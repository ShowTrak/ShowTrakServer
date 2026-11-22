// App update wiring (renderer).
//
// Drives the dedicated Software Update modal: the renderer kit's
// (@showtrak/protocol/ui/app-updates), shared with ShowTrak Timers, configured
// here for the Server. The manual entry points (the menu "Check for Updates"
// item and the About modal button) open the modal and kick off a check; the
// live OnAppUpdateStatus listener then updates the headline, download progress,
// action buttons and rendered changelog. While a check or download is in
// flight, reopening the modal shows its progress rather than starting another,
// and a floating progress bar tracks it whenever the modal is closed.
import { CreateAppUpdates } from '@showtrak/protocol/ui/app-updates';
import { CloseAllModals } from './modals';

export const { wireAppUpdates, OpenAppUpdateModal } = CreateAppUpdates({
  ProductName: 'ShowTrak Server',
  IconStyle: 'outline',
  OpenButtonIds: ['SHOWTRAK_MODEL_CORE_CHECKUPDATES', 'SHOWTRAK_ABOUT_CHECK_UPDATES'],
  Api: () => window.API,
  // An arrow, so CloseAllModals is looked up when the modal opens: in an import
  // cycle, ./modals may not have finished loading when this module runs.
  CloseAllModals: () => CloseAllModals(),
});
