import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from config.config import ProviderConfig
from services.platform.adapters import assistant


class AssistantAvailabilityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patcher = patch.dict("os.environ", {"ASSISTANT_MODEL": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_missing_key_is_distinguished_from_provider_failure(self):
        config = SimpleNamespace(provider=ProviderConfig())
        with patch("config.config.load_config", return_value=config):
            answer = await assistant([{"role": "user", "content": "Нужен станок"}], {})
        self.assertEqual(answer["unavailable_reason"], "missing_key")
        self.assertIn("не настроено", answer["availability_message"])

    async def test_provider_http_errors_have_safe_specific_reasons(self):
        for status, reason in ((401, "authentication"), (402, "quota"),
                               (429, "rate_limit"), (503, "provider")):
            with self.subTest(status=status):
                config = SimpleNamespace(provider=ProviderConfig(name="test-provider", base_url="https://provider.example/v1/", api_key="test-only-key", model="arbitrary-model"))
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
        config = SimpleNamespace(provider=ProviderConfig(name="test-provider", base_url="https://provider.example/v1/", api_key="test-only-key", model="arbitrary-model"))
        requests = []
        def handler(request):
            requests.append(request)
            return response
        response = httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
                "content": '{"text":"Объяснение от модели","questions":[]}'
            }}]})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("config.config.load_config", return_value=config), \
             patch("services.platform.adapters.httpx.AsyncClient", return_value=client):
            answer = await assistant([{"role": "user", "content": "Объясни решение"}], {})
        self.assertEqual(answer["mode"], "llm")
        self.assertEqual(answer["provider"], "test-provider")
        self.assertEqual(answer["model"], "arbitrary-model")
        self.assertEqual(str(requests[0].url), "https://provider.example/v1/chat/completions")
        self.assertEqual(requests[0].headers["Authorization"], "Bearer test-only-key")
        self.assertNotIn("unavailable_reason", answer)

    async def test_incomplete_configuration_does_not_call_provider(self):
        for base_url, model in (("", "test-model"), ("https://provider.example/v1", "")):
            config = SimpleNamespace(provider=ProviderConfig(
                api_key="test-key", base_url=base_url, model=model))
            with patch.dict("os.environ", {"ASSISTANT_MODEL": ""}), \
                 patch("config.config.load_config", return_value=config), \
                 patch("services.platform.adapters.httpx.AsyncClient") as client:
                answer = await assistant([{"role": "user", "content": "Объясни решение"}], {})
            self.assertEqual(answer["unavailable_reason"], "missing_configuration")
            client.assert_not_called()
