
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

def _resolve_data_dir() -> Path:
    raw = (os.environ.get("DASHFLEX_DATA_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (PROJECT_ROOT / "data").resolve()

DATA_DIR = _resolve_data_dir()
