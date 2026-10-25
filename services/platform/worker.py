"""Durable AI-review worker. SQL leases allow restart and multiple workers."""

import asyncio
import logging
import time

from sqlalchemy import and_, or_, select, update

from . import review
from .models import AssessmentRun

logger = logging.getLogger(__name__)
LEASE_SECONDS = 120


async def process_review(id, session_factory):
    now = int(time.time())
    async with session_factory() as db:
        row = await db.get(AssessmentRun, id)
        if not row or row.expires_at < now or row.state not in ("queued", "running"):
            return False
        if row.state == "running" and row.started_at + LEASE_SECONDS > now:
            return False
        lease = await db.execute(
            update(AssessmentRun)
            .where(
                AssessmentRun.id == id,
                AssessmentRun.state == row.state,
                AssessmentRun.started_at == row.started_at,
            )
            .values(state="running", started_at=now)
        )
        if lease.rowcount != 1:
            return False
        data, result = row.payload, row.result
        await db.commit()
    # No database connection/transaction is held while the proxy generates.
    try:
        answer = await review.review(data, result)
    except Exception as error:  # noqa: BLE001 - durable worker boundary records failures
        logger.error(
            "AI review failed assessment=%s category=%s", id, type(error).__name__
        )
        from .adapters import RulesAssistant

        with_rules = await RulesAssistant().answer(
            [{"role": "user", "content": "Объясни результат"}], result
        )
        answer = {
            **with_rules,
            "facts_hash": review.digest(result),
            "policy_version": result["policy_version"],
            "catalog_version": result["catalog_version"],
            "findings": [],
            "recommendation": "manual_review",
            "schema_version": "review-v1",
        }
    state = "done" if answer["mode"] == "llm" else "unavailable"
    async with session_factory() as db:
        changed = await db.execute(
            update(AssessmentRun)
            .where(
                AssessmentRun.id == id,
                AssessmentRun.state == "running",
                AssessmentRun.started_at == now,
            )
            .values(state=state, ai_review=answer)
        )
        await db.commit()
        return changed.rowcount == 1


async def worker_loop(session_factory, interval=1):
    while True:
        try:
            now = int(time.time())
            async with session_factory() as db:
                id = await db.scalar(
                    select(AssessmentRun.id)
                    .where(
                        AssessmentRun.expires_at > now,
                        or_(
                            AssessmentRun.state == "queued",
                            and_(
                                AssessmentRun.state == "running",
                                AssessmentRun.started_at < now - LEASE_SECONDS,
                            ),
                        ),
                    )
                    .order_by(AssessmentRun.expires_at)
                    .limit(1)
                )
            if id:
                await process_review(id, session_factory)
            else:
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - durable worker boundary records failures
            logger.error(
                "Review worker iteration failed category=%s", type(error).__name__
            )
            await asyncio.sleep(interval)


if __name__ == "__main__":
    from services.db import async_session_maker

    logging.basicConfig(level=logging.INFO)
    asyncio.run(worker_loop(async_session_maker))
