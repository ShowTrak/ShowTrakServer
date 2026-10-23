// Monitor tile widgets — the decisions, without the DOM.
//
// A monitor whose only check offers a tile widget (MonitoringTargetView
// .TileWidget) draws it in the tile's footer row in place of the latency line,
// the way client tiles show CPU and RAM. The widget only stands in for a healthy
// status: degraded, offline and idle tiles keep their usual text, so a problem
// always reads the same way whatever the check type.
import type { MonitoringTargetView, MonitorTileLevels } from '@showtrak/protocol';
import { FormatLevel, LevelPercent, LevelZoneOf, NextPeak, type PeakState } from './live-levels';

/** Whether the tile's footer shows its widget rather than the latency line. */
export function ShowsTileWidget(T: MonitoringTargetView): boolean {
  if (!T.TileWidget || !T.TileWidget.Kind) return false;
  const NoVerdict = !T.CheckCount || T.LastChecked == null;
  return !!T.Online && !T.Degraded && !NoVerdict;
}

/** The widget's kind, or '' for none. Drawers are looked up by it. */
export function TileWidgetKind(T: MonitoringTargetView): string {
  return (T.TileWidget && T.TileWidget.Kind) || '';
}

// --- 'levels' -----------------------------------------------------------------

export interface TileLevelBar {
  Label: string;
  Percent: number;
  Zone: string;
  // The peak-hold line, as in the monitor view; 0 hides it.
  PeakPercent: number;
  PeakZone: string;
  Title: string;
}

/**
 * What a levels footer shows: one bar per tile channel, or a short line of text
 * while the levels are not flowing (connecting, or why they cannot be read).
 */
export function TileLevelsView(
  Tile: MonitorTileLevels | undefined,
  // Each bar's peak, by position; updated in place (see NextPeak).
  Peaks: Map<number, PeakState> = new Map(),
  Now = 0
): {
  Bars: TileLevelBar[];
  Text: string | null;
} {
  if (!Tile || Tile.State === 'connecting') return { Bars: [], Text: 'Levels…' };
  if (Tile.State === 'unavailable') {
    return { Bars: [], Text: Tile.Message || 'Levels unavailable' };
  }
  return {
    Bars: Tile.Channels.map((Channel, Index) => {
      const Peak = NextPeak(Peaks.get(Index), Channel.Db, Now);
      Peaks.set(Index, Peak);
      return {
        Label: Channel.Label,
        Percent: LevelPercent(Channel.Db),
        Zone: LevelZoneOf(Channel.Db),
        PeakPercent: LevelPercent(Peak.Db),
        PeakZone: LevelZoneOf(Peak.Db),
        Title: `${Channel.Label}: ${FormatLevel(Channel.Db)}`,
      };
    }),
    Text: Tile.Channels.length ? null : 'No outputs chosen',
  };
}
