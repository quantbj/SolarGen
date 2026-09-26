# SolarGen daily actuals and production forecast

- 2026-08-10 18:55:30 CEST: Polled EcoFlow once via `python3 scripts/ecoflow_api_poll_collect.py --once`; saved tick row 317533 at 2026-08-10T16:55:30+00:00.
- Derived Monday, August 10, 2026 actuals from stored EcoFlow ticks; saved `actual_days` with source `ecoflow_automation`, total `5.008 kWh`, 24 ticks, and note `Derived from EcoFlow ticks via automation; tick_count=24; last_received_at=2026-08-10T16:55:30+00:00`.
- Ran `python3 -m history_app.cli capture-production`; saved forecast run ids 520, 521, 522 with production forecast run 522 for Tuesday, August 11, 2026 at `47.939 kWh`.
- Runtime this run: about 2 minutes.
- 2026-08-13 16:32:57 CEST: Polled EcoFlow once via `python3 scripts/ecoflow_api_poll_collect.py --once`; saved tick row 317595 at 2026-08-13T16:32:35+02:00.
- Derived Thursday, August 13, 2026 actuals from `list_ecoflow_ticks` for `2026-08-13`; saved `actual_days` via `save_actual` with source `ecoflow_automation`, total `8.545 kWh`, 15 ticks, and note `EcoFlow automation from 15 ticks; last_received_at=2026-08-13T14:32:35+00:00`.
- Ran `python3 -m history_app.cli capture-production`; saved forecast run ids 529, 530, 531 with production forecast run 531 for Friday, August 14, 2026 at `49.648 kWh`.
- 2026-08-18 20:15:55 CEST: Polled EcoFlow once via `python3 scripts/ecoflow_api_poll_collect.py --once`; saved tick row 318597 at 2026-08-18T20:15:55+02:00.
- Derived Tuesday, August 18, 2026 actuals from `list_ecoflow_ticks` for `2026-08-18`; saved `actual_days` via `save_actual` with source `ecoflow_automation`, total `15.622 kWh`, 243 ticks, and note `EcoFlow automation from 243 ticks; last_received_at=2026-08-18T18:15:55+00:00`.
- Ran `python3 -m history_app.cli capture-production`; saved forecast run ids 550, 551, 552 with production forecast run 552 for Wednesday, August 19, 2026 at `18.89 kWh`.
- Runtime this run: about 19 seconds.
- 2026-08-23 20:15:22 CEST: Polled EcoFlow once via `python3 scripts/ecoflow_api_poll_collect.py --once`; saved tick row 320634 at 2026-08-23T20:15:22+02:00.
- Derived Sunday, August 23, 2026 actuals from `list_ecoflow_ticks` for `2026-08-23`; saved `actual_days` via `save_actual` with source `ecoflow_automation`, total `37.966 kWh`, 787 ticks, and note `EcoFlow automation from 787 ticks; last_received_at=2026-08-23T18:14:50+00:00`.
- Ran `python3 -m history_app.cli capture-production`; saved forecast run ids 565, 566, 567 with production forecast run 567 for Monday, August 24, 2026 at `36.802 kWh`.
- Runtime this run: about 3 minutes.
