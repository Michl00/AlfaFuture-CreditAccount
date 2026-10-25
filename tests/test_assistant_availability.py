import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from services.platform.adapters import assistant


class AssistantAvailabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_key_is_distinguished_from_provider_failure(self):
        config = SimpleNamespace(comet=SimpleNamespace(api_key=""))
        with patch("config.config.load_config", return_value=config):
            answer = await assistant([{"role": "user", "content": "Нужен станок"}], {})
        self.assertEqual(answer["unavailable_reason"], "missing_key")
        self.assertIn("не настроено", answer["availability_message"])

    async def test_provider_http_errors_have_safe_specific_reasons(self):
        for status, reason in ((401, "authentication"), (402, "quota"),
                               (429, "rate_limit"), (503, "provider")):
            with self.subTest(status=status):
                config = SimpleNamespace(comet=SimpleNamespace(api_key="test-only-key"))
                client = httpx.AsyncClient(transport=httpx.MockTransport(
                    lambda request: httpx.Response(status, json={"error": {"message": "private provider detail"}})
                ))
                with patch("config.config.load_config", return_value=config), \
                     patch("services.platform.adapters.httpx.AsyncClient", return_value=client):
                    answer = await assistant([{"role": "user", "content": "Нужен станок"}], {})
                self.assertEqual(answer["unavailable_reason"], reason)
                self.assertNotIn("private provider detail", str(answer))
                self.assertNotIn("test-only-key", str(answer))

    async def test_valid_provider_response_stays_in_ai_mode(self):
        config = SimpleNamespace(comet=SimpleNamespace(api_key="test-only-key"))
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request:
            httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
                "content": '{"text":"Объяснение от модели","questions":[]}'
            }}]})
        ))
        with patch("config.config.load_config", return_value=config), \
             patch("services.platform.adapters.httpx.AsyncClient", return_value=client):
            answer = await assistant([{"role": "user", "content": "Объясни решение"}], {})
        self.assertEqual(answer["mode"], "llm")
        self.assertNotIn("unavailable_reason", answer)
