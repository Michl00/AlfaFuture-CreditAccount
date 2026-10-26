FROM node:24.15.0-alpine AS frontend
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14.0-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY config ./config
COPY services ./services
COPY --from=frontend /app/dist ./frontend/dist
COPY migrations ./migrations
COPY alembic.ini main.py manage.py ./
RUN useradd --create-home --uid 10001 conveyor && chown -R conveyor:conveyor /app
USER conveyor
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port 8000 --proxy-headers"]
