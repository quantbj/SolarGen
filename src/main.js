import { DEFAULTS, LOCATION } from "./config.js";
import { renderBatteryChart, renderDailyChart, renderGenerationWeatherChart, renderHourlyChart } from "./charts.js";
import { simulateForecast } from "./model.js";
import { buildFallbackForecast, fetchOpenMeteoForecast } from "./weather.js";
import { debounce, formatMoney, formatNumber } from "./utils.js";

const state = {
  forecast: null,
  days: [],
  selectedIndex: 0,
  settings: { ...DEFAULTS },
  hiddenSeries: {
    daily: new Set(),
    generationWeather: new Set(),
    hourly: new Set(),
    battery: new Set()
  }
};

const els = {
  forecastStatus: document.getElementById("forecastStatus"),
  updatedAt: document.getElementById("updatedAt"),
  todayGeneration: document.getElementById("todayGeneration"),
  todayWeather: document.getElementById("todayWeather"),
  todaySavings: document.getElementById("todaySavings"),
  todayFeedIn: document.getElementById("todayFeedIn"),
  periodValue: document.getElementById("periodValue"),
  periodBreakdown: document.getElementById("periodBreakdown"),
  forecastMeta: document.getElementById("forecastMeta"),
  dailyChart: document.getElementById("dailyChart"),
  generationWeatherChart: document.getElementById("generationWeatherChart"),
  hourlyChart: document.getElementById("hourlyChart"),
  batteryChart: document.getElementById("batteryChart"),
  daySelect: document.getElementById("daySelect"),
  dayDetails: document.getElementById("dayDetails"),
  forecastRows: document.getElementById("forecastRows"),
  generationWeatherTitle: document.getElementById("generationWeatherTitle"),
  selectedDayTitle: document.getElementById("selectedDayTitle"),
  refreshBtn: document.getElementById("refreshBtn"),
  statusRefreshBtn: document.getElementById("statusRefreshBtn"),
  loadingDetails: document.getElementById("loadingDetails"),
  loadingMessage: document.getElementById("loadingMessage"),
  mainContent: document.getElementById("mainContent")
};

const controls = [
  ["capacity", "capacityValue", value => `${value.toFixed(1)} kWp`],
  ["tilt", "tiltValue", value => `${value.toFixed(0)} deg`],
  ["battery", "batteryValue", value => `${value.toFixed(1)} kWh`],
  ["batteryStart", "batteryStartValue", value => `${value.toFixed(0)}%`],
  ["feedCap", "feedCapValue", value => `${value.toFixed(1)} kW`],
  ["price", "priceValue", value => `${value.toFixed(3)} EUR/kWh`],
  ["tariff", "tariffValue", value => `${value.toFixed(4)} EUR/kWh`],
  ["baseLoad", "baseLoadValue", value => `${value.toFixed(2)} kW`],
  ["dayLoad", "dayLoadValue", value => `${value.toFixed(2)} kW`],
  ["eveningLoad", "eveningLoadValue", value => `${value.toFixed(2)} kW`]
];

/**
 * Wire the app once on page load: controls, refresh buttons, forecast fetch, and resize redraws.
 */
function init() {
  wireControls();
  fetchForecast();
  window.addEventListener("resize", debounce(render, 120));
  els.refreshBtn.addEventListener("click", fetchForecast);
  els.statusRefreshBtn.addEventListener("click", fetchForecast);
  els.daySelect.addEventListener("change", event => {
    state.selectedIndex = Number(event.target.value);
    render();
  });
}

/**
 * Attach all slider controls to model settings.
 * Most controls re-simulate locally; roof tilt also refetches because Open-Meteo returns
 * irradiance for the requested panel tilt.
 */
function wireControls() {
  const refetchForTilt = debounce(fetchForecast, 450);
  controls.forEach(([id, valueId, format]) => {
    const input = document.getElementById(id);
    const output = document.getElementById(valueId);
    input.value = DEFAULTS[id];
    output.textContent = format(Number(input.value));
    input.addEventListener("input", () => {
      state.settings[id] = Number(input.value);
      output.textContent = format(Number(input.value));
      computeAndRender();
      if (id === "tilt") {
        refetchForTilt();
      }
    });
  });
}

/**
 * Fetch live weather, fall back to deterministic local weather when external data is unavailable,
 * then run the shared PV/storage/value simulation.
 */
async function fetchForecast() {
  setStatus("Loading forecast", false);
  setLoading(true, "Preparing Open-Meteo request for OHZ: hourly irradiance, cloud cover, rain, temperature, and weather codes.");
  await waitForPaint();

  try {
    setLoading(true, "Fetching 14-day hourly weather forecast from Open-Meteo.");
    await waitForPaint();
    state.forecast = await fetchOpenMeteoForecast(state.settings);

    setLoading(true, "Forecast received. Simulating rooftop PV, 6 kW curtailment, 10 kWh battery flow, and EUR values.");
    await waitForPaint();
    els.updatedAt.textContent = `Forecast for ${LOCATION.name}`;
    setStatus("Live forecast", false);
  } catch (error) {
    console.error(error);
    setLoading(true, "Open-Meteo did not respond. Building the local fallback clear-sky forecast.");
    await waitForPaint();
    state.forecast = buildFallbackForecast(new Date(), state.settings);
    els.updatedAt.textContent = "Using fallback clear-sky model";
    setStatus("Forecast offline", true);
  }

  computeAndRender();
  setLoading(false);
}

function setStatus(text, isError) {
  els.forecastStatus.textContent = text;
  els.forecastStatus.classList.toggle("error", Boolean(isError));
}

function setLoading(isLoading, message = "") {
  els.loadingDetails.hidden = !isLoading;
  els.loadingDetails.classList.toggle("active", isLoading);
  els.refreshBtn.disabled = isLoading;
  els.statusRefreshBtn.disabled = isLoading;
  els.mainContent.setAttribute("aria-busy", isLoading ? "true" : "false");
  if (message) {
    els.loadingMessage.textContent = message;
  }
}

function waitForPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function computeAndRender() {
  if (!state.forecast) return;
  state.days = simulateForecast(state.forecast, state.settings);
  state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.days.length - 1));
  render();
}

/**
 * Redraw all derived UI from the current state. No network or model work happens here.
 */
function render() {
  if (!state.days.length) return;
  renderSummary();
  renderDaySelect();
  renderDailyChart(
    els.dailyChart,
    state.days,
    state.selectedIndex,
    index => {
      state.selectedIndex = index;
      render();
    },
    state.hiddenSeries.daily,
    seriesId => toggleSeries("daily", seriesId)
  );
  renderGenerationWeatherChart(
    els.generationWeatherChart,
    state.days[state.selectedIndex],
    state.hiddenSeries.generationWeather,
    seriesId => toggleSeries("generationWeather", seriesId)
  );
  renderHourlyChart(
    els.hourlyChart,
    state.days[state.selectedIndex],
    state.hiddenSeries.hourly,
    seriesId => toggleSeries("hourly", seriesId)
  );
  renderBatteryChart(
    els.batteryChart,
    state.days[state.selectedIndex],
    state.hiddenSeries.battery,
    seriesId => toggleSeries("battery", seriesId)
  );
  els.generationWeatherTitle.textContent = `Generation and weather: ${state.days[state.selectedIndex].label}`;
  renderDetails();
  renderTable();
}

/**
 * Toggle one chart series and redraw. Each chart owns a separate hidden-series set.
 */
function toggleSeries(chartId, seriesId) {
  const hiddenSeries = state.hiddenSeries[chartId];
  if (hiddenSeries.has(seriesId)) {
    hiddenSeries.delete(seriesId);
  } else {
    hiddenSeries.add(seriesId);
  }
  render();
}

function renderSummary() {
  const today = state.days[0];
  const totals = state.days.reduce((acc, day) => {
    acc.value += day.totalValue;
    acc.savings += day.savings;
    acc.earnings += day.earnings;
    acc.pv += day.pv;
    return acc;
  }, { value: 0, savings: 0, earnings: 0, pv: 0 });

  els.todayGeneration.textContent = `${formatNumber(today.pv, 1)} kWh`;
  els.todayWeather.textContent = `${weatherText(today.weatherCode)}, ${formatNumber(today.cloud, 0)}% cloud, ${formatNumber(today.rain, 1)} mm rain`;
  els.todaySavings.textContent = formatMoney(today.savings);
  els.todayFeedIn.textContent = formatMoney(today.earnings);
  els.periodValue.textContent = formatMoney(totals.value);
  els.periodBreakdown.textContent = `${formatMoney(totals.savings)} saved + ${formatMoney(totals.earnings)} feed-in`;
  els.forecastMeta.textContent = `${formatNumber(totals.pv, 0)} kWh PV forecast across ${state.days.length} days`;
}

function renderDaySelect() {
  const currentValue = String(state.selectedIndex);
  els.daySelect.innerHTML = state.days.map((day, index) => (
    `<option value="${index}">${day.label}</option>`
  )).join("");
  els.daySelect.value = currentValue;
}

function renderDetails() {
  const day = state.days[state.selectedIndex];
  const items = [
    ["PV generation", `${formatNumber(day.pv, 1)} kWh`],
    ["Theoretical potential", `${formatNumber(day.theoreticalPv, 1)} kWh`],
    ["After curtailment", `${formatNumber(day.deliveredPv, 1)} kWh`],
    ["Total value", formatMoney(day.totalValue)],
    ["Self-consumed", `${formatNumber(day.selfConsumed, 1)} kWh`],
    ["Grid export", `${formatNumber(day.exportKwh, 1)} kWh`],
    ["Grid import", `${formatNumber(day.importKwh, 1)} kWh`],
    ["Curtailed", `${formatNumber(day.curtailed, 1)} kWh`],
    ["Weather", weatherText(day.weatherCode)],
    ["Cloud / rain", `${formatNumber(day.cloud, 0)}% / ${formatNumber(day.rain, 1)} mm`],
    ["Temperature", `${formatNumber(day.tempMin, 0)}-${formatNumber(day.tempMax, 0)} deg C`],
    ["Battery at midnight", `${formatNumber(day.endSoc, 1)} kWh`]
  ];

  els.dayDetails.innerHTML = items.map(([label, value]) => (
    `<div class="detail-item"><span>${label}</span><strong>${value}</strong></div>`
  )).join("");
}

function renderTable() {
  els.forecastRows.innerHTML = state.days.map((day, index) => `
    <tr class="${index === state.selectedIndex ? "selected" : ""}" data-index="${index}" tabindex="0" aria-current="${index === state.selectedIndex ? "true" : "false"}" aria-label="Select forecast day ${day.label}: ${formatNumber(day.pv, 1)} kWh PV, ${formatMoney(day.totalValue)} total value">
      <td>${day.label}</td>
      <td>${weatherText(day.weatherCode)}</td>
      <td>${formatNumber(day.pv, 1)}</td>
      <td>${formatNumber(day.selfConsumed, 1)}</td>
      <td>${formatNumber(day.exportKwh, 1)}</td>
      <td>${formatMoney(day.savings)}</td>
      <td>${formatMoney(day.earnings)}</td>
      <td>${formatMoney(day.totalValue)}</td>
      <td>${formatNumber(day.curtailed, 1)}</td>
    </tr>
  `).join("");

  els.forecastRows.querySelectorAll("tr").forEach(row => {
    const selectRow = () => {
      state.selectedIndex = Number(row.dataset.index);
      render();
    };
    row.addEventListener("click", selectRow);
    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRow();
      }
    });
  });
}

function weatherText(code) {
  const map = {
    0: "Clear",
    1: "Mostly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Fog",
    51: "Drizzle",
    53: "Drizzle",
    55: "Drizzle",
    61: "Rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Snow",
    73: "Snow",
    75: "Heavy snow",
    80: "Showers",
    81: "Showers",
    82: "Heavy showers",
    95: "Thunderstorm"
  };
  return map[code] || "Mixed";
}

init();
