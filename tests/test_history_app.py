import sqlite3
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from history_app.cli import recompute_production_forecasts
from history_app.database import forecast_detail, hourly_error_metrics, init_db, list_comparisons, parse_hourly_values, parse_number, save_actual, save_forecast_run, simple_forecast_total
from history_app.ecoflow_store import list_ecoflow_ticks, save_ecoflow_tick
from history_app.forecast_model import LOCATION, PRODUCTION_BLEND_SOURCE, blend_production_day_ahead, build_dwd_mosmix_url, build_forecast_url, capture_day_ahead_forecast, capture_dwd_day_ahead_forecast, capture_dwd_same_day_forecast, capture_production_day_ahead_forecasts, capture_same_day_forecast, compose_dwd_same_day_forecast, dwd_mosmix_xml_to_open_meteo
from xml.etree import ElementTree


class HistoryAppTest(unittest.TestCase):
    def test_capture_day_ahead_forecast_builds_hourly_snapshot(self):
        forecast = sample_forecast("2026-05-03", "2026-05-04")
        snapshot = capture_day_ahead_forecast(
            now=datetime(2026, 5, 3, 8, tzinfo=ZoneInfo(LOCATION["timezone"])),
            forecast=forecast,
        )

        self.assertEqual(snapshot["issued_date"], "2026-05-03")
        self.assertEqual(snapshot["target_date"], "2026-05-04")
        self.assertEqual(snapshot["source"], "Open-Meteo day-ahead")
        self.assertEqual(len(snapshot["hours"]), 24)
        self.assertGreater(snapshot["forecast_total_kwh"], 0)
        self.assertAlmostEqual(snapshot["simple_forecast_total_kwh"], 44.652, places=3)
        self.assertLessEqual(max(hour["delivered_kwh"] for hour in snapshot["hours"]), 6)

    def test_capture_same_day_forecast_uses_issued_date_as_target(self):
        snapshot = capture_same_day_forecast(
            now=datetime(2026, 5, 3, 8, tzinfo=ZoneInfo(LOCATION["timezone"])),
            forecast=sample_forecast("2026-05-03", "2026-05-04"),
        )

        self.assertEqual(snapshot["issued_date"], "2026-05-03")
        self.assertEqual(snapshot["target_date"], "2026-05-03")
        self.assertEqual(snapshot["source"], "Open-Meteo same-day")
        self.assertEqual(len(snapshot["hours"]), 24)

    def test_capture_dwd_day_ahead_forecast_keeps_separate_source(self):
        forecast = sample_forecast("2026-05-03", "2026-05-04")
        forecast["_dwd_meta"] = {"provider": "Deutscher Wetterdienst", "station_id": "10224"}
        snapshot = capture_dwd_day_ahead_forecast(
            now=datetime(2026, 5, 3, 8, tzinfo=ZoneInfo(LOCATION["timezone"])),
            forecast=forecast,
        )

        self.assertEqual(snapshot["target_date"], "2026-05-04")
        self.assertEqual(snapshot["source"], "DWD MOSMIX day-ahead")
        self.assertEqual(snapshot["weather"]["provider"], "Deutscher Wetterdienst")
        self.assertEqual(snapshot["weather"]["station_id"], "10224")
        self.assertEqual(snapshot["weather"]["dwd_simple_model"], "source-calibrated stable blend")
        self.assertGreater(snapshot["simple_forecast_total_kwh"], snapshot["weather"]["dwd_simple_raw_kwh"])

    def test_capture_dwd_same_day_forecast_keeps_separate_source(self):
        forecast = sample_forecast("2026-05-03", "2026-05-04")
        forecast["_dwd_meta"] = {"provider": "Deutscher Wetterdienst", "same_day_composite": True}
        snapshot = capture_dwd_same_day_forecast(
            now=datetime(2026, 5, 3, 8, tzinfo=ZoneInfo(LOCATION["timezone"])),
            forecast=forecast,
        )

        self.assertEqual(snapshot["target_date"], "2026-05-03")
        self.assertEqual(snapshot["source"], "DWD MOSMIX same-day")
        self.assertTrue(snapshot["weather"]["same_day_composite"])
        self.assertEqual(snapshot["weather"]["dwd_simple_model"], "hybrid: same-day uses current DWD model because it generalized better than simple uplift")
        self.assertEqual(snapshot["simple_forecast_total_kwh"], round(snapshot["forecast_total_kwh"], 3))
        self.assertNotEqual(snapshot["simple_forecast_total_kwh"], snapshot["weather"]["dwd_simple_raw_kwh"])

    def test_production_blend_combines_om_and_dwd_day_ahead_inputs(self):
        forecast = sample_forecast("2026-05-03", "2026-05-04")
        snapshots = capture_production_day_ahead_forecasts(
            now=datetime(2026, 5, 3, 8, tzinfo=ZoneInfo(LOCATION["timezone"])),
            open_meteo_forecast=forecast,
            dwd_forecast=forecast,
        )
        om_snapshot, dwd_snapshot, production = snapshots

        self.assertEqual(production["source"], PRODUCTION_BLEND_SOURCE)
        self.assertEqual(production["target_date"], "2026-05-04")
        self.assertEqual(len(production["hours"]), 24)
        self.assertTrue(all(hour["forecast_kwh"] >= 0 for hour in production["hours"]))
        self.assertEqual(production["simple_forecast_total_kwh"], production["forecast_total_kwh"])
        self.assertGreater(production["forecast_total_kwh"], min(om_snapshot["forecast_total_kwh"], dwd_snapshot["simple_forecast_total_kwh"]))
        self.assertLess(production["forecast_total_kwh"], max(om_snapshot["forecast_total_kwh"], dwd_snapshot["simple_forecast_total_kwh"]) + 1)
        self.assertEqual(production["weather"]["production_model"], "OM current plus DWD stable equal blend")

    def test_recompute_production_forecasts_rebuilds_from_stored_inputs(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        init_db(con)
        forecast = sample_forecast("2026-05-03", "2026-05-04")
        om_snapshot, dwd_snapshot, _ = capture_production_day_ahead_forecasts(
            now=datetime(2026, 5, 3, 8, tzinfo=ZoneInfo(LOCATION["timezone"])),
            open_meteo_forecast=forecast,
            dwd_forecast=forecast,
        )
        save_forecast_run(con, om_snapshot)
        save_forecast_run(con, dwd_snapshot)

        result = recompute_production_forecasts(con)
        [production] = [row for row in list_comparisons(con) if row["source"] == PRODUCTION_BLEND_SOURCE]
        expected = round(0.5 * om_snapshot["forecast_total_kwh"] + 0.5 * dwd_snapshot["simple_forecast_total_kwh"], 3)

        self.assertEqual(result["recomputed"], 1)
        self.assertEqual(production["forecast_total_kwh"], expected)

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
        self.assertEqual(comparison["simple_forecast_total_kwh"], snapshot["simple_forecast_total_kwh"])
        self.assertLess(comparison["error_kwh"], 0)
        self.assertIsNotNone(comparison["simple_error_kwh"])
        self.assertEqual(comparison["hourly_points"], 24)
        self.assertIsNotNone(comparison["hourly_rmse_kwh"])
        self.assertEqual(detail["run"]["id"], run_id)
        self.assertEqual(len(detail["hours"]), 24)
        self.assertEqual(len(detail["actual_hours"]), 24)

    def test_simple_forecast_total_uses_sunshine_and_daylight_rain(self):
        weather = {"sunshine_duration": 8 * 3600}
        hours = [
            {"irradiance_wm2": 0, "rain_mm": 10},
            {"irradiance_wm2": 120, "rain_mm": 2},
            {"irradiance_wm2": 300, "rain_mm": 1},
        ]

        self.assertEqual(simple_forecast_total(weather, hours), 31.397)

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

    def test_ecoflow_ticks_are_listed_by_local_day_with_generation_estimate(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        init_db(con)
        for received_at, power, soc in [
            ("2026-05-17T08:00:00+00:00", 1200, 54),
            ("2026-05-17T08:01:00+00:00", 1800, 55),
            ("2026-05-17T08:02:00+00:00", 0, 56),
        ]:
            save_ecoflow_tick(con, {
                "received_at": received_at,
                "device_sn": "HJ31",
                "device_name": "PowerOcean",
                "topic": "/open/account/HJ31/quota",
                "solar_power_w": power,
                "battery_soc_percent": soc,
                "battery_power_w": 100,
                "load_power_w": 400,
                "grid_power_w": 0,
                "raw": {"mpptPwr": power, "bpSoc": soc},
            })

        ticks = list_ecoflow_ticks(con, "2026-05-17", "Europe/Berlin")

        self.assertEqual(ticks["tick_count"], 3)
        self.assertEqual(ticks["summary"]["latest_solar_power_w"], 0)
        self.assertEqual(ticks["summary"]["latest_battery_soc_percent"], 56)
        self.assertAlmostEqual(ticks["summary"]["generation_kwh"], 0.05, places=3)
        self.assertAlmostEqual(ticks["hourly_generation_kwh"][10], 0.05, places=3)
        self.assertIsNone(ticks["hourly_generation_kwh"][9])

    def test_history_url_uses_shared_model_settings(self):
        url = build_forecast_url({"tilt": 42}, forecast_days=2)

        self.assertIn("forecast_days=2", url)
        self.assertIn("tilt=42", url)
        self.assertIn("global_tilted_irradiance", url)

    def test_dwd_mosmix_converter_normalizes_hourly_weather(self):
        forecast = dwd_mosmix_xml_to_open_meteo(ElementTree.fromstring(sample_dwd_mosmix_xml()))

        self.assertEqual(forecast["hourly"]["time"][0], "2026-05-15T00:00")
        self.assertAlmostEqual(forecast["hourly"]["temperature_2m"][0], 10.0, places=2)
        self.assertAlmostEqual(forecast["hourly"]["global_tilted_irradiance"][12], 500.0, places=2)
        self.assertEqual(forecast["daily"]["time"], ["2026-05-15"])
        self.assertAlmostEqual(forecast["daily"]["precipitation_sum"][0], 2.4)
        self.assertEqual(forecast["_dwd_meta"]["station_id"], "10224")
        self.assertIn("10224", build_dwd_mosmix_url())

    def test_dwd_same_day_composite_uses_latest_available_hour(self):
        older = dwd_mosmix_xml_to_open_meteo(ElementTree.fromstring(sample_dwd_mosmix_xml(issue="2026-05-14T21:00:00.000Z", cloud=80)))
        newer = dwd_mosmix_xml_to_open_meteo(ElementTree.fromstring(sample_dwd_mosmix_xml(issue="2026-05-15T03:00:00.000Z", cloud=20, first_hour=5)))

        composite = compose_dwd_same_day_forecast(
            [older, newer],
            "2026-05-15",
            now=datetime(2026, 5, 15, 7, tzinfo=ZoneInfo(LOCATION["timezone"])),
        )

        self.assertEqual(len(composite["hourly"]["time"]), 24)
        self.assertEqual(composite["hourly"]["cloud_cover"][3], 80)
        self.assertEqual(composite["hourly"]["cloud_cover"][6], 20)
        self.assertTrue(composite["_dwd_meta"]["same_day_composite"])


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


def sample_dwd_mosmix_xml(issue="2026-05-15T00:00:00.000Z", cloud=50, first_hour=0):
    times = "\n".join(
        f"<dwd:TimeStep>2026-05-14T{23:02d}:00:00.000Z</dwd:TimeStep>" if hour == 0
        else f"<dwd:TimeStep>2026-05-15T{hour - 1:02d}:00:00.000Z</dwd:TimeStep>"
        for hour in range(first_hour, 24)
    )
    hours = range(first_hour, 24)
    radiation = " ".join("1800.00" if hour == 12 else "0.00" for hour in hours)
    sunshine = " ".join("1800.00" if 8 <= hour <= 16 else "0.00" for hour in hours)
    rain = " ".join("0.10" for _ in hours)
    cloud_values = " ".join(f"{cloud:.2f}" for _ in hours)
    temp = " ".join("283.15" for _ in hours)
    weather = " ".join("2.00" for _ in hours)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<kml:kml xmlns:dwd="https://opendata.dwd.de/weather/lib/pointforecast_dwd_extension_V1_0.xsd" xmlns:kml="http://www.opengis.net/kml/2.2">
  <kml:Document>
    <kml:ExtendedData>
      <dwd:ProductDefinition>
        <dwd:IssueTime>{issue}</dwd:IssueTime>
        <dwd:ForecastTimeSteps>{times}</dwd:ForecastTimeSteps>
      </dwd:ProductDefinition>
    </kml:ExtendedData>
    <kml:Placemark>
      <kml:name>10224</kml:name>
      <kml:description>BREMEN</kml:description>
      <kml:ExtendedData>
        <dwd:Forecast dwd:elementName="Rad1h"><dwd:value>{radiation}</dwd:value></dwd:Forecast>
        <dwd:Forecast dwd:elementName="SunD1"><dwd:value>{sunshine}</dwd:value></dwd:Forecast>
        <dwd:Forecast dwd:elementName="RR1c"><dwd:value>{rain}</dwd:value></dwd:Forecast>
        <dwd:Forecast dwd:elementName="N"><dwd:value>{cloud_values}</dwd:value></dwd:Forecast>
        <dwd:Forecast dwd:elementName="TTT"><dwd:value>{temp}</dwd:value></dwd:Forecast>
        <dwd:Forecast dwd:elementName="ww"><dwd:value>{weather}</dwd:value></dwd:Forecast>
      </kml:ExtendedData>
    </kml:Placemark>
  </kml:Document>
</kml:kml>"""
