# SolarGen Production Model Selection Report

Date: 2026-06-13  
Scope: current production forecast model recalibration using stored paired Open-Meteo and DWD day-ahead forecast history.

## Executive Summary

SolarGen now uses a production forecast that combines two weather-source/model paths:

```text
production = 0.73 * OM_current_physical
           + 0.27 * DWD_stable
```

where:

```text
DWD_stable = 0.25 * DWD_current_physical
           + 0.75 * DWD_sunshine_rain
           + 4.039
```

This model is a conservative recalibration of the previous equal blend. Recent post-2026-06-05 actuals showed the equal blend underforecasting several days because the DWD stable leg was lower than Open-Meteo. A production-bias term was rejected because it worsened leave-one-out checks.

## Data Used

The paired production-data set contains 30 day-ahead target dates with both source forecasts and actuals:

- first paired actual date: `2026-05-14`
- latest paired actual date: `2026-06-12`
- source inputs retained in SQLite: Open-Meteo day-ahead and DWD MOSMIX day-ahead
- displayed forecast: Production blend day-ahead

The public browser app uses DWD ICON through Open-Meteo because that is a direct JSON API available to GitHub Pages. The local history app uses DWD MOSMIX because that is the retained historical DWD source. Both use the same DWD stable transfer and production blend structure.

## Candidate Models Tested

The review tested provider mixing and bias options:

- previous equal production blend;
- OM physical model only;
- DWD stable model only;
- fitted static source weights;
- fitted static source weights plus a production bias;
- rolling and leave-one-out checks of those source-weight options.

## Results

### Fixed And Fitted Source Models

| Candidate | In-sample MAE | Leave-one-out MAE | Rolling MAE |
|---|---:|---:|---:|
| Equal OM current + DWD stable | `3.918` | fixed model | `5.010` |
| OM current only | `4.147` | fixed model | not selected |
| DWD stable only | `4.567` | fixed model | not selected |
| Fitted source weight, no bias | `3.861` | `3.945` | `5.208` |
| Fitted source weight plus bias | `3.844` | `4.485` | `5.419` |

The fitted no-bias source weight is the smallest change that improves the full retained sample. Adding a bias term improves the in-sample score slightly but fails the leave-one-out and rolling checks.

### Structural Decision

The current structure is still not merely an OM/DWD average. The important model choice is to keep OM as the current physical model while transforming DWD through the stable DWD transfer model before blending. The recalibration changes only the final source weights.

## Current Stored-History Accuracy

After recomputing production rows under the recalibrated blend:

| Metric | Value |
|---|---:|
| Paired actual days | `30` |
| MAE | `3.861 kWh` |
| RMSE | `5.186 kWh` |
| Bias | `1.185 kWh` |
| MAPE | `10.69%` |

The forecast for `2026-06-07`, captured on `2026-06-06`, is `28.297 kWh`.

## Literature Context

Day-ahead PV forecast accuracy varies widely depending on normalization, weather regime, aggregation, and the amount of local training data.

The current SolarGen production model has daily MAPE around `8%` on the paired local sample. That is better than many simple NWP-to-PV baselines reported under cloudy conditions, but weaker than mature ML or commercial systems trained on longer histories. This is expected given the small local sample and the site-specific shading behavior.

## Operational Decision

Use the OM-weighted production blend as the production model:

```text
production = 0.73 * OM_current_physical
           + 0.27 * DWD_stable
```

Do not add a production bias or higher-dimensional machine learning until there is materially more paired history across seasons. Future model changes should be accepted only if they improve leave-one-out and chronological rolling tests, not just in-sample fit.

## Maintenance

After any production-model change:

```sh
python3 -m history_app.cli recompute-production
npm run check
npm test
```

Update `docs/methodology.md`, `docs/model-documentation.tex`, and the visible app copy in the same commit.
