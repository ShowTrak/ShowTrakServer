// Renderer shared-state barrel.
//
// This used to be a single ~410-line module holding ~50 mutable globals, their
// generated setters, the capability profile, and the pure client-label helpers
// all together. It is now partitioned into the ./state/ folder by role, and
// re-exported here so the ~20 modules that import from './01-state' are
// unchanged. ESM live bindings flow through the re-exports, so a setter in a
// leaf module updates the value every consumer sees.
//
//   ./state/types          — transient UI working-state interfaces
//   ./state/capabilities   — desktop/web capability profile (window-injected)
//   ./state/client-labels  — pure client-labelling helpers
//   ./state/server-caches  — authoritative server-pushed entity caches + config
//   ./state/ui-drafts      — transient editor/modal/selection/mode state
export * from './state/types';
export * from './state/capabilities';
export * from './state/client-labels';
export * from './state/server-caches';
export * from './state/ui-drafts';
