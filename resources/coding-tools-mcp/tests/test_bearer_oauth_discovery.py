from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from coding_tools_mcp.server import MCPHandler, Runtime, RuntimeHTTPServer


class BearerOAuthDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        runtime = Runtime(Path(self.temp.name), auth_token="test-bearer-token", transport="http")
        self.server = RuntimeHTTPServer(("127.0.0.1", 0), MCPHandler, runtime, lambda: runtime)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = int(self.server.server_address[1])

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method: str, path: str, *, headers: dict[str, str] | None = None, body: str | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            payload = response.read().decode("utf-8", errors="replace")
            return response.status, dict(response.getheaders()), payload
        finally:
            connection.close()

    def test_bearer_mode_hides_oauth_discovery_routes_from_options_and_get(self) -> None:
        oauth_paths = [
            "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
            "/oauth/authorize",
            "/oauth/token",
            "/oauth/register",
        ]
        for path in oauth_paths:
            with self.subTest(method="OPTIONS", path=path):
                status, headers, _ = self.request("OPTIONS", path)
                self.assertEqual(status, 404)
                self.assertNotIn("WWW-Authenticate", headers)

        for path in [
            "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
        ]:
            with self.subTest(method="GET", path=path):
                status, headers, payload = self.request("GET", path)
                self.assertEqual(status, 404)
                self.assertNotIn("WWW-Authenticate", headers)
                self.assertEqual(json.loads(payload).get("error"), "Unknown endpoint")

    def test_mcp_bearer_challenge_does_not_advertise_oauth_metadata(self) -> None:
        status, headers, _ = self.request(
            "POST",
            "/mcp",
            headers={"Content-Type": "application/json", "Content-Length": "2"},
            body="{}",
        )
        self.assertEqual(status, 401)
        challenge = headers.get("WWW-Authenticate", "")
        self.assertIn('Bearer realm="coding-tools-mcp"', challenge)
        self.assertNotIn("resource_metadata=", challenge)

    def test_server_card_still_reports_bearer_auth(self) -> None:
        status, _, payload = self.request("GET", "/.well-known/mcp.json")
        self.assertEqual(status, 200)
        card = json.loads(payload)
        self.assertEqual(card["auth"]["type"], "bearer")
        self.assertEqual(card["auth"]["scheme"], "Bearer")


if __name__ == "__main__":
    unittest.main()
