// Rainbow Mode: an undocumented easter egg, toggled from the hidden log console.
//
// The server holds one in-memory flag for every surface (desktop and Web UI);
// this module just mirrors it as a class on <body>. The rainbow itself is pure
// CSS on the tiles and list rows (see 04-toasts.css), so with the mode off there
// is nothing on the page at all.
//
// Only healthy online tiles get the rainbow; the CSS decides which, so a tile
// that goes degraded or offline drops it the moment its class changes.
//
// The one thing CSS cannot do is keep the tiles in step: each tile's colour
// cycle starts when its rainbow appears — when the tile is created, or when it
// comes back online — and both happen at arbitrary moments. While the mode is
// on, every new cycle is moved onto one shared start time so the colours stay
// in unison.
import { HandleNonFatalError } from './utils';

const ON_CLASS = 'st-rainbow';
const ENTERING_CLASS = 'st-rainbow-entering';
const LEAVING_CLASS = 'st-rainbow-leaving';
// Matches the fade in 04-toasts.css.
const FADE_MS = 1200;
const HUE_ANIMATION = 'st-rainbow-hue';

let FadeTimer: ReturnType<typeof setTimeout> | null = null;
let Observer: MutationObserver | null = null;
let SyncQueued = false;
// The document-timeline time every tile's colour cycle is aligned to.
let Origin: number | null = null;

function SyncPhase(): void {
  SyncQueued = false;
  if (Origin === null) return;
  for (const Anim of document.getAnimations()) {
    if ((Anim as CSSAnimation).animationName !== HUE_ANIMATION) continue;
    if (Anim.startTime !== Origin) Anim.startTime = Origin;
  }
}

function QueueSync(): void {
  if (SyncQueued) return;
  SyncQueued = true;
  requestAnimationFrame(SyncPhase);
}

function ClearFadeTimer(): void {
  if (FadeTimer) clearTimeout(FadeTimer);
  FadeTimer = null;
}

function Apply(Enabled: unknown): void {
  const On = Enabled === true;
  $('#LOG_CONSOLE_RAINBOW').prop('checked', On);
  const Body = document.body.classList;

  if (On) {
    ClearFadeTimer();
    // Turning it back on mid-fade-out just fades back in from where it is.
    Body.remove(LEAVING_CLASS);
    if (!Body.contains(ON_CLASS)) {
      Body.add(ON_CLASS, ENTERING_CLASS);
      FadeTimer = setTimeout(() => {
        FadeTimer = null;
        Body.remove(ENTERING_CLASS);
      }, FADE_MS);
    }
    if (Origin === null) Origin = Number(document.timeline.currentTime) || 0;
    if (!Observer) {
      Observer = new MutationObserver(QueueSync);
      // Class changes too: a tile coming online starts a fresh cycle in place.
      Observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }
    QueueSync();
    return;
  }

  if (!Body.contains(ON_CLASS) || Body.contains(LEAVING_CLASS)) return;
  ClearFadeTimer();
  Body.remove(ENTERING_CLASS);
  Body.add(LEAVING_CLASS);
  FadeTimer = setTimeout(() => {
    FadeTimer = null;
    Body.remove(ON_CLASS, LEAVING_CLASS);
    Observer?.disconnect();
    Observer = null;
    Origin = null;
  }, FADE_MS);
}

// Called by the bootstrap orchestrator in main.ts — never at import time.
export function InitRainbowMode() {
  window.API.OnRainbowModeUpdated(Apply);

  $('#LOG_CONSOLE_RAINBOW')
    .off('change.rainbow')
    .on('change.rainbow', function () {
      const Want = $(this).prop('checked') === true;
      Apply(Want);
      // The answer is the server's state; it also arrives as a push, but a
      // refused or lost request must still put the box back.
      window.API.SetRainbowMode(Want)
        .then(Apply)
        .catch((Err: unknown) => HandleNonFatalError('RainbowMode:Set', Err));
    });

  window.API.GetRainbowMode()
    .then(Apply)
    .catch((Err: unknown) => HandleNonFatalError('RainbowMode:Get', Err));
}
