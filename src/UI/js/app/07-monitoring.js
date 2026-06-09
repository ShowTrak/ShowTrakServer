function FormatInterval(ms) {
  const n = Number(ms) || 0;
  if (n < 60000) return `${Math.round(n / 1000)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function FormatLatency(ms) {
  if (ms == null) return '';
  if (ms < 1) return '<1ms';
  return `${Math.round(ms)}ms`;
}

function FormatMonitorStatus(Online, LastLatencyMs, LastError) {
  if (Online) return FormatLatency(LastLatencyMs);
  const ErrorText = typeof LastError === 'string' ? LastError.trim() : '';
  if (!ErrorText) return 'Offline';
  if (
    /timed?\s*out|timeout|unreachable|refused|reset|network\s+is\s+unreachable|no\s+route\s+to\s+host|socket\s+hang\s+up|econnrefused|econnreset|ehostunreach|enetunreach/i.test(
      ErrorText
    )
  ) {
    return 'Offline';
  }
  if (/enotfound|eai_again|nxdomain|dns|name\s+or\s+service\s+not\s+known/i.test(ErrorText)) {
    return 'DNS Error';
  }
  if (
    /cert|certificate|tls|ssl|self\s*signed|unable\s+to\s+verify|hostname\/?ip\s+does\s+not\s+match/i.test(
      ErrorText
    )
  ) {
    return 'TLS Error';
  }
  const HttpMatch = ErrorText.match(/\bHTTP\s+(\d{3})\b/i);
  if (HttpMatch) return `HTTP ${HttpMatch[1]}`;
  return ErrorText;
}

function RenderMonitoringTargetsSection() {
  // Deprecated: monitoring targets are now rendered inline within their group's
  // drop zone alongside clients. Kept as a no-op for backwards compatibility.
  return '';
}

function RenderMonitoringTargetTile(T) {
  const Online = !!T.Online;
  const Degraded = !!T.Degraded;
  const Name = T.Nickname || T.Address || 'Unnamed';
  const Sub = T.Address || '';
  const Status = FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError);
  const Method = String(T.Method || '').toUpperCase();
  const DragUUID = `monitor:${T.TargetID}`;
  const TileStateClass = Degraded ? 'DEGRADED' : Online ? 'ONLINE' : '';
  const TextClass = 'text-light';
  return `
    <div id="MONITOR_TILE_${T.TargetID}" class="SHOWTRAK_PC MONITOR ${TileStateClass}" data-target-id="${T.TargetID}" data-uuid="${DragUUID}" draggable="${
      AppMode === 'EDIT' ? 'true' : 'false'
    }">
      <button type="button" class="CLIENT_TILE_COG MONITOR_TILE_COG" aria-label="Edit Monitor" title="Edit Monitor">
        <i class="bi bi-gear-fill"></i>
      </button>
      <label class="text-sm" data-type="Method">${Safe(Method)} · ${Safe(
        FormatInterval(T.Interval)
      )}</label>
      <h5 class="mb-0" data-type="Name">${Safe(Name)}</h5>
      <small class="text-sm text-light" data-type="Address">${Safe(Sub)}</small>
      <div class="SHOWTRAK_PC_STATUS d-grid" data-type="MONITOR_STATUS">
        <h7 class="mb-0 ${TextClass}" data-type="MONITOR_STATUS_LABEL">${Safe(Status)}</h7>
      </div>
      <span class="MONITOR_COMPACT_LATENCY ${TextClass}" data-type="MONITOR_COMPACT_LATENCY">${Safe(Status)}</span>
    </div>`;
}

function UpdateMonitoringTargetTile(T) {
  const $tile = $(`#MONITOR_TILE_${T.TargetID}`);
  if (!$tile.length) return;
  const Online = !!T.Online;
  const Degraded = !!T.Degraded;
  $tile.toggleClass('ONLINE', Online && !Degraded);
  $tile.toggleClass('DEGRADED', Degraded);
  const Name = T.Nickname || T.Address || 'Unnamed';
  $tile.find('[data-type="Name"]').text(Name);
  $tile.find('[data-type="Address"]').text(T.Address || '');
  $tile
    .find('[data-type="Method"]')
    .text(`${String(T.Method || '').toUpperCase()} · ${FormatInterval(T.Interval)}`);
  const Status = FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError);
  const $label = $tile.find('[data-type="MONITOR_STATUS_LABEL"]');
  $label.text(Status);
  $label.removeClass('text-success text-warning').addClass('text-light');
  const $compact = $tile.find('[data-type="MONITOR_COMPACT_LATENCY"]');
  $compact.text(Status);
  $compact.removeClass('text-success text-warning').addClass('text-light');
}

async function LoadMonitoringTargetHistory(TargetID) {
  try {
    const Samples = await window.API.GetMonitoringTargetHistory(TargetID);
    MonitorHistorySamples = Array.isArray(Samples) ? Samples : [];
  } catch {
    MonitorHistorySamples = [];
  }
}

function GetMonitorHistoryRange(RangeKey) {
  if (MONITORING_HISTORY_RANGES[RangeKey]) return MONITORING_HISTORY_RANGES[RangeKey];
  return MONITORING_HISTORY_RANGES['5m'];
}

function GetVisibleMonitorHistoryRangeKeys(TargetIntervalMs) {
  const IntervalMs = Number(TargetIntervalMs);
  if (!Number.isFinite(IntervalMs) || IntervalMs <= 0) {
    return Object.keys(MONITORING_HISTORY_RANGES);
  }
  return Object.entries(MONITORING_HISTORY_RANGES)
    .filter(([, Range]) => Math.floor(Range.ms / IntervalMs) >= 10)
    .map(([Key]) => Key);
}

function FormatHistoryXAxisLabel(Timestamp) {
  try {
    return new Date(Timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function GetMonitoringSampleStatusText(Sample) {
  if (!Sample) return 'Unknown';
  if (!Sample.online) return 'Offline';
  if (Sample.degraded) return 'Degraded';
  return 'Online';
}

function HideMonitoringHistoryTooltip() {
  const El = document.getElementById('MONITOR_HISTORY_TOOLTIP');
  if (!El) return;
  El.classList.add('d-none');
}

function ShowMonitoringHistoryTooltip(MouseX, MouseY, Hit) {
  const Panel = document.getElementById('MONITOR_HISTORY_GRAPH_PANEL');
  const Tooltip = document.getElementById('MONITOR_HISTORY_TOOLTIP');
  if (!Panel || !Tooltip || !Hit || !Hit.sample) return;

  const Sample = Hit.sample;
  const Status = GetMonitoringSampleStatusText(Sample);
  const LatencyText =
    Sample.latencyMs != null && Number.isFinite(Number(Sample.latencyMs))
      ? `${Math.round(Number(Sample.latencyMs))} ms`
      : 'N/A';

  Tooltip.innerHTML = `
    <div class="monitor-tooltip-title">${FormatHistoryXAxisLabel(Sample.ts)}</div>
    <div class="monitor-tooltip-row">Status: ${Status}</div>
    <div class="monitor-tooltip-row">Latency: ${LatencyText}</div>
  `;
  Tooltip.classList.remove('d-none');

  const PanelRect = Panel.getBoundingClientRect();
  const TipRect = Tooltip.getBoundingClientRect();
  const OffsetX = 12;
  const OffsetY = 12;
  let Left = MouseX + OffsetX;
  let Top = MouseY + OffsetY;

  if (Left + TipRect.width > PanelRect.width - 6) {
    Left = Math.max(6, MouseX - TipRect.width - OffsetX);
  }
  if (Top + TipRect.height > PanelRect.height - 6) {
    Top = Math.max(6, MouseY - TipRect.height - OffsetY);
  }

  Tooltip.style.left = `${Math.max(6, Left)}px`;
  Tooltip.style.top = `${Math.max(6, Top)}px`;
}

function ResolvePingScaleMax(ObservedMaxMs) {
  const Observed = Number.isFinite(ObservedMaxMs) ? ObservedMaxMs : 0;
  const Base = Math.max(50, Observed);
  if (Base <= 50) return 50;

  const Magnitude = Math.pow(10, Math.floor(Math.log10(Base)));
  const Normalized = Base / Magnitude;
  let Nice = 10;
  if (Normalized <= 1) Nice = 1;
  else if (Normalized <= 2) Nice = 2;
  else if (Normalized <= 5) Nice = 5;
  return Nice * Magnitude;
}

function DrawMonitoringHistoryGraph(Canvas, BucketSamples, RangeConfig) {
  if (!Canvas) return;
  MonitorHistoryHoverBars = [];
  const Rect = Canvas.getBoundingClientRect();
  const Width = Math.max(320, Math.floor(Rect.width || Canvas.clientWidth || 320));
  const Height = Math.max(180, Math.floor(Rect.height || Canvas.clientHeight || 240));
  const DPR = Math.max(1, window.devicePixelRatio || 1);

  if (Canvas.width !== Math.floor(Width * DPR) || Canvas.height !== Math.floor(Height * DPR)) {
    Canvas.width = Math.floor(Width * DPR);
    Canvas.height = Math.floor(Height * DPR);
  }

  const Ctx = Canvas.getContext('2d');
  if (!Ctx) return;
  Ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  Ctx.clearRect(0, 0, Width, Height);

  const PadTop = 12;
  const PadRight = 10;
  const PadBottom = 26;
  const PadLeft = 42;
  const PlotWidth = Math.max(20, Width - PadLeft - PadRight);
  const PlotHeight = Math.max(20, Height - PadTop - PadBottom);

  Ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  Ctx.fillRect(PadLeft, PadTop, PlotWidth, PlotHeight);

  Ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  Ctx.lineWidth = 1;
  Ctx.beginPath();
  Ctx.moveTo(PadLeft, PadTop + PlotHeight + 0.5);
  Ctx.lineTo(PadLeft + PlotWidth, PadTop + PlotHeight + 0.5);
  Ctx.stroke();

  const NumericLatency = BucketSamples.filter((S) => S && S.online && S.latencyMs != null)
    .map((S) => Number(S.latencyMs))
    .filter((L) => Number.isFinite(L) && L >= 0);
  const MaxObservedLatency = NumericLatency.length ? Math.max(...NumericLatency) : 0;
  const PingScaleMax = ResolvePingScaleMax(MaxObservedLatency);

  const TickCount = 4;
  Ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
  Ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  Ctx.font = '10px sans-serif';
  Ctx.textAlign = 'right';
  Ctx.textBaseline = 'middle';
  for (let i = 0; i <= TickCount; i++) {
    const Ratio = i / TickCount;
    const Y = PadTop + PlotHeight - Ratio * PlotHeight;
    const Value = Math.round(Ratio * PingScaleMax);

    Ctx.beginPath();
    Ctx.moveTo(PadLeft, Y + 0.5);
    Ctx.lineTo(PadLeft + PlotWidth, Y + 0.5);
    Ctx.stroke();

    Ctx.fillText(`${Value}ms`, PadLeft - 6, Y);
  }

  const RangeEndTs = Date.now();
  const RangeStartTs = RangeEndTs - RangeConfig.ms;
  const RangeSpanMs = Math.max(1, RangeEndTs - RangeStartTs);

  let BarWidth = 1;
  if (BucketSamples.length > 1) {
    const FirstTs = Number(BucketSamples[0] && BucketSamples[0].ts);
    const LastTs = Number(
      BucketSamples[BucketSamples.length - 1] && BucketSamples[BucketSamples.length - 1].ts
    );
    if (Number.isFinite(FirstTs) && Number.isFinite(LastTs)) {
      const SampleSpanMs = Math.max(1, LastTs - FirstTs);
      const AvgSampleMs = SampleSpanMs / Math.max(1, BucketSamples.length - 1);
      const AvgWidthPx = (AvgSampleMs / RangeSpanMs) * PlotWidth;
      BarWidth = Math.max(1, Math.min(6, Math.ceil(AvgWidthPx)));
    }
  }

  function ResolveSampleVisual(Sample) {
    let HeightRatio = 0.15;
    let Fill = 'rgba(220, 53, 69, 0.95)';

    if (Sample.online && Sample.degraded) {
      const LatencyRatio = Math.min(1, (Sample.latencyMs || 0) / PingScaleMax);
      HeightRatio = Math.max(0.2, LatencyRatio);
      Fill = 'rgba(255, 193, 7, 0.95)';
    } else if (Sample.online) {
      const LatencyRatio = Math.min(1, (Sample.latencyMs || 0) / PingScaleMax);
      HeightRatio = Math.max(0.18, LatencyRatio);
      Fill = 'rgba(32, 201, 151, 0.95)';
    }

    const BarHeight = Math.max(4, Math.floor(PlotHeight * HeightRatio));
    const Y = PadTop + PlotHeight - BarHeight;
    return { Fill, BarHeight, Y };
  }

  let Previous = null;

  for (let i = 0; i < BucketSamples.length; i++) {
    const Sample = BucketSamples[i];
    if (!Sample) continue;

    const SampleTs = Number(Sample.ts);
    const Ratio = Number.isFinite(SampleTs) ? (SampleTs - RangeStartTs) / RangeSpanMs : 0;
    const XUnclamped = Math.round(PadLeft + Math.max(0, Math.min(1, Ratio)) * PlotWidth);
    const X = Math.max(PadLeft, Math.min(PadLeft + PlotWidth - BarWidth, XUnclamped));
    const Visual = ResolveSampleVisual(Sample);

    // Keep the stream visually continuous between known samples by extending
    // the previous value forward until the next sample arrives.
    if (Previous) {
      const BridgeStart = Previous.x + Previous.w;
      const BridgeWidth = X - BridgeStart;
      if (BridgeWidth > 0) {
        Ctx.fillStyle = Previous.fill;
        Ctx.fillRect(BridgeStart, Previous.y, BridgeWidth, Previous.h);
      }
    }

    Ctx.fillStyle = Visual.Fill;
    Ctx.fillRect(X, Visual.Y, BarWidth, Visual.BarHeight);

    Previous = {
      x: X,
      y: Visual.Y,
      w: BarWidth,
      h: Visual.BarHeight,
      fill: Visual.Fill,
    };

    MonitorHistoryHoverBars.push({
      x: X,
      y: Visual.Y,
      w: BarWidth,
      h: Visual.BarHeight,
      sample: Sample,
    });
  }

  const StartLabel = FormatHistoryXAxisLabel(RangeStartTs);
  const EndLabel = FormatHistoryXAxisLabel(RangeEndTs);
  Ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  Ctx.font = '11px sans-serif';
  Ctx.textBaseline = 'top';
  Ctx.fillText(StartLabel, PadLeft, Height - 16);
  const EndWidth = Ctx.measureText(EndLabel).width;
  Ctx.fillText(EndLabel, PadLeft + PlotWidth - EndWidth, Height - 16);
}

function BuildMonitoringHistoryBuckets(Samples, RangeConfig) {
  const SafeSamples = Array.isArray(Samples) ? Samples : [];
  const Now = Date.now();
  const Start = Now - RangeConfig.ms;
  const InRangeSamples = SafeSamples.filter(
    (S) => S && Number.isFinite(S.ts) && S.ts >= Start && S.ts <= Now
  ).sort((a, b) => a.ts - b.ts);

  return {
    buckets: InRangeSamples,
    visibleSampleCount: InRangeSamples.length,
  };
}

function RenderMonitoringHistoryModal() {
  if (!MonitorHistoryModalTargetID) return;
  const Target = MonitoringTargets.find(
    (T) => Number(T.TargetID) === Number(MonitorHistoryModalTargetID)
  );
  if (!Target) return;

  const IntervalMs = Number(Target.Interval);
  const VisibleRangeKeys = GetVisibleMonitorHistoryRangeKeys(IntervalMs);
  const $rangeButtons = $('#MONITOR_HISTORY_RANGE_GROUP [data-range]');
  $rangeButtons.each(function () {
    const Key = String($(this).attr('data-range') || '').trim();
    $(this).toggleClass('d-none', !VisibleRangeKeys.includes(Key));
  });

  if (!VisibleRangeKeys.length) {
    $('#MONITOR_HISTORY_RANGE_GROUP').addClass('d-none');
    $('#MONITOR_HISTORY_EMPTY')
      .removeClass('d-none')
      .text('No graph ranges available for this check interval.');
    $('#MONITOR_HISTORY_SUMMARY').text(
      'Increase history range or lower check interval to view at least 10 samples.'
    );
    const Canvas = document.getElementById('MONITOR_HISTORY_CANVAS');
    if (Canvas) {
      const Ctx = Canvas.getContext('2d');
      if (Ctx) Ctx.clearRect(0, 0, Canvas.width, Canvas.height);
    }
    MonitorHistoryHoverBars = [];
    HideMonitoringHistoryTooltip();
    return;
  }

  $('#MONITOR_HISTORY_RANGE_GROUP').removeClass('d-none');
  $('#MONITOR_HISTORY_EMPTY').text('No samples in this range yet.');
  if (!VisibleRangeKeys.includes(MonitorHistoryRangeKey)) {
    MonitorHistoryRangeKey = VisibleRangeKeys[0];
  }

  const Range = GetMonitorHistoryRange(MonitorHistoryRangeKey);
  const Samples = Array.isArray(MonitorHistorySamples) ? MonitorHistorySamples : [];
  const { buckets, visibleSampleCount } = BuildMonitoringHistoryBuckets(Samples, Range);
  const Latest = Samples.length ? Samples[Samples.length - 1] : null;

  $('#MONITOR_HISTORY_TITLE').text(
    Target.Nickname || Target.Address || `Target ${Target.TargetID}`
  );

  $('#MONITOR_HISTORY_RANGE_GROUP [data-range]')
    .removeClass('active btn-light')
    .addClass('btn-outline-light');
  $(`#MONITOR_HISTORY_RANGE_GROUP [data-range='${MonitorHistoryRangeKey}']`)
    .addClass('active btn-light')
    .removeClass('btn-outline-light');

  const Canvas = document.getElementById('MONITOR_HISTORY_CANVAS');
  if (!Canvas) return;

  if (!visibleSampleCount) {
    $('#MONITOR_HISTORY_EMPTY').removeClass('d-none');
    const Ctx = Canvas.getContext('2d');
    if (Ctx) Ctx.clearRect(0, 0, Canvas.width, Canvas.height);
    MonitorHistoryHoverBars = [];
    HideMonitoringHistoryTooltip();
    $('#MONITOR_HISTORY_SUMMARY').text('No history samples available yet in the selected range.');
    return;
  }

  $('#MONITOR_HISTORY_EMPTY').addClass('d-none');
  DrawMonitoringHistoryGraph(Canvas, buckets, Range);

  const StatusText = Latest
    ? Latest.online
      ? Latest.degraded
        ? 'Degraded'
        : 'Online'
      : 'Offline'
    : 'Unknown';
  const LatencyText =
    Latest && Latest.latencyMs != null && Number.isFinite(Number(Latest.latencyMs))
      ? `${Math.round(Number(Latest.latencyMs))} ms`
      : 'N/A';
  $('#MONITOR_HISTORY_SUMMARY').text(
    `Latest: ${StatusText} · Latency: ${LatencyText} · Samples in range: ${visibleSampleCount}`
  );
}

async function OpenMonitoringTargetHistory(TargetID) {
  const Target = MonitoringTargets.find((T) => Number(T.TargetID) === Number(TargetID));
  if (!Target) return Notify('Monitoring target not found', 'error');
  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('Monitoring:OpenMonitoringTargetHistory:CloseAllModals', err);
  }

  MonitorHistoryModalTargetID = Number(Target.TargetID);
  MonitorHistorySamples = [];
  await LoadMonitoringTargetHistory(MonitorHistoryModalTargetID);

  const $modal = $('#SHOWTRAK_MONITOR_HISTORY_MODAL');
  $modal.off('hidden.bs.modal.monitorhistory').on('hidden.bs.modal.monitorhistory', function () {
    MonitorHistoryModalTargetID = null;
    MonitorHistorySamples = [];
    MonitorHistoryHoverBars = [];
    HideMonitoringHistoryTooltip();
  });
  $modal.modal('show');
  RenderMonitoringHistoryModal();
}
