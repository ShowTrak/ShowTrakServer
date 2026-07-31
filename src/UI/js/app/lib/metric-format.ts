// Rendering FreeKiosk metric readings for humans.
//
// Pure and DOM-free, so it is unit-testable like the other lib/ modules.
//
// The server has its own formatter, used to word alarm reasons. This is not a
// mirror of a decision: the registry itself — the thing that could meaningfully
// drift — is delivered over IPC, and both formatters are driven entirely by the
// Unit / Decimals / Format hints in that payload. The renderer needs its own
// copy only because it cannot import from src/Modules (its tsconfig rootDir is
// src/UI).
import type { FreeKioskMetricView } from '@showtrak/protocol';

export function RoundTo(Value: number, Decimals: number): number {
  if (!Number.isFinite(Value)) return Value;
  const Factor = Math.pow(10, Math.max(0, Decimals));
  return Math.round(Value * Factor) / Factor;
}

/** Seconds as the largest two units that carry information. */
export function FormatDuration(Seconds: number): string {
  const Total = Math.max(0, Math.floor(Seconds));
  const Days = Math.floor(Total / 86400);
  const Hours = Math.floor((Total % 86400) / 3600);
  const Minutes = Math.floor((Total % 3600) / 60);
  if (Days) return `${Days}d ${Hours}h`;
  if (Hours) return `${Hours}h ${Minutes}m`;
  if (Minutes) return `${Minutes}m ${Total % 60}s`;
  return `${Total}s`;
}

export function FormatMegabytes(MB: number): string {
  return MB >= 1024 ? `${RoundTo(MB / 1024, 1)} GB` : `${RoundTo(MB, 0)} MB`;
}

/** A number with its unit, spaced except for a percentage. */
export function FormatNumericMetric(Metric: FreeKioskMetricView, Value: number): string {
  if (Metric.Format === 'duration') return FormatDuration(Value);
  if (Metric.Format === 'megabytes') return FormatMegabytes(Value);
  const Text = RoundTo(Value, Metric.Decimals ?? 0).toString();
  if (!Metric.Unit) return Text;
  return Metric.Unit === '%' ? `${Text}%` : `${Text} ${Metric.Unit}`;
}

/**
 * The reading as shown in the view modal and on a tile.
 *
 * A null reading is "—" rather than "0" or blank: a device with no light sensor
 * and a device reporting zero lux are different facts, and conflating them
 * would let an operator read a threshold as met when nothing was measured.
 */
export function FormatMetricValue(
  Metric: FreeKioskMetricView | null | undefined,
  Value: string | number | boolean | null | undefined,
  Options: { MaxLength?: number } = {}
): string {
  if (!Metric) return Value == null ? '—' : String(Value);
  if (Value == null || Value === '') return '—';

  // A live reading arrives as a real boolean, but a stored alarm threshold comes
  // back off a <select> as the STRING "true"/"false" — and "false" is truthy, so
  // a bare cast prints an armed "expected No" as "expected Yes". Same rule the
  // engine's AsBoolean uses, so the wording can never disagree with the verdict.
  if (Metric.Type === 'boolean') {
    if (typeof Value === 'string') {
      const Text = Value.trim().toLowerCase();
      if (Text === 'false' || Text === '0' || Text === 'no') return 'No';
      if (Text === 'true' || Text === '1' || Text === 'yes') return 'Yes';
      return '—';
    }
    return Value ? 'Yes' : 'No';
  }

  if (Metric.Type === 'number') {
    const Numeric = Number(Value);
    if (!Number.isFinite(Numeric)) return '—';
    return FormatNumericMetric(Metric, Numeric);
  }

  const Text = String(Value);
  const Limit = Options.MaxLength ?? (Metric.Format === 'url' ? 60 : 0);
  if (Limit > 0 && Text.length > Limit) return `${Text.slice(0, Limit - 3)}...`;
  return Text;
}

/**
 * A short label for a tile, where there is room for a value but not a unit
 * spelled out. Falls back to the full format for everything else.
 */
export function FormatMetricCompact(
  Metric: FreeKioskMetricView | null | undefined,
  Value: string | number | boolean | null | undefined
): string {
  if (!Metric || Value == null || Value === '') return '—';
  if (Metric.Type === 'number' && Metric.Unit === '%') {
    const Numeric = Number(Value);
    return Number.isFinite(Numeric) ? `${RoundTo(Numeric, 0)}%` : '—';
  }
  return FormatMetricValue(Metric, Value, { MaxLength: 24 });
}
