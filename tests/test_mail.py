import smtplib
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from services.mail import build_token_url, send_email


class TokenURLTests(unittest.TestCase):
    def test_encodes_token_and_preserves_query_and_fragment(self):
        token = 'a+b/c?=& Ж'
        url = build_token_url('https://example.com/reset?lang=ru&empty=#form', token)
        parts = urlsplit(url)
        self.assertEqual(parts.scheme, 'https')
        self.assertEqual(parts.netloc, 'example.com')
        self.assertEqual(parts.path, '/reset')
        self.assertEqual(parts.fragment, 'form')
        self.assertEqual(parse_qs(parts.query, keep_blank_values=True),
                         {'lang': ['ru'], 'empty': [''], 'token': [token]})

    def test_replaces_existing_tokens(self):
        url = build_token_url('https://example.com/verify?token=old&token=older', 'new')
        self.assertEqual(parse_qs(urlsplit(url).query), {'token': ['new']})

    def test_rejects_missing_relative_and_non_http_urls(self):
        for url in ('', '/reset', '//example.com/reset', 'https:///reset',
                    'javascript:alert(1)', 'ftp://example.com/reset'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                build_token_url(url, 'secret')


class SendEmailTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.config = SimpleNamespace(
            host='smtp.example.com', port=587, username='mailer',
            password='password', sender='no-reply@example.com', starttls=True,
        )
        self.smtp_patch = patch('services.mail.smtplib.SMTP')
        self.smtp_factory = self.smtp_patch.start()
        self.addCleanup(self.smtp_patch.stop)
        self.smtp = self.smtp_factory.return_value.__enter__.return_value

    async def test_sends_utf8_email_with_tls_before_login(self):
        await send_email(self.config, 'user@example.com', 'Сброс пароля',
                         'Ваша ссылка: https://example.com/reset?token=secret')
        self.smtp_factory.assert_called_once_with('smtp.example.com', 587, timeout=10)
        self.assertEqual([call[0] for call in self.smtp.method_calls],
                         ['starttls', 'login', 'send_message'])
        self.smtp.login.assert_called_once_with('mailer', 'password')
        message = self.smtp.send_message.call_args.args[0]
        self.assertEqual(message['To'], 'user@example.com')
        self.assertEqual(message['From'], 'no-reply@example.com')
        self.assertEqual(message['Subject'], 'Сброс пароля')
        self.assertIn('https://example.com/reset?token=secret', message.get_content())

    async def test_supports_local_server_without_tls_or_auth(self):
        self.config.starttls = False
        self.config.username = self.config.password = ''
        await send_email(self.config, 'user@example.com', 'Verify', 'Link')
        self.smtp.starttls.assert_not_called()
        self.smtp.login.assert_not_called()
        self.smtp.send_message.assert_called_once()

    async def test_rejects_missing_settings_before_connecting(self):
        for field in ('host', 'sender', 'username', 'password'):
            original = getattr(self.config, field)
            setattr(self.config, field, '')
            with self.subTest(field=field), self.assertRaises(ValueError):
                await send_email(self.config, 'user@example.com', 'Verify', 'Link')
            setattr(self.config, field, original)
        self.smtp_factory.assert_not_called()

    async def test_propagates_delivery_failure_and_closes_connection(self):
        self.smtp.send_message.side_effect = smtplib.SMTPException('Delivery failed')
        with self.assertRaises(smtplib.SMTPException):
            await send_email(self.config, 'user@example.com', 'Verify', 'Link')
        self.smtp_factory.return_value.__exit__.assert_called_once()

    async def test_does_not_send_if_tls_fails(self):
        self.smtp.starttls.side_effect = smtplib.SMTPNotSupportedError('No STARTTLS')
        with self.assertRaises(smtplib.SMTPNotSupportedError):
            await send_email(self.config, 'user@example.com', 'Verify', 'Link')
        self.smtp.login.assert_not_called()
        self.smtp.send_message.assert_not_called()

    async def test_does_not_send_if_authentication_fails(self):
        self.smtp.login.side_effect = smtplib.SMTPAuthenticationError(535, b'Failed')
        with self.assertRaises(smtplib.SMTPAuthenticationError):
            await send_email(self.config, 'user@example.com', 'Verify', 'Link')
        self.smtp.send_message.assert_not_called()

    async def test_smtp_runs_outside_event_loop_thread(self):
        main_thread = threading.get_ident()
        smtp_threads = []
        self.smtp.send_message.side_effect = lambda message: smtp_threads.append(
            threading.get_ident())
        await send_email(self.config, 'user@example.com', 'Verify', 'Link')
        self.assertEqual(len(smtp_threads), 1)
        self.assertNotEqual(smtp_threads[0], main_thread)


if __name__ == '__main__':
    unittest.main()
