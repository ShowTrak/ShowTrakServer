const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ScriptManager');

const { Config } = require('../Config');

const wol = require('wakeonlan')

const Manager = {};

Manager.Wake = async (MAC, Count = 3, Interval = 100) => {
    return new Promise((resolve, reject) => {
        wol(MAC, {
            count: Count,
            interval: Interval,
        }).then(() => {
            return resolve([null, 'Wake On LAN packet sent successfully']);
        }).catch((err) => {
            return resolve([err, null]);
        });
    })
} 


module.exports = {
    Manager,
};
