export const LOCATION = {
  name: "OHZ / Osterholz-Scharmbeck",
  latitude: 53.226,
  longitude: 8.795,
  timezone: "Europe/Berlin"
};

export const CALIBRATION = {
  date: "2026-05-01",
  // Recalibrated on stored Open-Meteo day-ahead forecast/actual history through 2026-05-29.
  // The out-of-sample tests favoured the current model for OM DA, with a small scale reduction.
  clearDayKwh: 48.753
};

export const ROOFTOP_PROFILE = {
  morningLowUntilHour: 10.67,
  eveningDropHour: 17.61,
  lowOutputCapKw: 1.44,
  lowOutputFactor: 0.286,
  eveningTransitionHours: 0.89,
  diffuseCloudStartPct: 57.94,
  diffuseCloudFullPct: 93.47,
  diffuseMorningRampStartHour: 4.5,
  diffuseMorningFullHour: 7.9,
  diffuseEveningRampStartHour: 13.18,
  diffuseEveningEndHour: 19.9,
  diffuseOutputFactor: 1.2
};

export const CLOUD_RESPONSE = {
  maxMultiplier: 1.748,
  cloudGain: 2.2,
  irradianceReferenceWm2: 577,
  irradianceExponent: 1.855,
  brightDampingStartWm2: 265,
  brightDampingFullWm2: 818,
  brightDampingStrength: 0.763,
  dailyRainDampingWeight: 0.195,
  dailyRainDampingFullMm: 3.116,
  lowSunDampingWeight: 0.747,
  lowSunFullHours: 3.755,
  lowSunNoneHours: 10.267,
  dailyCloudDampingWeight: 0.458,
  dailyCloudDampingStartPct: 61.016,
  dailyCloudDampingFullPct: 93.522,
  hourlyRainLoss: 0.955,
  dawnDiffuseFloorKwh: 0.2
};

export const DEFAULTS = {
  capacity: 10,
  tilt: 35,
  battery: 10,
  batteryStart: 50,
  feedCap: 6,
  price: 0.3,
  tariff: 0.0778,
  baseLoad: 0.2,
  dayLoad: 0.2,
  eveningLoad: 0.6
};

export const FORECAST_DAYS = 14;

export const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
