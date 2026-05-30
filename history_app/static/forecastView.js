import {
  COLORS,
  chartRect,
  drawGrid,
  drawSeriesLine,
  drawTimeLabels,
  setupCanvas
} from '/shared/chartCore.js';
import { drawBoxedLegend, legendPanelMetrics } from './historyCharts.js';
import { dateOnly, escapeHtml, fmt, metric, signed, simpleLabel, sourceLabel } from './historyFormat.js';

export function renderForecastSelect(select, comparisons, selectedId) {
  select.innerHTML = comparisons.map(item => {
    const label = `${dateOnly(item.target_date)} from ${dateOnly(item.issued_date)} (${sourceLabel(item.source)})`;
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('') || '<option>No forecasts</option>';
  select.disabled = !comparisons.length;
  if (selectedId) select.value = String(selectedId);
}

export function renderForecastTable(rows, comparisons, selectedId, onSelect) {
  rows.innerHTML = comparisons.map(item => `
    <tr class="${item.id === selectedId ? 'selected' : ''}" data-id="${item.id}" tabindex="0">
      <td>${escapeHtml(dateOnly(item.issued_date))}</td>
      <td>${escapeHtml(dateOnly(item.target_date))}</td>
      <td>${escapeHtml(sourceLabel(item.source))}</td>
      <td>${fmt(item.forecast_total_kwh, 1)}</td>
      <td>${item.simple_forecast_total_kwh == null ? '--' : fmt(item.simple_forecast_total_kwh, 1)}</td>
      <td>${item.actual_total_kwh == null ? '--' : fmt(item.actual_total_kwh, 1)}</td>
      <td>${item.error_kwh == null ? '--' : signed(item.error_kwh, 1)}</td>
      <td>${item.simple_error_kwh == null ? '--' : signed(item.simple_error_kwh, 1)}</td>
      <td>${item.error_pct == null ? '--' : signed(item.error_pct, 1) + '%'}</td>
      <td>${item.simple_error_pct == null ? '--' : signed(item.simple_error_pct, 1) + '%'}</td>
      <td>${item.hourly_rmse_kwh == null ? '--' : fmt(item.hourly_rmse_kwh, 2)}</td>
      <td>${item.hourly_points}</td>
    </tr>`).join('');
  rows.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', () => onSelect(Number(row.dataset.id)));
  });
}

export function renderForecastSummary(container, detail, ecoflow) {
  const comparison = detail.comparison;
  const ecoflowGeneration = ecoflow?.summary?.generation_kwh;
  const isProduction = comparison.source === 'Production blend day-ahead';
  container.innerHTML = [
    metric(isProduction ? 'Production forecast' : 'Source/input', `${fmt(comparison.forecast_total_kwh, 1)} kWh`),
    metric(simpleLabel(comparison.source), comparison.simple_forecast_total_kwh == null ? '--' : `${fmt(comparison.simple_forecast_total_kwh, 1)} kWh`),
    metric('Source', sourceLabel(comparison.source)),
    metric('Actual', comparison.actual_total_kwh == null ? '--' : `${fmt(comparison.actual_total_kwh, 1)} kWh`),
    metric('EcoFlow', ecoflowGeneration == null ? '--' : `${fmt(ecoflowGeneration, 2)} kWh`),
    metric(isProduction ? 'Production error' : 'Input error', comparison.error_kwh == null ? '--' : `${signed(comparison.error_kwh, 1)} kWh`),
    metric('Blend error', comparison.simple_error_kwh == null ? '--' : `${signed(comparison.simple_error_kwh, 1)} kWh`),
    metric('Hourly RMSE', comparison.hourly_rmse_kwh == null ? '--' : `${fmt(comparison.hourly_rmse_kwh, 2)} kWh`)
  ].join('');
}

export function renderEmptyForecast(container, canvas) {
  container.innerHTML = '<p>Capture a day-ahead forecast to start the local history.</p>';
  drawForecastChart(canvas, null, [], [], [], []);
}

export function renderForecastChart(canvas, detail, ecoflow) {
  const forecast = detail.hours.map(hour => hour.forecast_kwh);
  const simple = simpleHourlyForecast(forecast, detail.comparison?.simple_forecast_total_kwh);
  const actual = Array(24).fill(null);
  for (const row of detail.actual_hours || []) actual[row.hour] = row.generation_kwh;
  const ecoflowHourly = Array.isArray(ecoflow?.hourly_generation_kwh)
    ? ecoflow.hourly_generation_kwh.map(value => value == null ? null : Number(value))
    : [];
  drawForecastChart(canvas, detail, forecast, simple, actual, ecoflowHourly);
}

function simpleHourlyForecast(forecast, simpleTotal) {
  if (simpleTotal == null) return [];
  const currentTotal = forecast.reduce((total, value) => total + value, 0);
  if (!currentTotal) return Array(24).fill(0);
  const scale = simpleTotal / currentTotal;
  return forecast.map(value => value * scale);
}

function drawForecastChart(canvas, detail, forecast, simple, actual, ecoflow) {
  const ctx = setupCanvas(canvas);
  const ecoflowValues = ecoflow.filter(Number.isFinite);
  const left = 44;
  const right = 24;
  const legendItems = [
    { id: 'forecast', color: COLORS.blue, label: detail?.comparison?.source === 'Production blend day-ahead' ? 'Production forecast' : 'Source/input' },
    { id: 'simple', color: COLORS.vermillion, label: simpleLabel(detail?.comparison?.source), disabled: !simple.length },
    { id: 'actual', color: COLORS.purple, label: 'Manual actual', disabled: !actual.some(Number.isFinite) },
    { id: 'ecoflow', color: COLORS.black, label: 'EcoFlow generation', disabled: !ecoflowValues.length }
  ];
  const legend = legendPanelMetrics(ctx, legendItems, canvas.clientWidth - left - right);
  const rect = chartRect(canvas, left, 10 + legend.height + 28, 38, right);
  const max = Math.max(1, ...forecast, ...simple, ...actual.filter(Number.isFinite), ...ecoflowValues) * 1.2;
  drawGrid(ctx, rect, 4, step => fmt(max * step / 4, 1));
  drawSeriesLine(ctx, rect, forecast.map((value, hour) => [hour, value]), max, COLORS.blue, 3);
  if (simple.length) drawSeriesLine(ctx, rect, simple.map((value, hour) => [hour, value]), max, COLORS.vermillion, 3);
  if (actual.some(Number.isFinite)) drawSeriesLine(ctx, rect, actual.map((value, hour) => [hour, value ?? 0]), max, COLORS.purple, 3);
  if (ecoflowValues.length) drawSeriesLine(ctx, rect, ecoflow.map((value, hour) => [hour, value ?? 0]), max, COLORS.black, 3);
  drawTimeLabels(ctx, rect, rect.y + rect.h + 26);
  drawBoxedLegend(ctx, legendItems, rect.x, 10, rect.w);
}
