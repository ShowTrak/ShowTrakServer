// Dante device-presence monitoring: confirms an Audinate Dante device whose name
// matches the configured target is currently advertising on the network. See
// _dante-shared.ts for the shared, single process-wide mDNS browser that backs
// this method.
//
// Presence is binary, so there is no meaningful degraded state:
//   Success:true  -> online  (a matching device seen within the grace window)
//   Success:false -> offline (no matching device, or the browser is unavailable)
//
// This reports device presence only — not subscription health. Dante does not
// carry subscription state in mDNS; see the header of _dante-shared.ts.
import {
  Settings as DanteSettings,
  RunDante,
  BuildDanteDebug,
  DEFAULT_DANTE_INTERVAL_MS,
  _internal,
} from './_dante-shared';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'dante-device';

const Settings: MonitoringSettingField[] = DanteSettings;

function Run(Target: MonitoringTargetLike): MonitoringResult {
  return RunDante(Target);
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  return BuildDanteDebug(Result, Target);
}

export const Name = 'Dante Device Presence';
export const Description =
  'Passively browses mDNS for Audinate Dante devices (_netaudio-arc._udp and _netaudio-cmc._udp) and confirms one matching the configured name is on the network.';
export const DefaultInterval = DEFAULT_DANTE_INTERVAL_MS;
// Discovery is network-wide via mDNS: the Address field is unused, and presence
// is reported without a round-trip latency, so both editor fields are hidden.
export const UsesAddress = false;
export const SupportsLatencyThreshold = false;
export { ID, Settings, Run, Debug, _internal };
