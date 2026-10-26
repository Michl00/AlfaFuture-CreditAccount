# Тестовые сценарии

## Подготовка

Запустите приложение по [README](../README.md#быстрый-запуск), включите `DEMO_MODE=true`, дождитесь `/api/v1/health` → `200 {"status":"ok",...}`. Worker должен работать: встроенный при локальном запуске либо отдельный в Compose. Ключ модели для проверки основного процесса не нужен; заключение может завершаться в `unavailable` с объяснением по правилам.

Используйте отдельную тестовую БД. Профили `ooo`, `ip`, `bank` общие для всех посетителей стенда; одобренные/выданные заявки влияют на доступную нагрузку. В браузере переключайтесь через выход/вход либо используйте отдельные браузерные контексты клиента и сотрудника. API-шаги выполняйте с cookie и актуальным CSRF; для каждой новой отправки задавайте новый `Idempotency-Key`.

Базовая анкета: `working`, 1 500 000 ₽, 24 месяца; выручка 1 500 000 ₽/мес., расходы 900 000, налоги 50 000, внешний платёж 20 000, остаток 500 000, возраст 36 месяцев. ИНН ООО `7701234560`, ИП `500100732259`. Если не указано иное, приложен синтетический пакет и портфель пуст. Числа и коды полей приведены в [API](api.md), рабочие запросы — в [коллекции](requests.http).

## Основной сквозной сценарий

| ID | Шаги | Ожидаемый результат |
| --- | --- | --- |
| E2E-01 | Войти как ООО; выбрать продукт и заполнить базовую анкету со сценарием `overdue`; добавить пакет документов; рассчитать и дождаться заключения | Видны условия, график, прогноз, источники и основания ручного рассмотрения. Сохранены `assessment_id` и `fingerprint` |
| E2E-02 | Перезагрузить страницу расчёта; подтвердить данные и отправить заявку | Расчёт восстанавливается; HTTP 201, заявка `in_review`, версия 1, есть события и первая ревизия |
| E2E-03 | Войти сотрудником; найти заявку по ИНН; проверить основания и одобрить с комментарием | `approved`, версия увеличена; решение видно клиенту |
| E2E-04 | Выполнить учебное оформление, затем выплату с `simulate_failure=true` | Оформление успешно; выплата неуспешна, статус остаётся `approved`, версия увеличена |
| E2E-05 | Повторить выплату с актуальной версией, затем выполнить `settle` | `funded` → `settled`; повторное перечисление из `funded` запрещено, погашенный долг исключён из портфеля |
| E2E-06 | Клиентом открыть карточку, историю и ленту | Видны результат и разрешённые события; данные сохраняются после повторного входа |

Браузерный автотест использует ИП и сумму 600 000 ₽, но проверяет тот же процесс. Коллекция HTTP-запросов использует ООО и базовую анкету выше.

## Альтернативные и негативные сценарии

Каждый независимый финансовый сценарий начинайте с пустого портфеля либо погасите созданное обязательство.

| ID | Предусловие / действие | Ожидаемый результат | Автоматическое покрытие |
| --- | --- | --- | --- |
| T-01 | Базовая анкета, `clean`, документы есть; завершить заключение и отправить | Правила дают `approved`. При резервном заключении автоодобрение; рекомендация LLM о доппроверке может перевести в `in_review` | `PolicyTests.test_clean_and_each_source_scenario`, `BoundReviewTests.test_ai_concern_can_escalate_but_never_override_a_hard_stop` |
| T-02 | Отправить без документов; затем приложить пакет, выполнить новый расчёт/заключение и `/reply` | `needs_info` → `in_review`, версия +1; в ревизиях сохранены обе анкеты | `ProductTests.test_clarification_creates_new_revision` |
| T-03 | Сценарий `inactive`, затем попытка сотрудника одобрить | `rejected`; команда получает 409, запрет не обходится | `ProductTests.test_hard_stop_cannot_be_overridden` |
| T-04 | Сценарий `unavailable`, затем `recheck` без изменения пакета | `technical_hold`; недоступность не становится положительной проверкой. Чтобы изменить пакет, запросить уточнение | `PolicyTests.test_clean_and_each_source_scenario`, `ProjectionAndAlternativeTests.test_unknown_bureau_is_not_a_scored_clean_result` |
| T-05 | Из `in_review` предложить 1 000 000 ₽ на 36 месяцев; клиентом отправить `accept_offer=true` с текущей версией | `offer_pending` → `approved`, в заявке предложенные сумма и срок | `ProductTests.test_alternative_offer_exact_consent` |
| T-06 | На отдельном оффере отправить `accept_offer=false`; на других попытаться ответить без согласия, со старой версией или после 30 минут | Отказ → `offer_declined`; без явного ответа 422; старая версия/истёкший оффер 409 | Ручная проверка дополнительных веток оффера |
| T-07 | Повторить отправку с тем же ключом и неизменным телом; затем изменить тело, сохранив ключ | Та же заявка и 201; изменённое тело → 409 `IDEMPOTENCY_CONFLICT`, дубля нет | `ProductTests.test_idempotency_and_stale_portfolio` |
| T-08 | Изменить финансовые данные или портфель после расчёта; отправить с прежним fingerprint | 409 `ASSESSMENT_CHANGED`, нужен новый расчёт | `ProductTests.test_idempotency_and_stale_portfolio`, `BoundReviewTests.test_review_cannot_be_reused_with_other_inputs` |
| T-09 | Создать расчёт и отправить заявку до завершения заключения | 409 `AI_REVIEW_REQUIRED`, заявка не создаётся | `BoundReviewTests.test_review_must_complete_before_submission` |
| T-10 | Сохранить команду; повторить её со старой `version` | 409 `APPLICATION_CHANGED`; состояние и история не меняются | `ProductTests.test_payment_failure_success_and_settlement_release` |
| T-11 | Без входа открыть `/me`; после входа опустить CSRF в PUT; клиентом выполнить `/actions`; выйти и повторить GET | Соответственно 401, 403, 403, 401 | `ProductTests.test_demo_guard_csrf_logout_and_role` |
| T-12 | Создать заявку ООО; войти как ИП и открыть ID заявки/расчёта; проверить ленту | Чужие ресурсы возвращают 404, события ООО отсутствуют в ленте ИП | `ProductTests.test_ownership_and_ip_profile`, `BoundReviewTests.test_review_is_private_and_cached`, `BoundReviewTests.test_feed_is_personal_and_search_precedes_pagination` |
| T-13 | Из `approved` вызвать `pay` до оформления; симулировать ошибку `sign`, повторить успешно; попробовать подписать ещё раз | Без успешного договора 409; ошибка оформления сохраняется; повтор успешного оформления 409 | `BoundReviewTests.test_disbursement_needs_successful_contract_and_retries_are_versioned` |
| T-14 | Сравнить графики кредита, лизинга, овердрафта и гарантии | Суммы платежей согласованы с total/cost; у гарантии funding=0 и резерв exposure; выплату гарантии API запрещает | `PolicyTests.test_product_strategies_and_loan_cost`; запрет выплаты — ручная проверка |
| T-15 | Повторить расчёт сезонного бизнеса с задержкой; сравнить альтернативы | Числа воспроизводимы; сдвигаются все поступления, альтернативы учитывают собственные условия и документы | `PolicyTests.test_stress_and_alternatives_are_reproducible`, `ProjectionAndAlternativeTests` |
| T-16 | Отключить провайдера; завершить заключение. Для восстановления сбоя worker — оставить `running` с истёкшим lease в тестовой БД | Резервный режим обозначен явно; зависшее задание подхватывается снова | `BoundReviewTests.test_proxy_failure_still_has_explicit_bound_rules_review`, `BoundReviewTests.test_crashed_review_lease_is_recovered` |
| T-17 | В тестовой конфигурации вернуть из LLM неизвестные ссылки на факты или вымышленные числа | Неизвестные ссылки отбрасываются, финансовые основания берутся из серверных фактов | `BoundReviewTests.test_model_findings_require_known_fact_references`, `BoundReviewTests.test_numeric_hallucination_is_not_published_as_a_financial_fact` |
| T-18 | В PostgreSQL одновременно отправить две заявки при одном исходном портфеле; двумя worker захватить одно задание | Одна заявка сохраняется, вторая требует пересчёта; активный lease получает один worker | `PostgreSQLTests.test_simultaneous_submissions_revalidate_under_company_lock`, `PostgreSQLTests.test_two_review_workers_claim_only_one_provider_call` |

Имена тестов относятся к [`test_platform.py`](../tests/test_platform.py), [`test_audit_gaps.py`](../tests/test_audit_gaps.py) и [`test_postgres.py`](../tests/test_postgres.py). Ручные ветки не объявляются автоматически покрытыми.

## Команды проверки

Выполнять из корня после установки зависимостей:

```sh
# Серверные тесты на временных БД; провайдер в продуктовых тестах подменён
.venv/bin/python -m unittest discover -s tests -q

# Контракт документации
.venv/bin/python scripts/export-openapi.py --check

# PostgreSQL: отдельная тестовая БД, пользователь с правом CREATE SCHEMA
TEST_DATABASE_URL=postgresql+asyncpg://USER:PASSWORD@localhost/TEST_DB \
  .venv/bin/python -m unittest discover -s tests -p test_postgres.py -q

# UI: сборка, затем запуск API с собранным frontend и worker по README
npm run build --prefix frontend
npx --prefix frontend playwright install chromium
E2E_BASE_URL=http://127.0.0.1:8000 node tests/test_product_e2e.cjs
```

PostgreSQL-тесты создают/удаляют отдельную схему для каждого теста; без `TEST_DATABASE_URL` они пропускаются. Браузерный тест создаёт заявки на указанном стенде и PNG в `docs/screenshots/`; помощник в нём подменён. Результат ручного прогона фиксируйте вместе с commit hash, конфигурацией, датой, ID сценария и фактическим результатом. Этот документ описывает план проверки, а не утверждает, что каждый сценарий уже пройден в текущем окружении.
