import unittest

from sqlalchemy import MetaData, select
from sqlalchemy.ext.asyncio import create_async_engine

import test_demo  # Configure test settings before loading the application.
from services.db import Base, User, BankStaff, migrate_optional_inn


class UserMigrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_accounts_references_and_unique_email_survive_migration(self):
        engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        try:
            legacy = MetaData()
            for table in Base.metadata.sorted_tables:
                table.to_metadata(legacy)
            legacy.tables['user'].c.inn.nullable = False
            async with engine.begin() as conn:
                await conn.run_sync(legacy.create_all)
                await conn.execute(legacy.tables['user'].insert().values(id=1,
                    username='existing', email='existing@example.com', hashed_password='preserved-hash',
                    inn='7701234560', is_active=True, is_superuser=False, is_verified=False))
                await conn.execute(BankStaff.__table__.insert().values(user_id=1))
            await migrate_optional_inn(engine)
            await migrate_optional_inn(engine)  # Startup must be repeatable.
            async with engine.begin() as conn:
                old = (await conn.execute(select(User.__table__))).mappings().one()
                self.assertEqual(old['hashed_password'], 'preserved-hash')
                self.assertEqual(old['inn'], '7701234560')
                self.assertEqual((await conn.execute(select(BankStaff.user_id))).scalar_one(), 1)
                await conn.execute(User.__table__.insert().values(id=2, username='new',
                    email='new@example.com', hashed_password='new-hash', inn=None))
                self.assertEqual((await conn.exec_driver_sql('PRAGMA foreign_keys')).scalar_one(), 1)
                self.assertEqual((await conn.exec_driver_sql('PRAGMA foreign_key_check')).all(), [])
                self.assertEqual((await conn.execute(select(User.inn).where(User.id == 2))).scalar_one(), None)
                indexes = (await conn.exec_driver_sql('PRAGMA index_list(user)')).all()
                self.assertTrue(any(index[2] for index in indexes))
        finally:
            await engine.dispose()
