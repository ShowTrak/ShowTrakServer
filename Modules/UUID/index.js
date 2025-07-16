// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('UUID');

const { v4: uuidv4 } = require("uuid");

const Manager = {};

Manager.Generate = () => {
	return uuidv4();
};

module.exports = {
	Manager,
};
