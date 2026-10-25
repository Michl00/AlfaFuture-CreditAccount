import asyncio
from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine
from config.config import load_config
from services.db import Base
from services.platform import models  # register all product tables

config = context.config
target_metadata = Base.metadata

def configure(connection):
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction(): context.run_migrations()

async def online():
    engine = create_async_engine(load_config().db.url)
    async with engine.connect() as connection: await connection.run_sync(configure)
    await engine.dispose()

if context.is_offline_mode():
    context.configure(url=load_config().db.url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction(): context.run_migrations()
else: asyncio.run(online())
