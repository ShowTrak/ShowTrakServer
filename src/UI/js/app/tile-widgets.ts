// Monitor tile widgets: a custom footer on a monitor's dashboard tile, drawn by
// the check type, in place of the latency line (see lib/tile-widgets.ts).
//
// Each widget kind has a drawer: the row's markup, and a patch that runs on every
// monitor push and whenever its own data arrives. The footer row is always in the
// tile and its contents are redrawn only when the kind changes, so bars keep
// their CSS width transition the way client CPU/RAM bars do.
//
// 'levels' is fed by the server's tile meter stream. That stream can hold a
// device's only control connection, so it is open only while some tile on this
// dashboard needs it and the page is visible.
import type {
  MonitoringTargetView,
  MonitorTileLevels,
  MonitorTileLevelsSnapshot,
} from '@showtrak/protocol';
import { MonitoringTargets } from './state';
import { ShowsTileWidget, TileLevelsView, TileWidgetKind } from './lib/tile-widgets';
import type { PeakState } from './lib/live-levels';
import { HandleNonFatalError } from './utils';

interface TileWidgetDrawer {
  /** The row's inner markup for a freshly drawn widget. */
  Html(T: MonitoringTargetView): string;
  /** Bring the drawn widget up to date. */
  Patch(Row: HTMLElement, T: MonitoringTargetView): void;
}

// --- 'levels' -----------------------------------------------------------------

const TileLevels = new Map<number, MonitorTileLevels>();
// TargetID → each bar's peak-hold state.
const TilePeaks = new Map<number, Map<number, PeakState>>();
let TileStreamOpen = false;
let TileUnsubscribe: (() => void) | null = null;

const LevelsDrawer: TileWidgetDrawer = {
  Html: () =>
    '<div class="MONITOR_TILE_LEVELS"></div><h7 class="mb-0 text-light MONITOR_TILE_WIDGET_TEXT"></h7>',
  Patch: (Row, T) => {
    const ID = Number(T.TargetID);
    if (!TilePeaks.has(ID)) TilePeaks.set(ID, new Map());
    const View = TileLevelsView(TileLevels.get(ID), TilePeaks.get(ID), performance.now());
    const Bars = Row.querySelector<HTMLElement>('.MONITOR_TILE_LEVELS');
    const Text = Row.querySelector<HTMLElement>('.MONITOR_TILE_WIDGET_TEXT');
    if (!Bars || !Text) return;
    Text.textContent = View.Text || '';
    Text.hidden = !View.Text;
    Bars.hidden = !!View.Text;
    if (View.Text) return;
    // Keep the row elements across frames so the width transition runs.
    while (Bars.childElementCount > View.Bars.length) Bars.lastElementChild!.remove();
    while (Bars.childElementCount < View.Bars.length) {
      const Line = document.createElement('span');
      Line.className = 'MONITOR_TILE_LEVEL_ROW';
      Line.innerHTML =
        '<span class="MONITOR_TILE_LEVEL_LABEL"></span>' +
        '<span class="MONITOR_TILE_LEVEL"><span class="MONITOR_TILE_LEVEL_FILL"></span>' +
        '<span class="MONITOR_TILE_LEVEL_PEAK"></span></span>';
      Bars.appendChild(Line);
    }
    Bars.dataset.count = String(View.Bars.length);
    View.Bars.forEach((Bar, Index) => {
      const Line = Bars.children[Index] as HTMLElement;
      const Label = Line.querySelector<HTMLElement>('.MONITOR_TILE_LEVEL_LABEL')!;
      const Fill = Line.querySelector<HTMLElement>('.MONITOR_TILE_LEVEL_FILL')!;
      const Peak = Line.querySelector<HTMLElement>('.MONITOR_TILE_LEVEL_PEAK')!;
      if (Label.textContent !== Bar.Label) Label.textContent = Bar.Label;
      Fill.style.width = `${Bar.Percent}%`;
      Fill.dataset.zone = Bar.Zone;
      Peak.style.left = `${Bar.PeakPercent}%`;
      Peak.dataset.zone = Bar.PeakZone;
      Peak.hidden = Bar.PeakPercent <= 0;
      // The row has no box of its own (display: contents), so each part carries
      // the tooltip.
      Label.title = Bar.Title;
      (Fill.parentElement as HTMLElement).title = Bar.Title;
    });
  },
};

// --- Registry -------------------------------------------------------------------

const Drawers: Record<string, TileWidgetDrawer> = {
  levels: LevelsDrawer,
};

/** The footer row a monitor tile carries for its widget (hidden when it has none). */
export function TileWidgetRowHtml(T: MonitoringTargetView): string {
  const Kind = TileWidgetKind(T);
  const Drawer = Drawers[Kind];
  const Show = !!Drawer && ShowsTileWidget(T);
  return `<div class="SHOWTRAK_PC_STATUS MONITOR_TILE_WIDGET ${Show ? 'd-grid' : 'd-none'}" data-type="MONITOR_WIDGET" data-kind="${
    Drawer ? Kind : ''
  }">${Drawer ? Drawer.Html(T) : ''}</div>`;
}

/** Whether the widget row is showing in place of the latency line. */
export function TileWidgetShowing(T: MonitoringTargetView): boolean {
  return !!Drawers[TileWidgetKind(T)] && ShowsTileWidget(T);
}

/** Bring a tile's widget row up to date after a push (or a fresh render). */
export function UpdateTileWidget(T: MonitoringTargetView): void {
  const Row = document.querySelector<HTMLElement>(
    `#MONITOR_TILE_${Number(T.TargetID)} > [data-type="MONITOR_WIDGET"]`
  );
  if (!Row) return;
  const Kind = TileWidgetKind(T);
  const Drawer = Drawers[Kind];
  if ((Row.dataset.kind || '') !== (Drawer ? Kind : '')) {
    Row.dataset.kind = Drawer ? Kind : '';
    Row.innerHTML = Drawer ? Drawer.Html(T) : '';
  }
  const Show = !!Drawer && ShowsTileWidget(T);
  Row.classList.toggle('d-grid', Show);
  Row.classList.toggle('d-none', !Show);
  // Lets the grid tile give the widget the address line's room as well.
  Row.parentElement?.classList.toggle('HAS_TILE_WIDGET', Show);
  if (Drawer) {
    try {
      Drawer.Patch(Row, T);
    } catch (Err) {
      HandleNonFatalError(`TileWidget:${Kind}`, Err);
    }
  }
}

function OnTileSnapshot(Snapshot: MonitorTileLevelsSnapshot | null): void {
  if (!Snapshot || !TileStreamOpen) return;
  TileLevels.clear();
  for (const Tile of Snapshot.Tiles || []) TileLevels.set(Number(Tile.TargetID), Tile);
  for (const ID of TilePeaks.keys()) if (!TileLevels.has(ID)) TilePeaks.delete(ID);
  for (const T of MonitoringTargets) {
    if (TileWidgetKind(T) === 'levels') UpdateTileWidget(T);
  }
}

/**
 * Open the tile meter stream while some tile needs it and the page is visible,
 * and close it otherwise. Cheap; call after any render or push.
 */
export function SyncTileWidgetStreams(): void {
  const Wanted = !document.hidden && MonitoringTargets.some((T) => TileWidgetKind(T) === 'levels');
  if (Wanted === TileStreamOpen) return;
  TileStreamOpen = Wanted;
  if (Wanted) {
    if (!TileUnsubscribe) TileUnsubscribe = window.API.OnMonitorTileLevels(OnTileSnapshot);
    window.API.OpenMonitorTileLevels()
      .then(OnTileSnapshot)
      .catch((Err: unknown) => HandleNonFatalError('MonitorTileLevels:Open', Err));
    return;
  }
  if (TileUnsubscribe) TileUnsubscribe();
  TileUnsubscribe = null;
  TileLevels.clear();
  TilePeaks.clear();
  window.API.CloseMonitorTileLevels().catch((Err: unknown) =>
    HandleNonFatalError('MonitorTileLevels:Close', Err)
  );
}

/** After a full dashboard render: fill every widget and settle the streams. */
export function SyncTileWidgets(): void {
  for (const T of MonitoringTargets) UpdateTileWidget(T);
  SyncTileWidgetStreams();
}

// A hidden window (minimised, another tab) does not need meters, and the stream
// may be holding a device's only control connection.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    try {
      SyncTileWidgetStreams();
    } catch (Err) {
      HandleNonFatalError('TileWidget:visibilitychange', Err);
    }
  });
}
