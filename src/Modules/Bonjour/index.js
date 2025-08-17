const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('Bonjour');
const bonjour = require('bonjour');
const { Manager: OSManager } = require('../OS');
const { Config } = require('../Config');

// Use classic 'bonjour' with multicast-dns under the hood; prefer IPv4 and enable loopback for localhost testing
const instance = bonjour({ reuseAddr: true, loopback: true });
let publishedService = null;

const Manager = {
  Init: () => {
    const Hostname = OSManager.Hostname || 'Unknown PC';
    const port = Config?.Application?.Port;
    try {
      Logger.log('Bonjour.Init start', {
        Hostname,
        Port: port,
        TxtKeys: Config && Config.Shared ? Object.keys(Config.Shared) : [],
      });
    } catch {}

    try {
      publishedService = instance.publish({
        name: `${Hostname} - ShowTrak Server V3`,
        type: 'showtrak',
        subtypes: ['showtrakv3server'],
        txt: Config.Shared,
        port,
      });
      try { publishedService.on('up', () => Logger.log('Bonjour service announced (up)')); } catch {}
      try { publishedService.on('error', (e) => Logger.error('Bonjour service error:', e)); } catch {}
      try { publishedService.start(); } catch {}
      Logger.log('Bonjour publish call issued');
    } catch (e) {
      Logger.error('Bonjour publish exception:', e);
    }

    // Self-check: browse for our own service to validate publication in local testing
    try {
      const selfBrowser = instance.findOne({ type: 'showtrak' }, (svc) => {
        try {
          Logger.log('Bonjour self-check found service', {
            host: svc && svc.host,
            port: svc && svc.port,
            addresses: svc && svc.addresses,
          });
        } catch {}
      });
      try { selfBrowser.start(); setTimeout(() => { try { selfBrowser.update(); } catch {} }, 100); } catch {}
    } catch (e) {}

    // TODO(macOS): Validate Bonjour/mDNS discovery and firewall prompts on macOS; adjust service options if needed.
    Logger.log(`Bonjour publish requested: ${Hostname} - ShowTrak Server V3`);
  },
  Find: () => {
    try {
      Logger.log('Bonjour.Find invoked');
      const browser = instance.find({ type: 'showtrak' });
      browser.on('up', (Service) => {
        try {
          Logger.log('Bonjour.Find up', {
            host: Service.host,
            port: Service.port,
            addresses: Service.addresses,
            txt: Service.txt,
          });
        } catch {}
      });
      try { browser.start(); Logger.log('Bonjour.Find browser started'); } catch {}
      setTimeout(() => { try { browser.update(); Logger.log('Bonjour.Find browser initial update'); } catch {} }, 100);
    } catch (e) {
      Logger.error('Bonjour.Find exception:', e);
    }
  },
  OnFind: (callback) => {
    try {
      Logger.log('Bonjour.OnFind invoked');
      const browser = instance.find({ type: 'showtrak' });
      browser.on('up', callback);
      try { browser.start(); Logger.log('Bonjour.OnFind browser started'); } catch {}
      setTimeout(() => { try { browser.update(); Logger.log('Bonjour.OnFind browser initial update'); } catch {} }, 100);
    } catch (e) {
      Logger.error('Bonjour.OnFind exception:', e);
    }
  },
};

module.exports = {
  Manager,
};
