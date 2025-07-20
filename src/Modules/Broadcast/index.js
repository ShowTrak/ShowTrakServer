// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('Broadcast');
const { EventEmitter } = require("events");

const Manager = new EventEmitter();

module.exports = {
	Manager,
};
