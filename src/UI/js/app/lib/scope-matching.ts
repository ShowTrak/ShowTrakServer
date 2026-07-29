// Pure scope matching for the renderer.
//
// This is the renderer's MIRROR of src/Modules/ScopeMatching/index.ts. The two
// exist separately because the renderer is bundled for the browser and cannot
// import main-process modules; they answer the same question and must stay in
// step, so both are covered by tests pinning the same cases.
//
// A scope ({ Workspace, Groups[], Clients[], Tags[] }) is what backs alert-rule
// targets, per-script whitelists and tag membership. `Tags` is the arm that
// needs care: a tag's membership is itself a scope, so tags can nest (a tag that
// is a superset of other tags) and the operator can author a cycle. The walk
// below carries a visited set so a cycle terminates instead of hanging the UI.
//
// As on the server, this answers ONLY "is it covered": what an ABSENT scope
// means is the caller's decision, and the callers genuinely disagree — an absent
// script whitelist means "every client", an absent tag scope means "no clients".

/** Permissive scope shape: accepts wire views and editor drafts alike. */
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
 * monitoring target. Getting it wrong is silent — the scope simply never
 * matches — so tile builders derive it from the same value they put in the
 * tile's `data-uuid`.
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
  for (const Value of Array.isArray(Raw) ? Raw : []) {
    const N = Number(Value);
    if (!Number.isInteger(N) || N <= 0) continue;
    if (!Out.includes(N)) Out.push(N);
  }
  return Out;
}

/** Index a tag list by TagID for repeated lookups during a walk. */
export function IndexTagsByID(
  Tags: readonly ScopeTagLike[] | null | undefined
): Map<number, ScopeTagLike> {
  const Index = new Map<number, ScopeTagLike>();
  for (const Tag of Array.isArray(Tags) ? Tags : []) {
    if (!Tag || !Number.isFinite(Number(Tag.TagID))) continue;
    Index.set(Number(Tag.TagID), Tag);
  }
  return Index;
}

// The direct arms, in the order the editor cares about: an entity named
// outright is the only membership a single-client editor may revoke.
function directKind(Scope: ScopeShape, Entity: ScopeEntity): ScopeMembershipKind {
  if (Array.isArray(Scope.Clients)) {
    for (const Value of Scope.Clients) {
      if (String(Value) === Entity.ScopedID) return 'direct';
    }
  }
  if (Scope.Workspace) return 'workspace';
  if (Entity.GroupID != null && Array.isArray(Scope.Groups)) {
    for (const Value of Scope.Groups) {
      if (Number(Value) === Number(Entity.GroupID)) return 'group';
    }
  }
  return null;
}

function coversViaTags(
  Scope: ScopeShape,
  Entity: ScopeEntity,
  TagsByID: Map<number, ScopeTagLike>,
  Visited: Set<number>
): boolean {
  for (const TagID of NormalizeScopeTags(Scope.Tags)) {
    // Already walked on this traversal: revisiting can only loop.
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
 * Omit `Tags` and tag references contribute nothing — correct only for scopes
 * that cannot contain tags, so pass the tag list whenever the scope was
 * authored by an operator.
 */
export function ScopeCoversEntity(
  Scope: ScopeShape | null | undefined,
  Entity: ScopeEntity | null | undefined,
  Tags?: readonly ScopeTagLike[] | Map<number, ScopeTagLike> | null
): boolean {
  return ScopeMembershipKindFor(Scope, Entity, Tags) !== null;
}
