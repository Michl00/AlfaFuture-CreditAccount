from dataclasses import dataclass

from environs import Env


@dataclass
class DBConfig:
    url: str

@dataclass
class AuthConfig:
    secret: str
    cookie_secure: bool

@dataclass
class LogConfig:
    level: str
    format: str
    file: str

@dataclass
class Config:
    db: DBConfig
    log: LogConfig
    auth: AuthConfig



def load_config(path: str | None = None) -> Config:
    env = Env()
    env.read_env(path)

    return Config(
        db=DBConfig(url="sqlite+aiosqlite:///./app.db"),
        log=LogConfig(
            level = "DEBUG",
            format = "[%(asctime)s] #%(levelname)8s %(name)s -%(filename)s:%(lineno)d %(message)s",
            file = 'app.log',
        ),
        auth=AuthConfig(
            secret=env('SECRET'),
            cookie_secure=env('COOKIE_SECURE') == 'true',
        ),
    )