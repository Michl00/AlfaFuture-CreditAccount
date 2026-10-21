from dataclasses import dataclass, field

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

@dataclass
class LogConfig:
    level: str
    format: str
    file: str

@dataclass
class CometConfig:
    api_key: str = field(default='', repr=False)
    model: str = 'qwen3.8-flash'
    timeout_seconds: float = 180

    def __post_init__(self):
        if not 30 <= self.timeout_seconds <= 300:
            raise ValueError('COMETAPI_TIMEOUT_SECONDS must be between 30 and 300')

@dataclass
class Config:
    db: DBConfig
    log: LogConfig
    auth: AuthConfig
    mail: MailConfig
    comet: CometConfig = field(default_factory=CometConfig)



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
        ),
        comet=CometConfig(
            api_key=env.str('COMETAPI_KEY', default='') or env.str('COMETAPI_API_KEY', default=''),
            model=env.str('COMETAPI_MODEL', default='qwen3.8-flash'),
            timeout_seconds=env.float('COMETAPI_TIMEOUT_SECONDS', default=180),
        ),
    )
