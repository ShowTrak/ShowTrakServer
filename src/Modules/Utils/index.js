// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('Utils');

const Manager = {};

Manager.Wait = async (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

module.exports = Manager;
