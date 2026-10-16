// IPv4 Interfaces and IPv6 Interfaces sections of the client info modal, built
// by the same code like the audio inputs/outputs: one card per interface,
// styled like the audio cards. On the interface's home family (see HomeFamily)
// the card carries the critical toggle and — once critical — an auto-saving
// conditions table (present, IP address, IP range, subnet mask, router); in the
// other family's list it only shows the addresses. The decisions live in
// lib/network-interfaces.
import type { ClientView, NetworkCapabilities, NetworkInterfaceView } from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import {
  GetNetworkSectionState,
  HomeFamily,
  InterfacesFor,
  NetworkFamilyTitle,
  NetworkConditionRows,
  NetworkInterfaceBadge,
  NetworkInterfaceSummary,
  NetworkInterfaceTitle,
  NetworkRenderKey,
  NetworkSectionMessage,
  ParseNetworkRuleFields,
  type NetworkConditionRow,
  type NetworkFamily,
  type NetworkSectionState,
} from './lib/network-interfaces';

/** The list element of each family's section. */
export const NETWORK_LISTS: Record<NetworkFamily, string> = {
  IPv4: '#SHOWTRAK_CLIENT_INFO_NET_IPV4',
  IPv6: '#SHOWTRAK_CLIENT_INFO_NET_IPV6',
};
const FAMILIES: NetworkFamily[] = ['IPv4', 'IPv6'];
const ALL_LISTS = FAMILIES.map((Family) => NETWORK_LISTS[Family]).join(', ');

// Saves of each interface's conditions, chained so two quick edits reach the
// server in the order they were made.
const SaveChains = new Map<string, Promise<void>>();

// The last client rendered, so a rebuild held back while a condition was being
// typed into can be applied once the field loses focus.
let Pending: ClientView | null = null;

const Token = (Name: string) => encodeURIComponent(Name);

function MessageCard(Title: string, Body: string): string {
  return `
    <div class="rounded-3 p-2 bg-ghost">
      <h6 class="mb-0">${Safe(Title)}</h6>
      <p class="text-sm mb-0">${Safe(Body)}</p>
    </div>`;
}

function ConditionInput(Name: string, Value: string, Default: string, Label: string): string {
  return `<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off"
    data-rule="${Name}" value="${Safe(Value)}" placeholder="${Safe(Default)}"
    data-default="${Safe(Default)}" aria-label="${Safe(Label)}" />`;
}

function ConditionCell(Row: NetworkConditionRow): string {
  if (!Row.Supported) return `<span class="SHOWTRAK_AUDIO_COND_VALUE">Unsupported</span>`;
  if (!Row.Editable) return `<span class="SHOWTRAK_AUDIO_COND_VALUE">${Safe(Row.Value)}</span>`;
  if (Row.Field === 'Range') {
    return `
      <span class="SHOWTRAK_NET_COND_ADDRESS is-range">
        ${ConditionInput('RangeStart', Row.Expected[0] ?? '', Row.Defaults[0] ?? '', 'IP range start')}
        <span>–</span>
        ${ConditionInput('RangeEnd', Row.Expected[1] ?? '', Row.Defaults[1] ?? '', 'IP range end')}
      </span>`;
  }
  return `
    <span class="SHOWTRAK_NET_COND_ADDRESS">
      ${ConditionInput(Row.Field, Row.Expected[0] ?? '', Row.Defaults[0] ?? '', Row.Label)}
    </span>`;
}

/** A critical interface's conditions: key, value, and a tick to monitor it. Saves as it changes. */
function ConditionsTable(
  Iface: NetworkInterfaceView,
  Capabilities: NetworkCapabilities | null
): string {
  const Rows = NetworkConditionRows(Iface, Capabilities);
  if (!Rows.length) return '';
  return `
    <table class="SHOWTRAK_AUDIO_CONDITIONS SHOWTRAK_NET_CONDITIONS" data-interface="${Token(Iface.Name)}">
      <tbody>
        ${Rows.map(
          (Row) => `
          <tr data-cond="${Row.Field}" class="${Row.Supported ? '' : 'is-unsupported'} ${Row.Failing ? 'is-failing' : ''}"
            ${Row.Failing ? `title="${Safe(Row.Failing)}"` : ''}>
            <th scope="row">${Safe(Row.Label)}</th>
            <td>${ConditionCell(Row)}</td>
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

function InterfaceCard(
  Iface: NetworkInterfaceView,
  Capabilities: NetworkCapabilities | null,
  Family: NetworkFamily
): string {
  const Badge = NetworkInterfaceBadge(Iface);
  const { Title, Extra } = NetworkInterfaceTitle(Iface, Family);
  const Summary = NetworkInterfaceSummary(Iface, Capabilities, Family);
  // Controlled from its home family's list only; elsewhere it just lists addresses.
  const Home = HomeFamily(Iface) === Family;
  const Toggle = !Home
    ? Badge.State === 'internal'
      ? `<span class="SHOWTRAK_NET_INTERNAL_BADGE" title="${Badge.Title}">${Badge.Label}</span>`
      : ''
    : Badge.State === 'internal'
      ? `<span class="SHOWTRAK_NET_INTERNAL_BADGE" title="${Badge.Title}">${Badge.Label}</span>`
      : `<button type="button" class="${[
          'SHOWTRAK_TOGGLE_CRITICAL_USB',
          'SHOWTRAK_TOGGLE_CRITICAL_AUDIO',
          'SHOWTRAK_TOGGLE_CRITICAL_NETWORK',
          Iface.IsCritical ? 'is-critical' : '',
          Badge.State === 'missing' ? 'is-disconnected-critical' : '',
          Badge.State === 'issue' ? 'is-mismatch-critical' : '',
        ]
          .filter(Boolean)
          .join(' ')}" data-interface="${Token(Iface.Name)}" data-family="${Family}"
          data-critical="${Iface.IsCritical ? '1' : '0'}" title="${Badge.Title}" aria-label="${Badge.Title}">
          <i class="bi ${Badge.Icon}"></i>
          <span>${Badge.Label}</span>
        </button>`;
  return `
    <div class="rounded-3 p-2 bg-ghost SHOWTRAK_AUDIO_CARD SHOWTRAK_NET_CARD" data-interface="${Token(Iface.Name)}">
      <div class="SHOWTRAK_AUDIO_CARD_HEADER">
        <div class="SHOWTRAK_AUDIO_TITLE text-start">
          <h6 class="mb-0 SHOWTRAK_NET_ADDRESS">${Safe(Title)}</h6>
          ${Extra.map(
            (Line) =>
              `<small class="SHOWTRAK_NET_ADDRESS d-block mb-0 text-start">${Safe(Line)}</small>`
          ).join('')}
          <small class="text-light d-block mb-0 text-start">${Safe(Summary)}</small>
        </div>
        ${Toggle}
      </div>
      ${(Home ? Iface.Issues : [])
        .map(
          (Issue) =>
            `<small class="d-block mt-1 text-start st-condition-failing"><i class="bi bi-exclamation-triangle-fill me-1"></i>${Safe(Issue.Message)}</small>`
        )
        .join('')}
      ${Home ? ConditionsTable(Iface, Capabilities) : ''}
    </div>`;
}

/** One family's section markup for a client. Pure: a function of the client alone. */
export function BuildNetworkSectionHtml(
  Client: ClientView,
  State: NetworkSectionState,
  Family: NetworkFamily
): string {
  const Html: string[] = [];
  if (State !== 'ok') {
    const Message = NetworkSectionMessage(State, Family);
    Html.push(MessageCard(Message.Title, Message.Body));
  }
  const Interfaces = InterfacesFor(Client, Family);
  if (State === 'ok' && !Interfaces.length) {
    Html.push(
      MessageCard(`No ${NetworkFamilyTitle(Family)}`, `This client reports no ${Family} addresses.`)
    );
  }
  const Capabilities = Client.NetworkStatus?.Capabilities ?? null;
  for (const Iface of Interfaces) Html.push(InterfaceCard(Iface, Capabilities, Family));
  return Html.join('');
}

/** Render both sections, each rebuilt only when what it shows changes. */
export function RenderClientInfoNetwork(Client: ClientView): void {
  // Never rebuild under the operator's typing; catch up when they leave the field.
  if ($(ALL_LISTS).find('input[type="text"]:focus').length) {
    Pending = Client;
    return;
  }
  Pending = null;
  const State = GetNetworkSectionState(Client);
  for (const Family of FAMILIES) {
    const $List = $(NETWORK_LISTS[Family]);
    const Key = NetworkRenderKey(Client, State, Family);
    if (($List.attr('data-render-key') || '') === Key) continue;
    $List.html(BuildNetworkSectionHtml(Client, State, Family));
    $List.attr('data-render-key', Key);
  }
}

/** Empty both sections (an SDK client has no interfaces to show). */
export function ClearClientInfoNetwork(): void {
  Pending = null;
  $(ALL_LISTS).attr('data-render-key', '').html('');
}

/** Read a conditions table back into a request and save it. */
function SaveConditions(
  $Table: JQuery,
  UUID: string,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): Promise<void> {
  const Name = decodeURIComponent(String($Table.attr('data-interface') || ''));
  const Checked = (Field: string) =>
    $Table.find(`input[type="checkbox"][data-rule="${Field}"]`).is(':checked');
  const Value = (Field: string, Rule = Field) =>
    Checked(Field)
      ? String($Table.find(`input[type="text"][data-rule="${Rule}"]`).val() ?? '')
      : '';
  const Parsed = ParseNetworkRuleFields(Name, {
    Address: Value('Address'),
    RangeStart: Value('Range', 'RangeStart'),
    RangeEnd: Value('Range', 'RangeEnd'),
    Netmask: Value('Netmask'),
    Gateway: Value('Gateway'),
  });
  const Previous = SaveChains.get(Name) || Promise.resolve();
  const Next = Previous.then(async () => {
    try {
      if ('Error' in Parsed) {
        Notify(Parsed.Error, 'error');
      } else {
        const [Err] = await window.API.MarkClientNetworkInterfaceCritical(UUID, Parsed.Payload);
        // A later edit is already queued: its refresh shows the final state.
        if (!Err) return void (SaveChains.get(Name) === Next && (await Refresh()));
        Notify(String(Err), 'error');
      }
      // Put back what is really saved.
      $(ALL_LISTS).attr('data-render-key', '');
      await Refresh();
    } catch (err) {
      HandleNonFatalError('ClientInfo:SaveNetworkConditions', err);
    }
  });
  SaveChains.set(Name, Next);
  void Next.finally(() => {
    if (SaveChains.get(Name) === Next) SaveChains.delete(Name);
  });
  return Next;
}

/** Wire the section's controls. `Refresh` re-fetches and re-renders the client. */
export function BindClientInfoNetworkHandlers(
  GetUUID: () => string | null,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): void {
  $(ALL_LISTS)
    .off('.client-network')
    .on('click.client-network', '.SHOWTRAK_TOGGLE_CRITICAL_NETWORK', async function () {
      try {
        const UUID = GetUUID();
        const Name = decodeURIComponent(String($(this).attr('data-interface') || ''));
        if (!UUID || !Name) return;
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        // Marked under the list it was marked from, so it stays in that list.
        const Family = $(this).attr('data-family') === 'IPv6' ? 'IPv6' : 'IPv4';
        const [Err] = IsCritical
          ? await window.API.RemoveClientNetworkInterfaceCritical(UUID, Name)
          : await window.API.MarkClientNetworkInterfaceCritical(UUID, { Name, Family });
        if (Err) return void Notify(String(Err), 'error');
        await Notify(
          IsCritical
            ? 'Network interface no longer monitored.'
            : 'Network interface is now monitored.',
          'success',
          1400
        );
        await Refresh();
      } catch (err) {
        HandleNonFatalError('ClientInfo:ToggleCriticalNetwork', err);
      }
    })
    // Conditions save as they change: a tick, or a value once typed.
    .on('change.client-network', '.SHOWTRAK_NET_CONDITIONS input', function () {
      const UUID = GetUUID();
      const $Input = $(this);
      const $Table = $Input.closest('.SHOWTRAK_NET_CONDITIONS');
      if (!UUID || !$Table.length) return;
      const $Row = $Input.closest('[data-cond]');
      const $Fields = $Row.find('input[type="text"]');
      if ($Fields.length) {
        if ($Input.attr('type') === 'checkbox') {
          // Ticking a row with nothing typed starts from what the interface has now.
          if (!$Input.is(':checked')) $Fields.val('');
          else {
            $Fields.each(function () {
              if (!String($(this).val() ?? '').trim()) {
                $(this).val(String($(this).attr('data-default') || ''));
              }
            });
          }
        } else {
          // Typing a value monitors it; clearing every field of the row stops.
          const Typed = $Fields.toArray().some((Field) => String($(Field).val() ?? '').trim());
          $Row.find('input[type="checkbox"]').prop('checked', Typed);
        }
      }
      return SaveConditions($Table, UUID, Refresh, Notify);
    })
    // Enter commits a typed value, as leaving the field does.
    .on('keydown.client-network', '.SHOWTRAK_NET_CONDITIONS input[type="text"]', function (Event) {
      if (Event.key === 'Enter') $(this).trigger('blur');
    })
    .on('focusout.client-network', '.SHOWTRAK_NET_CONDITIONS input[type="text"]', function () {
      // Apply a rebuild that was held back while this field had focus — after
      // the `change` that fires first has had its chance to save.
      setTimeout(() => {
        if (!Pending || $(ALL_LISTS).find('input[type="text"]:focus').length) return;
        RenderClientInfoNetwork(Pending);
      }, 0);
    });
}

export const _internal = { SaveChains };
