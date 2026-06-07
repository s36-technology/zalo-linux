'use strict';

const path = require('path');

function getNativeBindingPath() {
    if (process.platform === 'linux' && process.arch === 'x64') {
        return path.join(__dirname, 'prebuilt', 'linux', 'electron', 'x64', 'db-cross-v4-native.node');
    }

    if (process.platform === 'darwin') {
        return path.join(__dirname, 'prebuilt', 'darwin', 'electron', process.arch, 'db-cross-v4-native.node');
    }

    throw new Error(`db-cross-v4 is not available for ${process.platform}/${process.arch}.`);
}

module.exports = require(getNativeBindingPath());
