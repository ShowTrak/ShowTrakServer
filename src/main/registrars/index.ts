// IPC registrar barrel. Each registrar module owns one domain's RPC.handle
// registrations (grouped from the old monolithic main.ts). The composition root
// calls RegisterAllHandlers() once, inside app.whenReady, to wire them all.
//
// Registration order is not significant — each channel maps to exactly one
// handler and the channels are independent — but the domains are listed in the
// same order they appeared in the original main.ts for easy cross-reference.

import { register as registerSystem } from './system';
import { register as registerShow } from './show';
import { register as registerUpdates } from './updates';
import { register as registerGroups } from './groups';
import { register as registerClients } from './clients';
import { register as registerMonitoring } from './monitoring';
import { register as registerDummy } from './dummy';
import { register as registerFreeKiosk } from './freekiosk';
import { register as registerAlerts } from './alerts';
import { register as registerTags } from './tags';
import { register as registerFog } from './fog';
import { register as registerAudio } from './audio';
import { register as registerNetwork } from './network';
import { register as registerScripts } from './scripts';
import { register as registerRemoteDevices } from './remote-devices';

function RegisterAllHandlers(): void {
  registerSystem();
  registerShow();
  registerUpdates();
  registerGroups();
  registerClients();
  registerMonitoring();
  registerDummy();
  registerFreeKiosk();
  registerAlerts();
  registerTags();
  registerFog();
  registerAudio();
  registerNetwork();
  registerScripts();
  registerRemoteDevices();
}

export { RegisterAllHandlers };
