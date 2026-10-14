// Critical displays — the pure half.
//
// Everything here is a function of its arguments: recognising which reported
// display a critical entry refers to, judging it against its conditions,
// building the view the renderer draws, and working out the entry a mark/update
// request produces. The Client entity (./client.ts) holds the state and calls
// these.
//
// Identity. The client gives each display the most durable id it can (see
// ShowTrak Client's DisplayMonitor): an EDID fingerprint ("edid:…"/"mac:…"),
// else the port it is plugged into ("port:…"), else a composite of its make and
// CURRENT MODE ("attr:VENDOR:PRODUCT:1920x1080@60:e"), else a per-session handle
// ("session:…"). The last two are weak: an attribute id changes with the
// resolution, and a session id with every boot. So a critical display is
// matched to a reported one rather than looked up by id:
//   1. the same id;
//   2. for attribute ids, the same id once the mode is set aside — so a display
//      whose resolution is not guarded does not go missing when it changes;
//   3. when either side's id is weak, the same name, if exactly one display and
//      one critical entry carry it — so a display the client could not
//      fingerprint this time (or could not when it was marked) is still known.
//
// The principle the audio and network halves follow holds here too: an unknown
// is never a fault. A property the client did not report is skipped rather than
// failed, and a display that is allowed to be absent has nothing judged while it
// is gone.
import type {
  ClientDisplay,
  CriticalDisplay,
  DisplayIssue,
  DisplayIssueKind,
} from '@showtrak/protocol';
import { AsRecord, normalizeDisplayID } from './normalizers';

/** DegradedWarnings entries, one per kind of fault (every configuration kind shares one). */
export const DISPLAY_WARNINGS: Record<DisplayIssueKind, string> = {
  missing: 'Missing Display',
  resolution: 'Display Configuration Changed',
  refresh_rate: 'Display Configuration Changed',
  scale: 'Display Configuration Changed',
  rotation: 'Display Configuration Changed',
  primary: 'Display Configuration Changed',
  position: 'Display Configuration Changed',
};

/** A reported display as the judging code reads it: the wire shape, loosely. */
export type ObservedDisplay = Partial<ClientDisplay>;

/** A display in the renderer's list: reported, or a critical one that was not. */
export interface DisplayViewEntry extends Record<string, unknown> {
  DisplayID: string | null;
  Label: string | null;
  IsConnected: boolean;
  IsCritical: boolean;
  Missing: boolean;
  Mismatch: boolean;
  Issues: DisplayIssue[];
  Critical: CriticalDisplay | null;
  CurrentSignature: string | null;
  ExpectedSignature: string | null;
}

// --- Values -----------------------------------------------------------------------

function WholeOrNull(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Parsed = Number(Value);
  return Number.isFinite(Parsed) ? Math.round(Parsed) : null;
}

function PositiveWholeOrNull(Value: unknown): number | null {
  const Parsed = WholeOrNull(Value);
  return Parsed !== null && Parsed > 0 ? Parsed : null;
}

function ScaleOrNull(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const Parsed = Number(Value);
  return Number.isFinite(Parsed) && Parsed > 0 ? Math.round(Parsed * 100) / 100 : null;
}

function RotationOrNull(Value: unknown): number | null {
  const Parsed = WholeOrNull(Value);
  if (Parsed === null) return null;
  return ((Parsed % 360) + 360) % 360;
}

/**
 * The values a reported display has now, each null when the client did not say.
 *
 * Resolution is in physical pixels — the reported size is in points, so it is
 * scaled up — which is the output mode an operator means by it, and keeps it
 * independent of scaling: on Windows a scaling change alters the size in points
 * while the output resolution stays put.
 */
export function displayReadings(Display: ObservedDisplay) {
  const Bounds = AsRecord(Display.Bounds);
  const Scale = ScaleOrNull(Display.ScaleFactor);
  const Pixels = (Points: unknown) => {
    const Value = PositiveWholeOrNull(Points);
    return Value === null ? null : Math.round(Value * (Scale ?? 1));
  };
  return {
    Width: Pixels(Display.Width),
    Height: Pixels(Display.Height),
    // Electron reports 0 when it cannot read the rate.
    RefreshRate: PositiveWholeOrNull(Display.RefreshRate),
    ScaleFactor: Scale,
    Rotation: RotationOrNull(Display.Rotation),
    Primary: typeof Display.Primary === 'boolean' ? Display.Primary : null,
    PositionX: WholeOrNull(Bounds.x),
    PositionY: WholeOrNull(Bounds.y),
  };
}

/** "1920 × 1080". */
export function DescribeResolution(Width: number, Height: number): string {
  return `${Width} × ${Height}`;
}

/** "200%". */
export function DescribeScale(Scale: number): string {
  return `${Math.round(Scale * 100)}%`;
}

/** "1920, 0". */
export function DescribePosition(X: number, Y: number): string {
  return `${X}, ${Y}`;
}

// Pixels derived from a size in points at a fractional scale (125%, 150%) can
// land a pixel either side of the panel's real mode, so a pixel's slack is not a
// change of resolution.
const RESOLUTION_SLACK_PX = 2;

function SameResolution(Width: number, Height: number, ExpectedW: number, ExpectedH: number) {
  return (
    Math.abs(Width - ExpectedW) <= RESOLUTION_SLACK_PX &&
    Math.abs(Height - ExpectedH) <= RESOLUTION_SLACK_PX
  );
}

// The "WIDTHxHEIGHT@HZ" string older consumers compared; kept on the view only.
function Signature(Width: unknown, Height: unknown, RefreshRate: unknown): string {
  return `${PositiveWholeOrNull(Width) ?? 0}x${PositiveWholeOrNull(Height) ?? 0}@${
    PositiveWholeOrNull(RefreshRate) ?? 0
  }`;
}

function CurrentSignature(Display: ObservedDisplay): string {
  const Now = displayReadings(Display);
  return Signature(Now.Width, Now.Height, Now.RefreshRate);
}

// --- Identity -----------------------------------------------------------------------

/** Whether an id names the display's current mode or session rather than the panel. */
export function IsWeakDisplayID(DisplayID: unknown): boolean {
  return /^(attr|session):/.test(String(DisplayID ?? ''));
}

/**
 * An attribute id with the mode set aside: "attr:VENDOR:PRODUCT:e". Null for any
 * other id, which carries no mode to set aside.
 */
export function DisplayModelKey(DisplayID: unknown): string | null {
  const Match = /^attr:(.*):\d+x\d+@\d+:([ie])$/.exec(String(DisplayID ?? ''));
  return Match ? `attr:${Match[1]}:${Match[2]}` : null;
}

function NameKey(Label: unknown): string | null {
  const Text = typeof Label === 'string' ? Label.trim().toLowerCase() : '';
  return Text || null;
}

function IdOf(Display: ObservedDisplay): string | null {
  return normalizeDisplayID(Display.DisplayID);
}

// How closely a reported display resembles a critical entry's baseline: used
// only to choose between several candidates for the same model.
function Resemblance(Display: ObservedDisplay, Critical: CriticalDisplay): number {
  const Now = displayReadings(Display);
  let Score = 0;
  if (
    Now.Width !== null &&
    Now.Height !== null &&
    Critical.Width !== null &&
    Critical.Height !== null &&
    SameResolution(Now.Width, Now.Height, Critical.Width, Critical.Height)
  ) {
    Score += 2;
  }
  if (Now.RefreshRate !== null && Now.RefreshRate === Critical.RefreshRate) Score += 1;
  if (NameKey(Display.Label) && NameKey(Display.Label) === NameKey(Critical.Label)) Score += 1;
  return Score;
}

/**
 * Which reported display each critical entry refers to, as indexes into
 * `Reported`, keyed by the critical entry's DisplayID. A critical entry with no
 * match is absent from the map; no display is matched twice.
 */
export function matchCriticalDisplays(
  Reported: ObservedDisplay[],
  Criticals: CriticalDisplay[]
): Map<string, number> {
  const Matches = new Map<string, number>();
  const Taken = new Set<number>();
  const Unmatched = () => Criticals.filter((Critical) => !Matches.has(Critical.DisplayID));
  const Free = () =>
    Reported.map((Display, Index) => ({ Display, Index })).filter(
      ({ Display, Index }) => !Taken.has(Index) && !!IdOf(Display)
    );
  const Bind = (Critical: CriticalDisplay, Index: number) => {
    Matches.set(Critical.DisplayID, Index);
    Taken.add(Index);
  };

  // 1. The same id.
  for (const Critical of Criticals) {
    const Found = Free().find(({ Display }) => IdOf(Display) === Critical.DisplayID);
    if (Found) Bind(Critical, Found.Index);
  }

  // 2. The same model, for attribute ids, whatever mode it is in now. Two
  // identical displays are paired with whichever resembles each baseline most,
  // so one going away leaves exactly one critical entry missing.
  for (const Critical of Unmatched()) {
    const Model = DisplayModelKey(Critical.DisplayID);
    if (!Model) continue;
    const Candidates = Free().filter(({ Display }) => DisplayModelKey(IdOf(Display)) === Model);
    if (!Candidates.length) continue;
    const Best = Candidates.reduce((Left, Right) =>
      Resemblance(Right.Display, Critical) > Resemblance(Left.Display, Critical) ? Right : Left
    );
    Bind(Critical, Best.Index);
  }

  // 3. The same name, when either side's id is weak and the name is unambiguous
  // on both sides. Two strong ids that differ are two different panels.
  for (const Critical of Unmatched()) {
    const Name = NameKey(Critical.Label);
    if (!Name) continue;
    const Rivals = Unmatched().filter((Other) => NameKey(Other.Label) === Name);
    if (Rivals.length !== 1) continue;
    const Candidates = Free().filter(({ Display }) => NameKey(Display.Label) === Name);
    if (Candidates.length !== 1) continue;
    const Candidate = Candidates[0]!;
    if (!IsWeakDisplayID(Critical.DisplayID) && !IsWeakDisplayID(IdOf(Candidate.Display))) {
      continue;
    }
    Bind(Critical, Candidate.Index);
  }
  return Matches;
}

// --- Critical entries -------------------------------------------------------------

function Paired(Left: number | null, Right: number | null): [number | null, number | null] {
  return Left === null || Right === null ? [null, null] : [Left, Right];
}

/** Normalise a stored or requested critical entry; null when it cannot be one. */
export function normalizeCriticalDisplayEntry(Value: unknown): CriticalDisplay | null {
  const E = AsRecord(Value);
  const DisplayID = normalizeDisplayID(E.DisplayID);
  if (!DisplayID) return null;
  const [Width, Height] = Paired(PositiveWholeOrNull(E.Width), PositiveWholeOrNull(E.Height));
  const [PositionX, PositionY] = Paired(WholeOrNull(E.PositionX), WholeOrNull(E.PositionY));
  const Label = typeof E.Label === 'string' && E.Label.trim() ? E.Label.trim().slice(0, 256) : null;
  return {
    DisplayID,
    Label,
    // sqlite hands booleans back as 0/1. A row written before presence became a
    // condition has no value at all, and was always required to be present.
    RequirePresent:
      E.RequirePresent === undefined || E.RequirePresent === null
        ? true
        : E.RequirePresent === true || E.RequirePresent === 1,
    Width,
    Height,
    RefreshRate: PositiveWholeOrNull(E.RefreshRate),
    ScaleFactor: ScaleOrNull(E.ScaleFactor),
    Rotation: RotationOrNull(E.Rotation),
    RequirePrimary: E.RequirePrimary === true || E.RequirePrimary === 1,
    PositionX,
    PositionY,
    Timestamp: Number.isFinite(Number(E.Timestamp)) && E.Timestamp ? Number(E.Timestamp) : null,
  };
}

/** The name a critical display goes by in messages. */
export function CriticalDisplayName(Critical: CriticalDisplay): string {
  return Critical.Label || 'Display';
}

/**
 * Judge one critical display. `Display` is null when no reported display matched
 * it. A missing display only faults when presence is required; its other
 * conditions describe it while it is connected, so they are not judged while it
 * is not.
 */
export function evaluateDisplayIssues(
  Display: ObservedDisplay | null,
  Critical: CriticalDisplay
): DisplayIssue[] {
  if (!Display) {
    return Critical.RequirePresent
      ? [{ Kind: 'missing', Message: `${CriticalDisplayName(Critical)} is not connected` }]
      : [];
  }
  const Now = displayReadings(Display);
  const Issues: DisplayIssue[] = [];

  if (
    Critical.Width !== null &&
    Critical.Height !== null &&
    Now.Width !== null &&
    Now.Height !== null &&
    !SameResolution(Now.Width, Now.Height, Critical.Width, Critical.Height)
  ) {
    Issues.push({
      Kind: 'resolution',
      Message: `Resolution is ${DescribeResolution(Now.Width, Now.Height)} (expected ${DescribeResolution(
        Critical.Width,
        Critical.Height
      )})`,
    });
  }
  if (
    Critical.RefreshRate !== null &&
    Now.RefreshRate !== null &&
    Now.RefreshRate !== Critical.RefreshRate
  ) {
    Issues.push({
      Kind: 'refresh_rate',
      Message: `Refresh rate is ${Now.RefreshRate} Hz (expected ${Critical.RefreshRate} Hz)`,
    });
  }
  if (
    Critical.ScaleFactor !== null &&
    Now.ScaleFactor !== null &&
    Math.abs(Now.ScaleFactor - Critical.ScaleFactor) >= 0.01
  ) {
    Issues.push({
      Kind: 'scale',
      Message: `Scaling is ${DescribeScale(Now.ScaleFactor)} (expected ${DescribeScale(
        Critical.ScaleFactor
      )})`,
    });
  }
  if (Critical.Rotation !== null && Now.Rotation !== null && Now.Rotation !== Critical.Rotation) {
    Issues.push({
      Kind: 'rotation',
      Message: `Rotation is ${Now.Rotation}° (expected ${Critical.Rotation}°)`,
    });
  }
  if (Critical.RequirePrimary && Now.Primary === false) {
    Issues.push({ Kind: 'primary', Message: 'Not the primary display' });
  }
  if (
    Critical.PositionX !== null &&
    Critical.PositionY !== null &&
    Now.PositionX !== null &&
    Now.PositionY !== null &&
    (Now.PositionX !== Critical.PositionX || Now.PositionY !== Critical.PositionY)
  ) {
    Issues.push({
      Kind: 'position',
      Message: `Position is ${DescribePosition(Now.PositionX, Now.PositionY)} (expected ${DescribePosition(
        Critical.PositionX,
        Critical.PositionY
      )})`,
    });
  }
  return Issues;
}

export interface DisplayViewResult {
  List: DisplayViewEntry[];
  /** Critical displays required to be connected that are not (only populated when trusted). */
  Missing: DisplayViewEntry[];
  /** Connected critical displays breaking a condition (only populated when trusted). */
  Mismatched: DisplayViewEntry[];
  /** De-duplicated DegradedWarnings entries, in a stable order. */
  Warnings: string[];
}

/**
 * Merge the reported displays with the critical baselines into the renderer's
 * list. `Trusted` is whether the list was reported on this connection: until
 * then nothing is judged, and a critical display that has not been reported
 * reads as not reported rather than as missing.
 */
export function buildDisplayView(
  Displays: ObservedDisplay[],
  Criticals: CriticalDisplay[],
  Trusted: boolean
): DisplayViewResult {
  const Reported = Array.isArray(Displays) ? Displays : [];
  const Unique: CriticalDisplay[] = [];
  for (const Entry of Array.isArray(Criticals) ? Criticals : []) {
    if (Entry && Entry.DisplayID && !Unique.some((E) => E.DisplayID === Entry.DisplayID)) {
      Unique.push(Entry);
    }
  }
  const Matches = matchCriticalDisplays(Reported, Unique);
  const CriticalAt = new Map<number, CriticalDisplay>();
  for (const Critical of Unique) {
    const Index = Matches.get(Critical.DisplayID);
    if (Index !== undefined) CriticalAt.set(Index, Critical);
  }

  const Connected: DisplayViewEntry[] = Reported.map((Display, Index) => {
    const Critical = CriticalAt.get(Index) || null;
    const Issues = Critical && Trusted ? evaluateDisplayIssues(Display, Critical) : [];
    return {
      ...(Display || {}),
      DisplayID: IdOf(Display || {}),
      Label:
        (Display && typeof Display.Label === 'string' && Display.Label) || Critical?.Label || null,
      IsConnected: true,
      IsCritical: !!Critical,
      Missing: false,
      Mismatch: Issues.length > 0,
      Issues,
      Critical,
      CurrentSignature: CurrentSignature(Display || {}),
      ExpectedSignature: Critical
        ? Signature(Critical.Width, Critical.Height, Critical.RefreshRate)
        : null,
    };
  });

  const Absent: DisplayViewEntry[] = [];
  for (const Critical of Unique) {
    if (Matches.has(Critical.DisplayID)) continue;
    const Issues = Trusted ? evaluateDisplayIssues(null, Critical) : [];
    Absent.push({
      DisplayID: Critical.DisplayID,
      Label: Critical.Label,
      // The baseline is in pixels; a reported size is in points at ScaleFactor.
      Width: Critical.Width,
      Height: Critical.Height,
      RefreshRate: Critical.RefreshRate,
      ScaleFactor: 1,
      Rotation: Critical.Rotation,
      IsConnected: false,
      IsCritical: true,
      // Absent but allowed to be: shown as not connected, never as missing.
      Missing: Trusted && Critical.RequirePresent,
      Mismatch: false,
      Issues,
      Critical,
      CurrentSignature: null,
      ExpectedSignature: Signature(Critical.Width, Critical.Height, Critical.RefreshRate),
    });
  }

  const List = Connected.concat(Absent);
  const Warnings: string[] = [];
  if (Trusted) {
    for (const Entry of List) {
      for (const Issue of Entry.Issues) {
        const Warning = DISPLAY_WARNINGS[Issue.Kind];
        if (!Warnings.includes(Warning)) Warnings.push(Warning);
      }
    }
  }
  return {
    List,
    Missing: Trusted ? Absent.filter((Entry) => Entry.Missing) : [],
    Mismatched: Trusted ? Connected.filter((Entry) => Entry.Mismatch) : [],
    Warnings,
  };
}

/** Options a mark/update request may carry; absent ones keep their current value. */
export interface CriticalDisplayOptions {
  RequirePresent?: boolean;
  RequirePrimary?: boolean;
  CheckResolution?: boolean;
  CheckRefreshRate?: boolean;
  CheckScale?: boolean;
  CheckRotation?: boolean;
  CheckPosition?: boolean;
}

type CheckOption = Exclude<keyof CriticalDisplayOptions, 'RequirePresent' | 'RequirePrimary'>;

/**
 * Work out the critical entry a mark/update request produces.
 *
 * A FIRST mark guards what the old display guard did: the display must stay
 * connected, at the resolution and refresh rate it has now. Ticking any other
 * property guards the value it has at that moment; a property that is already
 * guarded keeps its baseline, so editing one condition never quietly accepts a
 * change to another. A disconnected display can have conditions cleared, but
 * not new ones captured — there is nothing to capture.
 *
 * `DisplayID` is the id the entry is stored under: the existing entry's, or the
 * live display's on a first mark.
 */
export function resolveCriticalDisplayEntry(
  DisplayID: string,
  Options: CriticalDisplayOptions,
  Live: ObservedDisplay | null,
  Existing: CriticalDisplay | null,
  Now: number
): [string | null, CriticalDisplay | null] {
  if (!Live && !Existing) return ['That display is not connected to this client', null];
  const Has = (Key: keyof CriticalDisplayOptions) =>
    Object.prototype.hasOwnProperty.call(Options, Key) && Options[Key] !== undefined;
  const Flag = (Key: 'RequirePresent' | 'RequirePrimary', First: boolean) =>
    Has(Key) ? !!Options[Key] : Existing ? Existing[Key] : First;
  const Wants = (Key: CheckOption, Guarded: boolean, First: boolean) =>
    Has(Key) ? !!Options[Key] : Existing ? Guarded : First;
  const Reading = Live ? displayReadings(Live) : null;

  const Errors: string[] = [];
  // The guarded value(s) for one property: the baseline it already has, else the
  // live reading, else nothing to guard.
  const Capture = <T extends number>(
    Want: boolean,
    Kept: Array<T | null>,
    Read: Array<T | null> | null,
    What: string
  ): Array<T | null> => {
    if (!Want) return Kept.map(() => null);
    if (Kept.every((Value) => Value !== null)) return Kept;
    if (Read && Read.every((Value) => Value !== null)) return Read;
    Errors.push(
      Live
        ? `This display does not report its ${What}`
        : `Connect the display to start monitoring its ${What}`
    );
    return Kept.map(() => null);
  };

  const [Width, Height] = Capture(
    Wants('CheckResolution', Existing?.Width != null, true),
    [Existing?.Width ?? null, Existing?.Height ?? null],
    Reading ? [Reading.Width, Reading.Height] : null,
    'resolution'
  );
  const [RefreshRate] = Capture(
    // A first mark on a display that cannot read its rate just leaves it unguarded.
    Wants('CheckRefreshRate', Existing?.RefreshRate != null, Reading?.RefreshRate != null),
    [Existing?.RefreshRate ?? null],
    Reading ? [Reading.RefreshRate] : null,
    'refresh rate'
  );
  const [ScaleFactor] = Capture(
    Wants('CheckScale', Existing?.ScaleFactor != null, false),
    [Existing?.ScaleFactor ?? null],
    Reading ? [Reading.ScaleFactor] : null,
    'scaling'
  );
  const [Rotation] = Capture(
    Wants('CheckRotation', Existing?.Rotation != null, false),
    [Existing?.Rotation ?? null],
    Reading ? [Reading.Rotation] : null,
    'rotation'
  );
  const [PositionX, PositionY] = Capture(
    Wants('CheckPosition', Existing?.PositionX != null, false),
    [Existing?.PositionX ?? null, Existing?.PositionY ?? null],
    Reading ? [Reading.PositionX, Reading.PositionY] : null,
    'position'
  );
  const RequirePrimary = Flag('RequirePrimary', false);
  if (RequirePrimary && !Existing?.RequirePrimary && Reading && Reading.Primary === null) {
    Errors.push('This display does not report whether it is the primary display');
  }
  if (Errors.length) return [Errors[0]!, null];

  const LiveLabel = Live && typeof Live.Label === 'string' && Live.Label.trim() ? Live.Label : null;
  return [
    null,
    normalizeCriticalDisplayEntry({
      DisplayID,
      Label: LiveLabel ?? Existing?.Label ?? null,
      RequirePresent: Flag('RequirePresent', true),
      Width,
      Height,
      RefreshRate,
      ScaleFactor,
      Rotation,
      RequirePrimary,
      PositionX,
      PositionY,
      Timestamp: Existing?.Timestamp ?? Now,
    }),
  ];
}
