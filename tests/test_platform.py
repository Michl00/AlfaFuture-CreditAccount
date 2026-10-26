import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
import test_demo
from sqlalchemy.ext.asyncio import async_sessionmaker

from services.platform.api import Input
from services.platform.engine import evaluate, schedule
from services.platform.worker import process_review

DATA = Input(documents_attached=True).model_dump()


class PolicyTests(unittest.TestCase):
    def test_clean_and_each_source_scenario(self):
        expected = {
            "clean": "approved",
            "overdue": "in_review",
            "tax": "in_review",
            "inactive": "rejected",
            "conflict": "in_review",
            "unavailable": "technical_hold",
            "heavy_debt": "rejected",
        }
        for scenario, status in expected.items():
            with self.subTest(scenario=scenario):
                self.assertEqual(
                    evaluate({**DATA, "scenario": scenario})["status"], status
                )

    def test_product_strategies_and_loan_cost(self):
        for product in (
            "working",
            "equipment",
            "investment",
            "line",
            "refinance",
            "mortgage",
            "leasing",
        ):
            plan = schedule(product, 1500000, 24, 24)
            self.assertEqual(len(plan["payments"]), 24)
            self.assertAlmostEqual(
                sum(plan["payments"]) + plan["advance"], plan["total"], places=2
            )
            self.assertAlmostEqual(plan["total"] - 1500000, plan["cost"], places=2)
        bullet = schedule("overdraft", 1000000, 6, 24)
        self.assertEqual(bullet["payments"][-1], 1020000)
        guarantee = schedule("guarantee", 1000000, 12, 4.5)
        self.assertEqual(guarantee["funding"], 0)
        self.assertEqual(guarantee["exposure"], 1000000)
        self.assertEqual(guarantee["cost"], 45000)

    def test_document_requirement_and_portfolio_accounting(self):
        self.assertEqual(
            evaluate({**DATA, "documents_attached": False})["status"], "needs_info"
        )
        first = evaluate(DATA)
        existing = [
            {"payment": first["plan"]["payment"], "exposure": first["plan"]["exposure"]}
        ] * 3
        second = evaluate(DATA, existing)
        self.assertEqual(second["status"], "rejected")
        self.assertGreater(second["portfolio"]["payment"], 0)

    def test_stress_and_alternatives_are_reproducible(self):
        data = {**DATA, "scenario": "seasonal", "cash": 100000, "delay_months": 1}
        a = evaluate(data)
        self.assertEqual(a, evaluate(data))
        self.assertIsNotNone(a["stress"]["deficit_month"])
        self.assertGreater(len(a["alternatives"]), 0)


class ProductTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_demo.DemoTests.asyncSetUp
    asyncTearDown = test_demo.DemoTests.asyncTearDown

    async def login(self, profile="ooo", client=None):
        client = client or self.client
        with patch.dict(os.environ, {"DEMO_MODE": "true"}):
            r = await client.post("/api/v1/demo/login", json={"profile": profile})
        self.assertEqual(r.status_code, 200, r.text)
        client.headers["X-CSRF-Token"] = r.json()["csrf"]
        return r.json()

    async def assessment(self, data=None):
        r = await self.client.post("/api/v1/assessments", json=data or DATA)
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json()
        queued = await self.client.post(
            "/api/v1/assessments/" + result["assessment_id"] + "/review", json={}
        )
        self.assertEqual(queued.status_code, 202, queued.text)
        with patch(
            "services.platform.review.assistant",
            new_callable=AsyncMock,
            return_value={
                "text": "Заключение по синтетическим данным",
                "mode": "llm",
                "model": "test-open-weight",
                "provider": "test",
                "questions": [],
            },
        ):
            await process_review(
                result["assessment_id"],
                async_sessionmaker(self.engine, expire_on_commit=False),
            )
        completed = await self.client.get(
            "/api/v1/assessments/" + result["assessment_id"]
        )
        self.assertEqual(completed.json()["review_state"], "done", completed.text)
        return {**result, **completed.json()}

    async def submit(self, data=None, key="test-request-key"):
        data = data or DATA
        a = await self.assessment(data)
        r = await self.client.post(
            "/api/v1/applications",
            json={
                "assessment_id": a["assessment_id"],
                "data": data,
                "fingerprint": a["fingerprint"],
                "consent": True,
            },
            headers={"Idempotency-Key": key},
        )
        self.assertEqual(r.status_code, 201, r.text)
        return r.json(), a

    async def action(self, row, action, **extra):
        return await self.client.post(
            "/api/v1/applications/" + row["id"] + "/actions",
            json={
                "version": row["version"],
                "action": action,
                "comment": "Сотрудник проверил основания решения",
                **extra,
            },
        )

    async def test_demo_guard_csrf_logout_and_role(self):
        with patch.dict(os.environ, {"DEMO_MODE": "false"}):
            self.assertEqual(
                (
                    await self.client.post(
                        "/api/v1/demo/login", json={"profile": "bank"}
                    )
                ).status_code,
                404,
            )
        await self.login()
        self.client.headers.pop("X-CSRF-Token")
        self.assertEqual(
            (await self.client.post("/api/v1/assessments", json=DATA)).status_code, 403
        )
        await self.login()
        row, _ = await self.submit()
        self.assertEqual((await self.action(row, "settle")).status_code, 403)
        self.assertEqual((await self.client.post("/api/v1/logout")).status_code, 200)
        self.assertEqual((await self.client.get("/api/v1/me")).status_code, 401)

    async def test_idempotency_and_stale_portfolio(self):
        await self.login()
        initial = await self.assessment()
        body = {
            "assessment_id": initial["assessment_id"],
            "data": DATA,
            "fingerprint": initial["fingerprint"],
            "consent": True,
        }
        r = await self.client.post(
            "/api/v1/applications",
            json=body,
            headers={"Idempotency-Key": "idempotency-test"},
        )
        self.assertEqual(r.status_code, 201, r.text)
        repeat = await self.client.post(
            "/api/v1/applications",
            json=body,
            headers={"Idempotency-Key": "idempotency-test"},
        )
        self.assertEqual(repeat.json()["id"], r.json()["id"])
        stale = await self.client.post(
            "/api/v1/applications",
            json=body,
            headers={"Idempotency-Key": "different-request"},
        )
        self.assertEqual(stale.status_code, 409)
        altered = {**body, "data": {**DATA, "amount": 1000000}}
        self.assertEqual(
            (
                await self.client.post(
                    "/api/v1/applications",
                    json=altered,
                    headers={"Idempotency-Key": "idempotency-test"},
                )
            ).status_code,
            409,
        )

    async def test_ownership_and_ip_profile(self):
        await self.login()
        row, _ = await self.submit()
        await self.login("ip")
        self.assertEqual(
            (await self.client.get("/api/v1/applications/" + row["id"])).status_code,
            404,
        )
        bad = await self.client.post("/api/v1/assessments", json=DATA)
        self.assertEqual(bad.status_code, 422)
        ip = {**DATA, "inn": "500100732259"}
        self.assertEqual(
            (await self.client.post("/api/v1/assessments", json=ip)).status_code, 200
        )

    async def test_payment_failure_success_and_settlement_release(self):
        await self.login()
        row, _ = await self.submit()
        await self.login("bank")
        signed = await self.action(row, "sign")
        self.assertEqual(signed.status_code, 200, signed.text)
        row = signed.json()
        fail = await self.action(row, "pay", simulate_failure=True)
        self.assertEqual(fail.json()["status"], "approved", fail.text)
        self.assertFalse(fail.json()["assessment"]["disbursement"]["success"])
        stale = await self.action(row, "pay")
        self.assertEqual(stale.status_code, 409)
        paid = (await self.action(fail.json(), "pay")).json()
        self.assertEqual(paid["status"], "funded")
        self.assertEqual((await self.action(paid, "pay")).status_code, 409)
        settled = (await self.action(paid, "settle")).json()
        self.assertEqual(settled["status"], "settled")
        await self.login()
        self.assertEqual((await self.assessment())["portfolio"]["count"], 0)

    async def test_hard_stop_cannot_be_overridden(self):
        await self.login()
        row, _ = await self.submit({**DATA, "scenario": "inactive"})
        self.assertEqual(row["status"], "rejected")
        await self.login("bank")
        self.assertEqual((await self.action(row, "approve")).status_code, 409)

    async def test_alternative_offer_exact_consent(self):
        await self.login()
        row, _ = await self.submit({**DATA, "scenario": "overdue"})
        await self.login("bank")
        offered = await self.action(row, "offer", amount=1000000, months=36)
        self.assertEqual(offered.status_code, 200, offered.text)
        row = offered.json()
        self.assertEqual(row["status"], "offer_pending")
        await self.login()
        r = await self.client.post(
            "/api/v1/applications/" + row["id"] + "/reply",
            json={
                "version": row["version"],
                "comment": "Подтверждаю условия предложения",
                "accept_offer": True,
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "approved")
        self.assertEqual(r.json()["data"]["amount"], 1000000)

    async def test_clarification_creates_new_revision(self):
        await self.login()
        row, _ = await self.submit({**DATA, "documents_attached": False})
        self.assertEqual(row["status"], "needs_info")
        new_assessment = await self.assessment(DATA)
        r = await self.client.post(
            "/api/v1/applications/" + row["id"] + "/reply",
            json={
                "version": row["version"],
                "comment": "Приложены запрошенные документы",
                "data": DATA,
                "assessment_id": new_assessment["assessment_id"],
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "in_review")
        self.assertEqual(r.json()["version"], 2)
        revisions = (
            await self.client.get("/api/v1/applications/" + row["id"] + "/revisions")
        ).json()
        self.assertEqual([v["version"] for v in revisions], [1, 2])
        self.assertFalse(revisions[0]["snapshot"]["data"]["documents_attached"])
        self.assertTrue(revisions[1]["snapshot"]["data"]["documents_attached"])

    async def test_application_chat_uses_result_and_separate_history(self):
        await self.login()
        row, _ = await self.submit({**DATA, "scenario": "overdue"})
        with patch(
            "services.platform.adapters.ConfiguredAssistant.answer",
            new_callable=AsyncMock,
            side_effect=httpx.ConnectError("offline"),
        ) as provider:
            response = await self.client.post("/api/v1/chat", json={
                "message": "Почему такой результат?",
                "application_id": row["id"],
            })
        self.assertEqual(response.status_code, 200, response.text)
        answer = response.json()
        self.assertIn("Нужно рассмотрение сотрудником", answer["text"])
        self.assertIn("Новый платёж", answer["text"])
        self.assertEqual(answer["questions"], [])
        self.assertNotIn("proposal", answer)
        self.assertNotIn("product", answer)
        context = provider.call_args.args[1]
        self.assertEqual(context["task"], "application_explanation")
        self.assertEqual(context["assessment"]["status"], row["status"])
        self.assertEqual((await self.client.get("/api/v1/chat")).json(), [])
        history = await self.client.get("/api/v1/chat", params={"application_id": row["id"]})
        self.assertEqual(len(history.json()), 1)
        await self.login("ip")
        forbidden = await self.client.get("/api/v1/chat", params={"application_id": row["id"]})
        self.assertEqual(forbidden.status_code, 404)

    async def test_offer_explanation_separates_proposal_and_original_terms(self):
        await self.login()
        row, _ = await self.submit({**DATA, "scenario": "overdue"})
        await self.login("bank")
        offered = await self.action(row, "offer", amount=1000000, months=36)
        self.assertEqual(offered.status_code, 200, offered.text)
        await self.login()
        with patch("services.platform.adapters.ConfiguredAssistant.answer", new_callable=AsyncMock,
                   side_effect=httpx.ConnectError("offline")):
            response = await self.client.post("/api/v1/chat", json={
                "message": "Объясни новые условия", "application_id": row["id"],
            })
        self.assertEqual(response.status_code, 200, response.text)
        answer = response.json()
        self.assertNotIn("offer_pending", answer["text"])
        self.assertIn("Банк предложил новые условия", answer["text"])
        sections = {section["title"]: section["text"] for section in answer["sections"]}
        self.assertIn("1 000 000,00 ₽", sections["Предложение банка"])
        self.assertIn("36 мес.", sections["Предложение банка"])
        self.assertIn("24 мес.", sections["Исходные условия"])
        self.assertIn("согласиться", sections["Что делать дальше"])
        self.assertEqual(answer["unavailable_reason"], "connection")

    async def test_chat_provider_failure_is_explicit_and_persisted(self):
        await self.login()
        with patch(
            "services.platform.adapters.ConfiguredAssistant.answer",
            new_callable=AsyncMock,
            side_effect=httpx.ConnectError("offline"),
        ):
            r = await self.client.post(
                "/api/v1/chat",
                json={"message": "Нужно оборудование. Подготовь вопросы"},
            )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["mode"], "rules")
        self.assertGreater(len(r.json()["questions"]), 0)
        history = (await self.client.get("/api/v1/chat")).json()
        self.assertEqual(len(history), 1)
