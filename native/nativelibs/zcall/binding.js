function getLib() {
    if (process.platform === 'win32') {
        if (process.arch === 'x64') return require('./zcall_x64.node');
        return require('./zcall_ia32.node');
    } else if (process.platform === 'darwin') {
        return require('./zcall_mac.node');
    } else {
        // Linux does not have the proprietary zcall .node binary in this repo.
        // Use a JS adapter that exposes the same MainApp() surface and delegates
        // the real signaling/media work to native/qt-call-cap-linux.
        return require('./binding-linux');
    }
}
module.exports = getLib();
