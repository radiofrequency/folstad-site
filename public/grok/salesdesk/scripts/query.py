#!/usr/bin/env python3
"""Search scraped products. Used by reply-inquiry — never invent a row."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from db import connect
from paths import default_db

COLS = """id, name, price_adult, price_child, currency, duration,
       pickup_window, pickup_areas, includes, excludes, bring,
       notes, days, source_url, buy_url, buy_channel, buy_label"""
STOP = {
    "pax", "adult", "adults", "child", "kids", "please", "the", "and",
    "for", "from", "tomorrow", "today", "want", "need", "book",
}


def fts_query(q: str) -> str:
    terms = re.findall(r"[A-Za-z0-9\u0E00-\u0E7F]{2,}", q)
    keep = [t for t in terms if t.lower() not in STOP]
    return " OR ".join(keep) if keep else q.strip()


def search(db: Path, q: str, limit: int = 5) -> list[dict]:
    conn = connect(db)
    try:
        query = q.strip()
        rows = []
        if query:
            try:
                rows = conn.execute(
                    f"""
                    SELECT p.{COLS.replace(', ', ', p.')}
                    FROM products_fts f
                    JOIN products p ON p.id = f.rowid
                    WHERE products_fts MATCH ?
                    LIMIT ?
                    """,
                    (fts_query(query), limit),
                ).fetchall()
            except Exception:
                rows = []
            if not rows:
                like = f"%{query}%"
                rows = conn.execute(
                    f"SELECT {COLS} FROM products WHERE name LIKE ? OR raw_text LIKE ? OR notes LIKE ? ORDER BY price_adult IS NULL, name LIMIT ?",
                    (like, like, like, limit),
                ).fetchall()
            if not rows:
                for term in fts_query(query).split(" OR "):
                    like = f"%{term}%"
                    rows = conn.execute(
                        f"SELECT {COLS} FROM products WHERE name LIKE ? OR raw_text LIKE ? LIMIT ?",
                        (like, like, limit),
                    ).fetchall()
                    if rows:
                        break
        else:
            rows = conn.execute(
                f"SELECT {COLS} FROM products ORDER BY name LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("query", nargs="?", default="")
    parser.add_argument("--db", type=Path, default=default_db())
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    hits = search(args.db, args.query, args.limit)
    json.dump({"query": args.query, "count": len(hits), "products": hits}, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if hits else 1


if __name__ == "__main__":
    sys.exit(main())
