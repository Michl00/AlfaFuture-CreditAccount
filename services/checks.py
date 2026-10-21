"""Deterministic synthetic integrations. Never call real registries or credit bureaus."""
import time

SCENARIOS = {
    '7701234560': 'clean',
    '7701234578': 'overdue',
    '7701234585': 'tax_risk',
    '7701234592': 'inactive',
}


def run_checks(data, terms, documents=()):
    scenario = SCENARIOS.get(data['inn'], 'clean')
    registry_name = 'ЕГРИП' if len(data['inn']) == 12 else 'ЕГРЮЛ'
    inactive = scenario == 'inactive'
    overdue = scenario == 'overdue'
    tax_risk = scenario == 'tax_risk'
    checks = {
        'mock': True,
        'checked_at': int(time.time() * 1000),
        'scenario': scenario,
        'registry': {'source': registry_name, 'mock': True, 'status': 'fail' if inactive else 'pass',
            'summary': 'Деятельность прекращена (мок)' if inactive else 'Действующий бизнес (мок)',
            'data': {'active': not inactive, 'legal_form': 'ИП' if len(data['inn']) == 12 else 'ООО', 'registered_months_ago': 36}},
        'bki': {'source': 'БКИ', 'mock': True, 'status': 'warning' if overdue else 'pass',
            'summary': 'Просрочка 45 дней в синтетической истории' if overdue else 'Просрочек в синтетической истории нет',
            'data': {'credit_score': 470 if overdue else 780, 'overdue_days': 45 if overdue else 0, 'active_loans': 1}},
        'transparent': {'source': 'Прозрачный бизнес', 'mock': True, 'status': 'warning' if tax_risk else 'pass',
            'summary': 'Налоговая задолженность и массовый адрес (мок)' if tax_risk else 'Флаги риска не найдены (мок)',
            'data': {'tax_debt': 250000 if tax_risk else 0, 'mass_address': tax_risk, 'bankruptcy': False}},
    }
    conflicts = []
    for document in documents:
        for key in ('inn', 'revenue', 'expenses', 'debt', 'age'):
            if key in document.fields and str(document.fields[key]) != str(data.get(key, '')):
                conflicts.append({'document_id': document.id, 'field': key})
    checks['documents'] = {'source': 'Сверка документов', 'mock': False,
        'status': 'warning' if conflicts else 'pass',
        'summary': f'Расхождений: {len(conflicts)}' if conflicts else f'Прикреплено документов: {len(documents)}',
        'data': {'count': len(documents), 'conflicts': conflicts}}
    available = (data['revenue'] - data['expenses']) * 0.5 - data['debt']
    rate = terms['rate'] / 1200
    monthly = terms['amount'] * rate / (1 - (1 + rate) ** -terms['months'])
    ratio = available / monthly
    parts = {
        'financial': round(max(0, min(400, ratio * 200))),
        'credit_history': 100 if overdue else 275,
        'registry': 0 if inactive else 150,
        'business_transparency': 50 if tax_risk else 150,
        'document_penalty': -min(100, len(conflicts) * 25),
    }
    score = max(0, sum(parts.values()))
    reasons = []
    if overdue: reasons.append('Просрочка в моке БКИ')
    if tax_risk: reasons.append('Флаги мока «Прозрачный бизнес»')
    if data['age'] < 12: reasons.append('Бизнес работает меньше года')
    if ratio < 1.25: reasons.append('Высокая нагрузка платежей на доход')
    if conflicts: reasons.append('Данные заявки расходятся с документами')
    if data.get('ai_risk') == 'high': reasons.append('ИИ отметил повышенный риск')
    grade = 'low' if score >= 800 else 'medium' if score >= 600 else 'high' if score >= 400 else 'critical'
    return checks, {'value': score, 'max': 1000, 'risk': grade, 'parts': parts,
        'capacity_ratio': round(ratio, 3), 'manual_review': bool(reasons), 'manual_reasons': reasons,
        'hard_stop': inactive, 'method': 'Демонстрационная балльная модель; внешние источники — моки'}
