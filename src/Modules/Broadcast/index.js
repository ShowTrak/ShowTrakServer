// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('Broadcast');
// Thin, process-wide event bus used to decouple modules from Electron/Socket layers
const { EventEmitter } = require('events');

const Manager = new EventEmitter();

module.exports = {
  Manager,
};
