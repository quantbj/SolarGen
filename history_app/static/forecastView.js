import {
  COLORS,
  chartRect,
  drawGrid,
  drawSeriesLine,
  drawTimeLabels,
  setupCanvas
} from '/shared/chartCore.js';
import { drawBoxedLegend, legendPanelMetrics } from './historyCharts.js';
import { dateOnly, escapeHtml, fmt, metric, signed, sourceLabel } from './historyFormat.js';

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
      <td>${item.simple_forecast_total_kwh == null ? '--' : fmt(item.simple_forecast_total_kwh, 1)}</td>
      <td>${item.curtailed_total_kwh == null ? '--' : fmt(item.curtailed_total_kwh, 1)}</td>
      <td>${item.theoretical_total_kwh == null ? '--' : fmt(item.theoretical_total_kwh, 1)}</td>
      <td>${comparisonActual(item) == null ? '--' : fmt(comparisonActual(item), 1)}</td>
      <td>${item.ignored_actual_above_cap_kwh == null ? '--' : fmt(item.ignored_actual_above_cap_kwh, 1)}</td>
      <td>${item.actual_total_kwh == null ? '--' : fmt(item.actual_total_kwh, 1)}</td>
      <td>${item.simple_error_kwh == null ? '--' : signed(item.simple_error_kwh, 1)}</td>
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
  const rawActual = comparison.actual_total_kwh;
  const ignored = Number(comparison.ignored_actual_above_cap_kwh || 0);
  const metrics = [
    metric('Forecast <= cap', comparison.forecast_total_kwh == null ? '--' : `${fmt(comparison.forecast_total_kwh, 1)} kWh`),
    metric('Modeled above cap', comparison.curtailed_total_kwh == null ? '--' : `${fmt(comparison.curtailed_total_kwh, 1)} kWh`),
    metric('Theoretical forecast', comparison.theoretical_total_kwh == null ? '--' : `${fmt(comparison.theoretical_total_kwh, 1)} kWh`),
    metric('Source', sourceLabel(comparison.source)),
    metric('Actual <= cap', comparisonActual(comparison) == null ? '--' : `${fmt(comparisonActual(comparison), 1)} kWh`),
    metric('Above cap', comparison.actual_total_kwh == null ? '--' : `${fmt(ignored, 1)} kWh`),
    metric('Raw actual', rawActual == null ? '--' : `${fmt(rawActual, 1)} kWh`),
    metric('EcoFlow', ecoflowGeneration == null ? '--' : `${fmt(ecoflowGeneration, 2)} kWh`),
    metric('Production error', comparison.simple_error_kwh == null ? '--' : `${signed(comparison.simple_error_kwh, 1)} kWh`),
    metric('Hourly RMSE', comparison.hourly_rmse_kwh == null ? '--' : `${fmt(comparison.hourly_rmse_kwh, 2)} kWh`)
  ];
  container.innerHTML = metrics.join('');
}

export function renderEmptyForecast(container, canvas) {
  container.innerHTML = '<p>Capture a day-ahead forecast to start the local history.</p>';
  drawForecastChart(canvas, null, [], [], [], [], [], 6.1, []);
}

export function renderForecastChart(canvas, detail, ecoflow) {
  const forecast = detail.hours.map(hour => hour.forecast_kwh);
  const theoretical = detail.hours.map(hour => hour.theoretical_kwh);
  const simple = simpleHourlyForecast(forecast, detail.comparison?.simple_forecast_total_kwh);
  const hourlyCap = Number(detail.comparison?.forecastable_hourly_cap_kwh || 6.1);
  const actual = Array(24).fill(null);
  const rawActual = Array(24).fill(null);
  for (const row of detail.actual_hours || []) {
    rawActual[row.hour] = row.generation_kwh;
    actual[row.hour] = Math.min(row.generation_kwh, hourlyCap);
  }
  const ecoflowHourly = Array.isArray(ecoflow?.hourly_generation_kwh)
    ? ecoflow.hourly_generation_kwh.map(value => value == null ? null : Number(value))
    : [];
  drawForecastChart(canvas, detail, forecast, theoretical, simple, actual, rawActual, hourlyCap, ecoflowHourly);
}

function simpleHourlyForecast(forecast, simpleTotal) {
  if (simpleTotal == null) return [];
  const currentTotal = forecast.reduce((total, value) => total + value, 0);
  if (!currentTotal) return Array(24).fill(0);
  const scale = simpleTotal / currentTotal;
  return forecast.map(value => value * scale);
}

function drawForecastChart(canvas, detail, forecast, theoretical, simple, actual, rawActual, hourlyCap, ecoflow) {
  const ctx = setupCanvas(canvas);
  const ecoflowValues = ecoflow.filter(Number.isFinite);
  const rawActualValues = rawActual.filter(Number.isFinite);
  const hasAboveCap = rawActual.some(value => Number.isFinite(value) && value > hourlyCap);
  const left = 44;
  const right = 24;
  const legendItems = [
    { id: 'simple', color: COLORS.vermillion, label: 'Forecast capped', disabled: !simple.length },
    { id: 'theoretical', color: COLORS.sky, label: 'Forecast theoretical', disabled: !theoretical.length },
    { id: 'actual', color: COLORS.purple, label: 'Actual capped', disabled: !actual.some(Number.isFinite) },
    { id: 'rawActual', color: COLORS.grey, label: 'Actual raw', disabled: !hasAboveCap },
    { id: 'cap', color: COLORS.navy, label: '6.1 cap', disabled: false },
    { id: 'ecoflow', color: COLORS.black, label: 'EcoFlow generation', disabled: !ecoflowValues.length }
  ];
  const legend = legendPanelMetrics(ctx, legendItems, canvas.clientWidth - left - right);
  const rect = chartRect(canvas, left, 10 + legend.height + 28, 38, right);
  const max = Math.max(1, hourlyCap, ...forecast, ...theoretical, ...simple, ...actual.filter(Number.isFinite), ...rawActualValues, ...ecoflowValues) * 1.2;
  drawGrid(ctx, rect, 4, step => fmt(max * step / 4, 1));
  if (theoretical.length) drawSeriesLine(ctx, rect, theoretical.map((value, hour) => [hour, value]), max, COLORS.sky, 2);
  if (simple.length) drawSeriesLine(ctx, rect, simple.map((value, hour) => [hour, value]), max, COLORS.vermillion, 3);
  drawCapLine(ctx, rect, hourlyCap, max);
  if (hasAboveCap) drawSeriesLine(ctx, rect, rawActual.map((value, hour) => [hour, value ?? 0]), max, COLORS.grey, 2);
  if (actual.some(Number.isFinite)) drawSeriesLine(ctx, rect, actual.map((value, hour) => [hour, value ?? 0]), max, COLORS.purple, 3);
  if (ecoflowValues.length) drawSeriesLine(ctx, rect, ecoflow.map((value, hour) => [hour, value ?? 0]), max, COLORS.black, 3);
  drawTimeLabels(ctx, rect, rect.y + rect.h + 26);
  drawBoxedLegend(ctx, legendItems, rect.x, 10, rect.w);
}

function drawCapLine(ctx, rect, cap, max) {
  const y = rect.y + rect.h - (cap / max) * rect.h;
  ctx.save();
  ctx.strokeStyle = COLORS.navy;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(rect.x, y);
  ctx.lineTo(rect.x + rect.w, y);
  ctx.stroke();
  ctx.restore();
}

function comparisonActual(item) {
  return item.forecastable_actual_total_kwh ?? item.actual_total_kwh;
}
