// Which surface an edit or action came from (Desktop, Web UI, OSC, …).
//
// Every entry point that dispatches a request runs it inside
// RunWithAuditSource, and the audit log reads the label back when an edit is
// recorded however deep in the managers that happens. Work that is not inside
// any request (telemetry, timers) reads as no source, which is what an observed
// status change is.
import { AsyncLocalStorage } from 'async_hooks';

const SourceContext = new AsyncLocalStorage<string>();

export function RunWithAuditSource<T>(Source: string, Fn: () => T): T {
  return SourceContext.run(Source, Fn);
}

export function CurrentAuditSource(): string | null {
  return SourceContext.getStore() ?? null;
}
