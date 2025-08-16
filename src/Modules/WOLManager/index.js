// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('ScriptManager');

// const { Config } = require('../Config');

const wol = require('wakeonlan');

const Manager = {};

Manager.Wake = async (MAC, Count = 20, Interval = 50) => {
  if (!MAC) return console.log('NO MAC PROVIDED');
  return new Promise((resolve, _reject) => {
    wol(MAC, {
      count: Count,
      interval: Interval,
    })
      .then(() => {
        return resolve([null, 'Wake On LAN packet sent successfully']);
      })
      .catch((err) => {
        return resolve([err, null]);
      });
  });
};

module.exports = {
  Manager,
};
