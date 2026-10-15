// The Applications section of the client info modal, as decisions only: one
// card per application, styled like every other monitored-hardware card — a
// summary line, the Monitor toggle, the issues it raises, and (once monitored)
// a conditions table: running, responding, in the foreground. A condition this
// client cannot detect reads "Unsupported" in its row. The markup lives in
// ../client-info-applications.
import type { ClientView, RunningApplicationViewItem } from '@showtrak/protocol';

export type ApplicationConditionField =
  'RequireRunning' | 'RequireResponding' | 'RequireForeground';

export interface ApplicationConditionRow {
  Field: ApplicationConditionField;
  Label: string;
  /** What the application is doing now ("Yes", "No", "—"), or "Unsupported". */
  Value: string;
  /** Whether this client can detect it. Unsupported rows have no tick and are never sent. */
  Supported: boolean;
  Checked: boolean;
  /** Always on: monitoring an application is requiring it to run. Never sent. */
  Locked: boolean;
  /** The issue this condition currently raises, when it is not met. */
  Failing: string | null;
}

export type ApplicationState = 'plain' | 'healthy' | 'issue' | 'missing';

export interface ApplicationBadgeView {
  State: ApplicationState;
  Label: string;
  Icon: string;
  Title: string;
}

const YesNo = (Value: boolean | null | undefined) =>
  Value === true ? 'Yes' : Value === false ? 'No' : '—';

/** What the client's collector can detect: hung applications, the focused one. */
function Capable(Client: ClientView): { Responding: boolean; Foreground: boolean } {
  const Capabilities = Client.RunningApplications?.Capabilities;
  return {
    Responding: !!Capabilities?.Responding,
    Foreground: !!Capabilities?.Foreground,
  };
}

// Only a named owner is evidence that an application lost focus: nothing
// focused, or an unreadable window, is not.
function FocusKnown(Client: ClientView): boolean {
  const Foreground = Client.RunningApplications?.Foreground;
  return Capable(Client).Foreground && typeof Foreground === 'string' && !!Foreground;
}

/** The conditions a monitored application is failing, in an operator's words. */
export function ApplicationIssues(App: RunningApplicationViewItem, Client: ClientView): string[] {
  if (!App.IsCritical) return [];
  const Running = App.IsRunning !== false;
  const RequireResponding = App.RequireResponding !== false;
  const Issues: string[] = [];
  if (!Running) {
    Issues.push('Not running');
    return Issues;
  }
  if (RequireResponding && App.Responding === false) Issues.push('Not responding');
  if (App.RequireForeground && FocusKnown(Client) && !App.IsForeground) {
    const Front = Client.RunningApplications?.Foreground;
    Issues.push(`Not in the foreground${Front ? ` (${Front} is)` : ''}`);
  }
  return Issues;
}

/** "Running · 2 instances · In foreground", or "Not running". */
export function ApplicationSummary(App: RunningApplicationViewItem): string {
  if (App.IsRunning === false) return 'Not running';
  const Parts = ['Running'];
  const Count = Number(App.Count);
  if (Number.isFinite(Count) && Count > 1) Parts.push(`${Count} instances`);
  if (App.Responding === false) Parts.push('Not responding');
  if (App.IsForeground) Parts.push('In foreground');
  return Parts.join(' · ');
}

/** The badge the Monitor toggle shows, and what clicking it will do. */
export function ApplicationBadge(
  App: RunningApplicationViewItem,
  Client: ClientView
): ApplicationBadgeView {
  if (!App.IsCritical) {
    return {
      State: 'plain',
      Label: 'Monitor',
      Icon: 'bi-check-circle',
      Title: 'Monitor this application',
    };
  }
  if (App.IsRunning === false) {
    return {
      State: 'missing',
      Label: 'Not Running',
      Icon: 'bi-x-circle-fill',
      Title: 'Stop monitoring (application not running)',
    };
  }
  if (ApplicationIssues(App, Client).length) {
    return {
      State: 'issue',
      Label: 'Issue',
      Icon: 'bi-exclamation-triangle-fill',
      Title: 'Stop monitoring (conditions not met)',
    };
  }
  return {
    State: 'healthy',
    Label: 'Monitored',
    Icon: 'bi-check-circle-fill',
    Title: 'Stop monitoring',
  };
}

/** A monitored application's conditions table, one row per condition. */
export function ApplicationConditionRows(
  App: RunningApplicationViewItem,
  Client: ClientView
): ApplicationConditionRow[] {
  if (!App.IsCritical) return [];
  const Running = App.IsRunning !== false;
  const Can = Capable(Client);
  const Issues = ApplicationIssues(App, Client);
  const Failing = (Prefix: string) => Issues.find((Issue) => Issue.startsWith(Prefix)) ?? null;
  return [
    {
      Field: 'RequireRunning',
      Label: 'Is running',
      Value: YesNo(Running),
      Supported: true,
      Checked: true,
      Locked: true,
      Failing: Failing('Not running'),
    },
    {
      Field: 'RequireResponding',
      Label: 'Is responding',
      Value: Can.Responding ? (Running ? YesNo(App.Responding) : '—') : 'Unsupported',
      Supported: Can.Responding,
      Checked: App.RequireResponding !== false,
      Locked: false,
      Failing: Failing('Not responding'),
    },
    {
      Field: 'RequireForeground',
      Label: 'Is in foreground',
      Value: Can.Foreground
        ? Running && FocusKnown(Client)
          ? YesNo(!!App.IsForeground)
          : '—'
        : 'Unsupported',
      Supported: Can.Foreground,
      Checked: !!App.RequireForeground,
      Locked: false,
      Failing: Failing('Not in the foreground'),
    },
  ];
}

/**
 * Read a conditions table back into a request. Unsupported rows are left out
 * so their stored value survives — responding is on by default, and a client
 * that cannot detect hangs must not quietly switch it off.
 */
export function ApplicationConditionsPayload(
  Name: string,
  Ticks: Partial<Record<ApplicationConditionField, boolean>>
): Record<string, unknown> {
  const Payload: Record<string, unknown> = { Name };
  for (const Field of ['RequireResponding', 'RequireForeground'] as const) {
    if (typeof Ticks[Field] === 'boolean') Payload[Field] = Ticks[Field];
  }
  return Payload;
}
