# Forecast Methodology

This document describes how SolarGen converts weather forecast data into rooftop PV generation forecasts and how it compares forecasts against actual generation.

## Scope

The methodology currently models a 10 kWp south-facing rooftop system in OHZ / Osterholz-Scharmbeck, Germany, with a 6 kW grid-facing feed-in cap. The browser forecast app also models household load, battery flow, avoided cost, and feed-in revenue. The local history app focuses on forecast accuracy: forecast PV generation vs actual PV generation.

## Weather Inputs

SolarGen requests hourly Open-Meteo forecast data for the configured location and roof geometry:

- `global_tilted_irradiance`: irradiance on the tilted panel plane, W/m2
- `temperature_2m`: ambient air temperature, deg C
- `cloud_cover`: cloud cover, percent
- `precipitation`: hourly rain, mm
- `weather_code`: weather condition code

Daily weather summary values are also stored with each history snapshot:

- daily weather code
- daily maximum and minimum temperature
- daily precipitation sum
- daily mean cloud cover
- daily sunshine duration

Assumption: Open-Meteo `global_tilted_irradiance` already accounts for the selected tilt and south-facing azimuth. SolarGen therefore does not separately transpose global horizontal irradiance when this API field is available.

## Irradiance to Theoretical PV

For each hour:

```text
cloud_adjusted_irradiance = irradiance_Wm2 * cloud_response_multiplier
theoretical_kWh = cloud_adjusted_irradiance / 1000 * capacity_kWp * calibration_scale * temperature_factor
```

The model treats hourly average kW as kWh for that hour. For example, a modeled 5.2 kW hourly average contributes 5.2 kWh to the daily total.

## Cloud-Day Recalibration

The first three day-ahead forecast comparisons showed a systematic under-forecast on high-cloud days:

- `2026-05-04`: forecast `19.18 kWh`, actual `36.41 kWh`
- `2026-05-05`: forecast `7.42 kWh`, actual `14.47 kWh`
- `2026-05-08`: forecast `52.34 kWh`, actual `55.15 kWh`

The sunny/mostly clear day was close, while the overcast days were roughly half the actual generation. SolarGen therefore applies an empirical cloud response multiplier before temperature derating:

```text
cloud_fraction = cloud_cover_pct / 100
low_irradiance_weight = sqrt(1 - irradiance_Wm2 / 1400)
cloud_response_multiplier = min(2.0, 1 + 1.3 * cloud_fraction * low_irradiance_weight)
```

The low-irradiance weight is clamped between `0` and `1`. Clear hours keep multiplier `1.0`; high-cloud, low-irradiance hours can be lifted up to `2.0`; bright high-irradiance hours are changed much less.

This is an empirical correction to the Open-Meteo tilted irradiance input for this site. It is intentionally conservative and should be refit once more measured days are available.

## Temperature Derating

SolarGen estimates panel temperature from ambient air temperature and irradiance:

```text
panel_temp_C = ambient_temp_C + irradiance_Wm2 / 800 * 20
```

The PV temperature factor is:

```text
temperature_factor = 1 - 0.0035 * (panel_temp_C - 25)
```

The factor is clamped between `0.82` and `1.06`.

Assumptions:

- PV output drops by 0.35% per deg C above 25 deg C panel temperature.
- Panel temperature is approximated; no wind cooling model is included.
- This is adequate for first-order forecast correction, not for equipment acceptance testing.

## Calibration

The installation was calibrated against the full-sun measured day from May 1, 2026, with `50.23 kWh` total generation.

SolarGen computes a local clear-sky tilted irradiance curve for that date and then solves a single multiplicative `calibration_scale` so that the default 10 kWp system reproduces `50.23 kWh` after applying the rooftop profile.

Assumptions:

- May 1, 2026 was effectively cloud-free for calibration.
- The measured total is representative of the installed array, inverter, roof geometry, and site-specific losses.
- A single multiplicative scale is used across future dates.

## Rooftop Profile

The screenshots show that generation starts around 06:00 but remains below roughly 1 kW until about 10:00, then rises sharply to the curtailed range. Output drops sharply again around 17:00.

To reflect this, SolarGen applies a site profile after theoretical PV is calculated:

- before 10:00, output is limited to a low-output branch
- from 10:00 until late afternoon, output follows the theoretical curve
- around 17:00, output transitions back to the low-output branch

The low-output branch is:

```text
low_output = min(theoretical * 0.14, 0.95 kW)
```

Assumptions:

- This profile captures shading, inverter/string behavior, or roof/string layout effects visible in the sample data.
- The profile is deliberately empirical and can be recalibrated once more actual days are available.

## Curtailment

The grid-facing feed-in cap is 6 kW. SolarGen treats all rooftop PV above this cap as curtailed:

```text
curtailed_kWh = max(0, rooftop_pv_kWh - feed_cap_kW)
delivered_kWh = rooftop_pv_kWh - curtailed_kWh
```

Assumption: for hourly data, the kW cap is applied to the hourly average. Sub-hourly clipping is not visible unless actuals later provide finer resolution.

## Day-Ahead Forecast Snapshot

The local history app stores one day-ahead snapshot per issue date and target date. If captured on `2026-05-03`, the target date is `2026-05-04`.

Each snapshot stores:

- issue timestamp and issue date
- target date
- model source and settings
- daily forecast totals
- 24 hourly modeled forecast values
- 24 hourly meteo inputs used to create the forecast

This is important because future forecast data changes over time. Accuracy must be measured against the forecast that was known before the target day, not against a refreshed forecast after the actual generation is known.

## Shared Implementation

The browser forecast app and the local history app use the same JavaScript model in `src/model.js`. The history app remains a local Python server for SQLite and HTTP handling, but it delegates day-ahead forecast conversion to `src/historyForecastCli.mjs`. This avoids maintaining separate PV formulas in Python and JavaScript.

## Actuals

Manual actuals can be entered as:

- daily total only
- daily total plus 24 hourly kWh values
- 24 hourly values only, in which case the daily total is derived as their sum

Assumptions:

- Actuals represent PV generation for the same system and local day.
- Hourly values are ordered from 00:00 through 23:00 local time.
- Later API ingestion should map vendor timestamps into the same local hourly buckets before storage.

## Accuracy Metrics

Daily total error:

```text
error_kWh = actual_total_kWh - forecast_total_kWh
```

Daily percentage error:

```text
error_pct = error_kWh / forecast_total_kWh * 100
```

Hourly mean absolute error, when 24 hourly actuals exist:

```text
MAE = mean(abs(actual_hour_kWh - forecast_hour_kWh))
```

Hourly root mean squared error, when 24 hourly actuals exist:

```text
RMSE = sqrt(mean((actual_hour_kWh - forecast_hour_kWh)^2))
```

Interpretation:

- positive daily error means actual generation was higher than forecast
- negative daily error means actual generation was lower than forecast
- RMSE penalizes large hourly profile mismatches more strongly than MAE

## Known Limitations

The current methodology does not yet include:

- inverter efficiency curves
- sub-hourly clipping losses
- snow or soiling
- wind-based module cooling
- measured household load
- vendor API actual ingestion
- automatic parameter fitting from a larger forecast-error history

Those are natural future improvements once enough forecast/actual history has been collected.
