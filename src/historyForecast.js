import { DEFAULTS, LOCATION } from "./config.js";
import { simulateForecast } from "./model.js";
import { buildForecastUrl } from "./weather.js";

export function captureDayAheadForecast({ forecast, settings = DEFAULTS, now = new Date() }) {
  const effectiveSettings = { ...DEFAULTS, ...settings };
  const issuedDate = zonedDateString(now, LOCATION.timezone);
  const targetDate = addDays(issuedDate, 1);
  const [day] = simulateForecast(selectForecastDays(forecast, [targetDate]), effectiveSettings);

  if (!day) {
    throw new Error(`Forecast payload does not contain hourly data for ${targetDate}`);
  }

  return snapshotFromDay(day, issuedDate, targetDate, effectiveSettings, now);
}

export function buildHistoryForecastUrl(settings = DEFAULTS, forecastDays = 3) {
  return String(buildForecastUrl({ ...DEFAULTS, ...settings }, forecastDays));
}

function snapshotFromDay(day, issuedDate, targetDate, settings, now) {
  return {
    issued_at: zonedIsoString(now, LOCATION.timezone),
    issued_date: issuedDate,
    target_date: targetDate,
    source: "Open-Meteo day-ahead",
    location_name: LOCATION.name,
    settings,
    forecast_total_kwh: round(sum(day.hours, "pv"), 3),
    theoretical_total_kwh: round(sum(day.hours, "theoreticalPv"), 3),
    delivered_total_kwh: round(sum(day.hours, "deliveredPv"), 3),
    curtailed_total_kwh: round(sum(day.hours, "curtailed"), 3),
    weather: {
      weather_code: day.weatherCode,
      temperature_2m_max: day.tempMax,
      temperature_2m_min: day.tempMin,
      precipitation_sum: day.rain,
      cloud_cover_mean: day.cloud,
      sunshine_duration: day.sunshineHours * 3600
    },
    hours: day.hours.map(hour => ({
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
    }))
  };
}

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
