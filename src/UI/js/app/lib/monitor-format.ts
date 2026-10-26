// Pure formatting for monitoring targets: intervals, latency, the status line,
// the compact tile label and the method/address summaries. Shared by the tiles
// (../monitoring) and the history modal (../monitoring-history-modal).
import type { MonitoringTargetView } from '@showtrak/protocol';

export function FormatInterval(ms: unknown) {
  const n = Number(ms) || 0;
  if (n < 60000) return `${Math.round(n / 1000)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function FormatLatency(ms: number | null | undefined) {
  if (ms == null) return '';
  if (ms < 1) return '<1ms';
  return `${Math.round(ms)}ms`;
}

export function FormatMonitoringCheckSummary(T: MonitoringTargetView, MaxLength = 24) {
  const Checks = Array.isArray(T && T.Checks) ? T.Checks : [];
  const Labels: string[] = [];
  const Seen = new Set<string>();
  const MethodLabels: Record<string, string> = {
    ping: 'PING',
    dns: 'DNS',
    http: 'HTTP',
    https: 'HTTPS',
    'http-json': 'HTTP',
    'tcp-port': 'TCP',
    qlab: 'QLAB',
    qlab5: 'QLAB5',
    qlab4: 'QLAB4',
  };

  for (const Check of Checks) {
    const MethodID = String((Check && Check.Method) || '')
      .trim()
      .toLowerCase();
    if (!MethodID) continue;
    const Label = MethodLabels[MethodID] || MethodID.replace(/[-_]+/g, ' ').toUpperCase();
    if (Seen.has(Label)) continue;
    Seen.add(Label);
    Labels.push(Label);
  }

  if (!Labels.length) return '';

  const FormatVisibleLabels = (Items: string[]) => {
    if (Items.length <= 1) return Items.join('');
    if (Items.length === 2) return `${Items[0]} & ${Items[1]}`;
    return `${Items.slice(0, -1).join(', ')} & ${Items[Items.length - 1]}`;
  };

  const Visible: string[] = [];
  for (let Index = 0; Index < Labels.length; Index += 1) {
    const Label = Labels[Index]!; // Index < Labels.length: always defined
    const Remaining = Labels.length - (Index + 1);
    const Candidate = FormatVisibleLabels([...Visible, Label]);
    const Suffix = Remaining > 0 ? ` + ${Remaining} More` : '';
    if (Visible.length && Candidate.length + Suffix.length > MaxLength) break;
    Visible.push(Label);
  }

  const HiddenCount = Labels.length - Visible.length;
  const Summary = FormatVisibleLabels(Visible);
  return HiddenCount > 0 ? `${Summary} + ${HiddenCount} More` : Summary;
}

// Extract just the hostname from an http/https URL, or show a compact check
// summary for multi-check targets.
export function FormatMonitoringAddressSub(T: MonitoringTargetView) {
  const Count = Number(T && T.CheckCount);
  if (Number.isFinite(Count) && Count > 1) {
    return FormatMonitoringCheckSummary(T) || `${Count} Checks`;
  }
  const Addr = String((T && T.Address) || '');
  if (/^https?:\/\//i.test(Addr)) {
    try {
      return new URL(Addr).hostname;
    } catch (_) {
      // fall through
    }
  }
  return Addr;
}

// A target can hold multiple checks; show the single method when there is one,
// otherwise summarise the number of checks (including the empty case).
export function FormatMonitoringMethodLabel(T: MonitoringTargetView) {
  const Count = Number(T && T.CheckCount);
  if (Number.isFinite(Count)) {
    if (Count === 0) return 'NO CHECKS';
    if (Count > 1) return `${Count} CHECKS`;
  }
  return String((T && T.Method) || '').toUpperCase();
}

export function FormatMonitorStatus(
  Online: boolean,
  LastLatencyMs: number | null,
  LastError: string | null,
  Degraded: boolean
) {
  if (Online) {
    if (Degraded) {
      const Reason = typeof LastError === 'string' ? LastError.trim() : '';
      if (Reason) return Reason;
    }
    return FormatLatency(LastLatencyMs);
  }
  const ErrorText = typeof LastError === 'string' ? LastError.trim() : '';
  if (!ErrorText) return 'Offline';
  if (
    /timed?\s*out|timeout|unreachable|refused|reset|network\s+is\s+unreachable|no\s+route\s+to\s+host|socket\s+hang\s+up|econnrefused|econnreset|ehostunreach|enetunreach/i.test(
      ErrorText
    )
  ) {
    return 'Offline';
  }
  if (/enotfound|eai_again|nxdomain|dns|name\s+or\s+service\s+not\s+known/i.test(ErrorText)) {
    return 'DNS Error';
  }
  if (
    /cert|certificate|tls|ssl|self\s*signed|unable\s+to\s+verify|hostname\/?ip\s+does\s+not\s+match/i.test(
      ErrorText
    )
  ) {
    return 'TLS Error';
  }
  const HttpMatch = ErrorText.match(/\bHTTP\s+(\d{3})\b/i);
  if (HttpMatch) return `HTTP ${HttpMatch[1]}`;
  return ErrorText;
}

/**
 * Whether a target has checks configured but has not completed one yet.
 *
 * A target's runtime state is RAM-only and starts at Online: false, and its
 * first check does not run until a moment after the loop starts. Rendering that
 * gap as offline paints every monitor on the page red for the first check cycle
 * after the server starts; an outage the operator can see is not real, which
 * is the fastest way to teach them to ignore a red tile.
 *
 * It is deliberately not rendered as online either. Until a probe has answered
 * we do not know, and assuming "up" would hide a device that really is dead
 * when the server comes up. The tile shows the same neutral state a target with
 * no checks gets, labelled so it reads as "not yet", not as "nothing here".
 */
export function IsMonitorAwaitingFirstCheck(T: MonitoringTargetView | null | undefined): boolean {
  if (!T) return false;
  if (!Number(T.CheckCount)) return false;
  return T.LastChecked == null;
}

export function FormatMonitorCompactStatus(
  Online: boolean,
  LastLatencyMs: number | null,
  Degraded: boolean,
  IsIdle: boolean,
  AwaitingFirstCheck = false
) {
  // Compact view keeps labels short and deterministic. Prefer latency when it
  // exists, otherwise show a stable state label.
  const Latency = Online ? FormatLatency(LastLatencyMs) : '';
  if (Latency) return { text: Latency, color: 'text-light' };
  if (IsIdle) return { text: 'Idle', color: 'text-light' };
  if (AwaitingFirstCheck) return { text: 'Checking', color: 'text-light' };
  if (Online && Degraded) return { text: 'Degraded', color: 'text-warning' };
  if (Online) return { text: 'Online', color: 'text-light' };
  return { text: 'Offline', color: 'text-light' };
}

export function GetMonitoringOfflineSince(Target: MonitoringTargetView) {
  // Only LastSuccessAt reflects the moment the target was last confirmed
  // online. LastChecked/Timestamp update on every check cycle (including
  // failures), so using them here would make the offline timer reset on
  // every tick instead of counting from when it actually went offline.
  const Ts = Number(Target && Target.LastSuccessAt);
  if (Number.isFinite(Ts) && Ts > 0) return String(Math.round(Ts));
  return '';
}
