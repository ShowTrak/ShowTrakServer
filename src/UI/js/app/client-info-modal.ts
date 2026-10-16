// Read-only Client Info modal: OpenClientInfo (opens + live-refresh loop) and
// RenderClientInfoDetails (renders every tab/section). Extracted from
// selection-init.ts (REFACTOR_PLAN.md Phase 7). Imports are added below;
// cross-references back into selection-init are call-time only (safe cycle).
import type { ClientView } from '@showtrak/protocol';
import { openModal } from './lib/modal';
import {
  ClientInfoOpenUUID,
  ClientInfoRefreshTimer,
  FormatClientVersionLabel,
  IsIntegratedClientEntity,
  Tags,
  __clientInfoRefreshInFlight,
  setClientInfoOpenUUID,
  setClientInfoRefreshTimer,
  setMonitorHistoryModalContext,
  setMonitorHistorySeries,
  setMonitorHistoryTooltipHover,
  set__clientInfoRefreshInFlight,
} from './state';
import { HandleNonFatalError, Safe } from './utils';
import { GetClientStatusDisplayText } from './client-list';
import { ScriptColourHex } from './lib/script-colours';
import { GetTagMembershipKind, ResolveEntityTags, TagBadgeLabel } from './lib/tag-badges';
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
import { ResetClientInfoTab, SetClientInfoKind } from './client-info-nav';
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

export async function OpenClientInfo(UUID: string) {
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

  const { Nickname, Hostname, IP, MacAddress, OperatingSystem, GroupID } = Client;
  // Group title lookup
  let groupTitle = 'No Group';
  try {
    const groups = await window.API.GetAllGroups();
    if (Array.isArray(groups)) {
      const g = groups.find((x) => x && x.GroupID === GroupID);
      if (g && g.Title) groupTitle = g.Title;
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  $('#CLIENT_INFO_NICKNAME').val(Nickname && Nickname.length ? Nickname : Hostname || '');
  $('#CLIENT_INFO_HOSTNAME').val(Hostname || '');
  $('#CLIENT_INFO_OPERATING_SYSTEM').val(OperatingSystem || '');
  $('#CLIENT_INFO_GROUP').val(groupTitle);
  $('#CLIENT_INFO_IP').val(IP || 'Unknown IP');
  // Every MAC on record, not just the active one — this panel is read-only, so
  // seeing the full Wake-on-LAN target set is the point. Falls back to the
  // primary MAC alone if the list has not been populated.
  const MacList = (Array.isArray(Client.MacAddresses) ? Client.MacAddresses : [])
    .map((Entry) => String(Entry.MacAddress || '').toUpperCase())
    .filter(Boolean);
  if (!MacList.length && MacAddress && String(MacAddress).trim().length > 0) {
    MacList.push(String(MacAddress).toUpperCase());
  }
  if (MacList.length) {
    $('#CLIENT_INFO_MAC').val(MacList.join(', '));
    $('label[for="CLIENT_INFO_MAC"]').text(
      MacList.length === 1 ? 'MAC Address' : `MAC Addresses (${MacList.length})`
    );
    $('#CLIENT_INFO_MAC_WRAPPER').removeClass('d-none');
  } else {
    $('#CLIENT_INFO_MAC').val('');
    $('#CLIENT_INFO_MAC_WRAPPER').addClass('d-none');
  }
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
  try {
    await LoadHistorySamplesForContext();
  } catch (err) {
    HandleNonFatalError('OpenClientInfo:LoadHistory', err);
  }
  RenderMonitoringHistoryModal();

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

// The tags this client carries, read-only, under the usage charts.
//
// Same chip markup as the editor's picker (minus the interaction), so a tag
// looks the same wherever it appears. Every chip shows its icon here — unlike
// the tile badges, this panel has the width for it. The section hides entirely
// when the client has no tags rather than showing an empty box.
function RenderClientInfoTags(Client: ClientView): void {
  const Entity = { ScopedID: String(Client.UUID || ''), GroupID: Client.GroupID ?? null };
  const Applied = ResolveEntityTags(Tags, Entity);

  $('#CLIENT_INFO_TAGS_SECTION').toggleClass('d-none', Applied.length === 0);
  if (!Applied.length) {
    $('#CLIENT_INFO_TAGS').html('');
    return;
  }

  const Html = Applied.map((Tag) => {
    const Kind = GetTagMembershipKind(Tag, Entity, Tags);
    // Naming where a tag came from matters here: it explains why a tag cannot
    // be removed from this client in the editor.
    const Via =
      Kind === 'workspace' ? 'ALL' : Kind === 'group' ? 'GROUP' : Kind === 'tag' ? 'TAG' : '';
    return `
      <span class="tag-picker-chip is-on" style="--tag-colour: ${Safe(ScriptColourHex(Tag.Colour))}">
        <i class="bi bi-${Safe(Tag.Icon || 'tag')}" aria-hidden="true"></i>
        <span class="tag-picker-chip-label">${Safe(TagBadgeLabel(Tag))}</span>
        ${Via ? `<span class="tag-picker-chip-via">${Safe(Via)}</span>` : ''}
      </span>`;
  }).join('');

  $('#CLIENT_INFO_TAGS').html(Html);
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
    $('#CLIENT_INFO_RUNNING_APPS_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_POWER_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_TEMPERATURE_SECTION').toggleClass('d-none', IsIntegrated);
    // An SDK client reports no operating system: no usage, uptime or power.
    $('#CLIENT_INFO_SYSTEM_SECTION').toggleClass('d-none', IsIntegrated);
    SetClientInfoKind(IsIntegrated ? 'integrated' : 'client');
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

  try {
    RenderClientInfoTags(Client);
  } catch (err) {
    HandleNonFatalError('ClientInfo:RenderTags', err);
  }

  if (IsIntegrated) {
    try {
      ClearClientInfoSystem();
      ClearClientInfoUSB();
      ClearClientInfoDisplays();
      ClearClientInfoAudio();
      ClearClientInfoApplications();
      ClearClientInfoNetwork();
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
}
