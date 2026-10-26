#!/bin/sh
# Reuses a built frontend and same-origin FastAPI; no model download.
set -eu
cd "$(dirname "$0")/.."
if [ ! -d .venv ]; then python3 -m venv .venv; fi
.venv/Scripts/pip install -q -r requirements.lock
if [ ! -f .env ]; then cp .env.example .env; chmod 600 .env; fi
npm --prefix frontend ci
npm --prefix frontend run build
export DEMO_MODE=true
exec .venv/Scripts/uvicorn main:app --host 127.0.0.1 --port 8000 --proxy-headers --env-file .env
