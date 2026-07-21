// Shared UPS-MIB (RFC 1628) SNMP logic for the snmp-ups (v1/v2c) and snmp-ups-v3
// (v3 auth/priv) monitoring methods. Both talk to the same standard MIB and
// differ only in how the SNMP session is authenticated, so the OID set, the
// health evaluation and the debug rendering all live here; each method supplies
// a session factory and its own transport-specific editor Settings.
//
// RFC 1628 is implemented by the great majority of network-managed UPS cards
// (Eaton/MGE Network-M2/M3, Riello NetMan 208/204, APC AP96xx, CyberPower
// RMCARD, Tripp Lite, ...), so one method works across that whole range — it is
// not tied to any single vendor's proprietary MIB.
import snmp from 'net-snmp';
import { Esc, Pill, Rows, Row, TextRow, Note, FormatLatency } from './debug';
import type { MonitoringResult } from './types';

export const DEFAULT_PORT = 161;

// UPS-MIB scalar OIDs (all end in .0 — a single instance per device).
export const OID = {
  BatteryStatus: '1.3.6.1.2.1.33.1.2.1.0',
  Charge: '1.3.6.1.2.1.33.1.2.4.0',
  MinutesRemaining: '1.3.6.1.2.1.33.1.2.3.0',
  Temperature: '1.3.6.1.2.1.33.1.2.7.0',
  OutputSource: '1.3.6.1.2.1.33.1.4.1.0',
  AlarmsPresent: '1.3.6.1.2.1.33.1.6.1.0',
};

// Table columns are indexed by output/input line number (1-based on real gear).
export const LoadOid = (Index: number): string => `1.3.6.1.2.1.33.1.4.4.1.5.${Index}`;
export const InputVoltageOid = (Index: number): string => `1.3.6.1.2.1.33.1.3.3.1.3.${Index}`;

export const BATTERY_STATUS_LABELS: Record<number, string> = {
  1: 'Unknown',
  2: 'Normal',
  3: 'Low',
  4: 'Depleted',
};

export const OUTPUT_SOURCE_LABELS: Record<number, string> = {
  1: 'Other',
  2: 'None',
  3: 'Normal',
  4: 'Bypass',
  5: 'Battery',
  6: 'Booster',
  7: 'Reducer',
};

export const HEALTH_DEFAULTS = {
  MinCharge: 50,
  MaxLoad: 90,
  MaxTemperature: 45,
};

export interface HealthReadings {
  BatteryStatus?: number | null;
  OutputSource?: number | null;
  Charge?: number | null;
  Load?: number | null;
  Temperature?: number | null;
  AlarmsPresent?: number | null;
}

export interface HealthThresholds {
  MinCharge: number;
  MaxLoad: number;
  MaxTemperature: number;
  // Per-factor enable flags. Absent (undefined) counts as enabled so a bare
  // thresholds object — and checks saved before the toggles existed — keep
  // evaluating every factor.
  CheckCharge?: boolean;
  CheckLoad?: boolean;
  CheckTemperature?: boolean;
}

// Evaluate the readings against the thresholds and return the list of failing
// factors (empty when healthy). Exported for unit tests.
export function EvaluateHealth(Readings: HealthReadings, T: HealthThresholds): string[] {
  const Reasons: string[] = [];

  if (Readings.BatteryStatus === 3) Reasons.push('Low battery');
  else if (Readings.BatteryStatus === 4) Reasons.push('Battery depleted');

  if (Readings.OutputSource === 5) Reasons.push('On battery');
  else if (Readings.OutputSource === 4) Reasons.push('On bypass');
  else if (Readings.OutputSource === 1 || Readings.OutputSource === 2) {
    Reasons.push(`Output source: ${OUTPUT_SOURCE_LABELS[Readings.OutputSource]}`);
  }

  if (Readings.AlarmsPresent != null && Readings.AlarmsPresent > 0) {
    Reasons.push(
      `${Readings.AlarmsPresent} active alarm${Readings.AlarmsPresent === 1 ? '' : 's'}`
    );
  }
  if (T.CheckCharge !== false && Readings.Charge != null && Readings.Charge < T.MinCharge) {
    Reasons.push(`Charge ${Readings.Charge}% < ${T.MinCharge}%`);
  }
  if (T.CheckLoad !== false && Readings.Load != null && Readings.Load > T.MaxLoad) {
    Reasons.push(`Load ${Readings.Load}% > ${T.MaxLoad}%`);
  }
  if (
    T.CheckTemperature !== false &&
    Readings.Temperature != null &&
    Readings.Temperature > T.MaxTemperature
  ) {
    Reasons.push(`Temp ${Readings.Temperature}°C > ${T.MaxTemperature}°C`);
  }
  return Reasons;
}

// A net-snmp session (v1/v2c or v3) — both expose the same get()/close()/on()
// surface, so the probe is transport-agnostic once the session is built.
export type SnmpSession = ReturnType<typeof snmp.createSession>;

export interface SnmpProbe {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  Values: Record<string, number | null>;
}

// GET the requested OIDs over a single SNMP session built by CreateSession.
// Objects a device doesn't populate (NoSuchObject/NoSuchInstance) resolve to
// null rather than failing the whole probe; only a transport-level failure
// (timeout, socket error, unreachable host, bad credentials) is treated as
// unreachable. The session is always closed before resolving.
export function ProbeSnmpVars(
  CreateSession: () => SnmpSession,
  Vars: Array<{ Key: string; Oid: string }>
): Promise<SnmpProbe> {
  return new Promise<SnmpProbe>((resolve) => {
    const Started = Date.now();
    let Settled = false;

    let Session: SnmpSession;
    try {
      Session = CreateSession();
    } catch (Err) {
      resolve({
        Reachable: false,
        Error: Err instanceof Error ? Err.message : String(Err),
        Values: {},
      });
      return;
    }

    const Finish = (Result: SnmpProbe) => {
      if (Settled) return;
      Settled = true;
      try {
        Session.close();
      } catch {
        // ignore
      }
      resolve(Result);
    };

    Session.on('error', (Err: Error) => {
      Finish({
        Reachable: false,
        Error: Err && Err.message ? Err.message : String(Err),
        Values: {},
      });
    });

    try {
      Session.get(
        Vars.map((V) => V.Oid),
        (Err: Error | null, Varbinds) => {
          if (Err) {
            Finish({ Reachable: false, Error: Err.message || String(Err), Values: {} });
            return;
          }
          const Values: Record<string, number | null> = {};
          (Varbinds || []).forEach((Varbind, Idx) => {
            const Var = Vars[Idx];
            if (!Var) return; // more varbinds than requested OIDs; skip the extras
            const Key = Var.Key;
            if (snmp.isVarbindError(Varbind)) {
              Values[Key] = null;
              return;
            }
            const N = Number(Varbind.value);
            Values[Key] = Number.isFinite(N) ? N : null;
          });
          Finish({ Reachable: true, LatencyMs: Date.now() - Started, Values });
        }
      );
    } catch (Err) {
      Finish({
        Reachable: false,
        Error: Err instanceof Error ? Err.message : String(Err),
        Values: {},
      });
    }
  });
}

// The full UPS health probe shared by both transports: read the standard set of
// UPS-MIB objects, classify them against the thresholds, and assemble the
// MonitoringResult. Returns offline on a transport failure, degraded (with a
// combined reason) when any factor is breached, online otherwise.
export async function RunUpsHealth(
  CreateSession: () => SnmpSession,
  OutputIndex: number,
  Thresholds: HealthThresholds
): Promise<MonitoringResult> {
  const Probe = await ProbeSnmpVars(CreateSession, [
    { Key: 'BatteryStatus', Oid: OID.BatteryStatus },
    { Key: 'Charge', Oid: OID.Charge },
    { Key: 'MinutesRemaining', Oid: OID.MinutesRemaining },
    { Key: 'Temperature', Oid: OID.Temperature },
    { Key: 'OutputSource', Oid: OID.OutputSource },
    { Key: 'Load', Oid: LoadOid(OutputIndex) },
    { Key: 'InputVoltage', Oid: InputVoltageOid(OutputIndex) },
    { Key: 'AlarmsPresent', Oid: OID.AlarmsPresent },
  ]);

  if (!Probe.Reachable) {
    return { Success: false, Error: Probe.Error || 'No SNMP reply' };
  }

  const Readings: HealthReadings = {
    BatteryStatus: Probe.Values.BatteryStatus,
    OutputSource: Probe.Values.OutputSource,
    Charge: Probe.Values.Charge,
    Load: Probe.Values.Load,
    Temperature: Probe.Values.Temperature,
    AlarmsPresent: Probe.Values.AlarmsPresent,
  };

  const Reasons = EvaluateHealth(Readings, Thresholds);

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: Probe.LatencyMs,
    BatteryStatus: Readings.BatteryStatus,
    OutputSource: Readings.OutputSource,
    BatteryCharge: Readings.Charge,
    MinutesRemaining: Probe.Values.MinutesRemaining,
    Load: Readings.Load,
    Temperature: Readings.Temperature,
    InputVoltage: Probe.Values.InputVoltage,
    AlarmsPresent: Readings.AlarmsPresent,
  };

  if (Reasons.length) {
    return { ...Base, Degraded: true, DegradedReason: Reasons.join('; ') };
  }
  return Base;
}

// --- Shared threshold parsing ----------------------------------------------

// Pull MinCharge / MaxLoad / MaxTemperature off a settings object, defaulting
// and clamping anything missing or invalid.
export function ParseThresholds(Cfg: Record<string, unknown>): HealthThresholds {
  const Num = (Value: unknown, Fallback: number): number => {
    const N = Number(Value);
    return Number.isFinite(N) ? N : Fallback;
  };
  const Positive = (Value: unknown, Fallback: number): number => {
    const N = Num(Value, Fallback);
    return N > 0 ? N : Fallback;
  };
  return {
    MinCharge: Math.max(0, Math.min(100, Num(Cfg.MinCharge, HEALTH_DEFAULTS.MinCharge))),
    MaxLoad: Positive(Cfg.MaxLoad, HEALTH_DEFAULTS.MaxLoad),
    MaxTemperature: Positive(Cfg.MaxTemperature, HEALTH_DEFAULTS.MaxTemperature),
    CheckCharge: Cfg.CheckCharge !== false,
    CheckLoad: Cfg.CheckLoad !== false,
    CheckTemperature: Cfg.CheckTemperature !== false,
  };
}

// --- Shared debug rendering -------------------------------------------------

export function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', 'Healthy');
  if (Reachable) return Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  return Pill('danger', 'Offline');
}

function MonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

// Render the shared debug panel: a Host row, any transport-specific identity
// rows (community / v3 user), the status, and the metric rows. IdentityRows are
// pre-built (already-escaped) HTML row strings.
export function UpsDebug(
  Result: MonitoringResult,
  Address: string,
  Port: number,
  IdentityRows: Array<string | false | null | undefined>
): string {
  const Reachable = !!(Result && Result.Success === true);
  const Fmt = (Value: unknown, Suffix: string): string =>
    Value == null ? '—' : `${Value}${Suffix}`;

  const Head = Rows([
    TextRow('Host', `${Address || '—'}:${Port}`),
    ...IdentityRows,
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'No SNMP reply'),
    Reachable && Result.BatteryStatus != null
      ? MonoRow(
          'Battery status',
          BATTERY_STATUS_LABELS[Result.BatteryStatus as number] || String(Result.BatteryStatus)
        )
      : null,
    Reachable && Result.OutputSource != null
      ? MonoRow(
          'Output source',
          OUTPUT_SOURCE_LABELS[Result.OutputSource as number] || String(Result.OutputSource)
        )
      : null,
    Reachable ? MonoRow('Charge', Fmt(Result.BatteryCharge, '%')) : null,
    Reachable && Result.MinutesRemaining != null
      ? MonoRow('Runtime', Fmt(Result.MinutesRemaining, ' min'))
      : null,
    Reachable ? MonoRow('Load', Fmt(Result.Load, '%')) : null,
    Reachable && Result.Temperature != null
      ? MonoRow('Battery temp', Fmt(Result.Temperature, '°C'))
      : null,
    Reachable && Result.InputVoltage != null
      ? MonoRow('Input', Fmt(Result.InputVoltage, ' V'))
      : null,
    Reachable && Result.AlarmsPresent != null
      ? MonoRow('Alarms', String(Result.AlarmsPresent))
      : null,
  ]);
  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Could not reach the UPS over SNMP') + '</div>';
  }
  return Head;
}

// A pre-built identity row for the debug panel (label + monospace value).
export function IdentityRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}
