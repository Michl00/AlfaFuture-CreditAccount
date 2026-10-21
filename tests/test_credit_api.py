import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
import jwt

import test_demo as demo_tests
from services import credit_api as credit

OFFERS = credit.GeneratedOffers(offers=[
    {'product': 'working', 'name': 'Оборотные средства', 'amount': 1500000, 'months': 24,
     'rate': 24.9, 'reason': 'Под выбранную цель', 'conservative': False},
    {'product': 'equipment', 'name': 'Более посильный платёж', 'amount': 1000000, 'months': 36,
     'rate': 22.9, 'reason': 'Меньше сумма и больше срок', 'conservative': True},
])
READY = credit.RiskResult(status='ready', risk='low', approval_probability=0.8,
    reasons=['Дохода достаточно для платежа'], terms={'amount': 1500000, 'months': 24, 'rate': 24.9})


class CreditAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = demo_tests.DemoTests.asyncSetUp
    asyncTearDown = demo_tests.DemoTests.asyncTearDown
    register = demo_tests.DemoTests.register

    async def login(self):
        await self.register()
        response = await self.client.post('/auth/login', data={'username': 'demo@example.com', 'password': 'test-password-123'})
        self.assertEqual(response.status_code, 204)

    async def prepare(self):
        await self.login()
        with patch.object(credit, 'ask_model', new_callable=AsyncMock, return_value=OFFERS):
            response = await self.client.post('/credit/recommendations', json={
                'goal': 'Закупка материалов для новой мастерской', 'requestedAmount': 1500000, 'requestedMonths': 24})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        data = {'recommendation_token': result['recommendation_token'], 'offer_id': result['offers'][0]['id'],
            'amount': 1500000, 'company': 'ООО «Вектор»', 'inn': '7701234560',
            'revenue': 1200000, 'expenses': 700000, 'debt': 20000, 'age': 24, 'clarification': ''}
        return result, data

    async def assess(self, data, answer=READY):
        with patch.object(credit, 'ask_model', new_callable=AsyncMock, return_value=answer):
            return await self.client.post('/credit/assessments', json=data)

    async def test_all_credit_endpoints_require_authentication(self):
        for path in ('recommendations', 'assessments', 'confirm'):
            response = await self.client.post('/credit/' + path, json={})
            self.assertEqual(response.status_code, 401)

    async def test_recommendation_badge_is_validated_and_context_is_signed(self):
        offers, _ = await self.prepare()
        self.assertFalse(offers['offers'][0]['high_chance'])
        self.assertTrue(offers['offers'][1]['high_chance'])
        self.assertTrue(offers['recommendation_token'])

    async def test_ready_assessment_requires_consent_and_confirms_exact_terms(self):
        _, data = await self.prepare()
        result = (await self.assess(data)).json()
        self.assertEqual(result['status'], 'ready')
        payload = {'assessment_token': result['assessment_token'], 'data': data, 'consent': True}
        response = await self.client.post('/credit/confirm', json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['amount'], 1500000)
        self.assertEqual(response.json()['status'], 'bank_review')
        repeat = await self.client.post('/credit/confirm', json=payload)
        self.assertEqual(repeat.json()['id'], response.json()['id'])
        payload['consent'] = False
        self.assertEqual((await self.client.post('/credit/confirm', json=payload)).status_code, 422)

    async def test_financial_changes_invalidate_assessment(self):
        _, data = await self.prepare()
        result = (await self.assess(data)).json()
        changed = {**data, 'expenses': 1190000}
        response = await self.client.post('/credit/confirm', json={
            'assessment_token': result['assessment_token'], 'data': changed, 'consent': True})
        self.assertEqual(response.status_code, 409)

    async def test_critical_income_blocks_even_when_model_says_ready(self):
        _, data = await self.prepare()
        data['expenses'] = 1200000
        response = await self.assess(data)
        self.assertEqual(response.json()['status'], 'blocked')
        self.assertIsNone(response.json()['assessment_token'])

    async def test_extremely_low_model_probability_blocks_financially_affordable_case(self):
        _, data = await self.prepare()
        answer = READY.model_copy(update={'approval_probability': 0.05})
        result = (await self.assess(data, answer)).json()
        self.assertEqual(result['status'], 'blocked')
        self.assertIsNone(result['assessment_token'])

    async def test_unaffordable_corrected_terms_are_blocked(self):
        _, data = await self.prepare()
        data.update(expenses=1000000, debt=50000)
        result = (await self.assess(data)).json()
        self.assertEqual(result['status'], 'blocked')

    async def test_young_business_requires_clarification(self):
        _, data = await self.prepare()
        data['age'] = 2
        result = (await self.assess(data)).json()
        self.assertEqual(result['status'], 'needs_info')
        self.assertIsNone(result['assessment_token'])

    async def test_changed_or_foreign_signed_context_is_rejected(self):
        _, data = await self.prepare()
        data['recommendation_token'] += 'tampered'
        self.assertEqual((await self.assess(data)).status_code, 409)
        _, data = await self.prepare_second_context()
        await self.client.post('/auth/logout')
        await self.client.post('/auth/register', json={'email': 'other@example.com', 'password': 'other-password-123', 'username': 'other_user', 'inn': '7701234560'})
        await self.client.post('/auth/login', data={'username': 'other@example.com', 'password': 'other-password-123'})
        self.assertEqual((await self.assess(data)).status_code, 409)

    async def prepare_second_context(self):
        with patch.object(credit, 'ask_model', new_callable=AsyncMock, return_value=OFFERS):
            response = await self.client.post('/credit/recommendations', json={'goal': 'Закупка товаров', 'requestedAmount': 1500000, 'requestedMonths': 24})
        result = response.json()
        return result, {'recommendation_token': result['recommendation_token'], 'offer_id': result['offers'][0]['id'], 'amount': 1500000, 'company': 'Вектор', 'inn': '7701234560', 'revenue': 1200000, 'expenses': 700000, 'debt': 20000, 'age': 24}

    async def test_expired_proof_cannot_confirm(self):
        _, data = await self.prepare()
        result = (await self.assess(data)).json()
        claims = jwt.decode(result['assessment_token'], options={'verify_signature': False})
        claims['exp'] = 0
        expired = jwt.encode(claims, credit.config.auth.secret, algorithm='HS256')
        response = await self.client.post('/credit/confirm', json={'assessment_token': expired, 'data': data, 'consent': True})
        self.assertEqual(response.status_code, 409)

    async def test_no_key_fails_explicitly_without_network(self):
        await self.login()
        with patch.object(credit.config.comet, 'api_key', ''), patch('services.credit_api.httpx.AsyncClient') as client:
            response = await self.client.post('/credit/recommendations', json={'goal': 'Оборудование', 'requestedAmount': 1500000, 'requestedMonths': 24})
        self.assertEqual(response.status_code, 503)
        client.assert_not_called()

    async def test_invalid_offer_limits_or_fake_high_chance_badge_are_rejected(self):
        await self.login()
        for offer in [OFFERS.offers[1].model_copy(update={'amount': 9000000}), OFFERS.offers[0].model_copy(update={'conservative': True})]:
            answer = credit.GeneratedOffers(offers=[OFFERS.offers[0], offer])
            with patch.object(credit, 'ask_model', new_callable=AsyncMock, return_value=answer):
                response = await self.client.post('/credit/recommendations', json={'goal': 'Закупка товаров', 'requestedAmount': 1500000, 'requestedMonths': 24})
            self.assertEqual(response.status_code, 502)


class CometClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_openai_compatible_request_uses_configured_model_and_auth(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={'choices': [{'message': {'content': OFFERS.model_dump_json()}}]})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.object(credit.config.comet, 'api_key', 'test-only-key'), patch.object(credit.config.comet, 'model', 'configured-qwen-id'), patch('services.credit_api.httpx.AsyncClient', return_value=client):
            answer = await credit.ask_model('task', {'goal': 'Покупка оборудования'}, credit.GeneratedOffers)
        self.assertEqual(len(answer.offers), 2)
        self.assertEqual(str(requests[0].url), 'https://api.cometapi.com/v1/chat/completions')
        self.assertEqual(requests[0].headers['Authorization'], 'Bearer test-only-key')
        self.assertEqual(json.loads(requests[0].content)['model'], 'configured-qwen-id')

    async def test_malformed_model_output_is_rejected_without_leaking_raw_text(self):
        for body in [{'choices': [{'message': {'content': 'not json'}}]}, {'choices': []}]:
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body)))
            with patch.object(credit.config.comet, 'api_key', 'test-only-key'), patch.object(credit.config.comet, 'model', 'configured-qwen-id'), patch('services.credit_api.httpx.AsyncClient', return_value=client):
                with self.assertRaises(credit.HTTPException) as error:
                    await credit.ask_model('task', {}, credit.GeneratedOffers)
                self.assertEqual(error.exception.detail, 'CREDIT_AI_UNAVAILABLE')
