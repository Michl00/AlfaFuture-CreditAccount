"""Assign employee access to an existing account from the server console."""
import argparse
import asyncio

from sqlalchemy import select

from services.db import BankStaff, User, async_session_maker, create_db_and_tables, engine


async def set_staff(email: str, *, revoke: bool = False):
    await create_db_and_tables()
    async with async_session_maker() as session:
        user = await session.scalar(select(User).where(User.email == email))
        if user is None:
            raise ValueError('Аккаунт не найден. Сначала зарегистрируйте пользователя через интерфейс.')
        role = await session.get(BankStaff, user.id)
        if revoke and role is not None:
            await session.delete(role)
        elif not revoke and role is None:
            session.add(BankStaff(user_id=user.id))
        await session.commit()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['grant-staff', 'revoke-staff'])
    parser.add_argument('--email', required=True)
    args = parser.parse_args()
    try:
        await set_staff(args.email, revoke=args.action == 'revoke-staff')
    except ValueError as error:
        parser.exit(1, f'{error}\n')
    finally:
        await engine.dispose()
    print('Доступ сотрудника отозван.' if args.action == 'revoke-staff' else 'Доступ сотрудника выдан.')


if __name__ == '__main__':
    asyncio.run(main())
