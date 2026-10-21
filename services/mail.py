import asyncio
import smtplib
import ssl
from email.message import EmailMessage
from typing import TYPE_CHECKING
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

if TYPE_CHECKING:
    from config.config import MailConfig


def build_token_url(base_url: str, token: str) -> str:
    parts = urlsplit(base_url)
    if parts.scheme not in ('http', 'https') or not parts.netloc:
        raise ValueError('Email link URL must be an absolute HTTP(S) URL')
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
             if key != 'token']
    query.append(('token', token))
    return urlunsplit(parts._replace(query=urlencode(query)))


def _send_email(config: 'MailConfig', recipient: str, subject: str, body: str) -> None:
    if not config.host or not config.sender:
        raise ValueError('SMTP_HOST and SMTP_FROM must be configured to send email')
    if bool(config.username) != bool(config.password):
        raise ValueError('SMTP_USERNAME and SMTP_PASSWORD must be configured together')

    message = EmailMessage()
    message['From'] = config.sender
    message['To'] = recipient
    message['Subject'] = subject
    message.set_content(body)

    with smtplib.SMTP(config.host, config.port, timeout=10) as smtp:
        if config.starttls:
            smtp.starttls(context=ssl.create_default_context())
        if config.username:
            smtp.login(config.username, config.password)
        smtp.send_message(message)


async def send_email(config: 'MailConfig', recipient: str, subject: str, body: str) -> None:
    await asyncio.to_thread(_send_email, config, recipient, subject, body)
