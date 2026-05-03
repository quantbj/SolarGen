# Forecast History and Actuals

SolarGen now includes a separate local history app for storing day-ahead forecasts and actual generation on this computer.

## Start the Local History App

From the project folder:

```sh
python3 -m history_app.server
```

Open:

```text
http://127.0.0.1:4183
```

The SQLite database is stored at:

```text
data/solargen_history.sqlite3
```

Database files are intentionally ignored by git because they contain local operating history.

## Capture a Day-Ahead Forecast

Use the browser app button `Capture day-ahead forecast`, or run:

```sh
python3 -m history_app.cli capture
```

A capture stores the forecast issued today for tomorrow. It records daily totals and 24 hourly values.

## Enter Actual Generation

Use the form in the local history app, or run:

```sh
python3 -m history_app.cli actual 2026-05-04 --total 43.20
```

For hourly profile comparison, provide 24 hourly kWh values:

```sh
python3 -m history_app.cli actual 2026-05-04 --hourly-file actuals-2026-05-04.txt
```

The file can contain values separated by spaces, commas, semicolons, or new lines. Values are interpreted from `00:00` through `23:00` local time.

## Stored Data

Forecast snapshot tables:

- `forecast_runs`: issue time, target date, source, model settings, daily totals, daily meteo summary
- `forecast_hours`: 24 hourly forecast records with PV and meteo inputs

Actuals tables:

- `actual_days`: daily actual total, source, notes, timestamps
- `actual_hours`: optional 24 hourly actual generation values

Comparison outputs:

- daily forecast kWh vs actual kWh
- daily error in kWh
- daily percentage error
- hourly MAE when 24 hourly actuals are available
- hourly RMSE when 24 hourly actuals are available

## Future API Actuals

A future inverter or vendor API importer should write into the same actuals tables, using `actual_days.date` as the daily key and `actual_hours.hour` for the hourly profile. The manual entry path and API path should therefore produce identical downstream comparison results.
