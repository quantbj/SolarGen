import {
  COLORS,
  chartRect,
  drawAxisCaptions,
  drawGrid,
  drawRightAxis,
  escapeHtml,
  findNearestSeriesHit,
  hideTooltip,
  showTooltip,
  setupCanvas
} from '/shared/chartCore.js';
import { drawBoxedLegend, legendPanelMetrics } from './historyCharts.js';
import { cleanPowerAxisMax, formatMinuteOfDay } from './historyChartMath.js';
import { fmt, metric } from './historyFormat.js';

export function renderEcoflow(dateElement, summaryElement, canvas, data) {
  const summary = data?.summary || {};
  const ticks = data?.ticks || [];
  dateElement.textContent = data ? `${data.date} · ${data.tick_count} ticks` : '';
  summaryElement.innerHTML = [
    metric('Estimated generation', `${fmt(summary.generation_kwh || 0, 2)} kWh`),
    metric('Latest solar', summary.latest_solar_power_w == null ? '--' : `${fmt(summary.latest_solar_power_w, 0)} W`),
    metric('Latest battery', summary.latest_battery_soc_percent == null ? '--' : `${fmt(summary.latest_battery_soc_percent, 0)}%`)
  ].join('');
  drawEcoflowChart(canvas, ticks);
}

export function renderEcoflowError(summaryElement, canvas, message) {
  summaryElement.innerHTML = `<p>${escapeHtml(message)}</p>`;
  drawEcoflowChart(canvas, []);
}

export function drawEcoflowChart(canvas, ticks) {
  const ctx = setupCanvas(canvas);
  const left = 54;
  const right = 48;
  const legendItems = [
    { id: 'solar', color: COLORS.blue, label: 'Solar power', disabled: !ticks.some(tick => Number.isFinite(Number(tick.solar_power_w))) },
    { id: 'battery', color: COLORS.vermillion, label: 'Battery SOC', disabled: !ticks.some(tick => Number.isFinite(Number(tick.battery_soc_percent))) }
  ];
  const legend = legendPanelMetrics(ctx, legendItems, canvas.clientWidth - left - right);
  const rect = chartRect(canvas, left, 52, 58 + legend.height + 18, right);
  const solar = ticks
    .filter(tick => Number.isFinite(Number(tick.solar_power_w)))
    .map(tick => [minuteOfDay(tick.received_at), Number(tick.solar_power_w)]);
  const battery = ticks
    .filter(tick => Number.isFinite(Number(tick.battery_soc_percent)))
    .map(tick => [minuteOfDay(tick.received_at), Number(tick.battery_soc_percent)]);
  const powerAxisSteps = 4;
  const maxPower = cleanPowerAxisMax(solar.map(point => point[1]), powerAxisSteps);
  drawGrid(ctx, rect, powerAxisSteps, step => fmt(maxPower * step / powerAxisSteps, 0));
  drawRightAxis(ctx, rect, powerAxisSteps, step => `${fmt(100 * step / powerAxisSteps, 0)}%`);
  drawAxisCaptions(ctx, rect, 'Power (W)', 'Battery SOC');
  drawMinuteLine(ctx, rect, solar, maxPower, COLORS.blue, 3);
  drawMinuteLine(ctx, rect, battery, 100, COLORS.vermillion, 3);
  drawMinuteLabels(ctx, rect);
  drawBoxedLegend(ctx, legendItems, rect.x, rect.y + rect.h + 42, rect.w);
  bindEcoflowTooltips(canvas, rect, solar, battery, maxPower);
  if (!ticks.length) {
    ctx.fillStyle = '#66716a';
    ctx.font = '14px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No EcoFlow ticks stored for this date yet.', rect.x + rect.w / 2, rect.y + rect.h / 2);
  }
}

function bindEcoflowTooltips(canvas, rect, solar, battery, maxPower) {
  const targets = [
    {
      id: 'solar',
      label: 'Solar power',
      unit: 'W',
      type: 'line',
      points: mapMinutePoints(rect, solar, maxPower),
      values: solar
    },
    {
      id: 'battery',
      label: 'Battery SOC',
      unit: '%',
      type: 'line',
      points: mapMinutePoints(rect, battery, 100),
      values: battery
    }
  ].filter(target => target.values.length);

  canvas.onmousemove = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const hit = findNearestSeriesHit(x, y, targets);
    if (!hit) {
      canvas.style.cursor = 'default';
      hideTooltip(canvas);
      return;
    }
    canvas.style.cursor = 'pointer';
    showEcoflowTooltip(canvas, hit, x, y);
  };

  canvas.onmouseleave = () => {
    canvas.style.cursor = 'default';
    hideTooltip(canvas);
  };
}

function mapMinutePoints(rect, points, maxValue) {
  return points.map(([minute, value]) => [
    rect.x + (minute / 1439) * rect.w,
    rect.y + rect.h - (value / maxValue) * rect.h
  ]);
}

function showEcoflowTooltip(canvas, hit, x, y) {
  showTooltip(canvas, x, y, [
    `<strong>${escapeHtml(hit.label)}</strong>`,
    `${formatMinuteOfDay(hit.hour)}: ${fmt(hit.value, 0)} ${hit.unit}`
  ]);
}

function drawMinuteLine(ctx, rect, points, maxValue, color, lineWidth) {
  if (!points.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  points.forEach(([minute, value], index) => {
    const x = rect.x + (minute / 1439) * rect.w;
    const y = rect.y + rect.h - (value / maxValue) * rect.h;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawMinuteLabels(ctx, rect) {
  ctx.fillStyle = '#66716a';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  [0, 360, 720, 1080, 1439].forEach(minute => {
    const x = rect.x + (minute / 1439) * rect.w;
    const hour = Math.floor(minute / 60);
    ctx.fillText(`${hour}:00`, x, rect.y + rect.h + 26);
  });
}

function minuteOfDay(value) {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}
