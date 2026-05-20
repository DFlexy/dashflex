# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8787 \
    HOST=0.0.0.0 \
    DOCKER_HOST=unix:///var/run/docker.sock \
    DASHFLEX_DATA_DIR=/app/data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static
COPY logo ./logo
COPY app.py .

# Falha no build se o PNG da marca não estiver no contexto (evita imagem exportada sem logo).
RUN test -f /app/logo/logo.png || test -f /app/static/logo.png || \
    (echo >&2 "Falta logo/logo.png ou static/logo.png no contexto de build. Copie o ficheiro antes de exportar a imagem." && exit 1)

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787", "--no-access-log"]
