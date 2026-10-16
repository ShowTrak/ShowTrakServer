// Recording edits and actions in the audit log.
//
// Managers call these at the point a change has actually been made (after the
// write succeeded), with names as they read at that moment. The surface that
// asked for it (Desktop, Web UI, OSC…) is picked up from the request context;
// see ./source.
import type { AuditChange, AuditEntityType, AuditSegment, AuditSeverity } from '@showtrak/protocol';
import { Manager as AuditLog } from './index';

export interface EditInput {
  EntityType: AuditEntityType;
  EntityID?: string | number | null;
  EntityName?: string | null;
  Summary: AuditSegment[];
  Changes?: AuditChange[];
  Details?: string[];
  Severity?: AuditSeverity;
}

// A create, delete, or any change worth a line on its own.
export function RecordEdit(Input: EditInput): void {
  AuditLog.Record({ ...Input, Category: 'edit' });
}

// An update. Skipped when nothing reportable changed, so a save that alters
// nothing (or only a field the log does not report) leaves no line.
export function RecordUpdate(Input: EditInput & { Changes: AuditChange[] }): void {
  if (!Input.Changes.length) return;
  RecordEdit(Input);
}

// Something done rather than changed: a Wake-on-LAN, a script run, an identify.
export function RecordAction(Input: EditInput): void {
  AuditLog.Record({ ...Input, Category: 'action' });
}
