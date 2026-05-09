import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS } from "../src/config.js";
import {
  clearSkyPoa,
  applyRooftopProfile,
  cloudAdjustedIrradiance,
  fallbackIrradiance,
  householdLoad,
  simulateForecast
} from "../src/model.js";
import { buildFallbackForecast, buildForecastUrl, fetchOpenMeteoForecast } from "../src/weather.js";

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

  assert.ok(overcastLowIrradiance > 330);
  assert.ok(overcastLowIrradiance <= 360);
  assert.ok(overcastHighIrradiance < 1800);
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
  const evening = applyRooftopProfile(4.8, 17, DEFAULTS);

  assert.ok(morning <= 0.95);
  assert.equal(activeWindow, 4.8);
  assert.ok(evening <= 0.95);
});

test("high-cloud rooftop profile uses a smoother diffuse-light ramp", () => {
  const clearMorning = applyRooftopProfile(4.8, 9, DEFAULTS, 0);
  const cloudyMorning = applyRooftopProfile(4.8, 9, DEFAULTS, 100);
  const clearEvening = applyRooftopProfile(4.8, 17, DEFAULTS, 0);
  const cloudyEvening = applyRooftopProfile(4.8, 17, DEFAULTS, 100);

  assert.ok(clearMorning <= 0.95);
  assert.ok(cloudyMorning > clearMorning);
  assert.ok(cloudyMorning < 4.8);
  assert.ok(clearEvening <= 0.95);
  assert.ok(cloudyEvening > clearEvening);
  assert.ok(cloudyEvening < 4.8);
});

test("clear full-sun modeled rooftop generation calibrates to the measured screenshot day", () => {
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

  assert.ok(Math.abs(day.pv - 50.23) < 0.15);
  assert.ok(day.hours.every(hour => hour.deliveredPv <= DEFAULTS.feedCap));
  assert.ok(day.hours.find(hour => hour.hour === 8).pv < 1);
  assert.ok(day.hours.find(hour => hour.hour === 10).deliveredPv >= 5.9);
  assert.ok(day.hours.find(hour => hour.hour === 12).curtailed > 0);
  assert.ok(day.hours.find(hour => hour.hour === 17).pv < 1);
});

test("recalibrated cloud response improves stored cloudy-day underforecast pattern", () => {
  const may4 = oneDayForecast({
    date: "2026-05-04",
    cloudByHour: hour => STORED_MAY4.cloud[hour],
    irradianceByHour: hour => STORED_MAY4.irradiance[hour]
  });
  const may5 = oneDayForecast({
    date: "2026-05-05",
    cloudByHour: hour => STORED_MAY5.cloud[hour],
    irradianceByHour: hour => STORED_MAY5.irradiance[hour]
  });
  const may8 = oneDayForecast({
    date: "2026-05-08",
    cloudByHour: hour => STORED_MAY8.cloud[hour],
    irradianceByHour: hour => STORED_MAY8.irradiance[hour]
  });

  const [may4Day] = simulateForecast(may4, noLoadSettings());
  const [may5Day] = simulateForecast(may5, noLoadSettings());
  const [may8Day] = simulateForecast(may8, noLoadSettings());

  assert.ok(Math.abs(may4Day.pv - 36.41) < 1.5);
  assert.ok(Math.abs(may5Day.pv - 14.47) < 1.0);
  assert.ok(Math.abs(may8Day.pv - 55.15) < 1.5);
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

test("fallback forecast has the expected 14 day hourly shape", () => {
  const forecast = buildFallbackForecast(new Date("2026-05-02T00:00:00Z"));

  assert.equal(forecast.daily.time.length, 14);
  assert.equal(forecast.hourly.time.length, 14 * 24);
});

function oneDayForecast({ irradianceByHour, date, cloudByHour = () => 0 }) {
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
    hourly.temperature_2m.push(18);
    hourly.cloud_cover.push(cloudByHour(hour));
    hourly.precipitation.push(0);
    hourly.global_tilted_irradiance.push(irradianceByHour(hour));
    hourly.is_day.push(hour >= 6 && hour < 21 ? 1 : 0);
    hourly.weather_code.push(0);
  }

  return {
    hourly,
    daily: {
      time: [date],
      weather_code: [0],
      temperature_2m_max: [22],
      temperature_2m_min: [10],
      precipitation_sum: [0],
      cloud_cover_mean: [0],
      sunshine_duration: [12 * 3600]
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
  irradiance: [0, 0, 0, 0, 0, 0, 0, 19, 57, 104, 213, 312, 334, 307, 207, 204, 385, 610, 416, 237, 76, 18, 0, 0],
  cloud: [99, 95, 82, 97, 88, 96, 100, 96, 100, 100, 100, 100, 100, 100, 100, 100, 55, 100, 85, 61, 98, 100, 100, 100]
};

const STORED_MAY5 = {
  irradiance: [0, 0, 0, 0, 0, 0, 0, 7, 27, 40, 76, 132, 87, 90, 119, 126, 108, 194, 148, 82, 32, 7, 0, 0],
  cloud: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 98, 100, 100, 100, 100, 100, 98, 98, 97, 100, 100, 100, 100, 100]
};

const STORED_MAY8 = {
  irradiance: [0, 0, 0, 0, 0, 0, 2, 36, 128, 324, 538, 734, 888, 982, 1008, 962, 851, 619, 403, 232, 82, 20, 0, 0],
  cloud: [0, 15, 37, 0, 7, 15, 13, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 62, 46, 13, 0, 0, 0]
};
