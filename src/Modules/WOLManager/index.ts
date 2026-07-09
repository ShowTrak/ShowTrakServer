import { CreateLogger } from '../Logger';

const wol = require('wakeonlan');
const Logger = CreateLogger('WOLManager');

export const Manager = {
  Wake(
    MAC: string,
    Count = 20,
    Interval = 50
  ): Promise<[null, string] | [unknown, null]> | void {
    if (!MAC) return Logger.error('WOL Wake called with no MAC address');
    return new Promise((resolve) => {
      wol(MAC, {
        count: Count,
        interval: Interval,
      })
        .then(() => {
          resolve([null, 'Wake On LAN packet sent successfully']);
        })
        .catch((err: unknown) => {
          resolve([err, null]);
        });
    });
  },
};
