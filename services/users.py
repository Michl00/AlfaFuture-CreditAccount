import logging
from typing import Annotated

from fastapi import Depends, Request
from fastapi_users import BaseUserManager, FastAPIUsers, IntegerIDMixin
from fastapi_users.authentication import (
    AuthenticationBackend,
    CookieTransport,
    JWTStrategy,
)
from fastapi_users.db import SQLAlchemyUserDatabase
from fastapi_users.exceptions import InvalidPasswordException

from config.config import load_config
from services.db import User, get_user_db
from services.mail import build_token_url, send_email

config = load_config()
logger = logging.getLogger(__name__)


class UserManager(IntegerIDMixin, BaseUserManager[User, int]):
    reset_password_token_secret = config.auth.secret

    async def validate_password(self, password: str, user) -> None:
        if not 8 <= len(password) <= 128:
            raise InvalidPasswordException("Пароль: от 8 до 128 символов")

    async def on_after_register(self, user: User, request: Request | None = None):
        logger.info("user registered: id=%s", user.id)

    async def on_after_forgot_password(self, user: User, token: str,
                                       request: Request | None = None):
        link = build_token_url(config.mail.reset_password_url, token)
        await send_email(
            config.mail, user.email, "Сброс пароля",
            f"Для сброса пароля перейдите по ссылке:\n{link}\n\n"
            "Если вы не запрашивали сброс пароля, проигнорируйте это письмо.",
        )
        logger.info("password reset requested: id=%s", user.id)


async def get_user_manager(
    user_db: Annotated[SQLAlchemyUserDatabase, Depends(get_user_db)],
):
    yield UserManager(user_db)


cookie_transport = CookieTransport(
    cookie_max_age=3600,
    cookie_secure=config.auth.cookie_secure,
    cookie_httponly=True,
    cookie_samesite="lax",
)


def get_jwt_strategy() -> JWTStrategy:
    return JWTStrategy(secret=config.auth.secret, lifetime_seconds=3600)


auth_backend = AuthenticationBackend(
    name="jwt-cookie",
    transport=cookie_transport,
    get_strategy=get_jwt_strategy,
)

fastapi_users = FastAPIUsers[User, int](get_user_manager, [auth_backend])

current_active_user = fastapi_users.current_user(active=True)
