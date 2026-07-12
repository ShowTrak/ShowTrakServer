// A fake `net` whose Socket speaks the NUT protocol for tests, so nothing
// touches the real network. Shared by the nut-ups* method tests.
//
// Options:
//   vars    - map of NUT variable name -> value string. A `GET VAR <ups> <name>`
//             for a listed variable replies `VAR <ups> <name> "value"`; an
//             unlisted variable replies `ERR VAR-NOT-SUPPORTED`.
//   list    - the `LIST UPS` reply body (defaults to LIST_OK below).
//   auth    - { USERNAME, PASSWORD } reply overrides (default 'OK').
//   refuse  - never connects; emits ECONNREFUSED then close.
//   silent  - connects but never replies (drives the timeout path).
const { EventEmitter } = require('node:events');

const LIST_OK = 'BEGIN LIST UPS\nUPS ups "Server Room UPS"\nUPS backup "Rack B"\nEND LIST UPS\n';

function makeNutNet({ vars = {}, list = LIST_OK, auth = {}, refuse = false, silent = false } = {}) {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
    }
    setTimeout() {}
    connect() {
      process.nextTick(() => {
        if (refuse) {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:3493');
          err.code = 'ECONNREFUSED';
          this.emit('error', err);
          this.emit('close');
          return;
        }
        this.emit('connect');
      });
      return this;
    }
    write(data) {
      if (silent || refuse) return true;
      const line = String(data).trim();
      let reply = null;
      if (/^USERNAME\b/.test(line)) {
        reply = auth.USERNAME || 'OK\n';
      } else if (/^PASSWORD\b/.test(line)) {
        reply = auth.PASSWORD || 'OK\n';
      } else if (/^LIST UPS\b/.test(line)) {
        reply = list;
      } else if (/^LOGOUT\b/.test(line)) {
        reply = null;
      } else {
        const m = line.match(/^GET VAR\s+\S+\s+(\S+)/);
        if (m) {
          const name = m[1];
          reply = Object.prototype.hasOwnProperty.call(vars, name)
            ? `VAR ups ${name} "${vars[name]}"\n`
            : 'ERR VAR-NOT-SUPPORTED\n';
        }
      }
      if (reply != null && reply !== '') {
        process.nextTick(() => {
          if (!this.destroyed) this.emit('data', Buffer.from(reply, 'utf8'));
        });
      }
      return true;
    }
    destroy() {
      this.destroyed = true;
      process.nextTick(() => this.emit('close'));
      return this;
    }
  }
  return { Socket: FakeSocket, default: { Socket: FakeSocket } };
}

module.exports = { makeNutNet, LIST_OK };
