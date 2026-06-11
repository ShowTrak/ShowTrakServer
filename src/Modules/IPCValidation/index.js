// IPCValidation
// Validates and normalizes payloads crossing the IPC boundary. Validators are
// grouped by domain in sibling files and registered onto a single Manager so
// callers keep using `IPCValidation.<Validator>(...)` exactly as before.
const Manager = {};

require('./client-validators')(Manager);
require('./monitoring-validators')(Manager);
require('./dummy-validators')(Manager);
require('./alert-validators')(Manager);
require('./system-validators')(Manager);

module.exports = {
  Manager,
};
