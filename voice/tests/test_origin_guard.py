"""#97: the voice sidecar must reject cross-origin local browser requests.

The sidecar plays audio on the host's speakers and exposes WS endpoints; a
local browser tab could otherwise POST /tts or open ws://127.0.0.1/tts/stream
and make the speakers say anything. The daemon's own callers (Node http +
`ws`) send no Origin header, so the policy is: allow a missing Origin and any
loopback Origin, reject everything else.

Stdlib ``unittest`` only — the voice package ships no pytest/httpx, so this
unit-tests the security decision (the crux) and asserts the guards are wired
onto the app, rather than spinning up a live server.

Run:  voice/.venv/Scripts/python voice/tests/test_origin_guard.py
  or, from voice/tests/: ../.venv/Scripts/python -m unittest test_origin_guard
"""

import unittest

from fastapi.middleware.trustedhost import TrustedHostMiddleware

from buddy_voice.main import _origin_allowed, app


class OriginAllowedTest(unittest.TestCase):
    def test_missing_origin_is_allowed(self):
        # The daemon (Node http/ws) sends no Origin header.
        self.assertTrue(_origin_allowed(None))

    def test_loopback_origins_allowed(self):
        for origin in (
            "http://127.0.0.1",
            "http://127.0.0.1:31416",
            "http://localhost",
            "https://localhost:5173",
            "http://[::1]:3000",
        ):
            with self.subTest(origin=origin):
                self.assertTrue(_origin_allowed(origin))

    def test_cross_site_origins_rejected(self):
        for origin in (
            "https://evil.com",
            "http://example.com:31416",
            "http://127.0.0.1.evil.com",  # suffix trick — not loopback
            "https://attacker.localhost.evil.com",
            "null",  # opaque origin (sandboxed iframe)
            "http://",  # malformed → no host
        ):
            with self.subTest(origin=origin):
                self.assertFalse(_origin_allowed(origin))


class GuardWiringTest(unittest.TestCase):
    def test_trusted_host_middleware_registered(self):
        classes = [m.cls for m in app.user_middleware]
        self.assertIn(TrustedHostMiddleware, classes)

    def test_cross_origin_http_middleware_registered(self):
        # The @app.middleware("http") guard is a BaseHTTPMiddleware; at
        # least it (plus TrustedHost) should be present.
        self.assertGreaterEqual(len(app.user_middleware), 2)


if __name__ == "__main__":
    unittest.main()
