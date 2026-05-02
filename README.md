# SolarGen

SolarGen is a static browser app for forecasting rooftop PV production, self-consumption savings, and German EEG feed-in revenue for a 10 kWp south-facing rooftop system in OHZ / Osterholz-Scharmbeck.

## Project Structure

```text
.
├── docs/
│   ├── solution-architecture.md
│   ├── deployment.md
│   ├── testing.md
│   └── user-guide.md
├── src/
│   ├── charts.js
│   ├── config.js
│   ├── main.js
│   ├── model.js
│   ├── utils.js
│   └── weather.js
├── tests/
│   └── model.test.mjs
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

## Deployment

The app is ready for free static hosting. Render is the recommended path because the project includes `render.yaml`; Netlify and GitHub Pages are also supported. See [Deployment guide](docs/deployment.md).

## Development

Run syntax checks:

```sh
node --check src/config.js
node --check src/utils.js
node --check src/model.js
node --check src/weather.js
node --check src/charts.js
node --check src/main.js
```

Run tests:

```sh
node --test
```

`package.json` also includes `npm` scripts for environments where `npm` is available:

```sh
npm run check
npm test
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
