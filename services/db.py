import sqlite3

import aiosqlite


class UserExistsError(Exception):
    """username или email уже заняты."""


async def create_user(conn: aiosqlite.Connection, username: str, email: str,
                      password_hash: str, inn: str) -> int:
    try:
        cur = await conn.execute(
            "INSERT INTO users (username, email, password_hash, inn) "
            "VALUES (?, ?, ?, ?)",
            (username, email, password_hash, inn),
        )
        await conn.commit()
        if cur.lastrowid is None:
            raise RuntimeError("INSERT не вернул id")
        return cur.lastrowid
    except sqlite3.IntegrityError as e:
        await conn.rollback()
        msg = str(e)
        if "users.username" in msg:
            raise UserExistsError("username уже занят") from e
        if "users.email" in msg:
            raise UserExistsError("email уже зарегистрирован") from e
        raise   # другое нарушение (например, CHECK) не скрываем


async def get_user_by_email(conn: aiosqlite.Connection, email: str):
    cur = await conn.execute("SELECT * FROM users WHERE email = ?", (email,))
    return await cur.fetchone()