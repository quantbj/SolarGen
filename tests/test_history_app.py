import sqlite3
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from history_app.database import forecast_detail, hourly_error_metrics, init_db, list_comparisons, parse_hourly_values, parse_number, save_actual, save_forecast_run
from history_app.forecast_model import LOCATION, build_forecast_url, capture_day_ahead_forecast


class HistoryAppTest(unittest.TestCase):
    def test_capture_day_ahead_forecast_builds_hourly_snapshot(self):
        forecast = sample_forecast("2026-05-03", "2026-05-04")
        snapshot = capture_day_ahead_forecast(
            now=datetime(2026, 5, 3, 8, tzinfo=ZoneInfo(LOCATION["timezone"])),
            forecast=forecast,
        )

        self.assertEqual(snapshot["issued_date"], "2026-05-03")
        self.assertEqual(snapshot["target_date"], "2026-05-04")
        self.assertEqual(len(snapshot["hours"]), 24)
        self.assertGreater(snapshot["forecast_total_kwh"], 0)
        self.assertLessEqual(max(hour["delivered_kwh"] for hour in snapshot["hours"]), 6)

    def test_sqlite_stores_forecast_actuals_and_comparison_metrics(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        init_db(con)
        snapshot = capture_day_ahead_forecast(
            now=datetime(2026, 5, 3, 8, tzinfo=ZoneInfo(LOCATION["timezone"])),
            forecast=sample_forecast("2026-05-03", "2026-05-04"),
        )
        run_id = save_forecast_run(con, snapshot)
        hourly_actual = [round(hour["forecast_kwh"] * 0.9, 3) for hour in snapshot["hours"]]
        save_actual(con, "2026-05-04", None, hourly_actual, source="manual")

        [comparison] = list_comparisons(con)
        detail = forecast_detail(con, run_id)

        self.assertEqual(comparison["actual_total_kwh"], round(sum(hourly_actual), 3))
        self.assertLess(comparison["error_kwh"], 0)
        self.assertEqual(comparison["hourly_points"], 24)
        self.assertIsNotNone(comparison["hourly_rmse_kwh"])
        self.assertEqual(detail["run"]["id"], run_id)
        self.assertEqual(len(detail["hours"]), 24)
        self.assertEqual(len(detail["actual_hours"]), 24)

    def test_actual_parsing_accepts_german_decimal_commas(self):
        values = parse_hourly_values("0,00 0,10 0,20 0,30 0,40 0,50 0,60 0,70 0,80 0,90 1,00 1,10 1,20 1,30 1,40 1,50 1,60 1,70 1,80 1,90 2,00 2,10 2,20 2,30")

        self.assertEqual(len(values), 24)
        self.assertEqual(values[1], 0.10)
        self.assertEqual(values[23], 2.30)
        self.assertEqual(parse_number("36,41"), 36.41)

    def test_history_validation_and_empty_metrics(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        init_db(con)

        with self.assertRaisesRegex(ValueError, "24 values"):
            save_actual(con, "2026-05-04", None, [1.0, 2.0])
        with self.assertRaisesRegex(ValueError, "non-negative"):
            save_actual(con, "2026-05-04", None, [-1.0] * 24)
        with self.assertRaisesRegex(ValueError, "daily total"):
            save_actual(con, "2026-05-04", None, [])
        with self.assertRaises(ValueError):
            parse_number("")
        with self.assertRaises(ValueError):
            parse_hourly_values("1 2 3")

        self.assertEqual(hourly_error_metrics(con, 99, "2026-05-04")["hourly_points"], 0)
        self.assertIsNone(forecast_detail(con, 99))

    def test_history_url_uses_shared_model_settings(self):
        url = build_forecast_url({"tilt": 42}, forecast_days=2)

        self.assertIn("forecast_days=2", url)
        self.assertIn("tilt=42", url)
        self.assertIn("global_tilted_irradiance", url)


def sample_forecast(*dates):
    hourly = {
        "time": [],
        "temperature_2m": [],
        "cloud_cover": [],
        "precipitation": [],
        "global_tilted_irradiance": [],
        "is_day": [],
        "weather_code": [],
    }
    daily = {
        "time": list(dates),
        "weather_code": [0 for _ in dates],
        "temperature_2m_max": [22 for _ in dates],
        "temperature_2m_min": [10 for _ in dates],
        "precipitation_sum": [0 for _ in dates],
        "cloud_cover_mean": [10 for _ in dates],
        "sunshine_duration": [12 * 3600 for _ in dates],
    }
    for day in dates:
        for hour in range(24):
            hourly["time"].append(f"{day}T{hour:02d}:00")
            hourly["temperature_2m"].append(18)
            hourly["cloud_cover"].append(10)
            hourly["precipitation"].append(0)
            hourly["global_tilted_irradiance"].append(950 if 10 <= hour <= 15 else 120 if 6 <= hour < 18 else 0)
            hourly["is_day"].append(1 if 6 <= hour < 21 else 0)
            hourly["weather_code"].append(0)
    return {"hourly": hourly, "daily": daily}
