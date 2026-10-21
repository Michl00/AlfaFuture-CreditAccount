# Почтовые уведомления

Ссылки для сброса пароля и подтверждения почты отправляются через SMTP.
Укажите в `.env` (не добавляйте реальные пароли в Git):

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=no-reply@example.com
SMTP_STARTTLS=true
RESET_PASSWORD_URL=https://app.example.com/reset-password
VERIFICATION_URL=https://app.example.com/verify-email
```

`SMTP_HOST`, `SMTP_FROM` и соответствующий URL необходимы для отправки письма.
Имя и пароль SMTP можно оставить пустыми, если сервер не требует авторизации.
По умолчанию используется порт 587 с STARTTLS и проверкой сертификата.
Для локального тестового SMTP без TLS задайте его порт и `SMTP_STARTTLS=false`.
Неявный TLS (порт 465) не поддерживается.

К URL добавляется параметр `token`; существующие параметры и фрагмент сохраняются.
Это адреса страниц вашего интерфейса, которые нужно реализовать отдельно:
страница сброса отправляет `POST /auth/reset-password` с JSON `token` и `password`,
а страница подтверждения — `POST /auth/verify` с JSON `token`.
Готовых страниц этих форм в этом репозитории нет.
Адреса писем берутся из настроек, а не из заголовков запроса.
Токены и содержимое писем в журнал не записываются.
Ошибки конфигурации и SMTP передаются вызывающему коду; успешная отправка
не имитируется. При отключённом SMTP эти операции завершатся ошибкой.

Проверка почтового модуля: `python -m unittest discover -s tests -v`.
