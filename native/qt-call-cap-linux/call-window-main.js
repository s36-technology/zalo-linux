'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let callInfo = {};
let closingFromParent = false;

// The parent helper passes initial call metadata as argv[2]. Later updates are
// sent over stdin so this child can stay isolated from the main app process.
try {
    callInfo = JSON.parse(process.argv[2] || '{}');
} catch (_) {
    callInfo = {};
}

function sendToParent(message) {
    // LinuxCallWindow reads stdout line-by-line and forwards hangup events to
    // LinuxCallEngine.
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function createWindow() {
    win = new BrowserWindow({
        width: 360,
        height: 520,
        minWidth: 320,
        minHeight: 460,
        title: 'ZaloCall Linux',
        backgroundColor: '#111318',
        autoHideMenuBar: true,
        resizable: true,
        webPreferences: {
            preload: path.join(__dirname, 'call-window-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile(path.join(__dirname, 'call-window.html'));
    win.on('close', () => {
        // Only user-driven window closes should end the call. Parent-driven
        // cleanup sets closingFromParent first.
        if (!closingFromParent) {
            sendToParent({ type: 'hangup', source: 'window-close' });
        }
    });
    win.on('closed', () => {
        win = null;
    });
}

ipcMain.handle('get-call-info', () => callInfo);
ipcMain.on('answer', () => {
    sendToParent({ type: 'answer', source: 'button' });
});
ipcMain.on('hangup', () => {
    sendToParent({ type: 'hangup', source: 'button' });
});
ipcMain.on('window-ready', (event) => {
    event.sender.send('call-update', callInfo);
});

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
    // Parent commands are newline-delimited JSON, mirroring stdout events in
    // the opposite direction.
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
        if (!line) continue;
        let message;
        try {
            message = JSON.parse(line);
        } catch (_) {
            continue;
        }

        if (message.type === 'close') {
            closingFromParent = true;
            if (win && !win.isDestroyed()) {
                win.close();
            } else {
                app.quit();
            }
            continue;
        }

        if (message.type === 'update') {
            callInfo = message.call || {};
            if (win && !win.isDestroyed()) {
                win.webContents.send('call-update', callInfo);
            }
        }
    }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
