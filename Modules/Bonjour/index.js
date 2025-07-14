const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('Bonjour');
const { Bonjour } = require('bonjour-service');
const { Manager: OSManager } = require('../OS');
const { Config } = require('../Config');

const instance = new Bonjour()

const Manager = {
    Init: () => {
        const Hostname = OSManager.Hostname || 'Unknown PC';
        instance.publish({ 
            name: `${Hostname} - ShowTrak Server V3`,
            type: 'ShowTrak',
            subtypes: ['ShowTrakV3Server'],
            txt: Config.Shared, 
            disableIPv6: true,
            port: Config.Application.Port,
        }, (err) => {
            if (err) {
                Logger.error('Error publishing Bonjour service:', err);
            } else {
                Logger.error('Error publishing Bonjour service');
            }
        })
        Logger.log(`Bonjour service published: ${Hostname} - ShowTrak Server V3`);
    },
    Find: () => {
        instance.find({ type: 'ShowTrak' }, function (Service) {
            Logger.log(Service)
        })
    },
    OnFind: (callback) => {
        instance.find({ type: 'ShowTrak' }, callback)
    },
}

module.exports = { 
    Manager,
}