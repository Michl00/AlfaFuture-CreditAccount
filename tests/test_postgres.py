"""The same product contract against PostgreSQL, isolated per test via a schema."""

import asyncio
import os
import unittest
from uuid import uuid4

import httpx
import test_platform as platform_tests
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from main import app
from services.db import Base, get_async_session


@unittest.skipUnless(
    os.getenv("TEST_DATABASE_URL"),
    "Set TEST_DATABASE_URL for PostgreSQL contract checks",
)
class PostgreSQLTests(platform_tests.ProductTests):
    async def asyncSetUp(self):
        self.schema = "test_" + uuid4().hex
        self.admin = create_async_engine(os.environ["TEST_DATABASE_URL"])
        async with self.admin.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{self.schema}"'))
        self.engine = create_async_engine(
            os.environ["TEST_DATABASE_URL"],
            connect_args={"server_settings": {"search_path": self.schema}},
        )
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        maker = async_sessionmaker(self.engine, expire_on_commit=False)

        async def session():
            async with maker() as db:
                yield db

        app.dependency_overrides[get_async_session] = session
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        )

    async def asyncTearDown(self):
        await super().asyncTearDown()
        async with self.admin.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        await self.admin.dispose()

    async def test_simultaneous_submissions_revalidate_under_company_lock(self):
        await self.login()
        a = await self.assessment()
        body = {
            "assessment_id": a["assessment_id"],
            "data": platform_tests.DATA,
            "fingerprint": a["fingerprint"],
            "consent": True,
        }

        async def send(key):
            return await self.client.post(
                "/api/v1/applications", json=body, headers={"Idempotency-Key": key}
            )

        responses = await asyncio.gather(
            send("parallel-key-one"), send("parallel-key-two")
        )
        self.assertEqual(sorted(r.status_code for r in responses), [201, 409])
        self.assertEqual(
            len((await self.client.get("/api/v1/applications")).json()["items"]), 1
        )

    async def test_two_review_workers_claim_only_one_provider_call(self):
        from unittest.mock import AsyncMock, patch

        from services.platform.worker import process_review

        await self.login()
        run = (
            await self.client.post("/api/v1/assessments", json=platform_tests.DATA)
        ).json()
        await self.client.post(
            "/api/v1/assessments/" + run["assessment_id"] + "/review", json={}
        )

        async def answer(*args, **kwargs):
            await asyncio.sleep(0.05)
            return {
                "text": "Один результат",
                "mode": "llm",
                "model": "test",
                "questions": [],
            }

        sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        with patch(
            "services.platform.review.assistant",
            new_callable=AsyncMock,
            side_effect=answer,
        ) as model:
            outcomes = await asyncio.gather(
                process_review(run["assessment_id"], sessions),
                process_review(run["assessment_id"], sessions),
            )
        self.assertEqual(sorted(outcomes), [False, True])
        self.assertEqual(model.call_count, 1)
