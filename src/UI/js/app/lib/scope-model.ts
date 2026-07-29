// The scope model: WHICH machines does this apply to.
//
// A "scope" backs three editors — alert-rule targets, the per-script whitelist,
// and tag membership — and is persisted as
//   { Workspace: boolean, Groups: number[], Clients: string[], Tags: number[] }
// The editor works in a flat list of selection VALUES, which is what these
// helpers convert to and from:
//   workspace:*            → all clients
//   tag:<TagID>            → everything carrying that tag (dynamic, may nest)
//   group:<GroupID>        → a whole group (dynamic: current AND future members)
//   client:<ScopedID>      → a single entity (plain UUID, or monitor:/check:…)
//
// This module is pure: no DOM, no modal. The UI that renders it lives in
// ../scope-picker.ts. The split exists because the round trip
//   stored scope -> selection values -> stored scope
// runs every time an editor opens and saves, and if it is not stable then
// merely opening a rule and pressing save silently changes who it covers.
//
// Groups and tags differ in one important way. A GROUP has a fixed child list,
// so selecting every member collapses back to the group (and an operator who
// unticks one member gets the remaining members listed individually). A TAG
// does not: its membership is another scope which may itself name tags, so a
// tag is only ever an explicit token — never inferred from, and never collapsed
// into, the entities it happens to cover today.
import { AllClients, DummyClients, MonitoringTargets, IsIntegratedClientEntity } from '../state';
import type {
  AlertScopeEntity,
  AlertScopeGroupNode,
  AlertScopeModel,
  AlertScopeTagNode,
} from '../state';
import { ScriptColourHex } from './script-colours';
import { ScopeCoversEntity } from './scope-matching';
import type { GroupView, TagView } from '@showtrak/protocol';

export type ScopeEntityKind = 'showtrak' | 'monitor' | 'monitor-check' | 'dummy';

// Which entities the picker may display. Every field is optional bar Groups;
// the defaults reproduce the original alert behaviour (all kinds, grouped).
export interface ScopeSourceOptions {
  /** Groups to nest entities under (usually from window.API.GetAllGroups()). */
  Groups: GroupView[];
  /** Tags offered as selectable categories. Omit/empty to hide the section. */
  Tags?: TagView[];
  /** Entity kinds to include. Defaults to all four. */
  IncludeKinds?: ScopeEntityKind[];
  /** Drop integrated (SDK) clients from the 'showtrak' set. */
  ExcludeIntegrated?: boolean;
  /** Render group headers (true) or a single flat list (false). Default true. */
  ShowGroups?: boolean;
  /**
   * Hide one tag from the tag section — the tag currently being edited, which
   * must never be offered as a member of itself.
   */
  ExcludeTagID?: number | null;
  /** Extra predicate applied to real (showtrak) clients. */
  ClientFilter?: (Client: (typeof AllClients)[number]) => boolean;
  /** Restrict which groups appear as nodes; excluded groups' members fall to the flat list. */
  GroupFilter?: (Group: GroupView) => boolean;
}

// Concrete scope shape produced by the editor.
export interface ParsedScope {
  Workspace: boolean;
  Groups: number[];
  Clients: string[];
  Tags: number[];
}

// Permissive scope shape accepted by read-only helpers.
export type ScopeInput = {
  Workspace?: boolean;
  Groups?: unknown[];
  Clients?: unknown[];
  Tags?: unknown[];
};

export function scopeIconClass(Kind: string): string {
  if (Kind === 'showtrak') return 'bi-display';
  if (Kind === 'monitor' || Kind === 'monitor-check') return 'bi-diagram-3';
  if (Kind === 'dummy') return 'bi-cpu';
  return '';
}

export function buildScopeEntityLabel(
  Primary: string | null | undefined,
  Secondary: string | null | undefined,
  Fallback: string | null | undefined
): string {
  const Base = `${Primary || Secondary || Fallback || 'Unknown Target'}`.trim();
  const Detail =
    Secondary && Primary && String(Secondary).trim() && String(Secondary).trim() !== Base
      ? ` (${String(Secondary).trim()})`
      : '';
  return `${Base}${Detail}`;
}

function compareScopeEntities(A: AlertScopeEntity, B: AlertScopeEntity): number {
  const WeightDelta = (A && A.Weight ? A.Weight : 0) - (B && B.Weight ? B.Weight : 0);
  if (WeightDelta !== 0) return WeightDelta;
  return String((A && A.Label) || '').localeCompare(String((B && B.Label) || ''));
}

export function scopeClientValueToScopedID(Value: string): string {
  const Text = String(Value || '');
  if (!Text.startsWith('client:')) return '';
  return Text.slice(7);
}

/** Decode a `tag:<TagID>` value, or 0 when the value is not a tag. */
export function scopeTagValueToTagID(Value: string): number {
  const Text = String(Value || '');
  if (!Text.startsWith('tag:')) return 0;
  const TagID = parseInt(Text.slice(4), 10);
  return Number.isInteger(TagID) && TagID > 0 ? TagID : 0;
}

function sortedGroups(Groups: GroupView[]): GroupView[] {
  return (Array.isArray(Groups) ? Groups.slice() : []).sort((A, B) => {
    const WeightDelta = (A && A.Weight ? A.Weight : 0) - (B && B.Weight ? B.Weight : 0);
    if (WeightDelta !== 0) return WeightDelta;
    return String((A && A.Title) || '').localeCompare(String((B && B.Title) || ''));
  });
}

// Build the full tree model from the shared entity caches, filtered by options.
export function buildScopeModel(Options: ScopeSourceOptions): AlertScopeModel {
  const IncludeKinds = new Set<ScopeEntityKind>(
    Options.IncludeKinds && Options.IncludeKinds.length
      ? Options.IncludeKinds
      : ['showtrak', 'monitor', 'monitor-check', 'dummy']
  );
  const ShowGroups = Options.ShowGroups !== false;

  const VisibleGroups = sortedGroups(Options.Groups).filter((Group) =>
    Options.GroupFilter ? Options.GroupFilter(Group) : true
  );
  const LabelByValue = new Map<string, string>();
  const GroupNodes: AlertScopeGroupNode[] = ShowGroups
    ? VisibleGroups.map((Group) => ({
        Kind: 'group' as const,
        Value: `group:${Group.GroupID}`,
        GroupID: Group.GroupID,
        Label: Group.Title || `Group ${Group.GroupID}`,
        Children: [] as AlertScopeEntity[],
        ChildValues: [] as string[],
      }))
    : [];
  const GroupByID = new Map<string, AlertScopeGroupNode>(
    GroupNodes.map((Group) => [String(Group.GroupID), Group] as [string, AlertScopeGroupNode])
  );
  const Ungrouped: AlertScopeEntity[] = [];
  const Entities: AlertScopeEntity[] = [];

  // Tags arrive already ordered by Weight (the Tag Manager's drag order), which
  // is the operator's own priority, so it is preserved rather than re-sorted.
  const TagNodes: AlertScopeTagNode[] = (Array.isArray(Options.Tags) ? Options.Tags : [])
    .filter((Tag) => Tag && Tag.TagID != null)
    .filter(
      (Tag) => Options.ExcludeTagID == null || Number(Tag.TagID) !== Number(Options.ExcludeTagID)
    )
    .map((Tag) => ({
      Kind: 'tag' as const,
      Value: `tag:${Tag.TagID}`,
      TagID: Number(Tag.TagID),
      Label: Tag.Slug || `Tag ${Tag.TagID}`,
      IconClass: `bi-${Tag.Icon || 'tag'}`,
      ColourHex: ScriptColourHex(Tag.Colour),
    }));

  if (IncludeKinds.has('showtrak')) {
    for (const Client of AllClients || []) {
      if (!Client || !Client.UUID) continue;
      if (Options.ExcludeIntegrated && IsIntegratedClientEntity(Client)) continue;
      if (Options.ClientFilter && !Options.ClientFilter(Client)) continue;
      Entities.push({
        Kind: 'showtrak',
        Value: `client:${Client.UUID}`,
        ScopedID: String(Client.UUID),
        GroupID: Client.GroupID == null ? null : Client.GroupID,
        Label: buildScopeEntityLabel(
          Client.Nickname || Client.Hostname || Client.UUID,
          Client.Nickname ? Client.Hostname || '' : '',
          Client.UUID
        ),
        IconClass: scopeIconClass('showtrak'),
        Weight: Client.Weight || 0,
      });
    }
  }

  if (IncludeKinds.has('monitor') || IncludeKinds.has('monitor-check')) {
    for (const Target of MonitoringTargets || []) {
      if (!Target || Target.TargetID == null) continue;
      const ScopedID = `monitor:${Target.TargetID}`;
      if (IncludeKinds.has('monitor')) {
        Entities.push({
          Kind: 'monitor',
          Value: `client:${ScopedID}`,
          ScopedID,
          GroupID: Target.GroupID == null ? null : Target.GroupID,
          Label: buildScopeEntityLabel(
            Target.Nickname || Target.Address || `Target ${Target.TargetID}`,
            Target.Nickname ? Target.Address || '' : '',
            `Target ${Target.TargetID}`
          ),
          IconClass: scopeIconClass('monitor'),
          Weight: Target.Weight || 0,
        });
      }
      if (IncludeKinds.has('monitor-check')) {
        const TargetTitle = Target.Nickname || Target.Address || `Target ${Target.TargetID}`;
        for (const Check of Array.isArray(Target.Checks) ? Target.Checks : []) {
          if (!Check || Check.CheckID == null) continue;
          const CheckScopedID = `check:${Check.CheckID}`;
          const CheckLabel =
            Check.Name || Check.Address || `${String(Check.Method || '').toUpperCase()} check`;
          Entities.push({
            Kind: 'monitor-check',
            Value: `client:${CheckScopedID}`,
            ScopedID: CheckScopedID,
            GroupID: Target.GroupID == null ? null : Target.GroupID,
            Label: buildScopeEntityLabel(
              `${TargetTitle} · ${CheckLabel}`,
              Check.Name ? Check.Address || '' : '',
              `Check ${Check.CheckID}`
            ),
            IconClass: scopeIconClass('monitor'),
            Weight: Target.Weight || 0,
          });
        }
      }
    }
  }

  if (IncludeKinds.has('dummy')) {
    for (const Dummy of DummyClients || []) {
      if (!Dummy || !Dummy.UUID) continue;
      Entities.push({
        Kind: 'dummy',
        Value: `client:${Dummy.UUID}`,
        ScopedID: String(Dummy.UUID),
        GroupID: Dummy.GroupID == null ? null : Dummy.GroupID,
        Label: buildScopeEntityLabel(
          Dummy.Nickname || Dummy.DummyID || Dummy.UUID,
          Dummy.Nickname ? Dummy.DummyID || '' : '',
          Dummy.UUID
        ),
        IconClass: scopeIconClass('dummy'),
        Weight: Dummy.Weight || 0,
      });
    }
  }

  Entities.sort(compareScopeEntities);

  for (const Entity of Entities) {
    LabelByValue.set(Entity.Value, Entity.Label);
    const Group = Entity.GroupID == null ? null : GroupByID.get(String(Entity.GroupID));
    if (!Group) {
      Ungrouped.push(Entity);
      continue;
    }
    Group.Children.push(Entity);
    Group.ChildValues.push(Entity.Value);
  }

  for (const Group of GroupNodes) {
    LabelByValue.set(Group.Value, Group.Label);
  }
  for (const Tag of TagNodes) {
    LabelByValue.set(Tag.Value, Tag.Label);
  }
  LabelByValue.set('workspace:*', 'All Clients');

  const AllClientValues: string[] = [];
  for (const Group of GroupNodes) AllClientValues.push(...Group.ChildValues);
  for (const Entity of Ungrouped) AllClientValues.push(Entity.Value);

  return {
    Workspace: { Kind: 'workspace', Value: 'workspace:*', Label: 'All Clients' },
    Tags: TagNodes,
    Groups: GroupNodes,
    Ungrouped,
    AllClientValues,
    AllClientValueSet: new Set(AllClientValues),
    LabelByValue,
  };
}

export function parseScopeSelection(Selected: string[]): ParsedScope {
  const Scope: ParsedScope = { Workspace: false, Groups: [], Clients: [], Tags: [] };
  for (const RawValue of Selected || []) {
    const Value = `${RawValue}`;
    if (Value === 'workspace:*') {
      Scope.Workspace = true;
      continue;
    }
    if (Value.startsWith('group:')) {
      const GroupID = parseInt(Value.slice(6), 10);
      if (Number.isFinite(GroupID)) Scope.Groups.push(GroupID);
      continue;
    }
    if (Value.startsWith('tag:')) {
      const TagID = scopeTagValueToTagID(Value);
      if (TagID && !Scope.Tags.includes(TagID)) Scope.Tags.push(TagID);
      continue;
    }
    if (Value.startsWith('client:')) {
      Scope.Clients.push(Value.slice(7));
    }
  }
  return Scope;
}

/**
 * The entity values a scope names DIRECTLY (workspace, groups, clients).
 *
 * Tags are deliberately excluded: their membership is dynamic and may nest, so
 * folding it in here would let the group-collapse logic below rewrite a tag
 * selection into whichever machines happen to carry the tag right now. See
 * {@link resolveTagCoveredValues} for the display-only counterpart.
 */
export function resolveScopeTargetValues(Scope: ScopeInput, Model: AlertScopeModel): Set<string> {
  const Selected = new Set<string>();
  if (!Scope || !Model) return Selected;
  if (Scope.Workspace) {
    for (const Value of Model.AllClientValues) Selected.add(Value);
    return Selected;
  }
  const Groups = new Set((Scope.Groups || []).map((GroupID) => String(GroupID)));
  for (const Group of Model.Groups || []) {
    if (!Groups.has(String(Group.GroupID))) continue;
    for (const Value of Group.ChildValues || []) Selected.add(Value);
  }
  for (const ScopedID of Scope.Clients || []) {
    const Value = `client:${ScopedID}`;
    if (Model.AllClientValueSet.has(Value)) Selected.add(Value);
  }
  return Selected;
}

/** Every entity node in the model, groups flattened, in display order. */
export function scopeModelEntities(Model: AlertScopeModel): AlertScopeEntity[] {
  const Entities: AlertScopeEntity[] = [];
  for (const Group of Model.Groups || []) Entities.push(...Group.Children);
  Entities.push(...(Model.Ungrouped || []));
  return Entities;
}

/**
 * Which of the scope's TAGS cover each entity: value → covering tag labels.
 *
 * For display only. The picker shows these as covered-but-not-selected, because
 * unticking one would be a lie: the only way to exclude it would be to rewrite
 * the tag, which changes every other scope that uses that tag. Naming the tag
 * responsible is the point — "covered" without "by what" leaves the operator
 * hunting for why a machine they never picked is in the list.
 */
export function resolveTagCoverage(
  Scope: ScopeInput,
  Model: AlertScopeModel,
  Tags: TagView[] | null | undefined
): Map<string, string[]> {
  const Coverage = new Map<string, string[]>();
  const TagIDs = (Scope && Scope.Tags) || [];
  if (!Model || !TagIDs.length) return Coverage;

  const Entities = scopeModelEntities(Model);
  const TagList = Array.isArray(Tags) ? Tags : [];

  for (const RawTagID of TagIDs) {
    const TagID = Number(RawTagID);
    if (!Number.isInteger(TagID)) continue;
    const Label =
      Model.LabelByValue.get(`tag:${TagID}`) ||
      (TagList.find((Tag) => Number(Tag.TagID) === TagID) || {}).Slug ||
      `Tag ${TagID}`;
    // Each tag is resolved on its own so the entity can be attributed to it,
    // expanding any tags it in turn absorbs.
    for (const Entity of Entities) {
      if (!ScopeCoversEntity({ Tags: [TagID] }, Entity, TagList)) continue;
      const Existing = Coverage.get(Entity.Value);
      if (Existing) Existing.push(String(Label));
      else Coverage.set(Entity.Value, [String(Label)]);
    }
  }
  return Coverage;
}

/** The entity values covered by the scope's tags, without attribution. */
export function resolveTagCoveredValues(
  Scope: ScopeInput,
  Model: AlertScopeModel,
  Tags: TagView[] | null | undefined
): Set<string> {
  return new Set(resolveTagCoverage(Scope, Model, Tags).keys());
}

/**
 * Collapse a set of directly-selected entity values back into a stored scope.
 *
 * `ExistingTags` is carried through untouched — tag selections are explicit
 * tokens and are never re-derived from the entities they cover (see the note at
 * the top of this file).
 */
export function buildScopeFromTargetValues(
  TargetValues: string[],
  Model: AlertScopeModel,
  ExistingTags: number[] = []
): ParsedScope {
  const Tags = (Array.isArray(ExistingTags) ? ExistingTags : []).slice();
  const Selected = new Set((TargetValues || []).map((Value) => String(Value)));
  if (Model.AllClientValues.length && Model.AllClientValues.every((Value) => Selected.has(Value))) {
    return { Workspace: true, Groups: [], Clients: [], Tags };
  }
  const Scope: ParsedScope = { Workspace: false, Groups: [], Clients: [], Tags };
  const Covered = new Set<string>();
  for (const Group of Model.Groups || []) {
    if (!Group.ChildValues.length) continue;
    if (!Group.ChildValues.every((Value) => Selected.has(Value))) continue;
    Scope.Groups.push(Group.GroupID);
    for (const Value of Group.ChildValues) Covered.add(Value);
  }
  for (const Value of Model.AllClientValues) {
    if (!Selected.has(Value) || Covered.has(Value)) continue;
    const ScopedID = scopeClientValueToScopedID(Value);
    if (ScopedID) Scope.Clients.push(ScopedID);
  }
  return Scope;
}

export function scopeToSelectedValues(Scope: ScopeInput): string[] {
  const Selected: string[] = [];
  if (Scope && Scope.Workspace) Selected.push('workspace:*');
  for (const TagID of (Scope && Scope.Tags) || []) Selected.push(`tag:${TagID}`);
  for (const GroupID of (Scope && Scope.Groups) || []) Selected.push(`group:${GroupID}`);
  for (const ClientID of (Scope && Scope.Clients) || []) Selected.push(`client:${ClientID}`);
  return Selected;
}

function scopeSummaryText(Selected: Array<{ Label: string }>, Placeholder: string): string {
  if (!Array.isArray(Selected) || !Selected.length) return Placeholder;
  // Selected is non-empty here (guarded above), so Selected[0] is present
  if (Selected.length === 1) return Selected[0]!.Label;
  return `${Selected[0]!.Label} +${Selected.length - 1}`;
}

export function summarizeScopeSelection(
  Model: AlertScopeModel,
  Scope: ScopeInput,
  Placeholder: string
): string {
  if (!Scope) return Placeholder;
  if (Scope.Workspace) return 'All Clients';
  const Selected: Array<{ Label: string }> = [];
  for (const TagID of Scope.Tags || []) {
    const Value = `tag:${TagID}`;
    Selected.push({ Label: Model.LabelByValue.get(Value) || `Tag ${TagID}` });
  }
  for (const GroupID of Scope.Groups || []) {
    const Value = `group:${GroupID}`;
    Selected.push({ Label: Model.LabelByValue.get(Value) || `Group ${GroupID}` });
  }
  for (const ClientID of Scope.Clients || []) {
    const Value = `client:${ClientID}`;
    Selected.push({ Label: Model.LabelByValue.get(Value) || String(ClientID) });
  }
  return scopeSummaryText(Selected, Placeholder);
}
