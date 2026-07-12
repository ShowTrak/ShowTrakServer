// Millumin (Anome) monitoring: passively confirms a Millumin machine is alive by
// listening for its outbound OSC "API feedback" stream.
//
// Millumin does not answer a reliable request/response query — it only SENDS OSC
// feedback (all prefixed `/millumin`) to configured destinations when "API
// feedback" is enabled. So this check binds a UDP port and treats recent OSC
// activity from the target machine as the liveness signal. See _millumin-shared.ts
// for the shared single-socket receiver and the full protocol/config notes.
//
// USER MUST configure Millumin (Device manager -> CMD+K -> OSC tab -> "API
// feedback") to send OSC to ShowTrak's IP + the configured ListenPort.
//
// Result semantics (consumed by MonitoringTarget.Tick):
//   - No matching OSC in the grace window     -> offline  (Success: false)
//   - OSC arriving, but from a different IP    -> degraded ("OSC from X, not …")
//   - Matching OSC from the target machine     -> online   (Success: true)
import {
  BuildMilluminSettings,
  RunMillumin,
  BuildMilluminDebug,
  DEFAULT_MILLUMIN_INTERVAL_MS,
} from './_millumin-shared';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'millumin-status';

const Settings: MonitoringSettingField[] = BuildMilluminSettings();

function Run(Target: MonitoringTargetLike): MonitoringResult {
  return RunMillumin(Target);
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  return BuildMilluminDebug(Result, Target);
}

export const Name = 'Millumin';
export const Description =
  'Passively listens for Millumin\'s outbound OSC feedback and confirms the configured machine is sending it (Millumin must have "API feedback" enabled, targeting ShowTrak).';
export const DefaultInterval = DEFAULT_MILLUMIN_INTERVAL_MS;
// Passive OSC-feedback listener: no round-trip latency is measured, so the
// latency-based Degraded Threshold field is hidden in the editor.
export const SupportsLatencyThreshold = false;
export { ID, Settings, Run, Debug };
