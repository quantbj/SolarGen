from __future__ import annotations

import sys
from datetime import datetime
from typing import Any


def log(message: str, *, error: bool = False) -> None:
    print(log_message(message), file=sys.stderr if error else sys.stdout, flush=True)


def log_message(message: str) -> str:
    return f"{datetime.now().astimezone().isoformat(timespec='seconds')} {message}"


def format_watts(value: Any) -> str:
    if value is None:
        return "NoneW"
    return f"{float(value):.0f}W"


def format_percent(value: Any) -> str:
    if value is None:
        return "None%"
    return f"{float(value):.0f}%"
