// sACN monitoring: confirms a specific transmitter (source IP) is currently
// sending a given universe (1-63999). See _sacn-shared.ts for the shared,
// single-socket receiver that backs both sACN methods.
import { BuildSacnSettings, RunSacn, BuildSacnDebug, DEFAULT_SACN_INTERVAL_MS } from './_sacn-shared';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'sacn-universe';

const Settings: MonitoringSettingField[] = BuildSacnSettings(false);

function Run(Target: MonitoringTargetLike): MonitoringResult {
  return RunSacn(Target, { RequirePriority: false });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  return BuildSacnDebug(Result, Target, { RequirePriority: false });
}

export const Name = 'sACN - Receiving universe from target';
export const Description =
  'Passively listens for sACN (E1.31) data and confirms the configured source IP is transmitting the given universe.';
export const DefaultInterval = DEFAULT_SACN_INTERVAL_MS;
export { ID, Settings, Run, Debug };
