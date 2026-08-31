#!/usr/bin/env python3
"""Crawl an operator website (or saved HTML) into Sales Desk SQLite.

Stdlib only. Same-host crawl. JS-heavy sites: save rendered HTML into raw/
from the Grok Bot browser, then `--from-raw`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

from db import connect, set_setting
from paths import default_db, default_raw

USER_AGENT = "SalesDeskBot/1.0 (+https://x.ai/bot; operator-authorized catalog crawl)"
MAX_PAGES = 80
DELAY_SEC = 0.4
SKIP_EXT = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".pdf", ".zip",
    ".mp4", ".mp3", ".css", ".js", ".ico", ".woff", ".woff2",
}
PRODUCT_HINTS = (
    "tour", "trip", "package", "excursion", "activity", "island",
    "phi-phi", "phiphi", "similan", "racha", "james-bond", "speedboat",
    "diving", "transfer", "product", "book", "experience",
)
BOOK_PATH_RE = re.compile(
    r"/(book|booking|bookings|checkout|cart|reserve|reservation|pay|order|enquire|inquiry)(/|$|\?)",
    re.I,
)
BOOK_TEXT_RE = re.compile(
    r"\b(book\s*now|book\s*online|book\s*this|buy\s*now|checkout|add to cart|"
    r"reserve|pay\s*now|จอง|ซื้อ|ชำระ)\b",
    re.I,
)
OTA_HOSTS = (
    "klook.com", "viator.com", "getyourguide.com", "tripadvisor.com",
    "kkday.com", "gyg.com", "civitatis.com",
)
WIDGET_HOSTS = (
    "bokun.io", "bokun.com", "fareharbor.com", "peek.com", "rezdy.com",
    "checkfront.com", "checkfront.app", "trekksoft.com", "regiondo.com",
    "woocommerce.com",
)
PRICE_RE = re.compile(
    r"(?:฿|THB|baht|บาท)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})"
    r"|([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:฿|THB|baht|บาท)",
    re.I,
)
NUM = r"([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})"
ADULT_RE = re.compile(
    rf"(?:adult|ผู้ใหญ่)[^\d]{{0,24}}{NUM}|{NUM}\s*(?:฿|THB|baht|บาท)?\s*(?:adult|ผู้ใหญ่)",
    re.I,
)
CHILD_RE = re.compile(
    rf"(?:child|kid|เด็ก)[^\d]{{0,24}}{NUM}|{NUM}\s*(?:฿|THB|baht|บาท)?\s*(?:child|kid|เด็ก)",
    re.I,
)


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []
        self.link_items: list[dict] = []
        self.iframes: list[str] = []
        self.form_actions: list[str] = []
        self.title = ""
        self._capture_title = False
        self.json_ld: list[str] = []
        self._capture_ld = False
        self.og: dict[str, str] = {}
        self.meta_desc = ""
        self.text_parts: list[str] = []
        self._skip_depth = 0
        self._a_href: str | None = None
        self._a_text: list[str] = []

    def _flush_a(self) -> None:
        if self._a_href is None:
            return
        label = re.sub(r"\s+", " ", " ".join(self._a_text)).strip()
        self.link_items.append({"href": self._a_href, "text": label})
        self._a_href = None
        self._a_text = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        ad = {k.lower(): (v or "") for k, v in attrs}
        if tag in {"script", "style", "noscript"}:
            self._skip_depth += 1
            t = ad.get("type", "").lower()
            if "ld+json" in t:
                self._capture_ld = True
                self._skip_depth -= 1
        if tag == "a":
            self._flush_a()
            href = ad.get("href")
            if href:
                self.links.append(href)
                self._a_href = href
        if tag == "iframe" and ad.get("src"):
            self.iframes.append(ad["src"])
        if tag == "form" and ad.get("action"):
            self.form_actions.append(ad["action"])
        if tag == "title":
            self._capture_title = True
        if tag == "meta":
            name = (ad.get("name") or ad.get("property") or "").lower()
            content = ad.get("content", "")
            if name in {"og:title", "og:description", "og:url", "product:price:amount"}:
                self.og[name] = content
            if name == "description":
                self.meta_desc = content

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self._skip_depth:
            self._skip_depth -= 1
        if tag == "script" and self._capture_ld:
            self._capture_ld = False
        if tag == "title":
            self._capture_title = False
        if tag == "a":
            self._flush_a()

    def handle_data(self, data: str) -> None:
        if self._capture_title:
            self.title += data.strip()
        elif self._capture_ld:
            self.json_ld.append(data)
        elif self._skip_depth == 0:
            t = re.sub(r"\s+", " ", data).strip()
            if t:
                self.text_parts.append(t)
            if self._a_href is not None:
                self._a_text.append(t)


def to_int(value: object) -> int | None:
    if value is None:
        return None
    m = re.search(r"([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,6})", str(value))
    if not m:
        return None
    n = int(m.group(1).replace(",", ""))
    return n if 50 <= n <= 500_000 else None


def first_group(match: re.Match) -> str | None:
    return next((g for g in match.groups() if g), None)


def prices_from_text(text: str) -> tuple[int | None, int | None]:
    adult = child = None
    m = ADULT_RE.search(text)
    if m:
        adult = to_int(first_group(m))
    m = CHILD_RE.search(text)
    if m:
        child = to_int(first_group(m))
    if adult is None:
        found = [to_int(a or b) for a, b in PRICE_RE.findall(text)]
        found = [n for n in found if n]
        if found:
            adult = found[0]
            if child is None and len(found) > 1:
                child = found[1]
    return adult, child


def flatten_ld(node: object) -> list[dict]:
    if isinstance(node, list):
        out: list[dict] = []
        for item in node:
            out.extend(flatten_ld(item))
        return out
    if isinstance(node, dict):
        if "@graph" in node:
            return flatten_ld(node["@graph"])
        return [node]
    return []


def from_ld(blobs: list[str]) -> dict:
    fields: dict = {}
    for blob in blobs:
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            continue
        for node in flatten_ld(parsed):
            types = node.get("@type", "")
            if isinstance(types, list):
                types = " ".join(types)
            types = str(types).lower()
            if "product" in types or "tourist" in types or "offer" in types or "event" in types:
                if node.get("name"):
                    fields.setdefault("name", str(node["name"]).strip())
                offers = node.get("offers") or node.get("offers", {})
                if isinstance(offers, list) and offers:
                    offers = offers[0]
                if isinstance(offers, dict):
                    fields.setdefault("price_adult", to_int(offers.get("price") or offers.get("lowPrice")))
                    cur = offers.get("priceCurrency")
                    if cur:
                        fields.setdefault("currency", str(cur).upper())
                    offer_url = offers.get("url") or offers.get("availabilityUrl")
                    if offer_url:
                        fields.setdefault("buy_url", str(offer_url).strip())
                product_url = node.get("url")
                if product_url and not fields.get("buy_url"):
                    fields.setdefault("buy_url", str(product_url).strip())
                fields.setdefault("notes", node.get("description"))
    return {k: v for k, v in fields.items() if v}


def _host(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower().removeprefix("www.")


def classify_href(page_url: str, href: str, text: str = "") -> tuple[int, str, str] | None:
    """Return (score, absolute_url, channel) or None."""
    raw = href.strip()
    if not raw or raw.startswith("#") or raw.lower().startswith("javascript:"):
        return None
    lower = raw.lower()
    label = (text or "").strip()

    if lower.startswith("mailto:"):
        return (60, raw, "email")
    if lower.startswith("tel:"):
        return (50, raw, "phone")
    if "wa.me/" in lower or "whatsapp.com" in lower or "api.whatsapp.com" in lower:
        abs_url = urllib.parse.urljoin(page_url, raw)
        return (80, abs_url, "whatsapp")
    if "line.me" in lower or "lin.ee" in lower:
        return (75, urllib.parse.urljoin(page_url, raw), "line")

    abs_url = urllib.parse.urljoin(page_url, raw)
    host = _host(abs_url)
    path = urllib.parse.urlparse(abs_url).path.lower()
    page_host = _host(page_url)

    if any(host == o or host.endswith("." + o) for o in OTA_HOSTS):
        return (40, abs_url, "ota")
    if any(h in host for h in WIDGET_HOSTS):
        return (90, abs_url, "website")
    if host == page_host and (BOOK_PATH_RE.search(path) or BOOK_TEXT_RE.search(label)):
        return (100, abs_url, "website")
    if host == page_host and BOOK_TEXT_RE.search(label):
        return (95, abs_url, "website")
    return None


def pick_buy(page_url: str, parser: PageParser, ld: dict) -> tuple[str | None, str, str | None]:
    """Best purchase destination on this product page. Prefer first-party checkout over OTA."""
    ranked: list[tuple[int, str, str, str]] = []
    ld_url = ld.get("buy_url")
    if ld_url:
        hit = classify_href(page_url, ld_url, "book")
        if hit:
            score, url, channel = hit
            ranked.append((score + 5, url, channel, "schema.org Offer"))
        else:
            ranked.append((85, urllib.parse.urljoin(page_url, ld_url), "website", "schema.org Offer"))
    for item in parser.link_items:
        hit = classify_href(page_url, item["href"], item["text"])
        if hit:
            score, url, channel = hit
            ranked.append((score, url, channel, item["text"][:80] or url))
    for src in parser.iframes:
        hit = classify_href(page_url, src, "booking widget")
        if hit:
            score, url, channel = hit
            ranked.append((score, url, channel, "iframe widget"))
    for action in parser.form_actions:
        hit = classify_href(page_url, action, "book")
        if hit:
            score, url, channel = hit
            ranked.append((max(score, 88), url, channel, "booking form"))
    if not ranked:
        return None, "unknown", None
    ranked.sort(key=lambda r: r[0], reverse=True)
    _score, url, channel, label = ranked[0]
    return url, channel, label or None


def looks_like_product(url: str, title: str, text: str, fields: dict) -> bool:
    if fields.get("price_adult") or fields.get("name") and PRICE_RE.search(text):
        return True
    path = urllib.parse.urlparse(url).path.lower()
    if any(h in path for h in PRODUCT_HINTS) and PRICE_RE.search(text):
        return True
    blob = f"{title} {text[:2000]}".lower()
    return bool(PRICE_RE.search(text) and any(h in blob for h in PRODUCT_HINTS))


def extract(url: str, html: str) -> dict | None:
    parser = PageParser()
    try:
        parser.feed(html)
    except Exception:
        return None
    text = " ".join(parser.text_parts)
    fields = from_ld(parser.json_ld)
    name = fields.get("name") or parser.og.get("og:title") or parser.title
    name = re.sub(r"\s+", " ", name or "").strip()
    if not name or name.lower() in {"home", "index", "tours", "products"}:
        # listing pages are crawled for links, not stored as a product
        if not fields.get("price_adult"):
            return None
    adult, child = prices_from_text(text)
    fields["name"] = name
    fields["price_adult"] = fields.get("price_adult") or adult
    fields["price_child"] = fields.get("price_child") or child
    if parser.meta_desc and not fields.get("notes"):
        fields["notes"] = parser.meta_desc
    buy_url, buy_channel, buy_label = pick_buy(url, parser, fields)
    fields["buy_url"] = buy_url
    fields["buy_channel"] = buy_channel
    fields["buy_label"] = buy_label
    fields["raw_text"] = text[:20000]
    fields["source_url"] = url
    if not looks_like_product(url, name, text, fields):
        return None
    if not fields.get("name"):
        return None
    return fields


def same_host(base: str, href: str) -> str | None:
    joined = urllib.parse.urljoin(base, href)
    parsed = urllib.parse.urlparse(joined)
    if parsed.scheme not in {"http", "https"}:
        return None
    if parsed.netloc.lower().removeprefix("www.") != urllib.parse.urlparse(base).netloc.lower().removeprefix("www."):
        return None
    path = parsed.path.lower()
    if any(path.endswith(ext) for ext in SKIP_EXT):
        return None
    clean = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", parsed.query, ""))
    return clean.rstrip("/") or clean


def fetch(url: str, timeout: int = 25) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "html" not in ctype.lower() and not url.endswith((".html", ".htm", "/")):
                if "json" not in ctype.lower():
                    return None
            charset = "utf-8"
            m = re.search(r"charset=([\w-]+)", ctype, re.I)
            if m:
                charset = m.group(1)
            return raw.decode(charset, errors="replace")
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None


def upsert(conn, product: dict) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    raw = product.get("raw_text") or ""
    digest = hashlib.sha256(raw.encode()).hexdigest()[:16]
    existing = conn.execute(
        "SELECT id, content_hash FROM products WHERE source_url = ?",
        (product["source_url"],),
    ).fetchone()
    cols = (
        "source_url", "name", "price_adult", "price_child", "currency",
        "duration", "pickup_window", "pickup_areas", "includes", "excludes",
        "bring", "notes", "min_pax", "days", "category", "buy_url",
        "buy_channel", "buy_label", "raw_text", "content_hash", "scraped_at",
    )
    values = (
        product["source_url"],
        product["name"],
        product.get("price_adult"),
        product.get("price_child"),
        product.get("currency") or "THB",
        product.get("duration"),
        product.get("pickup_window"),
        product.get("pickup_areas"),
        product.get("includes"),
        product.get("excludes"),
        product.get("bring"),
        product.get("notes"),
        product.get("min_pax"),
        product.get("days"),
        product.get("category"),
        product.get("buy_url"),
        product.get("buy_channel") or "unknown",
        product.get("buy_label"),
        raw,
        digest,
        now,
    )
    if existing:
        conn.execute(
            """UPDATE products SET name=?, price_adult=?, price_child=?, currency=?,
               duration=?, pickup_window=?, pickup_areas=?, includes=?, excludes=?,
               bring=?, notes=?, min_pax=?, days=?, category=?, buy_url=?,
               buy_channel=?, buy_label=?, raw_text=?,
               content_hash=?, scraped_at=? WHERE source_url=?""",
            values[1:] + (product["source_url"],),
        )
        return "updated" if existing["content_hash"] != digest else "unchanged"
    conn.execute(
        f"INSERT INTO products({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
        values,
    )
    return "inserted"


def save_raw(raw_dir: Path, url: str, html: str) -> None:
    name = hashlib.sha256(url.encode()).hexdigest()[:16] + ".html"
    (raw_dir / name).write_text(html, encoding="utf-8")
    (raw_dir / (name + ".url")).write_text(url, encoding="utf-8")


def crawl(start: str, raw_dir: Path, max_pages: int) -> list[tuple[str, str]]:
    queue = [start.rstrip("/")]
    seen: set[str] = set()
    pages: list[tuple[str, str]] = []
    while queue and len(seen) < max_pages:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        html = fetch(url)
        time.sleep(DELAY_SEC)
        if not html:
            continue
        save_raw(raw_dir, url, html)
        pages.append((url, html))
        parser = PageParser()
        try:
            parser.feed(html)
        except Exception:
            continue
        for href in parser.links:
            nxt = same_host(start, href)
            if nxt and nxt not in seen and nxt not in queue:
                queue.append(nxt)
    return pages


def load_raw(raw_dir: Path) -> list[tuple[str, str]]:
    pages = []
    for html_path in sorted(raw_dir.glob("*.html")):
        url_path = Path(str(html_path) + ".url")
        url = url_path.read_text(encoding="utf-8").strip() if url_path.exists() else html_path.stem
        pages.append((url, html_path.read_text(encoding="utf-8", errors="replace")))
    return pages


def seed_markdown(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    chunks = re.split(r"\n## ", text)
    products = []
    for i, chunk in enumerate(chunks):
        if i == 0 and not chunk.startswith("#"):
            continue
        if i:
            chunk = "## " + chunk
        lines = [ln.rstrip() for ln in chunk.splitlines() if ln.strip()]
        if not lines:
            continue
        title = re.sub(r"^#+\s*", "", lines[0]).strip()
        if title.lower() in {"tours", "tour"}:
            continue
        fields: dict = {"name": title, "source_url": f"seed:{title.lower().replace(' ', '-')}", "currency": "THB"}
        body = []
        for ln in lines[1:]:
            m = re.match(r"- (\w+):\s*(.*)", ln)
            if not m:
                body.append(ln)
                continue
            key, val = m.group(1), m.group(2).strip()
            if key in {"adult", "car_3pax", "car", "price"}:
                fields["price_adult"] = to_int(val)
            elif key == "child":
                fields["price_child"] = to_int(val)
            elif key in {"duration", "pickup_window", "includes", "excludes", "bring", "notes", "days", "buy_url", "buy_channel", "buy_label"}:
                fields[key] = val
            elif key == "min_pax":
                fields["min_pax"] = to_int(val) or int(re.sub(r"[^\d]", "", val) or 0) or None
            elif key == "id":
                fields["source_url"] = f"seed:{val}"
        if body and not fields.get("notes"):
            fields["notes"] = " ".join(body)
        if fields.get("name"):
            products.append(fields)
    return products


def ingest_pages(conn, pages: list[tuple[str, str]]) -> dict:
    stats = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    for url, html in pages:
        product = extract(url, html)
        if not product:
            stats["skipped"] += 1
            continue
        stats[upsert(conn, product)] += 1
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape operator tours into SQLite")
    parser.add_argument("--url", help="Website to crawl (same host only)")
    parser.add_argument("--from-raw", type=Path, help="Ingest saved HTML from this directory")
    parser.add_argument("--seed", type=Path, help="Seed from tours markdown")
    parser.add_argument("--db", type=Path, default=default_db())
    parser.add_argument("--raw", type=Path, default=None)
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES)
    args = parser.parse_args()

    if not args.url and not args.from_raw and not args.seed:
        parser.error("Provide --url, --from-raw, or --seed")

    raw_dir = args.raw or default_raw()
    raw_dir.mkdir(parents=True, exist_ok=True)
    conn = connect(args.db)

    stats = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    if args.url:
        set_setting(conn, "website_url", args.url)
        pages = crawl(args.url, raw_dir, args.max_pages)
        part = ingest_pages(conn, pages)
        for k, v in part.items():
            stats[k] += v
        set_setting(conn, "last_scrape_at", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        set_setting(conn, "last_scrape_pages", str(len(pages)))
    if args.from_raw:
        pages = load_raw(args.from_raw)
        part = ingest_pages(conn, pages)
        for k, v in part.items():
            stats[k] += v
        set_setting(conn, "last_scrape_at", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    if args.seed:
        for product in seed_markdown(args.seed):
            stats[upsert(conn, product)] += 1

    conn.commit()
    count = conn.execute("SELECT COUNT(*) AS n FROM products").fetchone()["n"]
    missing_buy = conn.execute(
        "SELECT COUNT(*) AS n FROM products WHERE buy_url IS NULL OR IFNULL(buy_channel, 'unknown') = 'unknown'"
    ).fetchone()["n"]
    channels = {
        r["buy_channel"] or "unknown": r["n"]
        for r in conn.execute(
            "SELECT buy_channel, COUNT(*) AS n FROM products GROUP BY buy_channel"
        )
    }
    samples = [
        dict(r)
        for r in conn.execute(
            "SELECT id, name, price_adult, price_child, source_url, buy_url, buy_channel FROM products ORDER BY id DESC LIMIT 8"
        )
    ]
    conn.close()
    json.dump(
        {
            "db": str(args.db),
            "products": count,
            **stats,
            "missing_buy": missing_buy,
            "buy_channels": channels,
            "sample": samples,
        },
        sys.stdout,
        indent=2,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0 if count else 2


if __name__ == "__main__":
    sys.exit(main())
