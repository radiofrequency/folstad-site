#!/usr/bin/env python3
import importlib.util
import os
import unittest
from unittest.mock import MagicMock

os.environ["BUZZ_WILDCARD_BASE"] = "buzzftw.com"
spec = importlib.util.spec_from_file_location(
    "tls_ask", os.path.join(os.path.dirname(__file__), "tls-ask.py")
)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def check(domain: str) -> int:
    h = mod.Handler
    req = h.__new__(h)
    req.path = f"/check?domain={domain}"
    req.send_response = MagicMock()
    req.end_headers = MagicMock()
    req.do_GET()
    return req.send_response.call_args[0][0]


class TlsAskTests(unittest.TestCase):
    def test_relay_allowed(self):
        self.assertEqual(check("relay.buzzftw.com"), 200)

    def test_community_allowed(self):
        self.assertEqual(check("friends.buzzftw.com"), 200)

    def test_www_denied(self):
        self.assertEqual(check("www.buzzftw.com"), 400)

    def test_apex_denied(self):
        self.assertEqual(check("buzzftw.com"), 400)

    def test_other_zone_denied(self):
        self.assertEqual(check("relay.evil.example"), 400)


if __name__ == "__main__":
    unittest.main()
