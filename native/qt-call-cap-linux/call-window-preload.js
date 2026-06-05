'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Small, explicit bridge for the call window. The HTML page never gets direct
// Node access; it can only read call info, report hangup, and subscribe updates.
contextBridge.exposeInMainWorld('zaloCallWindow', {
    getCallInfo: () => ipcRenderer.invoke('get-call-info'),
    answer: () => ipcRenderer.send('answer'),
    hangup: () => ipcRenderer.send('hangup'),
    ready: () => ipcRenderer.send('window-ready'),
    onUpdate: (callback) => {
        ipcRenderer.on('call-update', (_event, callInfo) => callback(callInfo));
    }
});
