import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI

from config.config import Config, load_config
from services.db import User, create_db_and_tables
from services.schemas import UserCreate, UserRead, UserUpdate
from services.users import auth_backend, current_active_user, fastapi_users

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
    await create_db_and_tables()
    logger.info("db ready")
    yield


app = FastAPI(lifespan=lifespan)

app.include_router(fastapi_users.get_auth_router(auth_backend),
                   prefix="/auth", tags=["auth"])
app.include_router(fastapi_users.get_register_router(UserRead, UserCreate),
                   prefix="/auth", tags=["auth"])
app.include_router(fastapi_users.get_reset_password_router(),
                   prefix="/auth", tags=["auth"])
app.include_router(fastapi_users.get_verify_router(UserRead),
                   prefix="/auth", tags=["auth"])
app.include_router(fastapi_users.get_users_router(UserRead, UserUpdate),
                   prefix="/users", tags=["users"])


@app.get("/profile")
async def profile(user: Annotated[User, Depends(current_active_user)]):
    return {"id": user.id, "username": user.username, "email": user.email}