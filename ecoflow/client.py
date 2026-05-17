from __future__ import annotations

import hashlib
import hmac
import json
import os
import random
from datetime import date, datetime, time, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


DEFAULT_HOST = "https://api.ecoflow.com"
DEFAULT_CREDENTIALS_FILE = Path("EcoflowIoT/access.txt")
DEFAULT_TIMEZONE = "Europe/Berlin"


class EcoFlowError(RuntimeError):
    pass


def flatten_parameters(value, prefix=""):
    if isinstance(value, dict):
        pairs = []
        for key in sorted(value):
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            pairs.extend(flatten_parameters(value[key], next_prefix))
        return pairs
    if isinstance(value, list):
        pairs = []
        for index, item in enumerate(value):
            pairs.extend(flatten_parameters(item, f"{prefix}[{index}]"))
        return pairs
    if isinstance(value, bool):
        return [(prefix, "true" if value else "false")]
    if value is None:
        return [(prefix, "")]
    return [(prefix, str(value))]


def signature_payload(params, access_key, nonce, timestamp):
    parameter_text = "&".join(f"{key}={value}" for key, value in sorted(flatten_parameters(params)))
    auth_text = f"accessKey={access_key}&nonce={nonce}&timestamp={timestamp}"
    return f"{parameter_text}&{auth_text}" if parameter_text else auth_text


def sign_request(params, access_key, secret_key, nonce, timestamp):
    payload = signature_payload(params, access_key, nonce, timestamp)
    return hmac.new(secret_key.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def load_credentials(path):
    access_key = os.environ.get("ECOFLOW_ACCESS_KEY")
    secret_key = os.environ.get("ECOFLOW_SECRET_KEY")
    if access_key and secret_key:
        return access_key.strip(), secret_key.strip()

    credential_path = Path(path)
    if not credential_path.exists():
        raise EcoFlowError(
            "EcoFlow credentials were not found. Set ECOFLOW_ACCESS_KEY and "
            f"ECOFLOW_SECRET_KEY, or create {credential_path}."
        )

    values = {}
    for line in credential_path.read_text(encoding="utf-8").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        normalized = "".join(ch for ch in key.lower() if ch.isalnum())
        values[normalized] = value.strip()

    access_key = values.get("accesskey")
    secret_key = values.get("secretkey") or values.get("secrectkey")
    if not access_key or not secret_key:
        raise EcoFlowError(
            f"{credential_path} must contain 'Access key: ...' and 'Secret key: ...'."
        )
    return access_key, secret_key


class EcoFlowClient:
    def __init__(self, access_key, secret_key, host=DEFAULT_HOST, timeout=20):
        self.access_key = access_key
        self.secret_key = secret_key
        self.host = host.rstrip("/")
        self.timeout = timeout

    def request(self, method, path, params=None):
        params = params or {}
        nonce = f"{random.randint(0, 999999):06d}"
        timestamp = str(int(datetime.now(tz=timezone.utc).timestamp() * 1000))
        sign = sign_request(params, self.access_key, self.secret_key, nonce, timestamp)
        headers = {
            "accessKey": self.access_key,
            "nonce": nonce,
            "timestamp": timestamp,
            "sign": sign,
        }

        url = f"{self.host}{path}"
        body = None
        if method == "GET" and params:
            url = f"{url}?{urlencode(params)}"
        elif method in {"POST", "PUT"}:
            body = json.dumps(params, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json;charset=UTF-8"

        request = Request(url, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise EcoFlowError(f"HTTP {exc.code} from EcoFlow: {details}") from exc
        except URLError as exc:
            raise EcoFlowError(f"Could not reach EcoFlow API: {exc.reason}") from exc

        try:
            data = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise EcoFlowError(f"EcoFlow returned non-JSON data: {payload[:300]}") from exc

        code = str(data.get("code", "0"))
        if code != "0":
            raise EcoFlowError(f"EcoFlow API error {code}: {data.get('message', data)}")
        return data

    def list_devices(self):
        response = self.request("GET", "/iot-open/sign/device/list")
        return response.get("data") or []

    def all_quotas(self, serial_number):
        response = self.request("GET", "/iot-open/sign/device/quota/all", {"sn": serial_number})
        return response.get("data") or {}

    def history(self, serial_number, begin_utc, end_utc, code):
        response = self.request(
            "POST",
            "/iot-open/sign/device/quota/data",
            {
                "sn": serial_number,
                "params": {
                    "beginTime": format_ecoflow_time(begin_utc),
                    "endTime": format_ecoflow_time(end_utc),
                    "code": code,
                },
            },
        )
        return response.get("data")


def format_ecoflow_time(value):
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def local_day_to_utc_range(day: date, timezone_name: str):
    tz = ZoneInfo(timezone_name)
    start = datetime.combine(day, time.min, tzinfo=tz)
    end = datetime.combine(day, time.max.replace(microsecond=0), tzinfo=tz)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)
