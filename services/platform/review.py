"""AI reviews reference server facts; generated numbers never become financial facts."""

import hashlib
import json
import re
import time

from .adapters import assistant


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def rub(value):
    return f"{value:,.2f}".replace(",", " ").replace(".", ",") + " ₽"


def fact_catalog(data, result):
    by_key = {c.get("key", ""): c for c in result["checks"]}
    # Historical snapshots predate source keys; canonical monetary facts remain available.
    for key in ("registry", "bureau", "transparency"):
        by_key.setdefault(
            key, {"summary": "См. сохранённый снимок проверки", "data": {}}
        )
    external = max(data["debt"], by_key["bureau"]["data"].get("monthly_debt", 0))
    facts = {
        "REGISTRY": "Демонстрационный реестр: " + by_key["registry"]["summary"] + ".",
        "BUREAU": "Мок БКИ: " + by_key["bureau"]["summary"] + ".",
        "TAX": "Мок ФНС: " + by_key["transparency"]["summary"] + ".",
        "FINANCIALS": "Месячная выручка "
        + rub(data["revenue"])
        + "; расходы "
        + rub(data["expenses"])
        + "; налоги "
        + rub(data["taxes"])
        + ".",
        "TERMS": "Новый платёж — максимум "
        + rub(result["plan"]["payment"])
        + "; ставка "
        + str(result["terms"]["rate"])
        + "%; срок "
        + str(result["terms"]["months"])
        + " мес.",
        "PORTFOLIO": "Внешние платежи "
        + rub(external)
        + "; платежи по ранее одобренным заявкам "
        + rub(result["portfolio"]["payment"])
        + ". Это отдельные обязательства, не платёж по новой заявке.",
        "BASE_FORECAST": "Минимальный денежный ОСТАТОК в базовом сценарии "
        + rub(result["base"]["minimum"])
        + "; месяц дефицита: "
        + str(result["base"]["deficit_month"] or "нет")
        + ". Это остаток, не доход или порог выручки.",
        "STRESS_FORECAST": "Минимальный денежный ОСТАТОК в стрессе "
        + rub(result["stress"]["minimum"])
        + "; месяц дефицита: "
        + str(result["stress"]["deficit_month"] or "нет")
        + ".",
    }
    facts.update({r["code"]: r["text"] for r in result["rules"]})
    return facts


async def review(data, result):
    catalog = fact_catalog(data, result)
    facts = {
        "statements": catalog,
        "policy_status": result["status"],
        "checks": [
            {**c, "data": {k: v for k, v in c["data"].items() if k != "inn"}}
            for c in result["checks"]
        ],
        "financials": {
            k: data[k] for k in ("revenue", "expenses", "taxes", "debt", "cash", "age")
        },
        "financing": {
            **result["terms"],
            "new_max_payment": result["plan"]["payment"],
            "cost": result["plan"]["cost"],
        },
        "portfolio": result["portfolio"],
        "rules": result["rules"],
        "conflicts": result.get("conflicts", []),
    }
    answer = await assistant(
        [
            {
                "role": "user",
                "content": "Дай краткое качественное заключение перед отправкой заявки. НЕ включай числовые значения в text: "
                "платежи и показатели будут показаны сервером из statements. Не называй остаток доходом, "
                "не придумывай пороги. В review.findings выбери ссылки на важные факты из statements. "
                "Оцени полноту, противоречия, нагрузку и стресс; максимум четыре фактора. /no_think",
            }
        ],
        {
            "task": "underwriting",
            "facts": facts,
            "allowed_references": sorted(catalog),
            "policy_version": result["policy_version"],
            "goal": data["goal"],
            "product": data["product"],
        },
    )
    output = answer.get("review") if isinstance(answer.get("review"), dict) else {}
    raw = output.get("findings", [])
    findings = []
    for item in (raw if isinstance(raw, list) else [])[:4]:
        if not isinstance(item, dict):
            continue
        refs = item.get("references", [])
        if (
            not isinstance(refs, list)
            or not refs
            or not all(isinstance(ref, str) and ref in catalog for ref in refs)
        ):
            continue
        # The model selects relevant evidence; the statement is rendered from the server's fact catalog.
        findings.append(
            {
                "text": " ".join(catalog[ref] for ref in dict.fromkeys(refs)),
                "references": list(dict.fromkeys(refs)),
                "severity": item.get("severity")
                if item.get("severity") in ("info", "warning", "critical")
                else "info",
            }
        )
    if not findings:
        selected = [r["code"] for r in result["rules"]][:4] or [
            "REGISTRY",
            "TERMS",
            "PORTFOLIO",
            "STRESS_FORECAST",
        ]
        findings = [
            {"text": catalog[ref], "references": [ref], "severity": "info"}
            for ref in selected
        ]
    policy = {
        "approved": "approve",
        "in_review": "manual_review",
        "rejected": "decline",
        "needs_info": "request_info",
        "technical_hold": "wait_source",
    }[result["status"]]
    proposed = output.get("recommendation")
    if proposed not in (
        "approve",
        "manual_review",
        "decline",
        "request_info",
        "wait_source",
    ):
        proposed = policy
    effective = policy if result["status"] != "approved" else proposed
    raw_text = answer["text"]
    narrative_valid = not re.search(r"\d", raw_text)
    summary = {
        "approved": "По расчёту и обязательным проверкам блокирующих факторов нет.",
        "in_review": "Обнаружены факторы, требующие рассмотрения сотрудником.",
        "rejected": "Текущие условия не проходят обязательные ограничения.",
        "needs_info": "Для рассмотрения нужно дополнить сведения.",
        "technical_hold": "Нет актуального результата обязательного источника.",
    }[result["status"]]
    text = (
        raw_text
        if narrative_valid
        else summary + " Численные основания ниже сформированы из проверенного расчёта."
    )
    return {
        "text": text,
        "raw_model_text": raw_text,
        "narrative_validated": bool(narrative_valid),
        "text_origin": "model_qualitative" if narrative_valid else "server_grounded",
        "mode": answer["mode"],
        "model": answer.get("model"),
        "provider": answer.get("provider", "rules"),
        "recommendation": effective,
        "model_recommendation": proposed,
        "findings": findings,
        "facts_hash": digest(facts),
        "policy_version": result["policy_version"],
        "catalog_version": result["catalog_version"],
        "schema_version": "review-v2",
        "created_at": int(time.time() * 1000),
        "decision_authority": "Правила не могут быть отменены LLM. Дополнительные сомнения ИИ передаются сотруднику.",
    }


def apply_review(result, review, id):
    enriched = {**result, "ai_review": review, "assessment_id": id}
    if (
        result["status"] == "approved"
        and review.get("mode") == "llm"
        and review.get("recommendation") != "approve"
    ):
        enriched.update(status="in_review", risk="high", rules_status="approved")
        enriched["rules"] = [
            *result["rules"],
            {
                "code": "AI_MANUAL_REVIEW",
                "severity": "manual",
                "text": "ИИ рекомендует дополнительное рассмотрение; автоматического отказа по мнению модели нет.",
                "source": "Заключение ИИ",
            },
        ]
    return enriched
