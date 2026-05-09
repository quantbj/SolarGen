import { formatNumber } from "./utils.js";
import {
  bindSeriesInteractions,
  canvasCssHeight,
  chartRect,
  COLORS,
  dayIndexAtX,
  drawAxisCaptions,
  drawBar,
  drawGrid,
  drawLegend,
  drawRightAxis,
  drawSeriesLine,
  drawTimeLabels,
  escapeHtml,
  findNearestSeriesHit,
  hideTooltip,
  mapSeriesPoints,
  pointInRect,
  roundRect,
  setupCanvas,
  showSeriesTooltip,
  showToggleTooltip,
  showTooltip
} from "./chartCore.js";

/**
 * Render the 14-day bar chart.
 * Click/tap on a bar selects that day and shows its tooltip; click/tap on legend items toggles series.
 */
export function renderDailyChart(canvas, days, selectedIndex, onSelectDay, hiddenSeries = new Set(), onToggleSeries = () => {}) {
  const ctx = setupCanvas(canvas);
  const rect = chartRect(ctx.canvas, 48, 48, 52, 62);
  const maxKwh = Math.max(10, ...days.map(day => day.pv)) * 1.14;
  const maxValue = Math.max(5, ...days.map(day => day.totalValue)) * 1.14;
  const isVisible = id => !hiddenSeries.has(id);

  drawGrid(ctx, rect, 5, value => `${formatNumber((maxKwh * value) / 5, 0)}`);
  drawRightAxis(ctx, rect, 5, value => `${formatNumber((maxValue * value) / 5, 0)}`);
  drawAxisCaptions(ctx, rect, "kWh", "EUR");
  const barGap = 8;
  const barWidth = Math.max(16, (rect.w - barGap * (days.length - 1)) / days.length);

  days.forEach((day, index) => {
    const x = rect.x + index * (barWidth + barGap);
    const kwhHeight = (day.pv / maxKwh) * rect.h;
    const valueHeight = (day.totalValue / maxValue) * rect.h;
    const groupGap = Math.max(3, barWidth * 0.1);
    const groupedWidth = (barWidth - groupGap) / 2;

    if (isVisible("pv")) {
      ctx.fillStyle = index === selectedIndex ? COLORS.blue : COLORS.sky;
      roundRect(ctx, x, rect.y + rect.h - kwhHeight, groupedWidth, kwhHeight, 5);
      ctx.fill();
    }

    if (isVisible("value")) {
      ctx.fillStyle = COLORS.purple;
      roundRect(ctx, x + groupedWidth + groupGap, rect.y + rect.h - valueHeight, groupedWidth, valueHeight, 4);
      ctx.fill();
    }

    ctx.fillStyle = "#66716a";
    ctx.textAlign = "center";
    const [weekday, date] = day.label.split(" ");
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(weekday, x + barWidth / 2, rect.y + rect.h + 22);
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.fillText((date || "").replace("/", "."), x + barWidth / 2, rect.y + rect.h + 38);
  });

  const legendBoxes = drawLegend(ctx, [
    { id: "pv", color: COLORS.sky, label: "PV kWh", disabled: !isVisible("pv") },
    { id: "value", color: COLORS.purple, label: "EUR value", disabled: !isVisible("value") }
  ], rect.x, 18);

  canvas.onclick = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const legendHit = legendBoxes.find(item => pointInRect(x, y, item));
    if (legendHit) {
      onToggleSeries(legendHit.id);
      return;
    }
    const index = dayIndexAtX(x, rect, barWidth, barGap, days.length);
    if (index >= 0 && index < days.length) {
      onSelectDay(index);
      showDailyTooltip(canvas, days[index], x, y);
    }
  };

  canvas.onmousemove = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const legendHit = legendBoxes.find(item => pointInRect(x, y, item));
    if (legendHit) {
      canvas.style.cursor = "pointer";
      showToggleTooltip(canvas, legendHit, x, y);
      return;
    }

    const index = dayIndexAtX(x, rect, barWidth, barGap, days.length);
    if (index < 0 || y < rect.y || y > rect.y + rect.h + 48) {
      hideTooltip(canvas);
      canvas.style.cursor = "default";
      return;
    }

    const day = days[index];
    canvas.style.cursor = "pointer";
    showDailyTooltip(canvas, day, x, y);
  };

  canvas.onmouseleave = () => {
    hideTooltip(canvas);
    canvas.style.cursor = "default";
  };
}

/**
 * Render selected-day hourly PV/load/export.
 * The chart uses the same interaction contract as the other charts: legend toggles visibility,
 * while click/tap/hover over the chart body shows the nearest value.
 */
export function renderHourlyChart(canvas, day, hiddenSeries = new Set(), onToggleSeries = () => {}) {
  const ctx = setupCanvas(canvas);
  const rect = chartRect(ctx.canvas, 42, 16, 34, 34);
  const maxValue = Math.max(1, ...day.hours.flatMap(hour => [
    hour.pv,
    hour.load,
    hour.exportKwh,
    hour.charge,
    hour.discharge
  ])) * 1.2;
  const barWidth = rect.w / 24;
  const isVisible = id => !hiddenSeries.has(id);
  const hitTargets = [];

  drawGrid(ctx, rect, 4, value => `${formatNumber((maxValue * value) / 4, 1)}`);

  day.hours.forEach(hour => {
    if (!isVisible("pv")) return;
    const x = rect.x + hour.hour * barWidth;
    drawBar(ctx, rect, x + 2, barWidth - 4, hour.pv, maxValue, COLORS.blue);
    hitTargets.push({
      id: "pv",
      label: "PV",
      unit: "kWh/h",
      type: "bar",
      x: x + 2,
      y: rect.y + rect.h - (hour.pv / maxValue) * rect.h,
      w: barWidth - 4,
      h: (hour.pv / maxValue) * rect.h,
      hour: hour.hour,
      value: hour.pv
    });
  });

  const series = [
    { id: "load", label: "Load", color: COLORS.vermillion, unit: "kWh/h", points: day.hours.map(hour => [hour.hour, hour.load]) },
    { id: "export", label: "Export", color: COLORS.navy, unit: "kWh/h", points: day.hours.map(hour => [hour.hour, hour.exportKwh]) }
  ];
  series.forEach(item => {
    if (!isVisible(item.id)) return;
    drawSeriesLine(ctx, rect, item.points, maxValue, item.color);
    hitTargets.push({
      id: item.id,
      label: item.label,
      unit: item.unit,
      type: "line",
      points: mapSeriesPoints(rect, item.points, maxValue),
      values: item.points
    });
  });

  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  [0, 6, 12, 18, 23].forEach(hour => {
    const x = rect.x + hour * barWidth + barWidth / 2;
    ctx.fillText(`${hour}:00`, x, rect.y + rect.h + 24);
  });

  const legendBoxes = drawLegend(ctx, [
    { id: "pv", color: COLORS.blue, label: "PV", disabled: !isVisible("pv") },
    { id: "load", color: COLORS.vermillion, label: "Load", disabled: !isVisible("load") },
    { id: "export", color: COLORS.navy, label: "Export", disabled: !isVisible("export") }
  ], rect.x, 16);

  bindSeriesInteractions(canvas, legendBoxes, hitTargets, onToggleSeries);
}

/**
 * Render selected-day battery state of charge.
 * The visible series can be toggled through the legend, and the line itself is tooltip-only.
 */
export function renderBatteryChart(canvas, day, hiddenSeries = new Set(), onToggleSeries = () => {}) {
  const ctx = setupCanvas(canvas);
  const rect = chartRect(ctx.canvas, 42, 28, 34, 20);
  const points = day.hours.map(hour => [hour.hour, hour.batteryPercent || 0]);
  const isVisible = id => !hiddenSeries.has(id);
  const hitTargets = [];

  drawGrid(ctx, rect, 4, value => `${formatNumber((100 * value) / 4, 0)}%`);
  if (isVisible("battery")) {
    drawSeriesLine(ctx, rect, points, 100, COLORS.battery, 4);
    hitTargets.push({
      id: "battery",
      label: "Battery charge",
      unit: "%",
      type: "line",
      points: mapSeriesPoints(rect, points, 100),
      values: points
    });
  }
  const legendBoxes = drawLegend(ctx, [
    { id: "battery", color: COLORS.battery, label: "Battery charge %", disabled: !isVisible("battery") }
  ], rect.x, 16);
  drawTimeLabels(ctx, rect, rect.y + rect.h + 24);

  bindSeriesInteractions(canvas, legendBoxes, hitTargets, onToggleSeries);
}

/**
 * Render selected-day generation and weather.
 * The top panel shows PV-related series. The lower panel uses left axis for cloud percentage
 * and right axis for temperature, with rain shown as hourly bars.
 */
export function renderGenerationWeatherChart(canvas, day, hiddenSeries = new Set(), onToggleSeries = () => {}) {
  canvas.dataset.hiddenSeries = Array.from(hiddenSeries).sort().join(",");
  const ctx = setupCanvas(canvas);
  const top = chartRect(ctx.canvas, 44, 66, 134, 46);
  const bottom = {
    x: top.x,
    y: top.y + top.h + 34,
    w: top.w,
    h: 78
  };
  const maxPv = Math.max(1, ...day.hours.flatMap(hour => [
    hour.pv,
    hour.deliveredPv,
    hour.curtailed
  ])) * 1.18;
  const maxRain = Math.max(2, ...day.hours.map(hour => hour.precipitation || 0)) * 1.15;
  const isVisible = id => !hiddenSeries.has(id);

  drawGrid(ctx, top, 4, value => `${formatNumber((maxPv * value) / 4, 1)}`);
  drawGrid(ctx, bottom, 2, value => `${formatNumber((100 * value) / 2, 0)}%`);
  drawRightAxis(ctx, bottom, 2, value => `${formatNumber((40 * value) / 2, 0)}`);

  const hitTargets = [];
  const lineSeries = [
    {
      id: "rooftop",
      label: "Rooftop PV",
      color: COLORS.blue,
      rect: top,
      max: maxPv,
      width: 3,
      unit: "kWh/h",
      points: day.hours.map(hour => [hour.hour, hour.pv])
    },
    {
      id: "delivered",
      label: "After curtailment",
      color: COLORS.navy,
      rect: top,
      max: maxPv,
      width: 3,
      unit: "kWh/h",
      points: day.hours.map(hour => [hour.hour, hour.deliveredPv])
    },
    {
      id: "curtailed",
      label: "Curtailed",
      color: COLORS.vermillion,
      rect: top,
      max: maxPv,
      width: 2,
      unit: "kWh/h",
      points: day.hours.map(hour => [hour.hour, hour.curtailed])
    },
    {
      id: "cloud",
      label: "Cloud %",
      color: COLORS.grey,
      rect: bottom,
      max: 100,
      width: 2,
      unit: "%",
      points: day.hours.map(hour => [hour.hour, hour.cloudCover || 0])
    },
    {
      id: "temperature",
      label: "Temp deg C",
      color: COLORS.yellow,
      rect: bottom,
      max: 40,
      width: 2,
      unit: "deg C",
      points: day.hours.map(hour => [hour.hour, clampWeatherTemp(hour.temperature)])
    }
  ];

  lineSeries.forEach(series => {
    if (!isVisible(series.id)) return;
    drawSeriesLine(ctx, series.rect, series.points, series.max, series.color, series.width);
    hitTargets.push({
      id: series.id,
      label: series.label,
      unit: series.unit,
      type: "line",
      points: mapSeriesPoints(series.rect, series.points, series.max),
      values: series.points
    });
  });

  day.hours.forEach(hour => {
    if (!hour.precipitation || !isVisible("rain")) return;
    const barWidth = bottom.w / 24;
    const x = bottom.x + hour.hour * barWidth + 2;
    const width = Math.max(2, barWidth - 4);
    const height = (hour.precipitation / maxRain) * bottom.h;
    drawBar(ctx, bottom, x, width, hour.precipitation, maxRain, COLORS.black);
    hitTargets.push({
      id: "rain",
      label: "Rain",
      unit: "mm/h",
      type: "bar",
      x,
      y: bottom.y + bottom.h - height,
      w: width,
      h: height,
      hour: hour.hour,
      value: hour.precipitation
    });
  });

  drawTimeLabels(ctx, top, canvasCssHeight(canvas) - 17);
  const legendBoxes = drawLegend(ctx, [
    { id: "rooftop", color: COLORS.blue, label: "Rooftop PV", disabled: !isVisible("rooftop") },
    { id: "delivered", color: COLORS.navy, label: "After curtailment", disabled: !isVisible("delivered") },
    { id: "curtailed", color: COLORS.vermillion, label: "Curtailed", disabled: !isVisible("curtailed") },
    { id: "cloud", color: COLORS.grey, label: "Cloud %", disabled: !isVisible("cloud") },
    { id: "temperature", color: COLORS.yellow, label: "Temp deg C", disabled: !isVisible("temperature") },
    { id: "rain", color: COLORS.black, label: "Rain mm/h", disabled: !isVisible("rain") }
  ], top.x, 16, { maxWidth: canvas.clientWidth - top.x - 12 });

  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("PV", top.x, top.y + top.h + 18);
  drawAxisCaptions(ctx, bottom, "Cloud %", "Temp deg C");

  canvas.onclick = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const legendHit = legendBoxes.find(item => pointInRect(x, y, item));
    if (legendHit) {
      onToggleSeries(legendHit.id);
      return;
    }

    const curveHit = findNearestSeriesHit(x, y, hitTargets);
    if (curveHit) {
      showSeriesTooltip(canvas, curveHit, x, y);
    }
  };

  canvas.onmousemove = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const legendHit = legendBoxes.find(item => pointInRect(x, y, item));
    if (legendHit) {
      canvas.style.cursor = "pointer";
      showToggleTooltip(canvas, legendHit, x, y);
      return;
    }

    const curveHit = findNearestSeriesHit(x, y, hitTargets);
    if (!curveHit) {
      canvas.style.cursor = "default";
      hideTooltip(canvas);
      return;
    }

    canvas.style.cursor = "pointer";
    showSeriesTooltip(canvas, curveHit, x, y);
  };

  canvas.onmouseleave = () => {
    hideTooltip(canvas);
    canvas.style.cursor = "default";
  };
}

function showDailyTooltip(canvas, day, x, y) {
  showTooltip(canvas, x, y, [
    `<strong>${escapeHtml(day.label)}</strong>`,
    `PV: ${formatNumber(day.pv, 1)} kWh`,
    `Value: EUR ${formatNumber(day.totalValue, 2)}`,
    `Saved: EUR ${formatNumber(day.savings, 2)}`,
    `Feed-in: EUR ${formatNumber(day.earnings, 2)}`
  ]);
}

function clampWeatherTemp(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(40, value));
}
