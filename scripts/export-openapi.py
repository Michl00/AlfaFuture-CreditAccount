"""Export the actual FastAPI contract without starting the server or opening a DB."""

import argparse
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail on schema drift")
    args = parser.parse_args()
    # Do not use the developer's database, credentials, provider or log file.
    settings = {
        "SECRET": "openapi-export-only-not-a-runtime-secret",
        "COOKIE_SECURE": "false",
        "DATABASE_URL": "sqlite+aiosqlite:///:memory:",
        "PROVIDER_BASE_URL": "",
        "PROVIDER_API_KEY": "",
        "PROVIDER_MODEL": "",
        "PROVIDER_TIMEOUT_SECONDS": "180",
    }
    with patch.dict(os.environ, settings), patch("logging.basicConfig"):
        from main import app

        content = json.dumps(
            app.openapi(), ensure_ascii=False, indent=2, sort_keys=True
        ) + "\n"
    target = ROOT / "docs" / "openapi.json"
    if args.check:
        if not target.exists() or target.read_text(encoding="utf-8") != content:
            parser.exit(1, "OpenAPI differs: run python scripts/export-openapi.py\n")
        print("OpenAPI is up to date")
    else:
        target.write_text(content, encoding="utf-8")
        print("Exported docs/openapi.json")


if __name__ == "__main__":
    main()
