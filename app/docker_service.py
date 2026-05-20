
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import docker
from docker.errors import DockerException, ImageNotFound, NotFound

logger = logging.getLogger("dashflex.docker_service")

def _cpu_percent_unix(stats: dict[str, Any]) -> float:
    cpu_stats = stats.get("cpu_stats") or {}
    pre_cpu = stats.get("precpu_stats") or {}
    cpu_usage = cpu_stats.get("cpu_usage") or {}
    pre_usage = pre_cpu.get("cpu_usage") or {}
    delta_usage = cpu_usage.get("total_usage", 0) - pre_usage.get("total_usage", 0)
    system_usage = cpu_stats.get("system_cpu_usage", 0) - pre_cpu.get("system_cpu_usage", 0)
    cpus = cpu_stats.get("online_cpus") or 0
    if cpus == 0:
        percpu = cpu_usage.get("percpu_usage") or []
        cpus = max(len(percpu), 1)
    if system_usage <= 0 or delta_usage < 0:
        return 0.0
    return round((delta_usage / system_usage) * cpus * 100.0, 2)

def _memory_usage_bytes(ms: dict[str, Any]) -> int | None:
    u = ms.get("usage")
    if isinstance(u, (int, float)) and u >= 0:
        return int(u)
    st = ms.get("stats")
    if isinstance(st, dict):
        anon = st.get("anon")
        if isinstance(anon, (int, float)) and anon >= 0:
            fm = st.get("file_mapped")
            extra = int(fm) if isinstance(fm, (int, float)) and fm > 0 else 0
            return int(anon) + extra
    return None

def _mem_usage_ratio(stats: dict[str, Any]) -> tuple[float, int | None]:
    ms = stats.get("memory_stats") or {}
    usage = _memory_usage_bytes(ms)
    limit = ms.get("limit")
    limit_i = int(limit) if isinstance(limit, (int, float)) and limit > 0 else None
    if usage is None or limit_i is None or limit_i <= 0:
        return 0.0, limit_i
    return round((usage / limit_i) * 100.0, 2), limit_i

def _network_rx_tx_bytes(stats: dict[str, Any]) -> tuple[int, int]:
    nw = stats.get("networks") or {}
    rx = tx = 0
    if isinstance(nw, dict):
        for vals in nw.values():
            if isinstance(vals, dict):
                rx += int(vals.get("rx_bytes") or 0)
                tx += int(vals.get("tx_bytes") or 0)
    return rx, tx

def _ports_brief_from_network_settings(nw: dict[str, Any], limit: int = 8) -> list[str]:
    raw = nw.get("Ports")
    brief: list[str] = []
    if not raw:
        return brief

    if isinstance(raw, dict):
        for key in sorted(raw.keys()):
            if len(brief) >= limit:
                break
            bindings = raw[key]
            parts = key.split("/")
            priv = parts[0] if parts else key
            proto = parts[1] if len(parts) > 1 else "tcp"

            if not bindings:
                brief.append(priv)
                continue
            if isinstance(bindings, list):
                for b in bindings:
                    if len(brief) >= limit:
                        break
                    if not isinstance(b, dict):
                        continue
                    ip = (b.get("HostIp") or "").strip() or "0.0.0.0"
                    hp = str(b.get("HostPort") or "").strip()
                    if hp:
                        brief.append(f"{ip}:{hp}->{priv}/{proto}")
                    elif priv:
                        brief.append(priv)

    elif isinstance(raw, list):
        for p in raw[:limit]:
            if not p or not isinstance(p, dict):
                continue
            priv = str(p.get("PrivatePort") or "")
            pub = p.get("PublicPort")
            ip = "0.0.0.0"
            if pub:
                brief.append(f"{ip}:{pub}->{priv}/{p.get('Type', 'tcp')}")
            elif priv:
                brief.append(priv)

    return brief

def _ports_brief_from_summary_ports(raw: Any, limit: int = 8) -> list[str]:
    brief: list[str] = []
    if not isinstance(raw, list):
        return brief
    for p in raw:
        if len(brief) >= limit:
            break
        if not isinstance(p, dict):
            continue
        priv = str(p.get("PrivatePort") or "")
        pub = p.get("PublicPort")
        ip = (p.get("IP") or "").strip() or "0.0.0.0"
        typ = str(p.get("Type") or "tcp")
        if pub:
            brief.append(f"{ip}:{pub}->{priv}/{typ}" if priv else f"{ip}:{pub}/{typ}")
        elif priv:
            brief.append(priv)
    return brief

def _image_id_hex(image_id: str) -> str:
    s = str(image_id or "").strip().lower()
    if s.startswith("sha256:"):
        return s[7:]
    return s

@dataclass
class DockerSvc:
    client: docker.DockerClient

    @classmethod
    def from_env(cls) -> DockerSvc:
        return cls(client=docker.from_env())

    @classmethod
    def from_base_url(cls, base_url: str) -> DockerSvc:
        return cls(client=docker.DockerClient(base_url=base_url))

    def ping(self) -> bool:
        try:
            if self.client.ping():
                return True
        except Exception:
            pass
        try:
            self.client.version()
            return True
        except Exception:
            return False

    def info(self) -> dict[str, Any]:
        raw = self.client.info()
        return {
            "name": raw.get("Name") or raw.get("Name", "Docker Host"),
            "containers": raw.get("Containers", 0),
            "containers_running": raw.get("ContainersRunning", 0),
            "containers_paused": raw.get("ContainersPaused", 0),
            "containers_stopped": raw.get("ContainersStopped", 0),
            "images": raw.get("Images", 0),
            "server_version": raw.get("ServerVersion", ""),
            "operating_system": raw.get("OperatingSystem", ""),
            "architecture": raw.get("Architecture", ""),
            "cpus": raw.get("NCPU", 0),
            "mem_total_mb": round((raw.get("MemTotal", 0) or 0) / (1024**2), 1),
            "docker_root": raw.get("DockerRootDir"),
        }

    def list_containers(self, all_: bool = True) -> list[dict[str, Any]]:
        try:
            rows_raw = self.client.api.containers(all=all_)
        except DockerException:
            logger.exception("list_containers: api.containers falhou")
            return []

        containers: list[dict[str, Any]] = []
        for row in rows_raw:
            try:
                cid_full = str(row.get("Id") or "").strip()
                if not cid_full:
                    continue

                names = row.get("Names") or []
                name = (names[0] if names else "").lstrip("/")

                img = str(row.get("Image") or "").strip()
                if not img:
                    iid = str(row.get("ImageID") or "").strip()
                    img = iid[:12] if iid else cid_full[:12]

                status = str(row.get("Status") or "")
                state_kind = str(row.get("State") or "").strip().lower()

                health_status: str | None = None
                health_obj = row.get("Health")
                if isinstance(health_obj, dict):
                    hs = str(health_obj.get("Status") or "").strip().lower()
                    if hs:
                        health_status = hs

                mounts_raw = row.get("Mounts") or []
                if isinstance(mounts_raw, list):
                    mounts = [str(m.get("Destination", "")) for m in mounts_raw if isinstance(m, dict)][:5]
                else:
                    mounts = []

                nw = row.get("NetworkSettings") or {}
                net_names = list((nw.get("Networks") or {}).keys()) if isinstance(nw, dict) else []

                ports_brief = _ports_brief_from_summary_ports(row.get("Ports"), limit=8)

                created_val = row.get("Created")
                if isinstance(created_val, (int, float)):
                    created = datetime.fromtimestamp(float(created_val), tz=UTC).isoformat()
                else:
                    created = str(created_val or "")

                containers.append(
                    {
                        "id": cid_full[:12],
                        "id_full": cid_full,
                        "name": name,
                        "image": img,
                        "status": status,
                        "state": state_kind,
                        "state_kind": state_kind,
                        "health": health_status,
                        "created": created,
                        "ports": ports_brief,
                        "networks": net_names,
                        "mounts": mounts,
                    }
                )
            except Exception:
                logger.exception("list_containers: ignorar linha summary")

        return containers

    def _running_container_summaries(self) -> list[dict[str, Any]]:
        try:
            rows = self.client.api.containers(all=False)
        except DockerException:
            logger.exception("running summaries all=false")
            rows = []
        if rows:
            return rows
        try:
            alt = self.client.api.containers(all=True, filters={"status": ["running"]})
            return alt if isinstance(alt, list) else []
        except DockerException:
            logger.exception("running summaries filtros status=running")
            return []

    def container_stats_snapshot(self, container_id: str, *, cpu_retry: bool = True) -> dict[str, Any]:
        c = self.client.containers.get(container_id)
        stats = c.stats(stream=False)
        cpu = _cpu_percent_unix(stats)
        pre_cpu = stats.get("precpu_stats") or {}
        if cpu_retry and cpu == 0.0 and not pre_cpu.get("cpu_usage"):
            time.sleep(0.1)
            stats = c.stats(stream=False)
            cpu = _cpu_percent_unix(stats)

        mem_pct, mem_limit = _mem_usage_ratio(stats)
        ms = stats.get("memory_stats") or {}
        usage_b = _memory_usage_bytes(ms)
        kb = round(usage_b / 1024.0, 2) if usage_b is not None else 0.0

        rx, tx = _network_rx_tx_bytes(stats)

        return {
            "cpu_percent": cpu,
            "mem_percent": mem_pct,
            "mem_kb_resident": kb,
            "mem_limit_bytes": mem_limit,
            "network_rx_mb": round(rx / (1024**2), 3),
            "network_tx_mb": round(tx / (1024**2), 3),
        }

    def top_container_stats(self, limit: int = 15, *, cpu_retry: bool = True) -> list[dict[str, Any]]:
        running_rows = cached_running_summaries(self)
        cap = min(len(running_rows), max(limit, 1))
        scan = running_rows[:cap]

        def snap_row(row: dict[str, Any]) -> dict[str, Any] | None:
            cid = row.get("Id")
            if not cid:
                return None
            names = row.get("Names") or []
            name = (names[0] if names else "").lstrip("/")
            try:
                s = self.container_stats_snapshot(cid, cpu_retry=cpu_retry)
                s["id"] = str(cid)[:12]
                s["id_full"] = cid
                s["name"] = name
                return s
            except NotFound:
                logger.warning("stats de container não encontrados %s", str(cid)[:12])
                return None
            except DockerException as e:
                logger.warning("stats DockerException %s: %s", str(cid)[:12], e)
                return None
            except Exception as e:
                logger.warning("stats falhou %s: %s", str(cid)[:12], e)
                return None

        if not scan:
            return []

        workers = min(10, max(1, len(scan)))
        snap: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(snap_row, row) for row in scan]
            for fut in as_completed(futures):
                got = fut.result()
                if got:
                    snap.append(got)

        by_cpu = sorted(snap, key=lambda x: x.get("cpu_percent", 0), reverse=True)[:limit]
        return by_cpu

    def list_images(self) -> list[dict[str, Any]]:
        running_hex: set[str] = set()
        try:
            for row in self._running_container_summaries():
                iid = str(row.get("ImageID") or "").strip()
                if iid:
                    running_hex.add(_image_id_hex(iid))
        except DockerException:
            logger.exception("list_images: api.containers(running)")

        try:
            raw_list = self.client.api.images()
        except DockerException:
            logger.exception("list_images: api.images")
            return []

        if not isinstance(raw_list, list):
            raw_list = []

        out: list[dict[str, Any]] = []
        for img in raw_list:
            if not isinstance(img, dict):
                continue
            rid = str(img.get("Id") or "").strip()
            tags_raw = img.get("RepoTags")
            if tags_raw is None:
                tags: list[str] = []
            elif isinstance(tags_raw, list):
                tags = [str(t).strip() for t in tags_raw if t is not None and str(t).strip()]
            else:
                tags = []
            if not tags:
                tags = [rid[:12] if rid else "<sem id>"]
            try:
                size = int(img.get("Size") or 0)
            except (TypeError, ValueError):
                size = 0
            created_raw = img.get("Created")
            if isinstance(created_raw, (int, float)):
                created = datetime.fromtimestamp(int(created_raw), tz=UTC).isoformat()
            else:
                created = str(created_raw or "").strip()
            short = rid[:12] if rid else ""
            rid_hex = _image_id_hex(rid)
            used_running = bool(rid_hex and rid_hex in running_hex)
            out.append(
                {
                    "id": short,
                    "id_full": rid,
                    "tags": tags[:4],
                    "size_mb": round(size / (1024**2), 2),
                    "created": created,
                    "used_by_running_container": used_running,
                }
            )
        return sorted(out, key=lambda x: (x["tags"][0] or "").lower())

    def system_df(self) -> dict[str, Any]:
        try:
            return self.client.df()
        except DockerException:
            return {}

    def prune_dangling_images(self) -> dict[str, Any]:
        try:
            out = self.client.images.prune(filters={"dangling": True})
            return dict(out) if isinstance(out, dict) else {"raw": out}
        except DockerException:
            logger.exception("prune_dangling_images")
            raise

    def prune_stopped_containers(self) -> dict[str, Any]:
        try:
            out = self.client.containers.prune()
            return dict(out) if isinstance(out, dict) else {"raw": out}
        except DockerException:
            logger.exception("prune_stopped_containers")
            raise

    def prune_unused_networks(self) -> dict[str, Any]:
        try:
            out = self.client.networks.prune()
            return dict(out) if isinstance(out, dict) else {"raw": out}
        except DockerException:
            logger.exception("prune_unused_networks")
            raise

    def start(self, container_id: str) -> None:
        c = self.client.containers.get(container_id)
        c.start()

    def stop(self, container_id: str, timeout: int = 10) -> None:
        c = self.client.containers.get(container_id)
        c.stop(timeout=timeout)

    def restart(self, container_id: str, timeout: int = 10) -> None:
        c = self.client.containers.get(container_id)
        c.restart(timeout=timeout)

    def remove(self, container_id: str, force: bool = False) -> None:
        c = self.client.containers.get(container_id)
        c.reload()
        state = (c.attrs or {}).get("State") or {}
        if state.get("Running") or state.get("Restarting") or state.get("Paused"):
            raise ValueError("Pare o container antes de removê-lo.")
        c.remove(force=force)

    def list_running_containers_for_image(self, image_ref: str) -> list[str]:
        img = self.client.images.get(image_ref)
        target_id = str(getattr(img, "id", None) or "").strip()
        if not target_id:
            return []
        names: list[str] = []
        for c in self.client.containers.list(all=False):
            try:
                cid = str(c.image.id or "").strip()
            except (DockerException, AttributeError):
                continue
            if cid == target_id:
                names.append((c.name or "").lstrip("/"))
        return sorted(names)

    def remove_image(self, image_ref: str, force: bool = False) -> None:
        self.client.images.remove(image_ref, force=force)

    def logs(self, container_id: str, tail: int = 200) -> str:
        c = self.client.containers.get(container_id)
        data = c.logs(tail=tail, timestamps=True)
        if isinstance(data, bytes):
            return data.decode("utf-8", errors="replace")
        return str(data)

    def logs_stream(self, container_id: str, *, tail: int = 200) -> Iterator[str]:
        c = self.client.containers.get(container_id)
        for chunk in c.logs(tail=tail, follow=True, timestamps=True, stream=True):
            if isinstance(chunk, bytes):
                text = chunk.decode("utf-8", errors="replace")
            else:
                text = str(chunk)
            if text:
                yield text

    def inspect(self, container_id: str) -> dict[str, Any]:
        c = self.client.containers.get(container_id)
        return c.attrs

_svc: DockerSvc | None = None
_cached_key: str | None = None

_ping_ok: bool = False
_ping_until: float = 0.0
_PING_TTL = 2.5

_info_cache: dict[str, Any] | None = None
_info_until: float = 0.0
_INFO_TTL = 3.0

_running_cache: list[dict[str, Any]] | None = None
_running_until: float = 0.0
_RUNNING_TTL = 2.5


def invalidate_docker_caches() -> None:
    global _ping_until, _info_cache, _info_until, _running_cache, _running_until
    _ping_until = 0.0
    _info_cache = None
    _info_until = 0.0
    _running_cache = None
    _running_until = 0.0


def ping_cached(svc: DockerSvc, *, ttl: float = _PING_TTL) -> bool:
    global _ping_ok, _ping_until
    now = time.monotonic()
    if now < _ping_until:
        return _ping_ok
    _ping_ok = svc.ping()
    _ping_until = now + ttl
    return _ping_ok


def cached_info(svc: DockerSvc, *, ttl: float = _INFO_TTL) -> dict[str, Any]:
    global _info_cache, _info_until
    now = time.monotonic()
    if _info_cache is not None and now < _info_until:
        return _info_cache
    _info_cache = svc.info()
    _info_until = now + ttl
    return _info_cache


def cached_running_summaries(svc: DockerSvc, *, ttl: float = _RUNNING_TTL) -> list[dict[str, Any]]:
    global _running_cache, _running_until
    now = time.monotonic()
    if _running_cache is not None and now < _running_until:
        return _running_cache
    _running_cache = svc._running_container_summaries()
    _running_until = now + ttl
    return _running_cache


def reset_docker_client() -> None:
    global _svc, _cached_key
    invalidate_docker_caches()
    if _svc is not None:
        try:
            _svc.client.close()
        except Exception:
            pass
    _svc = None
    _cached_key = None

def get_docker() -> DockerSvc:
    global _svc, _cached_key
    from app.settings_store import effective_docker_base_url

    target = effective_docker_base_url()
    norm = target.strip() if target else "__from_env__"
    if _svc is not None and _cached_key == norm:
        return _svc
    if _svc is not None:
        try:
            _svc.client.close()
        except Exception:
            pass
        _svc = None
    if target:
        _svc = DockerSvc.from_base_url(target.strip())
    else:
        _svc = DockerSvc.from_env()
    _cached_key = norm
    return _svc
