import test from "node:test";
import assert from "node:assert/strict";

import { CALIBRATION, DEFAULTS } from "../src/config.js";
import {
  clearSkyPoa,
  applyRooftopProfile,
  cloudAdjustedIrradiance,
  fallbackIrradiance,
  householdLoad,
  simulateForecast
} from "../src/model.js";
import { buildFallbackForecast, buildForecastUrl, fetchOpenMeteoForecast } from "../src/weather.js";
import { buildHistoryForecastUrl, captureDayAheadForecast, captureForecastSnapshot, simpleDailyForecastTotal } from "../src/historyForecast.js";
import { debounce, formatDay, formatMoney, formatNumber, valueAt } from "../src/utils.js";

test("clear-sky model produces no irradiance at night and meaningful midday irradiance", () => {
  const night = clearSkyPoa("2026-05-01", 2, DEFAULTS.tilt);
  const morning = clearSkyPoa("2026-05-01", 8, DEFAULTS.tilt);
  const midday = clearSkyPoa("2026-05-01", 13, DEFAULTS.tilt);

  assert.equal(night, 0);
  assert.ok(morning > 50);
  assert.ok(midday > morning);
});

test("fallback irradiance decreases as cloud cover rises", () => {
  const clear = fallbackIrradiance("2026-05-01", 13, DEFAULTS.tilt, 0);
  const overcast = fallbackIrradiance("2026-05-01", 13, DEFAULTS.tilt, 100);

  assert.ok(clear > overcast);
  assert.ok(overcast > 0);
});

test("cloud response uplifts high-cloud low-irradiance hours without changing clear hours", () => {
  assert.equal(cloudAdjustedIrradiance(700, 0), 700);
  const overcastLowIrradiance = cloudAdjustedIrradiance(180, 100);
  const overcastHighIrradiance = cloudAdjustedIrradiance(900, 100);
  const stormyBrightOvercast = cloudAdjustedIrradiance(700, 100, 0, {
    cloudCoverMean: 95,
    precipitationSum: 5,
    sunshineHours: 4
  });

  assert.ok(overcastLowIrradiance > 310);
  assert.ok(overcastLowIrradiance < 320);
  assert.equal(overcastHighIrradiance, 900);
  assert.ok(stormyBrightOvercast < 200);
});

test("household load shape includes morning, daytime, and evening demand", () => {
  const settings = {
    ...DEFAULTS,
    baseLoad: 0.3,
    dayLoad: 0.4,
    eveningLoad: 1.1
  };

  assert.equal(householdLoad(2, settings), 0.3);
  assert.equal(householdLoad(7, settings), 0.48);
  assert.equal(householdLoad(12, settings), 0.7);
  assert.equal(round(householdLoad(20, settings)), 1.4);
});

test("default household load assumes about 10 kWh daily consumption", () => {
  const dailyConsumption = Array.from({ length: 24 }, (_, hour) => householdLoad(hour, DEFAULTS))
    .reduce((sum, load) => sum + load, 0);

  assert.ok(Math.abs(dailyConsumption - 10) < 0.05);
});

test("simulation applies feed-in cap and reports curtailment", () => {
  const forecast = oneDayForecast({
    irradianceByHour: hour => (hour >= 10 && hour <= 14 ? 1300 : 0),
    date: "2026-05-02"
  });
  const settings = {
    ...DEFAULTS,
    battery: 0,
    batteryStart: 0,
    feedCap: 2,
    baseLoad: 0,
    dayLoad: 0,
    eveningLoad: 0
  };

  const [day] = simulateForecast(forecast, settings);

  assert.ok(day.pv > day.exportKwh);
  assert.ok(day.theoreticalPv >= day.pv);
  assert.ok(day.curtailed > 0);
  assert.equal(round(day.deliveredPv), round(day.pv - day.curtailed));
  assert.ok(day.hours.every(hour => hour.deliveredPv <= settings.feedCap));
  assert.ok(day.hours.every(hour => hour.exportKwh <= settings.feedCap));
  assert.ok(day.hours.every(hour => round(hour.deliveredPv) === round(hour.pv - hour.curtailed)));
});

test("rooftop profile matches observed morning and evening suppression", () => {
  const morning = applyRooftopProfile(4.8, 8, DEFAULTS);
  const activeWindow = applyRooftopProfile(4.8, 12, DEFAULTS);
  const evening = applyRooftopProfile(4.8, 18, DEFAULTS);

  assert.ok(morning <= 1.45);
  assert.equal(activeWindow, 4.8);
  assert.ok(evening <= 1.45);
});

test("high-cloud rooftop profile uses a calibrated diffuse-light ramp", () => {
  const clearMorning = applyRooftopProfile(4.8, 9, DEFAULTS, 0);
  const cloudyMorning = applyRooftopProfile(4.8, 9, DEFAULTS, 100);
  const clearEvening = applyRooftopProfile(4.8, 17, DEFAULTS, 0);
  const cloudyEvening = applyRooftopProfile(4.8, 17, DEFAULTS, 100);

  assert.ok(clearMorning <= 1.45);
  assert.ok(cloudyMorning > clearMorning);
  assert.ok(cloudyMorning <= 5.8);
  assert.ok(clearEvening <= 4.8);
  assert.ok(cloudyEvening > 1.5);
  assert.ok(cloudyEvening < clearEvening);
});

test("clear full-sun modeled rooftop generation calibrates to the configured production target", () => {
  const forecast = oneDayForecast({
    irradianceByHour: hour => clearSkyPoa("2026-05-01", hour, DEFAULTS.tilt),
    date: "2026-05-01"
  });
  const [day] = simulateForecast(forecast, {
    ...DEFAULTS,
    battery: 25,
    batteryStart: 0,
    baseLoad: 0,
    dayLoad: 0,
    eveningLoad: 0
  });

  assert.ok(Math.abs(day.pv - CALIBRATION.clearDayKwh) < 0.15);
  assert.ok(day.hours.every(hour => hour.deliveredPv <= DEFAULTS.feedCap));
  assert.ok(day.hours.find(hour => hour.hour === 8).pv < 1.5);
  assert.ok(day.hours.find(hour => hour.hour === 11).deliveredPv >= 5.9);
  assert.ok(day.hours.find(hour => hour.hour === 12).curtailed > 0);
  assert.ok(day.hours.find(hour => hour.hour === 19).pv < 1);
});

test("recalibrated weather response balances all stored forecast-vs-actual days", () => {
  const cases = [
    ["2026-05-04", STORED_MAY4, 36.41],
    ["2026-05-05", STORED_MAY5, 14.47],
    ["2026-05-08", STORED_MAY8, 55.15],
    ["2026-05-09", STORED_MAY9, 33.41],
    ["2026-05-10", STORED_MAY10, 44.06],
    ["2026-05-11", STORED_MAY11, 27.4],
    ["2026-05-12", STORED_MAY12, 24.43]
  ];

  const absolutePercentErrors = cases.map(([date, stored, actual]) => {
    const forecast = oneDayForecast({
      date,
      cloudByHour: hour => stored.cloud[hour],
      irradianceByHour: hour => stored.irradiance[hour],
      precipitationByHour: hour => stored.rain[hour],
      temperatureByHour: hour => stored.temp[hour],
      daily: stored.daily
    });
    const [day] = simulateForecast(forecast, noLoadSettings());
    return Math.abs(day.pv - actual) / actual;
  });
  const meanAbsolutePercentError = absolutePercentErrors.reduce((sum, error) => sum + error, 0) / cases.length;

  assert.ok(meanAbsolutePercentError < 0.025);
  assert.ok(Math.max(...absolutePercentErrors) < 0.04);
});
test("battery storage reduces evening grid import after midday surplus and reports state of charge percent", () => {
  const forecast = oneDayForecast({
    irradianceByHour: hour => (hour >= 10 && hour <= 14 ? 900 : 0),
    date: "2026-05-02"
  });
  const common = {
    ...DEFAULTS,
    capacity: 6,
    feedCap: 6,
    baseLoad: 0,
    dayLoad: 0,
    eveningLoad: 1,
    price: 0.3,
    tariff: 0.0778
  };

  const [withoutBattery] = simulateForecast(forecast, {
    ...common,
    battery: 0,
    batteryStart: 0
  });
  const batteryCapacity = 4;
  const [withBattery] = simulateForecast(forecast, {
    ...common,
    battery: batteryCapacity,
    batteryStart: 0
  });

  assert.ok(withBattery.importKwh < withoutBattery.importKwh);
  assert.ok(withBattery.selfConsumed > withoutBattery.selfConsumed);
  assert.ok(withBattery.savings > withoutBattery.savings);
  assert.ok(withBattery.hours.every(hour => hour.batteryPercent >= 0 && hour.batteryPercent <= 100));
  assert.equal(round(withBattery.hours.at(-1).batteryPercent), round((withBattery.endSoc / batteryCapacity) * 100));
});

test("money values equal self-consumption savings plus feed-in earnings", () => {
  const forecast = oneDayForecast({
    irradianceByHour: hour => (hour >= 9 && hour <= 15 ? 700 : 0),
    date: "2026-05-02"
  });
  const settings = {
    ...DEFAULTS,
    battery: 2,
    batteryStart: 0,
    price: 0.3,
    tariff: 0.0778
  };

  const [day] = simulateForecast(forecast, settings);

  assert.equal(round(day.savings), round(day.selfConsumed * settings.price));
  assert.equal(round(day.earnings), round(day.exportKwh * settings.tariff));
  assert.equal(round(day.totalValue), round(day.savings + day.earnings));
});

test("simulation preserves hourly meteo inputs for generation curve", () => {
  const forecast = oneDayForecast({
    irradianceByHour: hour => (hour === 12 ? 800 : 0),
    date: "2026-05-02"
  });
  forecast.hourly.cloud_cover[12] = 37;
  forecast.hourly.precipitation[12] = 0.8;
  forecast.hourly.temperature_2m[12] = 21;

  const [day] = simulateForecast(forecast, DEFAULTS);
  const noon = day.hours.find(hour => hour.hour === 12);

  assert.equal(noon.irradiance, 800);
  assert.equal(noon.cloudCover, 37);
  assert.equal(noon.precipitation, 0.8);
  assert.equal(noon.temperature, 21);
  assert.ok(noon.pv > 0);
});

test("Open-Meteo URL requests tilted solar and weather forecast inputs", () => {
  const url = buildForecastUrl(DEFAULTS);

  assert.equal(url.searchParams.get("latitude"), "53.226");
  assert.equal(url.searchParams.get("azimuth"), "0");
  assert.equal(url.searchParams.get("tilt"), "35");
  assert.match(url.searchParams.get("hourly"), /global_tilted_irradiance/);
  assert.match(url.searchParams.get("hourly"), /cloud_cover/);
  assert.match(url.searchParams.get("hourly"), /precipitation/);
});

test("history capture selects the day-ahead forecast and serializes hourly values", () => {
  const forecast = {
    hourly: {
      time: [],
      temperature_2m: [],
      cloud_cover: [],
      precipitation: [],
      global_tilted_irradiance: [],
      is_day: [],
      weather_code: []
    },
    daily: {
      time: ["2026-05-09", "2026-05-10"],
      weather_code: [0, 2],
      temperature_2m_max: [18, 20],
      temperature_2m_min: [8, 10],
      precipitation_sum: [0, 0.4],
      cloud_cover_mean: [10, 35],
      sunshine_duration: [36000, 28000]
    }
  };
  for (const date of forecast.daily.time) {
    for (let hour = 0; hour < 24; hour += 1) {
      forecast.hourly.time.push(`${date}T${String(hour).padStart(2, "0")}:00`);
      forecast.hourly.temperature_2m.push(18);
      forecast.hourly.cloud_cover.push(20);
      forecast.hourly.precipitation.push(0);
      forecast.hourly.global_tilted_irradiance.push(hour >= 10 && hour <= 15 ? 800 : 0);
      forecast.hourly.is_day.push(hour >= 6 && hour <= 20 ? 1 : 0);
      forecast.hourly.weather_code.push(1);
    }
  }

  const snapshot = captureDayAheadForecast({
    forecast,
    now: new Date("2026-05-09T08:00:00+02:00")
  });

  assert.equal(snapshot.issued_date, "2026-05-09");
  assert.equal(snapshot.target_date, "2026-05-10");
  assert.equal(snapshot.source, "Open-Meteo day-ahead");
  assert.equal(snapshot.hours.length, 24);
  assert.ok(snapshot.forecast_total_kwh > 0);
  assert.equal(snapshot.simple_forecast_total_kwh, 34.07);
  assert.match(buildHistoryForecastUrl({ tilt: 40 }, 2), /forecast_days=2/);
});

test("history capture can store same-day forecasts as a separate source", () => {
  const forecast = {
    hourly: {
      time: [],
      temperature_2m: [],
      cloud_cover: [],
      precipitation: [],
      global_tilted_irradiance: [],
      is_day: [],
      weather_code: []
    },
    daily: {
      time: ["2026-05-09", "2026-05-10"],
      weather_code: [2, 0],
      temperature_2m_max: [18, 20],
      temperature_2m_min: [8, 10],
      precipitation_sum: [0.2, 0],
      cloud_cover_mean: [60, 10],
      sunshine_duration: [18000, 36000]
    }
  };
  for (const date of forecast.daily.time) {
    for (let hour = 0; hour < 24; hour += 1) {
      forecast.hourly.time.push(`${date}T${String(hour).padStart(2, "0")}:00`);
      forecast.hourly.temperature_2m.push(18);
      forecast.hourly.cloud_cover.push(60);
      forecast.hourly.precipitation.push(hour === 12 ? 0.2 : 0);
      forecast.hourly.global_tilted_irradiance.push(hour >= 10 && hour <= 15 ? 400 : 0);
      forecast.hourly.is_day.push(hour >= 6 && hour <= 20 ? 1 : 0);
      forecast.hourly.weather_code.push(2);
    }
  }

  const snapshot = captureForecastSnapshot({
    forecast,
    now: new Date("2026-05-09T15:00:00+02:00"),
    targetOffsetDays: 0,
    source: "Open-Meteo same-day"
  });

  assert.equal(snapshot.issued_date, "2026-05-09");
  assert.equal(snapshot.target_date, "2026-05-09");
  assert.equal(snapshot.source, "Open-Meteo same-day");
});

test("simple daily forecast candidate uses sunshine and daylight rain only", () => {
  const hours = [
    { irradiance_wm2: 0, rain_mm: 8 },
    { irradiance_wm2: 120, rain_mm: 2 },
    { irradiance_wm2: 300, rain_mm: 1 }
  ];

  assert.equal(simpleDailyForecastTotal(8, hours), 31.397);
});


test("Open-Meteo request times out instead of hanging indefinitely", async () => {
  await assert.rejects(
    () => fetchOpenMeteoForecast(DEFAULTS, (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }), 1),
    /Forecast request timed out/
  );
});

test("formatting helpers produce compact app labels", async () => {
  assert.equal(formatDay("2026-05-09"), "Sat 09/05");
  assert.equal(formatNumber(1.234, 1), "1.2");
  assert.equal(formatMoney(3.456), "EUR 3.46");
  assert.equal(valueAt([1], 1, 7), 7);

  let calls = 0;
  const debounced = debounce(() => { calls += 1; }, 1);
  debounced();
  debounced();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
});

test("fallback forecast has the expected 14 day hourly shape", () => {
  const forecast = buildFallbackForecast(new Date("2026-05-02T00:00:00Z"));

  assert.equal(forecast.daily.time.length, 14);
  assert.equal(forecast.hourly.time.length, 14 * 24);
});

function oneDayForecast({
  irradianceByHour,
  date,
  cloudByHour = () => 0,
  precipitationByHour = () => 0,
  temperatureByHour = () => 18,
  daily = {}
}) {
  const hourly = {
    time: [],
    temperature_2m: [],
    cloud_cover: [],
    precipitation: [],
    global_tilted_irradiance: [],
    is_day: [],
    weather_code: []
  };

  for (let hour = 0; hour < 24; hour += 1) {
    hourly.time.push(`${date}T${String(hour).padStart(2, "0")}:00`);
    hourly.temperature_2m.push(temperatureByHour(hour));
    hourly.cloud_cover.push(cloudByHour(hour));
    hourly.precipitation.push(precipitationByHour(hour));
    hourly.global_tilted_irradiance.push(irradianceByHour(hour));
    hourly.is_day.push(hour >= 6 && hour < 21 ? 1 : 0);
    hourly.weather_code.push(0);
  }

  return {
    hourly,
    daily: {
      time: [date],
      weather_code: [daily.weather_code ?? 0],
      temperature_2m_max: [daily.temperature_2m_max ?? 22],
      temperature_2m_min: [daily.temperature_2m_min ?? 10],
      precipitation_sum: [daily.precipitation_sum ?? 0],
      cloud_cover_mean: [daily.cloud_cover_mean ?? 0],
      sunshine_duration: [daily.sunshine_duration ?? 12 * 3600]
    }
  };
}

function round(value) {
  return Math.round(value * 1000000) / 1000000;
}

function noLoadSettings() {
  return {
    ...DEFAULTS,
    battery: 0,
    batteryStart: 0,
    baseLoad: 0,
    dayLoad: 0,
    eveningLoad: 0
  };
}

const STORED_MAY4 = {
  irradiance: [0, 0, 0, 0, 0, 0, 0, 18.6, 56.8, 103.9, 212.8, 312.5, 334.5, 306.8, 207, 204.3, 385.2, 609.6, 416.2, 236.6, 76.1, 17.7, 0, 0],
  cloud: [99, 95, 82, 97, 88, 96, 100, 96, 100, 100, 100, 100, 100, 100, 100, 100, 55, 100, 85, 61, 98, 100, 100, 100],
  rain: [0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  temp: [14.7, 14.3, 13.8, 13.5, 13.2, 13.1, 12.1, 11.7, 11.7, 12, 12.9, 13.5, 14.2, 15, 15.6, 15.8, 16.7, 16.9, 16.9, 16.1, 15.1, 12.6, 10.7, 9.3],
  daily: { weather_code: 80, temperature_2m_max: 16.9, temperature_2m_min: 9.3, precipitation_sum: 0.1, cloud_cover_mean: 94, sunshine_duration: 22506.36 }
};

const STORED_MAY5 = {
  irradiance: [0, 0, 0, 0, 0, 0, 0, 7.4, 26.9, 39.9, 75.7, 131.7, 86.6, 90, 119.4, 126.3, 107.6, 194.3, 148, 81.5, 32.5, 7.4, 0, 0],
  cloud: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 98, 100, 100, 100, 100, 100, 98, 98, 97, 100, 100, 100, 100, 100],
  rain: [0, 0, 0, 0.2, 0, 1.1, 0.8, 0.4, 0.4, 1, 0.4, 0, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  temp: [9.9, 9.4, 9.2, 9, 8.6, 8, 7.5, 7.4, 7.4, 7.3, 7.7, 8, 8.2, 8.8, 9.5, 10.1, 10.6, 11.2, 11.6, 11.5, 11.3, 10.8, 10.4, 9.7],
  daily: { weather_code: 61, temperature_2m_max: 11.6, temperature_2m_min: 7.3, precipitation_sum: 4.5, cloud_cover_mean: 100, sunshine_duration: 0 }
};

const STORED_MAY8 = {
  irradiance: [0, 0, 0, 0, 0, 0, 1.9, 35.6, 127.5, 323.9, 538.2, 734, 887.7, 982.1, 1008.1, 962, 851.4, 619.3, 402.9, 232.2, 82.4, 19.7, 0, 0],
  cloud: [0, 15, 37, 0, 7, 15, 13, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 62, 46, 13, 0, 0, 0],
  rain: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  temp: [7.5, 6.9, 6.8, 6.1, 5.1, 4.7, 4.4, 5.2, 7.7, 9.7, 11.2, 12.4, 13.5, 14.3, 15, 15.3, 15.4, 15.5, 15.4, 14.8, 14, 11.7, 9.5, 8.4],
  daily: { weather_code: 45, temperature_2m_max: 15.5, temperature_2m_min: 4.4, precipitation_sum: 0, cloud_cover_mean: 12, sunshine_duration: 53963.09 }
};


const STORED_MAY9 = {
  irradiance: [0, 0, 0, 0, 0, 0, 1.9, 36.6, 129.8, 311.6, 435.1, 552.3, 356.2, 321, 330.6, 373.9, 353.2, 246.8, 155.6, 122.8, 71.3, 18.6, 0, 0],
  cloud: [0, 0, 0, 0, 5, 10, 7, 0, 24, 24, 78, 84, 100, 100, 100, 100, 100, 100, 95, 95, 100, 97, 91, 100],
  rain: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  temp: [7.2, 5.9, 5.2, 4.6, 4, 3.4, 3.1, 4.2, 7, 10, 12, 13.9, 13.9, 14.3, 15.2, 15.3, 15.6, 15.3, 15.2, 15.2, 14.7, 12.9, 12, 11.5],
  daily: { weather_code: 45, temperature_2m_max: 15.6, temperature_2m_min: 3.1, precipitation_sum: 0, cloud_cover_mean: 59, sunshine_duration: 28609.54 }
};

const STORED_MAY10 = {
  irradiance: [0, 0, 0, 0, 0, 0, 1.9, 34.4, 80.9, 173.3, 387.4, 558.1, 631.5, 686.9, 453.5, 395.8, 604.6, 636.5, 444.5, 256.2, 87, 24.3, 0, 0],
  cloud: [96, 83, 100, 100, 71, 100, 91, 100, 100, 69, 99, 100, 100, 100, 100, 100, 38, 80, 16, 0, 42, 95, 100, 93],
  rain: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  temp: [10.5, 9.9, 9.6, 9.4, 9.2, 8.7, 8.2, 8.8, 10.2, 11.7, 13.6, 15.5, 16.5, 17.5, 16.2, 17, 16.5, 15.6, 14.2, 12.4, 10.7, 8.9, 7.6, 7],
  daily: { weather_code: 3, temperature_2m_max: 17.5, temperature_2m_min: 7, precipitation_sum: 0, cloud_cover_mean: 82, sunshine_duration: 41991.14 }
};

const STORED_MAY11 = {
  irradiance: [0, 0, 0, 0, 0, 0, 0.9, 21.3, 47.3, 63.1, 128.9, 244.9, 430.9, 531.5, 660.9, 378.6, 191.9, 153.4, 168.2, 222, 85.1, 24.3, 0, 0],
  cloud: [98, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 95, 77, 41, 91, 83, 100],
  rain: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.1, 0, 0, 0, 0, 0, 0],
  temp: [8.6, 8.4, 8.3, 8, 7.6, 7.3, 7.2, 7.2, 7.4, 7.7, 8.3, 9.2, 10.3, 10.8, 12.2, 11.7, 10.8, 10.1, 10.6, 11, 10.3, 8.5, 7.5, 6.3],
  daily: { weather_code: 61, temperature_2m_max: 12.2, temperature_2m_min: 6.3, precipitation_sum: 0.2, cloud_cover_mean: 95, sunshine_duration: 16433.71 }
};

const STORED_MAY12 = {
  irradiance: [0, 0, 0, 0, 0, 0, 1.9, 21.3, 61.9, 136.2, 281, 168.8, 335.3, 653.7, 772.1, 662.3, 504, 242.7, 240.1, 175.9, 90, 22.3, 0, 0],
  cloud: [100, 96, 100, 65, 17, 99, 98, 100, 100, 98, 100, 100, 97, 84, 98, 98, 100, 92, 95, 94, 84, 92, 95, 97],
  rain: [0, 0, 0, 0, 0, 0, 0, 0.9, 0.2, 0.3, 0.4, 3, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0, 0.1],
  temp: [5.2, 5.3, 5.3, 5.2, 3.5, 2.9, 4.1, 5.8, 6.4, 7.6, 8, 8.4, 10.1, 11.1, 11.8, 11.9, 11.7, 10.6, 10.2, 10.2, 9.9, 8.8, 7.9, 7.4],
  daily: { weather_code: 80, temperature_2m_max: 11.9, temperature_2m_min: 2.9, precipitation_sum: 5.2, cloud_cover_mean: 92, sunshine_duration: 25587.57 }
};
