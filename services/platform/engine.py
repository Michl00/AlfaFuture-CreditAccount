"""Pure, deterministic underwriting and monthly cash-flow modelling."""

from dataclasses import asdict
from decimal import ROUND_HALF_UP, Decimal

from .catalog import DOCUMENTS, PRODUCTS, VERSION

POLICY_VERSION = "policy-2026.10.v2"


def money(value):
    return float(Decimal(str(value)).quantize(Decimal(".01"), rounding=ROUND_HALF_UP))


def schedule(product, amount, months, rate):
    """Monthly periods; no hidden guarantee disbursement or factoring annuity."""
    p = PRODUCTS[product]
    principal = Decimal(amount)
    r = Decimal(str(rate)) / 1200
    advance = principal * Decimal(".2") if p.kind == "lease" else Decimal(0)
    financed = principal - advance
    if p.kind == "guarantee":
        fee = principal * Decimal(str(rate)) / 100
        return {
            "advance": 0,
            "funding": 0,
            "payments": [money(fee)] + [0.0] * (months - 1),
            "payment": money(fee),
            "total": money(fee),
            "cost": money(fee),
            "exposure": amount,
            "note": "Комиссия за весь срок; деньги клиенту не выдаются. В стрессе моделируется требование по гарантии.",
        }
    if p.kind in ("bullet", "factoring"):
        payments = [money(financed * r)] * months
        payments[-1] = money(financed + financed * r)
        return {
            "advance": 0,
            "funding": money(financed),
            "payments": payments,
            "payment": max(payments),
            "total": money(sum(payments)),
            "cost": money(sum(Decimal(str(x)) for x in payments) - financed),
            "exposure": amount,
            "note": "Проценты ежемесячно, основная сумма возвращается в конце срока. Для факторинга — упрощённое погашение дебитором.",
        }
    monthly = (financed * r / (1 - (1 + r) ** -months)).quantize(
        Decimal(".01"), rounding=ROUND_HALF_UP
    )
    remaining = financed
    payments = []
    for i in range(months):
        interest = (remaining * r).quantize(Decimal(".01"), rounding=ROUND_HALF_UP)
        payment = monthly if i < months - 1 else remaining + interest
        remaining -= payment - interest
        payments.append(money(payment))
    return {
        "advance": money(advance),
        "funding": money(financed),
        "payments": payments,
        "payment": max(payments),
        "total": money(sum(Decimal(str(x)) for x in payments) + advance),
        "cost": money(sum(Decimal(str(x)) for x in payments) - financed),
        "exposure": amount,
        "note": "Лизинг: аванс 20%, аннуитет оставшейся стоимости; НДС, выкуп и страхование не моделируются."
        if p.kind == "lease"
        else "Линия: моделируется полная выборка лимита и аннуитетное погашение."
        if p.kind == "line"
        else "Аннуитет с корректировкой последнего платежа.",
    }


def factors(data):
    return set(data.get("test_factors", [])) | {data["scenario"]}


def price(product, data, existing):
    flags = factors(data)
    surcharge = (
        (3 if flags & {"overdue", "tax", "conflict"} else 0)
        + (1.5 if existing else 0)
        + (2 if data["age"] < 12 else 0)
    )
    return money(product.rate + surcharge)


def projection(data, terms, debt, stress=False, financing=True):
    p = PRODUCTS[data["product"]]
    plan = schedule(p.id, terms["amount"], terms["months"], terms["rate"])
    balance = money(data["cash"] - (plan["advance"] if financing else 0))
    flags = factors(data)
    delay = data["delay_months"] if stress else 0
    drop = 1 - data["stress_drop"] / 100 if stress else 1

    def receipt(index):
        if index < 0:
            return 0
        return money(
            data["revenue"]
            * (0.55 if "seasonal" in flags and (index + 1) % 4 == 0 else 1)
            * drop
        )

    result = []
    for i, scheduled in enumerate(plan["payments"]):
        revenue = receipt(i - delay)
        payment = scheduled if financing else 0
        guarantee_call = (
            terms["amount"]
            if financing
            and stress
            and p.kind == "guarantee"
            and i == min(2, terms["months"] - 1)
            else 0
        )
        old_debt = max(
            0,
            debt
            - (data["refinanced_payment"] if financing and p.id == "refinance" else 0),
        )
        balance = money(
            balance
            + revenue
            - data["expenses"]
            - data["taxes"]
            - old_debt
            - payment
            - guarantee_call
        )
        result.append(
            {
                "month": i + 1,
                "revenue": revenue,
                "expenses": data["expenses"],
                "taxes": data["taxes"],
                "existing_debt": money(old_debt),
                "payment": payment,
                "balance": balance,
                "guarantee_call": guarantee_call,
            }
        )
    return {
        "rows": result,
        "minimum": min(x["balance"] for x in result),
        "deficit_month": next((x["month"] for x in result if x["balance"] < 0), None),
        "receivables_after_horizon": money(
            sum(
                receipt(i)
                for i in range(max(0, terms["months"] - delay), terms["months"])
            )
        )
        if delay
        else 0,
    }


def evaluate(data, existing=(), include_alternatives=True):
    from .composition import data_sources, document_provider

    product = PRODUCTS[data["product"]]
    flags = factors(data)
    checks_by_key = {}
    for key, source in data_sources().items():
        try:
            checks_by_key[key] = {
                **asdict(source.check(data["inn"], flags)),
                "key": key,
            }
        except (TimeoutError, ConnectionError):
            checks_by_key[key] = {
                "key": key,
                "source": key,
                "mock": False,
                "status": "unknown",
                "summary": "Источник временно недоступен",
                "data": {},
            }
    registry, bureau, transparency = (
        checks_by_key[k] for k in ("registry", "bureau", "transparency")
    )
    checks = list(checks_by_key.values())
    portfolio_payment = money(sum(x["payment"] for x in existing))
    external_debt = max(data["debt"], bureau["data"].get("monthly_debt", 0))
    debt = external_debt + portfolio_payment
    rules = []

    def rule(code, severity, text, source):
        rules.append(
            {"code": code, "severity": severity, "text": text, "source": source}
        )

    if registry["data"].get("active") is False:
        rule(
            "REGISTRY_INACTIVE", "block", "Деятельность прекращена", registry["source"]
        )
    for check in checks:
        if check["status"] == "unknown":
            rule(
                check["key"].upper() + "_UNKNOWN",
                "technical",
                "Нет актуального результата: " + check["source"],
                check["source"],
            )
    if bureau["data"].get("overdue_days", 0) > 0:
        rule(
            "BUREAU_OVERDUE",
            "manual",
            "Просрочка "
            + str(bureau["data"]["overdue_days"])
            + " дней требует рассмотрения",
            "БКИ",
        )
    if transparency["data"].get("tax_debt", 0) > 0 or transparency["data"].get(
        "mass_address"
    ):
        rule("TAX_DEBT", "manual", "Налоговая задолженность / массовый адрес", "ФНС")
    documents = document_provider().package(data) if data["documents_attached"] else []
    conflicts = []
    for doc in documents:
        if doc["type"] == "financials":
            for key in ("inn", "revenue", "expenses", "taxes", "debt", "age"):
                actual = doc["content"]["fields"].get(key)
                if actual != data[key]:
                    conflicts.append(
                        {
                            "field": key,
                            "declared": data[key],
                            "document_value": actual,
                            "document_id": doc["id"],
                        }
                    )
    if conflicts:
        rule(
            "DOCUMENT_CONFLICT",
            "manual",
            "Данные анкеты расходятся с отчётностью",
            "Документ",
        )
    registry_age = registry["data"].get("registered_months_ago")
    if registry_age is not None and registry_age != data["age"]:
        rule(
            "REGISTRY_AGE_CONFLICT",
            "manual",
            "Возраст бизнеса в анкете расходится с реестром",
            "ЕГРЮЛ/ЕГРИП",
        )
    if data["age"] < 12:
        rule("YOUNG_BUSINESS", "manual", "Бизнес работает менее года", "Анкета")
    if product.id == "project":
        rule(
            "PROJECT_EXPERTISE",
            "manual",
            "Проектное финансирование требует экспертного разбора бизнес-плана",
            "Каталог",
        )
    if not documents:
        rule(
            "DOCUMENTS_REQUIRED",
            "info",
            "Нужны: " + ", ".join(DOCUMENTS[x] for x in product.documents),
            "Каталог",
        )
    if product.id == "refinance" and (
        data["refinanced_payment"] <= 0 or data["refinanced_payment"] > external_debt
    ):
        rule(
            "REFINANCE_PROOF",
            "info",
            "Укажите подтверждённый платёж по замещаемому внешнему кредиту",
            "Анкета",
        )
    terms = {
        "amount": data["amount"],
        "months": data["months"],
        "rate": price(product, data, existing),
    }
    plan = schedule(product.id, **terms)
    effective_debt = debt - (
        data["refinanced_payment"]
        if product.id == "refinance" and data["refinanced_payment"] <= external_debt
        else 0
    )
    monthly_capacity = money(
        (data["revenue"] - data["expenses"] - data["taxes"]) * 0.5 - effective_debt
    )
    coverage = money(monthly_capacity / max(plan["payment"], 0.01))
    if coverage < 1 and product.kind != "guarantee":
        rule(
            "PAYMENT_CAPACITY",
            "block",
            "Платёж превышает 50% свободного потока с учётом всех обязательств",
            "Расчёт",
        )
    if data["cash"] < plan["advance"]:
        rule("LEASE_ADVANCE", "block", "Недостаточно остатка для аванса 20%", "Расчёт")
    exposure = sum(x["exposure"] for x in existing)
    if exposure + data["amount"] > product.max_amount:
        rule(
            "PORTFOLIO_LIMIT",
            "block",
            "Превышен совокупный демонстрационный лимит по компании",
            "Портфель",
        )
    base, stress = projection(data, terms, debt), projection(data, terms, debt, True)
    without = projection(data, terms, debt, financing=False)
    if base["minimum"] < 0:
        rule(
            "BASE_DEFICIT",
            "block",
            "Базовый сценарий содержит кассовый дефицит",
            "Симуляция",
        )
    if stress["minimum"] < 0:
        rule(
            "STRESS_DEFICIT",
            "manual",
            "Стресс-сценарий содержит кассовый дефицит",
            "Симуляция",
        )
    severities = {r["severity"] for r in rules}
    status = next(
        (
            state
            for severity, state in [
                ("block", "rejected"),
                ("technical", "technical_hold"),
                ("info", "needs_info"),
                ("manual", "in_review"),
            ]
            if severity in severities
        ),
        "approved",
    )
    risk = (
        "critical"
        if status == "rejected"
        else "unknown"
        if status == "technical_hold"
        else "high"
        if "manual" in severities
        else "low"
    )
    score = (
        None
        if "technical" in severities
        else max(
            0,
            min(
                1000,
                round(
                    650
                    + min(coverage, 2) * 125
                    - sum(150 for r in rules if r["severity"] in ("block", "manual"))
                ),
            ),
        )
    )
    evidence = [
        {
            "field": "Выручка / месяц",
            "value": data["revenue"],
            "source": "Анкета клиента",
            "confirmed": True,
        },
        {
            "field": "Выручка в отчётности",
            "value": next(
                (
                    d["content"]["fields"]["revenue"]
                    for d in documents
                    if d["type"] == "financials"
                ),
                0,
            ),
            "source": "Синтетическая отчётность"
            if documents
            else "Документ не приложен",
            "confirmed": bool(documents),
        },
        {
            "field": "Внешние платежи / месяц",
            "value": external_debt,
            "source": "max(анкета, мок БКИ)",
            "confirmed": bureau["status"] != "unknown",
        },
        {
            "field": "Платежи в нашем портфеле / месяц",
            "value": portfolio_payment,
            "source": "Одобренные / выданные заявки сервера",
            "confirmed": True,
        },
        {
            "field": "Резерв по обязательствам",
            "value": exposure,
            "source": "Портфель, включая гарантии",
            "confirmed": True,
        },
    ]
    result = {
        "status": status,
        "risk": risk,
        "score": score,
        "coverage": coverage,
        "terms": terms,
        "plan": plan,
        "checks": checks,
        "rules": rules,
        "evidence": evidence,
        "documents": documents,
        "conflicts": conflicts,
        "base": base,
        "stress": stress,
        "without_financing": without,
        "alternatives": [],
        "portfolio": {
            "payment": portfolio_payment,
            "exposure": exposure,
            "count": len(existing),
        },
        "policy_version": POLICY_VERSION,
        "catalog_version": VERSION,
        "assumptions": [
            "Источники синтетические. Скоринг — демонстрационная оценка, не вероятность одобрения.",
            "Расходы и налоги постоянны; рост дохода от проекта не предполагается.",
            "Кредитные поступления целиком расходуются на проект в начале периода.",
            "Задержка сдвигает каждый платёж выручки; поступления за пределами горизонта показаны отдельно.",
            "Без финансирования показана текущая деятельность без нового проекта.",
            "Портфель резервирует полный лимит и платёж до отметки о погашении.",
            "Ставки определяет риск-политика, LLM не управляет ценой.",
        ],
    }
    if include_alternatives:
        result["alternatives"] = alternatives(data, existing, result)
    return result


def alternatives(data, existing, original):
    p = PRODUCTS[data["product"]]
    peers = {
        "working": ["line", "unsecured", "non_revolving"],
        "investment": ["unsecured", "secured"],
        "equipment": ["leasing", "investment"],
        "leasing": ["equipment", "vehicle"],
        "vehicle": ["leasing", "equipment"],
        "mortgage": ["secured", "investment"],
        "line": ["working", "non_revolving"],
        "non_revolving": ["working", "line"],
        "unsecured": ["working", "investment"],
        "secured": ["investment", "working"],
        "contract_finance": ["working", "trade"],
        "trade": ["working", "contract_finance"],
        "overdraft": ["bridge", "working"],
        "bridge": ["overdraft", "working"],
        "project": ["investment", "secured"],
    }
    variants = [
        (p.id, 1, min(data["months"] + 12, p.max_months)),
        (p.id, 0.75, data["months"]),
        (p.id, 0.5, min(data["months"] + 24, p.max_months)),
    ]
    variants += [
        (
            pid,
            1,
            min(
                PRODUCTS[pid].max_months, max(PRODUCTS[pid].min_months, data["months"])
            ),
        )
        for pid in peers.get(p.id, [])
    ]
    result, seen = [], set()
    for pid, factor, months in variants:
        target = PRODUCTS[pid]
        amount = max(
            target.min_amount, min(target.max_amount, int(data["amount"] * factor))
        )
        signature = (pid, amount, months)
        if signature in seen or signature == (p.id, data["amount"], data["months"]):
            continue
        seen.add(signature)
        candidate = {
            **data,
            "product": pid,
            "amount": amount,
            "months": months,
            "documents_attached": data["documents_attached"]
            and set(target.documents) <= set(p.documents),
        }
        assessed = evaluate(candidate, existing, False)
        allowed = assessed["status"] in ("approved", "in_review")
        blocked = [
            r["text"]
            for r in assessed["rules"]
            if r["severity"] in ("block", "info", "technical")
        ]
        reasons = []
        if pid != p.id:
            reasons.append("Другой продукт: " + target.description)
        if amount < data["amount"]:
            reasons.append(
                "Бюджет проекта уменьшен на " + str(data["amount"] - amount) + " ₽"
            )
        if assessed["plan"]["advance"]:
            reasons.append("Нужен аванс " + str(assessed["plan"]["advance"]) + " ₽")
        reasons.append("Проверки и документы будут пересчитаны перед подтверждением")
        result.append(
            {
                "product": pid,
                "name": target.name,
                **assessed["terms"],
                "payment": assessed["plan"]["payment"],
                "cost": assessed["plan"]["cost"],
                "minimum": assessed["stress"]["minimum"],
                "feasible": allowed,
                "stress_feasible": allowed and assessed["stress"]["minimum"] >= 0,
                "status": assessed["status"],
                "blocked_reasons": blocked,
                "payment_delta": money(
                    assessed["plan"]["payment"] - original["plan"]["payment"]
                ),
                "cost_delta": money(
                    assessed["plan"]["cost"] - original["plan"]["cost"]
                ),
                "same_budget": amount == data["amount"],
                "reason": ". ".join(reasons),
            }
        )
    return sorted(
        result, key=lambda x: (not x["feasible"], not x["same_budget"], x["cost"])
    )[:5]
