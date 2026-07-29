// Assign tags to a single entity, from that entity's own editor.
//
// One picker serves all three editors (client, dummy client, monitoring
// target) because a tag means the same thing whatever it is attached to. The
// Tag Manager remains the place to create/colour/delete tags and to scope them
// by group; this is the "which tags does THIS machine carry" view.
//
// Two design points worth keeping:
//
//   Membership is a property of the TAG, not of the client — there is no join
//   table. Toggling a chip therefore rewrites that one tag's scope
//   (Scope.Clients) via the existing Tags:SetScope channel. No new IPC surface
//   was needed, and the Tag Manager's editor writes the identical shape.
//
//   A tag inherited from a group (or from Workspace) renders as an on, LOCKED
//   chip. Turning it off for one client would mean rewriting the tag for every
//   other client it covers — never what someone editing a single machine
//   intends. The chip says where it came from instead.
//
// Applying immediately rather than on the editor's Save mirrors the MAC address
// list in the same client-editor modal, which also writes as you click; it also
// sidesteps the fact that the three editors do not agree on a save model (the
// monitoring editor autosaves, the other two have a Save button).

import type { TagView } from '@showtrak/protocol';
import { Capabilities, Tags } from './state';
import { HandleNonFatalError, Safe } from './utils';
import { Notify } from './selection-init';
import { ScriptColourHex } from './lib/script-colours';
import { GetTagMembershipKind, TagBadgeLabel } from './lib/tag-badges';
import type { TagBadgeEntity, TagMembershipKind } from './lib/tag-badges';

/** The entity a mounted picker is editing, plus where its markup lives. */
export interface TagPickerMount {
  /** Wrapper toggled `d-none` when tags cannot be edited here. */
  WrapperSelector: string;
  /** Container the chips are rendered into. */
  ListSelector: string;
  /** jQuery event namespace, so two mounted pickers never cross-fire. */
  Namespace: string;
}

interface ActiveTagPicker {
  Mount: TagPickerMount;
  Entity: TagBadgeEntity;
}

// At most one editor is open at a time (every editor calls CloseAllModals
// first), so a single active mount is enough.
let Active: ActiveTagPicker | null = null;

function MembershipTitle(Kind: TagMembershipKind, Label: string): string {
  if (Kind === 'workspace') return `${Label} applies to all clients — edit it in the Tag Manager`;
  if (Kind === 'group')
    return `${Label} applies to this client's group — edit it in the Tag Manager`;
  if (Kind === 'tag')
    return `${Label} covers another tag this client carries — edit it in the Tag Manager`;
  if (Kind === 'direct') return `Remove ${Label}`;
  return `Add ${Label}`;
}

function RenderTagPickerChip(Tag: TagView, Entity: TagBadgeEntity, AllTags: TagView[]): string {
  const Kind = GetTagMembershipKind(Tag, Entity, AllTags);
  const Label = TagBadgeLabel(Tag);
  // Inherited membership of any kind is read-only here: dropping it would mean
  // rewriting the tag for every other client it covers.
  const Locked = Kind === 'group' || Kind === 'workspace' || Kind === 'tag';
  const Classes = ['tag-picker-chip', Kind ? 'is-on' : '', Locked ? 'is-locked' : '']
    .filter(Boolean)
    .join(' ');
  const Inherited =
    Kind === 'workspace' ? 'ALL' : Kind === 'group' ? 'GROUP' : Kind === 'tag' ? 'TAG' : '';

  return `
    <button
      type="button"
      class="${Classes}"
      data-tagid="${Safe(Tag.TagID)}"
      ${Locked ? 'disabled aria-disabled="true"' : ''}
      aria-pressed="${Kind ? 'true' : 'false'}"
      title="${Safe(MembershipTitle(Kind, Label))}"
      style="--tag-colour: ${Safe(ScriptColourHex(Tag.Colour))}"
    >
      <i class="bi bi-${Safe(Tag.Icon || 'tag')}" aria-hidden="true"></i>
      <span class="tag-picker-chip-label">${Safe(Label)}</span>
      ${Inherited ? `<span class="tag-picker-chip-via">${Safe(Inherited)}</span>` : ''}
    </button>`;
}

/**
 * Draw the picker for an entity, or hide it.
 *
 * Pass a null entity for a not-yet-created dummy/monitor: there is nothing to
 * put in a tag's scope until the row exists, so the section hides entirely
 * rather than offering chips that would silently do nothing.
 */
export function RenderTagPicker(Mount: TagPickerMount, Entity: TagBadgeEntity | null): void {
  const $Wrapper = $(Mount.WrapperSelector);
  // Tag management is desktop-only (the server allowlists no Tags:Set* channel
  // for the Web UI), so the browser gets read-only badges and no picker.
  const Editable = !!Entity && !!Entity.ScopedID && !Capabilities.isWeb;

  $Wrapper.toggleClass('d-none', !Editable);
  if (!Editable || !Entity) {
    Active = null;
    $(Mount.ListSelector).html('');
    return;
  }

  Active = { Mount, Entity };

  const List = Array.isArray(Tags) ? Tags : [];
  if (!List.length) {
    $(Mount.ListSelector).html(
      '<div class="tag-picker-empty">No tags yet. Create one in the Tag Manager.</div>'
    );
    return;
  }

  $(Mount.ListSelector).html(List.map((Tag) => RenderTagPickerChip(Tag, Entity, List)).join(''));

  $(Mount.ListSelector)
    .off(`click.${Mount.Namespace}`)
    .on(`click.${Mount.Namespace}`, '.tag-picker-chip:not(.is-locked)', async function () {
      const TagID = Number($(this).attr('data-tagid'));
      if (!Number.isInteger(TagID)) return;
      await ToggleTagMembership(TagID, Entity);
    });
}

/**
 * Add or remove this entity from one tag's direct membership.
 *
 * Read-modify-write on the tag's scope, from the push-maintained cache — the
 * same thing the Tag Manager's editor does when it saves. Chips are redrawn by
 * the SetTagList push that follows a successful write, so a failed write leaves
 * the UI showing what the server still holds.
 */
async function ToggleTagMembership(TagID: number, Entity: TagBadgeEntity): Promise<void> {
  const Tag = (Array.isArray(Tags) ? Tags : []).find((T) => T && T.TagID === TagID);
  if (!Tag) return;

  const Scope = Tag.Scope || { Workspace: false, Groups: [], Clients: [], Tags: [] };
  const Clients = Array.isArray(Scope.Clients) ? Scope.Clients.slice() : [];
  const Index = Clients.indexOf(Entity.ScopedID);
  if (Index === -1) Clients.push(Entity.ScopedID);
  else Clients.splice(Index, 1);

  // Every other arm of the scope is carried through verbatim. Dropping Tags
  // here would silently un-nest a superset tag the moment anyone toggled a
  // single client's chip.
  const NextScope = {
    Workspace: !!Scope.Workspace,
    Groups: Array.isArray(Scope.Groups) ? Scope.Groups.slice() : [],
    Clients,
    Tags: Array.isArray(Scope.Tags) ? Scope.Tags.slice() : [],
  };

  try {
    const [Err] = await window.API.SetTagScope(TagID, NextScope);
    if (Err) await Notify(String(Err), 'error');
  } catch (Error) {
    HandleNonFatalError('TagPicker:ToggleTagMembership', Error);
    await Notify('Failed to update tag', 'error');
  }
}

/**
 * Redraw the mounted picker after a tag list push.
 *
 * Without this, a chip toggled here would keep showing its pre-click state
 * until the editor was reopened — the write succeeds server-side and the UI
 * silently disagrees.
 */
export function RefreshTagPickerIfMounted(): void {
  if (!Active) return;
  RenderTagPicker(Active.Mount, Active.Entity);
}

/** Drop the mount when its editor closes, so a stale target is never redrawn. */
export function ClearTagPicker(): void {
  Active = null;
}
