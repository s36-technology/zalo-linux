var BINARY_PATH = `./binding/napi-v6-${process.platform}-${process.arch}/node_sqlite3.node`;
var binding = require(BINARY_PATH);
module.exports = exports = binding;
