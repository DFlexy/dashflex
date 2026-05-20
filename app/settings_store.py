
from __future__ import annotations

import json
import sys
from typing import Any

from app.data_paths import DATA_DIR

SETTINGS_FILE = DATA_DIR / "app_settings.json"

DEFAULTS: dict[str, Any] = {
    "dashboard_refresh_seconds": 12,
    "docker_base_url": "",
    "containers_show_stopped_default": True,
    "app_display_name": "DashFlex",
    "dash_bookmark_card_scale_percent": 100,
    "ui_theme": "glass",
    "ui_language": "",
}

_settings_cache: dict[str, Any] | None = None
_settings_mtime: float | None = None


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _invalidate_settings_cache() -> None:
    global _settings_cache, _settings_mtime
    _settings_cache = None
    _settings_mtime = None


def load_settings() -> dict[str, Any]:
    global _settings_cache, _settings_mtime
    if not SETTINGS_FILE.exists():
        return {**DEFAULTS}
    try:
        mtime = SETTINGS_FILE.stat().st_mtime
    except OSError:
        return {**DEFAULTS}
    if _settings_cache is not None and _settings_mtime == mtime:
        return {**_settings_cache}
    out = {**DEFAULTS}
    try:
        with SETTINGS_FILE.open(encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError):
        return out
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        if k in DEFAULTS:
            out[k] = v
    if out.get("ui_theme") == "aurora":
        out["ui_theme"] = "frost"
    _settings_cache = out
    _settings_mtime = mtime
    return {**out}


def save_settings(data: dict[str, Any]) -> None:
    _ensure_dir()
    merged = {**DEFAULTS, **data}
    for k in list(merged.keys()):
        if k not in DEFAULTS:
            del merged[k]
    tmp = SETTINGS_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)
    tmp.replace(SETTINGS_FILE)
    _invalidate_settings_cache()


def effective_docker_base_url() -> str | None:
    s = load_settings().get("docker_base_url") or ""
    u = str(s).strip()
    if not u:
        return None
    low = u.lower()
    if sys.platform != "win32" and ("npipe://" in low or "//./pipe/" in low):
        return None
    if sys.platform != "win32" and low.startswith("tcp://host.docker.internal"):
        return None
    return u
