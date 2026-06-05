'use strict';

const electron = require('electron');
const { app, ipcMain } = electron;
const childProcess = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const CALL_RECV_SOCKET = '/tmp/socketzalorecv2021';
const CALL_SEND_SOCKET = '/tmp/socketzalosend2021';
let linuxCallHelperProcess = null;

// Node 26 warns about fs.rmdir(..., { recursive: true }). The bundled code is
// generated, so patch the deprecated API at runtime instead of editing main-dist.
function patchDeprecatedRecursiveRmdir() {
    const originalRmdir = fs.rmdir.bind(fs);
    const originalPromisesRmdir = fs.promises.rmdir.bind(fs.promises);

    fs.rmdir = (target, options, callback) => {
        if (typeof options === 'function') {
            return originalRmdir(target, options);
        }

        if (options && options.recursive) {
            return fs.rm(target, options, callback || (() => {}));
        }

        return originalRmdir(target, options, callback);
    };

    fs.promises.rmdir = (target, options) => {
        if (options && options.recursive) {
            return fs.promises.rm(target, options);
        }

        return originalPromisesRmdir(target, options);
    };
}

function configureLinuxGpuFallback() {
    if (process.platform !== 'linux' || process.env.ZALO_DISABLE_GPU !== '1') {
        return;
    }

    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
}

function shouldEnableLinuxCallSupport() {
    return process.platform === 'linux' &&
        (process.env.ZALO_ENABLE_LINUX_CALL === '1' ||
            process.env.ZALO_ENABLE_CALL_MOCK === '1');
}

// main-dist constructs BrowserWindow instances directly. Wrap BrowserWindow on
// Linux so runtime-only fixes can be applied without editing the copied bundle:
// call preload injection and native titlebar for the photo viewer.
function patchBrowserWindowForLinuxRuntime() {
    if (process.platform !== 'linux' || Module._load.__zaloLinuxRuntimePatched) {
        return;
    }

    const OriginalBrowserWindow = electron.BrowserWindow;
    const preloadWrapper = path.join(__dirname, 'native', 'qt-call-cap-linux', 'preload-call-support.js');

    class ZaloLinuxBrowserWindow extends OriginalBrowserWindow {
        constructor(options = {}) {
            const patchedOptions = patchBrowserWindowOptions(options, preloadWrapper);
            super(patchedOptions);

            if (isPhotoViewerWindowOptions(patchedOptions)) {
                installLinuxPhotoViewerShortcuts(this);
            }
        }
    }

    ZaloLinuxBrowserWindow.__zaloLinuxRuntimePatched = true;
    patchElectronRequire(ZaloLinuxBrowserWindow);
}

// These logs are intentionally small. They answer the key debugging question:
// did the renderer send call-init/makeCall to Electron main, or did click stop
// earlier in pc-dist UI/worker logic?
function traceLinuxCallIpc() {
    if (!shouldEnableLinuxCallSupport() || ipcMain.__zaloLinuxCallTraceInstalled) {
        return;
    }

    const logPath = process.env.ZALO_CALL_IPC_LOG ||
        path.join(os.tmpdir(), 'zalo-linux-call-ipc.log');

    const log = (channel, payload) => {
        try {
            fs.appendFileSync(logPath, `${new Date().toISOString()} ${channel} ${JSON.stringify(summarizeCallPayload(payload))}\n`);
        } catch (_) {}
    };

    ipcMain.on('call-init', (_event, payload) => {
        log('call-init', payload);
    });

    ipcMain.on('call-send-to-native', (_event, payload) => {
        log('call-send-to-native', payload);
        if (shouldStartLinuxCallHelper(payload)) {
            // main-dist sometimes prepares sockets but does not spawn the helper
            // on Linux. Delay a bit so the socket servers can finish listening.
            setTimeout(() => startLinuxCallHelper(`ipc:${payload.command}`), 250);
        }
    });

    ipcMain.__zaloLinuxCallTraceInstalled = true;
}

// Optional IPC messages are only cache/update traffic. Non-optional init or
// makeCall means the native helper must be alive for the click to do anything.
function shouldStartLinuxCallHelper(payload) {
    return payload &&
        typeof payload === 'object' &&
        !payload._optional &&
        (payload.command === 'init' || payload.command === 'makeCall');
}

// The Linux helper implements the same two-socket protocol as the original
// native ZaloCall process. Starting it here avoids relying on generated bundle
// spawn logic that still points at a macOS helper path.
function startLinuxCallHelper(reason) {
    if (!shouldEnableLinuxCallSupport()) {
        return;
    }

    if (linuxCallHelperProcess && !linuxCallHelperProcess.killed) {
        return;
    }

    const linuxCallPath = path.join(__dirname, 'native', 'qt-call-cap-linux', 'ZaloCall');

    traceLinuxCallEvent('helper-spawn', {
        reason,
        path: linuxCallPath,
        args: [CALL_RECV_SOCKET, CALL_SEND_SOCKET]
    });

    linuxCallHelperProcess = childProcess.spawn(linuxCallPath, [CALL_RECV_SOCKET, CALL_SEND_SOCKET], {
        env: process.env,
        stdio: 'ignore'
    });

    linuxCallHelperProcess.on('exit', (code, signal) => {
        traceLinuxCallEvent('helper-exit', { code, signal });
        linuxCallHelperProcess = null;
    });
}

function stopLinuxCallHelper() {
    if (linuxCallHelperProcess && !linuxCallHelperProcess.killed) {
        linuxCallHelperProcess.kill();
    }
}

// Keep this redirect as a best-effort fast path for bundle code that calls
// child_process.spawn directly. The IPC fallback above is the reliable path.
function redirectLinuxCallSpawn() {
    if (!shouldEnableLinuxCallSupport() || childProcess.spawn.__zaloLinuxCallPatched) {
        return;
    }

    const originalSpawn = childProcess.spawn.bind(childProcess);
    const linuxCallPath = path.join(__dirname, 'native', 'qt-call-cap-linux', 'ZaloCall');

    childProcess.spawn = (command, args, options) => {
        if (isBundledMacZaloCall(command)) {
            traceLinuxCallEvent('spawn-redirect', {
                from: command,
                to: linuxCallPath,
                args
            });
            return originalSpawn(linuxCallPath, args, options);
        }

        return originalSpawn(command, args, options);
    };
    childProcess.spawn.__zaloLinuxCallPatched = true;
}

function isBundledMacZaloCall(command) {
    if (typeof command !== 'string') {
        return false;
    }

    const normalized = path.normalize(command);
    return normalized.endsWith(path.join('Contents', 'MacOS', 'ZaloCall')) &&
        normalized.includes(`${path.sep}qt-call-cap-mac${path.sep}`);
}

// Shared trace helper for startup, IPC, and child process lifecycle. The log is
// outside userData so it survives Zalo log rotation and is easy to tail.
function traceLinuxCallEvent(channel, payload) {
    const logPath = process.env.ZALO_CALL_IPC_LOG ||
        path.join(os.tmpdir(), 'zalo-linux-call-ipc.log');

    try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${channel} ${JSON.stringify(payload)}\n`);
    } catch (_) {}
}

// Avoid logging full signal payloads: they can contain ids, avatars, and large
// call configs. The summary keeps enough shape to debug routing.
function summarizeCallPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    const data = payload.data && typeof payload.data === 'object' ? payload.data : null;

    return {
        type: payload.type,
        command: payload.command,
        optional: !!payload._optional,
        dataType: data && data.type,
        partnerCount: data && Array.isArray(data.partner) ? data.partner.length : undefined,
        shouldStartNative: payload._optional === false
    };
}

// Electron exports BrowserWindow as a getter-only property in this version, so
// replacing electron.BrowserWindow directly crashes. Patch require('electron')
// instead and return a proxy with BrowserWindow overridden.
function patchElectronRequire(BrowserWindowOverride) {
    const originalLoad = Module._load;
    const electronProxy = new Proxy(electron, {
        get(target, property, receiver) {
            if (property === 'BrowserWindow') {
                return BrowserWindowOverride;
            }

            return Reflect.get(target, property, receiver);
        }
    });

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') {
            return electronProxy;
        }

        return originalLoad.call(this, request, parent, isMain);
    };
    Module._load.__zaloLinuxCallPatched = true;
}

function patchBrowserWindowOptions(options, preloadWrapper) {
    options = patchLinuxPhotoViewerOptions(options);

    const webPreferences = options && options.webPreferences;
    const originalPreload = webPreferences && webPreferences.preload;

    if (!shouldEnableLinuxCallSupport() || !originalPreload || !isMainDistPreload(originalPreload)) {
        return options;
    }

    const additionalArguments = (webPreferences.additionalArguments || [])
        .filter((arg) => !String(arg).startsWith('--zalo-original-preload='));

    console.log('[zalo-linux-call] preload wrapped', originalPreload);

    return Object.assign({}, options, {
        webPreferences: Object.assign({}, webPreferences, {
            preload: preloadWrapper,
            additionalArguments: additionalArguments.concat([
                `--zalo-original-preload=${originalPreload}`
            ])
        })
    });
}

function patchLinuxPhotoViewerOptions(options) {
    if (!isPhotoViewerWindowOptions(options)) {
        return options;
    }

    // The copied macOS bundle can create the photo viewer frameless. On Linux
    // that removes the window manager close button, so force native decoration.
    return Object.assign({}, options, {
        frame: true,
        closable: true,
        minimizable: true,
        maximizable: true,
        titleBarStyle: 'default'
    });
}

function isPhotoViewerWindowOptions(options) {
    return !!options && options.title === 'Zalo Photo';
}

function installLinuxPhotoViewerShortcuts(win) {
    // Keep a keyboard escape hatch even if renderer controls fail to render.
    win.webContents.on('before-input-event', (event, input) => {
        const key = String(input.key || '').toLowerCase();
        if (key === 'escape' || ((input.control || input.meta) && key === 'w')) {
            event.preventDefault();
            win.close();
        }
    });

    win.webContents.on('dom-ready', () => {
        injectLinuxPhotoViewerCloseButton(win);
    });
}

function injectLinuxPhotoViewerCloseButton(win) {
    // Add a small close affordance inside the viewer itself. This covers Linux
    // window managers/themes that hide native decorations on restored windows.
    win.webContents.executeJavaScript(`
(() => {
  if (document.getElementById('zalo-linux-photo-close')) return;

  const button = document.createElement('button');
  button.id = 'zalo-linux-photo-close';
  button.type = 'button';
  button.textContent = 'x';
  button.setAttribute('aria-label', 'Close preview');
  Object.assign(button.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '2147483647',
    width: '36px',
    height: '36px',
    border: '0',
    borderRadius: '18px',
    background: 'rgba(0, 0, 0, 0.64)',
    color: '#fff',
    fontSize: '22px',
    lineHeight: '36px',
    cursor: 'pointer'
  });
  button.addEventListener('click', () => window.close());
  document.documentElement.appendChild(button);
})();
        `).catch(() => {});
}

// Only wrap generated preloads. Other windows, including the Linux call window,
// should keep their own preload unchanged.
function isMainDistPreload(preloadPath) {
    const normalized = path.normalize(preloadPath);
    return normalized.includes(`${path.sep}main-dist${path.sep}`) &&
        path.basename(normalized).includes('preload');
}

function loadPerfRuntime() {
    require('./libs/perf-tracing/runtime');
}

function loadMigration() {
    require('./main-dist/migration');
}

function loadSecondInstance() {
    require('./main-dist/second-instance');
}

function startCompactApp() {
    require('./main-dist/compact-app');
}

function startMainApp() {
    perf.record(perf.MAIN_SCRIPT);
    require('./main-dist/main');
}

function hasCompactAppFlag(argv) {
    return argv.some((arg) => arg.startsWith('--launch-compact-app'));
}

function runWithSingleInstanceLock(startApp) {
    if (app.requestSingleInstanceLock()) {
        startApp();
        return;
    }

    loadSecondInstance();
}

function bootstrap() {
    patchDeprecatedRecursiveRmdir();
    configureLinuxGpuFallback();
    patchBrowserWindowForLinuxRuntime();
    traceLinuxCallIpc();
    redirectLinuxCallSpawn();
    app.once('before-quit', stopLinuxCallHelper);

    loadPerfRuntime();
    perf.record(perf.STARTUP);

    loadMigration();
    perf.record(perf.MIGRATION_DONE);

    if (hasCompactAppFlag(process.argv)) {
        runWithSingleInstanceLock(startCompactApp);
        return;
    }

    runWithSingleInstanceLock(startMainApp);
}

bootstrap();
