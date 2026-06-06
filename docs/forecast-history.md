# Forecast History and Actuals

SolarGen includes a local history app for storing source forecasts, blended production forecasts, and actual generation on this computer.

## Start The Local History App

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

Database files are ignored by git because they contain private operating history.

## Capture The Production Forecast

Use the history app button `Capture production day-ahead`, or run:

```sh
python3 -m history_app.cli capture-production
```

This stores three rows for the same issue date and target date:

- `Open-Meteo day-ahead` input;
- `DWD MOSMIX day-ahead` input;
- `Production blend day-ahead`.

The history UI displays only `Production blend day-ahead`. Source inputs remain in SQLite for audit and recomputation.

## Recompute Production Rows After Model Changes

After changing the production blend constants or DWD stable transfer, rebuild stored production rows from retained source inputs:

```sh
python3 -m history_app.cli recompute-production
```

This does not refetch weather. It reads stored Open-Meteo and DWD rows, recomputes `Production blend day-ahead`, and overwrites the existing production row for each source pair.

## Enter Actual Generation

Use the form in the local history app, or run:

```sh
python3 -m history_app.cli actual 2026-06-05 --total 30.49
```

For hourly profile comparison, provide 24 hourly kWh values:

```sh
python3 -m history_app.cli actual 2026-06-05 --hourly-file actuals-2026-06-05.txt
```

The file can contain values separated by spaces, commas, semicolons, or new lines. Values are interpreted from `00:00` through `23:00` local time.

## Current Production Model

```text
production = 0.5 * OM_current_physical
           + 0.5 * DWD_stable
```

with:

```text
DWD_stable = 0.25 * DWD_current_physical
           + 0.75 * DWD_sunshine_rain
           + 4.039
```

Selection basis: paired day-ahead source history through `2026-06-05`.

## Stored Data

Forecast tables:

- `forecast_runs`: issue time, target date, source, settings, daily totals, daily meteo summary
- `forecast_hours`: 24 hourly forecast records with PV and meteo inputs

Actuals tables:

- `actual_days`: daily actual total, source, notes, timestamps
- `actual_hours`: optional 24 hourly actual generation values

Comparison outputs:

- daily production forecast kWh vs actual kWh
- daily error in kWh and percent
- hourly MAE and RMSE when 24 hourly actuals are available

## Automation

The daily automation should:

1. poll EcoFlow once;
2. derive current-day actual generation from stored EcoFlow ticks;
3. save actuals into `actual_days` and `actual_hours`;
4. run `python3 -m history_app.cli capture-production`.

This keeps the database aligned with the current production model while preserving source inputs for audit.
