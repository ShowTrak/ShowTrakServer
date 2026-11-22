// Scope matching for the renderer: which tags badge a tile, which scripts a
// client may run, how a scope covers the client being edited. The walk lives in
// src/common, shared with the main process, so the two can never disagree.
export {
  NormalizeScopeTags,
  IndexTagsByID,
  ScopeMembershipKindFor,
  ScopeCoversEntity,
  type ScopeShape,
  type ScopeEntity,
  type ScopeTagLike,
  type ScopeMembershipKind,
} from '../../../../common/scope-matching';
