// TagManager
// - CRUD for Tags: cross-cutting, colour+icon labelled collections of clients.
//   Unlike Groups (a client belongs to exactly one), a client can fall under any
//   number of tags. The Slug doubles as the tag's display label.
// - Membership is dynamic: each tag stores a Scope ({ Workspace, Groups[],
//   Clients[] }), the same JSON shape as AlertRules / ScriptWhitelists, edited
//   with the shared scope-dropdown. Colour is an integer index into the shared
//   Scripts palette; Icon is a bare Bootstrap Icons name.
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateTagsRepository } from '../DB/repositories/tags';
import { Manager as BroadcastManager } from '../Broadcast';
import * as SlugService from '../Slug';
import { SCRIPT_COLOURS, NormalizeIconName } from '../ScriptManager/schema';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type { TagRow } from '../DB/rows';
import type { TagView, TagScope } from '@showtrak/protocol';

const Logger = CreateLogger('TagManager');

const TagsRepo = CreateTagsRepository(DB);

// Index 6 (light grey) is the shared neutral default, matching Scripts.
const DEFAULT_COLOUR = 6;
// A tag-shaped Bootstrap icon; overridable via the icon picker.
const DEFAULT_ICON = 'tag';

function CloneEmptyScope(): TagScope {
  return { Workspace: false, Groups: [], Clients: [] };
}

// Clamp a colour to a valid palette index, falling back to the neutral default.
function NormalizeColour(Value: unknown): number {
  const N = Number(Value);
  if (Number.isInteger(N) && N >= 0 && N < SCRIPT_COLOURS.length) return N;
  return DEFAULT_COLOUR;
}

function NormalizeIcon(Value: unknown): string {
  return NormalizeIconName(Value) || DEFAULT_ICON;
}

// Coerce arbitrary parsed JSON into a well-formed scope. Groups are numeric
// (GroupID); Clients are scoped-ID strings (plain UUID, or monitor:/check:…).
// Anything malformed is dropped rather than throwing.
function NormalizeScope(Raw: unknown): TagScope {
  const Obj = Raw && typeof Raw === 'object' ? (Raw as Record<string, unknown>) : {};
  const Groups: number[] = [];
  for (const Value of Array.isArray(Obj.Groups) ? Obj.Groups : []) {
    const N = Number(Value);
    if (Number.isFinite(N) && !Groups.includes(N)) Groups.push(N);
  }
  const Clients: string[] = [];
  for (const Value of Array.isArray(Obj.Clients) ? Obj.Clients : []) {
    const S = String(Value == null ? '' : Value).trim();
    if (S && !Clients.includes(S)) Clients.push(S);
  }
  return { Workspace: !!Obj.Workspace, Groups, Clients };
}

// Parse a stored Scope JSON string. Returns an empty scope when unusable so a
// single bad row can never break the tag list.
function ParseScopeText(Text: string | null | undefined): TagScope {
  if (typeof Text !== 'string' || !Text.trim()) return CloneEmptyScope();
  try {
    return NormalizeScope(JSON.parse(Text));
  } catch (Err) {
    Logger.warn('Failed to parse stored tag scope; treating as empty', Err);
    return CloneEmptyScope();
  }
}

class Tag {
  TagID: number;
  // Stable, human-friendly identifier that doubles as the tag label; unique
  // among tags. Back-filled non-null on boot.
  Slug: string | null;
  Colour: number;
  Icon: string;
  Scope: TagScope;

  constructor(Data: TagRow) {
    this.TagID = Data.TagID;
    this.Slug = Data.Slug || null;
    this.Colour = NormalizeColour(Data.Colour);
    this.Icon = NormalizeIcon(Data.Icon);
    this.Scope = ParseScopeText(Data.Scope);
  }

  ToView(): TagView {
    return {
      TagID: this.TagID,
      Slug: this.Slug,
      Colour: this.Colour,
      Icon: this.Icon,
      Scope: this.Scope,
    };
  }

  // Persist an already-validated/de-collided slug (TagManager.SetSlug owns the
  // validation against the tag namespace).
  async SetSlug(Slug: string): Promise<Result<boolean>> {
    if (this.Slug === Slug) return Ok(true);
    this.Slug = Slug;
    const [Err] = await TagsRepo.UpdateSlug(this.TagID, Slug);
    if (Err) {
      Logger.error('Failed to update tag Slug');
      return Fail('Failed to update tag slug');
    }
    Logger.debug(`Tag ${this.TagID} Slug updated to ${Slug}`);
    return Ok(true);
  }

  async SetColour(Colour: unknown): Promise<Result<boolean>> {
    const Next = NormalizeColour(Colour);
    if (this.Colour === Next) return Ok(true);
    this.Colour = Next;
    const [Err] = await TagsRepo.UpdateColour(this.TagID, Next);
    if (Err) {
      Logger.error('Failed to update tag Colour');
      return Fail('Failed to update tag colour');
    }
    Logger.debug(`Tag ${this.TagID} Colour updated to ${Next}`);
    return Ok(true);
  }

  async SetIcon(Icon: unknown): Promise<Result<boolean>> {
    const Next = NormalizeIcon(Icon);
    if (this.Icon === Next) return Ok(true);
    this.Icon = Next;
    const [Err] = await TagsRepo.UpdateIcon(this.TagID, Next);
    if (Err) {
      Logger.error('Failed to update tag Icon');
      return Fail('Failed to update tag icon');
    }
    Logger.debug(`Tag ${this.TagID} Icon updated to ${Next}`);
    return Ok(true);
  }

  async SetScope(Scope: unknown): Promise<Result<boolean>> {
    const Next = NormalizeScope(Scope);
    this.Scope = Next;
    const [Err] = await TagsRepo.UpdateScope(this.TagID, JSON.stringify(Next));
    if (Err) {
      Logger.error('Failed to update tag Scope');
      return Fail('Failed to update tag scope');
    }
    Logger.debug(`Tag ${this.TagID} Scope updated`);
    return Ok(true);
  }
}

const Manager = {
  async Create(Label: string = 'tag'): Promise<Result<Tag>> {
    // The slug doubles as the label, so a tag always has a unique non-null slug
    // from creation (no post-insert back-fill needed).
    const Slug = await SlugService.GenerateUniqueTagSlug(Label);
    const [Err] = await TagsRepo.Insert(
      Slug,
      DEFAULT_COLOUR,
      DEFAULT_ICON,
      JSON.stringify(CloneEmptyScope()),
      100
    );
    if (Err) {
      Logger.error('Failed to create tag:', Err);
      return Fail('Failed to create tag');
    }
    BroadcastManager.emit('TagListChanged');
    // Return the freshly-created tag so callers can open it in the editor.
    const Created = await Manager.GetBySlug(Slug);
    if (!Created) return Fail('Tag created but could not be reloaded');
    return Ok(Created);
  },

  // Set a tag's slug (validated + de-collided against the tag namespace).
  async SetSlug(TagID: number, Slug: unknown): Promise<Result<boolean>> {
    if (!TagID) return Fail('TagID is required');

    const [GetErr, Tag] = await Manager.Get(TagID);
    if (GetErr) return Fail(GetErr);
    if (!Tag) return Fail('Tag not found');

    const [SlugErr, Resolved] = await SlugService.ResolveTagSlugEdit(
      Slug,
      SlugService.TagOwner(TagID)
    );
    if (SlugErr) return Fail(SlugErr);

    const [SetErr] = await Tag.SetSlug(Resolved as string);
    if (SetErr) return Fail(SetErr);

    BroadcastManager.emit('TagListChanged');
    return Ok(true);
  },

  async SetColour(TagID: number, Colour: unknown): Promise<Result<boolean>> {
    if (!TagID) return Fail('TagID is required');
    const [GetErr, Tag] = await Manager.Get(TagID);
    if (GetErr) return Fail(GetErr);
    if (!Tag) return Fail('Tag not found');
    const [SetErr] = await Tag.SetColour(Colour);
    if (SetErr) return Fail(SetErr);
    BroadcastManager.emit('TagListChanged');
    return Ok(true);
  },

  async SetIcon(TagID: number, Icon: unknown): Promise<Result<boolean>> {
    if (!TagID) return Fail('TagID is required');
    const [GetErr, Tag] = await Manager.Get(TagID);
    if (GetErr) return Fail(GetErr);
    if (!Tag) return Fail('Tag not found');
    const [SetErr] = await Tag.SetIcon(Icon);
    if (SetErr) return Fail(SetErr);
    BroadcastManager.emit('TagListChanged');
    return Ok(true);
  },

  async SetScope(TagID: number, Scope: unknown): Promise<Result<boolean>> {
    if (!TagID) return Fail('TagID is required');
    const [GetErr, Tag] = await Manager.Get(TagID);
    if (GetErr) return Fail(GetErr);
    if (!Tag) return Fail('Tag not found');
    const [SetErr] = await Tag.SetScope(Scope);
    if (SetErr) return Fail(SetErr);
    BroadcastManager.emit('TagListChanged');
    return Ok(true);
  },

  // Persist a new ordering by reassigning Tag.Weight in display order.
  async SetOrder(OrderedTagIDs: unknown[] = []): Promise<{ ok: boolean; errors?: string[] }> {
    if (!Array.isArray(OrderedTagIDs)) return { ok: false, errors: ['Invalid order'] };

    const [Err, Rows] = await TagsRepo.GetAllIDs();
    if (Err) {
      Logger.error('Failed to fetch tags while reordering:', Err);
      return { ok: false, errors: ['Failed to reorder tags'] };
    }

    const Existing: number[] = (Rows || [])
      .map((Row) => Number(Row.TagID))
      .filter((TagID: number) => Number.isInteger(TagID) && TagID > 0);
    const ExistingSet = new Set(Existing);

    const Desired: number[] = [];
    for (const RawTagID of OrderedTagIDs) {
      const TagID = Number(RawTagID);
      if (!Number.isInteger(TagID) || TagID <= 0) continue;
      if (!ExistingSet.has(TagID)) continue;
      if (Desired.includes(TagID)) continue;
      Desired.push(TagID);
    }

    const Remaining = Existing.filter((TagID) => !Desired.includes(TagID));
    const FinalOrder = Desired.concat(Remaining);

    let Weight = 10;
    for (const TagID of FinalOrder) {
      const [SetErr] = await TagsRepo.UpdateWeight(TagID, Weight);
      if (SetErr) {
        Logger.error(`Failed to update tag weight while reordering (${TagID}):`, SetErr);
        return { ok: false, errors: ['Failed to reorder tags'] };
      }
      Weight += 10;
    }

    BroadcastManager.emit('TagListChanged');
    return { ok: true };
  },

  async Delete(TagID: number): Promise<Result<string>> {
    if (!TagID) return Fail('TagID is required to delete a tag');
    const [Err] = await TagsRepo.Delete(TagID);
    if (Err) {
      Logger.error('Failed to delete tag:', Err);
      return Fail('Failed to delete tag');
    }
    Logger.debug(`Deleted tag with ID ${TagID}`);
    BroadcastManager.emit('TagListChanged');
    return Ok('Tag Deleted Successfully');
  },

  // Assign generated unique slugs to any tag still lacking one (e.g. rows that
  // predate slug back-fill). Idempotent.
  async BackfillSlugs(): Promise<number> {
    const [Err, Tags] = await Manager.GetAll();
    if (Err) return 0;
    let Count = 0;
    for (const Tag of Tags || []) {
      if (Tag.Slug) continue;
      const Slug = await SlugService.GenerateUniqueTagSlug('tag', SlugService.TagOwner(Tag.TagID));
      const [SetErr] = await Tag.SetSlug(Slug);
      if (!SetErr) Count++;
    }
    if (Count) Logger.log(`Back-filled slugs for ${Count} tag(s)`);
    return Count;
  },

  // Resolve a tag by slug (case-insensitive), for OSC/API addressing.
  async GetBySlug(Slug: string): Promise<Tag | null> {
    if (!Slug) return null;
    const [Err, Tags] = await Manager.GetAll();
    if (Err) return null;
    const Lower = String(Slug).toLowerCase();
    return (Tags || []).find((T) => (T.Slug || '').toLowerCase() === Lower) || null;
  },

  async Get(TagID: number): Promise<Result<Tag | null>> {
    if (!TagID) return Fail('TagID is required');
    const [Err, Row] = await TagsRepo.GetByID(TagID);
    if (Err) {
      Logger.error('Failed to fetch tag:', Err);
      return Fail('Failed to fetch tag');
    }
    if (!Row) return Ok(null);
    return Ok(new Tag(Row));
  },

  // Ordered by Weight ascending so lower weight renders first.
  async GetAll(): Promise<Result<Tag[]>> {
    const [Err, Rows] = await TagsRepo.GetAll();
    if (Err) {
      Logger.error('Failed to fetch tags:', Err);
      return Fail('Failed to fetch tags', []);
    }
    return Ok((Rows || []).map((Row) => new Tag(Row)));
  },

  // Serializable projection for the renderer / API.
  async GetAllViews(): Promise<TagView[]> {
    const [Err, Tags] = await Manager.GetAll();
    if (Err) return [];
    return (Tags || []).map((Tag) => Tag.ToView());
  },
};

export { Manager };
