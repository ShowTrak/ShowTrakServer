const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ScriptManager');

const { Config } = require('../Config');

const wol = require('wakeonlan')

const Manager = {};

Manager.SendWOL = async (MAC) => {
    return new Promise((resolve, reject) => {
        wol('04:18:D6:A0:47:27', {
            count: 3,
            interval: 100,
        }).then(() => {
            return resolve([null, 'Sent Successfully']);
        }).catch((err) => {
            return resolve([err, null]);
        });
    })
} 


module.exports = {
    Manager,
};
