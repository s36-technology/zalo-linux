'use strict';

const { webFrame } = require('electron');
const os = require('os');

function shouldEnableLinuxCallSupport() {
    return process.platform === 'linux' &&
        (process.env.ZALO_ENABLE_LINUX_CALL === '1' ||
            process.env.ZALO_ENABLE_CALL_MOCK === '1');
}

function patchOsReleaseForCallSupport() {
    if (!shouldEnableLinuxCallSupport()) {
        return;
    }

    const release = process.env.ZALO_LINUX_CALL_OS_RELEASE || '17.0.0';

    // Zalo's renderer gates macOS call UI on $znode.os.release() >= 17.
    // The original preload exposes Node's os module through $znode, so patching
    // the module before loading that preload lets the bundled UI keep its own
    // call/video-call buttons without editing pc-dist.
    os.release = () => release;
}

// bootstrap.js passes the generated preload path through additionalArguments.
// This wrapper runs first, applies Linux call shims, then loads that original
// preload so the rest of the app behaves like the copied bundle expects.
function findOriginalPreload() {
    const prefix = '--zalo-original-preload=';
    const arg = process.argv.find((item) => String(item).startsWith(prefix));

    return arg ? arg.slice(prefix.length) : null;
}

patchOsReleaseForCallSupport();
injectCallConfigPatch();

const originalPreload = findOriginalPreload();
if (originalPreload) {
    require(originalPreload);
}

function injectCallConfigPatch() {
    if (!shouldEnableLinuxCallSupport()) {
        return;
    }

    // This runs in the renderer main world. It leaves pc-dist untouched, but
    // makes parsed server configs opt in to the existing Zalo call UI. Some
    // call decisions live in bundled web workers, so Worker is wrapped too.
    webFrame.executeJavaScript(buildMainWorldPatch()).catch(() => {});
}

function buildMainWorldPatch() {
    const workerPatch = buildSharedPatch();

    return `
(() => {
  if (window.__zaloLinuxCallConfigPatch) return;
  window.__zaloLinuxCallConfigPatch = true;

  ${workerPatch}

  // Search/shared workers own part of the call controller. If only the window
  // is patched, buttons can render but makeCall can still be rejected in worker.
  const workerPatchSource = ${JSON.stringify(workerPatch)};
  const OriginalWorker = window.Worker;

  function shouldPatchWorker(url) {
    return typeof url === 'string' &&
      (url.includes('search-worker') || url.includes('shared-worker'));
  }

  if (typeof OriginalWorker === 'function' && !OriginalWorker.__zaloLinuxCallPatched) {
    class ZaloLinuxCallWorker extends OriginalWorker {
      constructor(scriptURL, options) {
        let patchedURL = scriptURL;

        try {
          const rawURL = String(scriptURL);
          if (shouldPatchWorker(rawURL) && !rawURL.startsWith('blob:')) {
            const absoluteURL = new URL(rawURL, window.location.href).toString();
            // Build a temporary worker that installs the same JSON/config patch
            // before importing the original bundled worker script.
            const source = workerPatchSource + '\\nimportScripts(' + JSON.stringify(absoluteURL) + ');';
            patchedURL = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
            console.info('[zalo-linux-call] worker wrapped', rawURL);
          }
        } catch (error) {
          console.warn('[zalo-linux-call] worker wrap failed', error);
        }

        super(patchedURL, options);
      }
    }

    Object.defineProperty(ZaloLinuxCallWorker, '__zaloLinuxCallPatched', { value: true });
    window.Worker = ZaloLinuxCallWorker;
  }
})();
    `;
}

// Shared by the renderer window and wrapped workers. It patches parsed remote
// config instead of editing pc-dist files, which are treated as generated input.
function buildSharedPatch() {
    return `
  const originalParse = JSON.parse;

  function patchZnode(value) {
    try {
      if (value && value.os && typeof value.os.release === 'function') {
        // The copied bundle checks macOS release >= 17 before enabling call UI.
        value.os.release = () => '17.0.0';
      }
    } catch (_) {}
    return value;
  }

  try {
    const isWorkerScope = typeof WorkerGlobalScope !== 'undefined' &&
      globalThis instanceof WorkerGlobalScope;
    if (!isWorkerScope) throw new Error('skip-window-znode-shim');

    // In workers, $znode can be assigned after this patch runs. Keep a setter so
    // the os.release shim is applied when the worker later receives $znode.
    let currentZnode = patchZnode(typeof $znode !== 'undefined' ? $znode : undefined);
    Object.defineProperty(globalThis, '$znode', {
      configurable: true,
      get() {
        return currentZnode;
      },
      set(value) {
        currentZnode = patchZnode(value);
      }
    });
  } catch (_) {}

  function patchSettings(settings) {
    if (!settings || typeof settings !== 'object') return;

    // These are the feature flags consumed by the existing Zalo call controller.
    // Once set, the original UI and IPC call path can run without bundle edits.
    if (!settings.chat || typeof settings.chat !== 'object') {
      settings.chat = {};
    }
    settings.chat.enable_call = 1;
    settings.chat.enable_video_call = 1;

    if (!settings.features || typeof settings.features !== 'object') {
      settings.features = {};
    }
    settings.features.enable_mac_call = 1;
    settings.features.enable_ipc_call = 1;

    if (!settings.features.call || typeof settings.features.call !== 'object') {
      settings.features.call = {};
    }
    settings.features.call.launch_native_in_startup = 1;
  }

  function patchConfig(value) {
    if (!value || typeof value !== 'object') return value;

    const candidates = [value, value.config, value.data];
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      patchSettings(item.settings);
      patchSettings(item.setttings);
    }

    return value;
  }

  JSON.parse = function patchedParse(...args) {
    return patchConfig(originalParse.apply(this, args));
  };
    `;
}
