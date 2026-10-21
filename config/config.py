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
class MailConfig:
    host: str
    port: int
    username: str
    password: str
    sender: str
    starttls: bool
    reset_password_url: str
    verification_url: str

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
    mail: MailConfig



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
        mail=MailConfig(
            host=env.str('SMTP_HOST', default=''),
            port=env.int('SMTP_PORT', default=587),
            username=env.str('SMTP_USERNAME', default=''),
            password=env.str('SMTP_PASSWORD', default=''),
            sender=env.str('SMTP_FROM', default=''),
            starttls=env.bool('SMTP_STARTTLS', default=True),
            reset_password_url=env.str('RESET_PASSWORD_URL', default=''),
            verification_url=env.str('VERIFICATION_URL', default=''),
        ),
    )
