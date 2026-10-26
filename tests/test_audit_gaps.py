"""Regression checks for gaps found against the user's product brief."""

import unittest
from unittest.mock import AsyncMock, patch

import httpx
import test_platform as base_tests
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker

from services.platform import review
from services.platform.engine import evaluate
from services.platform.models import AssessmentRun
from services.platform.worker import process_review

DATA = base_tests.DATA


class ProjectionAndAlternativeTests(unittest.TestCase):
    def test_delayed_seasonal_revenue_shifts_every_receipt(self):
        data = {
            **DATA,
            "scenario": "seasonal",
            "delay_months": 1,
            "stress_drop": 0,
            "months": 6,
        }
        result = evaluate(data)
        rows = result["stress"]["rows"]
        self.assertEqual(rows[0]["revenue"], 0)
        self.assertEqual(rows[1]["revenue"], data["revenue"])
        self.assertEqual(rows[4]["revenue"], 825000)
        self.assertEqual(result["stress"]["receivables_after_horizon"], data["revenue"])
        self.assertGreater(
            result["without_financing"]["rows"][-1]["balance"],
            result["base"]["rows"][-1]["balance"],
        )

    def test_equipment_compares_real_product_rates_and_advance(self):
        result = evaluate({**DATA, "product": "equipment"})
        lease = next(a for a in result["alternatives"] if a["product"] == "leasing")
        self.assertTrue(lease["same_budget"])
        self.assertLess(lease["rate"], result["terms"]["rate"])
        self.assertLess(lease["cost"], result["plan"]["cost"])
        self.assertIn("аванс", lease["reason"])

    def test_inactive_registry_cannot_get_a_green_alternative(self):
        result = evaluate({**DATA, "scenario": "inactive"})
        self.assertTrue(result["alternatives"])
        self.assertTrue(all(not a["feasible"] for a in result["alternatives"]))

    def test_independent_factors_combine_and_document_values_are_inspectable(self):
        result = evaluate({**DATA, "test_factors": ["overdue", "tax", "conflict"]})
        codes = {r["code"] for r in result["rules"]}
        self.assertTrue({"BUREAU_OVERDUE", "TAX_DEBT", "DOCUMENT_CONFLICT"} <= codes)
        self.assertEqual(result["conflicts"][0]["field"], "revenue")
        self.assertEqual(
            result["documents"][0]["content"]["fields"]["revenue"],
            DATA["revenue"] * 0.8,
        )
        self.assertEqual(len(result["documents"][0]["id"]), 64)

    def test_unknown_bureau_is_not_a_scored_clean_result(self):
        result = evaluate({**DATA, "scenario": "unavailable"})
        self.assertIsNone(result["score"])
        self.assertEqual(result["status"], "technical_hold")

    def test_short_guarantee_models_call_even_on_one_month_horizon(self):
        result = evaluate(
            {**DATA, "product": "guarantee", "months": 6, "cash": 0, "stress_drop": 80}
        )
        self.assertEqual(
            sum(r["guarantee_call"] for r in result["stress"]["rows"]), DATA["amount"]
        )


class BoundReviewTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = base_tests.ProductTests.asyncSetUp
    asyncTearDown = base_tests.ProductTests.asyncTearDown
    login = base_tests.ProductTests.login
    assessment = base_tests.ProductTests.assessment
    submit = base_tests.ProductTests.submit
    action = base_tests.ProductTests.action

    async def test_one_click_document_endpoint_materializes_a_synthetic_package(self):
        await self.login()
        result = await self.client.post(
            "/api/v1/documents/preview",
            json={**DATA, "product": "equipment", "test_factors": ["conflict"]},
        )
        self.assertEqual(result.status_code, 200, result.text)
        documents = result.json()["documents"]
        self.assertEqual({d["type"] for d in documents}, {"financials", "invoice"})
        self.assertTrue(all(d["mock"] and len(d["id"]) == 64 for d in documents))
        report = next(d for d in documents if d["type"] == "financials")
        self.assertEqual(report["content"]["fields"]["revenue"], 1200000)

    async def test_crashed_review_lease_is_recovered(self):
        import time

        await self.login()
        a = (await self.client.post("/api/v1/assessments", json=DATA)).json()
        sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with sessions() as db:
            await db.execute(
                update(AssessmentRun)
                .where(AssessmentRun.id == a["assessment_id"])
                .values(state="running", started_at=int(time.time()) - 121)
            )
            await db.commit()
        with patch(
            "services.platform.review.assistant",
            new_callable=AsyncMock,
            return_value={
                "text": "Восстановленное заключение",
                "mode": "llm",
                "model": "test",
                "questions": [],
            },
        ):
            self.assertTrue(await process_review(a["assessment_id"], sessions))
        current = (
            await self.client.get("/api/v1/assessments/" + a["assessment_id"])
        ).json()
        self.assertEqual(current["review_state"], "done")

    async def test_feed_is_personal_and_search_precedes_pagination(self):
        await self.login()
        first, _ = await self.submit(
            {**DATA, "scenario": "overdue", "goal": "Редкий поиск ранней заявки"},
            key="search-first-case",
        )
        await self.submit(
            {**DATA, "scenario": "overdue", "goal": "Другая новая заявка"},
            key="search-second-case",
        )
        found = (await self.client.get("/api/v1/applications?q=Редкий&limit=1")).json()
        self.assertEqual(found["total"], 1)
        self.assertEqual(found["items"][0]["id"], first["id"])
        self.assertTrue((await self.client.get("/api/v1/feed")).json()["items"])
        await self.login("ip")
        self.assertEqual((await self.client.get("/api/v1/feed")).json()["items"], [])

    async def test_review_must_complete_before_submission(self):
        await self.login()
        a = (await self.client.post("/api/v1/assessments", json=DATA)).json()
        r = await self.client.post(
            "/api/v1/applications",
            headers={"Idempotency-Key": "review-not-done"},
            json={
                "assessment_id": a["assessment_id"],
                "data": DATA,
                "fingerprint": a["fingerprint"],
                "consent": True,
            },
        )
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], "AI_REVIEW_REQUIRED")

    async def test_review_cannot_be_reused_with_other_inputs(self):
        await self.login()
        a = await self.assessment()
        r = await self.client.post(
            "/api/v1/applications",
            headers={"Idempotency-Key": "review-wrong-inputs"},
            json={
                "assessment_id": a["assessment_id"],
                "data": {**DATA, "amount": 1000000},
                "fingerprint": a["fingerprint"],
                "consent": True,
            },
        )
        self.assertEqual(r.status_code, 409)

    async def test_review_is_private_and_cached(self):
        await self.login()
        a = await self.assessment()
        with patch(
            "services.platform.review.assistant", new_callable=AsyncMock
        ) as model:
            r = await self.client.post(
                "/api/v1/assessments/" + a["assessment_id"] + "/review", json={}
            )
            self.assertEqual(r.status_code, 200)
            model.assert_not_called()
        await self.login("ip")
        self.assertEqual(
            (
                await self.client.get("/api/v1/assessments/" + a["assessment_id"])
            ).status_code,
            404,
        )

    async def test_proxy_failure_still_has_explicit_bound_rules_review(self):
        await self.login()
        a = (await self.client.post("/api/v1/assessments", json=DATA)).json()
        with patch(
            "services.platform.adapters.ConfiguredAssistant.answer",
            new_callable=AsyncMock,
            side_effect=httpx.ConnectError("offline"),
        ):
            r = await self.client.post(
                "/api/v1/assessments/" + a["assessment_id"] + "/review", json={}
            )
            self.assertEqual(r.status_code, 202, r.text)
            await process_review(
                a["assessment_id"],
                async_sessionmaker(self.engine, expire_on_commit=False),
            )
        r = await self.client.get("/api/v1/assessments/" + a["assessment_id"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["review_state"], "unavailable")
        self.assertEqual(r.json()["ai_review"]["mode"], "rules")
        self.assertIn("недоступен", r.json()["ai_review"]["text"])

    async def test_chat_proposal_becomes_server_draft_for_this_company(self):
        await self.login("ip")
        answer = {
            "text": "Предлагаю кредит на оборудование",
            "questions": [],
            "mode": "llm",
            "model": "test",
            "proposal": {
                "product": "equipment",
                "amount": 800000,
                "months": 36,
                "goal": "Станок для мастерской",
            },
        }
        with patch(
            "services.platform.api.assistant",
            new_callable=AsyncMock,
            return_value=answer,
        ):
            turn = (
                await self.client.post(
                    "/api/v1/chat", json={"message": "Нужен станок за 800 тысяч"}
                )
            ).json()
        used = await self.client.post(
            "/api/v1/chat/" + turn["turn_id"] + "/draft", json={}
        )
        self.assertEqual(used.status_code, 200, used.text)
        saved = (await self.client.get("/api/v1/draft")).json()
        self.assertEqual(
            (saved["inn"], saved["amount"], saved["months"], saved["goal"]),
            ("500100732259", 800000, 36, "Станок для мастерской"),
        )
        self.assertFalse(saved["documents_attached"])
        await self.login("ooo")
        self.assertEqual(
            (
                await self.client.post(
                    "/api/v1/chat/" + turn["turn_id"] + "/draft", json={}
                )
            ).status_code,
            404,
        )

    async def test_disbursement_needs_successful_contract_and_retries_are_versioned(
        self,
    ):
        await self.login()
        row, _ = await self.submit()
        await self.login("bank")
        self.assertEqual((await self.action(row, "pay")).status_code, 409)
        failed = (await self.action(row, "sign", simulate_failure=True)).json()
        self.assertFalse(failed["assessment"]["contract"]["success"])
        self.assertEqual((await self.action(failed, "pay")).status_code, 409)
        signed = (await self.action(failed, "sign")).json()
        self.assertTrue(signed["assessment"]["contract"]["success"])
        self.assertEqual((await self.action(signed, "sign")).status_code, 409)
        paid = (await self.action(signed, "pay")).json()
        self.assertEqual(paid["status"], "funded")

    async def test_model_findings_require_known_fact_references(self):
        result = evaluate(DATA)
        model = {
            "text": "Модель объяснила результат",
            "mode": "llm",
            "model": "test",
            "questions": [],
            "review": {
                "recommendation": "approve",
                "findings": [
                    {"text": "Выдуманная причина", "references": ["MADE_UP"]},
                    {
                        "text": "Платёж сопоставлен с выручкой",
                        "references": ["FINANCIALS"],
                        "severity": "info",
                    },
                ],
            },
        }
        with patch(
            "services.platform.review.assistant",
            new_callable=AsyncMock,
            return_value=model,
        ):
            answer = await review.review(DATA, result)
        self.assertEqual(len(answer["findings"]), 1)
        self.assertEqual(answer["findings"][0]["references"], ["FINANCIALS"])

    async def test_numeric_hallucination_is_not_published_as_a_financial_fact(self):
        result = evaluate(DATA)
        model = {
            "text": "Новый платёж составляет 999999 рублей",
            "mode": "llm",
            "model": "test",
            "questions": [],
            "review": {
                "recommendation": "approve",
                "findings": [
                    {"text": "Выдуманный платёж 999999", "references": ["TERMS"]}
                ],
            },
        }
        with patch(
            "services.platform.review.assistant",
            new_callable=AsyncMock,
            return_value=model,
        ):
            response = await review.review(DATA, result)
        self.assertNotIn("999999", response["text"])
        self.assertNotIn("999999", response["findings"][0]["text"])
        self.assertFalse(response["narrative_validated"])
        self.assertEqual(response["text_origin"], "server_grounded")

    async def test_ai_concern_can_escalate_but_never_override_a_hard_stop(self):
        from services.platform.review import apply_review

        clean = evaluate(DATA)
        escalated = apply_review(
            clean, {"mode": "llm", "recommendation": "decline"}, "test-id"
        )
        self.assertEqual(escalated["status"], "in_review")
        blocked = evaluate({**DATA, "scenario": "inactive"})
        self.assertEqual(
            apply_review(
                blocked, {"mode": "llm", "recommendation": "approve"}, "test-id"
            )["status"],
            "rejected",
        )
