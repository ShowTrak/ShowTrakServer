import { CreateLogger } from '../Logger';
import { Manager as OSManager } from '../OS';
import { Config } from '../Config';
import { Manager as ServerIdentityManager } from '../ServerIdentity';
import { CreateBonjourErrorHandler } from '../NetworkErrors';

const Logger = CreateLogger('Bonjour');

// Minimal structural types for the `bonjour-service` package. Its own typings are
// class-based; we describe only the surface this module actually touches so the
// call sites below stay factory-style.
interface BonjourTxtRecord {
  [key: string]: unknown;
}

interface BonjourService {
  name?: string;
  type?: string;
  host?: string;
  port?: number;
  fqdn?: string;
  protocol?: string;
  subtypes?: string[] | null;
  txt?: BonjourTxtRecord | null;
  addresses?: string[];
  referer?: unknown;
  rawTxt?: unknown;
  published?: boolean;
}

interface BonjourPublishedService {
  on(event: string, listener: (...args: unknown[]) => void): BonjourPublishedService;
  start(): void;
}

interface BonjourBrowser {
  on(event: 'up', listener: (service: BonjourService) => void): void;
  start(): void;
  update(): void;
  stop(): void;
}

interface BonjourPublishOptions {
  name: string;
  type: string;
  subtypes?: string[];
  txt?: BonjourTxtRecord;
  port?: number;
  host?: string;
  protocol?: string;
}

interface BonjourFindOptions {
  type?: string;
}

interface BonjourInstance {
  publish(options: BonjourPublishOptions): BonjourPublishedService;
  find(options: BonjourFindOptions): BonjourBrowser;
  findOne(
    options: BonjourFindOptions,
    timeout: number,
    callback: (service: BonjourService) => void
  ): BonjourBrowser;
  destroy(): void;
}

type BonjourFactory = (options?: { reuseAddr?: boolean; loopback?: boolean }) => BonjourInstance;

// bonjour-service exports a class whose constructor takes an optional second
// `errorCallback`. Its default is `function (err) { throw err }`, which turns a
// routine interface drop (mDNS send → EADDRNOTAVAIL) into an uncaught exception.
// We always supply a logging handler so a network flap never crashes the app.
const { Bonjour } = require('bonjour-service') as {
  Bonjour: new (
    options?: { reuseAddr?: boolean; loopback?: boolean },
    errorCallback?: (err: unknown) => void
  ) => BonjourInstance;
};
const OnBonjourError = CreateBonjourErrorHandler(Logger);
const bonjour: BonjourFactory = (options) => new Bonjour(options, OnBonjourError);

// Use classic 'bonjour' with multicast-dns under the hood; prefer IPv4 and enable loopback for localhost testing
const instance = bonjour({ reuseAddr: true, loopback: true });
let publishedService: BonjourPublishedService | null = null;

const Manager = {
  Init: () => {
    const Hostname = OSManager.Hostname || 'Unknown PC';
    const port = Config?.Application?.Port;
    const serverIdentityToken = ServerIdentityManager.GetIdentityToken();
    const txtPayload = {
      ...(Config.Shared || {}),
      ServerIdentity: serverIdentityToken,
    };
    try {
      Logger.log('Bonjour.Init start', {
        Hostname,
        Port: port,
        TxtKeys: Object.keys(txtPayload),
      });
    } catch {
      /* intentional: diagnostic logging is best-effort and must never block publishing */
    }

    try {
      publishedService = instance.publish({
        name: `${Hostname} - ShowTrak Server V3`,
        type: 'showtrak',
        subtypes: ['showtrakv3server'],
        txt: txtPayload,
        port,
      });
      try {
        publishedService.on('up', () => Logger.log('Bonjour service announced (up)'));
      } catch {
        /* intentional: mDNS listener registration is best-effort; a failed 'up' handler is non-fatal */
      }
      try {
        publishedService.on('error', (e: unknown) => Logger.error('Bonjour service error:', e));
      } catch {
        /* intentional: mDNS listener registration is best-effort and non-fatal */
      }
      try {
        publishedService.start();
      } catch {
        /* intentional: some bonjour builds auto-start on publish; a redundant start() throwing is harmless */
      }
      Logger.log('Bonjour publish call issued');
    } catch (e) {
      Logger.error('Bonjour publish exception:', e);
    }

    // Self-check: browse for our own service to validate publication in local testing
    try {
      const selfBrowser = instance.findOne({ type: 'showtrak' }, 10000, (svc: BonjourService) => {
        try {
          Logger.log('Bonjour self-check found service', {
            host: svc && svc.host,
            port: svc && svc.port,
            addresses: svc && svc.addresses,
          });
        } catch {
          /* intentional: self-check logging is best-effort */
        }
      });
      try {
        selfBrowser.start();
        setTimeout(() => {
          try {
            selfBrowser.update();
          } catch {
            /* intentional: self-check re-query is best-effort */
          }
        }, 100);
      } catch {
        /* intentional: the self-check browser is a diagnostic aid; failures must not affect publishing */
      }
    } catch {
      /* intentional: the entire self-check is a local-testing diagnostic and non-fatal */
    }

    // TODO(macOS): Validate Bonjour/mDNS discovery and firewall prompts on macOS; adjust service options if needed.
    Logger.log(`Bonjour publish requested: ${Hostname} - ShowTrak Server V3`);
  },
  Find: () => {
    try {
      Logger.log('Bonjour.Find invoked');
      const browser = instance.find({ type: 'showtrak' });
      browser.on('up', (Service: BonjourService) => {
        try {
          Logger.log('Bonjour.Find up', {
            host: Service.host,
            port: Service.port,
            addresses: Service.addresses,
            txt: Service.txt,
          });
        } catch {
          /* intentional: discovery logging is best-effort */
        }
      });
      try {
        browser.start();
        Logger.log('Bonjour.Find browser started');
      } catch {
        /* intentional: some bonjour builds auto-start on find(); a redundant start() throwing is harmless */
      }
      setTimeout(() => {
        try {
          browser.update();
          Logger.log('Bonjour.Find browser initial update');
        } catch {
          /* intentional: initial re-query is best-effort */
        }
      }, 100);
    } catch (e) {
      Logger.error('Bonjour.Find exception:', e);
    }
  },
  OnFind: (callback: (service: BonjourService) => void) => {
    try {
      Logger.log('Bonjour.OnFind invoked');
      const browser = instance.find({ type: 'showtrak' });
      browser.on('up', callback);
      try {
        browser.start();
        Logger.log('Bonjour.OnFind browser started');
      } catch {
        /* intentional: some bonjour builds auto-start on find(); a redundant start() throwing is harmless */
      }
      setTimeout(() => {
        try {
          browser.update();
          Logger.log('Bonjour.OnFind browser initial update');
        } catch {
          /* intentional: initial re-query is best-effort */
        }
      }, 100);
    } catch (e) {
      Logger.error('Bonjour.OnFind exception:', e);
    }
  },
};

export { Manager };
