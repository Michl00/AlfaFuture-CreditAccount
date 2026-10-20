# from environs import Env
# Когда добавим пароли и т.д.
from dataclasses import dataclass
from pathlib import Path


@dataclass
class DBConfig:
    table: str

@dataclass
class LogConfig:
    level: str
    format: str
    file: str

@dataclass
class Config:
    db: DBConfig
    log: LogConfig



def load_config(path: str | None = None) -> Config:
    # env = Env()
    # env.read_env(path)

    return Config(
        DBConfig(
            table = Path("config/schema.sql").read_text(encoding="utf-8"),
        ),
        LogConfig(
            level = "DEBUG",
            format = "[%(asctime)s] #%(levelname)8s %(name)s -%(filename)s:%(lineno)d %(message)s",
            file = 'bot.log',
        ),
    )