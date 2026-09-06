#!/usr/bin/env python3
"""Caddy on-demand TLS allowlist: *.{base} except apex and www."""

from __future__ import annotations

import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

BASE = os.environ.get("BUZZ_WILDCARD_BASE", "buzzftw.com").lower().rstrip(".")
DENY_LABELS = {"www", ""}
LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
ALLOWED = re.compile(rf"^{LABEL}\.{re.escape(BASE)}$")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        domain = (parse_qs(urlparse(self.path).query).get("domain") or [""])[0]
        domain = domain.lower().rstrip(".")
        allowed = bool(ALLOWED.fullmatch(domain))
        if allowed:
            label = domain[: -len(BASE) - 1]
            if label in DENY_LABELS:
                allowed = False
        self.send_response(200 if allowed else 400)
        self.end_headers()

    def log_message(self, fmt: str, *args: object) -> None:
        return


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 9999), Handler).serve_forever()
