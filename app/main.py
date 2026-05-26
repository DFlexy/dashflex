
from __future__ import annotations

import logging
import re
import sys
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator, Literal

import docker as docker_mod
from docker.errors import ImageNotFound
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.docker_service import (
    DockerSvc,
    cached_info,
    cached_running_summaries,
    get_docker,
    invalidate_docker_caches,
    ping_cached,
    reset_docker_client,
)
from app.host_stats import host_snapshot
from app import dashboard_bookmarks_store as dash_store
from app import link_store
from app import settings_store

logger = logging.getLogger("dashflex")

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
LOGO_DIR = ROOT / "logo"
LOGO_PRIMARY = LOGO_DIR / "logo.png"
LOGO_FALLBACK_STATIC = STATIC / "logo.png"

_LOGO_MEDIA_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}


def resolve_brand_logo_file() -> tuple[Path, str] | None:
    """logo/logo.png na raiz do projeto ou static/logo.png (útil em desenvolvimento)."""
    for p in (LOGO_PRIMARY, LOGO_FALLBACK_STATIC):
        if p.is_file():
            mt = _LOGO_MEDIA_TYPES.get(p.suffix.lower(), "application/octet-stream")
            return (p, mt)
    return None


APP_VERSION = "0.2.0"
_IO_POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="dashflex-io")

def _settings_response() -> dict[str, Any]:
    s = settings_store.load_settings()
    return {
        **s,
        "links_saved_count": link_store.count_links(),
        "dash_bookmarks_count": dash_store.count_items(),
        "data_dir": str(settings_store.DATA_DIR),
        "app_version": APP_VERSION,
    }

def _parse_created(s: str | None) -> datetime | None:
    if not s:
        return None
    raw = s.replace("Z", "+00:00").strip()
    raw = re.sub(r"\.(\d{6})\d+", r".\1", raw)
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None

def _dashboard_kpis(d: DockerSvc) -> dict[str, Any]:
    info = cached_info(d)
    image_ids: set[str] = set()

    for row in cached_running_summaries(d):
        iid = str(row.get("ImageID") or "").strip()
        img_tag = str(row.get("Image") or "").strip()
        slot = iid if iid else (f"ref:{img_tag}" if img_tag else "")
        if slot:
            image_ids.add(slot)

    running = int(info.get("containers_running") or 0)
    stopped = int(info.get("containers_stopped") or 0)
    paused = int(info.get("containers_paused") or 0)
    total_images = int(info.get("images") or 0)
    images_active = len(image_ids)
    images_inactive = max(0, total_images - images_active)

    return {
        "containers_active": running,
        "containers_inactive": stopped + paused,
        "images_active": images_active,
        "images_inactive": images_inactive,
        "total_images": total_images,
        "server_version": info.get("server_version", ""),
    }


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    if resolve_brand_logo_file() is None:
        logger.warning(
            "Ficheiro de marca ausente em %s ou %s. O logo no cabeçalho e o favicon não serão servidos. "
            "Confirme que a imagem inclui COPY logo (e logo.png) e que nenhum volume sobrepõe /app/logo.",
            LOGO_PRIMARY,
            LOGO_FALLBACK_STATIC,
        )
    yield


app = FastAPI(title="DashFlex", version=APP_VERSION, lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ActionBody(BaseModel):
    action: Literal["start", "stop", "restart"]

class ContainerAccessBody(BaseModel):

    id_full: str | None = None
    name: str | None = None
    scheme: Literal["http", "https"] = "http"
    host: str = Field(..., min_length=1)
    port: int = Field(..., ge=1, le=65535)
    path: str = "/"

def _attach_access(entries: list[dict[str, Any]]) -> None:
    links = link_store.load_links()
    for it in entries:
        acc = link_store.resolve_access(
            it.get("id_full") or "",
            it.get("name") or "",
            links=links,
        )
        if acc:
            it["access"] = {**acc, "url": link_store.build_url(acc)}
        else:
            it["access"] = None


def _docker_unavailable() -> None:
    raise HTTPException(503, "Docker indisponível")


def _require_docker() -> DockerSvc:
    d = get_docker()
    if not ping_cached(d):
        _docker_unavailable()
    return d


def _invalidate_after_mutation() -> None:
    invalidate_docker_caches()

class SettingsPatch(BaseModel):
    dashboard_refresh_seconds: int | None = Field(None, ge=5, le=600)
    docker_base_url: str | None = None
    containers_show_stopped_default: bool | None = None
    app_display_name: str | None = Field(None, max_length=80)
    dash_bookmark_card_scale_percent: int | None = Field(None, ge=70, le=140)
    ui_theme: Literal["glass", "frost"] | None = None
    ui_language: Literal["pt", "en"] | None = None

    @field_validator("app_display_name")
    @classmethod
    def app_display_name_trim(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip()

class DockerTestBody(BaseModel):

    base_url: str = ""

class DockerPruneBody(BaseModel):

    dangling_images: bool = False
    stopped_containers: bool = False
    unused_networks: bool = False

class DashBookmarkCreate(BaseModel):
    title: str = Field("", max_length=120)
    url: str = Field(..., min_length=4, max_length=2048)
    icon: str = Field("🔗", max_length=16)
    container_id: str | None = Field(None, max_length=128)

    @field_validator("url")
    @classmethod
    def url_scheme(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith(("http://", "https://")):
            raise ValueError("A URL deve começar com http:// ou https://")
        return v

class DashBookmarkUpdate(BaseModel):
    title: str | None = Field(None, max_length=120)
    url: str | None = Field(None, min_length=4, max_length=2048)
    icon: str | None = Field(None, max_length=16)

    @field_validator("url")
    @classmethod
    def url_scheme(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v.startswith(("http://", "https://")):
            raise ValueError("A URL deve começar com http:// ou https://")
        return v

class DashBookmarksReorderBody(BaseModel):
    order: list[str] = Field(default_factory=list)

    @field_validator("order", mode="before")
    @classmethod
    def coerce_order(cls, v: object) -> list[str]:
        if not isinstance(v, list):
            raise ValueError("O campo order deve ser uma lista de IDs.")
        return [str(x).strip() for x in v if str(x).strip()]

class DashIconFromUrlBody(BaseModel):
    url: str = Field(..., min_length=12, max_length=2048)

    @field_validator("url")
    @classmethod
    def icon_url_scheme(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith(("http://", "https://")):
            raise ValueError("A URL do ícone deve começar com http:// ou https://")
        return v

@app.exception_handler(StarletteHTTPException)
async def http_exc(_req, exc: StarletteHTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}

@app.get("/api/docker/status")
def docker_status() -> dict[str, Any]:
    raw_cfg = str((settings_store.load_settings().get("docker_base_url") or "")).strip()
    eff = settings_store.effective_docker_base_url()
    used_explicit = eff is not None
    ignored_windows_url = bool(raw_cfg) and eff is None and sys.platform != "win32"

    d = get_docker()
    ok = ping_cached(d)
    if not ok:
        hint = ""
        if ignored_windows_url:
            hint = (
                "A URL base do Docker salva parece ser para Windows ou Docker Desktop e foi ignorada neste sistema. "
                "Em Administrativo, limpe o campo, salve e reinicie o container. Confira também "
                "-v /var/run/docker.sock:/var/run/docker.sock."
            )
        elif not raw_cfg:
            hint = (
                "Confira se você montou -v /var/run/docker.sock:/var/run/docker.sock no docker run e se o daemon Docker está ativo no host."
            )
        else:
            hint = (
                "Não foi possível conectar ao Docker com a URL salva. Revise o valor em Administrativo "
                "ou apague-o para usar o socket padrão (DOCKER_HOST / unix:///var/run/docker.sock)."
            )
        return {
            "connected": False,
            "error": "Não foi possível conectar ao Docker Engine.",
            "hint": hint,
            "settings_docker_base_url_set": bool(raw_cfg),
            "using_saved_url": used_explicit,
        }
    info = cached_info(d)
    return {
        "connected": True,
        "server_version": info.get("server_version", ""),
        "using_saved_url": used_explicit,
        "settings_docker_base_url_set": bool(raw_cfg),
    }

@app.get("/api/host")
def host() -> dict[str, Any]:
    return host_snapshot()

@app.get("/api/dashboard")
def dashboard() -> dict[str, Any]:
    d = _require_docker()
    fk = _IO_POOL.submit(_dashboard_kpis, d)
    fh = _IO_POOL.submit(host_snapshot)
    ft = _IO_POOL.submit(lambda: d.top_container_stats(10, cpu_retry=False))
    kpis = fk.result()
    try:
        host = fh.result()
    except Exception:
        logger.exception("host_snapshot")
        host = {
            "hostname": "?",
            "cpu_percent": 0.0,
            "cpu_bar": "ok",
            "mem_percent": 0.0,
            "mem_bar": "ok",
            "disk_percent": 0.0,
            "disk_bar": "ok",
            "mem_total_gb": 0.0,
            "disk_total_gb": 0.0,
        }
    try:
        top = ft.result()
    except Exception:
        logger.exception("top_container_stats")
        top = []
    return {"kpis": kpis, "top_cpu": top, "host": host}

@app.get("/api/dashboard/kpis")
def dashboard_kpis_only() -> dict[str, Any]:
    d = _require_docker()
    try:
        return {"kpis": _dashboard_kpis(d)}
    except Exception:
        logger.exception("_dashboard_kpis")
        raise HTTPException(503, "Docker indisponível") from None

@app.get("/api/overview/live")
def overview_live() -> dict[str, Any]:
    d = _require_docker()

    def _top() -> list[dict[str, Any]]:
        try:
            return d.top_container_stats(10, cpu_retry=False)
        except Exception:
            logger.exception("top_container_stats live")
            return []

    def _host_live() -> dict[str, Any]:
        try:
            return host_snapshot()
        except Exception:
            logger.exception("host_snapshot live")
            return {
                "hostname": "?",
                "cpu_percent": 0.0,
                "cpu_bar": "ok",
                "mem_percent": 0.0,
                "mem_bar": "ok",
                "disk_percent": 0.0,
                "disk_bar": "ok",
                "mem_total_gb": 0.0,
                "disk_total_gb": 0.0,
            }

    fk = _IO_POOL.submit(_dashboard_kpis, d)
    ft = _IO_POOL.submit(_top)
    fh = _IO_POOL.submit(_host_live)
    return {
        "kpis": fk.result(),
        "top_cpu": ft.result(),
        "host": fh.result(),
    }

@app.get("/api/stats/top")
def stats_top(limit: int = Query(15, ge=1, le=40)) -> list[dict[str, Any]]:
    d = _require_docker()
    return d.top_container_stats(limit)

@app.get("/api/containers")
def list_containers(all_: bool = Query(True, alias="all")) -> list[dict[str, Any]]:
    d = _require_docker()
    rows = d.list_containers(all_=all_)
    _attach_access(rows)
    return rows

@app.post("/api/container-access")
def upsert_container_access(body: ContainerAccessBody) -> dict[str, Any]:
    if not body.id_full and not (body.name and body.name.strip()):
        raise HTTPException(400, "Informe id_full ou name do container.")
    path = body.path.strip() or "/"
    if path != "/" and not path.startswith("/"):
        path = "/" + path
    cfg = {
        "scheme": body.scheme,
        "host": body.host.strip(),
        "port": body.port,
        "path": path,
    }
    try:
        link_store.set_access(body.id_full, body.name, cfg)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"saved": cfg, "url": link_store.build_url(cfg)}

@app.delete("/api/container-access")
def delete_container_access(
    id_full: str | None = Query(None),
    name: str | None = Query(None),
) -> dict[str, str]:
    try:
        link_store.delete_access(id_full, name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"status": "ok"}

@app.get("/api/containers/{container_id}/stats")
def container_stats(container_id: str) -> dict[str, Any]:
    d = _require_docker()
    try:
        return d.container_stats_snapshot(container_id)
    except Exception as e:
        logger.exception("stats")
        raise HTTPException(404, str(e)) from e

@app.post("/api/containers/{container_id}/action")
def container_action(container_id: str, body: ActionBody) -> dict[str, str]:
    d = _require_docker()
    try:
        if body.action == "start":
            d.start(container_id)
        elif body.action == "stop":
            d.stop(container_id)
        else:
            d.restart(container_id)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    _invalidate_after_mutation()
    return {"status": "ok"}

@app.delete("/api/containers/{container_id}")
def container_delete(container_id: str, force: bool = False) -> dict[str, str]:
    d = _require_docker()
    try:
        d.remove(container_id, force=force)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    _invalidate_after_mutation()
    return {"status": "removed"}

@app.get("/api/containers/{container_id}/logs")
def container_logs(container_id: str, tail: int = Query(300, ge=50, le=5000)) -> dict[str, str]:
    d = _require_docker()
    try:
        text = d.logs(container_id, tail=tail)
    except Exception as e:
        raise HTTPException(404, str(e)) from e
    return {"logs": text}

@app.get("/api/containers/{container_id}/logs/stream")
def container_logs_stream(
    container_id: str,
    tail: int = Query(200, ge=50, le=2000),
) -> StreamingResponse:
    d = _require_docker()
    try:
        stream = d.logs_stream(container_id, tail=tail)
    except Exception as e:
        raise HTTPException(404, str(e)) from e
    return StreamingResponse(stream, media_type="text/plain; charset=utf-8")

@app.get("/api/images")
def list_images() -> list[dict[str, Any]]:
    d = _require_docker()
    return d.list_images()

@app.delete("/api/images")
def image_delete(
    ref: str = Query(..., min_length=1, description="ID da imagem (sha256:…) ou nome:tag"),
    force: bool = Query(False),
) -> dict[str, str]:
    d = _require_docker()
    image_ref = ref.strip()
    if not image_ref:
        raise HTTPException(400, "Informe a referência da imagem (nome:tag ou ID).")
    try:
        running_names = d.list_running_containers_for_image(image_ref)
    except ImageNotFound:
        raise HTTPException(404, "Imagem não encontrada.") from None
    if running_names:
        shown = ", ".join(running_names[:12])
        extra = f" (+{len(running_names) - 12} mais)" if len(running_names) > 12 else ""
        raise HTTPException(
            409,
            "Não é possível remover esta imagem enquanto houver containers em execução usando-a: "
            f"{shown}{extra}. Pare ou remova esses containers antes.",
        )
    try:
        d.remove_image(image_ref, force=force)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    _invalidate_after_mutation()
    return {"status": "removed"}

@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return _settings_response()

@app.patch("/api/settings")
def patch_settings(body: SettingsPatch) -> dict[str, Any]:
    cur = settings_store.load_settings()
    changed_docker = False
    if body.dashboard_refresh_seconds is not None:
        cur["dashboard_refresh_seconds"] = body.dashboard_refresh_seconds
    if body.docker_base_url is not None:
        cur["docker_base_url"] = body.docker_base_url.strip()
        changed_docker = True
    if body.containers_show_stopped_default is not None:
        cur["containers_show_stopped_default"] = body.containers_show_stopped_default
    if body.app_display_name is not None:
        cur["app_display_name"] = body.app_display_name or settings_store.DEFAULTS["app_display_name"]
    if body.dash_bookmark_card_scale_percent is not None:
        cur["dash_bookmark_card_scale_percent"] = body.dash_bookmark_card_scale_percent
    if body.ui_theme is not None:
        cur["ui_theme"] = body.ui_theme
    if body.ui_language is not None:
        cur["ui_language"] = body.ui_language
    settings_store.save_settings(cur)
    if changed_docker:
        reset_docker_client()
    return _settings_response()

_DASH_ICON_MEDIA = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}

@app.get("/api/dash-bookmarks")
def dash_bookmarks_list() -> dict[str, Any]:
    raw = dash_store.load_items()
    items: list[dict[str, Any]] = []
    for it in raw:
        row = dict(it)
        bid = row.get("id")
        if bid and dash_store.has_icon(str(bid)):
            row["icon_image_url"] = f"/api/dash-bookmarks/{bid}/icon"
        items.append(row)
    return {"items": items}

@app.post("/api/dash-bookmarks")
def dash_bookmarks_create(body: DashBookmarkCreate) -> dict[str, Any]:
    try:
        return dash_store.create_item(body.title, body.url, body.icon, body.container_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

@app.post("/api/dash-bookmarks/reorder")
def dash_bookmarks_reorder(body: DashBookmarksReorderBody) -> dict[str, str]:
    try:
        dash_store.reorder_items(body.order)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"status": "ok"}

@app.patch("/api/dash-bookmarks/{bookmark_id}")
def dash_bookmarks_patch(bookmark_id: str, body: DashBookmarkUpdate) -> dict[str, Any]:
    try:
        return dash_store.update_item(bookmark_id, body.title, body.url, body.icon)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e

@app.delete("/api/dash-bookmarks/{bookmark_id}")
def dash_bookmarks_delete(bookmark_id: str) -> dict[str, str]:
    try:
        dash_store.delete_item(bookmark_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"status": "ok"}

@app.get("/api/dash-bookmarks/{bookmark_id}/icon")
def dash_bookmark_get_icon(bookmark_id: str) -> FileResponse:
    path = dash_store.icon_path(bookmark_id)
    if path is None:
        raise HTTPException(404, "Sem ícone")
    mt = _DASH_ICON_MEDIA.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=mt)

@app.post("/api/dash-bookmarks/{bookmark_id}/icon")
async def dash_bookmark_upload_icon(bookmark_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    if not dash_store.bookmark_exists(bookmark_id):
        raise HTTPException(404, "Atalho não encontrado")
    data = await file.read()
    try:
        mime = dash_store.save_icon(bookmark_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"status": "ok", "mime": mime}

@app.post("/api/dash-bookmarks/{bookmark_id}/icon-from-url")
def dash_bookmark_icon_from_url(bookmark_id: str, body: DashIconFromUrlBody) -> dict[str, Any]:
    if not dash_store.bookmark_exists(bookmark_id):
        raise HTTPException(404, "Atalho não encontrado")
    try:
        data = dash_store.fetch_icon_bytes(body.url)
        mime = dash_store.save_icon(bookmark_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"status": "ok", "mime": mime}


@app.post("/api/dash-bookmarks/{bookmark_id}/icon-from-logo")
def dash_bookmark_icon_from_logo(bookmark_id: str) -> dict[str, Any]:
    """Define como ícone do atalho o arquivo logo/logo.png ou static/logo.png."""
    if not dash_store.bookmark_exists(bookmark_id):
        raise HTTPException(404, "Atalho não encontrado")
    resolved = resolve_brand_logo_file()
    if resolved is None:
        raise HTTPException(
            404,
            "Nenhum logo encontrado. Adicione logo.png nas pastas logo/ ou static/ na raiz do projeto.",
        )
    path, _mt = resolved
    try:
        data = path.read_bytes()
        mime = dash_store.save_icon(bookmark_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except OSError as e:
        raise HTTPException(500, f"Não foi possível ler o logo: {e}") from e
    return {"status": "ok", "mime": mime}


@app.delete("/api/dash-bookmarks/{bookmark_id}/icon")
def dash_bookmark_remove_icon(bookmark_id: str) -> dict[str, str]:
    if not dash_store.bookmark_exists(bookmark_id):
        raise HTTPException(404, "Atalho não encontrado")
    dash_store.remove_icon(bookmark_id)
    return {"status": "ok"}

@app.get("/api/admin/info")
def admin_info() -> dict[str, Any]:
    import platform

    d = get_docker()
    try:
        ping_ok = bool(ping_cached(d))
    except Exception:
        ping_ok = False

    return {
        "app_version": APP_VERSION,
        "python": sys.version.split()[0],
        "python_full": sys.version.replace("\n", " "),
        "platform": platform.platform(),
        "root": str(ROOT),
        "data_dir": str(settings_store.DATA_DIR),
        "settings_file": str(settings_store.SETTINGS_FILE),
        "links_file": str(link_store.DATA_FILE),
        "dash_bookmarks_file": str(dash_store.DATA_FILE),
        "docker_ping": ping_ok,
        "links_saved_count": link_store.count_links(),
        "dash_bookmarks_count": dash_store.count_items(),
    }

@app.post("/api/admin/docker/test")
def admin_docker_test(body: DockerTestBody = DockerTestBody()) -> dict[str, Any]:
    url = (body.base_url or "").strip()
    cli = None
    try:
        if url:
            cli = docker_mod.DockerClient(base_url=url)
        else:
            cli = docker_mod.from_env()
        if not cli.ping():
            return {"ok": False, "error": "Ping falhou ou engine inacessível."}
        info = cli.info()
        return {
            "ok": True,
            "server_version": info.get("ServerVersion", ""),
            "host_name": info.get("Name", ""),
        }
    except Exception as e:
        logger.exception("docker test")
        return {"ok": False, "error": str(e)}
    finally:
        if cli is not None:
            try:
                cli.close()
            except Exception:
                pass

@app.delete("/api/admin/links")
def admin_clear_all_links() -> dict[str, str]:
    link_store.clear_all_links()
    return {"status": "ok"}

@app.delete("/api/admin/dash-bookmarks")
def admin_clear_all_dash_bookmarks() -> dict[str, Any]:
    removed = dash_store.clear_all_items()
    return {"status": "ok", "removed": removed}

@app.get("/api/admin/data-files")
def admin_data_files() -> dict[str, Any]:

    def meta(p: Path) -> dict[str, Any]:
        try:
            st = p.stat()
            return {"path": str(p.resolve()), "bytes": int(st.st_size), "exists": True}
        except OSError:
            return {"path": str(p.resolve()), "bytes": 0, "exists": False}

    return {
        "files": [
            meta(settings_store.SETTINGS_FILE),
            meta(link_store.DATA_FILE),
            meta(dash_store.DATA_FILE),
        ]
    }

@app.get("/api/admin/docker/df")
def admin_docker_df() -> dict[str, Any]:
    d = _require_docker()
    df = d.system_df()
    if df is None or df == {}:
        raise HTTPException(502, "Resposta docker df vazia.")
    return {"layers": df}

@app.post("/api/admin/docker/prune")
def admin_docker_prune(body: DockerPruneBody) -> dict[str, Any]:
    if not (body.dangling_images or body.stopped_containers or body.unused_networks):
        raise HTTPException(400, "Selecione pelo menos uma opção de limpeza.")
    d = _require_docker()

    results: dict[str, Any] = {}
    errors: list[dict[str, str]] = []

    if body.stopped_containers:
        try:
            results["stopped_containers"] = d.prune_stopped_containers()
        except Exception as e:
            logger.exception("admin prune containers")
            errors.append({"step": "stopped_containers", "error": str(e)})

    if body.dangling_images:
        try:
            results["unused_images"] = d.prune_unused_images()
        except Exception as e:
            logger.exception("admin prune images")
            errors.append({"step": "unused_images", "error": str(e)})

    if body.unused_networks:
        try:
            results["unused_networks"] = d.prune_unused_networks()
        except Exception as e:
            logger.exception("admin prune networks")
            errors.append({"step": "unused_networks", "error": str(e)})

    if results:
        _invalidate_after_mutation()
    return {"ok": len(errors) == 0, "results": results, "errors": errors}

def brand_logo_file_response() -> FileResponse:
    """Resposta HTTP do arquivo de marca (logo/logo.png ou static/logo.png)."""
    resolved = resolve_brand_logo_file()
    if resolved is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "Logo não encontrado. Crie os arquivos logo/logo.png ou static/logo.png "
                "na raiz do projeto (mesmo nível da pasta app)."
            ),
        )
    path, media_type = resolved
    return FileResponse(path, media_type=media_type)


@app.get("/logo/logo.png")
def serve_brand_logo_png() -> FileResponse:
    """Serve o logo da marca (também usa arquivo equivalente em static/ durante o desenvolvimento)."""
    return brand_logo_file_response()


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    """Mesmo símbolo do logo; atende pedidos automáticos a /favicon.ico."""
    return brand_logo_file_response()


@app.get("/")
def root() -> FileResponse:
    idx = STATIC / "index.html"
    if not idx.exists():
        raise HTTPException(500, "UI estática não encontrada")
    return FileResponse(idx)

app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8787, reload=True, access_log=False)
