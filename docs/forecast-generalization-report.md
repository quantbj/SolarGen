# SolarGen Production Model Selection Report

Date: 2026-06-06  
Scope: current production forecast model selection using stored paired Open-Meteo and DWD day-ahead forecast history.

## Executive Summary

SolarGen now uses a production forecast that combines two weather-source/model paths:

```text
production = 0.5 * OM_current_physical
           + 0.5 * DWD_stable
```

where:

```text
DWD_stable = 0.25 * DWD_current_physical
           + 0.75 * DWD_sunshine_rain
           + 4.039
```

This model was selected because it is simple, stable, and performs as well as or better than fitted alternatives in out-of-sample checks. Richer meteo regressions and fitted source weights improved in-sample errors but did not generalize on the available data.

## Data Used

The paired production-data set contains 23 day-ahead target dates with both source forecasts and actuals:

- first paired actual date: `2026-05-14`
- latest paired actual date: `2026-06-05`
- source inputs retained in SQLite: Open-Meteo day-ahead and DWD MOSMIX day-ahead
- displayed forecast: Production blend day-ahead

The public browser app uses DWD ICON through Open-Meteo because that is a direct JSON API available to GitHub Pages. The local history app uses DWD MOSMIX because that is the retained historical DWD source. Both use the same DWD stable transfer and equal blend structure.

## Candidate Models Tested

The review tested both provider mixing and meteo-to-PV transfer changes:

- previous production blend with fitted source weights;
- OM physical model only;
- DWD stable model only;
- equal average of OM physical and DWD stable;
- fitted static source weights;
- rain-regime source weights;
- source-specific transfer recalibration before blending;
- direct ridge regression using source forecasts and meteo summaries.

## Results

### Fixed And Fitted Source Models

| Candidate | In-sample MAE | Leave-one-out MAE | Rolling MAE |
|---|---:|---:|---:|
| Previous production blend | `2.812` | `2.812` | `3.092` |
| OM current only | `3.323` | `3.323` | `3.790` |
| DWD stable only | `3.371` | `3.371` | `2.855` |
| Equal OM current + DWD stable | `2.802` | `2.802` | `2.942` |
| Fitted static source weights | `2.821` | `3.090` | `3.138` |
| Rain-regime blend | `2.737` | `3.188` | `3.105` |
| Weather-corrected average | `2.710` | `3.457` | `3.439` |
| Ridge linear + rain | `2.745` | `3.116` | `3.140` |

The fitted models are worse out of sample despite better in-sample scores. The equal blend is the best stable choice.

### Meteo-To-PV Transfer Candidates

| Candidate | Leave-one-out MAE | Rolling MAE | Interpretation |
|---|---:|---:|---|
| Equal OM current + DWD stable | `2.802` | `2.942` | Best simple generalizer |
| Equal current physical models | `4.302` | `4.678` | DWD physical conversion alone is poor |
| Equal raw sunshine/rain models | `5.157` | `6.113` | Too crude |
| Source transfer then equal blend | `3.031` | `3.057` | Better in-sample, worse OOS |
| Source transfer then weighted blend | `3.197` | `3.199` | Overfits |
| Direct meteo ridge | `3.408` | `3.377` | Overfits current sample |

This shows that the current structure is not merely an OM/DWD average. The important model choice is to keep OM as the current physical model while transforming DWD through the stable DWD transfer model before blending.

## Current Stored-History Accuracy

After recomputing production rows under the equal blend:

| Metric | Value |
|---|---:|
| Paired actual days | `23` |
| MAE | `2.802 kWh` |
| RMSE | `3.578 kWh` |
| Bias | `0.014 kWh` |
| MAPE | `7.92%` |

The forecast for `2026-06-07`, captured on `2026-06-06`, is `28.297 kWh`.

## Literature Context

Day-ahead PV forecast accuracy varies widely depending on normalization, weather regime, aggregation, and the amount of local training data.

The current SolarGen production model has daily MAPE around `8%` on the paired local sample. That is better than many simple NWP-to-PV baselines reported under cloudy conditions, but weaker than mature ML or commercial systems trained on longer histories. This is expected given the small local sample and the site-specific shading behavior.

## Operational Decision

Use the equal production blend as the production model:

```text
production = 0.5 * OM_current_physical
           + 0.5 * DWD_stable
```

Do not add higher-dimensional machine learning until there is materially more paired history across seasons. Future model changes should be accepted only if they improve leave-one-out and chronological rolling tests, not just in-sample fit.

## Maintenance

After any production-model change:

```sh
python3 -m history_app.cli recompute-production
npm run check
npm test
```

Update `docs/methodology.md`, `docs/model-documentation.tex`, and the visible app copy in the same commit.
