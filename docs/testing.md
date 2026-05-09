# Testing Guide

## Test Scope

The automated tests focus on the business logic in `src/model.js` and forecast request construction in `src/weather.js`.

Covered behavior:

- clear-sky irradiance is zero at night and higher at midday
- cloud cover reduces fallback irradiance
- high-cloud low-irradiance recalibration improves the stored cloudy-day underforecast pattern
- household load profile applies base, morning, daytime, and evening loads
- default household load totals about 10 kWh/day
- rooftop profile suppresses output before 10:00 and after 17:00 as observed in the screenshots
- high-cloud rooftop profile uses a smoother diffuse-light ramp than clear-day hours
- a full-sun May 1 profile calibrates to the measured 50.23 kWh day
- feed-in export respects the configured cap
- curtailed energy is reported when PV surplus exceeds the cap
- delivered PV after curtailment never exceeds the configured cap
- delivered PV after curtailment equals theoretical PV minus curtailed loss
- battery storage reduces evening grid import after midday surplus and reports state of charge percent
- savings, feed-in earnings, and total value formulas remain consistent
- hourly meteo inputs are preserved for the selected-day generation/weather curve
- Open-Meteo URL requests the needed tilted solar and weather variables
- Open-Meteo request timeout fails into fallback handling instead of hanging indefinitely
- fallback forecast returns 14 days of hourly data
- local history snapshots produce 24 hourly forecast records
- local history snapshots call the shared JavaScript forecast model through the Python adapter
- SQLite stores forecast snapshots, actuals, and comparison metrics

Canvas drawing and visual layout are smoke-tested in the browser rather than unit-tested.

## Run Tests

Direct Node command:

```sh
node --test
python3 -m unittest discover -s tests -p 'test_*.py'
```

If `npm` is available:

```sh
npm test
```

The `npm test` script runs both the JavaScript and Python test suites.

## Syntax Checks

Direct Node commands:

```sh
node --check src/config.js
node --check src/utils.js
node --check src/model.js
node --check src/weather.js
node --check src/historyForecast.js
node --check src/historyForecastCli.mjs
node --check src/charts.js
node --check src/main.js
```

If `npm` is available:

```sh
npm run check
```

## Browser Smoke Test

1. Start the local server:

   ```sh
   python3 -m http.server 4173
   ```

2. Open `http://localhost:4173`.
3. Confirm the status pill becomes `Live forecast` or `Forecast offline`.
4. Confirm the summary tiles show numeric kWh and EUR values.
5. Change roof tilt and confirm the forecast refreshes.
6. Change feed-in cap and confirm exported/curtailed values update.
7. Select a forecast table row and confirm day details and hourly chart update.
8. Click chart legend items, then confirm the selected series hides and reappears.
9. Hover or click daily bars, hourly lines, battery lines, and generation/weather curves, then confirm tooltips show exact values without hiding the curve itself.

## Current Verification Notes

During development in this environment:

- `node --test` covers the browser forecast model.
- `python3 -m unittest discover -s tests -p 'test_*.py'` covers the local history app.
- `node --check` and `python3 -m py_compile` cover syntax checks for JavaScript and Python modules.


## Local History Smoke Test

1. Initialize the database:

   ```sh
   python3 -m history_app.cli init-db
   ```

2. Start the local history app:

   ```sh
   python3 -m history_app.server
   ```

3. Open `http://127.0.0.1:4183`.
4. Click `Capture day-ahead forecast`.
5. Enter an actual daily total for the target date.
6. Confirm the comparison table shows actual kWh and daily error.
7. Enter 24 hourly values and confirm hourly RMSE appears.
