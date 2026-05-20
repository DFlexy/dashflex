
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.data_paths import DATA_DIR

DATA_FILE = DATA_DIR / "container_access.json"

_links_cache: dict[str, dict[str, Any]] | None = None
_links_mtime: float | None = None

def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

def invalidate_links_cache() -> None:
    global _links_cache, _links_mtime
    _links_cache = None
    _links_mtime = None

def load_links() -> dict[str, dict[str, Any]]:
    global _links_cache, _links_mtime
    try:
        mtime = DATA_FILE.stat().st_mtime
    except OSError:
        invalidate_links_cache()
        return {}

    if _links_cache is not None and _links_mtime == mtime:
        return _links_cache

    try:
        with DATA_FILE.open(encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError):
        _links_cache = {}
        _links_mtime = mtime
        return _links_cache

    parsed: dict[str, dict[str, Any]]
    if isinstance(raw, dict) and "links" in raw:
        inner = raw.get("links") or {}
        parsed = inner if isinstance(inner, dict) else {}
    elif isinstance(raw, dict):
        parsed = raw
    else:
        parsed = {}

    _links_cache = parsed
    _links_mtime = mtime
    return _links_cache

def _save_links(store: dict[str, dict[str, Any]]) -> None:
    _ensure_dir()
    tmp = DATA_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump({"links": store}, f, indent=2, ensure_ascii=False)
    tmp.replace(DATA_FILE)
    invalidate_links_cache()

def _key_id(id_full: str) -> str:
    return f"id:{id_full}"

def _key_name(name: str) -> str:
    return f"name:{name.strip().lower()}"

def resolve_access(
    id_full: str,
    name: str,
    *,
    links: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    m = links if links is not None else load_links()
    ki = _key_id(id_full)
    kn = _key_name(name)
    return m.get(ki) or m.get(kn)

def build_url(cfg: dict[str, Any]) -> str:
    scheme = (cfg.get("scheme") or "http").lower()
    host = str(cfg.get("host") or "").strip()
    if not host:
        return ""
    port = int(cfg.get("port") or 80)
    path = str(cfg.get("path") or "/").strip()
    if not path.startswith("/"):
        path = "/" + path
    omit_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    authority = host if omit_port else f"{host}:{port}"
    return f"{scheme}://{authority}{path}"

def set_access(id_full: str | None, name: str | None, cfg: dict[str, Any]) -> None:
    keys: list[str] = []
    if id_full:
        keys.append(_key_id(id_full))
    if name and name.strip():
        keys.append(_key_name(name))
    if not keys:
        raise ValueError("Informe container_id_full ou nome do container.")

    store = load_links()
    for k in keys:
        store[k] = {**cfg}
    _save_links(store)

def count_links() -> int:
    return len(load_links())

def clear_all_links() -> None:
    _save_links({})

def delete_access(id_full: str | None, name: str | None) -> None:
    keys: list[str] = []
    if id_full:
        keys.append(_key_id(id_full))
    if name and name.strip():
        keys.append(_key_name(name))
    if not keys:
        raise ValueError("Informe container_id_full ou nome do container.")

    store = load_links()
    for k in keys:
        store.pop(k, None)
    _save_links(store)
