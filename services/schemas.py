from fastapi_users import schemas
from pydantic import Field, field_validator

from services.services import valid_inn


class UserRead(schemas.BaseUser[int]):
    username: str            # ИНН наружу не отдаём


class UserCreate(schemas.BaseUserCreate):
    username: str = Field(min_length=3, max_length=20)
    inn: str

    @field_validator("inn")
    @classmethod
    def check_inn(cls, v: str) -> str:
        v = v.strip()
        if not valid_inn(v):
            raise ValueError("некорректный ИНН")
        return v


class UserUpdate(schemas.BaseUserUpdate):
    username: str | None = Field(default=None, min_length=3, max_length=20)