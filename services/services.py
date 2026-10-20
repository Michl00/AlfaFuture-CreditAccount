import asyncio

import aiosqlite

from services.db import create_user
from services.security import hash_password


class ValidationError(ValueError):
    """Данные не прошли проверку."""


def valid_inn(inn: str) -> bool:
    if not (inn.isascii() and inn.isdigit() and len(inn) in (10, 12)):
        return False
    def ctrl(digits, coefs):
        return sum(int(d) * c for d, c in zip(digits, coefs)) % 11 % 10
    if len(inn) == 10:
        return ctrl(inn, [2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[9])
    return (ctrl(inn, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[10])
            and ctrl(inn, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[11]))


async def register_user(conn: aiosqlite.Connection, username: str, email: str,
                        password: str, inn: str) -> int:
    username, email, inn = username.strip(), email.strip(), inn.strip()

    if not 3 <= len(username) <= 20:
        raise ValidationError("username должен быть от 3 до 20 символов")
    if "@" not in email or len(email) > 254:
        raise ValidationError("некорректный email")
    if not 8 <= len(password) <= 128:
        raise ValidationError("пароль должен быть от 8 до 128 символов")
    if not valid_inn(inn):
        raise ValidationError("некорректный ИНН")

    # хеширование тяжёлое, уводим из event loop в отдельный поток
    password_hash = await asyncio.to_thread(hash_password, password)

    return await create_user(conn, username, email, password_hash, inn)