// Pure rules behind the search filter (Ctrl/Cmd+F), in every view mode. No
// DOM, no module state: ../list-filter.ts owns the search box and hides the
// rows; this decides which rows a search keeps.
//
// A row is searched by what an operator would type to find it: its name, its
// tags, its address and the name of the group it sits in. Each word of the
// search must appear somewhere in those (in any field, in any order), so
// "stage 10.0" narrows to the stage machines on that subnet rather than to
// nothing.
import type {
  ClientView,
  DummyClientView,
  FreeKioskTerminalView,
  GroupView,
  MonitoringTargetView,
  TagView,
} from '@showtrak/protocol';
import { ResolveEntityTags, TagBadgeLabel } from './tag-badges';
import { CHECK_SELECTION_PREFIX } from './list-view';

/** The search box's text as lower-cased words. No words means no filter. */
export function ParseListSearch(Query: unknown): string[] {
  const Text = typeof Query === 'string' ? Query.trim().toLowerCase() : '';
  return Text ? Text.split(/\s+/) : [];
}

/** Whether every word appears in at least one of a row's fields. */
export function MatchesListSearch(Fields: readonly string[], Terms: readonly string[]): boolean {
  if (!Terms.length) return true;
  const Haystack = Fields.map((Field) => Field.toLowerCase());
  return Terms.every((Term) => Haystack.some((Field) => Field.includes(Term)));
}

export interface ListSearchEntities {
  Groups: Pick<GroupView, 'GroupID' | 'Title'>[];
  Tags: TagView[];
  Clients: Pick<ClientView, 'UUID' | 'Nickname' | 'Hostname' | 'IP' | 'GroupID'>[];
  Monitors: Pick<
    MonitoringTargetView,
    'TargetID' | 'Nickname' | 'Address' | 'GroupID' | 'Checks'
  >[];
  Dummies: Pick<DummyClientView, 'UUID' | 'DummyID' | 'Nickname' | 'IP' | 'GroupID'>[];
  Kiosks: Pick<FreeKioskTerminalView, 'UUID' | 'Nickname' | 'Address' | 'IP' | 'GroupID'>[];
  /** Devices awaiting adoption: no group and no tags, only a name and address. */
  Pending: Pick<ClientView, 'UUID' | 'Hostname' | 'IP'>[];
}

/**
 * Every row's searchable fields, keyed by the row's data-uuid — the same keys
 * the tiles carry: a client's UUID, `monitor:<TargetID>`, `dummy:<UUID>`,
 * `kiosk:<UUID>`. A monitoring target's check rows are not keyed: they show
 * and hide with their target, so a target is also found by its checks' names
 * and addresses.
 *
 * Tags are resolved with the same scope ids the tile builders use, so a row is
 * found by exactly the tags its badges show — and by hidden tags as well, which
 * exist to target machines and are just as much a way of naming them.
 */
export function BuildListSearchIndex(Entities: ListSearchEntities): Map<string, string[]> {
  const GroupTitles = new Map<number | null, string>();
  for (const Group of Entities.Groups || []) {
    if (!Group) continue;
    GroupTitles.set(Group.GroupID ?? null, Group.Title == null ? '' : String(Group.Title));
  }
  const Tags = Array.isArray(Entities.Tags) ? Entities.Tags : [];
  const Out = new Map<string, string[]>();

  const Add = (
    Key: string,
    ScopedID: string,
    GroupID: number | null | undefined,
    Fields: unknown[]
  ) => {
    const Group = GroupID ?? null;
    const TagLabels = ResolveEntityTags(Tags, { ScopedID, GroupID: Group }).map(TagBadgeLabel);
    Out.set(
      Key,
      [...Fields, GroupTitles.get(Group) ?? '', ...TagLabels]
        .filter((Field) => Field != null && Field !== '')
        .map(String)
    );
  };

  for (const C of Entities.Clients || []) {
    if (!C || !C.UUID) continue;
    Add(String(C.UUID), String(C.UUID), C.GroupID, [C.Nickname, C.Hostname, C.IP]);
  }
  for (const T of Entities.Monitors || []) {
    if (!T || T.TargetID == null) continue;
    const Key = `monitor:${T.TargetID}`;
    const Checks = Array.isArray(T.Checks) ? T.Checks : [];
    Add(Key, Key, T.GroupID, [
      T.Nickname,
      T.Address,
      ...Checks.flatMap((Check) => (Check ? [Check.Name, Check.Address] : [])),
    ]);
  }
  for (const D of Entities.Dummies || []) {
    if (!D || !D.UUID) continue;
    Add(`dummy:${D.UUID}`, String(D.UUID), D.GroupID, [D.Nickname, D.DummyID, D.IP]);
  }
  for (const K of Entities.Kiosks || []) {
    if (!K || !K.UUID) continue;
    Add(`kiosk:${K.UUID}`, String(K.UUID), K.GroupID, [K.Nickname, K.Address, K.IP]);
  }
  for (const P of Entities.Pending || []) {
    if (!P || !P.UUID) continue;
    Out.set(
      String(P.UUID),
      [P.Hostname, P.IP].filter((Field) => Field != null && Field !== '').map(String)
    );
  }
  return Out;
}

/** The keys of the rows a search keeps. */
export function MatchListSearch(
  Index: ReadonlyMap<string, readonly string[]>,
  Terms: readonly string[]
): Set<string> {
  const Out = new Set<string>();
  for (const [Key, Fields] of Index) if (MatchesListSearch(Fields, Terms)) Out.add(Key);
  return Out;
}

/**
 * The rows left showing: the search's matches plus everything selected, so a
 * search never hides what an action is about to run on. A selected check row
 * keeps its target, as check rows show and hide with their target. A row stays
 * out of sight only while it is neither matched nor selected.
 */
export function KeepSelectedRows(
  Matched: ReadonlySet<string>,
  Selected: readonly string[],
  Monitors: Pick<MonitoringTargetView, 'TargetID' | 'Checks'>[]
): Set<string> {
  const Out = new Set(Matched);
  const SelectedChecks = new Set<string>();
  for (const ID of Selected || []) {
    const Key = String(ID);
    if (Key.startsWith(CHECK_SELECTION_PREFIX)) {
      SelectedChecks.add(Key.slice(CHECK_SELECTION_PREFIX.length));
    } else {
      Out.add(Key);
    }
  }
  if (!SelectedChecks.size) return Out;
  for (const T of Monitors || []) {
    if (!T || T.TargetID == null || !Array.isArray(T.Checks)) continue;
    if (T.Checks.some((Check) => Check && SelectedChecks.has(String(Check.CheckID)))) {
      Out.add(`monitor:${T.TargetID}`);
    }
  }
  return Out;
}
