# SolarGen Production Model Selection Report

Date: 2026-09-26
Scope: production forecast recalibration using every stored paired Open-Meteo and DWD day-ahead forecast date with actual generation.

## Executive Summary

The selected model keeps the equal source blend but applies the known curtailment structure hourly:

```text
uncapped_hour = 0.50 * OM_current_hour
              + 0.50 * DWD_stable_hour
forecast_hour = min(6.1 kWh, uncapped_hour)
production = sum(forecast_hour)
```

The uncapped blend is retained as theoretical generation, and the difference is exposed as curtailed generation. There is no fitted production coefficient or bias.

This model improves all aggregate validation views against the previous uncapped equal blend, but the improvement is modest: the paired bootstrap interval includes zero and June is worse. It is selected because it combines near-best accuracy, zero fitted parameters, and the correct physical treatment of the observed cap.

## Data Used

The fair comparison set contains 129 dates with both source forecasts and hourly actuals:

- first date: `2026-05-14`
- latest date: `2026-09-25`
- source inputs: Open-Meteo day-ahead and DWD MOSMIX day-ahead
- target: `sum(min(hourly_actual_kWh, 6.1))`
- incomplete dates omitted: `2026-08-08`, `2026-08-09`, `2026-08-10`, and `2026-08-12`

The cap removes `102.666 kWh` from 54 of the 129 paired dates. That energy is still shown in the history UI, but it is not counted against the forecast because it depends on coincident household consumption above the curtailment level.

## Candidate Models

`scripts/select_production_model.py` evaluates:

- fixed OM-only, DWD-only, old 73/27, and equal source models;
- convex source weights, mean/median bias, and affine recalibrations;
- structural variants that cap sources separately or cap the blended hourly curve;
- linear source/weather models;
- scikit-learn Ridge, Lasso, ElasticNet, Huber, RandomForest, and GradientBoosting models.

Validation includes leave-one-date-out, chronological rolling forecasts with a 21-day initial training window, a recent 14-day holdout, monthly slices, and a paired bootstrap comparison. The selection rule chooses the fewest fitted parameters among candidates within one standard error of the best rolling MAE, then breaks equal-complexity ties by rolling and leave-one-out MAE.

## Candidate Results

| Candidate | Fitted degrees | In-sample MAE | LOO MAE | Rolling MAE | Recent-14 MAE | LOO bias |
|---|---:|---:|---:|---:|---:|---:|
| Huber capped weather | 12 | `4.910` | `5.243` | `5.736` | `4.867` | `-0.919` |
| Equal hourly blend, then 6.1 cap | 0 | `5.313` | `5.313` | `5.736` | `4.980` | `-0.631` |
| Equal capped OM + capped DWD stable | 0 | `5.354` | `5.354` | `5.763` | `4.981` | `-0.519` |
| Linear OM + DWD stable + bias | 3 | `5.297` | `5.418` | `5.748` | `5.090` | `-0.004` |
| RidgeCV raw weather | 12 | `5.121` | `5.453` | `5.755` | `5.512` | `-0.026` |
| Previous uncapped equal blend | 0 | `5.455` | `5.455` | `5.867` | `5.097` | `-1.661` |
| Old 0.73 OM / 0.27 DWD stable | 0 | `5.541` | `5.541` | `5.985` | `4.857` | `-1.565` |
| RandomForest capped weather | 20 | `4.851` | `5.778` | `6.213` | `5.163` | `-0.023` |

The Huber model has the lowest leave-one-out MAE, but its advantage over the selected model is only `0.070 kWh/day`; both have the same rolling MAE to three decimals. The fitted ML model is not justified by that gain on a 129-date, partial-year sample.

## Baseline Comparison

Negative bias means the forecast is too high on average.

| Validation | Previous MAE | Selected MAE | MAE change | Previous RMSE | Selected RMSE | Previous bias | Selected bias | Previous WAPE | Selected WAPE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Leave-one-out | `5.455` | `5.313` | `-0.142` | `7.974` | `7.502` | `-1.661` | `-0.631` | `15.381%` | `14.982%` |
| Rolling | `5.867` | `5.736` | `-0.130` | `8.529` | `8.025` | `-1.770` | `-0.888` | `17.009%` | `16.632%` |
| Recent 14 | `5.097` | `4.980` | `-0.117` | `5.942` | `5.924` | `-0.089` | `0.028` | `16.183%` | `15.813%` |

On the 129 paired dates, the selected model reduces MAE by `0.142 kWh/day`. Its paired bootstrap 95% interval is `[-0.139, 0.431]`, so the sample does not establish a statistically decisive gain. It wins on 58 dates, ties on 12, and loses on 59; the aggregate gain comes mainly from reducing larger overforecasts.

## Monthly Check

| Month | Dates | Previous MAE | Selected MAE | Change |
|---|---:|---:|---:|---:|
| 2026-05 | 18 | `3.397` | `3.163` | `-0.234` |
| 2026-06 | 30 | `4.693` | `5.197` | `+0.504` |
| 2026-07 | 31 | `4.991` | `4.826` | `-0.165` |
| 2026-08 | 25 | `9.535` | `8.598` | `-0.937` |
| 2026-09 | 25 | `4.346` | `4.320` | `-0.026` |

The model improves four of five monthly slices. The June regression and absence of winter data remain material limitations.

## Decision

Select the equal hourly blend followed by the 6.1 kWh hourly cap.

The candidate is better than the previous production model on aggregate MAE, RMSE, absolute bias, WAPE, chronological rolling validation, and the recent holdout. It also has a direct physical interpretation and adds no fitted parameter. The ML alternatives remain analysis candidates until materially more seasonal data is available.

After recomputing stored production rows, database performance is `5.313 kWh` MAE, `7.502 kWh` RMSE, `-0.631 kWh` bias, and `14.982%` WAPE on 129 paired dates.

## Maintenance

```sh
python3 scripts/select_production_model.py
python3 -m history_app.cli recompute-production
npm run check
npm test
```

Update `docs/methodology.md`, `docs/model-documentation.tex`, and visible app copy with every production-model change.
