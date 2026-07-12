// sACN monitoring: confirms a specific transmitter (source IP) is sending a
// given universe (1-63999) AND that its per-packet priority (0-200) matches the
// configured value. Reachable-but-wrong-priority reports as degraded (amber).
// Shares the single-socket receiver in _sacn-shared.ts with the sacn-universe
// method, so watching the same universe from both never opens a second listener.
import { BuildSacnSettings, RunSacn, BuildSacnDebug, DEFAULT_SACN_INTERVAL_MS } from './_sacn-shared';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'sacn-universe-priority';

const Settings: MonitoringSettingField[] = BuildSacnSettings(true);

function Run(Target: MonitoringTargetLike): MonitoringResult {
  return RunSacn(Target, { RequirePriority: true });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  return BuildSacnDebug(Result, Target, { RequirePriority: true });
}

export const Name = 'sACN - Receiving universe at priority from target';
export const Description =
  'Passively listens for sACN (E1.31) data and confirms the configured source IP is transmitting the given universe at the expected priority.';
export const DefaultInterval = DEFAULT_SACN_INTERVAL_MS;
// Passive listener: no round-trip latency is measured, so the latency-based
// Degraded Threshold field is hidden in the editor.
export const SupportsLatencyThreshold = false;
export { ID, Settings, Run, Debug };
