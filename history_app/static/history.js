import {
  captureForecast as postCaptureForecast,
  fetchComparisons,
  fetchEcoflowTicks,
  fetchForecast,
  saveActuals as postActuals
} from './historyApi.js';
import {
  renderEmptyForecast,
  renderForecastChart,
  renderForecastSelect,
  renderForecastSummary,
  renderForecastTable
} from './forecastView.js';
import { renderEcoflow, renderEcoflowError } from './ecoflowView.js';
import { dateOnly, todayDate } from './historyFormat.js';

const ECOFLOW_REFRESH_MS = 60_000;
const state = {
  comparisons: [],
  selectedId: null,
  detail: null,
  ecoflow: null,
  refreshingEcoflow: false
};

const els = {
  captureBtn: document.getElementById('captureBtn'),
  captureTodayBtn: document.getElementById('captureTodayBtn'),
  captureDwdBtn: document.getElementById('captureDwdBtn'),
  captureDwdTodayBtn: document.getElementById('captureDwdTodayBtn'),
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
  chart: document.getElementById('profileChart'),
  ecoflowDate: document.getElementById('ecoflowDate'),
  ecoflowSummary: document.getElementById('ecoflowSummary'),
  ecoflowChart: document.getElementById('ecoflowChart')
};

init();

async function init() {
  els.captureBtn.addEventListener('click', () => captureForecast('/api/capture', 'Fetching Open-Meteo and saving day-ahead forecast...', 'Saved Open-Meteo day-ahead forecast snapshot.'));
  els.captureTodayBtn.addEventListener('click', () => captureForecast('/api/capture-today', 'Fetching Open-Meteo and saving same-day forecast...', 'Saved same-day forecast snapshot.'));
  els.captureDwdBtn.addEventListener('click', () => captureForecast('/api/capture-dwd', 'Fetching DWD MOSMIX and saving day-ahead forecast...', 'Saved DWD day-ahead forecast snapshot.'));
  els.captureDwdTodayBtn.addEventListener('click', () => captureForecast('/api/capture-dwd-today', 'Fetching DWD MOSMIX and saving same-day composite forecast...', 'Saved DWD same-day forecast snapshot.'));
  els.actualForm.addEventListener('submit', saveActuals);
  els.runSelect.addEventListener('change', () => selectRun(Number(els.runSelect.value)));
  els.actualDate.addEventListener('change', () => syncDateText(els.actualDate.value));
  els.actualDateText.addEventListener('input', () => syncNativeDate(els.actualDateText.value));
  await loadComparisons();
  window.setInterval(refreshEcoflowData, ECOFLOW_REFRESH_MS);
}

async function captureForecast(path, pendingMessage, successMessage) {
  setMessage(pendingMessage);
  try {
    await postCaptureForecast(path);
    setMessage(successMessage);
    await loadComparisons();
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function saveActuals(event) {
  event.preventDefault();
  try {
    await postActuals({
      date: normalizedDateInput(),
      total_kwh: els.actualTotal.value,
      hourly: els.actualHourly.value,
      source: 'manual',
      notes: els.actualNotes.value
    });
    setMessage('Saved actual generation.');
    await loadComparisons();
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function loadComparisons() {
  state.comparisons = await fetchComparisons();
  if (!state.selectedId && state.comparisons.length) state.selectedId = state.comparisons[0].id;
  renderForecastTable(els.rows, state.comparisons, state.selectedId, selectRun);
  renderForecastSelect(els.runSelect, state.comparisons, state.selectedId);
  if (state.selectedId) {
    await selectRun(state.selectedId);
  } else {
    renderEmptyForecast(els.summary, els.chart);
    await loadEcoflowTicks(todayDate());
  }
}

async function selectRun(id) {
  state.selectedId = id;
  state.detail = await fetchForecast(id);
  if (state.detail?.run?.target_date) setActualDate(state.detail.run.target_date);
  await loadEcoflowTicks(dateOnly(state.detail?.run?.target_date) || todayDate());
  renderForecastTable(els.rows, state.comparisons, state.selectedId, selectRun);
  renderForecastSelect(els.runSelect, state.comparisons, state.selectedId);
  renderSelectedForecast();
}

async function loadEcoflowTicks(date) {
  try {
    state.ecoflow = await fetchEcoflowTicks(date);
    renderEcoflow(els.ecoflowDate, els.ecoflowSummary, els.ecoflowChart, state.ecoflow);
  } catch (error) {
    state.ecoflow = null;
    renderEcoflowError(els.ecoflowSummary, els.ecoflowChart, error.message);
  }
}

async function refreshEcoflowData() {
  if (state.refreshingEcoflow) return;
  const date = dateOnly(state.detail?.run?.target_date) || state.ecoflow?.date || todayDate();
  state.refreshingEcoflow = true;
  try {
    await loadEcoflowTicks(date);
    if (state.detail) renderSelectedForecast();
  } finally {
    state.refreshingEcoflow = false;
  }
}

function renderSelectedForecast() {
  renderForecastSummary(els.summary, state.detail, state.ecoflow);
  renderForecastChart(els.chart, state.detail, state.ecoflow);
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

function setMessage(text, error = false) {
  els.message.textContent = text;
  els.message.classList.toggle('error', error);
}
