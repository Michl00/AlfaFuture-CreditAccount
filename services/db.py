from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Depends
from fastapi_users.db import SQLAlchemyBaseUserTable, SQLAlchemyUserDatabase
from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, JSON, LargeBinary, MetaData, event, inspect
from sqlalchemy.schema import CreateTable, CreateIndex
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
    inn: Mapped[str | None] = mapped_column(String(12), nullable=True)

    __table_args__ = (
        CheckConstraint("length(username) BETWEEN 3 AND 20", name="ck_username_len"),
        CheckConstraint(
            "inn NOT GLOB '*[^0-9]*' AND length(inn) IN (10, 12)", name="ck_inn"
        ),
    )


class BankStaff(Base):
    __tablename__ = 'bank_staff'
    user_id: Mapped[int] = mapped_column(ForeignKey('user.id'), primary_key=True)


class UploadedDocument(Base):
    __tablename__ = 'uploaded_documents'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('user.id'), index=True)
    filename: Mapped[str] = mapped_column(String(180))
    content: Mapped[bytes] = mapped_column(LargeBinary)
    fields: Mapped[dict] = mapped_column(JSON)
    warnings: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(Integer)


class CreditAssessment(Base):
    __tablename__ = 'credit_assessments'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('user.id'), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(Integer)


class CreditApplication(Base):
    __tablename__ = 'credit_applications'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    assessment_id: Mapped[str] = mapped_column(ForeignKey('credit_assessments.id'), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('user.id'), index=True)
    status: Mapped[str] = mapped_column(String(24), index=True)
    assigned_to: Mapped[int | None] = mapped_column(ForeignKey('user.id'), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    payload: Mapped[dict] = mapped_column(JSON)
    checks: Mapped[dict] = mapped_column(JSON)
    score: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[int] = mapped_column(Integer)


class ApplicationEvent(Base):
    __tablename__ = 'application_events'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    application_id: Mapped[str] = mapped_column(ForeignKey('credit_applications.id'), index=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey('user.id'))
    action: Mapped[str] = mapped_column(String(32))
    comment: Mapped[str] = mapped_column(String(2000))
    created_at: Mapped[int] = mapped_column(Integer)


engine = create_async_engine(config.db.url, connect_args={"timeout": 10})
async_session_maker = async_sessionmaker(engine, expire_on_commit=False)


@event.listens_for(engine.sync_engine, "connect")
def _set_pragmas(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys = ON")
    cur.execute("PRAGMA journal_mode = WAL")
    cur.close()


async def create_db_and_tables() -> None:
    await migrate_optional_inn(engine)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def migrate_optional_inn(db_engine) -> None:
    """Rebuild the legacy SQLite user table without losing accounts or references."""
    async with db_engine.connect() as conn:
        columns = await conn.run_sync(lambda sync: inspect(sync).get_columns('user')
            if inspect(sync).has_table('user') else [])
        if not any(column['name'] == 'inn' and not column['nullable'] for column in columns):
            return
        await conn.commit()
        # SQLite requires foreign keys to be disabled outside the transaction
        # while replacing a table referenced by applications and documents.
        await conn.exec_driver_sql('PRAGMA foreign_keys = OFF')
        await conn.commit()
        try:
            await conn.exec_driver_sql('BEGIN IMMEDIATE')
            replacement = User.__table__.to_metadata(MetaData(), name='user_optional_inn')
            await conn.execute(CreateTable(replacement))
            names = ', '.join(conn.dialect.identifier_preparer.quote(column.name) for column in User.__table__.columns)
            await conn.exec_driver_sql(f'INSERT INTO user_optional_inn ({names}) SELECT {names} FROM user')
            await conn.exec_driver_sql('DROP TABLE user')
            await conn.exec_driver_sql('ALTER TABLE user_optional_inn RENAME TO user')
            for index in User.__table__.indexes:
                await conn.execute(CreateIndex(index))
            if (await conn.exec_driver_sql('PRAGMA foreign_key_check')).first():
                raise RuntimeError('User migration failed foreign key validation')
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise
        finally:
            await conn.exec_driver_sql('PRAGMA foreign_keys = ON')
            await conn.commit()


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session


async def get_user_db(
    session: Annotated[AsyncSession, Depends(get_async_session)],
):
    yield SQLAlchemyUserDatabase(session, User)
