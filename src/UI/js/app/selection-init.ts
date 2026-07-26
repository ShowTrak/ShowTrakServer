// Re-export barrel. Phase 7 pulled the global bootstrap out (the document-ready
// IIFE and Init() now live in ./init.ts, called explicitly by main.ts); the
// remaining live logic — toasts, the confirmation dialog, the identify flow —
// has since been moved into the leaf modules below. This file now holds NO
// logic and NO side effects: importing it only re-exports, so the ~20 modules
// that still reach for these symbols here keep working unchanged.
export { UpdateOfflineIndicators } from './offline-indicators';
export { OpenClientInfo, RenderClientInfoDetails } from './client-info-modal';
export {
  ClearSelection,
  Deselect,
  IsSelected,
  Select,
  SelectAll,
  SelectByGroup,
  ToggleSelection,
  UpdateSelectionCount,
} from './selection';
export { Wait } from './lib/wait';
export {
  ConfirmationDialog,
  ensureToastHost,
  HideExecutionToast,
  iconForType,
  Notify,
  RemoveAlertToastById,
  ShowExecutionToast,
  enableExecToastOutsideClose,
  showAlertStyleToast,
} from './lib/toasts';
export {
  ApplyIdentifyStateLocally,
  GetIdentifyingUUIDs,
  GetIdentifyTargetByUUID,
  IsVersionAtLeast,
  MINIMUM_DISPLAY_MONITORING_VERSION,
  MINIMUM_IDENTIFY_VERSION,
  ParseSemverTuple,
  StopIdentifyingForUUIDs,
  UpdateIdentifyStatusBanner,
} from './identify';
