// FreeKiosk terminals (renderer): tiles and the shared metric lookup.
//
// A terminal renders inline in its group's drop zone alongside real clients,
// monitoring targets and dummies, on the same weight scale, so a drag can
// interleave all four. Where a real client shows its version, a terminal shows
// the literal label "KIOSK".
//
// Where a real client draws CPU and RAM as a pair of progress bars, a terminal
// draws battery and brightness in the same two bars: those are the two readings
// that tell an operator at a glance whether a tablet on a wall is about to
// become a problem, and keeping the shape identical means one scan reads both.
import type {
  FreeKioskDisplayMode,
  FreeKioskMetricView,
  FreeKioskTerminalView,
} from '@showtrak/protocol';
import { OfflineBadgeContent } from './lib/status-badges';
import {
  AppMode,
  FreeKioskMetricCatalogCache,
  Tags,
  setFreeKioskCommandsCache,
  setFreeKioskMetricCatalogCache,
} from './state';
import { ResolveEntityTags } from './lib/tag-badges';
import { RenderTagBadgeRow } from './lib/tag-badge-view';
import { Safe } from './utils';
import { FormatMetricCompact } from './lib/metric-format';

export const FREEKIOSK_TYPE_LABEL = 'KIOSK';

/** Selection / drag key. Mirrors the tile's data-uuid exactly. */
export function FreeKioskScopedID(UUID: string): string {
  return `kiosk:${UUID}`;
}

/**
 * Settings key for a section's monitoring switch.
 *
 * Mirrors GroupFieldKey in src/Modules/FreeKiosk/metrics — the renderer's
 * tsconfig rootDir is src/UI, so it cannot import the server's copy. The rule is
 * two lines and the server remains the authority: it force-disables the alarms
 * regardless of what this decides to draw.
 */
export function FreeKioskGroupFieldKey(Section: string): string {
  return `G_${Section}_On`;
}

/** Absent reads as enabled, matching the server: a pre-groups show file has no keys. */
export function IsFreeKioskGroupEnabled(Settings: unknown, Section: string): boolean {
  const Group = (FreeKioskMetricCatalogCache?.Groups || []).find((G) => G.Key === Section);
  if (Group && Group.Fixed) return true;
  const Source = (Settings && typeof Settings === 'object' ? Settings : {}) as Record<
    string,
    unknown
  >;
  const Stored = Source[FreeKioskGroupFieldKey(Section)];
  if (Stored === undefined || Stored === null || Stored === '') return true;
  if (typeof Stored === 'boolean') return Stored;
  const Text = String(Stored).trim().toLowerCase();
  return !(Text === 'false' || Text === '0' || Text === 'no');
}

/**
 * The terminal's declared display mode.
 *
 * Mirrors GetDisplayMode in src/Modules/FreeKiosk/metrics, for the same reason
 * the group rule is mirrored. Absent reads as WebView, which is what every
 * terminal configured before this existed was implicitly treated as.
 */
export function GetFreeKioskDisplayMode(Settings: unknown): FreeKioskDisplayMode {
  const Source = (Settings && typeof Settings === 'object' ? Settings : {}) as Record<
    string,
    unknown
  >;
  const Stored = String(Source.DisplayMode ?? '').trim();
  return Stored === 'external_app' || Stored === 'media_player' || Stored === 'webview'
    ? Stored
    : 'webview';
}

/**
 * Does this reading mean anything in the mode the terminal is in?
 *
 * FreeKiosk retains `webview.currentUrl` from the last page it loaded and never
 * clears it, so on a terminal locked to an external app it reports a URL that is
 * not on screen and cannot be distinguished from a live one by looking at it.
 */
export function IsFreeKioskMetricInMode(
  Settings: unknown,
  Metric: Pick<FreeKioskMetricView, 'RequiresMode'>
): boolean {
  if (!Metric.RequiresMode || !Metric.RequiresMode.length) return true;
  return Metric.RequiresMode.includes(GetFreeKioskDisplayMode(Settings));
}

export function GetFreeKioskMetric(Key: string): FreeKioskMetricView | null {
  const Catalogue = FreeKioskMetricCatalogCache;
  if (!Catalogue) return null;
  return Catalogue.Metrics.find((Metric) => Metric.Key === Key) || null;
}

/**
 * Fetch the server-declared registry and command map once per session.
 *
 * Both are static for the life of the process, and every FreeKiosk surface
 * (tile, editor, view modal, context menu) needs them, so they are pulled up
 * front rather than per-render.
 */
export async function LoadFreeKioskCatalogues(): Promise<void> {
  try {
    const [Catalogue, Commands] = await Promise.all([
      window.API.GetFreeKioskMetrics(),
      window.API.GetFreeKioskCommands(),
    ]);
    if (Catalogue && Array.isArray(Catalogue.Metrics)) setFreeKioskMetricCatalogCache(Catalogue);
    if (Array.isArray(Commands)) setFreeKioskCommandsCache(Commands);
  } catch {
    // A failed fetch leaves the caches empty; tiles still render, and the
    // editor reports that it could not load its settings rather than throwing.
  }
}

/** The compact-mode status shown to the right of the terminal's name. */
export function FreeKioskCompactStatus(K: FreeKioskTerminalView) {
  const State = String(K.State || 'IDLE');
  if (State === 'OFFLINE') return { text: '', color: 'text-light', offline: true };
  if (State === 'DEGRADED') {
    const Warning =
      Array.isArray(K.DegradedWarnings) && K.DegradedWarnings.length
        ? String(K.DegradedWarnings[0])
        : 'Alarm';
    return { text: Warning, color: 'text-warning', offline: false };
  }
  if (State === 'ONLINE') return { text: 'Online', color: 'text-light', offline: false };
  return { text: 'Idle', color: 'text-light', offline: false };
}

/** A 0–100 reading as a bar width. No reading draws an empty bar, never a full one. */
function BarPercent(Value: unknown): number {
  const Numeric = Number(Value);
  if (!Number.isFinite(Numeric)) return 0;
  return Math.min(100, Math.max(0, Math.round(Numeric)));
}

/** Battery / brightness, as the tooltip on each bar. */
function BarTitle(K: FreeKioskTerminalView): { battery: string; brightness: string } {
  const Metrics = K.Metrics || {};
  const Battery = FormatMetricCompact(GetFreeKioskMetric('battery_level'), Metrics.battery_level);
  const Brightness = FormatMetricCompact(
    GetFreeKioskMetric('screen_brightness'),
    Metrics.screen_brightness
  );
  return {
    battery: `Battery ${Battery}${Metrics.battery_charging === true ? ' (charging)' : ''}`,
    brightness: `Brightness ${Brightness}`,
  };
}

/**
 * The battery / brightness pair shown under the name.
 *
 * Deliberately the same two-bar `.progress` stack a real client uses for CPU and
 * RAM. An operator scanning a wall of tiles reads bar length, not text, and a
 * terminal that renders its vitals differently from the client beside it breaks
 * that scan. The numbers stay available as the bars' tooltips.
 */
export function FreeKioskVitalsBars(K: FreeKioskTerminalView): string {
  const Metrics = K.Metrics || {};
  const Titles = BarTitle(K);
  return (
    `<div class="progress" title="${Safe(Titles.battery)}">` +
    `<div data-type="BATTERY" class="progress-bar bg-white" role="progressbar" style="width: ${BarPercent(
      Metrics.battery_level
    )}%;"></div>` +
    `</div>` +
    `<div class="progress" title="${Safe(Titles.brightness)}">` +
    `<div data-type="BRIGHTNESS" class="progress-bar bg-white" role="progressbar" style="width: ${BarPercent(
      Metrics.screen_brightness
    )}%;"></div>` +
    `</div>`
  );
}

function TileStateClass(K: FreeKioskTerminalView): string {
  const State = String(K.State || 'IDLE');
  if (State === 'DEGRADED') return 'DEGRADED';
  if (State === 'ONLINE') return 'ONLINE';
  if (State === 'IDLE') return 'IDLE';
  return '';
}

function WarningText(K: FreeKioskTerminalView): string {
  return Array.isArray(K.DegradedWarnings) && K.DegradedWarnings.length
    ? String(K.DegradedWarnings[0])
    : 'Alarm';
}

/** Address line: the host, plus the port when it is not the default. */
export function FreeKioskDisplayAddress(K: FreeKioskTerminalView): string {
  const Address = String(K.Address || '').trim() || 'No address';
  const Port = Number(K.Port) || 8080;
  return Port === 8080 ? Address : `${Address}:${Port}`;
}

export function RenderFreeKioskTile(K: FreeKioskTerminalView): string {
  const State = String(K.State || 'IDLE');
  const DragUUID = FreeKioskScopedID(K.UUID);
  const Compact = FreeKioskCompactStatus(K);
  // Scoped by its bare UUID: the `kiosk:` prefix above is a drag/selection key,
  // not a scope id — the scope picker stores bare UUIDs for every client-like
  // entity, exactly as it does for dummies.
  const TagBadges = RenderTagBadgeRow(
    ResolveEntityTags(Tags, { ScopedID: String(K.UUID), GroupID: K.GroupID ?? null })
  );

  return `
    <div id="FREEKIOSK_TILE_${K.UUID}" class="SHOWTRAK_PC FREEKIOSK ${TileStateClass(
      K
    )}" data-kiosk-uuid="${K.UUID}" data-uuid="${DragUUID}" data-flip-key="${DragUUID}" draggable="${
      AppMode === 'EDIT' ? 'true' : 'false'
    }">
      <button type="button" class="CLIENT_TILE_COG FREEKIOSK_TILE_COG" aria-label="Edit FreeKiosk Terminal" title="Edit FreeKiosk Terminal">
        <i class="bi bi-gear-fill"></i>
      </button>
      <label class="text-sm ${
        TagBadges ? 'd-none' : ''
      }" data-type="FreeKioskLabel">${FREEKIOSK_TYPE_LABEL}</label>
      ${TagBadges}
      <h5 class="mb-0" data-type="Name">${Safe(K.Nickname || K.Address || 'FreeKiosk')}</h5>
      <span class="CLIENT_TILE_COMPACT_STATUS FREEKIOSK_COMPACT_STATUS ${Compact.color}${
        Compact.offline ? ' d-none' : ''
      }" data-type="FREEKIOSK_COMPACT_STATUS">${Safe(Compact.text)}</span>
      <small class="text-sm text-light" data-type="IP">${Safe(FreeKioskDisplayAddress(K))}</small>
      <div class="SHOWTRAK_PC_STATUS ${
        State === 'IDLE' ? 'd-grid' : 'd-none'
      }" data-type="INDICATOR_IDLE">
        <h7 class="mb-0 text-light">Waiting for first poll</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${
        State === 'ONLINE' ? 'd-grid' : 'd-none'
      } gap-2" data-type="INDICATOR_ONLINE">
        ${FreeKioskVitalsBars(K)}
      </div>
      <div class="SHOWTRAK_PC_STATUS ${
        State === 'DEGRADED' ? 'd-grid' : 'd-none'
      }" data-type="INDICATOR_DEGRADED">
        <h7 class="mb-0 text-warning" data-type="DEGRADED_WARNING">${Safe(WarningText(K))}</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${
        State === 'OFFLINE' ? 'd-grid' : 'd-none'
      }" data-type="INDICATOR_OFFLINE">
        <h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${K.LastSuccessAt || ''}">
          ${OfflineBadgeContent()}
        </h7>
      </div>
    </div>`;
}

/** In-place patch, so a poll does not rebuild the whole list. */
export function UpdateFreeKioskTile(K: FreeKioskTerminalView): void {
  const $tile = $(`#FREEKIOSK_TILE_${K.UUID}`);
  if (!$tile.length) return;
  const State = String(K.State || 'IDLE');

  $tile.toggleClass('ONLINE', State === 'ONLINE');
  $tile.toggleClass('DEGRADED', State === 'DEGRADED');
  $tile.toggleClass('IDLE', State === 'IDLE');
  $tile.find('[data-type="Name"]').text(K.Nickname || K.Address || 'FreeKiosk');
  $tile.find('[data-type="IP"]').text(FreeKioskDisplayAddress(K));
  $tile.find('[data-type="DEGRADED_WARNING"]').text(WarningText(K));

  // The bars are patched in place rather than re-rendered, so their width
  // transition runs instead of restarting from scratch on every poll.
  const Metrics = K.Metrics || {};
  const Titles = BarTitle(K);
  const $Bars = $tile
    .find('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_ONLINE"]')
    .children('.progress');
  $Bars
    .children('[data-type="BATTERY"]')
    .css('width', `${BarPercent(Metrics.battery_level)}%`)
    .parent()
    .attr('title', Titles.battery);
  $Bars
    .children('[data-type="BRIGHTNESS"]')
    .css('width', `${BarPercent(Metrics.screen_brightness)}%`)
    .parent()
    .attr('title', Titles.brightness);

  const Compact = FreeKioskCompactStatus(K);
  $tile
    .find('[data-type="FREEKIOSK_COMPACT_STATUS"]')
    .text(Compact.text)
    .removeClass('text-light text-success text-warning')
    .addClass(Compact.color)
    .toggleClass('d-none', Compact.offline);

  const ToggleIndicator = (Type: string, Show: boolean) => {
    $tile
      .find(`.SHOWTRAK_PC_STATUS[data-type="${Type}"]`)
      .toggleClass('d-grid', Show)
      .toggleClass('d-none', !Show);
  };
  ToggleIndicator('INDICATOR_IDLE', State === 'IDLE');
  ToggleIndicator('INDICATOR_ONLINE', State === 'ONLINE');
  ToggleIndicator('INDICATOR_DEGRADED', State === 'DEGRADED');
  ToggleIndicator('INDICATOR_OFFLINE', State === 'OFFLINE');
  $tile.find('[data-type="OFFLINE_SINCE"]').attr('data-offlinesince', K.LastSuccessAt || '');
}
