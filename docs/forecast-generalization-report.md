# SolarGen Forecast Generalization Report

Date: 2026-05-14  
Scope: out-of-sample testing of the SolarGen day-ahead generation model using the local SQLite history database.

## Executive Summary

The current production forecast model is too complex for the amount of measured data available. On the 8 historical day-ahead forecasts that have matching actuals, the stored production-model forecasts have a leave-one-out mean absolute error of 9.83 kWh and a MAPE of 34.0%.

The best simple candidate is a two-variable daily regression:

\[
\widehat{G}_{day} =
\max(0,\ 18.35 + 2.35H_{sun} - 1.92R_{daylight})
\]

where:

- \(H_{sun}\) is Open-Meteo sunshine duration in hours.
- \(R_{daylight}\) is precipitation summed only over hours with positive tilted irradiance.

This model is intentionally simple. It uses two weather variables and no fitted rooftop shape parameters. In leave-one-out testing it achieved 3.18 kWh MAE and 10.3% MAPE. In chronological walk-forward testing over 2026-05-10 through 2026-05-13 it achieved 2.42 kWh MAE and 7.9% MAPE.

Recommendation: do not add more machine-learning complexity yet. Use the two-variable daily model as the proposed daily total forecast, then distribute that daily total over the existing hourly curve shape. Keep the model under active validation as more actuals arrive.

## Data Used

The usable out-of-sample set is the subset of forecast runs that have actual generation for the target date:

| Target date | Actual kWh | Stored model forecast kWh | Rain mm | Cloud % | Sunshine h |
|---|---:|---:|---:|---:|---:|
| 2026-05-04 | 36.41 | 19.18 | 0.1 | 94 | 6.25 |
| 2026-05-05 | 14.47 | 7.42 | 4.5 | 100 | 0.00 |
| 2026-05-08 | 55.15 | 52.34 | 0.0 | 12 | 14.99 |
| 2026-05-09 | 33.41 | 47.11 | 0.0 | 59 | 7.95 |
| 2026-05-10 | 44.06 | 54.65 | 0.0 | 82 | 11.66 |
| 2026-05-11 | 27.40 | 39.62 | 0.2 | 95 | 4.56 |
| 2026-05-12 | 24.43 | 39.34 | 5.2 | 92 | 7.11 |
| 2026-05-13 | 38.31 | 38.43 | 3.0 | 91 | 8.93 |

This is a very small data set. It is enough to detect obvious overfitting, but not enough to justify a high-dimensional machine-learning model.

## Validation Design

Two checks were used:

1. Leave-one-out cross-validation: train on 7 days and test on the held-out day, repeated for all 8 days.
2. Chronological walk-forward validation: train on the first 4 measured forecast/actual pairs, then test the next day; repeat while expanding the training window.

The chronological test is stricter because it better resembles real future forecasting.

## Candidate Models Tested

The tested candidates included:

- Existing stored production-model forecast.
- Mean actual generation from the training set.
- Scale-only correction of the stored forecast.
- Simple rain-damped stored forecast.
- Ordinary least squares regressions using 1 to 3 features.
- Ridge regressions using current forecast, rain, sunshine, cloud, irradiance, and curtailment features.
- k-nearest-neighbor weather analog models as a lightweight machine-learning alternative.

Tree models, neural networks, and richer ML models were rejected as inappropriate for 8 observations. They would have far more degrees of freedom than the data can support.

## Main Results

### Leave-One-Out Cross-Validation

| Model | Features | MAE kWh | RMSE kWh | MAPE | Max abs error kWh |
|---|---|---:|---:|---:|---:|
| Current stored model | existing forecast | 9.83 | 11.32 | 34.0% | 17.23 |
| Training mean only | none | 10.60 | 13.34 | 40.1% | 23.94 |
| Scale current forecast | current forecast | 9.79 | 10.88 | 32.3% | 20.43 |
| OLS forecast + rain | current forecast, rain | 9.08 | 10.23 | 28.1% | 15.41 |
| Ridge forecast + rain + sun | current forecast, rain, sunshine | 7.04 | 7.73 | 24.1% | 14.38 |
| Sun-only regression | sunshine | 3.25 | 4.45 | 10.8% | 9.47 |
| Sunshine + daylight rain | sunshine, daylight rain | 3.18 | 3.47 | 10.3% | 5.66 |
| OLS forecast + sun + daylight rain | forecast, sunshine, daylight rain | 1.34 | 1.69 | 5.2% | 3.18 |
| OLS theoretical + rain + sun | theoretical output, rain, sunshine | 1.59 | 1.79 | 5.3% | 3.07 |
| Best kNN weather analog | sunshine, daylight rain | 6.11 | 8.34 | 24.0% | 15.09 |

The 3-feature OLS models score best numerically, but they are not the best proposal because their fitted coefficients are not physically stable. For example, some fitted versions assign a negative coefficient to the current forecast or theoretical output after controlling for sunshine. That is a strong overfitting warning.

### Chronological Walk-Forward Validation

The walk-forward window tests 2026-05-10 through 2026-05-13 after training only on earlier days.

| Model | MAE kWh | RMSE kWh | MAPE | Max abs error kWh |
|---|---:|---:|---:|---:|
| Current stored model | 9.46 | 11.00 | 32.5% | 14.91 |
| Mean actual only | 8.48 | 8.78 | 27.7% | 10.72 |
| Scale current forecast | 8.59 | 8.76 | 27.7% | 10.25 |
| OLS forecast + rain | 6.62 | 8.01 | 21.2% | 13.09 |
| Ridge forecast + rain + sun | 5.41 | 5.76 | 18.0% | 8.41 |
| Sun-only regression | 3.23 | 4.93 | 11.8% | 9.52 |
| Sunshine + daylight rain | 2.42 | 2.60 | 7.9% | 3.95 |
| OLS forecast + sun + daylight rain | 2.10 | 2.37 | 7.4% | 3.24 |
| OLS theoretical + rain + sun | 2.00 | 2.37 | 5.6% | 3.81 |

The two-variable sunshine-plus-daylight-rain model is nearly as good as the best 3-feature regressions and is substantially more defensible.

## Interpretation

The current model has many hand-tuned nonlinear parameters. It was able to match selected historical days in-sample, but its stored day-ahead forecasts do not generalize well on the available out-of-sample data.

The strongest generalizable signal is Open-Meteo sunshine duration. This is not surprising: it aggregates cloud timing and opacity into a daily scalar that is more stable than trying to infer production from many individual hourly cloud and irradiance interactions.

Daylight rain adds useful information. It especially reduces the 2026-05-12 over-forecast, where the sun-only model predicted 33.95 kWh versus 24.43 kWh actual. The sunshine-plus-daylight-rain model reduced that walk-forward prediction to 28.38 kWh.

The current stored forecast, theoretical output, cloud cover, and kNN weather analog models did not add robust value on this data set. They may become useful later, but right now they increase complexity faster than they reduce out-of-sample error.

## Proposed Model

Use a two-stage forecast:

1. Predict daily total generation with:

   \[
   \widehat{G}_{day} =
   \max(0,\ 18.35 + 2.35H_{sun} - 1.92R_{daylight})
   \]

2. Allocate the daily total across hours using the existing hourly shape machinery, normalized so that:

   \[
   \sum_{h=0}^{23}\widehat{G}_h = \widehat{G}_{day}
   \]

This keeps the useful part of the existing app, namely an hourly profile for charts and battery simulation, but removes the fragile daily-total calibration from the complex nonlinear model.

## Operational Recommendation

Do not replace the production model immediately without preserving a side-by-side comparison. The next implementation should:

- Add this two-variable model as a candidate model, not as a silent overwrite.
- Show both current-model and simple-model daily totals in the history app for future comparisons.
- Keep using actuals from 2026-05-14 onward as a locked forward test set.
- Refit coefficients only when at least 20 measured day-ahead pairs are available, unless there is a clear data quality issue.
- Track MAE, MAPE, bias, and max absolute error separately for all future days.

## Bottom Line

The evidence supports simplifying the model. The best proposal is not a richer ML model; it is a constrained daily regression using sunshine duration and daylight rain, with the existing hourly curve used only for intraday allocation.
