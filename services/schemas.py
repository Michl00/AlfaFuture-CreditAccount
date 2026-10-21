from fastapi_users import schemas
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from services.services import valid_inn


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: EmailStr
    is_active: bool
    is_superuser: bool
    username: str
    inn: str | None = None


class UserCreate(schemas.CreateUpdateDictModel):
    model_config = ConfigDict(extra='forbid')
    email: EmailStr
    password: str
    is_active: bool = True
    is_superuser: bool = False
    username: str = Field(min_length=3, max_length=20)
    inn: str | None = None

    @field_validator("inn")
    @classmethod
    def check_inn(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        v = v.strip()
        if not valid_inn(v):
            raise ValueError("некорректный ИНН")
        return v


class UserUpdate(schemas.CreateUpdateDictModel):
    model_config = ConfigDict(extra='forbid')
    password: str | None = None
    email: EmailStr | None = None
    is_active: bool | None = None
    is_superuser: bool | None = None
    username: str | None = Field(default=None, min_length=3, max_length=20)
    inn: str | None = None

    check_inn = field_validator('inn')(UserCreate.check_inn.__func__)
