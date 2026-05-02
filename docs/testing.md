# Testing Guide

## Test Scope

The automated tests focus on the business logic in `src/model.js` and forecast request construction in `src/weather.js`.

Covered behavior:

- clear-sky irradiance is zero at night and higher at midday
- cloud cover reduces fallback irradiance
- household load profile applies base, morning, daytime, and evening loads
- default household load totals about 10 kWh/day
- rooftop profile suppresses output before 10:00 and after 17:00 as observed in the screenshots
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

Canvas drawing and visual layout are smoke-tested in the browser rather than unit-tested.

## Run Tests

Direct Node command:

```sh
node --test
```

If `npm` is available:

```sh
npm test
```

## Syntax Checks

Direct Node commands:

```sh
node --check src/config.js
node --check src/utils.js
node --check src/model.js
node --check src/weather.js
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
8. Click generation/weather legend items and visible curves, then confirm the selected series hides and reappears.
9. Hover daily bars and generation/weather curves, then confirm tooltips show exact values.

## Current Verification Notes

During development in this environment:

- `node --test` passed with 13 tests.
- `node --check` passed for all source modules.
- `npm` was not available, so direct Node commands were used instead of `npm` scripts.
