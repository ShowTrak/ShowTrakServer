// A fake `net` whose Socket speaks the NUT protocol for tests, so nothing
// touches the real network. Shared by the nut-ups* method tests.
//
// Options:
//   vars    - map of NUT variable name -> value string. A `GET VAR <ups> <name>`
//             for a listed variable replies `VAR <ups> <name> "value"`; an
//             unlisted variable replies `ERR VAR-NOT-SUPPORTED`.
//   list    - the `LIST UPS` reply body (defaults to LIST_OK below).
//   auth    - { USERNAME, PASSWORD } reply overrides (default 'OK').
//   cmds    - the instant commands `LIST CMD <ups>` reports (default none), or
//             a raw reply string (e.g. an ERR line) in place of the list.
//   instcmd - map of command name -> `INSTCMD` reply (default 'OK\n').
//   refuse  - never connects; emits ECONNREFUSED then close.
//
// The returned object's `sent` array records every line the client wrote.
//   silent  - connects but never replies (drives the timeout path).
//   delayMs - per-reply delay (real timer) instead of an immediate nextTick, so
//             a multi-round-trip probe accrues wall-clock time. Each individual
//             gap stays under delayMs, so the (resettable) idle timeout never
//             fires; only an absolute whole-probe deadline can end it. Used to
//             prove ProbeNut caps total time rather than idle time.
const { EventEmitter } = require('node:events');

const LIST_OK = 'BEGIN LIST UPS\nUPS ups "Server Room UPS"\nUPS backup "Rack B"\nEND LIST UPS\n';

function makeNutNet({
  vars = {},
  list = LIST_OK,
  auth = {},
  cmds = [],
  instcmd = {},
  refuse = false,
  silent = false,
  delayMs = 0,
} = {}) {
  const sent = [];
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
      sent.push(line);
      let reply = null;
      const listCmd = line.match(/^LIST CMD\s+(\S+)/);
      const inst = line.match(/^INSTCMD\s+\S+\s+(\S+)/);
      if (/^USERNAME\b/.test(line)) {
        reply = auth.USERNAME || 'OK\n';
      } else if (/^PASSWORD\b/.test(line)) {
        reply = auth.PASSWORD || 'OK\n';
      } else if (/^LIST UPS\b/.test(line)) {
        reply = list;
      } else if (listCmd) {
        reply =
          typeof cmds === 'string'
            ? cmds
            : `BEGIN LIST CMD ${listCmd[1]}\n${cmds
                .map((c) => `CMD ${listCmd[1]} ${c}\n`)
                .join('')}END LIST CMD ${listCmd[1]}\n`;
      } else if (inst) {
        reply = instcmd[inst[1]] || 'OK\n';
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
        const deliver = () => {
          if (!this.destroyed) this.emit('data', Buffer.from(reply, 'utf8'));
        };
        if (delayMs > 0) setTimeout(deliver, delayMs);
        else process.nextTick(deliver);
      }
      return true;
    }
    destroy() {
      this.destroyed = true;
      process.nextTick(() => this.emit('close'));
      return this;
    }
  }
  return { Socket: FakeSocket, default: { Socket: FakeSocket }, sent };
}

module.exports = { makeNutNet, LIST_OK };
