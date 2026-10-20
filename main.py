import asyncio
import logging

import aiosqlite

from config.config import Config, load_config

config: Config = load_config()

logging.basicConfig(
    format = config.log.format,
    level = config.log.level,
    filemode='w',
    filename=config.log.file,
)
logger = logging.getLogger(__name__)

async def main():
    async with aiosqlite.connect('app.db', timeout=10) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute('PRAGMA foreign_keys = ON')
        await conn.execute('PRAGMA journal_mode = WAL')


        await conn.execute(config.db.table)
        await conn.commit()
        logger.info('db connected succesfully')

if __name__=='__main__':
    asyncio.run(main())
