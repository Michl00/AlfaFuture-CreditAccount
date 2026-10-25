# Подключение frontend

Новый кабинет подключён к FastAPI через `/api/v1`. Транспорт, cookie/CSRF, обработка ошибок и контроллеры экранов находятся в `src/scripts/product.ts`. Layout: `ProductLayout.astro`. Страницы: `/cabinet/`, `/cabinet/new/`, `/cabinet/applications/`, `/cabinet/application/`, `/cabinet/assistant/`, `/cabinet/company/`, `/cabinet/documents/`, `/cabinet/bank/`.

API и состояния описаны в корневых `docs/architecture.md` и `docs/openapi.json`. Локальный preview может обслуживаться непосредственно FastAPI из frontend/dist; Compose использует nginx. Только dev-прокси Astro соединяется с localhost:8000.

Старый контроллер cabinet.ts используется сохранёнными страницами демонстрации компонентов/дизайна и не управляет заявками нового продукта. Он не является серверным источником состояния.
