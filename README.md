# SolarGen

SolarGen is a static browser app for forecasting rooftop PV production, self-consumption savings, and German EEG feed-in revenue for a 10 kWp south-facing rooftop system in OHZ / Osterholz-Scharmbeck.

## Project Structure

```text
.
├── docs/
│   ├── solution-architecture.md
│   ├── deployment.md
│   ├── forecast-history.md
│   ├── methodology.md
│   ├── testing.md
│   └── user-guide.md
├── history_app/
│   ├── database.py
│   ├── forecast_model.py
│   ├── cli.py
│   ├── server.py
│   └── static/
├── src/
│   ├── chartCore.js
│   ├── charts.js
│   ├── config.js
│   ├── historyForecast.js
│   ├── historyForecastCli.mjs
│   ├── main.js
│   ├── model.js
│   ├── utils.js
│   └── weather.js
├── tests/
│   ├── chart_core.test.mjs
│   ├── chart_renderers.test.mjs
│   ├── history_chart_height.test.mjs
│   ├── model.test.mjs
│   └── test_history_app.py
├── .nojekyll
├── index.html
├── netlify.toml
├── package.json
├── render.yaml
└── styles.css
```

## Quick Start

Serve the folder locally:

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

The app can also be opened directly from `index.html`, but serving it locally is preferred because the JavaScript uses ES modules.

## Documentation

- [User guide](docs/user-guide.md)
- [Solution architecture](docs/solution-architecture.md)
- [Testing guide](docs/testing.md)
- [Deployment guide](docs/deployment.md)
- [Forecast history guide](docs/forecast-history.md)
- [Forecast methodology](docs/methodology.md)

## Local Forecast History

SolarGen includes a separate local history app that stores day-ahead forecasts and actual generation in SQLite on this computer. Start it with:

```sh
python3 -m history_app.server
```

Then open `http://127.0.0.1:4183`. The database lives at `data/solargen_history.sqlite3` and is ignored by git. See [Forecast history guide](docs/forecast-history.md) and [Forecast methodology](docs/methodology.md).

## Deployment

The app is ready for free static hosting. Render is the recommended path because the project includes `render.yaml`; Netlify and GitHub Pages are also supported. See [Deployment guide](docs/deployment.md).

## Development

Run syntax checks:

```sh
node --check src/config.js
node --check src/utils.js
node --check src/chartCore.js
node --check src/model.js
node --check src/weather.js
node --check src/historyForecast.js
node --check src/historyForecastCli.mjs
node --check src/charts.js
node --check src/main.js
```

Run tests:

```sh
npm test
```

Or run the suites directly:

```sh
node --test
python3 -m unittest discover -s tests -p 'test_*.py'
```

`package.json` also includes `npm` scripts for environments where `npm` is available:

```sh
npm run check
npm test
npm run coverage
npm start
```

## Key Defaults

- Location: OHZ / Osterholz-Scharmbeck, Germany (`53.226`, `8.795`)
- PV system: `10 kWp`, south-facing (`azimuth=0`)
- Roof tilt: `35 deg`
- Battery: `10 kWh`
- Feed-in cap: `6 kW`
- Measured calibration day: `50.23 kWh` on `2026-05-01`, treated as a full-sun day
- Rooftop profile: screenshot-calibrated low output before `10:00` and after about `17:00`
- Daily household consumption: about `10 kWh/day` by default
- Avoided import price: `0.30 EUR/kWh`
- Feed-in tariff: `0.0778 EUR/kWh`
