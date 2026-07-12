// NUT UPS status check. Reads the `ups.status` variable from a NUT `upsd` server
// and reports the power state: Online on mains (OL), Degraded on battery / low
// battery / replace-battery / overload / alarm, Offline when unreachable.
//
// Result semantics (consumed by MonitoringTarget.Tick):
//   - No connection / no reply / auth failure          -> offline  (Success: false)
//   - upsd answered but the named UPS is not listed     -> degraded ("UPS not found")
//   - ups.status not readable                           -> degraded ("Status unavailable")
//   - Status has OB / LB / RB / OVER / ALARM / DISCHRG  -> degraded (reason)
//   - Status contains OL and none of the above          -> online   (Success: true)
import {
  CommonNutSettings,
  RunNutProbe,
  ClassifyStatus,
  ParseNutConfig,
  StatePill,
  NutDebug,
  MonoRow,
} from './_nut-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'nut-ups-status';

const Settings: MonitoringSettingField[] = [...CommonNutSettings];

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunNutProbe(Target, ['ups.status']);
  if ('Result' in Probe) return Probe.Result;
  const { Probe: P } = Probe.Ctx;

  if (P.VarErrors['ups.status']) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Status unavailable',
      LatencyMs: P.LatencyMs,
      Status: null,
      StatusErr: P.VarErrors['ups.status'],
      UpsList: P.UpsNames,
    };
  }

  const Status = P.Vars['ups.status'];
  const Classification = ClassifyStatus(Status);
  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: P.LatencyMs,
    Status,
    Tokens: Classification.Tokens,
    UpsList: P.UpsNames,
  };
  if (Classification.Online) return Base;
  return { ...Base, Degraded: true, DegradedReason: Classification.DegradedReason };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseNutConfig(Target);
  const Pill = StatePill(Result, 'Online (OL)');
  const RawStatus = Result && Result.Status != null ? String(Result.Status) : '';
  return NutDebug(Config, Result, Pill, [
    Result && Result.Success === true && RawStatus ? MonoRow('ups.status', RawStatus) : null,
  ]);
}

export const Name = 'UPS Status (NUT)';
export const Description =
  'Reads the ups.status variable from a NUT upsd server and reports the UPS power state (online / on battery / low battery / replace battery).';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
