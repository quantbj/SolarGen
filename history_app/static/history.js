const state = { comparisons: [], selectedId: null, detail: null };
const els = {
  captureBtn: document.getElementById('captureBtn'),
  actualForm: document.getElementById('actualForm'),
  actualDate: document.getElementById('actualDate'),
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
        date: els.actualDate.value,
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
  if (state.detail?.run?.target_date) els.actualDate.value = state.detail.run.target_date;
  renderTable();
  renderSelect();
  renderSummary();
  renderChart();
}

function renderSelect() {
  els.runSelect.innerHTML = state.comparisons.map(item => `<option value="${item.id}">${item.target_date} from ${item.issued_date}</option>`).join('') || '<option>No forecasts</option>';
  els.runSelect.disabled = !state.comparisons.length;
  if (state.selectedId) els.runSelect.value = String(state.selectedId);
}

function renderTable() {
  els.rows.innerHTML = state.comparisons.map(item => `
    <tr class="${item.id === state.selectedId ? 'selected' : ''}" data-id="${item.id}" tabindex="0">
      <td>${item.issued_date}</td>
      <td>${item.target_date}</td>
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
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = Number(canvas.getAttribute('height'));
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const rect = { x: 44, y: 28, w: width - 68, h: height - 66 };
  const max = Math.max(1, ...forecast, ...actual.filter(Number.isFinite)) * 1.2;
  ctx.strokeStyle = '#d9dfd8'; ctx.fillStyle = '#66716a'; ctx.font = '12px system-ui'; ctx.textAlign = 'right';
  for (let step = 0; step <= 4; step++) {
    const y = rect.y + rect.h - rect.h * step / 4;
    ctx.beginPath(); ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.w, y); ctx.stroke();
    ctx.fillText(fmt(max * step / 4, 1), rect.x - 8, y + 4);
  }
  line(ctx, rect, forecast.map((value, hour) => [hour, value]), max, '#0072b2', 3);
  if (actual.some(Number.isFinite)) line(ctx, rect, actual.map((value, hour) => [hour, value ?? 0]), max, '#cc79a7', 3);
  ctx.textAlign = 'center'; ctx.fillStyle = '#66716a';
  [0, 6, 12, 18, 23].forEach(hour => ctx.fillText(`${hour}:00`, rect.x + rect.w * hour / 23, rect.y + rect.h + 26));
  legend(ctx, rect.x, 16, '#0072b2', 'Forecast'); legend(ctx, rect.x + 112, 16, '#cc79a7', 'Actual');
}

function line(ctx, rect, points, max, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  points.forEach(([hour, value], index) => {
    const x = rect.x + rect.w * hour / 23;
    const y = rect.y + rect.h - rect.h * value / max;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function legend(ctx, x, y, color, label) { ctx.fillStyle = color; ctx.fillRect(x, y - 8, 12, 12); ctx.fillStyle = '#66716a'; ctx.textAlign = 'left'; ctx.fillText(label, x + 18, y + 2); }
async function fetchJson(url, options = {}) { const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options }); const data = await res.json(); if (!res.ok) throw new Error(data.error || res.statusText); return data; }
function setMessage(text, error = false) { els.message.textContent = text; els.message.classList.toggle('error', error); }
function fmt(value, decimals) { return Number(value).toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
function signed(value, decimals) { return `${value > 0 ? '+' : ''}${fmt(value, decimals)}`; }
