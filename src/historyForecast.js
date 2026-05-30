import { DEFAULTS, LOCATION } from "./config.js";
import { simulateForecast } from "./model.js";
import { buildForecastUrl } from "./weather.js";

export const SIMPLE_FORECAST_CALIBRATIONS = {
  "Open-Meteo day-ahead": {
    currentWeight: 1,
    rawSimpleWeight: 0,
    biasKwh: -0.227,
    basis: "leave-one-target-date-out DA history through 2026-05-29"
  }
};

export function captureDayAheadForecast({ forecast, settings = DEFAULTS, now = new Date() }) {
  return captureForecastSnapshot({
    forecast,
    settings,
    now,
    targetOffsetDays: 1,
    source: "Open-Meteo day-ahead"
  });
}

/**
 * Convert a raw Open-Meteo payload into a SQLite-ready history snapshot.
 * Input `now` controls issue date; `targetOffsetDays` selects today (0) or day-ahead (1).
 */
export function captureForecastSnapshot({
  forecast,
  settings = DEFAULTS,
  now = new Date(),
  targetOffsetDays = 1,
  source = "Open-Meteo day-ahead"
}) {
  const effectiveSettings = { ...DEFAULTS, ...settings };
  const issuedDate = zonedDateString(now, LOCATION.timezone);
  const targetDate = addDays(issuedDate, targetOffsetDays);
  const [day] = simulateForecast(selectForecastDays(forecast, [targetDate]), effectiveSettings);

  if (!day) {
    throw new Error(`Forecast payload does not contain hourly data for ${targetDate}`);
  }

  return snapshotFromDay(day, issuedDate, targetDate, effectiveSettings, now, source);
}

/**
 * Build the short-horizon Open-Meteo URL used by the local history capture workflow.
 */
export function buildHistoryForecastUrl(settings = DEFAULTS, forecastDays = 3) {
  return String(buildForecastUrl({ ...DEFAULTS, ...settings }, forecastDays));
}

/**
 * Map the shared browser day model into the Python history app's persisted field names.
 */
function snapshotFromDay(day, issuedDate, targetDate, settings, now, source) {
  const hours = day.hours.map(hour => ({
    timestamp: hour.time,
    hour: hour.hour,
    theoretical_kwh: round(hour.theoreticalPv, 3),
    forecast_kwh: round(hour.pv, 3),
    delivered_kwh: round(hour.deliveredPv, 3),
    curtailed_kwh: round(hour.curtailed, 3),
    irradiance_wm2: round(hour.irradiance || 0, 3),
    cloud_pct: round(hour.cloudCover || 0, 3),
    rain_mm: round(hour.precipitation || 0, 3),
    temp_c: round(hour.temperature, 3)
  }));

  const currentTotal = round(sum(day.hours, "pv"), 3);
  const rawSimpleTotal = simpleDailyForecastTotal(day.sunshineHours, hours);
  const simpleModel = calibratedSimpleForecastTotal(source, currentTotal, rawSimpleTotal);

  return {
    issued_at: zonedIsoString(now, LOCATION.timezone),
    issued_date: issuedDate,
    target_date: targetDate,
    source,
    location_name: LOCATION.name,
    settings,
    forecast_total_kwh: currentTotal,
    simple_forecast_total_kwh: simpleModel.total,
    theoretical_total_kwh: round(sum(day.hours, "theoreticalPv"), 3),
    delivered_total_kwh: round(sum(day.hours, "deliveredPv"), 3),
    curtailed_total_kwh: round(sum(day.hours, "curtailed"), 3),
    weather: {
      weather_code: day.weatherCode,
      temperature_2m_max: day.tempMax,
      temperature_2m_min: day.tempMin,
      precipitation_sum: day.rain,
      cloud_cover_mean: day.cloud,
      sunshine_duration: day.sunshineHours * 3600,
      simple_model: simpleModel.name,
      simple_raw_kwh: rawSimpleTotal,
      simple_current_weight: simpleModel.currentWeight,
      simple_raw_weight: simpleModel.rawSimpleWeight,
      simple_bias_kwh: simpleModel.biasKwh,
      simple_calibration_basis: simpleModel.basis
    },
    hours
  };
}

/**
 * Simple out-of-sample candidate model from docs/forecast-generalization-report.md.
 * It predicts only the daily total; hourly allocation remains the existing model curve.
 */
export function simpleDailyForecastTotal(sunshineHours, hours) {
  const daylightRain = hours
    .filter(hour => Number(hour.irradiance_wm2 || 0) > 0)
    .reduce((total, hour) => total + Number(hour.rain_mm || 0), 0);
  return round(Math.max(0, 18.3545 + 2.351 * Number(sunshineHours || 0) - 1.9219 * daylightRain), 3);
}

export function calibratedSimpleForecastTotal(source, currentTotal, rawSimpleTotal) {
  const calibration = SIMPLE_FORECAST_CALIBRATIONS[source];
  if (!calibration) {
    return {
      total: rawSimpleTotal,
      name: "raw sunshine/rain simple model",
      currentWeight: 0,
      rawSimpleWeight: 1,
      biasKwh: 0,
      basis: "unadjusted raw simple model"
    };
  }
  const total = Math.max(
    0,
    calibration.currentWeight * currentTotal +
    calibration.rawSimpleWeight * rawSimpleTotal +
    calibration.biasKwh
  );
  return {
    total: round(total, 3),
    name: "source-calibrated stable blend",
    currentWeight: calibration.currentWeight,
    rawSimpleWeight: calibration.rawSimpleWeight,
    biasKwh: calibration.biasKwh,
    basis: calibration.basis
  };
}

/**
 * Keep only the target date in a multi-day Open-Meteo payload before simulation.
 */
function selectForecastDays(forecast, dates) {
  const dateSet = new Set(dates);
  const hourly = {};
  const daily = {};

  for (const [key, values] of Object.entries(forecast.hourly || {})) {
    hourly[key] = [];
    values.forEach((value, index) => {
      const date = forecast.hourly.time[index].slice(0, 10);
      if (dateSet.has(date)) hourly[key].push(value);
    });
  }

  for (const [key, values] of Object.entries(forecast.daily || {})) {
    daily[key] = [];
    values.forEach((value, index) => {
      const date = forecast.daily.time[index];
      if (dateSet.has(date)) daily[key].push(value);
    });
  }

  return { hourly, daily };
}

function zonedDateString(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function zonedIsoString(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset"
  }).formatToParts(date).map(part => [part.type, part.value]));
  const offset = parts.timeZoneName.replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sum(hours, key) {
  return hours.reduce((total, hour) => total + hour[key], 0);
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}
