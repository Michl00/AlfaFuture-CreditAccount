from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Depends
from fastapi_users.db import SQLAlchemyBaseUserTable, SQLAlchemyUserDatabase
from sqlalchemy import CheckConstraint, Integer, String, event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from config.config import load_config

config = load_config()


class Base(DeclarativeBase):
    pass


class User(SQLAlchemyBaseUserTable[int], Base):
    # уже есть в базовом классе: email (unique), hashed_password,
    # is_active, is_superuser
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(20))
    inn: Mapped[str] = mapped_column(String(12))

    __table_args__ = (
        CheckConstraint("length(username) BETWEEN 3 AND 20", name="ck_username_len"),
        CheckConstraint(
            "inn NOT GLOB '*[^0-9]*' AND length(inn) IN (10, 12)", name="ck_inn"
        ),
    )


engine = create_async_engine(config.db.url, connect_args={"timeout": 10})
async_session_maker = async_sessionmaker(engine, expire_on_commit=False)


@event.listens_for(engine.sync_engine, "connect")
def _set_pragmas(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys = ON")
    cur.execute("PRAGMA journal_mode = WAL")
    cur.close()


async def create_db_and_tables() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session


async def get_user_db(
    session: Annotated[AsyncSession, Depends(get_async_session)],
):
    yield SQLAlchemyUserDatabase(session, User)