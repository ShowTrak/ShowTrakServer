// ScopeMatching
// -----------------------------------------------------------------------------
// One question, one answer: does this scope cover this entity?
//
// A "scope" ({ Workspace, Groups[], Clients[], Tags[] }) is the shape shared by
// alert-rule targets, per-script whitelists and tag membership. Three of its
// four arms are flat lookups, but `Tags` is not: a tag's own membership is
// itself a scope, so a tag may be a SUPERSET of other tags and resolving one
// means walking a graph the operator authored by hand. That graph can contain a
// cycle (tag A includes B includes A) — which is why this walk is written once,
// here, with a visited set, rather than open-coded at each of the five call
// sites that need it.
//
// Everything here is pure: callers pass the entity and the tag list. The
// renderer keeps a mirror of this file at src/UI/js/app/lib/scope-matching.ts
// (it cannot import main-process modules) — the two must stay in step, and both
// are covered by tests that pin the same cases.
//
// NOTE on defaults: this module answers ONLY "is it covered". It deliberately
// says nothing about what an absent scope means, because the callers disagree —
// a missing script whitelist means "everyone", a missing tag scope means
// "nobody". That decision stays with each caller.

/** Permissive scope shape: accepts stored JSON, wire views and editor drafts. */
export interface ScopeShape {
  Workspace?: unknown;
  Groups?: unknown;
  Clients?: unknown;
  Tags?: unknown;
}

/**
 * The identity a scope is matched against.
 *
 * `ScopedID` is the string the scope picker persists into `Scope.Clients`: a
 * plain UUID for ShowTrak and dummy clients, `monitor:<TargetID>` for a
 * monitoring target, `check:<CheckID>` for a single check.
 */
export interface ScopeEntity {
  ScopedID: string;
  GroupID?: number | null;
}

/** Minimal tag shape needed to expand `Scope.Tags`. */
export interface ScopeTag {
  TagID: number;
  Scope: ScopeShape;
}

/** Coerce an arbitrary `Scope.Tags` value into a deduped list of tag IDs. */
export function NormalizeScopeTags(Raw: unknown): number[] {
  const Out: number[] = [];
  for (const Value of Array.isArray(Raw) ? Raw : []) {
    const N = Number(Value);
    if (!Number.isInteger(N) || N <= 0) continue;
    if (!Out.includes(N)) Out.push(N);
  }
  return Out;
}

/** Index a tag list by TagID for repeated lookups during a walk. */
export function IndexTagsByID(Tags: readonly ScopeTag[] | null | undefined): Map<number, ScopeTag> {
  const Index = new Map<number, ScopeTag>();
  for (const Tag of Array.isArray(Tags) ? Tags : []) {
    if (!Tag || !Number.isFinite(Number(Tag.TagID))) continue;
    Index.set(Number(Tag.TagID), Tag);
  }
  return Index;
}

function coversDirectly(Scope: ScopeShape, Entity: ScopeEntity): boolean {
  if (Scope.Workspace) return true;
  if (Array.isArray(Scope.Clients)) {
    for (const Value of Scope.Clients) {
      if (String(Value) === Entity.ScopedID) return true;
    }
  }
  if (Entity.GroupID != null && Array.isArray(Scope.Groups)) {
    for (const Value of Scope.Groups) {
      if (Number(Value) === Number(Entity.GroupID)) return true;
    }
  }
  return false;
}

function coversWithTags(
  Scope: ScopeShape | null | undefined,
  Entity: ScopeEntity,
  TagsByID: Map<number, ScopeTag>,
  Visited: Set<number>
): boolean {
  if (!Scope) return false;
  if (coversDirectly(Scope, Entity)) return true;
  for (const TagID of NormalizeScopeTags(Scope.Tags)) {
    // A tag already visited on this walk either matched (we would have
    // returned) or did not, so re-entering it can only loop.
    if (Visited.has(TagID)) continue;
    Visited.add(TagID);
    const Tag = TagsByID.get(TagID);
    // An unknown TagID (deleted tag still referenced by a stale scope) simply
    // contributes no members, exactly like an empty tag.
    if (!Tag) continue;
    if (coversWithTags(Tag.Scope, Entity, TagsByID, Visited)) return true;
  }
  return false;
}

/**
 * Whether a scope covers an entity, expanding tag references recursively.
 *
 * `Tags` is the full tag list; omit it and tag references contribute nothing
 * (correct for callers whose scopes cannot contain tags, wrong for any that
 * can, so pass it whenever the scope is operator-authored).
 */
export function ScopeCoversEntity(
  Scope: ScopeShape | null | undefined,
  Entity: ScopeEntity | null | undefined,
  Tags?: readonly ScopeTag[] | Map<number, ScopeTag> | null
): boolean {
  if (!Scope || !Entity || !Entity.ScopedID) return false;
  const TagsByID = Tags instanceof Map ? Tags : IndexTagsByID(Tags);
  return coversWithTags(Scope, Entity, TagsByID, new Set<number>());
}

/** True when the scope references at least one tag (directly). */
export function ScopeReferencesTags(Scope: ScopeShape | null | undefined): boolean {
  return !!Scope && NormalizeScopeTags(Scope.Tags).length > 0;
}
