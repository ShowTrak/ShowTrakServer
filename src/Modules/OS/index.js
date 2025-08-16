// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('OSManager');

const os = require('os');

const Manager = {
  Hostname: os.hostname(),
};

module.exports = {
  Manager,
};
