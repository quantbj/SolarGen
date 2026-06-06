import { DEFAULTS, DWD_ICON_ENDPOINT, FORECAST_DAYS, LOCATION, OPEN_METEO_ENDPOINT } from "./config.js";
import { fallbackIrradiance } from "./model.js";

/**
 * Build the default Open-Meteo forecast URL for the configured location and roof tilt.
 * Output is a URL object so callers can inspect query parameters in tests.
 */
export function buildForecastUrl(settings, forecastDays = FORECAST_DAYS) {
  return buildProviderForecastUrl(OPEN_METEO_ENDPOINT, settings, forecastDays);
}

export function buildDwdIconForecastUrl(settings, forecastDays = FORECAST_DAYS) {
  return buildProviderForecastUrl(DWD_ICON_ENDPOINT, settings, forecastDays);
}

function buildProviderForecastUrl(endpoint, settings, forecastDays = FORECAST_DAYS) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    latitude: LOCATION.latitude,
    longitude: LOCATION.longitude,
    timezone: LOCATION.timezone,
    forecast_days: String(forecastDays),
    tilt: String(settings.tilt),
    azimuth: "0",
    hourly: [
      "temperature_2m",
      "cloud_cover",
      "precipitation",
      "global_tilted_irradiance",
      "is_day",
      "weather_code"
    ].join(","),
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "cloud_cover_mean",
      "sunshine_duration"
    ].join(",")
  });
  return url;
}

/**
 * Fetch default Open-Meteo data with a timeout.
 * Input `fetchFn` is injectable for tests; output is the raw JSON forecast payload.
 */
export async function fetchOpenMeteoForecast(settings, fetchFn = fetch, timeoutMs = 12000) {
  return fetchForecastFromUrl(buildForecastUrl(settings), fetchFn, timeoutMs, "Open-Meteo");
}

export async function fetchDwdIconForecast(settings, fetchFn = fetch, timeoutMs = 12000) {
  return fetchForecastFromUrl(buildDwdIconForecastUrl(settings), fetchFn, timeoutMs, "DWD ICON");
}

async function fetchForecastFromUrl(url, fetchFn = fetch, timeoutMs = 12000, label = "Forecast") {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchFn(
      url,
      controller ? { signal: controller.signal } : undefined
    );
    if (!response.ok) {
      throw new Error(`${label} request failed with ${response.status}`);
    }
    return response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} request timed out after ${timeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Build a deterministic offline forecast with plausible weather fields.
 * This keeps the UI functional when the external API is unavailable.
 */
export function buildFallbackForecast(start = new Date(), settings = DEFAULTS) {
  const hourly = {
    time: [],
    temperature_2m: [],
    cloud_cover: [],
    precipitation: [],
    global_tilted_irradiance: [],
    is_day: [],
    weather_code: []
  };
  const daily = {
    time: [],
    weather_code: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_sum: [],
    cloud_cover_mean: [],
    sunshine_duration: []
  };

  for (let dayOffset = 0; dayOffset < FORECAST_DAYS; dayOffset += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + dayOffset);
    const dateString = date.toISOString().slice(0, 10);
    const cloud = 18 + ((dayOffset * 17) % 55);
    daily.time.push(dateString);
    daily.weather_code.push(cloud > 60 ? 3 : cloud > 35 ? 2 : 1);
    daily.temperature_2m_max.push(18 + (dayOffset % 5));
    daily.temperature_2m_min.push(8 + (dayOffset % 4));
    daily.precipitation_sum.push(cloud > 62 ? 1.2 : 0);
    daily.cloud_cover_mean.push(cloud);
    daily.sunshine_duration.push(Math.max(3, 12 * (1 - cloud / 120)) * 3600);

    for (let hour = 0; hour < 24; hour += 1) {
      const iso = `${dateString}T${String(hour).padStart(2, "0")}:00`;
      hourly.time.push(iso);
      hourly.temperature_2m.push(10 + Math.sin(((hour - 7) / 24) * Math.PI) * 10);
      hourly.cloud_cover.push(cloud);
      hourly.precipitation.push(cloud > 62 && hour > 13 && hour < 17 ? 0.2 : 0);
      hourly.global_tilted_irradiance.push(fallbackIrradiance(dateString, hour, settings.tilt, cloud));
      hourly.is_day.push(hour > 5 && hour < 21 ? 1 : 0);
      hourly.weather_code.push(cloud > 60 ? 3 : cloud > 35 ? 2 : 1);
    }
  }

  return { hourly, daily };
}
