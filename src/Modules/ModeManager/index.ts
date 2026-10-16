import { EventEmitter } from 'events';
import { RecordEdit } from '../AuditLog/edits';
import { Line, Value } from '../AuditLog/message';
import { AuditStep } from '../Shared/audit-names';

// In-memory application mode. Always defaults to SHOW on boot.
type AppMode = 'SHOW' | 'EDIT';
let Mode: AppMode = 'SHOW';

const Emitter = new EventEmitter();

export const Manager = {
  Get(): AppMode {
    return Mode;
  },
  Set(NewMode: unknown): AppMode {
    const Normalized: AppMode = String(NewMode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
    if (Normalized === Mode) return Mode;
    Mode = Normalized;
    Emitter.emit('ModeUpdated', Mode);
    void AuditStep(() =>
      RecordEdit({
        EntityType: 'system',
        EntityID: null,
        Summary: Line('Switched to ', Value(Mode === 'EDIT' ? 'Edit Mode' : 'Show Mode')),
      })
    );
    return Mode;
  },
  on(Event: string, Callback: (...args: unknown[]) => void): EventEmitter {
    return Emitter.on(Event, Callback);
  },
};
