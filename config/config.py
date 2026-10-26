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
class ProviderConfig:
    name: str = "openai-compatible"
    base_url: str = ""
    api_key: str = field(default='', repr=False)
    model: str = ''
    timeout_seconds: float = 180

    def __post_init__(self):
        if not 30 <= self.timeout_seconds <= 300:
            raise ValueError('PROVIDER_TIMEOUT_SECONDS must be between 30 and 300')

    @property
    def completions_url(self):
        return self.base_url.rstrip("/") + "/chat/completions"

@dataclass
class Config:
    db: DBConfig
    log: LogConfig
    auth: AuthConfig
    mail: MailConfig
    provider: ProviderConfig = field(default_factory=ProviderConfig)



def load_config(path: str | None = None) -> Config:
    env = Env()
    env.read_env(path)

    return Config(
        db=DBConfig(url=env.str("DATABASE_URL", default="sqlite+aiosqlite:///./app.db")),
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
        provider=ProviderConfig(
            name=env.str('PROVIDER', default='openai-compatible'),
            base_url=env.str('PROVIDER_BASE_URL', default='').strip().rstrip('/'),
            api_key=env.str('PROVIDER_API_KEY', default=''),
            model=env.str('PROVIDER_MODEL', default=''),
            timeout_seconds=env.float('PROVIDER_TIMEOUT_SECONDS', default=180),
        ),
    )
