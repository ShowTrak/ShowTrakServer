// Live "Offline HH:MM:SS" counter ticking on every client tile's offline
// indicator. Extracted from 14-selection-init.ts (REFACTOR_PLAN.md Phase 7).

export async function UpdateOfflineIndicators() {
  const CurrentTime = new Date().getTime();
  $('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]').each(
    function () {
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
      $(this).html(`Offline <span class="badge bg-ghost">${HH}:${MM}:${SS}</span>`);
    }
  );
}

// Tick every second. Called by the bootstrap orchestrator in main.ts — never
// at import time.
export function InitOfflineIndicators() {
  setInterval(UpdateOfflineIndicators, 1000);
}
