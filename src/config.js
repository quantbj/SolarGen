export const LOCATION = {
  name: "OHZ / Osterholz-Scharmbeck",
  latitude: 53.226,
  longitude: 8.795,
  timezone: "Europe/Berlin"
};

export const CALIBRATION = {
  date: "2026-05-01",
  clearDayKwh: 50.23
};

export const ROOFTOP_PROFILE = {
  morningLowUntilHour: 10,
  eveningDropHour: 17,
  lowOutputCapKw: 0.95,
  lowOutputFactor: 0.14,
  eveningTransitionHours: 0.5,
  diffuseCloudStartPct: 50,
  diffuseCloudFullPct: 95,
  diffuseMorningRampStartHour: 7,
  diffuseMorningFullHour: 12,
  diffuseEveningRampStartHour: 16,
  diffuseEveningEndHour: 20,
  diffuseOutputFactor: 0.85
};

export const CLOUD_RESPONSE = {
  maxMultiplier: 2,
  cloudGain: 1.3,
  irradianceReferenceWm2: 1400,
  irradianceExponent: 0.5
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
