
from __future__ import annotations

import json
import re
import sys
from typing import Any

from app.data_paths import DATA_DIR

SETTINGS_FILE = DATA_DIR / "app_settings.json"

UI_THEMES = frozenset({"scifi", "paper"})
UI_PRIMARIES = frozenset({"darkgreen", "blue", "purple", "black", "custom"})
UI_PATTERNS = frozenset(
    {"grid", "dots", "diagonal", "circuit", "hex", "binary", "stripes", "honeycomb", "spark", "cross"}
)
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

DEFAULTS: dict[str, Any] = {
    "dashboard_refresh_seconds": 12,
    "docker_base_url": "",
    "containers_show_stopped_default": True,
    "app_display_name": "DashFlex",
    "dash_bookmark_card_scale_percent": 100,
    "ui_theme": "scifi",
    "ui_primary": "black",
    "ui_primary_hex": "#2dd4bf",
    "ui_pattern": "diagonal",
    "ui_language": "",
}

_settings_cache: dict[str, Any] | None = None
_settings_mtime: float | None = None


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _as_int(value: Any, default: int, lo: int, hi: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return min(hi, max(lo, n))


def _normalize_theme_fields(out: dict[str, Any]) -> None:
    theme = out.get("ui_theme")
    if theme in ("frost", "light", "paper"):
        out["ui_theme"] = "paper"
    else:
        out["ui_theme"] = "scifi"
    if out.get("ui_primary") not in UI_PRIMARIES:
        out["ui_primary"] = DEFAULTS["ui_primary"]
    hx = str(out.get("ui_primary_hex") or "").strip()
    out["ui_primary_hex"] = hx.lower() if _HEX_COLOR.match(hx) else DEFAULTS["ui_primary_hex"]
    if out.get("ui_pattern") not in UI_PATTERNS:
        out["ui_pattern"] = DEFAULTS["ui_pattern"]
    out["dashboard_refresh_seconds"] = _as_int(out.get("dashboard_refresh_seconds"), 12, 5, 600)
    out["dash_bookmark_card_scale_percent"] = _as_int(
        out.get("dash_bookmark_card_scale_percent"), 100, 70, 140
    )
    flag = out.get("containers_show_stopped_default")
    if isinstance(flag, str):
        out["containers_show_stopped_default"] = flag.strip().lower() in {"1", "true", "yes", "on"}
    elif flag is None:
        out["containers_show_stopped_default"] = True
    else:
        out["containers_show_stopped_default"] = bool(flag)
    name = str(out.get("app_display_name") or "").strip()
    out["app_display_name"] = (name[:80] or DEFAULTS["app_display_name"])
    lang = str(out.get("ui_language") or "").strip().lower()
    out["ui_language"] = lang if lang in {"pt", "en"} else ""
    raw_url = out.get("docker_base_url")
    out["docker_base_url"] = raw_url.strip() if isinstance(raw_url, str) else ""


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
    _normalize_theme_fields(out)
    _settings_cache = out
    _settings_mtime = mtime
    return {**out}


def save_settings(data: dict[str, Any]) -> None:
    _ensure_dir()
    merged = {**DEFAULTS, **data}
    for k in list(merged.keys()):
        if k not in DEFAULTS:
            del merged[k]
    _normalize_theme_fields(merged)
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
