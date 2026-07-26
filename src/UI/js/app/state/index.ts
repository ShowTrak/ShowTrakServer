// Renderer shared-state barrel.
//
// This used to be a single ~410-line module holding ~50 mutable globals, their
// generated setters, the capability profile, and the pure client-label helpers
// all together. It is partitioned by role into the sibling modules below and
// re-exported here, so the ~25 consumers import one thing: `./state`. ESM live
// bindings flow through the re-exports, so a setter in a leaf module updates the
// value every consumer sees.
//
//   ./types          — transient UI working-state interfaces
//   ./capabilities   — desktop/web capability profile (window-injected)
//   ./client-labels  — pure client-labelling helpers
//   ./server-caches  — authoritative server-pushed entity caches + config
//   ./ui-drafts      — transient editor/modal/selection/mode state
export * from './types';
export * from './capabilities';
export * from './client-labels';
export * from './server-caches';
export * from './ui-drafts';
