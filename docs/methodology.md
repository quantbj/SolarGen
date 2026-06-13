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

Production blend:

```text
production = 0.73 * OM_current_physical
           + 0.27 * DWD_stable
```

There is no production-blend bias term in the current model.

Selection basis: paired Open-Meteo and DWD day-ahead forecast history with actuals through `2026-06-12`. Recent post-`2026-06-05` errors showed the equal blend was being pulled low by the DWD stable leg. A small reweighting toward Open-Meteo improved the full retained sample without adding a bias term, which did not generalize in leave-one-out checks.

Current stored-history performance for the recalibrated blend on 30 paired actual days:

| Metric | Value |
|---|---:|
| MAE | `3.861 kWh` |
| RMSE | `5.186 kWh` |
| Bias | `1.185 kWh` |
| MAPE | `10.69%` |

## Hourly Production Allocation

The production blend is fitted at daily-total level. For hourly charts, SolarGen blends the Open-Meteo hourly curve with the DWD hourly curve after scaling the DWD hourly curve to its stable daily total. The blended hourly curve is then scaled so that the hourly sum exactly equals the production daily total.

The rounding adjustment is applied to the largest positive production hour so that no night hour becomes negative.

## Curtailment and Delivered PV

The grid-facing feed-in cap is applied to hourly rooftop generation:

```text
curtailed_kWh = max(0, rooftop_pv_kWh - feed_cap_kW)
delivered_kWh = rooftop_pv_kWh - curtailed_kWh
```

For production-blend history rows, `forecast_kwh`, `delivered_kwh`, and `theoretical_kwh` all represent the production forecast curve, and `curtailed_kwh` is stored as zero because the production blend is already an empirical output forecast.

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
