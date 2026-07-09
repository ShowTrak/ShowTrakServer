// Thin, process-wide event bus used to decouple modules from the Electron and
// Socket layers.
import { EventEmitter } from 'events';

export const Manager = new EventEmitter();
