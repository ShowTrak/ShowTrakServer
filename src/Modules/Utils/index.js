// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('Utils');

const Manager = {};

Manager.Wait = async (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

Manager.Ok = (value = null) => {
  return [null, value];
};

Manager.Fail = (error, value = null) => {
  return [error || 'Unknown Error', value];
};

module.exports = Manager;
