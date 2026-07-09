// Shared low-level validation primitives used by every IPCValidation domain.
// The implementations live in Modules/Validation/primitives so the socket
// validators (Modules/SocketValidation) can reuse them; this re-export keeps
// existing IPCValidation imports working unchanged.
export { fail, isPlainObject, normalizeNonEmptyString } from '../Validation/primitives';
