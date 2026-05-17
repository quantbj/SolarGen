#!/usr/bin/env python3
"""Subscribe to EcoFlow MQTT quota ticks and persist them to the history DB."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ecoflow.client import EcoFlowClient, load_credentials
from ecoflow.logging import log
from ecoflow.mqtt import DEFAULT_KEEPALIVE, MQTTConnectionClosed, MinimalMQTTClient, build_client_id, decode_publish, mqtt_certification
from ecoflow.ticks import current_snapshot, extract_topic_sn, parse_payload, persist_current_snapshot, select_devices, tick_from_payload
from history_app.database import connect, init_db
from history_app.ecoflow_store import save_ecoflow_tick


DEFAULT_REST_REFRESH_SECONDS = 60


def subscribe_topics(mqtt: MinimalMQTTClient, topics: list[str]) -> None:
    for topic in topics:
        mqtt.subscribe(topic)
        log(f"subscribed {topic}")


def seed_current_state(con, api_client: EcoFlowClient, devices: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    state_by_sn: dict[str, dict[str, Any]] = {}
    for device in devices:
        seeded = persist_current_snapshot(con, api_client, device)
        if seeded:
            row_id, tick = seeded
            state_by_sn[device["sn"]] = tick
            log(
                f"seeded current tick for {device['sn']} row={row_id} "
                f"solar={tick.get('solar_power_w')}W soc={tick.get('battery_soc_percent')}%"
            )
    return state_by_sn


def print_saved_tick(row_id: int, tick: dict[str, Any]) -> None:
    carried = f" carried={','.join(tick['_carried_fields'])}" if tick.get("_carried_fields") else ""
    fresh = f" fresh={','.join(tick['_fresh_fields'])}" if tick.get("_fresh_fields") else ""
    log(
        f"saved tick row={row_id} sn={tick['device_sn']} "
        f"solar={tick.get('solar_power_w')}W soc={tick.get('battery_soc_percent')}%{fresh}{carried}"
    )


class RestSnapshotRefresher:
    """Periodically persist full HTTP quota snapshots while MQTT is running."""

    def __init__(
        self,
        con,
        api_client: EcoFlowClient,
        devices: list[dict[str, Any]],
        state_by_sn: dict[str, dict[str, Any]],
        interval_seconds: float,
    ):
        self.con = con
        self.api_client = api_client
        self.devices = devices
        self.state_by_sn = state_by_sn
        self.interval_seconds = interval_seconds
        self.last_refresh = time.monotonic()

    def refresh_now(self) -> None:
        for device in self.devices:
            tick = current_snapshot(self.api_client, device)
            if tick is None:
                continue
            row_id = save_ecoflow_tick(self.con, tick)
            self.state_by_sn[tick["device_sn"]] = tick
            print_saved_tick(row_id, tick)
        self.last_refresh = time.monotonic()

    def refresh_if_due(self) -> None:
        if self.interval_seconds <= 0:
            return
        if time.monotonic() - self.last_refresh >= self.interval_seconds:
            self.refresh_now()


def refresh_rest_snapshots(con, api_client: EcoFlowClient, devices: list[dict[str, Any]], state_by_sn: dict[str, dict[str, Any]]) -> None:
    """Compatibility wrapper used by tests and one-off refresh callers."""
    RestSnapshotRefresher(con, api_client, devices, state_by_sn, interval_seconds=0).refresh_now()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-file", default="EcoflowIoT/access.txt")
    parser.add_argument("--host", default="https://api.ecoflow.com")
    parser.add_argument("--sn", action="append", help="Device serial number. Repeat to subscribe to multiple devices.")
    parser.add_argument("--client-id-prefix", default="solargen")
    parser.add_argument("--no-seed-current", action="store_true", help="Do not persist one current REST quota snapshot before subscribing.")
    parser.add_argument("--reconnect-delay", type=float, default=10.0)
    parser.add_argument("--keepalive", type=int, default=DEFAULT_KEEPALIVE, help="MQTT keepalive seconds.")
    parser.add_argument(
        "--rest-refresh-seconds",
        type=float,
        default=DEFAULT_REST_REFRESH_SECONDS,
        help="Poll quota/all this often to fill fields MQTT omits, such as load/grid. Use 0 to disable.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    access_key, secret_key = load_credentials(args.credentials_file)
    api_client = EcoFlowClient(access_key, secret_key, host=args.host)
    devices = select_devices(api_client.list_devices(), args.sn)
    if not devices:
        log("No EcoFlow devices found.", error=True)
        return 1

    con = connect()
    init_db(con)
    device_names = {device["sn"]: device.get("deviceName", "") for device in devices if device.get("sn")}
    state_by_sn: dict[str, dict[str, Any]] = {}

    if not args.no_seed_current:
        state_by_sn = seed_current_state(con, api_client, devices)

    while True:
        mqtt = None
        try:
            rest_refresher = RestSnapshotRefresher(con, api_client, devices, state_by_sn, args.rest_refresh_seconds)
            cert = mqtt_certification(api_client)
            topics = [f"/open/{cert['certificateAccount']}/{device['sn']}/quota" for device in devices]
            mqtt = MinimalMQTTClient(
                cert["url"],
                int(cert["port"]),
                cert["certificateAccount"],
                cert["certificatePassword"],
                build_client_id(args.client_id_prefix),
                keepalive=args.keepalive,
            )
            mqtt.connect()
            subscribe_topics(mqtt, topics)

            def on_message(topic: str, payload: bytes) -> None:
                parsed = parse_payload(payload)
                if parsed is None:
                    return
                serial = extract_topic_sn(topic)
                tick = tick_from_payload(topic, parsed, device_names, state_by_sn.get(serial))
                if tick is None:
                    return
                row_id = save_ecoflow_tick(con, tick)
                state_by_sn[tick["device_sn"]] = tick
                print_saved_tick(row_id, tick)
                rest_refresher.refresh_if_due()

            mqtt.loop_forever(on_message, on_idle=rest_refresher.refresh_if_due)
        except KeyboardInterrupt:
            if mqtt:
                mqtt.close()
            return 0
        except MQTTConnectionClosed as exc:
            if mqtt:
                mqtt.close()
            log(f"mqtt connection closed: {exc}; reconnecting in {args.reconnect_delay:g}s", error=True)
            time.sleep(args.reconnect_delay)
        except Exception as exc:
            if mqtt:
                mqtt.close()
            log(f"mqtt collector error: {exc}; reconnecting in {args.reconnect_delay:g}s", error=True)
            time.sleep(args.reconnect_delay)


if __name__ == "__main__":
    raise SystemExit(main())
