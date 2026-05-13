import { CALIBRATION, CLOUD_RESPONSE, DEFAULTS, LOCATION, ROOFTOP_PROFILE } from "./config.js";
import { clamp, dayOfYear, formatDay, toRad, valueAt } from "./utils.js";

let calibrationScaleCache = null;

/**
 * Convert a raw Open-Meteo forecast payload into SolarGen day models.
 *
 * Input:
 * - `forecast.daily`: one row per local day with summary weather fields.
 * - `forecast.hourly`: one row per local hour with irradiance, cloud, rain, and temperature.
 * - `settings`: user-adjustable system assumptions such as kWp, battery size, tariff, and load.
 *
 * Output:
 * - an array of day objects containing hourly PV, battery, export/import, curtailment, and value fields.
 */
export function simulateForecast(forecast, settings = DEFAULTS) {
  const daily = forecast.daily;
  const hourly = forecast.hourly;
  const grouped = groupHourlyForecast(hourly);
  const calibrationScale = calculateCalibrationScale();
  let batterySoc = settings.battery * (settings.batteryStart / 100);

  return daily.time.map((date, dayIndex) => {
    const dailyWeather = {
      cloudCoverMean: valueAt(daily.cloud_cover_mean, dayIndex, 0),
      precipitationSum: valueAt(daily.precipitation_sum, dayIndex, 0),
      sunshineHours: valueAt(daily.sunshine_duration, dayIndex, 0) / 3600
    };
    const hours = (grouped.get(date) || []).map(hour => {
      const irradiance = hour.irradiance ?? fallbackIrradiance(date, hour.hour, settings.tilt, hour.cloudCover);

      // The weather response uses both hourly and daily Open-Meteo fields. Low-irradiance
      // overcast hours are lifted, while bright high-cloud hours are damped on wet,
      // low-sun, high-cloud days where the raw tilted irradiance has over-forecast.
      const correctedIrradiance = cloudAdjustedIrradiance(
        irradiance,
        hour.cloudCover,
        hour.precipitation,
        dailyWeather
      );
      const tempFactor = pvTemperatureFactor(correctedIrradiance, hour.temperature);
      const theoreticalPv = Math.max(0, (correctedIrradiance / 1000) * settings.capacity * calibrationScale * tempFactor);

      // Rooftop behavior is weather-dependent: clear days keep the observed step profile,
      // cloudy days blend toward a smoother diffuse-light profile.
      const pv = Math.max(
        applyRooftopProfile(theoreticalPv, hour.hour, settings, hour.cloudCover),
        diffuseDawnFloor(hour.hour, hour.cloudCover, settings)
      );
      const curtailed = Math.max(0, pv - settings.feedCap);
      const deliveredPv = pv - curtailed;
      const load = householdLoad(hour.hour, settings);

      const direct = Math.min(deliveredPv, load);
      let remainingLoad = load - direct;
      const discharge = Math.min(batterySoc, remainingLoad);
      batterySoc -= discharge;
      remainingLoad -= discharge;

      let surplus = deliveredPv - direct;
      const chargeRoom = Math.max(0, settings.battery - batterySoc);
      const chargeInput = Math.min(surplus, chargeRoom / 0.94);
      batterySoc += chargeInput * 0.94;
      surplus -= chargeInput;

      const exportKwh = Math.min(surplus, settings.feedCap);
      const batteryPercent = settings.battery > 0 ? (batterySoc / settings.battery) * 100 : 0;

      return {
        ...hour,
        theoreticalPv,
        pv,
        deliveredPv,
        load,
        direct,
        discharge,
        charge: chargeInput * 0.94,
        exportKwh,
        curtailed,
        importKwh: Math.max(0, remainingLoad),
        batterySoc,
        batteryPercent
      };
    });

    const totals = sumHours(hours);
    return {
      date,
      label: formatDay(date),
      weatherCode: valueAt(daily.weather_code, dayIndex, 0),
      tempMax: valueAt(daily.temperature_2m_max, dayIndex, null),
      tempMin: valueAt(daily.temperature_2m_min, dayIndex, null),
      rain: valueAt(daily.precipitation_sum, dayIndex, 0),
      cloud: dailyWeather.cloudCoverMean,
      sunshineHours: dailyWeather.sunshineHours,
      hours,
      ...totals,
      savings: totals.selfConsumed * settings.price,
      earnings: totals.exportKwh * settings.tariff,
      totalValue: totals.selfConsumed * settings.price + totals.exportKwh * settings.tariff
    };
  });
}

/**
 * Group Open-Meteo hourly arrays by local date and normalize field names.
 * Returns a Map keyed by `yyyy-mm-dd`, each value containing 24-ish hourly objects.
 */
export function groupHourlyForecast(hourly) {
  const grouped = new Map();
  hourly.time.forEach((iso, index) => {
    const date = iso.slice(0, 10);
    if (!grouped.has(date)) {
      grouped.set(date, []);
    }
    grouped.get(date).push({
      time: iso,
      hour: Number(iso.slice(11, 13)),
      temperature: valueAt(hourly.temperature_2m, index, 16),
      cloudCover: valueAt(hourly.cloud_cover, index, 0),
      precipitation: valueAt(hourly.precipitation, index, 0),
      irradiance: valueAt(hourly.global_tilted_irradiance, index, null),
      isDay: valueAt(hourly.is_day, index, 0),
      weatherCode: valueAt(hourly.weather_code, index, 0)
    });
  });
  return grouped;
}

/**
 * Sum hourly simulation records into daily totals used by summary cards, tables, and charts.
 */
export function sumHours(hours) {
  return hours.reduce((acc, hour) => {
    acc.pv += hour.pv;
    acc.theoreticalPv += hour.theoreticalPv;
    acc.deliveredPv += hour.deliveredPv;
    acc.load += hour.load;
    acc.direct += hour.direct;
    acc.discharge += hour.discharge;
    acc.charge += hour.charge;
    acc.exportKwh += hour.exportKwh;
    acc.curtailed += hour.curtailed;
    acc.importKwh += hour.importKwh;
    acc.selfConsumed += hour.direct + hour.discharge;
    acc.endSoc = hour.batterySoc;
    return acc;
  }, {
    pv: 0,
    theoreticalPv: 0,
    deliveredPv: 0,
    load: 0,
    direct: 0,
    discharge: 0,
    charge: 0,
    exportKwh: 0,
    curtailed: 0,
    importKwh: 0,
    selfConsumed: 0,
    endSoc: 0
  });
}

/**
 * Synthetic household load profile in kWh/h.
 * Inputs are three sliders: base demand, daytime extra demand, and evening extra demand.
 */
export function householdLoad(hour, settings = DEFAULTS) {
  let load = settings.baseLoad;
  if (hour >= 8 && hour < 18) load += settings.dayLoad;
  if (hour >= 18 && hour < 23) load += settings.eveningLoad;
  if (hour >= 6 && hour < 8) load += settings.dayLoad * 0.45;
  return load;
}

/**
 * Solve a single scale factor so the clear-sky May 1 calibration day reproduces 50.23 kWh.
 * This keeps the model anchored to the measured full-sun screenshot before weather corrections.
 */
export function calculateCalibrationScale() {
  if (calibrationScaleCache !== null) return calibrationScaleCache;
  const baseHourly = Array.from({ length: 24 }, (_, hour) => {
    const irradiance = clearSkyPoa(CALIBRATION.date, hour, DEFAULTS.tilt);
    return (irradiance / 1000) * DEFAULTS.capacity * pvTemperatureFactor(irradiance, 18);
  });

  let low = 0.1;
  let high = 5;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const mid = (low + high) / 2;
    const generated = baseHourly.reduce((sum, pv, hour) => (
      sum + applyRooftopProfile(pv * mid, hour, DEFAULTS)
    ), 0);
    if (generated < CALIBRATION.clearDayKwh) {
      low = mid;
    } else {
      high = mid;
    }
  }
  calibrationScaleCache = (low + high) / 2;
  return calibrationScaleCache;
}

/**
 * Apply the site-specific rooftop shape to a weather-adjusted theoretical PV value.
 *
 * Inputs:
 * - `theoreticalPv`: hourly kWh/h before site profile.
 * - `hour`: local hour 0-23.
 * - `cloudCover`: hourly cloud cover percent.
 *
 * Output:
 * - rooftop PV before feed-in curtailment.
 */
export function applyRooftopProfile(theoreticalPv, hour, settings = DEFAULTS, cloudCover = 0) {
  if (theoreticalPv <= 0) return 0;
  const sunnyOutput = applySunnyRooftopProfile(theoreticalPv, hour, settings);
  const diffuseWeight = smoothstep(
    ROOFTOP_PROFILE.diffuseCloudStartPct,
    ROOFTOP_PROFILE.diffuseCloudFullPct,
    cloudCover || 0
  );

  if (diffuseWeight <= 0) return sunnyOutput;

  // Diffuse light from cloudy skies softens the morning and evening shading/string effects.
  // A smooth daylight window captures that with few parameters and avoids fitting noise.
  const centerHour = hour + 0.5;
  const diffuseMorning = smoothstep(
    ROOFTOP_PROFILE.diffuseMorningRampStartHour,
    ROOFTOP_PROFILE.diffuseMorningFullHour,
    centerHour
  );
  const diffuseEvening = 1 - smoothstep(
    ROOFTOP_PROFILE.diffuseEveningRampStartHour,
    ROOFTOP_PROFILE.diffuseEveningEndHour,
    centerHour
  );
  const diffuseOutput = theoreticalPv * diffuseMorning * diffuseEvening * ROOFTOP_PROFILE.diffuseOutputFactor;

  return sunnyOutput * (1 - diffuseWeight) + diffuseOutput * diffuseWeight;
}

/**
 * Clear/direct-light profile derived from the sunny screenshots.
 * It intentionally creates a step around late morning and a sharp evening drop.
 */
function applySunnyRooftopProfile(theoreticalPv, hour, settings = DEFAULTS) {
  const lowCap = Math.min(ROOFTOP_PROFILE.lowOutputCapKw, settings.capacity);
  const lowOutput = Math.min(theoreticalPv * ROOFTOP_PROFILE.lowOutputFactor, lowCap);

  if (hour < ROOFTOP_PROFILE.morningLowUntilHour) {
    return lowOutput;
  }

  if (hour >= ROOFTOP_PROFILE.eveningDropHour) {
    return lowOutput;
  }

  const transitionStart = ROOFTOP_PROFILE.eveningDropHour - ROOFTOP_PROFILE.eveningTransitionHours;
  if (hour >= transitionStart) {
    const progress = (hour - transitionStart) / ROOFTOP_PROFILE.eveningTransitionHours;
    return theoreticalPv * (1 - progress) + lowOutput * progress;
  }

  return theoreticalPv;
}

/**
 * Smooth interpolation helper used for cloud blending and diffuse-light daylight windows.
 * Returns 0 below `edge0`, 1 above `edge1`, and a smooth cubic transition in between.
 */
function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const progress = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}

/**
 * Estimate module temperature derating from irradiance and ambient temperature.
 * Returns a bounded multiplier, not an absolute temperature.
 */
export function pvTemperatureFactor(irradiance, ambientTemperature) {
  const panelTemp = ambientTemperature + (Math.max(0, irradiance) / 800) * 20;
  return clamp(1 - 0.0035 * (panelTemp - 25), 0.82, 1.06);
}

/**
 * Empirical correction for high-cloud hours where Open-Meteo tilted irradiance under-forecast
 * the actual generation. Clear hours return the original irradiance unchanged.
 */
export function cloudAdjustedIrradiance(irradiance, cloudCover, precipitation = 0, dailyWeather = {}) {
  if (irradiance <= 0) return 0;
  const cloud = clamp((cloudCover || 0) / 100, 0, 1);
  const lowIrradianceWeight = Math.pow(
    clamp(1 - irradiance / CLOUD_RESPONSE.irradianceReferenceWm2, 0, 1),
    CLOUD_RESPONSE.irradianceExponent
  );
  const multiplier = Math.min(
    CLOUD_RESPONSE.maxMultiplier,
    1 + CLOUD_RESPONSE.cloudGain * cloud * lowIrradianceWeight
  );
  const brightIrradianceWeight = smoothstep(
    CLOUD_RESPONSE.brightDampingStartWm2,
    CLOUD_RESPONSE.brightDampingFullWm2,
    irradiance
  );
  const dailyDamping = weatherDampingWeight(dailyWeather);
  const brightDamping = 1 - CLOUD_RESPONSE.brightDampingStrength * cloud * brightIrradianceWeight * dailyDamping;
  const rainDamping = 1 / (1 + CLOUD_RESPONSE.hourlyRainLoss * Math.max(0, precipitation || 0));

  return irradiance * multiplier * clamp(brightDamping, 0.25, 1.1) * rainDamping;
}

function weatherDampingWeight(dailyWeather = {}) {
  const dailyRain = Number.isFinite(dailyWeather.precipitationSum) ? Math.max(0, dailyWeather.precipitationSum) : null;
  const sunshineHours = Number.isFinite(dailyWeather.sunshineHours) ? Math.max(0, dailyWeather.sunshineHours) : null;
  const cloudCoverMean = Number.isFinite(dailyWeather.cloudCoverMean) ? Math.max(0, dailyWeather.cloudCoverMean) : null;
  return clamp(
    (dailyRain === null ? 0 : CLOUD_RESPONSE.dailyRainDampingWeight * smoothstep(0, CLOUD_RESPONSE.dailyRainDampingFullMm, dailyRain)) +
    (sunshineHours === null ? 0 : CLOUD_RESPONSE.lowSunDampingWeight * smoothstep(
      CLOUD_RESPONSE.lowSunNoneHours,
      CLOUD_RESPONSE.lowSunFullHours,
      sunshineHours
    )) +
    (cloudCoverMean === null ? 0 : CLOUD_RESPONSE.dailyCloudDampingWeight * smoothstep(
      CLOUD_RESPONSE.dailyCloudDampingStartPct,
      CLOUD_RESPONSE.dailyCloudDampingFullPct,
      cloudCoverMean
    )),
    0,
    1.2
  );
}

function diffuseDawnFloor(hour, cloudCover, settings = DEFAULTS) {
  if (hour < 5 || hour > 6) return 0;
  const cloud = clamp((cloudCover || 0) / 100, 0, 1);
  return CLOUD_RESPONSE.dawnDiffuseFloorKwh * cloud * (settings.capacity / DEFAULTS.capacity);
}

/**
 * Deterministic fallback irradiance for offline mode. It starts from local clear-sky POA
 * and applies a simple cloud attenuation curve.
 */
export function fallbackIrradiance(date, hour, tilt, cloudCover) {
  const clear = clearSkyPoa(date, hour, tilt);
  const cloudFactor = clamp(1 - 0.72 * Math.pow(cloudCover / 100, 1.35), 0.08, 1);
  return clear * cloudFactor;
}

/**
 * Clear-sky plane-of-array irradiance approximation for the configured south-facing roof.
 * Used for the full-sun calibration and for offline fallback forecasts.
 */
export function clearSkyPoa(dateString, hour, tiltDeg) {
  const lat = toRad(LOCATION.latitude);
  const tilt = toRad(tiltDeg);
  const day = dayOfYear(dateString);
  const decl = toRad(23.45 * Math.sin(toRad((360 / 365) * (284 + day))));
  const b = toRad((360 / 365) * (day - 81));
  const equationOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const standardMeridian = 15;
  const timeCorrection = 4 * (LOCATION.longitude - standardMeridian) + equationOfTime;
  const solarTime = hour + 0.5 + timeCorrection / 60;
  const hourAngle = toRad(15 * (solarTime - 12));
  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  if (cosZenith <= 0) return 0;

  const cosIncidence =
    Math.sin(decl) * Math.sin(lat) * Math.cos(tilt) -
    Math.sin(decl) * Math.cos(lat) * Math.sin(tilt) +
    Math.cos(decl) * Math.cos(lat) * Math.cos(tilt) * Math.cos(hourAngle) +
    Math.cos(decl) * Math.sin(lat) * Math.sin(tilt) * Math.cos(hourAngle);

  const ghi = 1098 * cosZenith * Math.exp(-0.059 / cosZenith);
  const beam = Math.max(0, ghi * 0.82 * Math.max(0, cosIncidence) / Math.max(0.12, cosZenith));
  const diffuse = ghi * 0.18 * ((1 + Math.cos(tilt)) / 2);
  const reflected = ghi * 0.2 * ((1 - Math.cos(tilt)) / 2);
  return Math.max(0, beam + diffuse + reflected);
}
