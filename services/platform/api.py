"""Versioned HTTP boundary for the autonomous demo product."""

import hashlib
import json
import os
import secrets
import time
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from services.db import get_async_session
from services.services import valid_inn

from . import composition
from .adapters import SCENARIOS, assistant
from .catalog import DOCUMENTS, PRODUCTS, catalog
from .engine import evaluate
from .models import (
    Account,
    Application,
    ApplicationRevision,
    AssessmentRun,
    ChatTurn,
    Draft,
    SessionToken,
)
from .review import apply_review, fact_catalog
from .origins import check_login_origin

router = APIRouter(prefix="/api/v1", tags=["conveyor"])
DB = Annotated[AsyncSession, Depends(get_async_session)]
COOKIE = "conveyor_session"
PROFILES = [
    {
        "id": "ip",
        "name": "ИП Алексеева Мария",
        "inn": "500100732259",
        "role": "client",
        "legal_form": "ИП",
    },
    {
        "id": "ooo",
        "name": "ООО «Пример роста»",
        "inn": "7701234560",
        "role": "client",
        "legal_form": "ООО",
    },
    {
        "id": "bank",
        "name": "Александр · кредитный аналитик",
        "inn": "",
        "role": "staff",
        "legal_form": "",
    },
]


def demo_enabled():
    return os.getenv("DEMO_MODE", "false").lower() == "true"


def public_account(a):
    return {
        "id": a.id,
        "name": a.name,
        "inn": a.inn,
        "role": a.role,
        "legal_form": a.legal_form,
    }


async def seed(session):
    for p in PROFILES:
        if await session.get(Account, p["id"]) is None:
            session.add(Account(**p))
    await session.commit()


async def identity(request: Request, db: DB):
    token = request.cookies.get(COOKIE, "")
    session = await db.get(SessionToken, hashlib.sha256(token.encode()).hexdigest())
    if not session or session.expires < time.time():
        raise HTTPException(401, "SESSION_REQUIRED")
    if request.method not in ("GET", "HEAD", "OPTIONS") and not secrets.compare_digest(
        request.headers.get("x-csrf-token", ""), session.csrf
    ):
        raise HTTPException(403, "CSRF_REQUIRED")
    account = await db.get(Account, session.account_id)
    if not account:
        raise HTTPException(401, "SESSION_REQUIRED")
    request.state.csrf = session.csrf
    return account


Identity = Annotated[Account, Depends(identity)]


def client_only(account):
    if account.role != "client":
        raise HTTPException(403, "CLIENT_REQUIRED")


def staff_only(account):
    if account.role != "staff":
        raise HTTPException(403, "STAFF_REQUIRED")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Login(Strict):
    profile: Literal["ip", "ooo", "bank"]


@router.get("/demo")
async def demo():
    return {
        "enabled": demo_enabled(),
        "profiles": PROFILES if demo_enabled() else [],
        "synthetic": True,
    }


@router.post("/demo/login")
async def login(data: Login, request: Request, response: Response, db: DB):
    if not demo_enabled():
        raise HTTPException(404, "DEMO_DISABLED")
    check_login_origin(request)
    if await db.get(Account, data.profile) is None:
        try:
            await seed(db)
        except IntegrityError:
            await db.rollback()
    old = request.cookies.get(COOKIE)
    if old:
        await db.execute(
            delete(SessionToken).where(
                SessionToken.digest == hashlib.sha256(old.encode()).hexdigest()
            )
        )
    token, csrf = secrets.token_urlsafe(48), secrets.token_hex(32)
    db.add(
        SessionToken(
            digest=hashlib.sha256(token.encode()).hexdigest(),
            account_id=data.profile,
            csrf=csrf,
            expires=int(time.time()) + 14400,
        )
    )
    await db.commit()
    response.set_cookie(
        COOKIE,
        token,
        httponly=True,
        secure=os.getenv("COOKIE_SECURE", "false") == "true",
        samesite="lax",
        max_age=14400,
        path="/",
    )
    return {
        "account": public_account(await db.get(Account, data.profile)),
        "csrf": csrf,
    }


@router.get("/me")
async def me(request: Request, account: Identity, db: DB):
    return {
        "account": public_account(account),
        "csrf": request.state.csrf,
        "demo": True,
        "summary": await summary_for(account, db),
    }


@router.post("/logout")
async def logout(request: Request, response: Response, account: Identity, db: DB):
    await db.execute(
        delete(SessionToken).where(
            SessionToken.digest
            == hashlib.sha256(request.cookies[COOKIE].encode()).hexdigest()
        )
    )
    await db.commit()
    response.delete_cookie(COOKIE)
    return {"success": True}


@router.get("/catalog")
async def products():
    return {
        "products": catalog(),
        "scenarios": [{"id": k, **v} for k, v in SCENARIOS.items()],
    }


class Input(Strict):
    product: str = "working"
    amount: int = Field(default=1500000, ge=100000, le=50000000)
    months: int = Field(default=24, ge=1, le=120)
    goal: str = Field(default="Развитие бизнеса", min_length=3, max_length=1000)
    inn: str = "7701234560"
    revenue: int = Field(default=1500000, gt=0, le=1000000000)
    expenses: int = Field(default=900000, ge=0, le=1000000000)
    taxes: int = Field(default=50000, ge=0, le=1000000000)
    debt: int = Field(default=20000, ge=0, le=1000000000)
    cash: int = Field(default=500000, ge=0, le=1000000000)
    age: int = Field(default=36, ge=0, le=1200)
    scenario: str = "clean"
    documents_attached: bool = False
    stress_drop: int = Field(default=20, ge=0, le=80)
    delay_months: int = Field(default=0, ge=0, le=3)
    test_factors: list[
        Literal[
            "overdue",
            "tax",
            "inactive",
            "seasonal",
            "conflict",
            "unavailable",
            "heavy_debt",
        ]
    ] = Field(default_factory=list, max_length=7)
    refinanced_payment: int = Field(default=0, ge=0, le=1000000000)

    @model_validator(mode="after")
    def validate_product(self):
        p = PRODUCTS.get(self.product)
        if (
            not p
            or not p.min_amount <= self.amount <= p.max_amount
            or not p.min_months <= self.months <= p.max_months
        ):
            raise ValueError("Параметры вне лимитов продукта")
        if self.scenario not in SCENARIOS or not valid_inn(self.inn):
            raise ValueError("Неверный ИНН или сценарий")
        if self.delay_months >= self.months:
            raise ValueError("Задержка должна быть короче срока")
        return self


async def portfolio(db, account_id, exclude=None):
    rows = (
        await db.scalars(
            select(Application).where(
                Application.account_id == account_id,
                Application.status.in_(("approved", "funded")),
            )
        )
    ).all()
    return [
        {
            "id": a.id,
            "payment": a.assessment["plan"]["payment"],
            "exposure": a.assessment["plan"]["exposure"],
        }
        for a in rows
        if a.id != exclude
    ]


def validate_owner(data, account):
    client_only(account)
    if data.inn != account.inn:
        raise HTTPException(422, "COMPANY_INN_MISMATCH")


async def result_for(data, account, db):
    return evaluate(data.model_dump(), await portfolio(db, account.id))


@router.put("/draft")
async def save_draft(data: Input, account: Identity, db: DB):
    validate_owner(data, account)
    # Serialize upserts and submissions for this company across API processes.
    await db.execute(
        update(Account).where(Account.id == account.id).values(name=Account.name)
    )
    row = await db.get(Draft, account.id)
    if row:
        row.payload = data.model_dump()
    else:
        db.add(Draft(account_id=account.id, payload=data.model_dump()))
    await db.commit()
    return {"saved": True}


@router.get("/draft")
async def draft(account: Identity, db: DB):
    client_only(account)
    row = await db.get(Draft, account.id)
    return row.payload if row else None


@router.post("/assessments")
async def assess(data: Input, account: Identity, db: DB):
    validate_owner(data, account)
    result = await result_for(data, account, db)
    fingerprint = digest({"data": data.model_dump(), "result": result})
    row = AssessmentRun(
        id=str(uuid4()),
        account_id=account.id,
        payload=data.model_dump(),
        fingerprint=fingerprint,
        result=result,
        ai_review={},
        state="pending",
        started_at=0,
        expires_at=int(time.time()) + 1800,
    )
    db.add(row)
    await db.commit()
    return {
        **result,
        "fingerprint": fingerprint,
        "assessment_id": row.id,
        "review_state": row.state,
    }


def digest(data):
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def event(actor, action, comment):
    return {
        "id": str(uuid4()),
        "actor": actor,
        "action": action,
        "comment": comment,
        "at": int(time.time() * 1000),
    }


def view(a, staff=False, brief=False):
    result = {
        "id": a.id,
        "account_id": a.account_id,
        "status": a.status,
        "version": a.version,
        "data": a.payload,
        "assessment": {
            k: a.assessment[k]
            for k in ("risk", "score", "terms", "plan", "portfolio")
            if k in a.assessment
        }
        if brief
        else a.assessment,
        "created_at": a.created_at,
        "events": []
        if brief
        else [e for e in a.events if staff or not e.get("internal")],
    }
    return result


class Submission(Strict):
    assessment_id: str
    data: Input
    fingerprint: str = Field(min_length=64, max_length=64)
    consent: Literal[True]


@router.post("/applications", status_code=201)
async def submit(
    data: Submission,
    account: Identity,
    db: DB,
    idempotency_key: Annotated[str, Header(min_length=8, max_length=80)],
):
    validate_owner(data.data, account)
    await db.execute(
        update(Account).where(Account.id == account.id).values(name=Account.name)
    )
    old = await db.scalar(
        select(Application).where(
            Application.account_id == account.id,
            Application.request_key == idempotency_key,
        )
    )
    request_hash = digest(data.model_dump())
    if old:
        if old.request_hash != request_hash:
            raise HTTPException(409, "IDEMPOTENCY_CONFLICT")
        return view(old)
    run = await db.get(AssessmentRun, data.assessment_id)
    if not run or run.account_id != account.id:
        raise HTTPException(404, "ASSESSMENT_NOT_FOUND")
    if run.expires_at < time.time():
        raise HTTPException(409, "ASSESSMENT_EXPIRED")
    if run.state not in ("done", "unavailable"):
        raise HTTPException(409, "AI_REVIEW_REQUIRED")
    if run.payload != data.data.model_dump() or run.fingerprint != data.fingerprint:
        raise HTTPException(409, "ASSESSMENT_CHANGED")
    assessment = await result_for(data.data, account, db)
    if (
        digest({"data": data.data.model_dump(), "result": assessment})
        != data.fingerprint
    ):
        raise HTTPException(409, "ASSESSMENT_CHANGED")
    assessment = apply_review(assessment, run.ai_review, run.id)
    # Rejected applications are persisted to make the result inspectable and auditable.
    row = Application(
        id=str(uuid4()),
        account_id=account.id,
        request_key=idempotency_key,
        request_hash=request_hash,
        status=assessment["status"],
        version=1,
        payload=data.data.model_dump(),
        assessment=assessment,
        events=[
            event(
                account.name, "submitted", "Клиент подтвердил данные и версию условий"
            ),
            event(
                "Риск-политика",
                assessment["status"],
                "Автоматический результат по " + assessment["policy_version"],
            ),
        ],
        created_at=int(time.time() * 1000),
    )
    db.add(row)
    await db.flush()
    save_revision(db, row)
    await db.commit()
    return view(row)


async def summary_for(account, db):
    where = [] if account.role == "staff" else [Application.account_id == account.id]
    counts = dict(
        (
            await db.execute(
                select(Application.status, func.count())
                .where(*where)
                .group_by(Application.status)
            )
        ).all()
    )
    active = (
        await db.scalars(
            select(Application.assessment).where(
                *where, Application.status.in_(("approved", "funded"))
            )
        )
    ).all()
    return {
        "total": sum(counts.values()),
        "counts": counts,
        "active_count": len(active),
        "payment": sum(a["plan"]["payment"] for a in active),
        "exposure": sum(a["plan"]["exposure"] for a in active),
    }


@router.get("/applications")
async def applications(
    account: Identity,
    db: DB,
    status: str = "all",
    q: str = "",
    limit: int = 100,
    offset: int = 0,
):
    query = select(Application)
    if account.role != "staff":
        query = query.where(Application.account_id == account.id)
    if status != "all":
        query = query.where(Application.status == status)
    if q:
        pattern = "%" + q[:200] + "%"
        query = query.where(
            or_(
                Application.id.ilike(pattern),
                Application.payload["goal"].as_string().ilike(pattern),
                Application.payload["inn"].as_string().ilike(pattern),
            )
        )
    total = await db.scalar(select(func.count()).select_from(query.subquery()))
    limit = min(max(limit, 1), 100)
    offset = max(0, offset)
    rows = (
        await db.scalars(
            query.order_by(Application.created_at.desc(), Application.id)
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return {
        "items": [view(a, account.role == "staff", True) for a in rows],
        "total": total,
        "offset": offset,
        "has_more": offset + len(rows) < total,
        "summary": await summary_for(account, db),
    }


async def owned(id, account, db):
    row = await db.get(Application, id)
    if not row or account.role != "staff" and row.account_id != account.id:
        raise HTTPException(404, "APPLICATION_NOT_FOUND")
    return row


@router.get("/applications/{id}")
async def application(id: str, account: Identity, db: DB):
    return view(await owned(id, account, db), account.role == "staff")


class Action(Strict):
    version: int = Field(ge=1)
    action: Literal[
        "approve", "reject", "request_info", "recheck", "pay", "settle", "offer", "sign"
    ]
    comment: str = Field(min_length=10, max_length=2000)
    amount: int | None = Field(default=None, ge=100000, le=50000000)
    months: int | None = Field(default=None, ge=1, le=120)
    simulate_failure: bool = False


@router.post("/applications/{id}/actions")
async def action(id: str, data: Action, account: Identity, db: DB):
    staff_only(account)
    row = await owned(id, account, db)
    await db.execute(
        update(Account).where(Account.id == row.account_id).values(name=Account.name)
    )
    await db.refresh(row)
    if row.version != data.version:
        raise HTTPException(409, "APPLICATION_CHANGED")
    if len(data.comment.strip()) < 10:
        raise HTTPException(422, "COMMENT_REQUIRED")
    payload, assessment = dict(row.payload), dict(row.assessment)
    status = row.status
    if data.action == "sign":
        if status != "approved":
            raise HTTPException(409, "APPROVAL_REQUIRED")
        if assessment.get("contract", {}).get("success"):
            raise HTTPException(409, "CONTRACT_ALREADY_SIGNED")
        assessment["contract"] = composition.contract_gateway().sign(
            row.id, assessment["terms"], data.simulate_failure
        )
    elif data.action == "pay":
        if status != "approved":
            raise HTTPException(409, "APPROVAL_REQUIRED")
        if PRODUCTS[payload["product"]].kind == "guarantee":
            raise HTTPException(422, "GUARANTEE_HAS_NO_DISBURSEMENT")
        if not assessment.get("contract", {}).get("success"):
            raise HTTPException(409, "CONTRACT_REQUIRED")
        payment = composition.payment_gateway().disburse(
            row.id, int(assessment["plan"]["funding"]), data.simulate_failure
        )
        assessment["disbursement"] = payment
        status = "funded" if payment["success"] else "approved"
    elif data.action == "settle":
        if status not in ("approved", "funded"):
            raise HTTPException(409, "NO_ACTIVE_OBLIGATION")
        status = "settled"
    elif data.action == "reject":
        if status not in ("in_review", "needs_info", "technical_hold", "offer_pending"):
            raise HTTPException(409, "FINAL_APPLICATION")
        status = "rejected"
    elif data.action == "request_info":
        if status not in ("in_review", "needs_info", "technical_hold"):
            raise HTTPException(409, "FINAL_APPLICATION")
        status = "needs_info"
    elif data.action == "offer":
        if status not in ("in_review", "needs_info", "technical_hold"):
            raise HTTPException(409, "FINAL_APPLICATION")
        if data.amount is None or data.months is None:
            raise HTTPException(422, "OFFER_TERMS_REQUIRED")
        try:
            new_data = Input(
                **{**payload, "amount": data.amount, "months": data.months}
            )
        except ValidationError:
            raise HTTPException(422, "OFFER_POLICY_BLOCKED") from None
        offered = evaluate(
            new_data.model_dump(), await portfolio(db, row.account_id, row.id)
        )
        if offered["status"] in ("rejected", "technical_hold", "needs_info"):
            raise HTTPException(422, "OFFER_POLICY_BLOCKED")
        assessment["offer"] = {
            "data": new_data.model_dump(),
            "assessment": offered,
            "expires": int(time.time()) + 1800,
        }
        status = "offer_pending"
    else:
        if status not in ("in_review", "needs_info", "technical_hold"):
            raise HTTPException(409, "FINAL_APPLICATION")
        fresh = evaluate(payload, await portfolio(db, row.account_id, row.id))
        previous = {
            k: v
            for k, v in assessment.items()
            if k
            not in (
                "ai_review",
                "assessment_id",
                "offer",
                "contract",
                "disbursement",
                "rules_status",
            )
        }
        if "rules_status" in assessment:
            previous["status"] = assessment["rules_status"]
            previous["risk"] = fresh["risk"]
            previous["rules"] = [
                r for r in previous["rules"] if r["code"] != "AI_MANUAL_REVIEW"
            ]
        old_review = assessment.get("ai_review")
        assessment = (
            apply_review(fresh, old_review, assessment.get("assessment_id"))
            if old_review and digest(previous) == digest(fresh)
            else fresh
        )
        if data.action == "approve":
            if assessment["status"] in ("rejected", "technical_hold", "needs_info"):
                raise HTTPException(422, "POLICY_BLOCKED")
            status = "approved"
        else:
            status = assessment["status"]
    events = [*row.events, event(account.name, data.action, data.comment)]
    changed = await db.execute(
        update(Application)
        .where(Application.id == id, Application.version == data.version)
        .values(
            status=status,
            payload=payload,
            assessment=assessment,
            events=events,
            version=data.version + 1,
        )
    )
    if changed.rowcount != 1:
        raise HTTPException(409, "APPLICATION_CHANGED")
    await db.refresh(row)
    save_revision(db, row)
    await db.commit()
    return view(row, True)


class Reply(Strict):
    version: int = Field(ge=1)
    comment: str = Field(min_length=10, max_length=2000)
    data: Input | None = None
    accept_offer: bool | None = None
    assessment_id: str | None = None


@router.post("/applications/{id}/reply")
async def reply(id: str, data: Reply, account: Identity, db: DB):
    client_only(account)
    row = await owned(id, account, db)
    await db.execute(
        update(Account).where(Account.id == account.id).values(name=Account.name)
    )
    await db.refresh(row)
    if row.version != data.version:
        raise HTTPException(409, "APPLICATION_CHANGED")
    if len(data.comment.strip()) < 10:
        raise HTTPException(422, "COMMENT_REQUIRED")
    if row.status == "offer_pending":
        if data.accept_offer is None:
            raise HTTPException(422, "EXPLICIT_CONSENT_REQUIRED")
        offer = row.assessment["offer"]
        if offer["expires"] < time.time():
            raise HTTPException(409, "OFFER_EXPIRED")
        payload = offer["data"] if data.accept_offer else row.payload
        assessment = evaluate(payload, await portfolio(db, account.id, row.id))
        if data.accept_offer:
            if assessment != offer["assessment"]:
                raise HTTPException(409, "OFFER_CHANGED")
            status = "approved"
        else:
            status = "offer_declined"
    elif row.status == "needs_info" and data.data:
        if not data.assessment_id:
            raise HTTPException(409, "AI_REVIEW_REQUIRED")
        validate_owner(data.data, account)
        payload = data.data.model_dump()
        assessment = evaluate(payload, await portfolio(db, account.id, row.id))
        if data.assessment_id:
            run = await db.get(AssessmentRun, data.assessment_id)
            if (
                not run
                or run.account_id != account.id
                or run.payload != payload
                or run.state not in ("done", "unavailable")
            ):
                raise HTTPException(409, "AI_REVIEW_REQUIRED")
            if (
                run.expires_at < time.time()
                or digest({"data": payload, "result": assessment}) != run.fingerprint
            ):
                raise HTTPException(409, "ASSESSMENT_CHANGED")
            assessment = apply_review(assessment, run.ai_review, run.id)
        # An employee-requested clarification returns to review rather than silently closing it.
        status = (
            "in_review" if assessment["status"] == "approved" else assessment["status"]
        )
    else:
        raise HTTPException(409, "REPLY_NOT_ALLOWED")
    changed = await db.execute(
        update(Application)
        .where(Application.id == id, Application.version == data.version)
        .values(
            status=status,
            payload=payload,
            assessment=assessment,
            version=data.version + 1,
            events=[*row.events, event(account.name, "reply", data.comment)],
        )
    )
    if changed.rowcount != 1:
        raise HTTPException(409, "APPLICATION_CHANGED")
    await db.refresh(row)
    save_revision(db, row)
    await db.commit()
    return view(row)


class Chat(Strict):
    message: str = Field(min_length=1, max_length=2000)
    application_id: str | None = None


@router.get("/chat")
async def history(account: Identity, db: DB, application_id: str | None = None):
    if application_id:
        await owned(application_id, account, db)
    rows = (
        await db.scalars(
            select(ChatTurn)
            .where(
                ChatTurn.account_id == account.id,
                ChatTurn.answer["application_id"].as_string() == application_id,
                ~ChatTurn.question.like("Заключение по заявке %"),
            )
            .order_by(ChatTurn.created_at.desc())
            .limit(30)
        )
    ).all()
    return [
        {"id": r.id, "question": r.question, "answer": r.answer} for r in reversed(rows)
    ]


@router.post("/chat")
async def chat(data: Chat, account: Identity, db: DB):
    row = await owned(data.application_id, account, db) if data.application_id else None
    rows = (
        await db.scalars(
            select(ChatTurn)
            .where(
                ChatTurn.account_id == account.id,
                ChatTurn.answer["application_id"].as_string() == data.application_id,
                ~ChatTurn.question.like("Заключение по заявке %"),
            )
            .order_by(ChatTurn.created_at.desc())
            .limit(3)
        )
    ).all()
    messages = []
    for r in reversed(rows):
        messages.extend(
            [
                {"role": "user", "content": r.question},
                {"role": "assistant", "content": r.answer["text"]},
            ]
        )
    messages.append({"role": "user", "content": data.message})
    context = {"catalog": catalog()}
    if row:
        context["task"] = "application_explanation"
        context["application_id"] = row.id
        context["assessment"] = {
            k: row.assessment[k]
            for k in ("status", "risk", "terms", "rules", "portfolio", "plan", "base", "stress")
        }
        context["assessment"]["status"] = row.status
        context["assessment"]["facts"] = fact_catalog(row.payload, row.assessment)
        bureau = next((c.get("data", {}) for c in row.assessment["checks"] if c.get("key") == "bureau"), {})
        context["assessment"]["external_payment"] = max(row.payload["debt"], bureau.get("monthly_debt", 0))
        if row.status == "offer_pending" and row.assessment.get("offer"):
            offer = row.assessment["offer"]
            context["assessment"]["offer"] = {
                "amount": offer["data"]["amount"], "months": offer["data"]["months"],
                "rate": offer["assessment"]["terms"]["rate"],
                "payment": offer["assessment"]["plan"]["payment"],
                "expired": offer["expires"] < time.time(),
            }
    # Release the database transaction while the remote model generates.
    account_id = account.id
    await db.commit()
    answer = await assistant(messages, context)
    if data.application_id:
        answer = {k: v for k, v in answer.items() if k not in ("product", "proposal")}
        answer["application_id"] = data.application_id
    turn = ChatTurn(
        id=str(uuid4()),
        account_id=account_id,
        question=data.message,
        answer=answer,
        created_at=int(time.time() * 1000),
    )
    db.add(turn)
    await db.commit()
    return {**answer, "turn_id": turn.id}


@router.get("/documents/demo")
async def demo_documents(account: Identity):
    client_only(account)
    return {
        "documents": [
            {
                "type": k,
                "name": v + ".json",
                "mock": True,
                "source": "Синтетический пакет демонстрации",
            }
            for k, v in DOCUMENTS.items()
        ]
    }


@router.get("/health")
async def health(db: DB):
    from sqlalchemy import text

    await db.execute(text("SELECT 1"))
    return {"status": "ok", "demo": demo_enabled()}


@router.post("/applications/{id}/explanation")
async def explanation(id: str, account: Identity, db: DB):
    row = await owned(id, account, db)
    if row.assessment.get("ai_review"):
        return row.assessment["ai_review"]
    facts = fact_catalog(row.payload, row.assessment)
    return {
        "mode": "facts",
        "text": "\n".join(
            facts[key]
            for key in ("TERMS", "PORTFOLIO", "BASE_FORECAST", "STRESS_FORECAST")
        ),
        "questions": [],
    }


def save_revision(db, row):
    db.add(
        ApplicationRevision(
            application_id=row.id,
            version=row.version,
            snapshot={
                "status": row.status,
                "data": row.payload,
                "assessment": row.assessment,
            },
            created_at=int(time.time() * 1000),
        )
    )


@router.get("/applications/{id}/revisions")
async def revisions(id: str, account: Identity, db: DB):
    await owned(id, account, db)
    rows = (
        await db.scalars(
            select(ApplicationRevision)
            .where(ApplicationRevision.application_id == id)
            .order_by(ApplicationRevision.version)
        )
    ).all()
    return [
        {"version": r.version, "snapshot": r.snapshot, "created_at": r.created_at}
        for r in rows
    ]


@router.post("/documents/preview")
async def document_preview(data: Input, account: Identity):
    validate_owner(data, account)
    return {"documents": composition.document_provider().package(data.model_dump())}


async def owned_assessment(id, account, db):
    row = await db.get(AssessmentRun, id)
    if not row or row.account_id != account.id:
        raise HTTPException(404, "ASSESSMENT_NOT_FOUND")
    if row.expires_at < time.time():
        raise HTTPException(409, "ASSESSMENT_EXPIRED")
    return row


@router.get("/assessments/{id}")
async def assessment_status(
    id: str, account: Identity, db: DB, include_result: bool = False
):
    row = await owned_assessment(id, account, db)
    return {
        "id": row.id,
        "review_state": row.state,
        "ai_review": row.ai_review,
        "fingerprint": row.fingerprint,
        **(
            {"data": row.payload, "result": row.result, "assessment_id": row.id}
            if include_result
            else {}
        ),
    }


@router.post("/assessments/{id}/review")
async def review_assessment(
    id: str, account: Identity, db: DB, response: Response, retry: bool = False
):
    row = await owned_assessment(id, account, db)
    if row.state == "unavailable" and retry:
        if row.started_at + 30 > time.time():
            raise HTTPException(429, "REVIEW_RETRY_LATER")
        await db.execute(
            update(AssessmentRun)
            .where(AssessmentRun.id == id, AssessmentRun.state == "unavailable")
            .values(state="queued", started_at=int(time.time()), ai_review={})
        )
        await db.commit()
        response.status_code = 202
        return {"id": id, "review_state": "queued", "ai_review": {}}
    if row.state in ("done", "unavailable"):
        return {"id": id, "review_state": row.state, "ai_review": row.ai_review}
    if row.state == "pending":
        await db.execute(
            update(AssessmentRun)
            .where(AssessmentRun.id == id, AssessmentRun.state == "pending")
            .values(state="queued", started_at=int(time.time()))
        )
        await db.commit()
    response.status_code = 202
    return {
        "id": id,
        "review_state": "queued" if row.state == "pending" else row.state,
        "ai_review": {},
    }


@router.post("/chat/{id}/draft")
async def chat_to_draft(id: str, account: Identity, db: DB):
    client_only(account)
    turn = await db.get(ChatTurn, id)
    if not turn or turn.account_id != account.id:
        raise HTTPException(404, "CHAT_TURN_NOT_FOUND")
    proposal = turn.answer.get("proposal") or {"product": turn.answer.get("product")}
    target = (
        PRODUCTS.get(proposal.get("product"))
        if isinstance(proposal, dict) and isinstance(proposal.get("product"), str)
        else None
    )
    if not target:
        raise HTTPException(422, "NO_FINANCING_PROPOSAL")
    old = await db.get(Draft, account.id)
    values = old.payload.copy() if old else Input(inn=account.inn).model_dump()
    values.update(
        product=target.id,
        goal=str(proposal.get("goal") or turn.question)[:1000],
        documents_attached=False,
    )
    for key in ("amount", "months"):
        raw = proposal.get(key, values[key])
        try:
            value = int(raw)
        except (ValueError, TypeError):
            value = values[key]
        values[key] = min(
            getattr(target, "max_" + key), max(getattr(target, "min_" + key), value)
        )
    validated = Input(**values)
    await db.execute(
        update(Account).where(Account.id == account.id).values(name=Account.name)
    )
    old = await db.get(Draft, account.id)
    if old:
        old.payload = validated.model_dump()
    else:
        db.add(Draft(account_id=account.id, payload=validated.model_dump()))
    await db.commit()
    return {
        "saved": True,
        "data": validated.model_dump(),
        "source_turn": id,
        "notice": "Черновик из консультации. Проверьте сумму, срок и все сведения перед расчётом.",
    }


@router.get("/applications/{id}/state")
async def application_state(id: str, account: Identity, db: DB):
    row = await owned(id, account, db)
    return {"id": row.id, "version": row.version, "status": row.status}


@router.get("/feed")
async def activity_feed(account: Identity, db: DB):
    query = select(Application)
    if account.role != "staff":
        query = query.where(Application.account_id == account.id)
    rows = (
        await db.scalars(query.order_by(Application.created_at.desc()).limit(200))
    ).all()
    items = [
        {
            **event,
            "application_id": row.id,
            "company_inn": row.payload["inn"],
            "product": row.payload["product"],
        }
        for row in rows
        for event in row.events
        if account.role == "staff" or not event.get("internal")
    ]
    return {"items": sorted(items, key=lambda e: (e["at"], e["id"]), reverse=True)[:20]}


@router.get("/documents")
async def company_documents(account: Identity, db: DB):
    client_only(account)
    rows = (
        await db.scalars(
            select(Application)
            .where(Application.account_id == account.id)
            .order_by(Application.created_at.desc())
        )
    ).all()
    documents = {}
    for row in rows:
        for item in row.assessment.get("documents", []):
            saved = documents.setdefault(item["id"], {**item, "applications": []})
            saved["applications"].append(row.id)
    return {"documents": list(documents.values())}
