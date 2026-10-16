// Audit log rendering (pure): entry rows, day dividers, and the filter a live
// entry is checked against before it joins an open list. Shared by the Logs
// tab of the view modal and the Audit Log modal.
import type {
  AuditCategory,
  AuditEntityType,
  AuditLogEntry,
  AuditLogQuery,
  AuditSegment,
} from '@showtrak/protocol';
import { Safe } from '../utils';

const ENTITY_TYPE_LABELS: Record<AuditEntityType, string> = {
  client: 'Client',
  freekiosk: 'FreeKiosk Terminal',
  dummy: 'Dummy Client',
  monitor: 'Monitor',
  group: 'Group',
  tag: 'Tag',
  script: 'Script',
  'alert-rule': 'Alert Rule',
  variable: 'Variable',
  system: 'ShowTrak',
};

const CATEGORY_LABELS: Record<AuditCategory, string> = {
  status: 'Status',
  edit: 'Edit',
  action: 'Action',
};

// The filters the Audit Log modal offers, in menu order.
export const AUDIT_ENTITY_TYPE_OPTIONS: ReadonlyArray<[AuditEntityType | '', string]> = [
  ['', 'Everything'],
  ['client', 'Clients'],
  ['freekiosk', 'FreeKiosk Terminals'],
  ['dummy', 'Dummy Clients'],
  ['monitor', 'Monitors'],
  ['group', 'Groups'],
  ['tag', 'Tags'],
  ['script', 'Scripts'],
  ['alert-rule', 'Alert Rules'],
  ['variable', 'Variables'],
  ['system', 'ShowTrak'],
];

export const AUDIT_CATEGORY_OPTIONS: ReadonlyArray<[AuditCategory | '', string]> = [
  ['', 'All Activity'],
  ['status', 'Status Changes'],
  ['edit', 'Edits'],
  ['action', 'Actions'],
];

// Entities whose view modal can be opened from a log row.
const VIEWABLE_TYPES = new Set<AuditEntityType>(['client', 'freekiosk', 'dummy', 'monitor']);

export function AuditEntityTypeLabel(Type: string): string {
  return ENTITY_TYPE_LABELS[Type as AuditEntityType] || 'ShowTrak';
}

export function AuditCategoryLabel(Category: string): string {
  return CATEGORY_LABELS[Category as AuditCategory] || 'Status';
}

function Pad(Value: number): string {
  return String(Value).padStart(2, '0');
}

/** HH:MM:SS, local time. */
export function FormatAuditTime(Timestamp: number): string {
  const At = new Date(Timestamp);
  return `${Pad(At.getHours())}:${Pad(At.getMinutes())}:${Pad(At.getSeconds())}`;
}

function DayKey(Timestamp: number): string {
  const At = new Date(Timestamp);
  return `${At.getFullYear()}-${At.getMonth()}-${At.getDate()}`;
}

/** "Today", "Yesterday", or the date, for the divider above a day's entries. */
export function FormatAuditDay(Timestamp: number, Now: number = Date.now()): string {
  if (DayKey(Timestamp) === DayKey(Now)) return 'Today';
  const Yesterday = new Date(Now);
  Yesterday.setDate(Yesterday.getDate() - 1);
  if (DayKey(Timestamp) === DayKey(Yesterday.getTime())) return 'Yesterday';
  return new Date(Timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** The full local date and time, for a row's tooltip. */
export function FormatAuditTimestamp(Timestamp: number): string {
  return new Date(Timestamp).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function AuditSummaryHtml(Segments: readonly AuditSegment[]): string {
  return (Array.isArray(Segments) ? Segments : [])
    .map((Segment) => {
      const Text = Safe(Segment && Segment.T);
      if (!Segment || !Segment.H) return Text;
      return `<span class="audit-hl audit-hl-${Safe(Segment.H)}">${Text}</span>`;
    })
    .join('');
}

export function AuditSummaryText(Segments: readonly AuditSegment[]): string {
  return (Array.isArray(Segments) ? Segments : []).map((Segment) => Segment.T).join('');
}

export interface AuditRowOptions {
  // The Audit Log modal names the entity on every row; a Logs tab, which is
  // already about one entity, does not.
  ShowEntity: boolean;
}

function EntityChipHtml(Entry: AuditLogEntry): string {
  const Name = Entry.EntityName || AuditEntityTypeLabel(Entry.EntityType);
  const Title = AuditEntityTypeLabel(Entry.EntityType);
  if (Entry.EntityID && VIEWABLE_TYPES.has(Entry.EntityType)) {
    return `<button type="button" class="audit-entity" data-audit-entity-type="${Safe(Entry.EntityType)}" data-audit-entity-id="${Safe(Entry.EntityID)}" title="Open ${Safe(Title)}">${Safe(Name)}</button>`;
  }
  return `<span class="audit-entity" title="${Safe(Title)}">${Safe(Name)}</span>`;
}

export function AuditEntryHtml(Entry: AuditLogEntry, Options: AuditRowOptions): string {
  const Changes = (Entry.Changes || [])
    .map(
      (Change) =>
        `<li><span class="audit-change-field">${Safe(Change.Field)}</span> ${
          Change.From === null && Change.To === 'Changed'
            ? '<span class="audit-change-to">Changed</span>'
            : `<span class="audit-change-from">${Safe(Change.From ?? 'None')}</span><span class="audit-change-arrow" aria-label="to">→</span><span class="audit-change-to">${Safe(Change.To ?? 'None')}</span>`
        }</li>`
    )
    .join('');
  const Details = (Entry.Details || []).map((Line) => `<li>${Safe(Line)}</li>`).join('');
  // A status row's dot already says what it is; edits and actions say who.
  const Meta =
    Entry.Category === 'status'
      ? []
      : [AuditCategoryLabel(Entry.Category), Entry.Source].filter(Boolean).map(Safe);
  // Beside the entity's own chip, a summary that opens with its name would
  // say it twice ("CONSOLE-01 CONSOLE-01 Disconnected").
  const Summary =
    Options.ShowEntity &&
    Entry.Summary[0] &&
    Entry.Summary[0].H === 'entity' &&
    Entry.Summary[0].T === Entry.EntityName
      ? Entry.Summary.slice(1).map((Segment, Index) =>
          Index === 0 ? { ...Segment, T: Segment.T.replace(/^\s+/, '') } : Segment
        )
      : Entry.Summary;
  return `<div class="audit-entry" data-audit-id="${Safe(Entry.ID)}" data-severity="${Safe(Entry.Severity)}" data-category="${Safe(Entry.Category)}">
    <time class="audit-time" datetime="${Safe(new Date(Entry.Timestamp).toISOString())}" title="${Safe(FormatAuditTimestamp(Entry.Timestamp))}">${Safe(FormatAuditTime(Entry.Timestamp))}</time>
    <span class="audit-marker" aria-hidden="true"></span>
    <div class="audit-body">
      <div class="audit-line">${Options.ShowEntity ? EntityChipHtml(Entry) : ''}<span class="audit-summary">${AuditSummaryHtml(Summary)}</span></div>
      ${Changes ? `<ul class="audit-changes">${Changes}</ul>` : ''}
      ${Details ? `<ul class="audit-details">${Details}</ul>` : ''}
      ${Meta.length ? `<div class="audit-meta">${Meta.join(' · ')}</div>` : ''}
    </div>
  </div>`;
}

/** Rows newest first, with a divider wherever the day changes. */
export function AuditEntriesHtml(
  Entries: readonly AuditLogEntry[],
  Options: AuditRowOptions,
  Now: number = Date.now()
): string {
  let LastDay = '';
  const Html: string[] = [];
  for (const Entry of Entries) {
    const Day = DayKey(Entry.Timestamp);
    if (Day !== LastDay) {
      LastDay = Day;
      Html.push(
        `<div class="audit-day" role="separator">${Safe(FormatAuditDay(Entry.Timestamp, Now))}</div>`
      );
    }
    Html.push(AuditEntryHtml(Entry, Options));
  }
  return Html.join('');
}

/**
 * Whether a pushed entry belongs in a list showing `Query`, judged the same
 * way the server filters a read (search is a case-insensitive substring of the
 * name, summary, details, changes and source).
 */
export function AuditEntryMatches(Entry: AuditLogEntry, Query: AuditLogQuery): boolean {
  if (Query.EntityType && Entry.EntityType !== Query.EntityType) return false;
  if (Query.EntityID && Entry.EntityID !== String(Query.EntityID)) return false;
  if (Query.Category && Entry.Category !== Query.Category) return false;
  const Search = typeof Query.Search === 'string' ? Query.Search.trim().toLowerCase() : '';
  if (!Search) return true;
  const Haystack = [
    Entry.EntityName || '',
    AuditSummaryText(Entry.Summary),
    ...(Entry.Details || []),
    ...(Entry.Changes || []).map(
      (Change) => `${Change.Field} ${Change.From ?? ''} ${Change.To ?? ''}`
    ),
    Entry.Source || '',
  ]
    .join('\n')
    .toLowerCase();
  return Haystack.includes(Search);
}

/** Merge entries into a newest-first list, dropping any already held. */
export function MergeAuditEntries(
  Held: readonly AuditLogEntry[],
  Incoming: readonly AuditLogEntry[]
): AuditLogEntry[] {
  const Seen = new Set<number>();
  const Merged: AuditLogEntry[] = [];
  for (const Entry of [...Incoming, ...Held]) {
    if (!Entry || Seen.has(Entry.ID)) continue;
    Seen.add(Entry.ID);
    Merged.push(Entry);
  }
  return Merged.sort((A, B) => B.ID - A.ID);
}
