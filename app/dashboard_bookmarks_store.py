
from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.data_paths import DATA_DIR

DATA_FILE = DATA_DIR / "dashboard_bookmarks.json"
ICONS_DIR = DATA_DIR / "dashboard_icons"

MAX_ITEMS = 48
ICON_MAX_BYTES = 512 * 1024

_items_cache: list[dict[str, Any]] | None = None
_items_mtime: float | None = None
_icon_stems: set[str] | None = None
_icons_dir_mtime: float | None = None


def _invalidate_items_cache() -> None:
    global _items_cache, _items_mtime
    _items_cache = None
    _items_mtime = None


def _invalidate_icon_stems_cache() -> None:
    global _icon_stems, _icons_dir_mtime
    _icon_stems = None
    _icons_dir_mtime = None

def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

def _detect_image_format(data: bytes) -> tuple[str, str] | None:
    if len(data) < 12:
        return None
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return (".png", "image/png")
    if data[:3] == b"\xff\xd8\xff":
        return (".jpg", "image/jpeg")
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return (".gif", "image/gif")
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return (".webp", "image/webp")
    head = data[:8192].lstrip()
    if head.startswith(b"<svg") or head.startswith(b"<?xml"):
        try:
            decoded = data[:16384].decode("utf-8", errors="ignore").lower()
            if "<svg" in decoded:
                return (".svg", "image/svg+xml")
        except Exception:
            pass
    return None

def icon_stems() -> set[str]:
    global _icon_stems, _icons_dir_mtime
    if not ICONS_DIR.is_dir():
        _icon_stems = set()
        _icons_dir_mtime = 0.0
        return _icon_stems
    try:
        mtime = ICONS_DIR.stat().st_mtime
    except OSError:
        return set()
    if _icon_stems is not None and _icons_dir_mtime == mtime:
        return _icon_stems
    _icon_stems = {p.stem for p in ICONS_DIR.iterdir() if p.is_file()}
    _icons_dir_mtime = mtime
    return _icon_stems


def icon_path(bookmark_id: str) -> Path | None:
    bid = str(bookmark_id or "").strip()
    if not bid or not ICONS_DIR.is_dir():
        return None
    for p in ICONS_DIR.iterdir():
        if p.is_file() and p.stem == bid:
            return p
    return None


def has_icon(bookmark_id: str) -> bool:
    bid = str(bookmark_id or "").strip()
    return bool(bid and bid in icon_stems())

def remove_icon(bookmark_id: str) -> None:
    p = icon_path(bookmark_id)
    if p is None:
        return
    try:
        p.unlink()
    except OSError:
        pass
    _invalidate_icon_stems_cache()

def fetch_icon_bytes(url: str) -> bytes:
    u = str(url or "").strip()
    if not u.startswith(("http://", "https://")):
        raise ValueError("A URL do ícone deve começar com http:// ou https://.")
    req = Request(u, headers={"User-Agent": "DashFlex/1.0 (+dashboard icon)", "Accept": "image/*,*/*;q=0.8"}, method="GET")
    try:
        with urlopen(req, timeout=20) as resp:
            chunks: list[bytes] = []
            total = 0
            while total <= ICON_MAX_BYTES:
                block = resp.read(min(65536, ICON_MAX_BYTES - total + 1))
                if not block:
                    break
                chunks.append(block)
                total += len(block)
            data = b"".join(chunks)
    except HTTPError as e:
        raise ValueError(f"Erro HTTP {e.code} ao baixar o ícone.") from e
    except URLError as e:
        reason = getattr(e, "reason", e)
        raise ValueError(f"Não foi possível baixar o ícone: {reason}") from e
    if len(data) > ICON_MAX_BYTES:
        raise ValueError(f"Ícone muito grande (máximo {ICON_MAX_BYTES // 1024} KB).")
    if len(data) < 12:
        raise ValueError("Resposta do servidor muito pequena para ser uma imagem.")
    return data

def save_icon(bookmark_id: str, data: bytes) -> str:
    bid = str(bookmark_id or "").strip()
    if not bid:
        raise ValueError("ID inválido.")
    if len(data) > ICON_MAX_BYTES:
        raise ValueError(f"Ícone muito grande (máximo {ICON_MAX_BYTES // 1024} KB).")
    detected = _detect_image_format(data)
    if not detected:
        raise ValueError("Formato não suportado. Use PNG, JPEG, GIF, WebP ou SVG.")
    _ensure_dir()
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    ext, mime = detected
    remove_icon(bid)
    path = ICONS_DIR / f"{bid}{ext}"
    path.write_bytes(data)
    _invalidate_icon_stems_cache()
    return mime

def load_items() -> list[dict[str, Any]]:
    global _items_cache, _items_mtime
    if not DATA_FILE.exists():
        return []
    try:
        mtime = DATA_FILE.stat().st_mtime
    except OSError:
        return []
    if _items_cache is not None and _items_mtime == mtime:
        return [dict(x) for x in _items_cache]
    try:
        with DATA_FILE.open(encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if isinstance(raw, dict):
        inner = raw.get("items")
        items = inner if isinstance(inner, list) else []
    elif isinstance(raw, list):
        items = raw
    else:
        items = []
    _items_cache = items
    _items_mtime = mtime
    return [dict(x) for x in items]

def _save(items: list[dict[str, Any]]) -> None:
    _ensure_dir()
    tmp = DATA_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump({"items": items}, f, indent=2, ensure_ascii=False)
    tmp.replace(DATA_FILE)
    _invalidate_items_cache()

def create_item(
    title: str,
    url: str,
    icon: str,
    container_id: str | None = None,
) -> dict[str, Any]:
    items = load_items()
    if len(items) >= MAX_ITEMS:
        raise ValueError(f"Máximo de {MAX_ITEMS} atalhos.")
    bid = secrets.token_hex(8)
    row = {
        "id": bid,
        "title": title.strip()[:120],
        "url": url.strip()[:2048],
        "icon": (icon.strip()[:16] or "🔗"),
    }
    cid = str(container_id or "").strip()
    if cid:
        row["container_id"] = cid[:128]
    items.append(row)
    _save(items)
    return row

def update_item(
    bid: str,
    title: str | None,
    url: str | None,
    icon: str | None,
) -> dict[str, Any]:
    items = load_items()
    for i, it in enumerate(items):
        if it.get("id") != bid:
            continue
        cur = {**it}
        if title is not None:
            cur["title"] = title.strip()[:120]
        if url is not None:
            cur["url"] = url.strip()[:2048]
        if icon is not None:
            cur["icon"] = icon.strip()[:16] or "🔗"
        items[i] = cur
        _save(items)
        return cur
    raise ValueError("Atalho não encontrado.")

def delete_item(bid: str) -> None:
    before = load_items()
    items = [x for x in before if x.get("id") != bid]
    if len(items) == len(before):
        raise ValueError("Atalho não encontrado.")
    remove_icon(bid)
    _save(items)

def reorder_items(ordered_ids: list[str]) -> None:
    items = load_items()
    current_ids = [str(x.get("id")) for x in items if x.get("id")]
    ids = [str(x).strip() for x in ordered_ids if str(x).strip()]
    if not items:
        if ids:
            raise ValueError("Não há atalhos para reordenar.")
        return
    if len(ids) != len(current_ids):
        raise ValueError("A lista de ordem deve incluir exatamente todos os atalhos.")
    if len(set(ids)) != len(ids):
        raise ValueError("IDs duplicados na ordem.")
    if set(ids) != set(current_ids):
        raise ValueError("IDs na ordem não correspondem aos atalhos atuais.")
    id_to_item = {str(x["id"]): x for x in items}
    new_list = [id_to_item[i] for i in ids]
    _save(new_list)

def count_items() -> int:
    return len(load_items())

def clear_all_items() -> int:
    n = len(load_items())
    _save([])
    if ICONS_DIR.is_dir():
        for p in ICONS_DIR.iterdir():
            if p.is_file():
                try:
                    p.unlink()
                except OSError:
                    pass
    _invalidate_icon_stems_cache()
    return n

def bookmark_exists(bookmark_id: str) -> bool:
    return any(x.get("id") == bookmark_id for x in load_items())
