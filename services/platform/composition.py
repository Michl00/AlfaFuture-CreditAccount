"""Single composition root: replace integrations here without changing credit rules."""

from .adapters import (
    BureauMock,
    ContractGateway,
    DocumentProvider,
    MockPaymentGateway,
    RegistryMock,
    TransparencyMock,
)


def data_sources():
    return {
        "registry": RegistryMock(),
        "bureau": BureauMock(),
        "transparency": TransparencyMock(),
    }


def payment_gateway():
    return MockPaymentGateway()


class DemoDocumentProvider(DocumentProvider):
    def package(self, data):
        import hashlib
        import json

        from .catalog import DOCUMENTS, PRODUCTS

        factors = set(data.get("test_factors", [])) | {data["scenario"]}
        fields = {
            key: data[key]
            for key in ("inn", "revenue", "expenses", "taxes", "debt", "age")
        }
        if "conflict" in factors:
            fields["revenue"] = round(fields["revenue"] * 0.8, 2)
        result = []
        for kind in PRODUCTS[data["product"]].documents:
            content = {
                "type": kind,
                "company_inn": data["inn"],
                "synthetic": True,
                "fields": fields
                if kind == "financials"
                else {"amount": data["amount"], "purpose": data["goal"]},
            }
            encoded = json.dumps(content, sort_keys=True, ensure_ascii=False).encode()
            result.append(
                {
                    "id": hashlib.sha256(encoded).hexdigest(),
                    "type": kind,
                    "name": DOCUMENTS[kind] + ".json",
                    "mock": True,
                    "content": content,
                    "source": "Синтетический пакет клиента",
                    "version": "documents-v1",
                }
            )
        return result


def document_provider():
    return DemoDocumentProvider()


class DemoContractGateway(ContractGateway):
    def sign(self, application_id, terms, fail=False):
        import hashlib
        import json

        content = json.dumps(
            {"application_id": application_id, "terms": terms}, sort_keys=True
        )
        return {
            "mock": True,
            "success": not fail,
            "provider": "demo-contract",
            "document_hash": hashlib.sha256(content.encode()).hexdigest(),
            "terms": terms,
            "message": "Ошибка симуляции оформления"
            if fail
            else "Учебное оформление завершено. Юридически значимая подпись не создавалась.",
        }


def contract_gateway():
    return DemoContractGateway()
