// Scope matching: one question, one answer: does this scope cover this entity?
//
// A "scope" ({ Workspace, Groups[], Clients[], Tags[] }) is the shape shared by
// alert-rule targets, per-script whitelists and tag membership. Three of its
// four arms are flat lookups, but `Tags` is not: a tag's own membership is
// itself a scope, so a tag may be a SUPERSET of other tags and resolving one
// means walking a graph the operator authored by hand. That graph can contain a
// cycle (tag A includes B includes A), which is why this walk is written once,
// here, with a visited set.
//
// Both processes ask it: the server decides whether an alert fires or a script
// may run, the renderer decides which tags badge a tile and which scripts appear
// in a menu. Compiled into both programs: no Node and no DOM here.
//
// NOTE on defaults: this module answers ONLY "is it covered". It deliberately
// says nothing about what an absent scope means, because the callers disagree:
// a missing script whitelist means "everyone", a missing tag scope means
// "nobody". That decision stays with each caller.

import { IsArray } from '@showtrak/protocol/common';

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
 * monitoring target, `check:<CheckID>` for a single check. Getting it wrong is
 * silent (the scope simply never matches), so tile builders derive it from the
 * same value they put in the tile's `data-uuid`.
 */
export interface ScopeEntity {
  ScopedID: string;
  GroupID?: number | null;
}

/** Minimal tag shape needed to expand `Scope.Tags`. */
export interface ScopeTagLike {
  TagID: number;
  Scope?: ScopeShape | null;
}

/** How a scope came to cover an entity. `null` means it does not. */
export type ScopeMembershipKind = 'direct' | 'group' | 'tag' | 'workspace' | null;

/** Coerce an arbitrary `Scope.Tags` value into a deduped list of tag IDs. */
export function NormalizeScopeTags(Raw: unknown): number[] {
  const Out: number[] = [];
  for (const Value of IsArray(Raw) ? Raw : []) {
    const N = Number(Value);
    if (!Number.isInteger(N) || N <= 0) continue;
    if (!Out.includes(N)) Out.push(N);
  }
  return Out;
}

/** Index a tag list by TagID for repeated lookups during a walk. */
export function IndexTagsByID<T extends ScopeTagLike>(
  Tags: readonly T[] | null | undefined
): Map<number, T> {
  const Index = new Map<number, T>();
  for (const Tag of IsArray(Tags) ? Tags : []) {
    if (!Tag || !Number.isFinite(Number(Tag.TagID))) continue;
    Index.set(Number(Tag.TagID), Tag);
  }
  return Index;
}

// The direct arms, in the order the editor cares about: an entity named
// outright is the only membership a single-client editor may revoke.
function directKind(Scope: ScopeShape, Entity: ScopeEntity): ScopeMembershipKind {
  if (IsArray(Scope.Clients)) {
    for (const Value of Scope.Clients) {
      if (String(Value) === Entity.ScopedID) return 'direct';
    }
  }
  if (Scope.Workspace) return 'workspace';
  if (Entity.GroupID != null && IsArray(Scope.Groups)) {
    for (const Value of Scope.Groups) {
      if (Number(Value) === Number(Entity.GroupID)) return 'group';
    }
  }
  return null;
}

function coversViaTags(
  Scope: ScopeShape,
  Entity: ScopeEntity,
  TagsByID: ReadonlyMap<number, ScopeTagLike>,
  Visited: Set<number>
): boolean {
  for (const TagID of NormalizeScopeTags(Scope.Tags)) {
    // A tag already visited on this walk either matched (we would have
    // returned) or did not, so re-entering it can only loop.
    if (Visited.has(TagID)) continue;
    Visited.add(TagID);
    const Tag = TagsByID.get(TagID);
    // An unknown TagID (a deleted tag still named by a stale scope) contributes
    // no members, exactly like an empty tag.
    if (!Tag || !Tag.Scope) continue;
    if (directKind(Tag.Scope, Entity) !== null) return true;
    if (coversViaTags(Tag.Scope, Entity, TagsByID, Visited)) return true;
  }
  return false;
}

/**
 * Why a scope covers this entity, or null if it does not.
 *
 * The distinction matters wherever a single entity is edited: only `direct`
 * membership can be toggled off for one client. Revoking a `group`, `tag` or
 * `workspace` membership would mean rewriting the scope for every other entity
 * it covers, which is never what someone editing a single machine intends.
 */
export function ScopeMembershipKindFor(
  Scope: ScopeShape | null | undefined,
  Entity: ScopeEntity | null | undefined,
  Tags?: readonly ScopeTagLike[] | Map<number, ScopeTagLike> | null
): ScopeMembershipKind {
  if (!Scope || !Entity || !Entity.ScopedID) return null;
  const Direct = directKind(Scope, Entity);
  if (Direct) return Direct;
  const TagsByID = Tags instanceof Map ? Tags : IndexTagsByID(Tags);
  return coversViaTags(Scope, Entity, TagsByID, new Set<number>()) ? 'tag' : null;
}

/**
 * Whether a scope covers an entity by any route, expanding tags recursively.
 *
 * `Tags` is the full tag list; omit it and tag references contribute nothing
 * (correct for callers whose scopes cannot contain tags, wrong for any that
 * can, so pass it whenever the scope is operator-authored).
 */
export function ScopeCoversEntity(
  Scope: ScopeShape | null | undefined,
  Entity: ScopeEntity | null | undefined,
  Tags?: readonly ScopeTagLike[] | Map<number, ScopeTagLike> | null
): boolean {
  return ScopeMembershipKindFor(Scope, Entity, Tags) !== null;
}

/** True when the scope references at least one tag (directly). */
export function ScopeReferencesTags(Scope: ScopeShape | null | undefined): boolean {
  return !!Scope && NormalizeScopeTags(Scope.Tags).length > 0;
}
