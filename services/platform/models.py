"""Persistent demo product entities; legacy prototype tables stay compatible."""

from sqlalchemy import JSON, BigInteger, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from services.db import Base


class Account(Base):
    __tablename__ = "conveyor_accounts"
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    inn: Mapped[str] = mapped_column(String(12))
    role: Mapped[str] = mapped_column(String(20))
    legal_form: Mapped[str] = mapped_column(String(10))


class SessionToken(Base):
    __tablename__ = "conveyor_sessions"
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("conveyor_accounts.id"))
    csrf: Mapped[str] = mapped_column(String(64))
    expires: Mapped[int] = mapped_column(Integer)


class Application(Base):
    __tablename__ = "conveyor_applications"
    __table_args__ = (
        UniqueConstraint("account_id", "request_key", name="uq_conveyor_request"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("conveyor_accounts.id"), index=True
    )
    request_key: Mapped[str] = mapped_column(String(80))
    request_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    payload: Mapped[dict] = mapped_column(JSON)
    assessment: Mapped[dict] = mapped_column(JSON)
    events: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(BigInteger)


class Draft(Base):
    __tablename__ = "conveyor_drafts"
    account_id: Mapped[str] = mapped_column(
        ForeignKey("conveyor_accounts.id"), primary_key=True
    )
    payload: Mapped[dict] = mapped_column(JSON)


class ChatTurn(Base):
    __tablename__ = "conveyor_chat"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("conveyor_accounts.id"), index=True
    )
    question: Mapped[str] = mapped_column(String(2000))
    answer: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(BigInteger)


class ApplicationRevision(Base):
    __tablename__ = "conveyor_revisions"
    application_id: Mapped[str] = mapped_column(
        ForeignKey("conveyor_applications.id"), primary_key=True
    )
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[int] = mapped_column(BigInteger)


class AssessmentRun(Base):
    __tablename__ = "conveyor_assessment_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("conveyor_accounts.id"), index=True
    )
    payload: Mapped[dict] = mapped_column(JSON)
    fingerprint: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON)
    ai_review: Mapped[dict] = mapped_column(JSON)
    state: Mapped[str] = mapped_column(String(20))
    started_at: Mapped[int] = mapped_column(BigInteger, default=0)
    expires_at: Mapped[int] = mapped_column(BigInteger)
