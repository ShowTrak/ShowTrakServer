import { EventEmitter } from 'events';

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
    return Mode;
  },
  on(Event: string, Callback: (...args: unknown[]) => void): EventEmitter {
    return Emitter.on(Event, Callback);
  },
};
