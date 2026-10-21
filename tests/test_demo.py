import os
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

import httpx
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

# Use test settings without reading or changing the project's credentials.
with patch.dict(os.environ, {
    'SECRET': 'demo-test-secret-that-is-at-least-32-characters',
    'COOKIE_SECURE': 'false',
}), patch('logging.basicConfig'):
    from main import app
    from services.db import Base, get_async_session
    from services.users import config


class DemoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        session_maker = async_sessionmaker(self.engine, expire_on_commit=False)

        async def test_session():
            async with session_maker() as session:
                yield session

        app.dependency_overrides[get_async_session] = test_session
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url='http://testserver',
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        app.dependency_overrides.clear()
        await self.engine.dispose()

    async def register(self):
        response = await self.client.post('/auth/register', json={
            'email': 'demo@example.com', 'password': 'test-password-123',
            'username': 'demo_user', 'inn': '7707083893',
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.assertNotIn('inn', response.json())

    async def test_demo_and_assets(self):
        response = await self.client.get('/demo')
        self.assertEqual(response.status_code, 200)
        self.assertIn('text/html', response.headers['content-type'])
        self.assertEqual(response.headers['referrer-policy'], 'no-referrer')
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual((await self.client.get('/')).status_code, 200)
        for asset, content_type in [('app.js', 'javascript'), ('credit.js', 'javascript'), ('style.css', 'text/css')]:
            path = f'/demo/assets/{asset}'
            self.assertIn(path, response.text)
            asset_response = await self.client.get(path)
            self.assertEqual(asset_response.status_code, 200)
            self.assertIn(content_type, asset_response.headers['content-type'])

    async def test_register_login_profile_update_and_logout(self):
        self.assertEqual((await self.client.get('/profile')).status_code, 401)
        await self.register()
        response = await self.client.post('/auth/login', data={
            'username': 'demo@example.com', 'password': 'test-password-123',
        })
        self.assertEqual(response.status_code, 204)
        self.assertIn('httponly', response.headers['set-cookie'].lower())
        response = await self.client.get('/profile')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['username'], 'demo_user')
        self.assertEqual((await self.client.get('/users/me')).status_code, 200)
        response = await self.client.patch('/users/me', json={'username': 'updated_user'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['username'], 'updated_user')
        self.assertEqual((await self.client.post('/auth/logout')).status_code, 204)
        self.assertEqual((await self.client.get('/profile')).status_code, 401)

    async def test_reset_password_from_email_link(self):
        await self.register()
        with patch.object(config.mail, 'reset_password_url', 'http://testserver/demo?flow=reset'), \
                patch('services.users.send_email', new_callable=AsyncMock) as send:
            response = await self.client.post('/auth/forgot-password', json={'email': 'demo@example.com'})
        self.assertEqual(response.status_code, 202)
        send.assert_awaited_once()
        self.assertEqual(send.call_args.args[1], 'demo@example.com')
        link = send.call_args.args[3].splitlines()[1]
        query = parse_qs(urlsplit(link).query)
        self.assertEqual(query['flow'], ['reset'])
        response = await self.client.post('/auth/reset-password', json={
            'token': query['token'][0], 'password': 'changed-password-123',
        })
        self.assertEqual(response.status_code, 200, response.text)
        response = await self.client.post('/auth/login', data={
            'username': 'demo@example.com', 'password': 'changed-password-123',
        })
        self.assertEqual(response.status_code, 204)

    async def test_verify_from_email_link(self):
        await self.register()
        with patch.object(config.mail, 'verification_url', 'http://testserver/demo?flow=verify'), \
                patch('services.users.send_email', new_callable=AsyncMock) as send:
            response = await self.client.post('/auth/request-verify-token', json={'email': 'demo@example.com'})
        self.assertEqual(response.status_code, 202)
        send.assert_awaited_once()
        link = send.call_args.args[3].splitlines()[1]
        query = parse_qs(urlsplit(link).query)
        self.assertEqual(query['flow'], ['verify'])
        response = await self.client.post('/auth/verify', json={'token': query['token'][0]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['is_verified'])

    async def test_validation_error_is_json(self):
        response = await self.client.post('/auth/register', json={
            'email': 'demo@example.com', 'password': 'test-password-123',
            'username': 'demo_user', 'inn': '0000000001',
        })
        self.assertEqual(response.status_code, 422)
        self.assertIsInstance(response.json()['detail'], list)
