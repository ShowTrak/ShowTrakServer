// Scope matching ("does this scope cover this entity?"). The walk lives in
// src/common, so the renderer answers the question with the very same code;
// this is the main process's entry point to it, plus the reading of a scope the
// server has stored.
import { NormalizeScopeTags } from '../../common/scope-matching';

export {
  NormalizeScopeTags,
  IndexTagsByID,
  ScopeCoversEntity,
  ScopeReferencesTags,
  type ScopeShape,
  type ScopeEntity,
  type ScopeTagLike as ScopeTag,
} from '../../common/scope-matching';

/** A scope as the server stores it (a tag's membership, a script whitelist). */
export interface StoredScope {
  Workspace: boolean;
  Groups: number[];
  Clients: string[];
  Tags: number[];
}

/**
 * Coerce arbitrary parsed JSON into a well-formed scope. Groups are numeric
 * (GroupID); Clients are scoped-ID strings (a plain UUID, or monitor:/check:...);
 * Tags are numeric TagIDs. Anything malformed is dropped rather than throwing, so
 * a single bad row can never break the tag list or script dispatch.
 */
export function NormalizeStoredScope(Raw: unknown): StoredScope {
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
  return { Workspace: !!Obj.Workspace, Groups, Clients, Tags: NormalizeScopeTags(Obj.Tags) };
}
