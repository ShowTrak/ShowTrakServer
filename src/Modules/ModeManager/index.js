const { EventEmitter } = require('events');

// In-memory application mode. Always defaults to SHOW on boot.
let Mode = 'SHOW'; // Allowed values: 'SHOW' | 'EDIT'

const Emitter = new EventEmitter();

const Manager = {
  Get() {
    return Mode;
  },
  Set(NewMode) {
    const Normalized = String(NewMode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
    if (Normalized === Mode) return Mode;
    Mode = Normalized;
    Emitter.emit('ModeUpdated', Mode);
    return Mode;
  },
  on(Event, Callback) {
    return Emitter.on(Event, Callback);
  },
};

module.exports = { Manager };
