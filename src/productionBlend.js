import { DEFAULTS } from "./config.js";
import { householdLoad, sumHours } from "./model.js";

export const DWD_STABLE_CURRENT_WEIGHT = 0.25;
export const DWD_STABLE_RAW_WEIGHT = 0.75;
export const DWD_STABLE_BIAS_KWH = 4.039;
export const PRODUCTION_OM_WEIGHT = 0.5;
export const PRODUCTION_DWD_WEIGHT = 0.5;

/**
 * Combine simulated Open-Meteo and DWD forecast days into the production forecast.
 * The daily total uses the same transfer structure as the local history app:
 *   0.5 * OM current + 0.5 * DWD stable
 * where DWD stable is a blend of the DWD physical model and the sunshine/rain model.
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

    const targetTotal =
      PRODUCTION_OM_WEIGHT * omDay.pv +
      PRODUCTION_DWD_WEIGHT * dwdStableTotal;
    scaleHoursToTotal(baseHours, targetTotal);

    const hours = baseHours.map(hour => {
      const curtailed = Math.max(0, hour.pv - settings.feedCap);
      const deliveredPv = hour.pv - curtailed;
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
    blended.push({
      ...omDay,
      sourceModel: "Production equal blend",
      sourceOpenMeteoTotal: omDay.pv,
      sourceDwdStableTotal: dwdStableTotal,
      sourceDwdCurrentTotal: dwdDay.pv,
      sourceDwdRawTotal: dwdRawSunshineRainTotal(dwdDay),
      hours,
      ...totals,
      savings: totals.selfConsumed * settings.price,
      earnings: totals.exportKwh * settings.tariff,
      totalValue: totals.selfConsumed * settings.price + totals.exportKwh * settings.tariff
    });
  }

  return blended;
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
