// Displays section of the client info modal — the decisions, without the DOM.
//
// What the section shows, the badge each display's critical toggle wears, the
// conditions a critical display can be held to, and turning the conditions
// table back into a request. Mirrors lib/audio-devices and lib/network-interfaces.
import type { ClientDisplayView, ClientView, CriticalDisplay } from '@showtrak/protocol';

/**
 * Which overall message the section shows:
 *  - `outdated`: the client predates display monitoring — no list, no controls;
 *  - `offline`: nothing live to show beyond the critical baselines;
 *  - `ok`: render the displays.
 */
export type DisplaySectionState = 'outdated' | 'offline' | 'ok';

export function GetDisplaySectionState(
  Client: ClientView,
  Supported: boolean
): DisplaySectionState {
  if (!Supported) return 'outdated';
  if (!Client.Online) return 'offline';
  return 'ok';
}

/** The displays the section lists: offline, only the critical ones' baselines. */
export function VisibleDisplays(
  Client: ClientView,
  State: DisplaySectionState
): ClientDisplayView[] {
  if (State === 'outdated') return [];
  const List = Array.isArray(Client.DisplayList) ? Client.DisplayList : [];
  return State === 'offline' ? List.filter((Display) => Display.IsCritical) : List;
}

/** The id the critical toggle and conditions act on: the entry's own once critical. */
export function DisplayKey(Display: ClientDisplayView): string {
  return String(Display.Critical?.DisplayID || Display.DisplayID || '').trim();
}

/** The name a display goes by on its card. */
export function DisplayTitle(Display: ClientDisplayView): string {
  const Label = typeof Display.Label === 'string' ? Display.Label.trim() : '';
  if (Label) return Label;
  return Display.Primary ? 'Primary Display' : 'Display';
}

/** "3840 × 2160": the resolution in physical pixels, or null when it is not reported. */
export function PixelResolution(Display: {
  Width?: unknown;
  Height?: unknown;
  ScaleFactor?: unknown;
}): string | null {
  const Width = Number(Display.Width);
  const Height = Number(Display.Height);
  if (!(Width > 0) || !(Height > 0)) return null;
  const Scale = Number(Display.ScaleFactor);
  const Factor = Number.isFinite(Scale) && Scale > 0 ? Scale : 1;
  return `${Math.round(Width * Factor)} × ${Math.round(Height * Factor)}`;
}

function RefreshText(Rate: unknown): string | null {
  const Value = Math.round(Number(Rate));
  return Number.isFinite(Value) && Value > 0 ? `${Value} Hz` : null;
}

function ScaleText(Scale: unknown): string | null {
  const Value = Number(Scale);
  return Number.isFinite(Value) && Value > 0 ? `${Math.round(Value * 100)}%` : null;
}

function RotationText(Rotation: unknown): string | null {
  if (Rotation === null || Rotation === undefined || Rotation === '') return null;
  const Value = Math.round(Number(Rotation));
  return Number.isFinite(Value) ? `${Value}°` : null;
}

function PositionText(X: unknown, Y: unknown): string | null {
  if (X === null || X === undefined || Y === null || Y === undefined) return null;
  const Left = Math.round(Number(X));
  const Top = Math.round(Number(Y));
  return Number.isFinite(Left) && Number.isFinite(Top) ? `${Left}, ${Top}` : null;
}

/**
 * The card's subtitle: "3840 × 2160 · 60 Hz · 200%", plus the rotation when the
 * display is turned. A display that is not connected says so instead.
 */
export function DisplaySummary(Display: ClientDisplayView): string {
  if (!Display.IsConnected && Display.IsConnected !== undefined) {
    if (Display.Missing) return 'Not connected';
    return Display.Critical && !Display.Critical.RequirePresent
      ? 'Not connected'
      : 'Not reported yet';
  }
  const Rotation = Math.round(Number(Display.Rotation));
  const Parts = [
    PixelResolution(Display) ?? 'Resolution unavailable',
    RefreshText(Display.RefreshRate),
    ScaleText(Display.ScaleFactor),
    Number.isFinite(Rotation) && Rotation % 360 !== 0 ? `Rotated ${Rotation}°` : null,
  ];
  return Parts.filter(Boolean).join(' · ');
}

export type DisplayState = 'healthy' | 'issue' | 'missing' | 'unreported' | 'absent' | 'plain';

/** The badge the critical toggle shows, and what clicking it will do. */
export function DisplayBadge(Display: ClientDisplayView): {
  State: DisplayState;
  Label: string;
  Icon: string;
  Title: string;
} {
  if (!Display.IsCritical) {
    return {
      State: 'plain',
      Label: 'Critical',
      Icon: 'bi-check-circle',
      Title: 'Mark as critical',
    };
  }
  if (Display.Missing) {
    return {
      State: 'missing',
      Label: 'Missing',
      Icon: 'bi-x-circle-fill',
      Title: 'Remove critical status (display disconnected)',
    };
  }
  if (Display.IsConnected === false) {
    const Allowed = !!Display.Critical && !Display.Critical.RequirePresent;
    return {
      State: Allowed ? 'absent' : 'unreported',
      Label: 'Critical',
      Icon: 'bi-question-circle',
      Title: Allowed
        ? 'Remove critical status (not connected)'
        : 'Remove critical status (not reported yet)',
    };
  }
  if ((Display.Issues || []).length || Display.Mismatch) {
    return {
      State: 'issue',
      Label: 'Changed',
      Icon: 'bi-exclamation-triangle-fill',
      Title: 'Remove critical status (conditions not met)',
    };
  }
  return {
    State: 'healthy',
    Label: 'Critical',
    Icon: 'bi-check-circle-fill',
    Title: 'Remove critical status',
  };
}

/** A condition a critical display can be held to, as its form field is named. */
export type DisplayConditionField =
  | 'RequirePresent'
  | 'CheckResolution'
  | 'CheckRefreshRate'
  | 'CheckScale'
  | 'CheckRotation'
  | 'RequirePrimary'
  | 'CheckPosition';

/** One row of a critical display's conditions table. */
export interface DisplayConditionRow {
  Field: DisplayConditionField;
  /** Key-style label, e.g. "Refresh rate". */
  Label: string;
  /**
   * What is guarded ("3840 × 2160") when monitored, else what the display
   * reports now; "—" when neither is known, "Unsupported" when it cannot be held.
   */
  Value: string;
  /** Whether this display can be held to it. A condition already set always is, so it can be cleared. */
  Supported: boolean;
  /** Whether the condition is being monitored. */
  Checked: boolean;
  /** The issue this condition currently raises, when it is not met. */
  Failing: string | null;
}

const YesNo = (Value: boolean | null | undefined) =>
  Value === null || Value === undefined ? '—' : Value ? 'Yes' : 'No';

/**
 * The conditions table of a critical display, one row per condition. A guarded
 * property shows its baseline (what it must be); an unguarded one what the
 * display reports now (what ticking it would guard). A disconnected display can
 * only have conditions cleared — there is nothing to capture a new one from.
 */
export function DisplayConditionRows(Display: ClientDisplayView): DisplayConditionRow[] {
  const Critical: CriticalDisplay | null | undefined = Display.Critical;
  if (!Display.IsCritical || !Critical) return [];
  const Connected = Display.IsConnected !== false;
  const Issue = (Kind: string) =>
    (Display.Issues || []).find((Candidate) => Candidate.Kind === Kind)?.Message ?? null;
  const Row = (
    Field: DisplayConditionField,
    Label: string,
    Guarded: string | null,
    Live: string | null,
    Checked: boolean,
    Failing: string | null,
    AlwaysSupported = false
  ): DisplayConditionRow => {
    const Supported = Checked || AlwaysSupported || (Connected && Live !== null);
    return {
      Field,
      Label,
      Value: !Supported ? 'Unsupported' : ((Checked ? Guarded : null) ?? Live ?? '—'),
      Supported,
      Checked,
      Failing,
    };
  };
  const LiveOnly = <T>(Value: T) => (Connected ? Value : null);
  return [
    Row(
      'RequirePresent',
      'Connected',
      null,
      Connected ? 'Yes' : 'No',
      Critical.RequirePresent,
      Issue('missing'),
      true
    ),
    Row(
      'CheckResolution',
      'Resolution',
      Critical.Width !== null && Critical.Height !== null
        ? `${Critical.Width} × ${Critical.Height}`
        : null,
      LiveOnly(PixelResolution(Display)),
      Critical.Width !== null,
      Issue('resolution')
    ),
    Row(
      'CheckRefreshRate',
      'Refresh rate',
      RefreshText(Critical.RefreshRate),
      LiveOnly(RefreshText(Display.RefreshRate)),
      Critical.RefreshRate !== null,
      Issue('refresh_rate')
    ),
    Row(
      'CheckScale',
      'Scaling',
      ScaleText(Critical.ScaleFactor),
      LiveOnly(ScaleText(Display.ScaleFactor)),
      Critical.ScaleFactor !== null,
      Issue('scale')
    ),
    Row(
      'CheckRotation',
      'Rotation',
      RotationText(Critical.Rotation),
      LiveOnly(RotationText(Display.Rotation)),
      Critical.Rotation !== null,
      Issue('rotation')
    ),
    Row(
      'RequirePrimary',
      'Is primary display',
      null,
      LiveOnly(typeof Display.Primary === 'boolean' ? YesNo(Display.Primary) : null),
      Critical.RequirePrimary,
      Issue('primary')
    ),
    Row(
      'CheckPosition',
      'Position',
      PositionText(Critical.PositionX, Critical.PositionY),
      LiveOnly(PositionText(Display.Bounds?.x, Display.Bounds?.y)),
      Critical.PositionX !== null,
      Issue('position')
    ),
  ];
}

/** Rebuild the list only when something it shows changes. */
export function DisplayRenderKey(Client: ClientView, State: DisplaySectionState): string {
  const Prefix = `${Client.UUID}::${State}`;
  if (State === 'outdated') return Prefix;
  const Displays = VisibleDisplays(Client, State).map((Display) =>
    [
      DisplayKey(Display),
      DisplayTitle(Display),
      Display.ScreenNumber ?? '',
      Display.Primary ? 1 : 0,
      DisplaySummary(Display),
      DisplayBadge(Display).State,
      (Display.Issues || []).map((Issue) => Issue.Message).join(','),
      DisplayConditionRows(Display)
        .map((Row) => `${Row.Field}:${Row.Supported ? 1 : 0}${Row.Checked ? 1 : 0}:${Row.Value}`)
        .join(','),
    ].join('|')
  );
  return `${Prefix}::${Displays.join(';;')}`;
}

/** The ticks of a critical display's conditions form, as read from the DOM. */
export type DisplayRuleFields = Record<DisplayConditionField, boolean>;

/** Turn the conditions form into a request. */
export function ParseDisplayRuleFields(
  DisplayID: string,
  Fields: DisplayRuleFields
): { DisplayID: string } & DisplayRuleFields {
  return {
    DisplayID,
    RequirePresent: !!Fields.RequirePresent,
    CheckResolution: !!Fields.CheckResolution,
    CheckRefreshRate: !!Fields.CheckRefreshRate,
    CheckScale: !!Fields.CheckScale,
    CheckRotation: !!Fields.CheckRotation,
    RequirePrimary: !!Fields.RequirePrimary,
    CheckPosition: !!Fields.CheckPosition,
  };
}

/**
 * The live state of a critical display's history row: green while connected and
 * meeting its conditions, orange while connected but not, red while missing.
 * Idle while the client is offline or the display has not been judged yet — a
 * timeline must never paint a state nobody observed.
 */
export function DisplayTimelineLiveState(
  Display: ClientDisplayView,
  Online: boolean
): { State: 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE'; Label: string } {
  if (!Online) return { State: 'IDLE', Label: 'Idle' };
  if (Display.Missing) return { State: 'OFFLINE', Label: 'Missing' };
  if (Display.IsConnected === false) {
    const Allowed = !!Display.Critical && !Display.Critical.RequirePresent;
    return { State: 'IDLE', Label: Allowed ? 'Not Connected' : 'Not Reported' };
  }
  const Issues = Display.Issues || [];
  if (Issues.length) {
    return { State: 'DEGRADED', Label: Issues.map((Issue) => Issue.Message).join('; ') };
  }
  if (Display.Mismatch) return { State: 'DEGRADED', Label: 'Configuration Changed' };
  return { State: 'ONLINE', Label: 'Connected' };
}
