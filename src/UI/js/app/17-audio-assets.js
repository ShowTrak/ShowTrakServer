// Custom Audio Assets manager (renderer).
// - Plays custom audio assets requested by alert actions (PlayCustomAudio).
// - Drives the Audio Assets modal: import (with client-side duration check),
//   per-asset label + volume editing, preview and delete.
// The main process owns the files (AppData/Audio + manifest.json); this module
// only ever sees metadata plus on-demand base64 data URLs for playback.

const AUDIO_ASSET_MAX_DURATION_SECONDS = 15;

// Keep references to in-flight audio elements so they are not garbage collected
// mid-playback. Cleaned up when playback finishes or errors.
let ActiveAudioPlaybacks = [];
let AudioPlaybackContext = null;
let ActivePreviewPlayback = null;

function getAudioPlaybackContext() {
  if (AudioPlaybackContext) return AudioPlaybackContext;
  const ContextClass = window.AudioContext || window.webkitAudioContext;
  if (!ContextClass) return null;
  AudioPlaybackContext = new ContextClass();
  return AudioPlaybackContext;
}

function toBackendVolume(Value) {
  const Raw = Number(Value);
  if (!Number.isFinite(Raw)) return 100;
  return Math.min(200, Math.max(0, Math.round(Raw)));
}

function toVisualVolume(BackendVolume) {
  return Math.round(toBackendVolume(BackendVolume) / 2);
}

function playAudioDataURL(DataURL, VolumePercent, Hooks = {}) {
  if (!DataURL) return;
  try {
    let cleaned = false;
    const Element = new Audio(DataURL);
    const BackendVolume = toBackendVolume(VolumePercent);
    const GainValue = BackendVolume / 100;
    const Context = getAudioPlaybackContext();
    let SourceNode = null;
    let GainNode = null;

    if (Context) {
      SourceNode = Context.createMediaElementSource(Element);
      GainNode = Context.createGain();
      GainNode.gain.value = GainValue;
      SourceNode.connect(GainNode);
      GainNode.connect(Context.destination);
      if (Context.state === 'suspended') {
        Context.resume().catch(() => {});
      }
    } else {
      // Fallback path if Web Audio is unavailable: clip to normal range.
      Element.volume = Math.min(1, Math.max(0, GainValue));
    }

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      ActiveAudioPlaybacks = ActiveAudioPlaybacks.filter((Entry) => Entry.Element !== Element);
      if (SourceNode) {
        try {
          SourceNode.disconnect();
        } catch {
          /* ignore */
        }
      }
      if (GainNode) {
        try {
          GainNode.disconnect();
        } catch {
          /* ignore */
        }
      }
      if (typeof Hooks.OnStop === 'function') Hooks.OnStop();
    };

    const stop = () => {
      try {
        Element.pause();
        Element.currentTime = 0;
      } catch {
        /* ignore */
      }
      cleanup();
    };

    ActiveAudioPlaybacks.push({ Element, SourceNode, GainNode, stop });
    Element.addEventListener('ended', cleanup, { once: true });
    Element.addEventListener('error', cleanup, { once: true });
    const Playback = Element.play();
    if (Playback && typeof Playback.catch === 'function') {
      Playback.catch(() => cleanup());
    }
    return { stop };
  } catch (Err) {
    HandleNonFatalError('AudioAssets:Play', Err);
    return null;
  }
}

function setPreviewButtonState(ID, IsPlaying) {
  const $button = $(`#AUDIO_ASSETS_LIST [data-audio-id="${ID}"] [data-audio-preview]`);
  if (!$button.length) return;

  if (IsPlaying) {
    $button.attr('title', 'Stop preview');
    $button.html('<i class="bi bi-stop-fill"></i>');
    return;
  }

  $button.attr('title', 'Preview');
  $button.html('<i class="bi bi-play-fill"></i>');
}

// Alert action -> server -> renderer: play a custom asset at its saved volume.
window.API.PlayCustomAudio(async (Payload) => {
  if (!Payload || !Payload.DataURL) return;
  playAudioDataURL(Payload.DataURL, Payload.Volume);
});

// Refresh the local cache whenever the store changes (import/update/delete from
// any window) so alert action warning icons stay accurate.
window.API.OnAudioAssetsUpdated(async () => {
  await LoadAudioAssets();
  if ($('#SHOWTRAK_MODAL_AUDIO_ASSETS').hasClass('show')) RenderAudioAssetsList();
  if (typeof RenderAlertActionsList === 'function') RenderAlertActionsList();
});

async function LoadAudioAssets() {
  try {
    const List = await window.API.GetAudioAssets();
    AudioAssetsCache = Array.isArray(List) ? List : [];
  } catch (Err) {
    HandleNonFatalError('AudioAssets:Load', Err);
    AudioAssetsCache = [];
  }
  return AudioAssetsCache;
}

function AudioAssetByID(ID) {
  return (AudioAssetsCache || []).find((A) => A.ID === ID) || null;
}

// Validate a candidate audio file's duration in the renderer (the only place
// that can actually decode audio). Resolves with the duration in seconds or
// rejects with a human-readable reason.
function getAudioDurationFromDataURL(DataURL) {
  return new Promise((resolve, reject) => {
    const Element = new Audio();
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(Timer);
      fn(arg);
    };
    const Timer = setTimeout(() => done(reject, new Error('Timed out reading audio')), 10000);
    Element.addEventListener('loadedmetadata', () => {
      const Duration = Element.duration;
      if (!Number.isFinite(Duration) || Duration <= 0) {
        done(reject, new Error('Could not determine audio duration'));
        return;
      }
      done(resolve, Duration);
    });
    Element.addEventListener('error', () => done(reject, new Error('Not a valid audio file')));
    Element.src = DataURL;
  });
}

async function SelectAndImportAudioAssets() {
  let Candidates;
  try {
    const [Err, List] = await window.API.SelectAudioAssetFiles();
    if (Err) return Notify(Err, 'error');
    Candidates = Array.isArray(List) ? List : [];
  } catch (ErrSelect) {
    return HandleNonFatalError('AudioAssets:Select', ErrSelect);
  }

  if (!Candidates.length) return;

  let Imported = 0;
  const Failures = [];

  for (const Candidate of Candidates) {
    const Name = Candidate && Candidate.OriginalName ? Candidate.OriginalName : 'file';
    if (!Candidate || Candidate.Error) {
      Failures.push(`${Name}: ${(Candidate && Candidate.Error) || 'Invalid file'}`);
      continue;
    }

    let Duration;
    try {
      Duration = await getAudioDurationFromDataURL(Candidate.DataURL);
    } catch (DurErr) {
      Failures.push(`${Name}: ${DurErr.message || 'Invalid audio file'}`);
      continue;
    }

    if (Duration > AUDIO_ASSET_MAX_DURATION_SECONDS + 0.5) {
      Failures.push(
        `${Name}: longer than ${AUDIO_ASSET_MAX_DURATION_SECONDS} seconds (${Duration.toFixed(1)}s)`
      );
      continue;
    }

    try {
      const [ImportErr] = await window.API.ImportAudioAsset({
        SourcePath: Candidate.Path,
        Label: Candidate.BaseLabel,
        // Visual default is 50%; persisted scale is 0-200, so default is 100.
        Volume: 100,
        Duration,
      });
      if (ImportErr) {
        Failures.push(`${Name}: ${ImportErr}`);
        continue;
      }
      Imported += 1;
    } catch (ImportThrow) {
      Failures.push(`${Name}: ${ImportThrow.message || 'Import failed'}`);
    }
  }

  await LoadAudioAssets();
  RenderAudioAssetsList();
  if (typeof RenderAlertActionsList === 'function') RenderAlertActionsList();

  if (Imported) {
    Notify(`Imported ${Imported} audio asset${Imported === 1 ? '' : 's'}`, 'success', 2500);
  }
  if (Failures.length) {
    Notify(`Skipped ${Failures.length} file(s): ${Failures.join('; ')}`, 'error', 8000);
  }
}

async function PreviewAudioAsset(ID) {
  if (ActivePreviewPlayback && ActivePreviewPlayback.ID === ID) {
    ActivePreviewPlayback.stop();
    return;
  }

  if (ActivePreviewPlayback) {
    ActivePreviewPlayback.stop();
    ActivePreviewPlayback = null;
  }

  try {
    const [Err, Payload] = await window.API.GetAudioAssetData(ID);
    if (Err || !Payload) return Notify(Err || 'Audio asset unavailable', 'error');

    const Controller = playAudioDataURL(Payload.DataURL, Payload.Volume, {
      OnStop: () => {
        if (ActivePreviewPlayback && ActivePreviewPlayback.ID === ID) {
          ActivePreviewPlayback = null;
        }
        setPreviewButtonState(ID, false);
      },
    });
    if (!Controller) return;

    ActivePreviewPlayback = {
      ID,
      stop: Controller.stop,
    };
    setPreviewButtonState(ID, true);
  } catch (ErrPreview) {
    HandleNonFatalError('AudioAssets:Preview', ErrPreview);
  }
}

function formatAudioAssetSize(Bytes) {
  const Size = Number(Bytes) || 0;
  if (Size >= 1024 * 1024) return `${(Size / (1024 * 1024)).toFixed(1)} MB`;
  if (Size >= 1024) return `${Math.round(Size / 1024)} KB`;
  return `${Size} B`;
}

function RenderAudioAssetsList() {
  const $host = $('#AUDIO_ASSETS_LIST');
  if (!$host.length) return;

  if (!Array.isArray(AudioAssetsCache) || !AudioAssetsCache.length) {
    $host.html(
      '<div class="rounded bg-ghost p-2 text-center text-muted">No audio assets yet. Use “Select Files” to import some.</div>'
    );
    return;
  }

  let Html = '';
  for (const Asset of AudioAssetsCache) {
    const IsPreviewPlaying = !!(ActivePreviewPlayback && ActivePreviewPlayback.ID === Asset.ID);
    const BackendVolume = toBackendVolume(Asset.Volume);
    const VisualVolume = toVisualVolume(BackendVolume);
    const Meta = [];
    if (Asset.Extension) Meta.push(String(Asset.Extension).toUpperCase());
    Meta.push(formatAudioAssetSize(Asset.Size));
    if (Asset.Duration != null) Meta.push(`${Number(Asset.Duration).toFixed(1)}s`);
    const MissingBadge = Asset.Missing
      ? '<span class="badge bg-warning text-dark ms-2" title="The audio file is missing">Missing</span>'
      : '';

    Html += `
      <div class="audio-asset-row rounded bg-ghost p-2 text-start" data-audio-id="${Safe(Asset.ID)}">
        <input
          type="text"
          class="form-control form-control-sm audio-asset-label-inline"
          data-audio-label
          value="${Safe(Asset.Label)}"
          maxlength="40"
          placeholder="Label"
          title="Alphanumeric only"
        />
        <div class="text-sm text-muted text-truncate audio-asset-meta" title="${Safe(Asset.OriginalName || '')}">
          ${Safe(Meta.join(' · '))}${MissingBadge}
        </div>
        <div class="d-flex align-items-center gap-2 audio-asset-volume-wrap">
          <i class="bi bi-volume-down text-muted" aria-hidden="true"></i>
          <input
            type="range"
            class="form-range flex-grow-1"
            min="0"
            max="100"
            step="1"
            value="${VisualVolume}"
            data-audio-volume
          />
          <span class="text-sm" data-audio-volume-label>${VisualVolume}%</span>
        </div>
        <div class="d-flex gap-1 flex-shrink-0 audio-asset-actions">
          <button type="button" class="btn btn-sm bg-ghost-light text-white" data-audio-preview title="${IsPreviewPlaying ? 'Stop preview' : 'Preview'}" ${Asset.Missing ? 'disabled' : ''}>
            <i class="bi ${IsPreviewPlaying ? 'bi-stop-fill' : 'bi-play-fill'}"></i>
          </button>
          <button type="button" class="btn btn-sm btn-danger" data-audio-delete title="Delete">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>
    `;
  }

  $host.html(Html);
  BindAudioAssetRowHandlers();
}

function BindAudioAssetRowHandlers() {
  const $host = $('#AUDIO_ASSETS_LIST');

  $host
    .find('[data-audio-preview]')
    .off('click')
    .on('click', function () {
      const ID = $(this).closest('[data-audio-id]').attr('data-audio-id');
      if (ID) PreviewAudioAsset(ID);
    });

  $host
    .find('[data-audio-delete]')
    .off('click')
    .on('click', async function () {
      const ID = $(this).closest('[data-audio-id]').attr('data-audio-id');
      if (!ID) return;
      const Asset = AudioAssetByID(ID);
      const Confirmed = await ConfirmationDialog(
        `Delete audio asset “${Asset ? Asset.Label : ID}”? This cannot be undone.`
      );
      if (!Confirmed) return;
      const [Err] = await window.API.DeleteAudioAsset(ID);
      if (Err) return Notify(Err, 'error');
      Notify('Audio asset deleted', 'success', 1500);
      await LoadAudioAssets();
      RenderAudioAssetsList();
      if (typeof RenderAlertActionsList === 'function') RenderAlertActionsList();
    });

  // Live-sanitize labels to alphanumeric (no spaces / special characters).
  $host
    .find('[data-audio-label]')
    .off('input blur keydown')
    .on('input', function () {
      const Cleaned = String($(this).val() || '').replace(/[^A-Za-z0-9]/g, '');
      if (Cleaned !== $(this).val()) $(this).val(Cleaned);
    })
    .on('keydown', function (Event) {
      if (Event.key === 'Enter') {
        Event.preventDefault();
        $(this).blur();
      }
    })
    .on('blur', async function () {
      const ID = $(this).closest('[data-audio-id]').attr('data-audio-id');
      if (!ID) return;
      const NewLabel = String($(this).val() || '').replace(/[^A-Za-z0-9]/g, '');
      const Asset = AudioAssetByID(ID);
      if (!Asset || NewLabel === Asset.Label) return;
      const [Err, Updated] = await window.API.UpdateAudioAsset(ID, { Label: NewLabel });
      if (Err) return Notify(Err, 'error');
      if (Updated) Asset.Label = Updated.Label;
      $(this).val(Asset.Label);
      if (typeof RenderAlertActionsList === 'function') RenderAlertActionsList();
    });

  $host
    .find('[data-audio-volume]')
    .off('input change')
    .on('input', function () {
      $(this)
        .closest('[data-audio-id]')
        .find('[data-audio-volume-label]')
        .text(`${$(this).val()}%`);
    })
    .on('change', async function () {
      const ID = $(this).closest('[data-audio-id]').attr('data-audio-id');
      if (!ID) return;
      const VisualVolume = parseInt($(this).val(), 10);
      const BackendVolume = Math.min(200, Math.max(0, Math.round(VisualVolume * 2)));
      const [Err, Updated] = await window.API.UpdateAudioAsset(ID, { Volume: BackendVolume });
      if (Err) return Notify(Err, 'error');
      const Asset = AudioAssetByID(ID);
      if (Asset && Updated) Asset.Volume = Updated.Volume;
    });
}

async function OpenAudioAssetsManager() {
  await LoadAudioAssets();
  RenderAudioAssetsList();
  $('#SHOWTRAK_MODAL_ALERT_MANAGER').modal('hide');
  await Wait(200);
  $('#SHOWTRAK_MODAL_AUDIO_ASSETS').modal('show');
}

document.addEventListener('DOMContentLoaded', () => {
  $('#AUDIO_ASSETS_OPEN_BUTTON')
    .off('click.audioAssets')
    .on('click.audioAssets', () => OpenAudioAssetsManager());

  $('#AUDIO_ASSETS_SELECT_BUTTON')
    .off('click.audioAssets')
    .on('click.audioAssets', () => SelectAndImportAudioAssets());

  $('#AUDIO_ASSETS_BACK_BUTTON')
    .off('click.audioAssets')
    .on('click.audioAssets', async () => {
      $('#SHOWTRAK_MODAL_AUDIO_ASSETS').modal('hide');
      await Wait(200);
      if (typeof OpenAlertRuleManager === 'function') await OpenAlertRuleManager();
    });
});
