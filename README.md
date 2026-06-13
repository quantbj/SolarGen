# SolarGen

SolarGen forecasts rooftop PV production, self-consumption savings, and German EEG feed-in revenue for a 10 kWp south-facing rooftop system in OHZ / Osterholz-Scharmbeck.

The displayed forecast uses the current production model:

```text
production = 0.73 * Open-Meteo current physical model
           + 0.27 * DWD stable model
```

with:

```text
DWD stable = 0.25 * DWD current physical model
           + 0.75 * DWD sunshine/rain model
           + 4.039 kWh
```

## Project Structure

```text
.
├── docs/
├── history_app/
├── src/
├── tests/
├── index.html
├── package.json
└── styles.css
```

Important modules:

- `src/model.js`: source physical PV model and battery/load/export accounting.
- `src/productionBlend.js`: browser production blend.
- `src/weather.js`: Open-Meteo and DWD ICON browser forecast fetches.
- `history_app/forecast_model.py`: local history capture and production blend using retained OM/DWD source rows.
- `history_app/database.py`: SQLite forecast and actual storage.

## Quick Start

Serve the static browser app locally:

```sh
python3 -m http.server 4173
```

Open:

```text
http://localhost:4173
```

The app can be opened directly from `index.html`, but serving it locally is preferred because the JavaScript uses ES modules and external forecast requests.

## Local Forecast History

Start the local history app:

```sh
python3 -m history_app.server
```

Open:

```text
http://127.0.0.1:4183
```

Capture the production forecast:

```sh
python3 -m history_app.cli capture-production
```

After model changes, rebuild stored production rows from retained source inputs:

```sh
python3 -m history_app.cli recompute-production
```

The database lives at `data/solargen_history.sqlite3` and is ignored by git.

## Documentation

- [User guide](docs/user-guide.md)
- [Forecast methodology](docs/methodology.md)
- [Model documentation](docs/model-documentation.pdf)
- [Production model selection report](docs/forecast-generalization-report.md)
- [Forecast history guide](docs/forecast-history.md)
- [Solution architecture](docs/solution-architecture.md)
- [Testing guide](docs/testing.md)
- [Deployment guide](docs/deployment.md)

## Deployment

The public app is deployed as a GitHub Pages static site from the `main` branch root. See [Deployment guide](docs/deployment.md).

## Development

Run syntax checks:

```sh
npm run check
```

Run tests:

```sh
npm test
```

## Key Defaults

- Location: OHZ / Osterholz-Scharmbeck, Germany (`53.226`, `8.795`)
- PV system: `10 kWp`, south-facing (`azimuth=0`)
- Roof tilt: `35 deg`
- Battery: `10 kWh`
- Feed-in cap: `6 kW`
- Clear-sky anchor day: `50.23 kWh` on `2026-05-01`
- Source physical-model calibration note: Open-Meteo forecast-vs-actual history through `2026-05-29`
- Production model selection period: paired source history through `2026-06-12`
- Daily household consumption: about `10 kWh/day` by default
- Avoided import price: `0.30 EUR/kWh`
- Feed-in tariff: `0.0778 EUR/kWh`

## Runtime Dependencies

Browser app:

- Open-Meteo forecast API
- Open-Meteo DWD ICON API

Local history app:

- Open-Meteo forecast API
- DWD MOSMIX open-data feed
- local SQLite database

Development:

- Node.js for JavaScript checks/tests
- Python 3 for the local history app and tests
- `pdflatex` only when regenerating PDF documentation

## EcoFlow Actuals

Local EcoFlow credentials are read from `EcoflowIoT/access.txt` or from `ECOFLOW_ACCESS_KEY` and `ECOFLOW_SECRET_KEY`. The credentials file is ignored by git.

Poll once:

```sh
python3 scripts/ecoflow_api_poll_collect.py --once
```

Poll continuously:

```sh
npm run ecoflow:poll
```
