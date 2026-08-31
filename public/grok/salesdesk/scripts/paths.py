"""Shared paths for Sales Desk scripts."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = Path(__file__).resolve().parent / "schema.sql"
WORKSPACE = Path("/workspace/sales-desk")
LOCAL_DATA = ROOT / "data"


def default_db() -> Path:
    if WORKSPACE.exists():
        WORKSPACE.mkdir(parents=True, exist_ok=True)
        return WORKSPACE / "salesdesk.db"
    LOCAL_DATA.mkdir(parents=True, exist_ok=True)
    return LOCAL_DATA / "salesdesk.db"


def default_raw() -> Path:
    base = WORKSPACE if WORKSPACE.exists() else LOCAL_DATA
    raw = base / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    return raw
