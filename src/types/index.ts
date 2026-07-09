// Central internal type definitions for the ShowTrakServer Node/main-process side.
//
// Server-internal types live here; cross-app wire-protocol types live in the
// standalone `@showtrak/protocol` package (see shared/). This barrel re-exports
// both so most modules can import from a single location.

export * from './result';
export type * from '@showtrak/protocol';
