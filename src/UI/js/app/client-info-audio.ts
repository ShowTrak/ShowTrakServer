// Audio Inputs and Audio Outputs sections of the client info modal: the markup,
// the in-place level patch, and the handlers for marking critical, editing
// conditions, and changing a level or mute on the client machine. Each direction
// is its own section, built by the same code. The decisions live in
// lib/audio-devices.
import { CreateConditionSaveQueue } from './lib/condition-save-queue';
import type {
  AudioCapabilities,
  AudioDirection,
  AudioEndpointView,
  ClientView,
} from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import {
  AudioConditionRows,
  AudioDirectionTitle,
  AudioEndpointBadge,
  AudioEndpointSummary,
  AudioRenderKey,
  AudioSectionMessage,
  CanControlAudio,
  EndpointsFor,
  GetAudioSectionState,
  ParseAudioRuleFields,
  ParseLevelInput,
  type AudioConditionRow,
  type AudioSectionState,
} from './lib/audio-devices';

/** The list element of each direction's section. */
export const AUDIO_LISTS: Record<AudioDirection, string> = {
  input: '#SHOWTRAK_CLIENT_INFO_AUDIO_INPUTS',
  output: '#SHOWTRAK_CLIENT_INFO_AUDIO_OUTPUTS',
};
const DIRECTIONS: AudioDirection[] = ['input', 'output'];

// Saves of each endpoint's conditions, chained so two quick ticks reach the
// server in the order they were made.
const Saves = CreateConditionSaveQueue();

const Token = (EndpointID: string) => encodeURIComponent(EndpointID);

function MessageCard(Title: string, Body: string, Tone: 'ghost' | 'danger' = 'ghost'): string {
  const Classes =
    Tone === 'danger'
      ? 'rounded-3 p-2 bg-danger bg-opacity-25 border border-danger-subtle'
      : 'rounded-3 p-2 bg-ghost';
  return `
    <div class="${Classes}">
      <h6 class="mb-0">${Safe(Title)}</h6>
      <p class="text-sm mb-0">${Safe(Body)}</p>
    </div>`;
}

function LevelRow(Endpoint: AudioEndpointView, Capabilities: AudioCapabilities | null): string {
  const Id = Token(Endpoint.EndpointID);
  const Parts: string[] = [];
  if (CanControlAudio(Endpoint, Capabilities, 'Mute') && Endpoint.Muted !== null) {
    const Muted = Endpoint.Muted === true;
    Parts.push(`
      <button type="button" class="SHOWTRAK_AUDIO_MUTE ${Muted ? 'is-muted' : ''}" data-endpoint="${Id}"
        data-muted="${Muted ? '1' : '0'}" title="${Muted ? 'Unmute' : 'Mute'}" aria-label="${Muted ? 'Unmute' : 'Mute'}">
        <i class="bi ${Muted ? 'bi-volume-mute-fill' : 'bi-volume-up-fill'}"></i>
      </button>`);
  }
  if (CanControlAudio(Endpoint, Capabilities, 'Volume') && Endpoint.Volume !== null) {
    const Level = Math.max(0, Math.min(100, Endpoint.Volume));
    Parts.push(`
      <input type="range" class="form-range SHOWTRAK_AUDIO_LEVEL" min="0" max="100" step="1"
        value="${Level}" data-endpoint="${Id}" aria-label="${Safe(Endpoint.Name)} level" />
      <span class="SHOWTRAK_AUDIO_LEVEL_VALUE" data-endpoint="${Id}">${Endpoint.Volume}%</span>`);
  }
  return Parts.length ? `<div class="SHOWTRAK_AUDIO_LEVEL_ROW">${Parts.join('')}</div>` : '';
}

function ConditionCell(Row: AudioConditionRow, Endpoint: AudioEndpointView): string {
  if (!Row.Supported) return `<span class="SHOWTRAK_AUDIO_COND_VALUE">Unsupported</span>`;
  if (Row.Field === 'MinVolume' || Row.Field === 'MaxVolume') {
    return `
      <span class="SHOWTRAK_AUDIO_COND_BOUND">
        <input type="number" min="0" max="100" step="1" data-rule="${Row.Field}"
          value="${Row.Bound ?? ''}" placeholder="${Endpoint.Volume ?? ''}"
          data-current="${Endpoint.Volume ?? ''}" aria-label="${Safe(Row.Label)}" />
        <span>%</span>
      </span>`;
  }
  return `<span class="SHOWTRAK_AUDIO_COND_VALUE">${Safe(Row.Value)}</span>`;
}

/** A critical endpoint's conditions: key, value, and a tick to monitor it. Saves as it changes. */
function ConditionsTable(
  Endpoint: AudioEndpointView,
  Capabilities: AudioCapabilities | null
): string {
  const Rows = AudioConditionRows(Endpoint, Capabilities);
  if (!Rows.length) return '';
  return `
    <table class="SHOWTRAK_AUDIO_CONDITIONS" data-endpoint="${Token(Endpoint.EndpointID)}">
      <tbody>
        ${Rows.map(
          (Row) => `
          <tr data-cond="${Row.Field}" class="${Row.Supported ? '' : 'is-unsupported'} ${Row.Failing ? 'is-failing' : ''}"
            ${Row.Failing ? `title="${Safe(Row.Failing)}"` : ''}>
            <th scope="row">${Safe(Row.Label)}</th>
            <td>${ConditionCell(Row, Endpoint)}</td>
            <td class="SHOWTRAK_AUDIO_COND_CHECK">${
              Row.Supported
                ? `<input type="checkbox" class="form-check-input" data-rule="${Row.Field}"
                    ${Row.Checked ? 'checked' : ''} aria-label="Monitor ${Safe(Row.Label.toLowerCase())}" />`
                : ''
            }</td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`;
}

function EndpointCard(Endpoint: AudioEndpointView, Capabilities: AudioCapabilities | null): string {
  const Badge = AudioEndpointBadge(Endpoint);
  const Summary = Endpoint.IsConnected
    ? AudioEndpointSummary(Endpoint)
    : Endpoint.Missing
      ? 'Not connected'
      : 'Not reported yet';
  const ToggleClasses = [
    'SHOWTRAK_TOGGLE_CRITICAL_USB',
    'SHOWTRAK_TOGGLE_CRITICAL_AUDIO',
    Endpoint.IsCritical ? 'is-critical' : '',
    Badge.State === 'missing' ? 'is-disconnected-critical' : '',
    Badge.State === 'issue' ? 'is-mismatch-critical' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <div class="rounded-3 p-2 bg-ghost SHOWTRAK_AUDIO_CARD" data-endpoint="${Token(Endpoint.EndpointID)}">
      <div class="SHOWTRAK_AUDIO_CARD_HEADER">
        <div class="SHOWTRAK_AUDIO_TITLE text-start">
          <h6 class="mb-0">${Safe(Endpoint.Name)}${
            Endpoint.IsDefault ? ' <span class="SHOWTRAK_AUDIO_DEFAULT_BADGE">Default</span>' : ''
          }</h6>
          ${Summary ? `<small class="text-light d-block mb-0 text-start">${Safe(Summary)}</small>` : ''}
        </div>
        <button type="button" class="${ToggleClasses}" data-endpoint="${Token(Endpoint.EndpointID)}"
          data-critical="${Endpoint.IsCritical ? '1' : '0'}" title="${Badge.Title}" aria-label="${Badge.Title}">
          <i class="bi ${Badge.Icon}"></i>
          <span>${Badge.Label}</span>
        </button>
      </div>
      ${Endpoint.Issues.map(
        (Issue) =>
          `<small class="d-block mt-1 text-start st-condition-failing"><i class="bi bi-exclamation-triangle-fill me-1"></i>${Safe(Issue.Message)}</small>`
      ).join('')}
      ${LevelRow(Endpoint, Capabilities)}
      ${ConditionsTable(Endpoint, Capabilities)}
    </div>`;
}

/** One direction's section markup for a client. Pure: a function of the client alone. */
export function BuildAudioSectionHtml(
  Client: ClientView,
  State: AudioSectionState,
  Direction: AudioDirection
): string {
  if (State === 'outdated' || State === 'waiting' || State === 'unsupported') {
    const Message = AudioSectionMessage(State, Client, Direction);
    return MessageCard(Message.Title, Message.Body);
  }
  const View = Client.AudioDevices;
  const Html: string[] = [];
  if (State === 'error' || State === 'offline') {
    const Message = AudioSectionMessage(State, Client, Direction);
    Html.push(MessageCard(Message.Title, Message.Body, State === 'error' ? 'danger' : 'ghost'));
  }
  const Endpoints = EndpointsFor(View ? View.Endpoints : [], Direction);
  const Capabilities = View ? View.Capabilities : null;
  if (State === 'ok' && !Endpoints.length) {
    const Title = AudioDirectionTitle(Direction);
    Html.push(MessageCard(`No ${Title}`, `This client reports no audio ${Direction}s.`));
  }
  // Offline/error clients carry just their critical baselines, listed under the
  // message; nothing at all when this direction has none.
  for (const Endpoint of Endpoints) Html.push(EndpointCard(Endpoint, Capabilities));
  return Html.join('');
}

/**
 * Patch levels and mute buttons in place. Skips a slider the operator is holding:
 * its value is theirs until they let go, and the `change` that follows sends it.
 */
export function PatchAudioLevels($List: JQuery, Client: ClientView): void {
  const Endpoints = Client.AudioDevices?.Endpoints || [];
  for (const Endpoint of Endpoints) {
    const Id = Token(Endpoint.EndpointID);
    const $Card = $List.find(`.SHOWTRAK_AUDIO_CARD[data-endpoint="${CSS.escape(Id)}"]`);
    if (!$Card.length) continue;
    const $Slider = $Card.find('.SHOWTRAK_AUDIO_LEVEL');
    if (
      $Slider.length &&
      Endpoint.Volume !== null &&
      !$Slider.is(':focus') &&
      !$Slider.attr('data-dragging')
    ) {
      $Slider.val(String(Math.max(0, Math.min(100, Endpoint.Volume))));
      $Card.find('.SHOWTRAK_AUDIO_LEVEL_VALUE').text(`${Endpoint.Volume}%`);
    }
    const $Mute = $Card.find('.SHOWTRAK_AUDIO_MUTE');
    if ($Mute.length && Endpoint.Muted !== null) {
      const Muted = Endpoint.Muted === true;
      $Mute
        .toggleClass('is-muted', Muted)
        .attr('data-muted', Muted ? '1' : '0')
        .attr('title', Muted ? 'Unmute' : 'Mute')
        .attr('aria-label', Muted ? 'Unmute' : 'Mute');
      $Mute.find('i').attr('class', `bi ${Muted ? 'bi-volume-mute-fill' : 'bi-volume-up-fill'}`);
    }
    PatchConditions($Card, Endpoint, Client.AudioDevices?.Capabilities ?? null);
  }
}

/** Ticks, readings and level bounds, patched; a bound being typed into is left alone. */
function PatchConditions(
  $Card: JQuery,
  Endpoint: AudioEndpointView,
  Capabilities: AudioCapabilities | null
): void {
  for (const Row of AudioConditionRows(Endpoint, Capabilities)) {
    const $Row = $Card.find(`[data-cond="${Row.Field}"]`);
    if (!$Row.length) continue;
    $Row.find('input[type="checkbox"]').prop('checked', Row.Checked);
    if (Row.Field !== 'MinVolume' && Row.Field !== 'MaxVolume') {
      $Row.find('.SHOWTRAK_AUDIO_COND_VALUE').text(Row.Value);
      continue;
    }
    const $Bound = $Row.find('input[type="number"]');
    if (!$Bound.length) continue;
    $Bound
      .attr('data-current', String(Endpoint.Volume ?? ''))
      .attr('placeholder', String(Endpoint.Volume ?? ''));
    if (!$Bound.is(':focus')) $Bound.val(Row.Bound === null ? '' : String(Row.Bound));
  }
}

/** Render both sections, each rebuilt only when its own structure changes. */
export function RenderClientInfoAudio(Client: ClientView): void {
  const State = GetAudioSectionState(Client);
  for (const Direction of DIRECTIONS) {
    const $List = $(AUDIO_LISTS[Direction]);
    const Key = AudioRenderKey(Client, State, Direction);
    if (($List.attr('data-render-key') || '') !== Key) {
      $List.html(BuildAudioSectionHtml(Client, State, Direction));
      $List.attr('data-render-key', Key);
      continue;
    }
    PatchAudioLevels($List, Client);
  }
}

/** Empty both sections (an SDK client has no audio to show). */
export function ClearClientInfoAudio(): void {
  for (const Direction of DIRECTIONS) {
    $(AUDIO_LISTS[Direction]).attr('data-render-key', '').html('');
  }
}

/** Wire the section's controls. `Refresh` re-fetches and re-renders the client. */
export function BindClientInfoAudioHandlers(
  GetUUID: () => string | null,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): void {
  const $List = $(DIRECTIONS.map((Direction) => AUDIO_LISTS[Direction]).join(', '));
  const Endpoint = (Element: Element) =>
    decodeURIComponent(String($(Element).attr('data-endpoint') || ''));

  $List
    .off('.client-audio')
    .on('click.client-audio', '.SHOWTRAK_TOGGLE_CRITICAL_AUDIO', async function () {
      try {
        const UUID = GetUUID();
        const EndpointID = Endpoint(this);
        if (!UUID || !EndpointID) return;
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        const [Err] = IsCritical
          ? await window.API.RemoveClientAudioDeviceCritical(UUID, EndpointID)
          : await window.API.MarkClientAudioDeviceCritical(UUID, { EndpointID });
        if (Err) return void Notify(String(Err), 'error');
        await Notify(
          IsCritical ? 'Audio device no longer monitored.' : 'Audio device is now monitored.',
          'success',
          1400
        );
        await Refresh();
      } catch (err) {
        HandleNonFatalError('ClientInfo:ToggleCriticalAudio', err);
      }
    })
    // Conditions save as they change: a tick, or a level bound once typed.
    .on('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input', function () {
      const UUID = GetUUID();
      const $Table = $(this).closest('.SHOWTRAK_AUDIO_CONDITIONS');
      const EndpointID = decodeURIComponent(String($Table.attr('data-endpoint') || ''));
      if (!UUID || !EndpointID) return;
      const $Input = $(this);
      const Rule = String($Input.attr('data-rule') || '');
      const IsBound = Rule === 'MinVolume' || Rule === 'MaxVolume';
      if (IsBound) {
        const $Row = $Input.closest('[data-cond]');
        const $Check = $Row.find('input[type="checkbox"]');
        const $Bound = $Row.find('input[type="number"]');
        if ($Input.attr('type') === 'checkbox') {
          // Ticking a bound with nothing typed starts from the level it is at now.
          if (!$Input.is(':checked')) $Bound.val('');
          else if (!String($Bound.val() ?? '').trim()) {
            $Bound.val(String($Bound.attr('data-current') || (Rule === 'MinVolume' ? 0 : 100)));
          }
        } else {
          // Typing a bound monitors it; clearing it stops.
          $Check.prop('checked', String($Input.val() ?? '').trim() !== '');
        }
      }
      const Checked = (Field: string) =>
        $Table.find(`input[type="checkbox"][data-rule="${Field}"]`).is(':checked');
      const Bound = (Field: string) =>
        Checked(Field)
          ? String($Table.find(`input[type="number"][data-rule="${Field}"]`).val() ?? '')
          : '';
      const Parsed = ParseAudioRuleFields(EndpointID, {
        RequireDefault: Checked('RequireDefault'),
        RequireUnmuted: Checked('RequireUnmuted'),
        CheckChannels: Checked('CheckChannels'),
        CheckSampleRate: Checked('CheckSampleRate'),
        MinVolume: Bound('MinVolume'),
        MaxVolume: Bound('MaxVolume'),
      });
      return Saves.Enqueue(EndpointID, {
        Save: async () =>
          'Error' in Parsed
            ? Parsed.Error
            : (await window.API.MarkClientAudioDeviceCritical(UUID, Parsed.Payload))[0],
        Refresh,
        Notify,
        ResetRender: () => $Table.closest('[data-render-key]').attr('data-render-key', ''),
        ErrorContext: 'ClientInfo:SaveAudioConditions',
      });
    })
    .on('pointerdown.client-audio', '.SHOWTRAK_AUDIO_LEVEL', function () {
      $(this).attr('data-dragging', '1');
    })
    .on('input.client-audio', '.SHOWTRAK_AUDIO_LEVEL', function () {
      const Level = ParseLevelInput($(this).val());
      if (Level === null) return;
      $(this).siblings('.SHOWTRAK_AUDIO_LEVEL_VALUE').text(`${Level}%`);
    })
    // `change` fires once, on release — one request per gesture, not one per pixel.
    .on('change.client-audio', '.SHOWTRAK_AUDIO_LEVEL', async function () {
      const $Slider = $(this);
      $Slider.removeAttr('data-dragging');
      try {
        const UUID = GetUUID();
        const EndpointID = Endpoint(this);
        const Level = ParseLevelInput($Slider.val());
        if (!UUID || !EndpointID || Level === null) return;
        const [Err] = await window.API.SetClientAudioLevel(UUID, { EndpointID, Volume: Level });
        if (Err) {
          Notify(String(Err), 'error');
          // Let the next refresh put the real level back.
          $Slider.trigger('blur');
          await Refresh();
        }
      } catch (err) {
        HandleNonFatalError('ClientInfo:SetAudioLevel', err);
      }
    })
    .on('click.client-audio', '.SHOWTRAK_AUDIO_MUTE', async function () {
      try {
        const UUID = GetUUID();
        const EndpointID = Endpoint(this);
        if (!UUID || !EndpointID) return;
        const Muted = String($(this).attr('data-muted') || '0') === '1';
        const [Err] = await window.API.SetClientAudioLevel(UUID, { EndpointID, Muted: !Muted });
        if (Err) return void Notify(String(Err), 'error');
        await Refresh();
      } catch (err) {
        HandleNonFatalError('ClientInfo:ToggleAudioMute', err);
      }
    });
}

export const _internal = { SaveChains: Saves.Chains };
