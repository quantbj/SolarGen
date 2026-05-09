import {
  COLORS,
  chartRect,
  drawGrid,
  drawLegend,
  drawSeriesLine,
  drawTimeLabels,
  setupCanvas
} from '/shared/chartCore.js';

const state = { comparisons: [], selectedId: null, detail: null };
const els = {
  captureBtn: document.getElementById('captureBtn'),
  actualForm: document.getElementById('actualForm'),
  actualDate: document.getElementById('actualDate'),
  actualDateText: document.getElementById('actualDateText'),
  actualTotal: document.getElementById('actualTotal'),
  actualHourly: document.getElementById('actualHourly'),
  actualNotes: document.getElementById('actualNotes'),
  message: document.getElementById('message'),
  runSelect: document.getElementById('runSelect'),
  rows: document.getElementById('rows'),
  summary: document.getElementById('summary'),
  chart: document.getElementById('profileChart')
};

init();

async function init() {
  els.captureBtn.addEventListener('click', captureForecast);
  els.actualForm.addEventListener('submit', saveActuals);
  els.runSelect.addEventListener('change', () => selectRun(Number(els.runSelect.value)));
  els.actualDate.addEventListener('change', () => syncDateText(els.actualDate.value));
  els.actualDateText.addEventListener('input', () => syncNativeDate(els.actualDateText.value));
  await loadComparisons();
}

async function captureForecast() {
  setMessage('Fetching Open-Meteo and saving day-ahead forecast...');
  try {
    await fetchJson('/api/capture', { method: 'POST', body: '{}' });
    setMessage('Saved day-ahead forecast snapshot.');
    await loadComparisons();
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function saveActuals(event) {
  event.preventDefault();
  try {
    await fetchJson('/api/actuals', {
      method: 'POST',
      body: JSON.stringify({
        date: normalizedDateInput(),
        total_kwh: els.actualTotal.value,
        hourly: els.actualHourly.value,
        source: 'manual',
        notes: els.actualNotes.value
      })
    });
    setMessage('Saved actual generation.');
    await loadComparisons();
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function loadComparisons() {
  state.comparisons = await fetchJson('/api/comparisons');
  if (!state.selectedId && state.comparisons.length) state.selectedId = state.comparisons[0].id;
  renderTable();
  renderSelect();
  if (state.selectedId) await selectRun(state.selectedId);
  else renderEmpty();
}

async function selectRun(id) {
  state.selectedId = id;
  state.detail = await fetchJson(`/api/forecast?id=${id}`);
  if (state.detail?.run?.target_date) setActualDate(state.detail.run.target_date);
  renderTable();
  renderSelect();
  renderSummary();
  renderChart();
}


function setActualDate(value) {
  const normalized = dateOnly(value);
  els.actualDate.value = normalized;
  syncDateText(normalized);
}

function syncDateText(value) {
  els.actualDateText.value = dateOnly(value);
}

function syncNativeDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    els.actualDate.value = value;
  }
}

function normalizedDateInput() {
  const value = els.actualDateText.value.trim() || els.actualDate.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Use date format yyyy-mm-dd.');
  }
  els.actualDate.value = value;
  return value;
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function renderSelect() {
  els.runSelect.innerHTML = state.comparisons.map(item => `<option value="${item.id}">${dateOnly(item.target_date)} from ${dateOnly(item.issued_date)}</option>`).join('') || '<option>No forecasts</option>';
  els.runSelect.disabled = !state.comparisons.length;
  if (state.selectedId) els.runSelect.value = String(state.selectedId);
}

function renderTable() {
  els.rows.innerHTML = state.comparisons.map(item => `
    <tr class="${item.id === state.selectedId ? 'selected' : ''}" data-id="${item.id}" tabindex="0">
      <td>${dateOnly(item.issued_date)}</td>
      <td>${dateOnly(item.target_date)}</td>
      <td>${fmt(item.forecast_total_kwh, 1)}</td>
      <td>${item.actual_total_kwh == null ? '--' : fmt(item.actual_total_kwh, 1)}</td>
      <td>${item.error_kwh == null ? '--' : signed(item.error_kwh, 1)}</td>
      <td>${item.error_pct == null ? '--' : signed(item.error_pct, 1) + '%'}</td>
      <td>${item.hourly_rmse_kwh == null ? '--' : fmt(item.hourly_rmse_kwh, 2)}</td>
      <td>${item.hourly_points}</td>
    </tr>`).join('');
  els.rows.querySelectorAll('tr').forEach(row => row.addEventListener('click', () => selectRun(Number(row.dataset.id))));
}

function renderSummary() {
  const c = state.detail.comparison;
  els.summary.innerHTML = `
    <div class="metric"><span>Forecast</span><strong>${fmt(c.forecast_total_kwh, 1)} kWh</strong></div>
    <div class="metric"><span>Actual</span><strong>${c.actual_total_kwh == null ? '--' : fmt(c.actual_total_kwh, 1) + ' kWh'}</strong></div>
    <div class="metric"><span>Total error</span><strong>${c.error_kwh == null ? '--' : signed(c.error_kwh, 1) + ' kWh'}</strong></div>
    <div class="metric"><span>Hourly RMSE</span><strong>${c.hourly_rmse_kwh == null ? '--' : fmt(c.hourly_rmse_kwh, 2) + ' kWh'}</strong></div>`;
}

function renderEmpty() {
  els.summary.innerHTML = '<p>Capture a day-ahead forecast to start the local history.</p>';
  drawChart([], []);
}

function renderChart() {
  const forecast = state.detail.hours.map(hour => hour.forecast_kwh);
  const actual = Array(24).fill(null);
  for (const row of state.detail.actual_hours || []) actual[row.hour] = row.generation_kwh;
  drawChart(forecast, actual);
}

function drawChart(forecast, actual) {
  const canvas = els.chart;
  const ctx = setupCanvas(canvas);
  const rect = chartRect(canvas, 44, 28, 38, 24);
  const max = Math.max(1, ...forecast, ...actual.filter(Number.isFinite)) * 1.2;
  drawGrid(ctx, rect, 4, step => fmt(max * step / 4, 1));
  drawSeriesLine(ctx, rect, forecast.map((value, hour) => [hour, value]), max, COLORS.blue, 3);
  if (actual.some(Number.isFinite)) {
    drawSeriesLine(ctx, rect, actual.map((value, hour) => [hour, value ?? 0]), max, COLORS.purple, 3);
  }
  drawTimeLabels(ctx, rect, rect.y + rect.h + 26);
  drawLegend(ctx, [
    { id: 'forecast', color: COLORS.blue, label: 'Forecast' },
    { id: 'actual', color: COLORS.purple, label: 'Actual', disabled: !actual.some(Number.isFinite) }
  ], rect.x, 16);
}
async function fetchJson(url, options = {}) { let res; try { res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options }); } catch (error) { throw new Error('Cannot reach the local SolarGen history server. Start it with: python3 -m history_app.server'); } const data = await res.json(); if (!res.ok) throw new Error(data.error || res.statusText); return data; }
function setMessage(text, error = false) { els.message.textContent = text; els.message.classList.toggle('error', error); }
function fmt(value, decimals) { return Number(value).toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
function signed(value, decimals) { return `${value > 0 ? '+' : ''}${fmt(value, decimals)}`; }
