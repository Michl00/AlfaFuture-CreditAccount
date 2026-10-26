import os
import unittest
from unittest.mock import patch

import httpx
import test_demo
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from services.platform.origins import normalize_origin


class OriginTests(unittest.TestCase):
    def test_default_ports_and_host_case(self):
        self.assertEqual(normalize_origin("https://CREDIT.example:443/"),
                         normalize_origin("https://credit.example"))
        self.assertEqual(normalize_origin("http://localhost:80"),
                         normalize_origin("http://localhost"))
        self.assertNotEqual(normalize_origin("https://credit.example"),
                            normalize_origin("http://credit.example"))
        self.assertNotEqual(normalize_origin("http://localhost:4321"),
                            normalize_origin("http://localhost:8000"))

    def test_invalid_origins_are_rejected(self):
        for value in ("", "null", "*", "https://user@credit.example",
                      "https://credit.example/path", "https://credit.example?x=1",
                      "https://credit.example#fragment", "https://credit.example:bad",
                      "https://credit.example https://evil.example", "file:///tmp"):
            with self.subTest(value=value):
                self.assertIsNone(normalize_origin(value))


class LoginOriginTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_demo.DemoTests.asyncSetUp
    asyncTearDown = test_demo.DemoTests.asyncTearDown

    async def login(self, url, origin, *, forwarded=None, trusted="127.0.0.1",
                    public_origin="", root_path=""):
        application = ProxyHeadersMiddleware(test_demo.app, trusted_hosts=trusted)
        transport = httpx.ASGITransport(
            app=application, client=("172.20.0.5", 54321), root_path=root_path
        )
        headers = {"Origin": origin}
        if forwarded:
            headers.update(forwarded)
        with patch.dict(os.environ, {"DEMO_MODE": "true", "PUBLIC_ORIGIN": public_origin,
                                    "COOKIE_SECURE": "true" if origin.startswith("https:") else "false"}):
            async with httpx.AsyncClient(transport=transport, base_url=url) as client:
                return await client.post("/api/v1/demo/login", headers=headers,
                                         json={"profile": "ip"})

    async def test_direct_compose_and_astro_ports(self):
        for origin in ("http://127.0.0.1:8000", "http://localhost:8000",
                       "http://127.0.0.1:4321", "http://localhost:8080"):
            with self.subTest(origin=origin):
                response = await self.login(origin, origin)
                self.assertEqual(response.status_code, 200, response.text)

    async def test_coolify_https_from_private_proxy(self):
        response = await self.login(
            "http://credit.example", "https://credit.example:443", trusted="*",
            forwarded={"X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.10"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("Secure", response.headers["set-cookie"])

    async def test_untrusted_proxy_cannot_change_scheme(self):
        response = await self.login("http://credit.example", "https://credit.example",
                                    forwarded={"X-Forwarded-Proto": "https"})
        self.assertEqual(response.status_code, 403)

    async def test_public_origin_when_proxy_rewrites_host(self):
        response = await self.login("http://api:8000", "https://credit.example",
                                    public_origin="https://credit.example")
        self.assertEqual(response.status_code, 200, response.text)
        rejected = await self.login("http://api:8000", "http://api:8000",
                                   public_origin="https://credit.example")
        self.assertEqual(rejected.status_code, 403)

    async def test_cross_origin_and_forged_forwarded_host_rejected(self):
        for origin in ("https://evil.example", "null", "", "https://credit.example.evil.example",
                       "http://credit.example", "https://credit.example:8443"):
            with self.subTest(origin=origin):
                response = await self.login(
                    "http://credit.example", origin, trusted="*",
                    forwarded={"X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example"},
                )
                self.assertEqual(response.status_code, 403, response.text)

    async def test_subpath_does_not_change_origin(self):
        response = await self.login("http://localhost:8000", "http://localhost:8000",
                                    root_path="/credit")
        self.assertEqual(response.status_code, 200, response.text)

    async def test_invalid_public_origin_is_configuration_error(self):
        response = await self.login("http://api:8000", "https://credit.example",
                                    public_origin="https://credit.example/cabinet/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "PUBLIC_ORIGIN_INVALID")
