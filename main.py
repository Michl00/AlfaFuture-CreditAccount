import logging
import asyncio
from contextlib import suppress
import os
import time
from uuid import uuid4
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from config.config import Config, load_config
from services.db import User, create_db_and_tables, async_session_maker
from services.schemas import UserCreate, UserRead, UserUpdate
from services.users import auth_backend, current_active_user, fastapi_users
from services.credit_api import router as credit_router
from services.bank import router as bank_router, client_router as applications_router
from services.documents import router as documents_router
from services.platform.api import router as conveyor_router

config: Config = load_config()

logging.basicConfig(
    format=config.log.format,
    level=config.log.level,
    filemode="a",
    filename=config.log.file,
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("AUTO_CREATE_SCHEMA", "true") == "true":
        await create_db_and_tables()
    logger.info("db ready")
    worker = None
    if os.getenv("AI_WORKER_EMBEDDED", "true") == "true":
        from services.platform.worker import worker_loop

        worker = asyncio.create_task(worker_loop(async_session_maker))
    try:
        yield
    finally:
        if worker:
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker


app = FastAPI(lifespan=lifespan)
app.include_router(conveyor_router)
app.include_router(credit_router)
app.include_router(bank_router)
app.include_router(applications_router)
app.include_router(documents_router)


@app.get("/", include_in_schema=False)
@app.get("/demo", include_in_schema=False)
@app.get("/demo/", include_in_schema=False)
async def cabinet_entry():
    return RedirectResponse("/cabinet/", headers={"Cache-Control": "no-store"})


app.include_router(
    fastapi_users.get_auth_router(auth_backend), prefix="/auth", tags=["auth"]
)
app.include_router(
    fastapi_users.get_register_router(UserRead, UserCreate),
    prefix="/auth",
    tags=["auth"],
)
app.include_router(
    fastapi_users.get_reset_password_router(), prefix="/auth", tags=["auth"]
)
app.include_router(
    fastapi_users.get_users_router(UserRead, UserUpdate),
    prefix="/users",
    tags=["users"],
)


@app.get("/profile")
async def profile(user: Annotated[User, Depends(current_active_user)]):
    return {"id": user.id, "username": user.username, "email": user.email}


@app.middleware("http")
async def conveyor_headers(request, call_next):
    started = time.monotonic()
    request_id = str(uuid4())
    try:
        response = await call_next(request)
    except Exception as error:
        logger.error(
            "request failed id=%s exception=%s", request_id, type(error).__name__
        )
        response = JSONResponse(
            status_code=500,
            content={"detail": "INTERNAL_ERROR", "request_id": request_id},
        )
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        logger.info(
            "request id=%s method=%s status=%s elapsed_ms=%.1f",
            request_id,
            request.method,
            response.status_code,
            (time.monotonic() - started) * 1000,
        )
    return response


# Local preview serves the exact production build with same-origin API cookies.
frontend_build = Path(__file__).resolve().parent / "frontend" / "dist"
if frontend_build.exists():
    for route, directory in (
        ("/cabinet", "cabinet"),
        ("/_astro", "_astro"),
        ("/assets", "assets"),
        ("/components", "components"),
        ("/references", "references"),
    ):
        if (frontend_build / directory).exists():
            app.mount(
                route,
                StaticFiles(directory=frontend_build / directory, html=True),
                name="frontend-" + directory,
            )


@app.get("/favicon.svg", include_in_schema=False)
async def favicon():
    return FileResponse(
        frontend_build / "favicon.svg"
    )
