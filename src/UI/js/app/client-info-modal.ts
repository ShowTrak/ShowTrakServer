// Read-only Client Info modal: OpenClientInfo (opens + live-refresh loop) and
// RenderClientInfoDetails (renders every tab/section). Extracted from
// selection-init.ts (REFACTOR_PLAN.md Phase 7). Imports are added below;
// cross-references back into selection-init are call-time only (safe cycle).
import type {
  ClientView,
  ClientDisplayView,
  NetworkInterfaceAddress,
  RunningApplicationsStatus,
} from '@showtrak/protocol';
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
import { FormatBytes, HandleNonFatalError, Safe } from './utils';
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

// The renderer-facing DisplayList is enriched in-place by the client's
// critical-marking machinery with connection/mismatch annotations that the
// base ClientDisplayView type does not declare. Widen locally so the render
// path can read them without `any`.
type ClientInfoDisplayRow = ClientDisplayView & {
  IsConnected?: boolean;
  Mismatch?: boolean;
  CurrentSignature?: string | null;
  ExpectedSignature?: string | null;
};

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
  if (!Client) return Notify('Client not found', 'error');

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

  window.__ClientInfoNetFamily = 'IPv4';

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

  $('#SHOWTRAK_CLIENT_INFO_NET_FAMILY_V4')
    .off('click.net-family')
    .on('click.net-family', async function () {
      try {
        window.__ClientInfoNetFamily = 'IPv4';
        if (!ClientInfoOpenUUID) return;
        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) RenderClientInfoDetails(Fresh);
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:NetFamilyToggle', err);
      }
    });

  $('#SHOWTRAK_CLIENT_INFO_NET_FAMILY_V6')
    .off('click.net-family')
    .on('click.net-family', async function () {
      try {
        window.__ClientInfoNetFamily = 'IPv6';
        if (!ClientInfoOpenUUID) return;
        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) RenderClientInfoDetails(Fresh);
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:NetFamilyToggle', err);
      }
    });

  $('#SHOWTRAK_CLIENT_INFO_USB_DEVICES')
    .off('click.critical-usb-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_USB')
    .on('click.critical-usb-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_USB', async function () {
      try {
        const Mode = ($(this).attr('data-mode') || 'serial').toString();
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        if (!ClientInfoOpenUUID) return;

        let Err: unknown;
        if (Mode === 'name') {
          // Serial-less device: guarded by its visible name + connected count.
          const ManufacturerToken = ($(this).attr('data-manufacturer') || '').toString();
          const ProductToken = ($(this).attr('data-product') || '').toString();
          const Payload: { ManufacturerName?: string; ProductName?: string } = {};
          if (ManufacturerToken) Payload.ManufacturerName = decodeURIComponent(ManufacturerToken);
          if (ProductToken) Payload.ProductName = decodeURIComponent(ProductToken);
          [Err] = IsCritical
            ? await window.API.RemoveClientUSBNameCritical(ClientInfoOpenUUID, Payload)
            : await window.API.MarkClientUSBNameCritical(ClientInfoOpenUUID, Payload);
        } else {
          const SerialToken = ($(this).attr('data-serial') || '').toString();
          const SerialNumber = decodeURIComponent(SerialToken);
          if (!SerialNumber) return;
          [Err] = IsCritical
            ? await window.API.RemoveClientUSBDeviceCritical(ClientInfoOpenUUID, SerialNumber)
            : await window.API.MarkClientUSBDeviceCritical(ClientInfoOpenUUID, {
                SerialNumber,
              });
        }
        if (Err) return Notify(String(Err), 'error');

        await Notify(
          IsCritical ? 'Critical USB status removed' : 'USB device marked as critical',
          'success',
          1400
        );

        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) {
          $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Fresh));
          RenderClientInfoDetails(Fresh);
        }
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:ToggleCriticalUSB', err);
      }
    });

  $('#SHOWTRAK_CLIENT_INFO_DISPLAYS')
    .off('click.critical-display-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_DISPLAY')
    .on('click.critical-display-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_DISPLAY', async function () {
      try {
        const IsUnavailable = String($(this).attr('data-unavailable') || '0') === '1';
        if (IsUnavailable) return;
        const DisplayToken = ($(this).attr('data-display') || '').toString();
        const DisplayID = decodeURIComponent(DisplayToken);
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        if (!ClientInfoOpenUUID || !DisplayID) return;

        const [Err] = IsCritical
          ? await window.API.RemoveClientDisplayCritical(ClientInfoOpenUUID, DisplayID)
          : await window.API.MarkClientDisplayCritical(ClientInfoOpenUUID, {
              DisplayID,
            });
        if (Err) return Notify(String(Err), 'error');

        await Notify(
          IsCritical ? 'Critical display status removed' : 'Display marked as critical',
          'success',
          1400
        );

        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) {
          $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Fresh));
          RenderClientInfoDetails(Fresh);
        }
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:ToggleCriticalDisplay', err);
      }
    });

  $('#SHOWTRAK_CLIENT_INFO_RUNNING_APPLICATIONS')
    .off('click.critical-app-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_APP')
    .on('click.critical-app-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_APP', async function () {
      try {
        const NameToken = ($(this).attr('data-name') || '').toString();
        const ApplicationName = decodeURIComponent(NameToken);
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        if (!ClientInfoOpenUUID || !ApplicationName) return;

        const [Err] = IsCritical
          ? await window.API.RemoveClientApplicationCritical(ClientInfoOpenUUID, ApplicationName)
          : await window.API.MarkClientApplicationCritical(ClientInfoOpenUUID, {
              Name: ApplicationName,
            });
        if (Err) return Notify(String(Err), 'error');

        await Notify(
          IsCritical ? 'Critical application status removed' : 'Application marked as critical',
          'success',
          1400
        );

        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) {
          $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Fresh));
          RenderClientInfoDetails(Fresh);
        }
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:ToggleCriticalApplication', err);
      }
    });

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
    const Kind = GetTagMembershipKind(Tag, Entity);
    // Naming where a tag came from matters here: it explains why a tag cannot
    // be removed from this client in the editor.
    const Via = Kind === 'workspace' ? 'ALL' : Kind === 'group' ? 'GROUP' : '';
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
    $('#CLIENT_INFO_NETWORK_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_RUNNING_APPS_SECTION').toggleClass('d-none', IsIntegrated);
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

  // Vitals (CPU/RAM) progress bars
  try {
    const rawCpu = Client && Client.Vitals ? Client.Vitals.CPU?.UsagePercentage : 0;
    const cpuNum = typeof rawCpu === 'number' ? rawCpu : parseFloat(rawCpu);
    const cpuClamped = isNaN(cpuNum) ? 0 : Math.max(0, Math.min(100, cpuNum));

    const rawRam = Client && Client.Vitals ? Client.Vitals.Ram?.UsagePercentage : 0;
    const ramNum = typeof rawRam === 'number' ? rawRam : parseFloat(rawRam);
    const ramClamped = isNaN(ramNum) ? 0 : Math.max(0, Math.min(100, ramNum));

    $('#CLIENT_INFO_CPU_BAR')
      .css('width', `${cpuClamped}%`)
      .attr('aria-valuenow', cpuClamped.toFixed(0));
    $('#CLIENT_INFO_CPU_LABEL').text(`${cpuClamped.toFixed(0)}%`);
    $('#CLIENT_INFO_RAM_BAR')
      .css('width', `${ramClamped}%`)
      .attr('aria-valuenow', ramClamped.toFixed(0));
    // Compose RAM label: used/total (percent%) if we have byte counts
    const ramUsed =
      Client && Client.Vitals && typeof Client.Vitals.Ram?.Used !== 'undefined'
        ? Client.Vitals.Ram.Used
        : null;
    const ramTotal =
      Client && Client.Vitals && typeof Client.Vitals.Ram?.Total !== 'undefined'
        ? Client.Vitals.Ram.Total
        : null;
    if (ramUsed != null && ramTotal != null) {
      const usedStr = FormatBytes(ramUsed);
      const totalStr = FormatBytes(ramTotal);
      if (usedStr && totalStr) {
        $('#CLIENT_INFO_RAM_LABEL').text(`${usedStr} / ${totalStr} (${ramClamped.toFixed(0)}%)`);
      } else {
        $('#CLIENT_INFO_RAM_LABEL').text(`${ramClamped.toFixed(0)}%`);
      }
    } else {
      $('#CLIENT_INFO_RAM_LABEL').text(`${ramClamped.toFixed(0)}%`);
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  if (IsIntegrated) {
    try {
      $('#SHOWTRAK_CLIENT_INFO_USB_DEVICES').attr('data-render-key', '').html('');
      $('#SHOWTRAK_CLIENT_INFO_DISPLAYS').attr('data-render-key', '').html('');
      $('#SHOWTRAK_CLIENT_INFO_RUNNING_APPLICATIONS').attr('data-render-key', '').html('');
      $('#SHOWTRAK_CLIENT_INFO_NET_INTERFACES').html('');
    } catch (err) {
      HandleNonFatalError('SelectionInit:NonFatal', err);
    }
    return;
  }

  // USB devices
  try {
    const $usbList = $('#SHOWTRAK_CLIENT_INFO_USB_DEVICES');
    const list = Array.isArray(Client.USBDeviceList) ? Client.USBDeviceList : [];
    const clientKey = Client && Client.UUID ? String(Client.UUID) : '';
    const renderKey = `${clientKey}::${list
      .map(
        (d) =>
          `${d.SerialNumber || d.NameKey || ''}|${d.IsCritical ? '1' : '0'}|${
            d.IsConnected === false ? '0' : '1'
          }|${d.IsCriticalByName ? '1' : '0'}|${d.ConnectedCount ?? ''}/${d.Quantity ?? ''}`
      )
      .join(';;')}`;
    const previousRenderKey = $usbList.attr('data-render-key') || '';

    if (previousRenderKey !== renderKey) {
      // Dispose old popovers before replacing USB rows to avoid dangling tooltips.
      try {
        $usbList.find('.SHOWTRAK_TOGGLE_CRITICAL_USB[data-bs-toggle="popover"]').each(function () {
          const instance = bootstrap.Popover.getInstance(this);
          if (instance) instance.dispose();
        });
      } catch (e) {
        // Best effort cleanup only.
      }

      if (list.length === 0) {
        $usbList.html(`
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">No USB Devices Connected</h6>
            <p class="text-sm mb-0">Devices that do not comply with WebUSB 1.3 cannot be displayed.</p>
          </div>`);
      } else {
        $usbList.html('');
        for (const dev of list) {
          const ManufacturerName = dev.ManufacturerName;
          const ProductName = dev.ProductName;
          const SerialNumber = dev.SerialNumber;
          const IsCritical = !!dev.IsCritical;
          const IsConnected = dev.IsConnected !== false;
          const IsCriticalByName = !!dev.IsCriticalByName;
          const Shortfall = !!dev.Shortfall;
          const HasSerial = typeof SerialNumber === 'string' && SerialNumber.trim().length > 0;
          // Serial-less devices are guarded by their visible name + a connected
          // count; devices with a serial keep the per-serial guarantee.
          const Mode = HasSerial ? 'serial' : 'name';
          const SerialToken = HasSerial ? encodeURIComponent(SerialNumber!.trim()) : '';
          const ManufacturerToken = ManufacturerName
            ? encodeURIComponent(String(ManufacturerName))
            : '';
          const ProductToken = ProductName ? encodeURIComponent(String(ProductName)) : '';
          const Quantity = typeof dev.Quantity === 'number' ? dev.Quantity : null;
          const ConnectedCount = typeof dev.ConnectedCount === 'number' ? dev.ConnectedCount : null;

          // Subtitle: the serial when present, otherwise the connected-vs-expected
          // count for a name-guarded device, else a plain "no serial" note.
          let Subtitle: string;
          if (HasSerial) {
            Subtitle = Safe(SerialNumber);
          } else if (IsCriticalByName && Quantity !== null) {
            Subtitle = `${ConnectedCount ?? 0} of ${Quantity} connected`;
          } else {
            Subtitle = 'No serial number';
          }

          // A critical device needs attention when it's disconnected, or when a
          // name-guarded device has fewer connected than expected (shortfall).
          const NeedsAttention = IsCritical && (!IsConnected || Shortfall);
          const StatusLabel = !IsConnected ? 'Disconnected' : Shortfall ? 'Short' : 'Critical';
          const ActionLabel = !IsConnected
            ? 'Remove critical status (device disconnected)'
            : Shortfall
              ? 'Remove critical status (fewer connected than expected)'
              : IsCritical
                ? 'Remove critical status'
                : 'Mark as critical';

          $usbList.append(`
            <div class="rounded-3 p-2 bg-ghost SHOWTRAK_CLIENT_USB_DEVICE_CARD">
              <div class="d-flex align-items-center gap-2">
                <h6 class="mb-0">${ManufacturerName ? Safe(ManufacturerName) : 'Generic'} ${
                  ProductName ? Safe(ProductName) : 'USB Device'
                }</h6>
              </div>
              <small class="text-light d-block mb-0 text-start">${Subtitle}</small>
              <button
                type="button"
                class="SHOWTRAK_TOGGLE_CRITICAL_USB ${IsCritical ? 'is-critical' : ''} ${
                  NeedsAttention ? 'is-disconnected-critical' : ''
                }"
                data-mode="${Mode}"
                data-serial="${SerialToken}"
                data-manufacturer="${ManufacturerToken}"
                data-product="${ProductToken}"
                data-critical="${IsCritical ? '1' : '0'}"
                title="${ActionLabel}"
                aria-label="${ActionLabel}"
              >
                <i class="bi ${NeedsAttention ? 'bi-x-circle-fill' : IsCritical ? 'bi-check-circle-fill' : 'bi-check-circle'}"></i>
                <span>${StatusLabel}</span>
              </button>
              ${
                IsCriticalByName
                  ? `<small class="d-block mt-2 mb-0 text-start text-warning SHOWTRAK_USB_NAME_WARNING"><i class="bi bi-exclamation-triangle-fill me-1"></i>ShowTrak can only monitor this device by name (expects ${
                      Quantity ?? 1
                    }), so identical devices can't be told apart.</small>`
                  : ''
              }
            </div>
          `);
        }
      }

      $usbList.attr('data-render-key', renderKey);

      try {
        const Nodes = document.querySelectorAll(
          '#SHOWTRAK_CLIENT_INFO_USB_DEVICES .SHOWTRAK_TOGGLE_CRITICAL_USB[data-bs-toggle="popover"]'
        );
        for (const Node of Nodes) {
          if (!Node) continue;
          if (bootstrap.Popover.getInstance(Node)) continue;
          new bootstrap.Popover(Node, {
            container: 'body',
            customClass: 'SHOWTRAK_USB_POPOVER',
          });
        }
      } catch (err) {
        HandleNonFatalError('RenderClientInfoDetails:CriticalUSBPopoverInit', err);
      }
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Displays
  try {
    const $displayList = $('#SHOWTRAK_CLIENT_INFO_DISPLAYS');
    const DisplayMonitoringSupported = IsVersionAtLeast(
      Client && Client.Version,
      MINIMUM_DISPLAY_MONITORING_VERSION
    );
    const displays: ClientInfoDisplayRow[] = Array.isArray(Client.DisplayList)
      ? Client.DisplayList
      : [];
    const clientKey = Client && Client.UUID ? String(Client.UUID) : '';
    const renderKey = `${clientKey}::${DisplayMonitoringSupported ? 'supported' : 'unsupported'}::${displays
      .map(
        (d) =>
          `${d.DisplayID || ''}|${d.IsCritical ? '1' : '0'}|${
            d.IsConnected === false ? '0' : '1'
          }|${d.Mismatch ? '1' : '0'}|${d.CurrentSignature || ''}|${d.ExpectedSignature || ''}|${d.ScreenNumber || ''}`
      )
      .join(';;')}`;
    const previousRenderKey = $displayList.attr('data-render-key') || '';

    const FormatDisplayResolution = (d: {
      Width?: string | number | null;
      Height?: string | number | null;
      RefreshRate?: string | number | null;
    }) => {
      const w = parseInt(String(d.Width ?? ''), 10) || 0;
      const h = parseInt(String(d.Height ?? ''), 10) || 0;
      if (!w || !h) return null;
      const rate =
        d && d.RefreshRate != null && Number.isFinite(Number(d.RefreshRate))
          ? Math.round(Number(d.RefreshRate))
          : null;
      return rate ? `${w} × ${h} @ ${rate}Hz` : `${w} × ${h}`;
    };

    if (previousRenderKey !== renderKey) {
      if (!DisplayMonitoringSupported) {
        $displayList.html(`
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">Display Monitoring Unavailable</h6>
            <p class="text-sm mb-0">Display monitoring is only available in ShowTrak Client 3.8.0 and above.</p>
          </div>`);
        $displayList.attr('data-render-key', renderKey);
      } else if (displays.length === 0) {
        $displayList.html(`
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">No Displays Detected</h6>
            <p class="text-sm mb-0">This client has not reported any connected displays.</p>
          </div>`);
      } else {
        $displayList.html('');
        for (const disp of displays) {
          const DisplayID = disp.DisplayID;
          const HasID = typeof DisplayID === 'string' && DisplayID.trim().length > 0;
          const DisplayToken = HasID ? encodeURIComponent(DisplayID.trim()) : '';
          const IsCritical = !!disp.IsCritical;
          const IsConnected = disp.IsConnected !== false;
          const IsMismatch = !!disp.Mismatch;
          const ScreenNumber =
            disp.ScreenNumber != null && Number.isFinite(Number(disp.ScreenNumber))
              ? Math.trunc(Number(disp.ScreenNumber))
              : null;
          const ScreenNumberBadge =
            ScreenNumber != null && IsConnected
              ? `<span class="SHOWTRAK_DISPLAY_NUMBER" title="Identify screen number">${ScreenNumber}</span>`
              : '';
          const Label =
            disp.Label && String(disp.Label).trim().length > 0
              ? String(disp.Label).trim()
              : disp.Primary
                ? 'Primary Display'
                : 'Display';
          const CurrentRes = FormatDisplayResolution(disp);
          const ExpectedRes =
            IsMismatch || !IsConnected
              ? FormatDisplayResolution({
                  Width: (disp.ExpectedSignature || '').split('x')[0],
                  Height: ((disp.ExpectedSignature || '').split('x')[1] || '').split('@')[0],
                  RefreshRate: (disp.ExpectedSignature || '').split('@')[1],
                })
              : null;

          let subText;
          if (!IsConnected) {
            subText = ExpectedRes ? `Expected ${Safe(ExpectedRes)}` : 'Disconnected';
          } else if (IsMismatch) {
            subText = `${CurrentRes ? Safe(CurrentRes) : 'Unknown'}${
              ExpectedRes ? ` (expected ${Safe(ExpectedRes)})` : ''
            }`;
          } else {
            subText = CurrentRes ? Safe(CurrentRes) : 'Resolution unavailable';
          }

          const IconClass =
            IsCritical && !IsConnected
              ? 'bi-x-circle-fill'
              : IsCritical && IsMismatch
                ? 'bi-exclamation-triangle-fill'
                : IsCritical
                  ? 'bi-check-circle-fill'
                  : 'bi-check-circle';
          const ButtonLabel =
            IsCritical && !IsConnected
              ? 'Missing'
              : IsCritical && IsMismatch
                ? 'Changed'
                : 'Critical';
          const TitleText = !HasID
            ? 'Unavailable due to missing identifier'
            : IsCritical && !IsConnected
              ? 'Remove critical status (display disconnected)'
              : IsCritical && IsMismatch
                ? 'Display configuration changed — remove critical status'
                : IsCritical
                  ? 'Remove critical status'
                  : 'Mark as critical';

          $displayList.append(`
            <div class="rounded-3 p-2 bg-ghost SHOWTRAK_CLIENT_USB_DEVICE_CARD">
              <div class="d-flex align-items-center gap-2">
                ${ScreenNumberBadge}
                <h6 class="mb-0">${Safe(Label)}${disp.Primary ? ' <small class="text-light">(Primary)</small>' : ''}</h6>
              </div>
              <small class="text-light d-block mb-0 text-start">${subText}</small>
              <button
                type="button"
                class="SHOWTRAK_TOGGLE_CRITICAL_DISPLAY ${IsCritical ? 'is-critical' : ''} ${
                  IsCritical && !IsConnected ? 'is-disconnected-critical' : ''
                } ${IsCritical && IsMismatch ? 'is-mismatch-critical' : ''} ${HasID ? '' : 'is-unavailable'}"
                data-display="${DisplayToken}"
                data-critical="${IsCritical ? '1' : '0'}"
                data-unavailable="${HasID ? '0' : '1'}"
                ${HasID ? `title="${TitleText}"` : ''}
                aria-label="${TitleText}"
              >
                <i class="bi ${IconClass}"></i>
                <span>${ButtonLabel}</span>
              </button>
            </div>
          `);
        }
      }

      $displayList.attr('data-render-key', renderKey);
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Running applications
  try {
    const $appsList = $('#SHOWTRAK_CLIENT_INFO_RUNNING_APPLICATIONS');
    const apps = Array.isArray(Client?.RunningApplications?.Items)
      ? Client.RunningApplications.Items
      : [];
    const appStatus: Partial<RunningApplicationsStatus> = Client?.RunningApplications?.Status || {};
    const appStatusState =
      typeof appStatus.State === 'string' && appStatus.State.trim().length > 0
        ? appStatus.State.trim().toLowerCase()
        : 'unknown';
    const appStatusMessage =
      typeof appStatus.Message === 'string' && appStatus.Message.trim().length > 0
        ? appStatus.Message.trim()
        : null;
    const renderKey = `${Client?.UUID || ''}::${apps
      .map(
        (app) =>
          `${app?.Name || ''}|${app?.IsCritical ? '1' : '0'}|${app?.IsRunning === false ? '0' : '1'}`
      )
      .join(';;')}::${appStatusState}|${appStatusMessage || ''}`;

    if (($appsList.attr('data-render-key') || '') !== renderKey) {
      if (apps.length === 0) {
        let filler = '';
        if (appStatusState === 'permission_denied' || appStatusState === 'error') {
          filler += `
            <div class="rounded-3 p-2 bg-danger bg-opacity-25 border border-danger-subtle">
              <h6 class="mb-1">Application Monitoring Warning</h6>
              <p class="text-sm mb-0">${Safe(
                appStatusMessage ||
                  'The client cannot collect running applications because system permission was denied.'
              )}</p>
            </div>`;
        }
        filler += `
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">No applications reported</h6>
            <p class="text-sm mb-0">The client has not sent an application snapshot yet.</p>
          </div>`;
        $appsList.html(filler);
      } else {
        let html = '';
        if (appStatusState === 'permission_denied' || appStatusState === 'error') {
          html += `
            <div class="rounded-3 p-2 bg-danger bg-opacity-25 border border-danger-subtle">
              <h6 class="mb-1">Application Monitoring Warning</h6>
              <p class="text-sm mb-0">${Safe(
                appStatusMessage ||
                  'The client cannot collect running applications because system permission was denied.'
              )}</p>
            </div>`;
        }
        for (const app of apps) {
          const name = app?.Name ? String(app.Name) : 'Unknown Application';
          const IsCritical = !!app?.IsCritical;
          const IsRunning = app?.IsRunning !== false;
          const NameToken = encodeURIComponent(name);
          html += `
            <div class="rounded-3 p-2 bg-ghost SHOWTRAK_CLIENT_USB_DEVICE_CARD">
              <div class="d-flex align-items-center gap-2">
                <h6 class="mb-0">${Safe(name)}</h6>
              </div>
              <button
                type="button"
                class="SHOWTRAK_TOGGLE_CRITICAL_USB SHOWTRAK_TOGGLE_CRITICAL_APP ${IsCritical ? 'is-critical' : ''} ${
                  IsCritical && !IsRunning ? 'is-disconnected-critical' : ''
                }"
                data-name="${NameToken}"
                data-critical="${IsCritical ? '1' : '0'}"
                title="${
                  IsCritical && !IsRunning
                    ? 'Remove critical status (application not running)'
                    : IsCritical
                      ? 'Remove critical status'
                      : 'Mark as critical'
                }"
                aria-label="${
                  IsCritical && !IsRunning
                    ? 'Remove critical status (application not running)'
                    : IsCritical
                      ? 'Remove critical status'
                      : 'Mark as critical'
                }"
              >
                <i class="bi ${IsCritical && !IsRunning ? 'bi-x-circle-fill' : IsCritical ? 'bi-check-circle-fill' : 'bi-check-circle'}"></i>
                <span>${IsCritical && !IsRunning ? 'Not Running' : 'Critical'}</span>
              </button>
            </div>`;
        }
        $appsList.html(html);
      }

      $appsList.attr('data-render-key', renderKey);
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Network Interfaces
  try {
    const $netList = $('#SHOWTRAK_CLIENT_INFO_NET_INTERFACES');
    const $v4 = $('#SHOWTRAK_CLIENT_INFO_NET_FAMILY_V4');
    const $v6 = $('#SHOWTRAK_CLIENT_INFO_NET_FAMILY_V6');
    const selectedFamily = window.__ClientInfoNetFamily === 'IPv6' ? 'IPv6' : 'IPv4';
    window.__ClientInfoNetFamily = selectedFamily;
    const isV4 = selectedFamily === 'IPv4';
    $v4
      .toggleClass('btn-light', isV4)
      .toggleClass('btn-outline-light', !isV4)
      .attr('aria-pressed', isV4 ? 'true' : 'false');
    $v6
      .toggleClass('btn-light', !isV4)
      .toggleClass('btn-outline-light', isV4)
      .attr('aria-pressed', isV4 ? 'false' : 'true');

    $netList.html('');
    const ifaces = Array.isArray(Client.NetworkInterfaces) ? Client.NetworkInterfaces : [];

    const normalizeFamily = (family: unknown) => {
      const value = String(family || '').toUpperCase();
      if (value === '4' || value === 'IPV4') return 'IPv4';
      if (value === '6' || value === 'IPV6') return 'IPv6';
      return value;
    };
    const isAddressActive = (address: NetworkInterfaceAddress | null | undefined) => {
      if (!address || typeof address !== 'object') return false;
      if (typeof address.active === 'boolean') return address.active;
      const ip = String(address.address || '').trim();
      if (!ip) return false;
      if (ip === '0.0.0.0' || ip === '::') return false;
      return true;
    };

    if (ifaces.length === 0) {
      $netList.html(
        '<div class="rounded-3 p-2 bg-ghost"><h6 class="mb-0">No Interfaces Reported</h6></div>'
      );
    } else {
      const cards: string[] = [];
      for (const iface of ifaces) {
        const nameRaw = iface && iface.name ? String(iface.name) : 'unknown';
        const name = Safe(nameRaw || 'unknown');
        const addresses = Array.isArray(iface.addresses) ? iface.addresses : [];
        const matchingAddresses = addresses.filter(
          (a) => normalizeFamily(a && a.family) === selectedFamily
        );
        if (!matchingAddresses.length) continue;

        for (const address of matchingAddresses) {
          const ip = Safe(address && address.address ? address.address : 'Unknown address');
          const mask = Safe(address && address.netmask ? address.netmask : 'Unknown');
          const mac = Safe(address && address.mac ? String(address.mac).toUpperCase() : 'Unknown');
          const inactiveClass = isAddressActive(address) ? '' : ' is-inactive';
          const kindBadge =
            address && address.internal
              ? '<span class="SHOWTRAK_NET_IFACE_KIND_BADGE">Internal Only</span>'
              : '';
          cards.push(`
            <div class="rounded-3 p-2 bg-ghost SHOWTRAK_NET_IFACE_CARD${inactiveClass}">
              ${kindBadge}
              <div class="SHOWTRAK_NET_IFACE_NAME">${name}</div>
              <div class="SHOWTRAK_NET_IFACE_IP mt-1">${ip}</div>
              <div class="SHOWTRAK_NET_IFACE_META mt-1">${mask}</div>
              <div class="SHOWTRAK_NET_IFACE_META">${mac}</div>
            </div>`);
        }
      }

      if (!cards.length) {
        $netList.html(
          `<div class="rounded-3 p-2 bg-ghost"><h6 class="mb-0">No ${selectedFamily} Interfaces Detected</h6></div>`
        );
      } else {
        $netList.html(cards.join(''));
      }
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
}
