"""SQLite helpers."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from paths import SCHEMA


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA.read_text())
    _migrate_products(conn)
    return conn


def _migrate_products(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(products)")}
    for name, typ in (("buy_url", "TEXT"), ("buy_channel", "TEXT"), ("buy_label", "TEXT")):
        if name not in cols:
            conn.execute(f"ALTER TABLE products ADD COLUMN {name} {typ}")


def setting(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
