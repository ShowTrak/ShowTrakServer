// USB section of the client info modal: one card per device, styled like the
// audio and display cards, with a critical toggle and — once critical — an
// auto-saving conditions table (connected, port, firmware version, device
// error). The decisions live in lib/usb-devices.
import { CreateConditionSaveQueue } from './lib/condition-save-queue';
import type { ClientView, USBCapabilities, USBDeviceView } from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import {
  GetUSBSectionState,
  ParseUSBRuleFields,
  USBConditionRows,
  USBDeviceBadge,
  USBDeviceError,
  USBDeviceSummary,
  USBDeviceTitle,
  USBGuardMode,
  USBRenderKey,
  USB_CONDITION_FIELDS,
  VisibleUSBDevices,
  type USBConditionField,
  type USBSectionState,
} from './lib/usb-devices';

export const USB_LIST = '#SHOWTRAK_CLIENT_INFO_USB_DEVICES';

// Saves of each device's conditions, chained so two quick ticks reach the
// server in the order they were made.
const Saves = CreateConditionSaveQueue();

const Token = (Value: unknown) => (Value ? encodeURIComponent(String(Value)) : '');

function MessageCard(Title: string, Body: string): string {
  return `
    <div class="rounded-3 p-2 bg-ghost">
      <h6 class="mb-0">${Safe(Title)}</h6>
      <p class="text-sm mb-0">${Safe(Body)}</p>
    </div>`;
}

// What identifies a device to the mark/remove calls, carried on the toggle and
// on the conditions table.
function IdentityAttributes(Device: USBDeviceView): string {
  const Mode = USBGuardMode(Device);
  return [
    `data-mode="${Mode}"`,
    `data-serial="${Mode === 'serial' ? Token(String(Device.SerialNumber).trim()) : ''}"`,
    `data-manufacturer="${Token(Device.ManufacturerName)}"`,
    `data-product="${Token(Device.ProductName)}"`,
  ].join(' ');
}

/** A critical device's conditions: key, value, and a tick to monitor it. Saves as it changes. */
function ConditionsTable(Device: USBDeviceView, Capabilities: USBCapabilities | null): string {
  const Rows = USBConditionRows(Device, Capabilities);
  if (!Rows.length) return '';
  return `
    <table class="SHOWTRAK_AUDIO_CONDITIONS SHOWTRAK_USB_CONDITIONS" ${IdentityAttributes(Device)}>
      <tbody>
        ${Rows.map(
          (Row) => `
          <tr data-cond="${Row.Field}" class="${Row.Supported ? '' : 'is-unsupported'} ${Row.Failing ? 'is-failing' : ''}"
            ${Row.Failing ? `title="${Safe(Row.Failing)}"` : ''}>
            <th scope="row">${Safe(Row.Label)}</th>
            <td><span class="SHOWTRAK_AUDIO_COND_VALUE">${Safe(Row.Value)}</span></td>
            <td class="SHOWTRAK_AUDIO_COND_CHECK">${
              Row.Supported
                ? `<input type="checkbox" class="form-check-input" data-rule="${Row.Field}"
                    ${Row.Checked ? 'checked' : ''} ${Row.Locked ? 'disabled' : ''} aria-label="Monitor ${Safe(Row.Label.toLowerCase())}" />`
                : ''
            }</td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`;
}

function Warning(Message: string): string {
  return `<small class="d-block mt-1 text-start st-condition-failing"><i class="bi bi-exclamation-triangle me-1"></i>${Safe(Message)}</small>`;
}

function DeviceCard(Device: USBDeviceView, Capabilities: USBCapabilities | null): string {
  const Badge = USBDeviceBadge(Device);
  const Issues = (Device.Issues || []).map((Issue) => Issue.Message);
  // A device error is worth seeing on any device, critical or not.
  const Error = USBDeviceError(Device);
  if (Error && !Issues.some((Message) => Message === Error)) Issues.push(Error);
  const ToggleClasses = [
    'SHOWTRAK_TOGGLE_CRITICAL_USB',
    'SHOWTRAK_TOGGLE_CRITICAL_AUDIO',
    'SHOWTRAK_TOGGLE_CRITICAL_USB_DEVICE',
    Device.IsCritical ? 'is-critical' : '',
    Badge.State === 'missing' || Badge.State === 'short' ? 'is-disconnected-critical' : '',
    Badge.State === 'issue' ? 'is-mismatch-critical' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <div class="rounded-3 p-2 bg-ghost SHOWTRAK_AUDIO_CARD SHOWTRAK_USB_CARD">
      <div class="SHOWTRAK_AUDIO_CARD_HEADER">
        <div class="SHOWTRAK_AUDIO_TITLE text-start">
          <h6 class="mb-0">${Safe(USBDeviceTitle(Device))}</h6>
          <small class="text-light d-block mb-0 text-start">${Safe(USBDeviceSummary(Device))}</small>
        </div>
        <button type="button" class="${ToggleClasses}" ${IdentityAttributes(Device)}
          data-critical="${Device.IsCritical ? '1' : '0'}" title="${Badge.Title}" aria-label="${Badge.Title}">
          <i class="bi ${Badge.Icon}"></i>
          <span>${Badge.Label}</span>
        </button>
      </div>
      ${Issues.map(Warning).join('')}
      ${
        Device.IsCriticalByName
          ? Warning(
              `ShowTrak can only monitor this device by name (expects ${
                Device.Quantity ?? 1
              }), so identical devices can't be told apart.`
            )
          : ''
      }
      ${ConditionsTable(Device, Capabilities)}
    </div>`;
}

/** The section markup for a client. Pure: a function of the client alone. */
export function BuildUSBSectionHtml(Client: ClientView, State: USBSectionState): string {
  const Html: string[] = [];
  const Devices = VisibleUSBDevices(Client, State);
  if (State === 'offline') {
    Html.push(
      MessageCard('Client Offline', 'USB devices are reported while the client is connected.')
    );
  } else if (!Devices.length) {
    Html.push(
      MessageCard(
        'No USB Devices Connected',
        'Devices that do not comply with WebUSB 1.3 cannot be displayed.'
      )
    );
  }
  const Capabilities = Client.USBCapabilities ?? null;
  for (const Device of Devices) Html.push(DeviceCard(Device, Capabilities));
  return Html.join('');
}

/** Render the section, rebuilt only when what it shows changes. */
export function RenderClientInfoUSB(Client: ClientView): void {
  const $List = $(USB_LIST);
  const State = GetUSBSectionState(Client);
  const Key = USBRenderKey(Client, State);
  if (($List.attr('data-render-key') || '') === Key) return;
  $List.html(BuildUSBSectionHtml(Client, State));
  $List.attr('data-render-key', Key);
}

/** Empty the section (an SDK client has no USB devices to show). */
export function ClearClientInfoUSB(): void {
  $(USB_LIST).attr('data-render-key', '').html('');
}

interface USBIdentity {
  Mode: 'serial' | 'name';
  SerialNumber: string;
  ManufacturerName?: string;
  ProductName?: string;
  Key: string;
}

function ReadIdentity(Element: Element): USBIdentity {
  const $El = $(Element);
  const Decode = (Name: string) => decodeURIComponent(String($El.attr(Name) || ''));
  const Mode = $El.attr('data-mode') === 'name' ? 'name' : 'serial';
  const SerialNumber = Decode('data-serial');
  const ManufacturerName = Decode('data-manufacturer') || undefined;
  const ProductName = Decode('data-product') || undefined;
  return {
    Mode,
    SerialNumber,
    ManufacturerName,
    ProductName,
    Key: Mode === 'serial' ? `serial:${SerialNumber}` : `name:${ManufacturerName}|${ProductName}`,
  };
}

// Mark (or update) by serial or by name; the payload is the request's options.
function Mark(UUID: string, Id: USBIdentity, Options: Record<string, boolean> = {}) {
  return Id.Mode === 'serial'
    ? window.API.MarkClientUSBDeviceCritical(UUID, { SerialNumber: Id.SerialNumber, ...Options })
    : window.API.MarkClientUSBNameCritical(UUID, {
        ManufacturerName: Id.ManufacturerName,
        ProductName: Id.ProductName,
        ...Options,
      });
}

/** Wire the section's controls. `Refresh` re-fetches and re-renders the client. */
export function BindClientInfoUSBHandlers(
  GetUUID: () => string | null,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): void {
  $(USB_LIST)
    .off('.client-usb')
    .on('click.client-usb', '.SHOWTRAK_TOGGLE_CRITICAL_USB_DEVICE', async function () {
      try {
        const UUID = GetUUID();
        const Id = ReadIdentity(this);
        if (!UUID || (Id.Mode === 'serial' && !Id.SerialNumber)) return;
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        const [Err] = !IsCritical
          ? await Mark(UUID, Id)
          : Id.Mode === 'serial'
            ? await window.API.RemoveClientUSBDeviceCritical(UUID, Id.SerialNumber)
            : await window.API.RemoveClientUSBNameCritical(UUID, {
                ManufacturerName: Id.ManufacturerName,
                ProductName: Id.ProductName,
              });
        if (Err) return void Notify(String(Err), 'error');
        await Notify(
          IsCritical ? 'USB device no longer monitored.' : 'USB device is now monitored.',
          'success',
          1400
        );
        await Refresh();
      } catch (err) {
        HandleNonFatalError('ClientInfo:ToggleCriticalUSB', err);
      }
    })
    // Conditions save as they are ticked.
    .on('change.client-usb', '.SHOWTRAK_USB_CONDITIONS input', function () {
      const UUID = GetUUID();
      const $Table = $(this).closest('.SHOWTRAK_USB_CONDITIONS');
      if (!UUID || !$Table.length) return;
      const Id = ReadIdentity($Table[0]!);
      const Fields: Partial<Record<USBConditionField, boolean>> = {};
      for (const Field of USB_CONDITION_FIELDS) {
        const $Check = $Table.find(`input[type="checkbox"][data-rule="${Field}"]`);
        // A row without a tick (Unsupported) is not part of the request.
        if ($Check.length) Fields[Field] = $Check.is(':checked');
      }
      const Options = ParseUSBRuleFields(Fields) as Record<string, boolean>;
      return Saves.Enqueue(Id.Key, {
        Save: async () => (await Mark(UUID, Id, Options))[0],
        Refresh,
        Notify,
        ResetRender: () => $(USB_LIST).attr('data-render-key', ''),
        ErrorContext: 'ClientInfo:SaveUSBConditions',
      });
    });
}

export const _internal = { SaveChains: Saves.Chains };
