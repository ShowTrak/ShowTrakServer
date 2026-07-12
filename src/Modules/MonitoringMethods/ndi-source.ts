// NDI source-presence monitoring: confirms an NDI source whose name matches the
// configured target is currently advertising on the network. See _ndi-shared.ts
// for the shared, single process-wide mDNS browser that backs this method.
//
// Presence is binary, so there is no meaningful degraded state:
//   Success:true  -> online  (a matching source seen within the grace window)
//   Success:false -> offline (no matching source, or the browser is unavailable)
import {
  Settings as NdiSettings,
  RunNdi,
  BuildNdiDebug,
  DEFAULT_NDI_INTERVAL_MS,
  _internal,
} from './_ndi-shared';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'ndi-source';

const Settings: MonitoringSettingField[] = NdiSettings;

function Run(Target: MonitoringTargetLike): MonitoringResult {
  return RunNdi(Target);
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  return BuildNdiDebug(Result, Target);
}

export const Name = 'NDI Source Presence';
export const Description =
  'Passively browses mDNS for NDI (_ndi._tcp) sources and confirms one matching the configured name is on the network.';
export const DefaultInterval = DEFAULT_NDI_INTERVAL_MS;
// Discovery is network-wide via mDNS: the Address field is unused, and presence
// is reported without a round-trip latency, so both editor fields are hidden.
export const UsesAddress = false;
export const SupportsLatencyThreshold = false;
export { ID, Settings, Run, Debug, _internal };
