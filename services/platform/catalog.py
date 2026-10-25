"""Versioned synthetic products. Rates are demo policy, never bank quotations."""

from dataclasses import asdict, dataclass

VERSION = "2026.10.v2"


@dataclass(frozen=True)
class Product:
    id: str
    name: str
    description: str
    kind: str = "loan"
    min_amount: int = 100000
    max_amount: int = 10000000
    min_months: int = 6
    max_months: int = 60
    rate: float = 24.9
    documents: tuple[str, ...] = ("financials",)
    group: str = "Деньги на развитие"


PRODUCTS = {
    p.id: p
    for p in [
        Product(
            "working",
            "Оборотный кредит",
            "Закупки, запасы и текущие расходы",
            max_months=36,
            group="Оборот и ликвидность",
        ),
        Product(
            "investment",
            "Инвестиционный кредит",
            "Развитие и новые направления",
            max_months=84,
            rate=22.9,
        ),
        Product(
            "equipment",
            "Кредит на оборудование",
            "Покупка техники в собственность",
            rate=22.9,
            documents=("financials", "invoice"),
        ),
        Product(
            "line",
            "Кредитная линия",
            "Возобновляемый лимит для бизнеса",
            kind="line",
            max_months=36,
            rate=25.9,
            group="Оборот и ликвидность",
        ),
        Product(
            "overdraft",
            "Овердрафт",
            "Краткосрочное покрытие кассовых разрывов",
            kind="bullet",
            min_months=1,
            max_months=12,
            rate=27.9,
            group="Оборот и ликвидность",
        ),
        Product(
            "refinance",
            "Рефинансирование",
            "Замена действующего обязательства",
            rate=23.9,
            documents=("financials", "debt_statement"),
        ),
        Product(
            "mortgage",
            "Коммерческая ипотека",
            "Помещение для бизнеса; залог моделируется",
            max_amount=50000000,
            max_months=120,
            rate=21.9,
            documents=("financials", "property"),
        ),
        Product(
            "leasing",
            "Лизинг",
            "Финансирование имущества с авансом 20%",
            kind="lease",
            rate=21.9,
            documents=("financials", "invoice"),
            group="Имущество и лизинг",
        ),
        Product(
            "factoring",
            "Факторинг",
            "Финансирование подтверждённой дебиторской задолженности",
            kind="factoring",
            min_months=1,
            max_months=6,
            rate=20.9,
            documents=("financials", "receivable"),
            group="Контракты и дебиторка",
        ),
        Product(
            "guarantee",
            "Банковская гарантия",
            "Условное обязательство без выдачи денег клиенту",
            kind="guarantee",
            max_months=36,
            rate=4.5,
            documents=("financials", "contract"),
            group="Контракты и дебиторка",
        ),
        Product(
            "unsecured",
            "Кредит без залога",
            "Свободная цель без имущественного обеспечения в модели",
            max_amount=5000000,
            max_months=36,
            rate=29.9,
        ),
        Product(
            "secured",
            "Кредит под залог",
            "Финансирование с подтверждением имущества",
            rate=20.9,
            documents=("financials", "property"),
        ),
        Product(
            "vehicle",
            "Кредит на коммерческий транспорт",
            "Автомобиль или техника для бизнеса",
            rate=23.9,
            documents=("financials", "invoice"),
            group="Имущество и лизинг",
        ),
        Product(
            "contract_finance",
            "Кредит на исполнение контракта",
            "Расходы до оплаты заказчиком",
            max_months=36,
            rate=24.4,
            documents=("financials", "contract"),
            group="Контракты и дебиторка",
        ),
        Product(
            "trade",
            "Торговое финансирование",
            "Закупка партий товара по договору поставки",
            max_months=24,
            rate=25.4,
            documents=("financials", "contract"),
            group="Контракты и дебиторка",
        ),
        Product(
            "bridge",
            "Бридж-кредит",
            "Короткое финансирование до планового поступления",
            kind="bullet",
            min_months=1,
            max_months=12,
            rate=28.9,
            group="Оборот и ликвидность",
        ),
        Product(
            "non_revolving",
            "Невозобновляемая кредитная линия",
            "Поэтапное финансирование в рамках общего лимита",
            kind="line",
            max_months=60,
            rate=24.4,
            group="Оборот и ликвидность",
        ),
        Product(
            "project",
            "Проектное финансирование",
            "Инвестиционный проект с ручным анализом плана",
            max_amount=50000000,
            max_months=120,
            rate=23.4,
            documents=("financials", "business_plan"),
        ),
    ]
}
DOCUMENTS = {
    "financials": "Управленческая отчётность",
    "invoice": "Счёт на имущество",
    "debt_statement": "Справка о рефинансируемом долге",
    "property": "Сведения об объекте",
    "receivable": "Реестр дебиторской задолженности",
    "contract": "Контракт / договор поставки",
    "business_plan": "Бизнес-план проекта",
}


def catalog():
    return [
        {
            **asdict(p),
            "version": VERSION,
            "document_names": [DOCUMENTS[d] for d in p.documents],
        }
        for p in PRODUCTS.values()
    ]
