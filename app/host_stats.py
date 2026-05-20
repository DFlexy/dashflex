
from __future__ import annotations

import sys
import threading
import time
from typing import Any

import psutil

_HOST_LOCK = threading.Lock()
_HOST_CACHE: dict[str, Any] | None = None
_HOST_CACHE_MONO = 0.0
_HOST_SNAPSHOT_TTL_SEC = 2.5

def bars_for_percent(val: float) -> str:
    if val >= 85:
        return "danger"
    if val >= 65:
        return "warn"
    return "ok"

def host_snapshot(*, bypass_cache: bool = False) -> dict[str, Any]:
    global _HOST_CACHE, _HOST_CACHE_MONO
    now = time.monotonic()
    with _HOST_LOCK:
        if (
            not bypass_cache
            and _HOST_CACHE is not None
            and (now - _HOST_CACHE_MONO) < _HOST_SNAPSHOT_TTL_SEC
        ):
            return dict(_HOST_CACHE)

    virt = psutil.virtual_memory()
    cpu = psutil.cpu_percent(interval=0.05)
    disk = psutil.disk_usage("/")
    if sys.platform == "win32":
        try:
            disk = psutil.disk_usage("C:\\")
        except OSError:
            pass

    mem_pct = float(virt.percent)
    disk_pct = float(disk.percent)

    out = {
        "hostname": (__import__("socket").gethostname() or "host"),
        "cpu_percent": round(cpu, 1),
        "cpu_bar": bars_for_percent(cpu),
        "mem_percent": round(mem_pct, 1),
        "mem_bar": bars_for_percent(mem_pct),
        "disk_percent": round(disk_pct, 1),
        "disk_bar": bars_for_percent(disk_pct),
        "mem_total_gb": round(virt.total / (1024**3), 2),
        "disk_total_gb": round(disk.total / (1024**3), 2),
    }
    with _HOST_LOCK:
        _HOST_CACHE = out
        _HOST_CACHE_MONO = time.monotonic()
    return dict(out)
