// Live "Offline HH:MM:SS" counter ticking on every client tile's offline
// indicator. Extracted from selection-init.ts (REFACTOR_PLAN.md Phase 7).
import { OfflineBadgeContent } from './lib/status-badges';

const OFFLINE_SINCE_SELECTOR =
  '.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]';

// Refresh the counters under `Root` (the whole page by default).
//
// Only counters that are showing are written. Every tile carries an offline
// indicator, hidden while it is online, and every client tile's is stamped with
// its LastSeen on each heartbeat, so this used to rebuild a hidden badge for
// every online client every second. A tile revealing its indicator calls this
// for itself, so a newly offline tile never shows a stale count for a tick.
export async function UpdateOfflineIndicators(Root?: Element | null) {
  const CurrentTime = new Date().getTime();
  const Scope = Root ? $(Root) : $(document);
  Scope.find(OFFLINE_SINCE_SELECTOR).each(function () {
    if (this.parentElement && this.parentElement.classList.contains('d-none')) return;
    const LastSeenRaw = $(this).attr('data-offlinesince');
    if (!LastSeenRaw) return;
    const LastSeen = parseInt(LastSeenRaw);
    const OfflineDuration = CurrentTime - LastSeen;
    const Hours = Math.floor(OfflineDuration / (1000 * 60 * 60));
    const Minutes = Math.floor((OfflineDuration % (1000 * 60 * 60)) / (1000 * 60));
    const Seconds = Math.floor((OfflineDuration % (1000 * 60)) / 1000);
    const HH = String(Hours).padStart(2, '0');
    const MM = String(Minutes).padStart(2, '0');
    const SS = String(Seconds).padStart(2, '0');
    const Text = `${HH}:${MM}:${SS}`;
    // Rebuilding the badge markup is skipped when the count has not moved.
    if (this.getAttribute('data-offline-text') === Text) return;
    this.setAttribute('data-offline-text', Text);
    $(this).html(OfflineBadgeContent(Text));
  });
}

// Tick every second. Called by the bootstrap orchestrator in main.ts, never
// at import time. Nothing is drawn while the window is hidden, so the tick
// skips then and catches up the moment it is shown again.
export function InitOfflineIndicators() {
  setInterval(() => {
    if (document.hidden) return;
    UpdateOfflineIndicators();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) UpdateOfflineIndicators();
  });
}
