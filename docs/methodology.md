# Forecast Methodology

This document describes the SolarGen production forecast model used by both forecast surfaces:

- the public/static browser forecast;
- the local history/production forecast.

Both surfaces now use the same production-transfer structure: Open-Meteo current physical forecast plus DWD stable forecast, blended with a modest Open-Meteo weight. The static browser fetches DWD ICON through Open-Meteo's DWD endpoint because it must run without Python or a local database. The local history app stores DWD MOSMIX input rows because that is the retained historical DWD source. Both apply the same DWD stable transfer and production blend.

## System Scope

Default system:

- location: OHZ / Osterholz-Scharmbeck, Germany
- PV array: `10 kWp`
- roof: south-facing, `35 deg` tilt
- battery: `10 kWh`
- grid-facing feed-in cap: `6 kW`

## Source Physical Model

The Open-Meteo current forecast and DWD current forecast are both converted to PV output with the same site-specific physical model in `src/model.js`. The model consumes hourly weather for the configured location and roof geometry:

- `global_tilted_irradiance`
- `temperature_2m`
- `cloud_cover`
- `precipitation`
- `weather_code`

Daily summary values are also used and stored in history snapshots: weather code, max/min temperature, precipitation sum, mean cloud cover, and sunshine duration.

For each hour, the physical model computes:

```text
adjusted_irradiance = global_tilted_irradiance
                    * cloud_response
                    * bright_cloud_damping
                    * hourly_rain_damping

theoretical_pv = adjusted_irradiance / 1000
               * capacity_kWp
               * calibration_scale
               * temperature_factor
```

Hourly kW averages are treated as kWh over that hour.

### Physical-Model Calibration

The source physical model has two calibration layers:

- clear-sky anchor: `2026-05-01`, measured full-sun output `50.23 kWh`;
- Open-Meteo weather-response and rooftop-profile calibration: stored forecast-vs-actual history through `2026-05-29`.

This physical model is still used as an input model. It is no longer the final displayed browser forecast.

### Rooftop Profile

The rooftop profile reflects the observed site behavior:

- low output before the late-morning production window;
- full output through the main production window;
- late-afternoon/evening output drop;
- smoother morning/evening behavior under high cloud cover because diffuse light reduces hard shading effects.

The clear low-output branch is:

```text
low_output = min(theoretical_pv * 0.286, 1.44)
```

Cloudy hours blend between the clear profile and a diffuse-light daylight window using cloud cover as the blend weight.

## Production Forecast

The production forecast is the displayed forecast in the browser app and the visible forecast in the local history app. The local history app stores source forecasts but only displays the blended production forecast.

Source inputs:

- browser app: Open-Meteo forecast API plus Open-Meteo DWD ICON API;
- local history app: Open-Meteo forecast API plus DWD MOSMIX.

In both cases:

- OM input is the current physical model total;
- DWD input is converted through the DWD stable transfer model.

DWD stable transfer:

```text
DWD_stable = 0.25 * DWD_current_physical
           + 0.75 * DWD_sunshine_rain
           + 4.039
```

Production blend and forecastable output:

```text
uncapped_hour = 0.50 * OM_current_hour
              + 0.50 * DWD_stable_hour
forecast_hour = min(6.1 kWh, uncapped_hour)
production = sum(forecast_hour)
```

There is no production-blend bias term or fitted production parameter in the current model. The uncapped blend remains available as theoretical output; the difference is reported as curtailment.

Selection basis: all 129 available paired Open-Meteo and DWD day-ahead forecast dates with actuals from `2026-05-14` through `2026-09-25`. Validation uses a forecastable actual target built from hourly actuals capped at `6.1 kWh`; energy above that level is ignored because it depends on random coincident self-consumption rather than weather-driven PV availability.

The selection compared fixed blends, bias and affine recalibrations, source-transfer changes, hourly cap structures, and scikit-learn Ridge, Lasso, ElasticNet, Huber, RandomForest, and GradientBoosting models. Huber regression had the lowest leave-one-date-out MAE (`5.243 kWh`) but used 12 fitted degrees and tied the zero-parameter hourly-capped blend on chronological rolling MAE (`5.736 kWh`). The selection rule chooses the fewest fitted parameters within one standard error of the best rolling result, then breaks equal-complexity ties by rolling and leave-one-out MAE.

Current stored-history performance for the selected hourly-capped equal blend on 129 paired actual days:

| Metric | Value |
|---|---:|
| MAE | `5.313 kWh` |
| RMSE | `7.502 kWh` |
| Bias | `-0.631 kWh` |
| WAPE | `14.982%` |

## Hourly Production Allocation

SolarGen scales the DWD hourly curve to its stable daily total, then blends it with the Open-Meteo hourly curve. Each blended hour is capped at `6.1 kWh` for forecastable production. The uncapped hourly value is retained as theoretical production so the above-cap amount remains visible.

The production daily total is the sum of the capped hourly values, avoiding a daily cap that would distort the generation shape.

## Curtailment and Delivered PV

The grid-facing feed-in cap is applied to hourly rooftop generation:

```text
curtailed_kWh = max(0, rooftop_pv_kWh - feed_cap_kW)
delivered_kWh = rooftop_pv_kWh - curtailed_kWh
```

For production-blend history rows, `forecast_kwh`, `delivered_kwh`, and `theoretical_kwh` all represent the production forecast curve, and `curtailed_kwh` is stored as zero because the production blend is already an empirical output forecast.

## Household Consumption Profile

The browser app uses a deliberately simple three-level household load profile for battery, import, export, and value calculations:

```text
00:00-09:00 and 23:00-24:00: 0.46 kWh/h
09:00-18:00:                 0.46 + 0.21 = 0.67 kWh/h
18:00-23:00:                 0.46 + 0.22 = 0.68 kWh/h
daily total:                                  14.03 kWh
```

The profile was calibrated on EcoFlow `load_power_w` telemetry from May 17 through September 26, 2026. Samples were integrated in local time with gaps longer than 15 minutes excluded. Calibration retained 1,393 date-hour observations across 99 dates with at least 75% coverage in each hour.

Candidate models kept the same three parameters and varied only the daytime/evening boundaries and the existing early-morning ramp. The selected 09:00-18:00 daytime and 18:00-23:00 evening structure removes the unsupported morning ramp and stays close to the best chronological-validation candidates while preserving intuitive operating periods. Against the retained hourly observations, the implemented rounded profile improves MAE from `0.283 kW` to `0.236 kW`, RMSE from `0.494 kW` to `0.434 kW`, and mean bias from `-0.162 kW` to `-0.005 kW` compared with the previous defaults.

## Actuals and Accuracy Metrics

Actuals can be stored as a daily total, 24 hourly values, or both.

Daily total error:

```text
error_kWh = actual_total_kWh - forecast_total_kWh
```

Daily percentage error:

```text
error_pct = error_kWh / forecast_total_kWh * 100
```

Hourly metrics, when hourly actuals are available:

```text
MAE = mean(abs(actual_hour_kWh - forecast_hour_kWh))
RMSE = sqrt(mean((actual_hour_kWh - forecast_hour_kWh)^2))
```

Positive daily error means actual generation exceeded the forecast. Negative daily error means the forecast was too high.

## Maintenance Rules

Whenever the production model changes:

1. update `history_app/forecast_model.py`;
2. run `python3 -m history_app.cli recompute-production`;
3. update this document, `docs/model-documentation.tex`, and the visible app/header copy if the calibration period changes;
4. regenerate `docs/model-documentation.pdf` when LaTeX is available;
5. run `npm run check` and `npm test`.
