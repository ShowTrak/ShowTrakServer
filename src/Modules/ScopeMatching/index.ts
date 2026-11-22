// Scope matching ("does this scope cover this entity?"). The walk lives in
// src/common, so the renderer answers the question with the very same code;
// this is the main process's entry point to it.
export {
  NormalizeScopeTags,
  IndexTagsByID,
  ScopeCoversEntity,
  ScopeReferencesTags,
  type ScopeShape,
  type ScopeEntity,
  type ScopeTagLike as ScopeTag,
} from '../../common/scope-matching';
