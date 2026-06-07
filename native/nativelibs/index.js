'use strict';

const load = (modulePath) => () => require(modulePath);

module.exports = {
    fileUtils: load('./file-utils/index.js'),
    winUtils: load('./win-utils/index.js'),
    zcall: load('./zcall/index.js'),
    sqlite3: load('./sqlite3/index.js'),
    dbUtils: load('./db-cross-v4/binding.js'),
    v8Profiles: load('./v8-profiles/index.js'),
    zimage: (options) => require('./zimage/index.js')(options),
    zaloLogger: load('./logger/index.js'),
    zjxl: load('./zjxl/index.js'),
    zwalker: load('./zwalker/index.js'),
    zfile: load('./zfile/index.js'),
    mp4thumb: load('./mp4thumb/index.js'),

    fileUtilities: () => {
        try {
            return require('./file-utilities/index.js');
        } catch (_) {
            return {};
        }
    },
};
