import asyncio
import logging

import aiosqlite

from config.config import Config, load_config
from services.db import UserExistsError
from services.services import ValidationError, register_user

config: Config = load_config()

logging.basicConfig(
    format = config.log.format,
    level = config.log.level,
    filemode='a',
    filename=config.log.file,
)
logger = logging.getLogger(__name__)

async def main():
    async with aiosqlite.connect(config.db.path, timeout=10) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute('PRAGMA foreign_keys = ON')
        await conn.execute('PRAGMA journal_mode = WAL')


        await conn.execute(config.db.table)
        await conn.commit()
        logger.info('db connected succesfully')

        # Тестовая регистрация пользователя
        try:
            user_id = await register_user(
                conn, "alice", "alice@example.com", "strongpass123", "7707083893"
            )
            logger.info("user created: id=%s", user_id)
        except ValidationError as e:
            logger.warning("validation failed: %s", e)
        except UserExistsError as e:
            logger.warning("registration failed: %s", e)

if __name__=='__main__':
    asyncio.run(main())
