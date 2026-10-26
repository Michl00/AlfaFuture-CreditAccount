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
            'username': 'demo_user',
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.assertIsNone(response.json()['inn'])

    async def test_entry_points_only_open_new_cabinet(self):
        for path in ('/', '/demo', '/demo/'):
            response = await self.client.get(path)
            self.assertEqual(response.status_code, 307)
            self.assertEqual(response.headers['location'], '/cabinet/')
            self.assertEqual(response.headers['cache-control'], 'no-store')
        for asset in ('index.html', 'app.js', 'credit.js', 'bank.js', 'style.css'):
            response = await self.client.get(f'/demo/assets/{asset}')
            self.assertEqual(response.status_code, 404)

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

    async def test_optional_profile_inn_can_be_added_changed_and_removed(self):
        await self.register()
        await self.client.post('/auth/login', data={'username': 'demo@example.com', 'password': 'test-password-123'})
        self.assertIsNone((await self.client.get('/users/me')).json()['inn'])
        for value, expected in [('7707083893', '7707083893'), ('7701234560', '7701234560'), ('', None), (None, None)]:
            response = await self.client.patch('/users/me', json={'inn': value})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['inn'], expected)
            self.assertEqual((await self.client.get('/users/me')).json()['inn'], expected)
        response = await self.client.patch('/users/me', json={'inn': '0000000001'})
        self.assertEqual(response.status_code, 422)
        self.assertIsNone((await self.client.get('/users/me')).json()['inn'])

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

    async def test_email_confirmation_is_not_exposed(self):
        schema = (await self.client.get('/openapi.json')).json()
        self.assertNotIn('/auth/verify', schema['paths'])
        self.assertNotIn('/auth/request-verify-token', schema['paths'])
        await self.register()
        await self.client.post('/auth/login', data={'username': 'demo@example.com', 'password': 'test-password-123'})
        profile = await self.client.get('/users/me')
        self.assertEqual(profile.status_code, 200)
        self.assertNotIn('is_verified', profile.json())
        for name in ('UserRead', 'UserCreate', 'UserUpdate'):
            self.assertNotIn('is_verified', schema['components']['schemas'][name]['properties'])

    async def test_validation_error_is_json(self):
        response = await self.client.post('/auth/register', json={
            'email': 'demo@example.com', 'password': 'test-password-123',
            'username': 'demo_user', 'inn': '0000000001',
        })
        self.assertEqual(response.status_code, 422)
        self.assertIsInstance(response.json()['detail'], list)
