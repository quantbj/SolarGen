# User Guide

## Purpose

OHZ Solar Forecast estimates:

- expected rooftop PV generation for the next 14 days
- PV used directly in the home
- battery charge and discharge contribution
- exported surplus energy
- curtailed surplus caused by the 6 kW feed-in cap
- money saved by avoided grid import
- money earned through EEG feed-in remuneration

## Starting the App

From the project folder:

```sh
python3 -m http.server 4173
```

Open:

```text
http://localhost:4173
```

Do not open `index.html` directly in Safari for normal use. The app uses browser modules and external forecast requests, which should be loaded through the local HTTP server. If opened as a `file://` page, the app shows a warning and links back to `http://localhost:4173`.

## Reading the Dashboard

The four summary tiles show:

- `Today generation`: forecast PV production for the current local day.
- `Today saved`: self-consumed PV value at the configured avoided import price.
- `Today feed-in`: exported PV value at the configured EEG tariff.
- `14 day value`: total estimated value from savings plus feed-in payment.

The charts show:

- `14 day outlook`: daily PV energy and daily euro value.
- `Generation and weather`: selected-day theoretical PV potential, screenshot-calibrated rooftop PV, generation after curtailment, curtailed loss, tilted irradiance, cloud cover, temperature, and rain.
- `Hourly flow`: selected-day PV production, household load, and grid export.
- `Battery charge`: selected-day battery state of charge in percent.
- `Day details`: selected-day totals, weather, import/export, curtailment, and ending battery state.
- `Forecast table`: daily values for scanning and selecting a day, including total EUR value from savings plus feed-in earnings.

In the `Generation and weather` chart, click a legend item to hide or show that series. You can also click near a visible curve to hide that curve directly. Hover over a visible curve to see the nearest hourly value.

In the `14 day outlook`, use the left y-axis for PV generation in kWh and the right y-axis for EUR value. Hover over a day to see exact generation, total value, savings, and feed-in earnings. Clicking a day selects it for the detailed charts below.

## Adjustable Inputs

System inputs:

- `PV capacity`: installed DC peak capacity in kWp.
- `Roof tilt`: panel tilt in degrees. Changing it refetches Open-Meteo tilted irradiance.
- `Battery capacity`: usable modeled storage capacity in kWh.
- `Starting battery`: starting state of charge for the first forecast hour.
- `Feed-in cap`: maximum hourly export in kW/kWh per hour.

Money inputs:

- `Import price`: avoided electricity cost per self-consumed kWh.
- `Feed-in tariff`: remuneration per exported kWh.

Home load inputs:

- `Base load`: constant load every hour, day and night.
- `Daytime extra`: additional load from 08:00 to 18:00, with a partial morning ramp from 06:00 to 08:00.
- `Evening extra`: additional load from 18:00 to 23:00 for higher evening consumption.

The default load profile assumes about `10 kWh/day`: `0.20 kW` base load, `0.20 kW` daytime extra, and `0.60 kW` evening extra.

## Tariff Assumption

The default feed-in tariff is `0.0778 EUR/kWh`. This is the Bundesnetzagentur surplus feed-in rate for rooftop PV up to 10 kWp commissioned from February 1, 2026 through July 31, 2026.

If the actual commissioning or tariff class differs, adjust the slider.

## Forecast Reliability

During refresh, the status card shows a spinner and the current stage: preparing the Open-Meteo request, fetching external hourly weather data, simulating PV/storage/euro values, or building the local fallback forecast. Open-Meteo requests time out after 12 seconds so the app does not remain stuck on loading.

The forecast depends on Open-Meteo weather data. If the network request fails, the app switches to a local fallback model that uses a clear-sky curve with synthetic cloud attenuation. The status pill changes to `Forecast offline` when that happens.

## Rooftop Profile Calibration

The default generation curve uses the screenshots from May 1, 2026 as a site profile. It keeps forecast output below about 1 kW before 10:00, opens the main production window after 10:00, and drops output sharply around 17:00. The theoretical potential curve remains available in the chart so you can compare actual modeled rooftop behavior with the weather-only potential. Battery charge level is shown separately below the hourly flow chart.

## Accessibility

The app uses semantic form labels, keyboard focus states, screen-reader-only chart descriptions, keyboard-selectable forecast table rows, and hover/focus tooltips for the home load controls.
