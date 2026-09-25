# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8787 \
    HOST=0.0.0.0 \
    DOCKER_HOST=unix:///var/run/docker.sock \
    DASHFLEX_DATA_DIR=/app/data

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./

RUN test -f /app/logo/logo.png || test -f /app/static/logo/logo.png || \
    (echo >&2 "Falta logo/logo.png no contexto de build." && exit 1)

RUN mkdir -p /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,sys,urllib.request; p=os.environ.get('PORT','8787'); r=urllib.request.urlopen('http://127.0.0.1:%s/api/health'%p, timeout=4); sys.exit(0 if r.status==200 else 1)"

CMD ["sh", "-c", "exec python -B -m uvicorn app.main:app --host \"${HOST:-0.0.0.0}\" --port \"${PORT:-8787}\" --no-access-log"]
