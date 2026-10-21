// Client Info modal: OpenClientInfo (opens + live-refresh loop) and
// RenderClientInfoDetails (renders every tab/section). Read-only in Show mode;
// in Edit mode a ShowTrak Client is edited here too (client-info-edit.ts).
// Cross-references back into selection-init are call-time only (safe cycle).
import type { ClientView } from '@showtrak/protocol';
import { openModal } from './lib/modal';
import {
  ClientInfoOpenUUID,
  ClientInfoRefreshTimer,
  FormatClientVersionLabel,
  IsIntegratedClientEntity,
  __clientInfoRefreshInFlight,
  setClientInfoOpenUUID,
  setClientInfoRefreshTimer,
  setMonitorHistoryModalContext,
  setMonitorHistorySeries,
  setMonitorHistoryTooltipHover,
  set__clientInfoRefreshInFlight,
} from './state';
import { HandleNonFatalError } from './utils';
import { GetClientStatusDisplayText } from './client-list';
import {
  HideStatusTimelineTooltip,
  LoadHistorySamplesForContext,
  RenderMonitoringHistoryModal,
} from './monitoring';
import { CloseAllModals } from './modals';
import { IsVersionAtLeast, MINIMUM_DISPLAY_MONITORING_VERSION, Notify } from './selection-init';
import {
  BindClientInfoAudioHandlers,
  ClearClientInfoAudio,
  RenderClientInfoAudio,
} from './client-info-audio';
import {
  BindClientInfoUSBHandlers,
  ClearClientInfoUSB,
  RenderClientInfoUSB,
} from './client-info-usb';
import {
  BindClientInfoDisplayHandlers,
  ClearClientInfoDisplays,
  RenderClientInfoDisplays,
} from './client-info-displays';
import {
  BindClientInfoNetworkHandlers,
  ClearClientInfoNetwork,
  RenderClientInfoNetwork,
} from './client-info-network';
import {
  BindClientInfoStorageHandlers,
  ClearClientInfoStorage,
  RenderClientInfoStorage,
} from './client-info-storage';
import {
  ResetClientInfoTab,
  SelectClientInfoTab,
  SetClientInfoAlarmTabs,
  SetClientInfoKind,
} from './client-info-nav';
import { ClientAlarmTabs } from './lib/client-info-alarms';
import type { ClientInfoTabKey } from './lib/client-info-tabs';
import { MountClientInfoEditor, RefreshClientInfoEditor } from './client-info-edit';
import {
  BindClientInfoSystemHandlers,
  ClearClientInfoSystem,
  RenderClientInfoSystem,
} from './client-info-health';
import {
  BindClientInfoApplicationHandlers,
  ClearClientInfoApplications,
  RenderClientInfoApplications,
} from './client-info-applications';

/** Open a client's view modal, optionally on a given tab (the tile cog opens Info). */
export async function OpenClientInfo(UUID: string, Options: { Tab?: ClientInfoTabKey } = {}) {
  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
  let Client = null;
  try {
    Client = await window.API.GetClient(UUID);
  } catch (e) {
    console.error('Failed to fetch client', e);
  }
  if (!Client) return Notify('Client not found.', 'error');

  const { Hostname, IP } = Client;

  // Slug, nickname, group and the other editable fields are filled by the
  // editor layer (MountClientInfoEditor) in whichever mode applies.
  $('#CLIENT_INFO_HOSTNAME').val(Hostname || '');
  $('#CLIENT_INFO_IP').val(IP || 'Unknown IP');
  $('#CLIENT_INFO_UUID').val(UUID);
  $('#CLIENT_INFO_VERSION').val(FormatClientVersionLabel(Client));
  $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Client));

  ResetClientInfoTab();
  RenderClientInfoDetails(Client);

  // Drive the shared status-timeline graph (same modal used by monitoring
  // targets and dummy clients) for this client.
  setMonitorHistoryModalContext({ type: 'client', id: UUID });
  setMonitorHistorySeries([]);
  setMonitorHistoryTooltipHover(null);
  await Promise.all([
    MountClientInfoEditor(Client).catch((err) =>
      HandleNonFatalError('OpenClientInfo:MountEditor', err)
    ),
    LoadHistorySamplesForContext().catch((err) =>
      HandleNonFatalError('OpenClientInfo:LoadHistory', err)
    ),
  ]);
  RenderMonitoringHistoryModal();
  if (Options.Tab) SelectClientInfoTab(Options.Tab);

  const RefreshOpenClient = async () => {
    if (!ClientInfoOpenUUID) return;
    const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
    if (Fresh) {
      $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Fresh));
      RenderClientInfoDetails(Fresh);
    }
  };
  BindClientInfoUSBHandlers(() => ClientInfoOpenUUID, RefreshOpenClient, Notify);
  BindClientInfoDisplayHandlers(() => ClientInfoOpenUUID, RefreshOpenClient, Notify);
  BindClientInfoAudioHandlers(() => ClientInfoOpenUUID, RefreshOpenClient, Notify);
  BindClientInfoNetworkHandlers(() => ClientInfoOpenUUID, RefreshOpenClient, Notify);
  BindClientInfoStorageHandlers(() => ClientInfoOpenUUID, RefreshOpenClient, Notify);
  BindClientInfoSystemHandlers(() => ClientInfoOpenUUID, RefreshOpenClient, Notify);

  BindClientInfoApplicationHandlers(() => ClientInfoOpenUUID, RefreshOpenClient, Notify);

  // mark modal as open for this UUID and clear when hidden
  setClientInfoOpenUUID(UUID);
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    $modal.off('hidden.bs.modal.clientinfo').on('hidden.bs.modal.clientinfo', function () {
      setClientInfoOpenUUID(null);
      if (ClientInfoRefreshTimer) {
        clearInterval(ClientInfoRefreshTimer);
        setClientInfoRefreshTimer(null);
      }
      set__clientInfoRefreshInFlight(false);

      // Shared status-timeline modal state teardown.
      setMonitorHistoryModalContext(null);
      setMonitorHistorySeries([]);
      setMonitorHistoryTooltipHover(null);
      HideStatusTimelineTooltip();

      // Dispose all popovers to prevent stuck state
      try {
        const popovers = document.querySelectorAll('[data-bs-toggle="popover"]');
        for (const el of popovers) {
          const instance = bootstrap.Popover.getInstance(el);
          if (instance) instance.dispose();
        }
      } catch (e) {
        // ignore popover cleanup errors
      }
    });
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  openModal('SHOWTRAK_CLIENT_INFO');

  // Start periodic refresh as a safety net in case events are missed
  try {
    if (ClientInfoRefreshTimer) {
      clearInterval(ClientInfoRefreshTimer);
      setClientInfoRefreshTimer(null);
    }
    setClientInfoRefreshTimer(
      setInterval(async () => {
        if (!ClientInfoOpenUUID) return;
        if (__clientInfoRefreshInFlight) return;
        set__clientInfoRefreshInFlight(true);
        try {
          const fresh = await window.API.GetClient(ClientInfoOpenUUID);
          if (fresh) RenderClientInfoDetails(fresh);
        } catch (err) {
          HandleNonFatalError('SelectionInit:NonFatal', err);
        }
        set__clientInfoRefreshInFlight(false);
      }, 4000)
    );
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
}

export function RenderClientInfoDetails(Client: ClientView) {
  const IsIntegrated = IsIntegratedClientEntity(Client);

  try {
    $('#CLIENT_INFO_USB_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_DISPLAYS_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_AUDIO_INPUTS_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_AUDIO_OUTPUTS_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_NETWORK_V4_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_NETWORK_V6_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_STORAGE_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_RUNNING_APPS_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_POWER_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_TEMPERATURE_SECTION').toggleClass('d-none', IsIntegrated);
    // An SDK client reports no operating system: no usage, uptime or power.
    $('#CLIENT_INFO_SYSTEM_SECTION').toggleClass('d-none', IsIntegrated);
    SetClientInfoKind(IsIntegrated ? 'integrated' : 'client');
    SetClientInfoAlarmTabs(ClientAlarmTabs(Client));
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  try {
    $('#CLIENT_INFO_OPERATING_SYSTEM').val(
      (Client && Client.OperatingSystem ? String(Client.OperatingSystem) : '') || ''
    );
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  try {
    $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Client));
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Info, Variables, Wake on LAN and Actions: read-only parts follow the live
  // client; fields being edited are left alone.
  try {
    RefreshClientInfoEditor(Client);
  } catch (err) {
    HandleNonFatalError('ClientInfo:RefreshEditor', err);
  }

  if (IsIntegrated) {
    try {
      ClearClientInfoSystem();
      ClearClientInfoUSB();
      ClearClientInfoDisplays();
      ClearClientInfoAudio();
      ClearClientInfoApplications();
      ClearClientInfoNetwork();
      ClearClientInfoStorage();
    } catch (err) {
      HandleNonFatalError('SelectionInit:NonFatal', err);
    }
    return;
  }

  // USB devices
  try {
    RenderClientInfoUSB(Client);
  } catch (err) {
    HandleNonFatalError('ClientInfo:RenderUSB', err);
  }

  // Displays
  try {
    RenderClientInfoDisplays(
      Client,
      IsVersionAtLeast(Client && Client.Version, MINIMUM_DISPLAY_MONITORING_VERSION)
    );
  } catch (err) {
    HandleNonFatalError('ClientInfo:RenderDisplays', err);
  }

  // Audio endpoints
  try {
    RenderClientInfoAudio(Client);
  } catch (err) {
    HandleNonFatalError('ClientInfo:RenderAudio', err);
  }

  // System checks: CPU, memory and uptime (Usage tab), power and thermal.
  try {
    RenderClientInfoSystem(Client);
  } catch (err) {
    HandleNonFatalError('ClientInfo:RenderSystem', err);
  }

  // Running applications
  try {
    RenderClientInfoApplications(Client);
  } catch (err) {
    HandleNonFatalError('ClientInfo:RenderApplications', err);
  }

  // Network Interfaces
  try {
    RenderClientInfoNetwork(Client);
  } catch (err) {
    HandleNonFatalError('ClientInfo:RenderNetwork', err);
  }

  // Storage volumes
  try {
    RenderClientInfoStorage(Client);
  } catch (err) {
    HandleNonFatalError('ClientInfo:RenderStorage', err);
  }
}
