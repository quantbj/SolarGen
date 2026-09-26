import { DEFAULTS } from "./config.js?v=20260926-load";
import { householdLoad, sumHours } from "./model.js?v=20260926-load";

export const DWD_STABLE_CURRENT_WEIGHT = 0.25;
export const DWD_STABLE_RAW_WEIGHT = 0.75;
export const DWD_STABLE_BIAS_KWH = 4.039;
export const PRODUCTION_OM_WEIGHT = 0.50;
export const PRODUCTION_DWD_WEIGHT = 0.50;
export const PRODUCTION_BLEND_BIAS_KWH = 0.0;
export const PRODUCTION_FORECASTABLE_HOURLY_CAP_KWH = 6.1;

/**
 * Combine simulated Open-Meteo and DWD forecast days into the production forecast.
 * The daily total uses the same transfer structure as the local history app:
 *   min(6.1 kWh, 0.50 * OM current hour + 0.50 * DWD stable hour)
 * where DWD stable is a blend of the DWD physical model and the sunshine/rain model.
 * The uncapped blend remains available as theoretical PV and curtailment.
 */
export function blendProductionForecastDays(openMeteoDays, dwdDays, settings = DEFAULTS) {
  const count = Math.min(openMeteoDays.length, dwdDays.length);
  let batterySoc = settings.battery * (settings.batteryStart / 100);
  const blended = [];

  for (let index = 0; index < count; index += 1) {
    const omDay = openMeteoDays[index];
    const dwdDay = dwdDays[index];
    const dwdStableTotal = dwdStableForecastTotal(dwdDay);
    const dwdScale = dwdDay.pv > 0 ? dwdStableTotal / dwdDay.pv : 0;
    const baseHours = omDay.hours.map((omHour, hourIndex) => {
      const dwdHour = dwdDay.hours[hourIndex] || omHour;
      const blendedPv =
        PRODUCTION_OM_WEIGHT * omHour.pv +
        PRODUCTION_DWD_WEIGHT * dwdHour.pv * dwdScale;
      return {
        ...omHour,
        sourceOpenMeteoPv: omHour.pv,
        sourceDwdPv: dwdHour.pv,
        sourceDwdStablePv: dwdHour.pv * dwdScale,
        pv: Math.max(0, blendedPv),
        theoreticalPv: Math.max(0, blendedPv),
        curtailed: 0,
        deliveredPv: 0,
        load: householdLoad(omHour.hour, settings),
        direct: 0,
        discharge: 0,
        charge: 0,
        exportKwh: 0,
        importKwh: 0,
        batterySoc,
        batteryPercent: settings.battery > 0 ? (batterySoc / settings.battery) * 100 : 0
      };
    });

    const uncappedTargetTotal =
      PRODUCTION_OM_WEIGHT * omDay.pv +
      PRODUCTION_DWD_WEIGHT * dwdStableTotal +
      PRODUCTION_BLEND_BIAS_KWH;
    scaleHoursToTotal(baseHours, uncappedTargetTotal);
    baseHours.forEach(hour => { hour.theoreticalPv = hour.pv; });
    const simulation = simulateCappedHours(baseHours, settings, batterySoc);
    const hours = simulation.hours;
    batterySoc = simulation.batterySoc;

    const totals = sumHours(hours);
    blended.push({
      ...omDay,
      sourceModel: "Production hourly-capped equal blend",
      sourceOpenMeteoTotal: omDay.pv,
      sourceDwdStableTotal: dwdStableTotal,
      sourceDwdCurrentTotal: dwdDay.pv,
      sourceDwdRawTotal: dwdRawSunshineRainTotal(dwdDay),
      sourceUncappedBlendTotal: uncappedTargetTotal,
      forecastableHourlyCap: PRODUCTION_FORECASTABLE_HOURLY_CAP_KWH,
      hours,
      ...totals,
      savings: totals.selfConsumed * settings.price,
      earnings: totals.exportKwh * settings.tariff,
      totalValue: totals.selfConsumed * settings.price + totals.exportKwh * settings.tariff
    });
  }

  return blended;
}

/** Apply the production model's forecastable cap when live source blending is unavailable. */
export function capForecastableProductionDays(sourceDays, settings = DEFAULTS) {
  let batterySoc = settings.battery * (settings.batteryStart / 100);
  return sourceDays.map(sourceDay => {
    const baseHours = sourceDay.hours.map(hour => ({
      ...hour,
      theoreticalPv: Math.max(0, hour.pv)
    }));
    const simulation = simulateCappedHours(baseHours, settings, batterySoc);
    batterySoc = simulation.batterySoc;
    const totals = sumHours(simulation.hours);
    return {
      ...sourceDay,
      sourceModel: "Production hourly-capped fallback",
      sourceUncappedBlendTotal: baseHours.reduce((total, hour) => total + hour.theoreticalPv, 0),
      forecastableHourlyCap: PRODUCTION_FORECASTABLE_HOURLY_CAP_KWH,
      hours: simulation.hours,
      ...totals,
      savings: totals.selfConsumed * settings.price,
      earnings: totals.exportKwh * settings.tariff,
      totalValue: totals.selfConsumed * settings.price + totals.exportKwh * settings.tariff
    };
  });
}

export function dwdStableForecastTotal(day) {
  return Math.max(
    0,
    DWD_STABLE_CURRENT_WEIGHT * day.pv +
    DWD_STABLE_RAW_WEIGHT * dwdRawSunshineRainTotal(day) +
    DWD_STABLE_BIAS_KWH
  );
}

export function dwdRawSunshineRainTotal(day) {
  const daylightRain = day.hours
    .filter(hour => Number(hour.irradiance || 0) > 0)
    .reduce((total, hour) => total + Number(hour.precipitation || 0), 0);
  return Math.max(0, 18.3545 + 2.351 * Number(day.sunshineHours || 0) - 1.9219 * daylightRain);
}

function scaleHoursToTotal(hours, targetTotal) {
  const total = hours.reduce((sum, hour) => sum + hour.pv, 0);
  const scale = total > 0 ? targetTotal / total : 0;
  hours.forEach(hour => {
    hour.pv = Math.max(0, hour.pv * scale);
    hour.theoreticalPv = hour.pv;
  });
}

function simulateCappedHours(baseHours, settings, startingBatterySoc) {
  let batterySoc = startingBatterySoc;
  const hours = baseHours.map(hour => {
    const theoreticalPv = Math.max(0, hour.theoreticalPv);
    const pv = Math.min(theoreticalPv, PRODUCTION_FORECASTABLE_HOURLY_CAP_KWH);
    const deliveredPv = Math.min(pv, settings.feedCap);
    const curtailed = Math.max(0, theoreticalPv - deliveredPv);
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

    return {
      ...hour,
      theoreticalPv,
      pv,
      deliveredPv,
      load,
      direct,
      discharge,
      charge: chargeInput * 0.94,
      exportKwh: Math.min(surplus, settings.feedCap),
      curtailed,
      importKwh: Math.max(0, remainingLoad),
      batterySoc,
      batteryPercent: settings.battery > 0 ? (batterySoc / settings.battery) * 100 : 0
    };
  });
  return { hours, batterySoc };
}
