import time
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from services.checks import run_checks
from services.db import ApplicationEvent, BankStaff, CreditApplication, User, get_async_session
from services.documents import owned_documents
from services.users import current_active_user, current_credit_client

router = APIRouter(prefix='/bank', tags=['bank'])
client_router = APIRouter(prefix='/credit/applications', tags=['applications'], dependencies=[Depends(current_credit_client)])
Session = Annotated[AsyncSession, Depends(get_async_session)]
ActiveUser = Annotated[User, Depends(current_active_user)]


async def bank_employee(user: ActiveUser, session: Session):
    if await session.get(BankStaff, user.id) is None: raise HTTPException(403, 'BANK_STAFF_REQUIRED')
    return user


Employee = Annotated[User, Depends(bank_employee)]


def application_view(item):
    return {**item.payload, 'id': item.id, 'status': item.status, 'version': item.version,
        'assigned_to': item.assigned_to, 'createdAt': item.created_at, 'updatedAt': item.updated_at,
        'checks': item.checks, 'score': item.score}


async def application_detail(item, session):
    result = application_view(item)
    owner = await session.get(User, item.user_id)
    result['applicant'] = {'id': owner.id, 'email': owner.email, 'username': owner.username}
    events = (await session.scalars(select(ApplicationEvent).where(ApplicationEvent.application_id == item.id)
        .order_by(ApplicationEvent.created_at, ApplicationEvent.id))).all()
    result['events'] = [{'id': event.id, 'action': event.action, 'comment': event.comment,
        'actor_id': event.actor_id, 'createdAt': event.created_at} for event in events]
    documents = await owned_documents(session, item.user_id, item.payload.get('document_ids', []))
    result['documents'] = [{'id': document.id, 'filename': document.filename, 'fields': document.fields,
        'warnings': document.warnings} for document in documents]
    return result


@client_router.get('')
async def my_applications(user: ActiveUser, session: Session):
    rows = (await session.scalars(select(CreditApplication).where(CreditApplication.user_id == user.id)
        .order_by(CreditApplication.created_at.desc()).limit(100))).all()
    return [application_view(row) for row in rows]


@client_router.get('/{application_id}')
async def my_application(application_id: str, user: ActiveUser, session: Session):
    item = await session.get(CreditApplication, application_id)
    if item is None or item.user_id != user.id: raise HTTPException(404, 'APPLICATION_NOT_FOUND')
    return await application_detail(item, session)


@router.get('/me')
async def me(user: Employee):
    return {'id': user.id, 'username': user.username, 'role': 'bank_employee'}


@router.get('/applications')
async def queue(user: Employee, session: Session,
        status: Literal['all', 'bank_review', 'in_review', 'needs_info', 'approved', 'rejected'] = 'all',
        only_mine: bool = False, manual_only: bool = False, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100)):
    query = select(CreditApplication)
    if status != 'all': query = query.where(CreditApplication.status == status)
    if only_mine: query = query.where(CreditApplication.assigned_to == user.id)
    if manual_only: query = query.where(CreditApplication.score['manual_review'].as_boolean() == True)
    rows = (await session.scalars(query.order_by(CreditApplication.created_at.desc()).offset(offset).limit(limit + 1))).all()
    items = []
    for row in rows[:limit]:
        item = application_view(row)
        owner = await session.get(User, row.user_id)
        item['applicant'] = {'id': owner.id, 'email': owner.email, 'username': owner.username} if owner else None
        items.append(item)
    return {'items': items, 'has_more': len(rows) > limit, 'offset': offset}


@router.get('/applications/{application_id}')
async def bank_application(application_id: str, user: Employee, session: Session):
    item = await session.get(CreditApplication, application_id)
    if item is None: raise HTTPException(404, 'APPLICATION_NOT_FOUND')
    return await application_detail(item, session)


class Action(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(ge=1)
    action: Literal['claim', 'approve', 'reject', 'request_info', 'recheck']
    comment: str = Field(default='', max_length=2000)


@router.post('/applications/{application_id}/actions')
async def bank_action(application_id: str, data: Action, user: Employee, session: Session):
    item = await session.get(CreditApplication, application_id)
    if item is None: raise HTTPException(404, 'APPLICATION_NOT_FOUND')
    if item.version != data.version: raise HTTPException(409, 'APPLICATION_CHANGED')
    if item.status in ('approved', 'rejected'): raise HTTPException(409, 'APPLICATION_FINAL')
    values = {'version': item.version + 1, 'updated_at': int(time.time() * 1000)}
    if data.action == 'claim':
        if item.status not in ('bank_review', 'in_review') or item.assigned_to not in (None, user.id):
            raise HTTPException(409, 'APPLICATION_ASSIGNED')
        values.update(status='in_review', assigned_to=user.id)
    else:
        if item.status != 'in_review' or item.assigned_to != user.id:
            raise HTTPException(409, 'APPLICATION_CLAIM_REQUIRED')
        comment = data.comment.strip()
        if data.action != 'recheck' and len(comment) < 10: raise HTTPException(422, 'DECISION_COMMENT_REQUIRED')
        if data.action in ('approve', 'recheck'):
            documents = await owned_documents(session, item.user_id, item.payload.get('document_ids', []))
            checks, score = run_checks(item.payload, item.payload, documents)
            if data.action == 'approve' and (score['hard_stop'] or score['capacity_ratio'] < 1):
                raise HTTPException(422, 'APPLICATION_HARD_STOP')
            values.update(checks=checks, score=score)
        if data.action != 'recheck':
            values['status'] = {'approve': 'approved', 'reject': 'rejected', 'request_info': 'needs_info'}[data.action]
    result = await session.execute(update(CreditApplication).where(CreditApplication.id == item.id,
        CreditApplication.version == data.version).values(**values))
    if result.rowcount != 1: raise HTTPException(409, 'APPLICATION_CHANGED')
    session.add(ApplicationEvent(id=str(uuid4()), application_id=item.id, actor_id=user.id,
        action=data.action, comment=data.comment.strip(), created_at=values['updated_at']))
    await session.commit()
    await session.refresh(item)
    return await application_detail(item, session)


class Clarification(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int = Field(ge=1)
    comment: str = Field(min_length=10, max_length=2000)
    document_ids: list[str] = Field(default_factory=list, max_length=5)


@client_router.post('/{application_id}/clarification')
async def clarify(application_id: str, data: Clarification, user: ActiveUser, session: Session):
    item = await session.get(CreditApplication, application_id)
    if item is None or item.user_id != user.id: raise HTTPException(404, 'APPLICATION_NOT_FOUND')
    if item.status != 'needs_info' or item.version != data.version: raise HTTPException(409, 'APPLICATION_CHANGED')
    if len(data.comment.strip()) < 10: raise HTTPException(422, 'CLARIFICATION_REQUIRED')
    ids = list(dict.fromkeys(item.payload.get('document_ids', []) + data.document_ids))
    if len(ids) > 10: raise HTTPException(422, 'DOCUMENT_COUNT_LIMIT')
    documents = await owned_documents(session, user.id, ids)
    payload = {**item.payload, 'document_ids': ids}
    checks, score = run_checks(payload, payload, documents)
    now = int(time.time() * 1000)
    changed = await session.execute(update(CreditApplication).where(CreditApplication.id == item.id,
        CreditApplication.version == data.version).values(payload=payload, checks=checks, score=score,
            status='bank_review', assigned_to=None, version=item.version + 1, updated_at=now))
    if changed.rowcount != 1: raise HTTPException(409, 'APPLICATION_CHANGED')
    session.add(ApplicationEvent(id=str(uuid4()), application_id=item.id, actor_id=user.id,
        action='clarification', comment=data.comment.strip(), created_at=now))
    await session.commit()
    await session.refresh(item)
    return await application_detail(item, session)
