import asyncio
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
READY = credit.RiskResult(risk='low',
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

    async def test_risk_assessment_without_decision_or_corrections_uses_selected_terms(self):
        _, data = await self.prepare()
        answer = credit.RiskResult(risk='high', reasons=['Требуется внимание сотрудника'])
        result = await self.assess(data, answer)
        self.assertEqual(result.status_code, 200, result.text)
        assessment = result.json()
        self.assertEqual(assessment['status'], 'ready')
        self.assertEqual(assessment['terms']['amount'], data['amount'])
        self.assertTrue(assessment['score']['manual_review'])
        response = await self.client.post('/credit/confirm', json={
            'assessment_token': assessment['assessment_token'], 'data': data, 'consent': True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['status'], 'bank_review')
        self.assertEqual(response.json()['ai_reasons'], answer.reasons)

    async def test_model_can_request_information_without_corrected_terms(self):
        _, data = await self.prepare()
        answer = credit.RiskResult(risk='medium', needs_info=True, reasons=['Уточните источники выручки'])
        result = (await self.assess(data, answer)).json()
        self.assertEqual(result['status'], 'needs_info')
        self.assertIsNone(result['assessment_token'])

    async def test_equipment_assessment_caps_suggestion_to_clients_reduced_amount(self):
        recommendations, data = await self.prepare()
        data.update(offer_id=recommendations['offers'][1]['id'], amount=600000)
        answer = credit.RiskResult(risk='low', reasons=['Платёж посилен'],
            terms={'amount': 1000000, 'months': 36, 'rate': 22.9})
        with patch.object(credit, 'ask_model', new_callable=AsyncMock, return_value=answer) as ask:
            response = await self.client.post('/credit/assessments', json=data)
        self.assertEqual(response.status_code, 200, response.text)
        assessment = response.json()
        self.assertEqual(assessment['status'], 'ready')
        self.assertEqual(assessment['terms']['amount'], 600000)
        self.assertAlmostEqual(assessment['terms']['payment'], credit.monthly_payment(600000, 36, 22.9))
        sent = ask.call_args.args[1]
        self.assertEqual(sent['selected_offer']['amount'], 600000)
        self.assertEqual(sent['limits']['max_amount'], 600000)
        result = await self.client.post('/credit/confirm', json={
            'assessment_token': assessment['assessment_token'], 'data': data, 'consent': True})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['amount'], 600000)
        self.assertEqual(result.json()['status'], 'bank_review')

    async def test_suggested_term_is_capped_to_product_limit(self):
        _, data = await self.prepare()
        answer = READY.model_copy(update={'terms': credit.Terms(amount=1500000, months=60, rate=24.9)})
        result = (await self.assess(data, answer)).json()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['terms']['months'], 36)
        self.assertAlmostEqual(result['terms']['payment'], credit.monthly_payment(1500000, 36, 24.9))

    async def test_capping_term_rechecks_payment_and_blocks_unaffordable_result(self):
        _, data = await self.prepare()
        data.update(expenses=1000000, debt=50000)
        answer = READY.model_copy(update={'terms': credit.Terms(amount=1500000, months=60, rate=24.9)})
        result = (await self.assess(data, answer)).json()
        self.assertEqual(result['status'], 'blocked')
        self.assertIsNone(result['assessment_token'])

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

    async def test_critical_risk_blocks_financially_affordable_case(self):
        _, data = await self.prepare()
        answer = READY.model_copy(update={'risk': 'critical'})
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
        with patch.object(credit.config.provider, 'api_key', ''), patch('services.credit_api.httpx.AsyncClient') as client:
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


class ProviderClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from config.config import ProviderConfig
        patcher = patch.object(credit.config, 'provider', ProviderConfig(
            name='test-provider', base_url='https://provider.example/v1/', model='test-model'))
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_openai_compatible_request_uses_configured_model_and_auth(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={'choices': [{'message': {'content': OFFERS.model_dump_json()}}]})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.object(credit.config.provider, 'api_key', 'test-only-key'), patch.object(credit.config.provider, 'model', 'deepseek-v4.1-flash'), patch('services.credit_api.httpx.AsyncClient', return_value=client):
            answer = await credit.ask_model('task', {'goal': 'Покупка оборудования'}, credit.GeneratedOffers)
        self.assertEqual(len(answer.offers), 2)
        self.assertEqual(str(requests[0].url), 'https://provider.example/v1/chat/completions')
        self.assertEqual(requests[0].headers['Authorization'], 'Bearer test-only-key')
        self.assertEqual(json.loads(requests[0].content)['model'], 'deepseek-v4.1-flash')

    async def test_risk_response_does_not_require_decision_probability_or_terms(self):
        body = {'risk': 'medium', 'reasons': ['Условия требуют проверки сотрудником']}
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200,
            json={'choices': [{'message': {'content': json.dumps(body)}}]})))
        with patch.object(credit.config.provider, 'api_key', 'test-key'), patch('services.credit_api.httpx.AsyncClient', return_value=client):
            answer = await credit.ask_model('Оцени риски', {}, credit.RiskResult)
        self.assertEqual(answer.risk, 'medium')
        self.assertIsNone(answer.terms)
        self.assertFalse(answer.needs_info)
        properties = credit.RiskResult.model_json_schema()['properties']
        self.assertNotIn('status', properties)
        self.assertNotIn('approval_probability', properties)

    async def test_malformed_model_output_is_rejected_without_leaking_raw_text(self):
        for body in [{'choices': [{'message': {'content': 'not json'}}]}, {'choices': []}]:
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body)))
            with patch.object(credit.config.provider, 'api_key', 'test-only-key'), patch.object(credit.config.provider, 'model', 'deepseek-v4.1-flash'), patch('services.credit_api.httpx.AsyncClient', return_value=client):
                with self.assertRaises(credit.HTTPException) as error:
                    await credit.ask_model('task', {}, credit.GeneratedOffers)
                self.assertEqual(error.exception.detail, 'CREDIT_AI_INVALID_RESPONSE')

    async def test_provider_http_failures_are_classified_without_leaking_response(self):
        for status, code in [(401, 'AUTH_FAILED'), (402, 'BALANCE_REQUIRED'),
                (403, 'ACCESS_DENIED'), (404, 'MODEL_NOT_FOUND'), (429, 'RATE_LIMIT'),
                (400, 'REQUEST_REJECTED'), (503, 'UNAVAILABLE')]:
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(status,
                json={'error': {'message': 'private-provider-message'}})))
            with patch.object(credit.config.provider, 'api_key', 'private-api-key'), patch('services.credit_api.httpx.AsyncClient', return_value=client), self.assertLogs(credit.logger, level='WARNING') as logs:
                with self.assertRaises(credit.HTTPException) as error:
                    await credit.ask_model('task', {'goal': 'private-goal'}, credit.GeneratedOffers)
            self.assertEqual(error.exception.detail, 'CREDIT_AI_' + code)
            self.assertIn(f'upstream_status={status}', logs.output[0])
            for private in ('private-provider-message', 'private-api-key', 'private-goal'):
                self.assertNotIn(private, '\n'.join(logs.output))

    async def test_rejected_json_mode_retries_once_without_response_format(self):
        requests = []
        def handler(request):
            requests.append(json.loads(request.content))
            if len(requests) == 1:
                return httpx.Response(400, json={'error': {'param': 'response_format', 'message': 'unsupported parameter'}})
            return httpx.Response(200, json={'choices': [{'message': {'content': '```json\n' + OFFERS.model_dump_json() + '\n```'}}]})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.object(credit.config.provider, 'api_key', 'test-key'), patch('services.credit_api.httpx.AsyncClient', return_value=client):
            result = await credit.ask_model('task', {}, credit.GeneratedOffers)
        self.assertEqual(len(result.offers), 2)
        self.assertEqual(len(requests), 2)
        self.assertIn('response_format', requests[0])
        self.assertNotIn('response_format', requests[1])

    async def test_timeout_and_connection_errors_have_specific_codes_without_retry(self):
        for exception, code, status in [(httpx.ReadTimeout, 'TIMEOUT', 504), (httpx.ConnectError, 'CONNECTION_FAILED', 502)]:
            calls = []
            def handler(request):
                calls.append(request)
                raise exception('private network detail', request=request)
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            with patch.object(credit.config.provider, 'api_key', 'test-key'), patch('services.credit_api.httpx.AsyncClient', return_value=client):
                with self.assertRaises(credit.HTTPException) as error:
                    await credit.ask_model('task', {}, credit.GeneratedOffers)
            self.assertEqual(error.exception.detail, 'CREDIT_AI_' + code)
            self.assertEqual(error.exception.status_code, status)
            self.assertEqual(len(calls), 1)

    async def test_slow_valid_response_uses_configured_timeout(self):
        async def handler(request):
            await asyncio.sleep(0.02)
            return httpx.Response(200, json={'choices': [{'message': {'content': OFFERS.model_dump_json()}}]})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.object(credit.config.provider, 'api_key', 'test-key'), patch.object(credit.config.provider, 'timeout_seconds', 0.5), patch('services.credit_api.httpx.AsyncClient', return_value=client) as factory:
            result = await credit.ask_model('task', {}, credit.GeneratedOffers)
        self.assertEqual(len(result.offers), 2)
        self.assertEqual(factory.call_args.kwargs['timeout'].read, 0.5)
        self.assertEqual(factory.call_args.kwargs['timeout'].connect, 20)

    async def test_total_deadline_includes_json_mode_retry_and_cancels_request(self):
        calls = []
        cancelled = asyncio.Event()
        async def handler(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(400, json={'error': {'param': 'response_format'}})
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.object(credit.config.provider, 'api_key', 'test-key'), patch.object(credit.config.provider, 'timeout_seconds', 0.02), patch('services.credit_api.httpx.AsyncClient', return_value=client), self.assertLogs(credit.logger, level='WARNING') as logs:
            with self.assertRaises(credit.HTTPException) as error:
                await credit.ask_model('task', {}, credit.GeneratedOffers)
        self.assertEqual(error.exception.status_code, 504)
        self.assertEqual(error.exception.detail, 'CREDIT_AI_TIMEOUT')
        self.assertEqual(len(calls), 2)
        self.assertTrue(cancelled.is_set())
        self.assertTrue(client.is_closed)
        self.assertIn('phase=total', logs.output[-1])

    async def test_connection_and_response_timeouts_have_distinct_log_phases(self):
        for exception, phase in [(httpx.ConnectTimeout, 'connect'), (httpx.ReadTimeout, 'read')]:
            def handler(request):
                raise exception('private-network-detail', request=request)
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            with patch.object(credit.config.provider, 'api_key', 'test-key'), patch('services.credit_api.httpx.AsyncClient', return_value=client), self.assertLogs(credit.logger, level='WARNING') as logs:
                with self.assertRaises(credit.HTTPException):
                    await credit.ask_model('task', {}, credit.GeneratedOffers)
            self.assertIn('phase=' + phase, logs.output[0])
            self.assertNotIn('private-network-detail', logs.output[0])

    async def test_truncated_response_cannot_be_used_as_valid_advice(self):
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200,
            json={'choices': [{'finish_reason': 'length', 'message': {'content': OFFERS.model_dump_json()}}]})))
        with patch.object(credit.config.provider, 'api_key', 'test-key'), patch('services.credit_api.httpx.AsyncClient', return_value=client):
            with self.assertRaises(credit.HTTPException) as error:
                await credit.ask_model('task', {}, credit.GeneratedOffers)
        self.assertEqual(error.exception.detail, 'CREDIT_AI_RESPONSE_TRUNCATED')
