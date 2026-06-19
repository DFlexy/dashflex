

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const IC = {
  play: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 6.82v10.36L18.06 12z"/></svg>`,
  stop: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>`,
  restart: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M1 4v6h6"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  trash: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 002 2h8a2 2 0 002-2V9H6v10zm12-13h-4.5l-1.12-2.25A2 2 0 009.6 6H14V4h-4v2h-.81C8.43 6 8 6.52 8.15 7.05l1 3.05z"/></svg>`,
  logs: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 6h16M4 11h16M4 16h11"/></svg>`,
  logsLive: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 6h16M4 11h16M4 16h11"/><circle cx="19" cy="5" r="3" fill="currentColor" stroke="none"/></svg>`,
  pencil: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-width="2" d="M4 21h16"/><path stroke="currentColor" stroke-width="2" d="M16 4l5 5-12 13H6v-5z"/></svg>`,
};

let lastContainers = [];

let containerSort = { key: "name", dir: "asc" };

let lastDashBookmarks = [];
let lastDashBookmarkContainers = [];
let dashDragBookmarkEl = null;

const MAX_DASH_BOOKMARKS = 48;

const DEFAULT_APP_DISPLAY_NAME = "DashFlex";
const t = (key, params) => window.DashFlexI18n.t(key, params);

const UI_THEMES = new Set(["glass", "frost"]);
const DEFAULT_UI_THEME = "glass";
const UI_THEME_STORAGE_KEY = "dashflex_ui_theme";

function normalizeUiTheme(themeId) {
  if (themeId === "aurora") return "frost";
  return UI_THEMES.has(themeId) ? themeId : DEFAULT_UI_THEME;
}

function applyUiTheme(themeId, { persistLocal = true } = {}) {
  const id = normalizeUiTheme(themeId);
  document.documentElement.dataset.theme = id;
  if (persistLocal) {
    try {
      localStorage.setItem(UI_THEME_STORAGE_KEY, id);
    } catch (_) {}
  }
}

function applyUiThemeFromSettings(s) {
  const raw = s && typeof s.ui_theme === "string" ? s.ui_theme.trim() : "";
  applyUiTheme(raw || DEFAULT_UI_THEME);
}

function syncAdminUiThemeUi(themeId) {
  const sel = $("#adminUiTheme");
  if (!sel) return;
  sel.value = normalizeUiTheme(themeId);
}

function syncAdminUiLanguageUi(lang) {
  const sel = $("#adminUiLanguage");
  if (!sel) return;
  const safe = lang === "en" || lang === "pt" ? lang : window.DashFlexI18n.getLocale();
  sel.value = safe === "en" ? "en" : "pt";
}

function applyUiLanguageFromSettings(s) {
  const lang = s && typeof s.ui_language === "string" ? s.ui_language.trim().toLowerCase() : "";
  if (lang === "pt" || lang === "en") {
    window.DashFlexI18n.setLocale(lang, { persistLocal: true });
    return;
  }
  window.DashFlexI18n.initLocale();
}

function refreshUiAfterLocaleChange() {
  updateContainerSortHeaders();
  if (isOverviewVisible()) void loadOverviewLive().catch(() => loadDashboard());
  if (!$("#view-containers")?.classList.contains("hidden")) loadContainers();
  if (!$("#view-images")?.classList.contains("hidden")) loadImages();
  if (!$("#view-dash")?.classList.contains("hidden")) loadDashBookmarks();
  if (!$("#view-admin")?.classList.contains("hidden")) {
    loadAdmin();
  } else {
    const pingBadge = $("#adminPingBadge");
    if (pingBadge) {
      const connected = pingBadge.classList.contains("admin-chip--ok");
      pingBadge.textContent = connected ? t("admin.docker.connected") : t("admin.docker.disconnected");
    }
  }
  window.DashFlexI18n.applyI18n(document);
}

let dashBmPreviewUrl = null;
let dashBmObjectUrl = null;
let dashBmHadServerImage = false;
let dashBmRemoveIconOnSave = false;

let overviewLiveMs = 6000;
let overviewLiveIntervalId = null;
let overviewRefreshTimer = null;

let logsLiveAbort = null;

function isOverviewVisible() {
  return !$("#view-overview")?.classList.contains("hidden");
}

function updateDockerMetaFromKpis(kpis) {
  const meta = $("#dockerMeta");
  if (!meta || !kpis) return;
  meta.textContent = t("docker.meta.kpi", {
    version: kpis.server_version || "",
    images: kpis.total_images ?? 0,
  });
}

async function refreshDockerMeta() {
  try {
    const r = await fetch("/api/docker/status");
    if (!r.ok) return;
    const sj = await r.json().catch(() => null);
    const meta = $("#dockerMeta");
    if (!meta) return;
    if (!sj?.connected) {
      meta.textContent = t("docker.meta.disconnected");
      return;
    }
    meta.textContent = sj.server_version
      ? t("docker.meta.connected_version", { version: sj.server_version })
      : t("docker.meta.connected");
  } catch (_) {
  }
}

function applyOverviewPayload(data) {
  if (data.kpis) {
    renderKpis(data.kpis);
    updateDockerMetaFromKpis(data.kpis);
  }
  renderHostTable(data.host);
  renderOverviewBars(data.top_cpu);
}

function applyBrandingFromSettings(s) {
  const raw = s && typeof s.app_display_name === "string" ? s.app_display_name.trim() : "";
  const name = raw || DEFAULT_APP_DISPLAY_NAME;
  const brandEl = $(".brand");
  if (brandEl) brandEl.textContent = name;
  document.title = `${name} ${t("branding.title_suffix")}`;
}

/** Mostra logo em logo/logo.png ao lado do nome; mantém oculto se o arquivo não existir. */
function wireBrandLogo() {
  const img = $("#brandLogo");
  const wrap = $("#brandMark");
  if (!img || !wrap) return;
  const reveal = () => {
    wrap.hidden = false;
  };
  const conceal = () => {
    wrap.hidden = true;
  };
  img.addEventListener("load", reveal);
  img.addEventListener("error", conceal);
  if (img.complete) {
    if (img.naturalWidth > 0) reveal();
    else conceal();
  }
}

function clampDashBookmarkCardScalePct(v) {
  let n = Math.round(Number(v));
  if (!Number.isFinite(n)) n = 100;
  return Math.min(140, Math.max(70, n));
}

function applyDashBookmarkCardScaleFromSettings(s) {
  const g = $("#dashGrid");
  if (!g) return;
  let pct = 100;
  if (s && s.dash_bookmark_card_scale_percent != null) {
    pct = clampDashBookmarkCardScalePct(s.dash_bookmark_card_scale_percent);
  }
  g.style.setProperty("--dash-s", String(pct / 100));
}

function syncAdminDashCardScaleUi(pct) {
  const v = clampDashBookmarkCardScalePct(pct);
  const rng = $("#adminDashCardScale");
  const lab = $("#adminDashCardScaleVal");
  if (rng) rng.value = String(v);
  if (lab) lab.textContent = String(v);
}

function unwrapStaleLiquidGlassWrapper() {
  document.body.classList.remove("theme-liquid", "theme-glass", "liquid-ready");
  const ge = document.getElementById("liquidMainGlass");
  const main = document.querySelector("main.content");
  const col = document.getElementById("mainColumn");
  if (ge && main && col && main.parentElement === ge) {
    col.insertBefore(main, ge);
    ge.remove();
  }
}

function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text == null ? "" : String(text);
  return d.innerHTML;
}

function escapeAttr(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/'/g, "&#39;");
}

function apiDetailMessage(data, fallback) {
  if (!data || typeof data !== "object") return fallback;
  const d = data.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d.length) {
    const first = d[0];
    if (typeof first === "string") return first;
    if (first && typeof first.msg === "string") return first.msg;
  }
  return fallback;
}

async function dockerDisconnectedHint() {
  try {
    const st = await fetch("/api/docker/status");
    if (!st.ok) return "";
    const sj = await st.json().catch(() => ({}));
    return !sj.connected && sj.hint ? " " + sj.hint : "";
  } catch (_) {
    return "";
  }
}

function imageCardTitle(im) {
  const tags = Array.isArray(im?.tags) ? im.tags : [];
  const line = tags.map((t) => (t != null ? String(t) : "")).filter((s) => s.trim()).join(", ");
  const ref = String(im?.id_full || im?.id || "").trim();
  return line || ref || t("images.no_tag");
}

function formatImageSizeMb(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Toque no SVG interno nem sempre dispara click no celular; touchend + dedupe com click. */
function wireTapClick(btn, handler, opts = {}) {
  if (!btn) return;
  const stopProp = !!opts.stopPropagation;
  let lastTouch = 0;
  const run = (ev) => {
    ev?.preventDefault?.();
    if (stopProp) ev?.stopPropagation?.();
    handler(ev);
  };
  btn.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      if (stopProp) e.stopPropagation();
      lastTouch = Date.now();
      run(e);
    },
    { passive: false },
  );
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (stopProp) e.stopPropagation();
    if (Date.now() - lastTouch < 500) return;
    run(e);
  });
}

function wireImageRemoveButton(btn, ref, labelFn) {
  wireTapClick(btn, () => {
    void removeDockerImage(ref, labelFn());
  });
}

function appendImageCard(grid, im) {
  const card = document.createElement("div");
  card.className = "image-card";

  const titleText = imageCardTitle(im);
  const h3 = document.createElement("h3");
  h3.textContent = titleText;

  const ref = String(im?.id_full || im?.id || "").trim();
  const sid = String(im?.id || "").trim() || ref.slice(0, 12) || "—";
  const mb = formatImageSizeMb(im?.size_mb);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = t("images.meta", { size: Number.isFinite(mb) ? mb : "?", id: sid });

  const actions = document.createElement("div");
  actions.className = "image-card-actions";
  const inUseRunning = !!im.used_by_running_container;
  if (ref && !inUseRunning) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-danger-outline btn-compact";
    btn.dataset.act = "image-remove";
    btn.dataset.imageRef = ref;
    btn.title = t("images.delete_title");
    btn.setAttribute("aria-label", t("images.delete_aria"));
    btn.innerHTML = `${IC.trash}<span class="btn-text-after">${escapeHtml(t("images.delete"))}</span>`;
    wireImageRemoveButton(btn, ref, () => imageCardTitle(im));
    actions.appendChild(btn);
  } else if (inUseRunning) {
    const badge = document.createElement("span");
    badge.className = "image-running-badge";
    badge.textContent = t("images.running");
    badge.title = t("images.running_tooltip");
    actions.appendChild(badge);
  } else {
    const hint = document.createElement("p");
    hint.className = "muted small";
    hint.style.margin = "0";
    hint.textContent = t("images.ref_unavailable");
    actions.appendChild(hint);
  }

  card.appendChild(h3);
  card.appendChild(meta);
  card.appendChild(actions);
  grid.appendChild(card);
}

const NAV_VIEWS = new Set(["dash", "overview", "containers", "images", "admin"]);
const STORAGE_NAV_KEY = "dashflex_nav_view";

function viewFromLocationHash() {
  const raw = (location.hash || "").replace(/^#/, "").trim().toLowerCase();
  return NAV_VIEWS.has(raw) ? raw : null;
}

function syncLocationHashForView(name) {
  const safe = NAV_VIEWS.has(name) ? name : "dash";
  const url = `${location.pathname}${location.search}#${safe}`;
  if (location.hash !== `#${safe}`) history.replaceState(null, "", url);
}

function showView(name, opts = {}) {
  const safe = NAV_VIEWS.has(name) ? name : "dash";
  $$(".view").forEach((v) => v.classList.add("hidden"));
  const el = document.getElementById(`view-${safe}`);
  if (el) el.classList.remove("hidden");
  $$(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === safe);
  });
  try {
    sessionStorage.setItem(STORAGE_NAV_KEY, safe);
  } catch (_) {
  }
  if (!opts.skipHash) syncLocationHashForView(safe);
}

function restoreInitialView() {
  const validHash = viewFromLocationHash();
  if (validHash) {
    showView(validHash, { skipHash: true });
    return validHash;
  }
  const frag = (location.hash || "").replace(/^#/, "").trim();
  if (frag) {
    showView("dash", { skipHash: false });
    return "dash";
  }
  let saved = null;
  try {
    saved = sessionStorage.getItem(STORAGE_NAV_KEY);
  } catch (_) {
  }
  const initial = NAV_VIEWS.has(saved) ? saved : "dash";
  showView(initial, { skipHash: false });
  return initial;
}

function loadViewPrimaryData(name) {
  if (name !== "overview") stopOverviewLive();
  if (name === "overview") {
    void loadDashboard().then(() => scheduleOverviewLive());
    return;
  }
  if (name === "containers") loadContainers();
  if (name === "dash") loadDashBookmarks();
  if (name === "images") loadImages();
  if (name === "admin") loadAdmin();
}

function formatPorts(ports) {
  if (!ports || !ports.length) return "—";
  return escapeHtml(ports.slice(0, 4).join(", ") + (ports.length > 4 ? "…" : ""));
}

function runningClass(status) {
  const s = (status || "").toLowerCase();
  return s.includes("running") || s.includes("up") ? "on" : "off";
}

function containerRowClass(c) {
  const sk = String(c.state_kind || "").toLowerCase();
  if (sk === "running") return "container-row container-row--running";
  if (sk === "paused") return "container-row container-row--paused";
  if (sk === "restarting") return "container-row container-row--restarting";
  if (sk === "exited" || sk === "dead") return "container-row container-row--stopped";
  return "container-row container-row--other";
}

function statusDotClass(c) {
  const sk = String(c.state_kind || "").toLowerCase();
  if (sk === "running") return "on";
  if (sk === "paused") return "paused";
  if (sk === "restarting") return "restarting";
  if (sk === "exited" || sk === "dead") return "off";
  return runningClass(c.status) === "on" ? "on" : "off";
}

function stateBadgeLabel(kind) {
  const k = String(kind || "").toLowerCase();
  const MAP = {
    running: t("state.running"),
    exited: t("state.exited"),
    paused: t("state.paused"),
    restarting: t("state.restarting"),
    dead: t("state.dead"),
    created: t("state.created"),
    removing: t("state.removing"),
  };
  if (MAP[k]) return MAP[k];
  if (!k) return t("state.unknown");
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function renderStateCell(c) {
  const kind = String(c.state_kind || "").toLowerCase();
  const safeKind = kind.replace(/[^a-z0-9_-]/g, "") || "unknown";
  const badgeClass = `badge badge-state badge-state--${safeKind}`;
  const label = stateBadgeLabel(kind);
  return `
    <div class="cell-stack">
      <span class="${badgeClass}">${escapeHtml(label)}</span>
      <span class="muted">${escapeHtml(c.status || "—")}</span>
    </div>`;
}

function healthLabelText(hRaw) {
  if (hRaw == null || hRaw === "") return "";
  const hk = String(hRaw).toLowerCase();
  const MAP = {
    healthy: t("health.healthy"),
    unhealthy: t("health.unhealthy"),
    starting: t("health.starting"),
  };
  return MAP[hk] || String(hRaw);
}

function renderHealthCell(c) {
  const h = c.health;
  if (h == null || h === "") {
    return `<span class="badge badge-health badge-health--na" title="${escapeAttr(t("health.none_tooltip"))}">${escapeHtml(t("health.none"))}</span>`;
  }
  const hk = String(h).toLowerCase();
  const safe = hk.replace(/[^a-z0-9_-]/g, "") || "unknown";
  const label = escapeHtml(healthLabelText(h));
  return `<span class="badge badge-health badge-health--${safe}" title="${escapeAttr(h)}">${label}</span>`;
}

function compareContainers(a, b, sortKey, dir) {
  const mul = dir === "asc" ? 1 : -1;
  let va = "";
  let vb = "";
  switch (sortKey) {
    case "name":
      va = String(a.name || "");
      vb = String(b.name || "");
      break;
    case "image":
      va = String(a.image || "");
      vb = String(b.image || "");
      break;
    case "state":
      va = `${stateBadgeLabel(a.state_kind)} ${a.status || ""}`.trim();
      vb = `${stateBadgeLabel(b.state_kind)} ${b.status || ""}`.trim();
      break;
    case "health":
      va = healthLabelText(a.health) || t("health.none");
      vb = healthLabelText(b.health) || t("health.none");
      break;
    case "ports":
      va = Array.isArray(a.ports) ? a.ports.join(", ") : "";
      vb = Array.isArray(b.ports) ? b.ports.join(", ") : "";
      break;
    case "actions":
      va = String(a.id_full || a.id || "");
      vb = String(b.id_full || b.id || "");
      break;
    default:
      va = String(a.name || "");
      vb = String(b.name || "");
  }
  let cmp = va.localeCompare(vb, undefined, { sensitivity: "base", numeric: true });
  if (cmp !== 0) return mul * cmp;
  cmp = String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base", numeric: true });
  return mul * cmp;
}

function updateContainerSortHeaders() {
  $$("#containersTable thead .th-sort").forEach((btn) => {
    const k = btn.dataset.sort;
    const active = k === containerSort.key;
    btn.classList.toggle("active", active);
    btn.classList.toggle("asc", active && containerSort.dir === "asc");
    btn.classList.toggle("desc", active && containerSort.dir === "desc");
    const ind = btn.querySelector(".sort-ind");
    if (ind) ind.textContent = active ? (containerSort.dir === "asc" ? " A→Z" : " Z→A") : "";
  });
}

function containerProtectedFromRemove(c) {
  const sk = String(c.state_kind || "").toLowerCase();
  return sk === "running" || sk === "restarting" || sk === "paused";
}

function buildContainerRowHtml(c) {
  const prot = containerProtectedFromRemove(c);
  const removeTitle = prot ? t("containers.action.remove_blocked") : t("containers.action.remove");
  return `
    <tr class="${containerRowClass(c)}" data-id="${escapeAttr(c.id_full)}" data-name="${escapeAttr(c.name)}">
      <td class="status-cell"><span class="status-dot ${statusDotClass(c)}" title="${escapeAttr(c.status)}"></span></td>
      <td><strong>${escapeHtml(c.name)}</strong><br><span class="muted">${escapeHtml(c.id)}</span></td>
      <td>${escapeHtml(c.image)}</td>
      <td class="status-detail-cell">${renderStateCell(c)}</td>
      <td class="health-cell">${renderHealthCell(c)}</td>
      <td>${formatPorts(c.ports)}</td>
      <td class="actions-cell">
        <div class="actions-toolbar" role="group" aria-label="${escapeAttr(t("containers.actions.group"))}">
        ${icoBtn("start", t("containers.action.start"), IC.play)}
        ${icoBtn("stop", t("containers.action.stop"), IC.stop)}
        ${icoBtn("restart", t("containers.action.restart"), IC.restart)}
        ${icoBtn("remove", removeTitle, IC.trash, "btn-danger", { disabled: prot })}
        ${icoBtn("logs", t("containers.action.logs"), IC.logs, "primary")}
        </div>
      </td>
    </tr>`;
}

function renderContainerTableBody() {
  const tb = $("#containersTable tbody");
  if (!tb) return;
  if (!lastContainers.length) {
    tb.innerHTML = "";
    return;
  }
  const sorted = [...lastContainers].sort((a, b) =>
    compareContainers(a, b, containerSort.key, containerSort.dir)
  );
  tb.innerHTML = sorted.map((c) => buildContainerRowHtml(c)).join("");
  updateContainerSortHeaders();
}

function barClass(kind) {
  if (kind === "warn") return "warn";
  if (kind === "danger") return "danger";
  return "ok";
}

function icoBtn(act, title, html, variant = "", opts = {}) {
  const extra = variant ? ` ${variant}` : "";
  const dis = opts.disabled ? " disabled" : "";
  const ariaDis = opts.disabled ? ' aria-disabled="true"' : "";
  return `<button type="button" class="btn btn-ico${extra}" data-act="${act}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}"${dis}${ariaDis}>${html}</button>`;
}

function renderKpis(kpis) {
  const row = $("#kpiRow");
    row.innerHTML = `
    <div class="kpi-card c1"><div class="label">${escapeHtml(t("kpi.containers_active"))}</div><div class="value">${kpis.containers_active}</div></div>
    <div class="kpi-card c2"><div class="label">${escapeHtml(t("kpi.containers_inactive"))}</div><div class="value">${kpis.containers_inactive}</div></div>
    <div class="kpi-card c3"><div class="label">${escapeHtml(t("kpi.images_active"))}</div><div class="value">${kpis.images_active}</div></div>
    <div class="kpi-card c4"><div class="label">${escapeHtml(t("kpi.images_inactive"))}</div><div class="value">${kpis.images_inactive}</div></div>
  `;
}

function renderHostTable(h) {
  const hostTableEl = $("#hostTable");
  if (!h) {
    hostTableEl.innerHTML = "";
    return;
  }
  const row = (label, pct, bar) => `
    <tr>
      <th>${label}</th>
      <td>${pct}%</td>
      <td class="bar-cell">
        <div class="progress"><span class="${barClass(bar)}" style="width:${Math.min(100, pct)}%"></span></div>
      </td>
    </tr>`;
  hostTableEl.innerHTML = `
    <tr><th>${escapeHtml(t("host.label"))}</th><td colspan="2">${escapeHtml(h.hostname || t("common.em_dash"))}</td></tr>
    ${row(escapeHtml(t("host.memory")), h.mem_percent, h.mem_bar)}
    ${row(escapeHtml(t("host.cpu")), h.cpu_percent, h.cpu_bar)}
    ${row(escapeHtml(t("host.disk")), h.disk_percent, h.disk_bar)}
  `;
}

function shortName(n, max = 22) {
  if (!n) return "—";
  return n.length > max ? n.slice(0, max) + "…" : n;
}

function chartSuggestedMax(vals, floorVal) {
  const nums = vals.map((x) => Number(x) || 0);
  const m = nums.length ? Math.max(...nums) : 0;
  return m <= 0 ? floorVal : Math.max(floorVal, m * 1.12);
}

function renderBarPanel(container, items, opts) {
  if (!container) return;
  container.innerHTML = "";
  items.forEach((item) => {
    const v = Number(opts.value(item)) || 0;
    const max = opts.max > 0 ? opts.max : 1;
    const pct = Math.min(100, (v / max) * 100);
    const row = document.createElement("div");
    row.className = "simple-bar-row";
    const label = document.createElement("span");
    label.className = "simple-bar-label";
    label.textContent = shortName(item.name);
    label.title = item.name || "";
    const track = document.createElement("div");
    track.className = "simple-bar-track";
    const fill = document.createElement("span");
    fill.className = `simple-bar-fill ${opts.fillClass}`;
    fill.style.width = `${pct}%`;
    const val = document.createElement("span");
    val.className = "simple-bar-val";
    val.textContent = opts.format(v);
    track.appendChild(fill);
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(val);
    container.appendChild(row);
  });
}

function renderOverviewBars(top) {
  const emptyHint = t("charts.empty");
  const cpuEl = $("#chartCpuBars");
  const memEl = $("#chartMemBars");
  const netEl = $("#chartNetBars");
  if (!cpuEl || !memEl || !netEl) return;

  if (!top || !top.length) {
    const html = `<p class="chart-empty-msg muted">${escapeHtml(emptyHint)}</p>`;
    cpuEl.innerHTML = html;
    memEl.innerHTML = html;
    netEl.innerHTML = html;
    return;
  }

  const num = (x) => Number(x) || 0;
  const netSum = (x) => num(x.network_rx_mb) + num(x.network_tx_mb);

  const byCpu = [...top].sort((a, b) => num(b.cpu_percent) - num(a.cpu_percent));
  const byMem = [...top].sort((a, b) => num(b.mem_kb_resident) - num(a.mem_kb_resident));
  const byNet = [...top].sort((a, b) => netSum(b) - netSum(a));

  const memVals = byMem.map((x) => num(x.mem_kb_resident));
  const memMax = chartSuggestedMax(memVals, 512);
  const netVals = byNet.map((x) => netSum(x));
  const netMax = chartSuggestedMax(netVals, 0.01);

  renderBarPanel(cpuEl, byCpu, {
    value: (x) => num(x.cpu_percent),
    max: 100,
    format: (v) => `${v.toFixed(1)} %`,
    fillClass: "simple-bar-fill--cpu",
  });
  renderBarPanel(memEl, byMem, {
    value: (x) => num(x.mem_kb_resident),
    max: memMax,
    format: (v) => `${Math.round(v)} KB`,
    fillClass: "simple-bar-fill--mem",
  });
  renderBarPanel(netEl, byNet, {
    value: (x) => netSum(x),
    max: netMax,
    format: (v) => `${Number(v).toFixed(3)} MB`,
    fillClass: "simple-bar-fill--net",
  });
}

async function loadOverviewLive() {
  const banner = $("#banner");
  try {
    const r = await fetch("/api/overview/live");
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(apiDetailMessage(data, r.statusText || t("overview.error.update_metrics")));
    }
    applyOverviewPayload(data);
    banner.classList.add("hidden");
    banner.classList.remove("err");
  } catch (e) {
    const extra = await dockerDisconnectedHint();
    banner.textContent = t("overview.banner.docker_unavailable", { message: e.message || "" }) + extra;
    banner.classList.remove("hidden");
    banner.classList.add("err");
  }
}

async function loadDashboard() {
  const banner = $("#banner");
  try {
    const r = await fetch("/api/dashboard");
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || r.statusText);
    }
    const data = await r.json();
    banner.classList.add("hidden");
    banner.classList.remove("err");
    applyOverviewPayload(data);
  } catch (e) {
    const extra = await dockerDisconnectedHint();
    banner.textContent = t("overview.banner.docker_unavailable", { message: e.message || "" }) + extra;
    banner.classList.remove("hidden");
    banner.classList.add("err");
  }
}

function maybeRefreshOverview() {
  if (isOverviewVisible()) {
    clearTimeout(overviewRefreshTimer);
    overviewRefreshTimer = setTimeout(() => {
      void loadOverviewLive();
    }, 400);
    return;
  }
  void refreshDockerMeta();
}

function setContainersBanner(message, isError) {
  const banner = $("#containersBanner");
  if (!banner) return;
  if (!message) {
    banner.textContent = "";
    banner.classList.add("hidden");
    banner.classList.remove("err");
    return;
  }
  banner.textContent = message;
  banner.classList.remove("hidden");
  banner.classList.toggle("err", !!isError);
}

async function loadContainers() {
  const all = $("#showAllContainers").checked;
  const tb = $("#containersTable tbody");
  if (!tb) return;

  let r;
  let data;
  try {
    r = await fetch(`/api/containers?all=${all}`);
    data = await r.json().catch(() => null);
  } catch (e) {
    const extra = await dockerDisconnectedHint();
    setContainersBanner(t("containers.error.no_connection") + extra, true);
    tb.innerHTML = "";
    return;
  }

  if (!r.ok) {
    const msg = apiDetailMessage(data, r.statusText || t("containers.error.list"));
    const extra = await dockerDisconnectedHint();
    setContainersBanner(msg + extra, true);
    tb.innerHTML = "";
    return;
  }

  if (!Array.isArray(data)) {
    setContainersBanner(t("containers.error.invalid_response"), true);
    tb.innerHTML = "";
    return;
  }

  setContainersBanner("", false);
  lastContainers = data;

  if (data.length === 0) {
    const hint = all ? t("containers.empty.none") : t("containers.empty.running_only");
    setContainersBanner(hint, false);
    tb.innerHTML = "";
    updateContainerSortHeaders();
    return;
  }

  renderContainerTableBody();
}

async function actOnContainer(id, action) {
  const r = await fetch(`/api/containers/${encodeURIComponent(id)}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    alert(j.detail || t("containers.alert.action_failed"));
    return;
  }
  await loadContainers();
  maybeRefreshOverview();
}

async function removeContainer(id) {
  const row = lastContainers.find((x) => x.id_full === id);
  if (row && containerProtectedFromRemove(row)) {
    alert(t("containers.alert.stop_before_remove"));
    return;
  }
  const r = await fetch(`/api/containers/${encodeURIComponent(id)}?force=true`, { method: "DELETE" });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    alert(j.detail || t("containers.alert.remove_failed"));
    return;
  }
  await loadContainers();
  maybeRefreshOverview();
}

async function showLogs(id, title) {
  await openLogsModal(id, title, { live: false });
}

function stopLogsLive() {
  if (logsLiveAbort) {
    logsLiveAbort.abort();
    logsLiveAbort = null;
  }
}

async function showLogsLive(id, title) {
  await openLogsModal(id, title, { live: true });
}

async function openLogsModal(id, title, { live = false } = {}) {
  stopLogsLive();
  const body = $("#logsBody");
  const modal = $("#logsModal");
  if (!body || !modal) return;

  body.textContent = live ? t("logs.connecting") : "";
  $("#logsTitle").textContent = live ? t("logs.title.live", { title }) : t("logs.title.static", { title });
  modal.showModal();

  if (!live) {
    const r = await fetch(`/api/containers/${encodeURIComponent(id)}/logs?tail=400`);
    if (!r.ok) {
      alert(t("logs.alert.load_failed"));
      modal.close();
      return;
    }
    const j = await r.json();
    body.textContent = j.logs || "";
    return;
  }

  logsLiveAbort = new AbortController();
  const signal = logsLiveAbort.signal;
  try {
    const r = await fetch(`/api/containers/${encodeURIComponent(id)}/logs/stream?tail=200`, {
      signal,
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(apiDetailMessage(j, r.statusText || t("logs.error.open_live")));
    }
    if (!r.body) throw new Error(t("logs.error.stream_unavailable"));
    body.textContent = "";
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      body.textContent += dec.decode(value, { stream: true });
      body.scrollTop = body.scrollHeight;
    }
  } catch (e) {
    if (signal.aborted || e.name === "AbortError") return;
    body.textContent += `\n[${e.message || t("logs.error.connection_closed")}]`;
    body.scrollTop = body.scrollHeight;
  } finally {
    if (!signal.aborted) logsLiveAbort = null;
  }
}

function dashBookmarkDetails(urlStr) {
  const raw = String(urlStr ?? "").trim();
  if (!raw) {
    return {
      ok: false,
      schemeKey: "none",
      schemeLabel: "—",
      hostPort: "",
      hostname: "—",
      portLabel: "—",
      pathDisplay: "",
      origin: "",
      hint: t("dash.url.none"),
    };
  }
  try {
    const u = new URL(raw);
    const scheme = (u.protocol || "").replace(/:$/, "").toLowerCase() || "—";
    const schemeKey =
      scheme === "https" ? "https" : scheme === "http" ? "http" : scheme === "ftp" ? "ftp" : "other";
    const hostPort = u.host || "—";
    const hostname = u.hostname || "—";
    let portLabel = u.port;
    if (!portLabel) {
      if (scheme === "https") portLabel = "443";
      else if (scheme === "http") portLabel = "80";
      else portLabel = "—";
    }
    const pathPart = (u.pathname || "/") + (u.search || "");
    let pathDisplay = pathPart;
    if (pathDisplay.length > 52) pathDisplay = pathDisplay.slice(0, 50) + "…";
    return {
      ok: true,
      schemeKey,
      schemeLabel: scheme.toUpperCase(),
      hostPort,
      hostname,
      portLabel,
      pathDisplay,
      origin: u.origin || "",
      hint: "",
    };
  } catch (_) {
    const snippet = raw.length > 72 ? raw.slice(0, 70) + "…" : raw;
    return {
      ok: false,
      schemeKey: "invalid",
      schemeLabel: "!",
      hostPort: "",
      hostname: "—",
      portLabel: "—",
      pathDisplay: snippet,
      origin: "",
      hint: t("dash.url.invalid"),
    };
  }
}

function revokeDashBmObjectUrl() {
  if (dashBmObjectUrl) {
    URL.revokeObjectURL(dashBmObjectUrl);
    dashBmObjectUrl = null;
  }
}

function renderDashBmPreview() {
  const pv = $("#dashBmIconPreview");
  if (!pv) return;
  revokeDashBmObjectUrl();
  pv.innerHTML = "";
  const file = $("#dashBmIconFile")?.files?.[0];
  const rm = dashBmRemoveIconOnSave;
  const iconUrl = ($("#dashBmIconUrl")?.value || "").trim();
  const iconUrlOk =
    iconUrl.startsWith("http://") || iconUrl.startsWith("https://");
  if (file) {
    dashBmObjectUrl = URL.createObjectURL(file);
    const img = document.createElement("img");
    img.src = dashBmObjectUrl;
    img.alt = "";
    pv.appendChild(img);
    return;
  }
  if (iconUrlOk) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    pv.appendChild(img);
    return;
  }
  if (dashBmPreviewUrl && !rm) {
    const img = document.createElement("img");
    img.src = dashBmPreviewUrl;
    img.alt = "";
    pv.appendChild(img);
    return;
  }
  const em = ($("#dashBmIcon")?.value || "🔗").trim().slice(0, 16) || "🔗";
  const span = document.createElement("span");
  span.className = "dash-bm-preview-emoji";
  span.textContent = em;
  span.style.fontSize = "2rem";
  span.style.lineHeight = "1";
  pv.appendChild(span);
}

function syncLastDashBookmarksOrderFromDom() {
  const grid = $("#dashGrid");
  if (!grid) return;
  const ids = [...grid.querySelectorAll(".dash-tile-wrap[data-bookmark-id]")].map(
    (w) => w.dataset.bookmarkId
  );
  const map = new Map(lastDashBookmarks.map((x) => [x.id, x]));
  lastDashBookmarks = ids.map((id) => map.get(id)).filter(Boolean);
}

/** Arrastar cartões usa HTML5 DnD e quebra cliques em links no celular; desativa em telas estreitas ou toque grosseiro. */
function dashBookmarkDragReorderEnabled() {
  try {
    if (window.matchMedia("(max-width: 720px)").matches) return false;
    if (window.matchMedia("(pointer: coarse)").matches) return false;
  } catch (_) {}
  return true;
}

async function persistDashBookmarkOrder() {
  const grid = $("#dashGrid");
  if (!grid) return;
  const ids = [...grid.querySelectorAll(".dash-tile-wrap[data-bookmark-id]")]
    .map((w) => w.dataset.bookmarkId)
    .filter(Boolean);
  const r = await fetch("/api/dash-bookmarks/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: ids }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(apiDetailMessage(data, r.statusText || t("dash.error.reorder")));
  }
}

function renderDashBookmarks(items, containers = lastDashBookmarkContainers) {
  const g = $("#dashGrid");
  if (!g) return;
  const reorderOk = dashBookmarkDragReorderEnabled();
  g.innerHTML = "";
  if (!items.length) {
    g.classList.remove("dash-grid--sortable");
    const p = document.createElement("p");
    p.className = "dash-empty muted";
    p.textContent = t("dash.empty");
    g.appendChild(p);
    return;
  }
  if (reorderOk) g.classList.add("dash-grid--sortable");
  else g.classList.remove("dash-grid--sortable");
  items.forEach((it) => {
    if (!it || typeof it !== "object") return;
    const wrap = document.createElement("div");
    wrap.className = "dash-tile-wrap";
    if (it.id) wrap.dataset.bookmarkId = it.id;
    if (reorderOk) {
      wrap.draggable = true;
      wrap.title = t("dash.drag_reorder");
      wrap.classList.remove("dash-tile-wrap--no-drag");
    } else {
      wrap.draggable = false;
      wrap.removeAttribute("draggable");
      wrap.title = "";
      wrap.classList.add("dash-tile-wrap--no-drag");
    }

    const bar = document.createElement("div");
    bar.className = "dash-tile-bar";

    const urlRaw = String(it.url || "").trim();
    const ct = resolveContainerForBookmark(it, containers);
    const logContainerId = containerLogTargetId(it, containers);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-ico ghost";
    editBtn.dataset.act = "dash-edit";
    editBtn.title = t("dash.tile.edit_title");
    editBtn.setAttribute("aria-label", t("dash.tile.edit_aria"));
    editBtn.innerHTML = IC.pencil;
    editBtn.draggable = false;

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-ico ghost btn-danger";
    delBtn.dataset.act = "dash-remove";
    delBtn.title = t("dash.tile.remove_title");
    delBtn.setAttribute("aria-label", t("dash.tile.remove_aria"));
    delBtn.innerHTML = IC.trash;
    delBtn.draggable = false;

    bar.appendChild(editBtn);
    bar.appendChild(delBtn);

    const det = dashBookmarkDetails(urlRaw);
    const hostFallback = det.hostPort || urlRaw;
  const titleText = (it.title && String(it.title).trim()) || hostFallback || t("dash.tile.open_fallback");

    if (logContainerId) {
      const logBtn = document.createElement("button");
      logBtn.type = "button";
      logBtn.className = "btn btn-ico ghost dash-tile-log-btn";
      logBtn.dataset.act = "dash-logs-live";
      logBtn.dataset.containerId = logContainerId;
      logBtn.title = t("dash.tile.logs_live");
      logBtn.setAttribute("aria-label", t("dash.tile.logs_live"));
      logBtn.innerHTML = IC.logsLive;
      logBtn.draggable = false;
      wireDashLogButton(logBtn, logContainerId, titleText);
      bar.appendChild(logBtn);
    }

    const a = document.createElement("a");
    a.className = "dash-tile";
    a.draggable = false;
    a.href = det.ok ? urlRaw : "#";
    if (!det.ok) {
      wrap.classList.add("dash-tile-wrap--invalid");
      a.addEventListener("click", (ev) => ev.preventDefault());
      a.classList.add("dash-tile--invalid");
      a.title = det.hint || urlRaw;
    } else {
      a.title = urlRaw;
    }
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const inner = document.createElement("div");
    inner.className = "dash-tile-inner";

    if (ct) {
      const dot = document.createElement("span");
      dot.className = containerDotRunning(ct)
        ? "dash-tile-ct-status dash-tile-ct-status--run"
        : "dash-tile-ct-status dash-tile-ct-status--down";
      const st = String(ct.state_kind || ct.state || "").trim() || "?";
      dot.title = containerDotRunning(ct)
        ? t("dash.tile.container_running")
        : t("dash.tile.container_status", { state: st });
      dot.setAttribute("aria-hidden", "true");
      inner.appendChild(dot);
    }

    const scheme = document.createElement("span");
    scheme.className = `dash-tile-scheme dash-tile-scheme--${det.schemeKey}`;
    scheme.textContent = det.schemeLabel;

    const ic = document.createElement(it.icon_image_url ? "div" : "span");
    ic.className = it.icon_image_url ? "dash-tile-icon dash-tile-icon--img" : "dash-tile-icon";
    if (it.icon_image_url) {
      const img = document.createElement("img");
      img.src = it.icon_image_url;
      img.alt = "";
      img.loading = "lazy";
      img.draggable = false;
      ic.appendChild(img);
    } else {
      ic.textContent = (it.icon && String(it.icon).trim()) || "🔗";
    }

    const titleEl = document.createElement("span");
    titleEl.className = "dash-tile-title";
    titleEl.textContent = titleText;

    const details = document.createElement("div");
    details.className = "dash-tile-details";

    const rowHost = document.createElement("div");
    rowHost.className = "dash-tile-dt-row dash-tile-dt-row--host";
    const lk = document.createElement("span");
    lk.className = "dash-tile-dt-k";
    lk.textContent = t("dash.tile.host");
    const hv = document.createElement("span");
    hv.className = "dash-tile-dt-v";
    hv.textContent = det.ok ? det.hostname : "—";
    rowHost.appendChild(lk);
    rowHost.appendChild(hv);

    const rowPort = document.createElement("div");
    rowPort.className = "dash-tile-dt-row dash-tile-dt-row--host dash-tile-dt-row--port";
    const lkP = document.createElement("span");
    lkP.className = "dash-tile-dt-k";
    lkP.textContent = t("dash.tile.port");
    const hvP = document.createElement("span");
    hvP.className = "dash-tile-dt-v";
    hvP.textContent = det.ok ? det.portLabel : "—";
    rowPort.appendChild(lkP);
    rowPort.appendChild(hvP);

    details.appendChild(rowHost);
    details.appendChild(rowPort);

    if (det.hint) {
      const hint = document.createElement("p");
      hint.className = "dash-tile-hint";
      hint.textContent = det.hint;
      details.appendChild(hint);
    }

    inner.appendChild(ic);
    inner.appendChild(titleEl);
    inner.appendChild(scheme);
    inner.appendChild(details);

    a.appendChild(inner);

    wrap.appendChild(a);
    wrap.appendChild(bar);
    g.appendChild(wrap);
  });
}

async function loadDashBookmarks() {
  const g = $("#dashGrid");
  if (!g) return;
  try {
    const [bmRes, ctRes] = await Promise.all([
      fetch("/api/dash-bookmarks", { cache: "no-store" }),
      fetch("/api/containers?all=true", { cache: "no-store" }),
    ]);
    const data = await bmRes.json().catch(() => null);
    if (!bmRes.ok) {
      throw new Error(apiDetailMessage(data, bmRes.statusText || t("dash.error.load_api")));
    }
    lastDashBookmarks = Array.isArray(data.items) ? data.items : [];
    let ctPayload = null;
    if (ctRes.ok) ctPayload = await ctRes.json().catch(() => null);
    lastDashBookmarkContainers = Array.isArray(ctPayload) ? ctPayload : [];
    renderDashBookmarks(lastDashBookmarks, lastDashBookmarkContainers);
  } catch (e) {
    lastDashBookmarks = [];
    lastDashBookmarkContainers = [];
    g.innerHTML = "";
    const p = document.createElement("p");
    p.className = "dash-empty";
    p.style.color = "var(--danger)";
    p.textContent = e.message || t("dash.error.load");
    g.appendChild(p);
  }
}

function closeDashBookmarkModal() {
  revokeDashBmObjectUrl();
  $("#dashBookmarkModal")?.close();
}

function syncDashBmRemoveIconBtn() {
  const btn = $("#dashBmRemoveIconBtn");
  if (!btn) return;
  const show = dashBmHadServerImage && !dashBmRemoveIconOnSave;
  btn.classList.toggle("hidden", !show);
  btn.disabled = dashBmRemoveIconOnSave;
  btn.textContent = dashBmRemoveIconOnSave
    ? t("dash.modal.remove_icon_pending")
    : t("dash.modal.remove_icon");
}

function openDashBookmarkModal(it) {
  const isEdit = !!(it && it.id);
  revokeDashBmObjectUrl();
  const fileEl = $("#dashBmIconFile");
  if (fileEl) fileEl.value = "";
  const urlEl = $("#dashBmIconUrl");
  if (urlEl) urlEl.value = "";
  dashBmPreviewUrl = isEdit && it.icon_image_url ? it.icon_image_url : null;
  dashBmHadServerImage = !!dashBmPreviewUrl;
  dashBmRemoveIconOnSave = false;

  $("#dashBmModalTitle").textContent = isEdit ? t("dash.modal.title_edit") : t("dash.modal.title_new");
  $("#dashBmId").value = isEdit ? it.id : "";
  $("#dashBmTitle").value = isEdit ? (it.title || "") : "";
  $("#dashBmUrl").value = isEdit ? (it.url || "") : "";
  $("#dashBmIcon").value = isEdit ? (it.icon && String(it.icon).trim()) || "🔗" : "🔗";
  const delBtn = $("#dashBmDelete");
  if (delBtn) {
    delBtn.disabled = !isEdit;
    delBtn.classList.toggle("hidden", !isEdit);
  }
  syncDashBmRemoveIconBtn();
  $("#dashBookmarkModal").showModal();
  renderDashBmPreview();
  setTimeout(() => $("#dashBmUrl").focus(), 50);
}

async function saveDashBookmarkFromForm(ev) {
  ev.preventDefault();
  const id = $("#dashBmId").value.trim();
  const title = $("#dashBmTitle").value.trim();
  let url = $("#dashBmUrl").value.trim();
  const icon = ($("#dashBmIcon").value.trim() || "🔗").slice(0, 16);
  const file = $("#dashBmIconFile")?.files?.[0];
  const removeImg = dashBmRemoveIconOnSave;
  const iconUrl = ($("#dashBmIconUrl")?.value || "").trim();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    alert(t("dash.validation.url"));
    return;
  }
  if (
    iconUrl &&
    !iconUrl.startsWith("http://") &&
    !iconUrl.startsWith("https://")
  ) {
    alert(t("dash.validation.icon_url"));
    return;
  }

  const payload = { title, url, icon };
  if (!id) {
    const matched = resolveContainerForBookmark({ url, title }, lastDashBookmarkContainers);
    if (matched?.id_full) payload.container_id = matched.id_full;
  }

  let bid = id;
  if (id) {
    const r = await fetch(`/api/dash-bookmarks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(apiDetailMessage(j, t("dash.alert.save_failed")));
      return;
    }
  } else {
    const r = await fetch("/api/dash-bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(apiDetailMessage(j, t("dash.alert.create_failed")));
      return;
    }
    const row = await r.json().catch(() => ({}));
    bid = row.id ? String(row.id) : "";
    if (!bid) {
      alert(t("dash.alert.create_no_id"));
      closeDashBookmarkModal();
      await loadDashBookmarks();
      return;
    }
  }

  if (bid) {
    if (file) {
      const fd = new FormData();
      fd.append("file", file);
      const ui = await fetch(`/api/dash-bookmarks/${encodeURIComponent(bid)}/icon`, {
        method: "POST",
        body: fd,
      });
      if (!ui.ok) {
        const j = await ui.json().catch(() => ({}));
        alert(apiDetailMessage(j, t("dash.alert.icon_upload_failed")));
      }
    } else if (iconUrl) {
      const iu = await fetch(
        `/api/dash-bookmarks/${encodeURIComponent(bid)}/icon-from-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: iconUrl }),
        },
      );
      if (!iu.ok) {
        const j = await iu.json().catch(() => ({}));
        alert(
          apiDetailMessage(
            j,
            t("dash.alert.icon_download_failed"),
          ),
        );
      }
    } else if (removeImg && dashBmHadServerImage) {
      const ri = await fetch(`/api/dash-bookmarks/${encodeURIComponent(bid)}/icon`, { method: "DELETE" });
      if (!ri.ok) {
        const j = await ri.json().catch(() => ({}));
        alert(apiDetailMessage(j, t("dash.alert.icon_remove_failed")));
      }
    }
  }

  closeDashBookmarkModal();
  await loadDashBookmarks();
}

async function deleteDashBookmarkConfirmed() {
  const id = $("#dashBmId").value.trim();
  if (!id || !confirm(t("dash.confirm.delete_modal"))) return;
  const r = await fetch(`/api/dash-bookmarks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    alert(apiDetailMessage(j, t("dash.alert.remove_failed")));
    return;
  }
  closeDashBookmarkModal();
  await loadDashBookmarks();
}

function parseDockerPortPublish(portLine) {
  const s = String(portLine).trim();
  const arrowIdx = s.indexOf("->");
  if (arrowIdx === -1) return null;
  const left = s.slice(0, arrowIdx).trim();
  const ipv6 = left.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) {
    const port = parseInt(ipv6[2], 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    let h = ipv6[1];
    if (h === "::" || h === "") h = "127.0.0.1";
    else if (h === "::1") h = "127.0.0.1";
    return { host: h, port };
  }
  if (/^:\d+$/.test(left)) {
    const port = parseInt(left.slice(1), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    return { host: "127.0.0.1", port };
  }
  const colonIdx = left.lastIndexOf(":");
  if (colonIdx <= 0) return null;
  const hostPart = left.slice(0, colonIdx).trim();
  const portStr = left.slice(colonIdx + 1).trim();
  const port = parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  let bh = hostPart;
  if (!bh || bh === "0.0.0.0" || bh === "::") bh = "127.0.0.1";
  return { host: bh, port };
}

function suggestedDashUrlFromContainer(c, publishedHost) {
  let raw = String(publishedHost ?? "").trim();
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  const hostForUrl = raw || "127.0.0.1";
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostForUrl);
  const hostInHttp = hostForUrl.includes(":") && !isIpv4 ? `[${hostForUrl}]` : hostForUrl;

  if (c.access && c.access.url) {
    return {
      url: String(c.access.url).trim(),
      hint: t("dash.import.hint.link"),
      source: "access",
    };
  }
  const ports = Array.isArray(c.ports) ? c.ports : [];
  for (const line of ports) {
    const m = parseDockerPortPublish(line);
    if (!m) continue;
    return {
      url: `http://${hostInHttp}:${m.port}/`,
      hint: t("dash.import.hint.port", { host: hostForUrl }),
      source: "port",
    };
  }
  return { url: "", hint: t("common.em_dash"), source: "none" };
}

function normalizeDashImportUrl(u) {
  const raw = String(u || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const x = new URL(raw);
    let path = x.pathname || "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${x.protocol}//${x.host}${path}${x.search}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function dashImportValidHttpUrl(s) {
  const t = String(s || "").trim();
  return t.startsWith("http://") || t.startsWith("https://");
}

function dashImportUrlSetFromBookmarks(items) {
  const set = new Set();
  (items || []).forEach((b) => {
    const n = normalizeDashImportUrl(b.url);
    if (n) set.add(n);
  });
  return set;
}

let dashImportModalCache = null;

function dashImportPublishedHost() {
  const v = ($("#dashImportHost")?.value || "").trim();
  return v || "127.0.0.1";
}

/** Imagem do container na lista Docker (ex.: dashflex:latest). */
function containerImageIsDashflexLatest(imageField) {
  const s = String(imageField || "").trim().toLowerCase();
  if (!s) return false;
  if (s === "dashflex:latest") return true;
  const slash = s.lastIndexOf("/");
  const tail = slash >= 0 ? s.slice(slash + 1) : s;
  return tail === "dashflex:latest";
}

function publishedHostsForBookmarkMatch(rawUrl) {
  const hosts = new Set();
  hosts.add(dashImportPublishedHost());
  hosts.add("127.0.0.1");
  hosts.add("localhost");
  hosts.add("::1");
  try {
    const u = new URL(String(rawUrl || "").trim());
    if (u.hostname) hosts.add(u.hostname);
  } catch (_) {}
  return [...hosts];
}

function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "[::]" || h === "::";
}

function normalizeHostForMatch(host) {
  let h = String(host || "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (isLoopbackHost(h)) return "loopback";
  return h;
}

function urlPortFromString(u) {
  try {
    const x = new URL(u);
    if (x.port) return parseInt(x.port, 10);
    return x.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

function hostsMatchForBookmark(a, b) {
  const ah = normalizeHostForMatch(a);
  const bh = normalizeHostForMatch(b);
  if (ah === bh) return true;
  return ah === "loopback" && bh === "loopback";
}

function urlsMatchForContainerBookmark(bookmarkUrl, candidateUrl) {
  if (!bookmarkUrl || !candidateUrl) return false;
  if (normalizeDashImportUrl(bookmarkUrl) === normalizeDashImportUrl(candidateUrl)) return true;
  try {
    const bPort = urlPortFromString(bookmarkUrl);
    const cPort = urlPortFromString(candidateUrl);
    if (bPort == null || cPort == null || bPort !== cPort) return false;
    const b = new URL(bookmarkUrl);
    const c = new URL(candidateUrl);
    return hostsMatchForBookmark(b.hostname, c.hostname);
  } catch {
    return false;
  }
}

function httpHostForUrl(host) {
  let raw = String(host ?? "").trim();
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  const hostForUrl = raw || "127.0.0.1";
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostForUrl);
  return hostForUrl.includes(":") && !isIpv4 ? `[${hostForUrl}]` : hostForUrl;
}

function allUrlsForContainerMatch(c, hosts) {
  const urls = [];
  const acc = c.access && c.access.url;
  if (acc) urls.push(String(acc).trim());

  const ports = Array.isArray(c.ports) ? c.ports : [];
  const hostSet = new Set(hosts.map((h) => String(h || "").trim()).filter(Boolean));
  const cname = String(c.name || "").trim();
  if (cname) hostSet.add(cname);

  for (const host of hostSet) {
    const hostInHttp = httpHostForUrl(host);
    for (const line of ports) {
      const m = parseDockerPortPublish(line);
      if (!m) continue;
      urls.push(`http://${hostInHttp}:${m.port}/`);
      if (m.host && !hostSet.has(m.host)) {
        urls.push(`http://${httpHostForUrl(m.host)}:${m.port}/`);
      }
    }
  }
  return urls;
}

function containerByStoredId(storedId, containers) {
  const sid = String(storedId || "").trim();
  if (!sid || !Array.isArray(containers)) return null;
  return (
    containers.find(
      (c) =>
        c &&
        (c.id_full === sid ||
          c.id === sid ||
          (c.id_full && sid.startsWith(c.id)) ||
          (c.id && sid.startsWith(c.id))),
    ) || null
  );
}

function findContainerForBookmark(bookmarkUrl, containers, bookmarkTitle) {
  const raw = String(bookmarkUrl || "").trim();
  if (!raw || !Array.isArray(containers) || !containers.length) return null;
  if (!dashImportValidHttpUrl(raw)) return null;

  const hosts = publishedHostsForBookmarkMatch(raw);
  const bPort = urlPortFromString(raw);

  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    for (const cand of allUrlsForContainerMatch(c, hosts)) {
      if (urlsMatchForContainerBookmark(raw, cand)) return c;
    }
  }

  if (bPort != null) {
    let bookmarkHost = "";
    try {
      bookmarkHost = new URL(raw).hostname;
    } catch (_) {}

    for (const c of containers) {
      if (!c || typeof c !== "object") continue;
      const cname = String(c.name || "").trim();
      if (!cname) continue;

      const nameMatch =
        bookmarkHost &&
        (bookmarkHost.toLowerCase() === cname.toLowerCase() ||
          bookmarkHost.toLowerCase().startsWith(`${cname.toLowerCase()}.`));
      const titleMatch =
        bookmarkTitle && String(bookmarkTitle).trim().toLowerCase() === cname.toLowerCase();
      if (!nameMatch && !titleMatch) continue;

      for (const line of c.ports || []) {
        const m = parseDockerPortPublish(line);
        if (m && m.port === bPort) return c;
      }
    }
  }

  return null;
}

function containerLogTargetId(bookmark, containers) {
  if (!bookmark || typeof bookmark !== "object") return null;

  const stored = String(bookmark.container_id || "").trim();
  if (stored) {
    const hit = containerByStoredId(stored, containers);
    return hit?.id_full || stored;
  }

  const resolved = resolveContainerForBookmark(bookmark, containers);
  if (resolved?.id_full) return resolved.id_full;

  const title = String(bookmark.title || "").trim().toLowerCase();
  if (title && Array.isArray(containers)) {
    const byTitle = containers.filter(
      (c) => c && String(c.name || "").trim().toLowerCase() === title,
    );
    if (byTitle.length) {
      const running = byTitle.find((c) => containerDotRunning(c));
      return (running || byTitle[0]).id_full || null;
    }
  }

  try {
    const host = new URL(String(bookmark.url || "").trim()).hostname.toLowerCase();
    if (host) {
      const byHost = containers.filter(
        (c) => c && String(c.name || "").trim().toLowerCase() === host,
      );
      if (byHost.length) {
        const running = byHost.find((c) => containerDotRunning(c));
        return (running || byHost[0]).id_full || null;
      }
    }
  } catch (_) {}

  return null;
}

function wireDashLogButton(btn, containerId, title) {
  wireTapClick(
    btn,
    () => {
      void showLogsLive(containerId, title);
    },
    { stopPropagation: true },
  );
}

function resolveContainerForBookmark(bookmark, containers) {
  if (!bookmark || typeof bookmark !== "object") return null;
  const byId = containerByStoredId(bookmark.container_id, containers);
  if (byId) return byId;

  const matched = findContainerForBookmark(bookmark.url, containers, bookmark.title);
  if (matched) return matched;

  const title = String(bookmark.title || "").trim().toLowerCase();
  if (!title || !Array.isArray(containers)) return null;
  const byName = containers.filter(
    (c) => c && String(c.name || "").trim().toLowerCase() === title,
  );
  return byName.length === 1 ? byName[0] : null;
}

function containerDotRunning(c) {
  const s = String(c?.state_kind || c?.state || "").toLowerCase();
  return s === "running" || s === "restarting";
}

function closeDashImportModal() {
  $("#dashImportModal")?.close();
}

function renderDashImportTableRows() {
  const cache = dashImportModalCache;
  const tbody = $("#dashImportTbody");
  const summaryEl = $("#dashImportSummary");
  const submitBtn = $("#dashImportSubmitBtn");
  if (!cache || !tbody || !submitBtn || !summaryEl) return;

  const { bookmarks, containers } = cache;
  const existingNorm = dashImportUrlSetFromBookmarks(bookmarks);
  const slotsLeft = Math.max(0, MAX_DASH_BOOKMARKS - bookmarks.length);
  const publishedHost = dashImportPublishedHost();

  summaryEl.textContent =
    slotsLeft <= 0
        ? t("dash.import.limit", { max: MAX_DASH_BOOKMARKS })
        : t("dash.import.slots_free", { free: slotsLeft, max: MAX_DASH_BOOKMARKS });

  tbody.innerHTML = "";

  const sorted = [...containers].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" })
  );

  sorted.forEach((c) => {
    const sug = suggestedDashUrlFromContainer(c, publishedHost);
    const url = sug.url || "";
    const dup = url && existingNorm.has(normalizeDashImportUrl(url));
    const tr = document.createElement("tr");
    tr.dataset.containerName = c.name || "";
    tr.dataset.containerImage = c.image || "";
    if (c.id_full) tr.dataset.containerId = c.id_full;
    tr.dataset.importSource = sug.source || "";
    if (url) tr.dataset.importSuggested = "1";
    if (!url) tr.classList.add("row-muted");

    const tdCb = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "dash-import-cb";
    cb.checked = !!(url && dashImportValidHttpUrl(url) && !dup);
    cb.disabled = slotsLeft <= 0;
    tdCb.appendChild(cb);

    const tdName = document.createElement("td");
    const nm = document.createElement("span");
    nm.className = "dash-import-name";
    nm.textContent = c.name || t("common.em_dash");
    const meta = document.createElement("span");
    meta.className = "dash-import-meta";
    const st = (c.state || c.state_kind || "").trim() || t("common.em_dash");
    meta.textContent = `${st}${c.id ? " · " + String(c.id).slice(0, 12) : ""}`;
    tdName.appendChild(nm);
    tdName.appendChild(meta);

    const tdUrl = document.createElement("td");
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "dash-import-url";
    inp.autocomplete = "off";
    inp.placeholder = "http://…";
    inp.value = url;
    tdUrl.appendChild(inp);

    const tdNote = document.createElement("td");
    tdNote.className = "dash-import-notes";
    let note = sug.hint || t("common.em_dash");
    if (dup) note += ` ${t("dash.import.note.duplicate")}`;
    tdNote.textContent = note;

    tr.appendChild(tdCb);
    tr.appendChild(tdName);
    tr.appendChild(tdUrl);
    tr.appendChild(tdNote);
    tbody.appendChild(tr);
  });

  submitBtn.disabled = slotsLeft <= 0;
}

async function loadDashImportModalTable() {
  const statusEl = $("#dashImportStatus");
  const tbody = $("#dashImportTbody");
  const summaryEl = $("#dashImportSummary");
  const submitBtn = $("#dashImportSubmitBtn");
  if (!statusEl || !tbody || !submitBtn) return;

  submitBtn.disabled = true;
  statusEl.textContent = t("dash.import.loading");
  tbody.innerHTML = "";
  summaryEl.textContent = "";

  const includeStopped = !!$("#dashImportIncludeStopped")?.checked;

  try {
    const [bmRes, ctRes] = await Promise.all([
      fetch("/api/dash-bookmarks"),
      fetch(`/api/containers?all=${includeStopped}`),
    ]);

    const bmData = bmRes.ok ? await bmRes.json().catch(() => ({})) : {};
    const bookmarks = Array.isArray(bmData.items) ? bmData.items : [];
    if (!bmRes.ok) {
      dashImportModalCache = null;
      statusEl.textContent = apiDetailMessage(bmData, t("dash.import.error.read_bookmarks"));
      submitBtn.disabled = true;
      return;
    }

    const ctData = ctRes.ok ? await ctRes.json().catch(() => null) : null;
    if (!ctRes.ok) {
      dashImportModalCache = null;
      statusEl.textContent = apiDetailMessage(
        ctData,
        ctRes.status === 503 ? t("dash.import.error.docker_unavailable") : t("dash.import.error.list_containers")
      );
      submitBtn.disabled = true;
      return;
    }

    const containers = Array.isArray(ctData) ? ctData : [];
    dashImportModalCache = { bookmarks, containers };

    statusEl.textContent =
      containers.length === 0 ? t("dash.import.empty_containers") : t("dash.import.rows", { count: containers.length });

    renderDashImportTableRows();
  } catch (e) {
    dashImportModalCache = null;
    statusEl.textContent = e.message || t("dash.import.error.load");
  }
}

async function openDashImportModal() {
  const dlg = $("#dashImportModal");
  if (!dlg) return;
  dlg.showModal();
  await loadDashImportModalTable();
}

async function submitDashImportFromModal() {
  const tbody = $("#dashImportTbody");
  const submitBtn = $("#dashImportSubmitBtn");
  if (!tbody || !submitBtn) return;

  const bmRes = await fetch("/api/dash-bookmarks");
  const bmData = bmRes.ok ? await bmRes.json().catch(() => ({})) : {};
  let bookmarks = Array.isArray(bmData.items) ? bmData.items : [];
  if (!bmRes.ok) {
    alert(apiDetailMessage(bmData, t("dash.import.alert.verify_failed")));
    return;
  }

  const rows = [...tbody.querySelectorAll("tr")];
  const picked = rows.filter((tr) => tr.querySelector(".dash-import-cb")?.checked);
  if (!picked.length) {
    alert(t("dash.import.alert.select_rows"));
    return;
  }

  let slotsLeft = MAX_DASH_BOOKMARKS - bookmarks.length;
  if (slotsLeft <= 0) {
    alert(t("dash.import.alert.max", { max: MAX_DASH_BOOKMARKS }));
    return;
  }

  const seen = dashImportUrlSetFromBookmarks(bookmarks);
  let ok = 0;
  let skippedBad = 0;
  let skippedDup = 0;
  let skippedCap = 0;
  const fails = [];

  submitBtn.disabled = true;

  try {
    for (const tr of picked) {
      if (slotsLeft <= 0) {
        skippedCap++;
        continue;
      }
      const urlInp = tr.querySelector(".dash-import-url");
      const title = (tr.dataset.containerName || "").trim() || t("dash.import.default_title");
      const url = (urlInp && urlInp.value.trim()) || "";
      const containerId = (tr.dataset.containerId || "").trim();
      if (!dashImportValidHttpUrl(url)) {
        skippedBad++;
        continue;
      }
      const norm = normalizeDashImportUrl(url);
      if (seen.has(norm)) {
        skippedDup++;
        continue;
      }
      seen.add(norm);

      const r = await fetch("/api/dash-bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          url,
          icon: "🐳",
          container_id: containerId || null,
        }),
      });
      if (r.ok) {
        ok++;
        slotsLeft--;
        const row = await r.json().catch(() => null);
        if (row && row.id) {
          bookmarks = bookmarks.concat([row]);
          if (containerImageIsDashflexLatest(tr.dataset.containerImage)) {
            await fetch(`/api/dash-bookmarks/${encodeURIComponent(row.id)}/icon-from-logo`, {
              method: "POST",
            }).catch(() => {});
          }
        }
      } else {
        const j = await r.json().catch(() => ({}));
        fails.push(apiDetailMessage(j, url.slice(0, 40)));
      }
    }
  } finally {
    submitBtn.disabled = false;
  }

  const parts = [t("dash.import.result.ok", { count: ok })];
  if (skippedBad) parts.push(t("dash.import.result.skipped_url", { count: skippedBad }));
  if (skippedDup) parts.push(t("dash.import.result.duplicates", { count: skippedDup }));
  if (skippedCap) parts.push(t("dash.import.result.limit", { count: skippedCap }));
  if (fails.length) {
    parts.push(
      t("dash.import.result.errors", {
        details: `${fails.slice(0, 2).join("; ")}${fails.length > 2 ? "…" : ""}`,
      }),
    );
  }
  const msg = parts.join(" · ");

  await loadDashBookmarks();
  await loadDashImportModalTable();
  alert(msg);
}

function dashImportSelectByPredicate(pred) {
  $$("#dashImportTbody tr").forEach((tr) => {
    const cb = tr.querySelector(".dash-import-cb");
    const inp = tr.querySelector(".dash-import-url");
    if (!cb || cb.disabled) return;
    cb.checked = pred(cb, inp, tr);
  });
}

function loadImages() {
  const g = $("#imageGrid");
  if (!g) return;

  g.innerHTML = `<p class="image-grid-msg muted">${escapeHtml(t("images.loading"))}</p>`;

  fetch("/api/images", { cache: "no-store" })
    .then(async (r) => {
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        throw new Error(apiDetailMessage(data, r.statusText || t("images.error.list")));
      }
      return Array.isArray(data) ? data : [];
    })
    .then((imgs) => {
      g.innerHTML = "";
      if (!imgs.length) {
        const p = document.createElement("p");
        p.className = "image-grid-empty muted";
        p.textContent = t("images.empty");
        g.appendChild(p);
        return;
      }
      imgs.forEach((im) => {
        if (!im || typeof im !== "object") return;
        appendImageCard(g, im);
      });
    })
    .catch((err) => {
      g.innerHTML = "";
      const p = document.createElement("p");
      p.className = "image-grid-msg err";
      p.textContent = err.message || t("images.error.load");
      g.appendChild(p);
    });
}

let dockerImageRemoveBusy = false;

async function removeDockerImage(ref, displayLabel) {
  if (!ref || !String(ref).trim()) {
    alert(t("images.alert.ref_not_found"));
    return;
  }
  if (dockerImageRemoveBusy) return;
  // confirm precisa rodar no mesmo turno do toque/clique; setTimeout quebra no celular.
  if (
    !window.confirm(t("images.confirm.delete", { label: displayLabel }))
  ) {
    return;
  }
  dockerImageRemoveBusy = true;
  try {
    const params = new URLSearchParams();
    params.set("ref", ref);
    params.set("force", "true");
    const u = `/api/images?${params.toString()}`;
    const r = await fetch(u, { method: "DELETE", cache: "no-store" });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(apiDetailMessage(j, t("images.alert.delete_failed")));
      return;
    }
    await loadImages();
    maybeRefreshOverview();
  } finally {
    dockerImageRemoveBusy = false;
  }
}

function scheduleOverviewLive() {
  if (overviewLiveIntervalId !== null) {
    clearInterval(overviewLiveIntervalId);
    overviewLiveIntervalId = null;
  }
  if (isOverviewVisible()) {
    overviewLiveIntervalId = setInterval(() => {
      if (isOverviewVisible()) void loadOverviewLive();
    }, overviewLiveMs);
  }
}

function stopOverviewLive() {
  if (overviewLiveIntervalId !== null) {
    clearInterval(overviewLiveIntervalId);
    overviewLiveIntervalId = null;
  }
  clearTimeout(overviewRefreshTimer);
  overviewRefreshTimer = null;
}

async function applySettingsFromServer() {
  try {
    const r = await fetch("/api/settings");
    if (!r.ok) return;
    const s = await r.json();
    const sec = Math.max(5, Math.min(600, Number(s.dashboard_refresh_seconds) || 12));
    overviewLiveMs = Math.max(4000, Math.min(25000, Math.round(sec * 650)));
    const v =
      typeof s.containers_show_stopped_default === "boolean" ? s.containers_show_stopped_default : true;
    const chk = $("#showAllContainers");
    if (chk) chk.checked = v;
    if (isOverviewVisible()) scheduleOverviewLive();
    applyUiLanguageFromSettings(s);
    applyBrandingFromSettings(s);
    applyDashBookmarkCardScaleFromSettings(s);
    applyUiThemeFromSettings(s);
  } catch (_) {
    if (isOverviewVisible()) scheduleOverviewLive();
  }
}

function fmtBytes(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return t("common.em_dash");
  if (x === 0) return t("units.zero");
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = x;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  const shown = i === 0 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${shown} ${u[i]}`;
}

function renderAdminDataFiles(files) {
  const tb = $("#adminDataFilesBody");
  if (!tb || !Array.isArray(files)) return;
  const labels = [
    t("admin.files.app_config"),
    t("admin.files.container_links"),
    t("admin.files.dash_bookmarks"),
  ];
  tb.innerHTML = files
    .map((f, i) => {
      const label = labels[i] || t("admin.files.generic", { n: i + 1 });
      const ok = f.exists !== false;
      const pathTitle = escapeAttr(f.path || "");
      return `<tr>
        <td title="${pathTitle}">${escapeHtml(label)}</td>
        <td>${ok ? fmtBytes(f.bytes) : t("common.em_dash")}</td>
        <td>${ok ? "" : `<span class="muted">${escapeHtml(t("admin.files.not_found"))}</span>`}</td>
      </tr>`;
    })
    .join("");
}

function _dfRowLabel(row) {
  if (!row || typeof row !== "object") return t("common.em_dash");
  const tags = row.RepoTags ?? row.repo_tags;
  if (Array.isArray(tags) && tags.length) return tags.join(", ");
  const nm = row.Name ?? row.name;
  if (nm) return String(nm);
  const desc = row.Description ?? row.description ?? row.Id ?? row.id;
  return desc ? String(desc).slice(0, 96) : t("common.em_dash");
}

function renderAdminDiskUsage(payload) {
  const wrap = $("#adminDfWrap");
  const raw = $("#adminDfRaw");
  if (raw) raw.textContent = JSON.stringify(payload, null, 2);
  if (!wrap) return;
  const layers = payload && payload.layers !== undefined ? payload.layers : payload;
  if (layers == null || layers === "") {
    wrap.innerHTML = `<p class="muted small">${escapeHtml(t("admin.df.empty"))}</p>`;
    return;
  }
  if (Array.isArray(layers) && layers.length) {
    const rows = layers.map((row) => {
      const type = escapeHtml(row.Type ?? row.type ?? row.Description ?? _dfRowLabel(row));
      const cnt = row.EntityCount ?? row.Count ?? row.count ?? row.TotalCount ?? t("common.em_dash");
      const sz = fmtBytes(row.Size ?? row.size ?? row.Usage ?? row.LayerSize ?? NaN);
      const shr = fmtBytes(row.SharedSize ?? row.shared_size ?? NaN);
      return `<tr><td>${type}</td><td>${escapeHtml(String(cnt))}</td><td>${sz}</td><td>${shr}</td></tr>`;
    });
    wrap.innerHTML = `<table class="admin-df-table"><thead><tr><th>${escapeHtml(t("admin.df.col.type"))}</th><th>${escapeHtml(t("admin.df.col.items"))}</th><th>${escapeHtml(t("admin.df.col.size"))}</th><th>${escapeHtml(t("admin.df.col.shared"))}</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
    return;
  }
  if (typeof layers === "object") {
    const bits = [];
    const ls = layers.LayersSize ?? layers.layers_size;
    if (typeof ls === "number") {
      bits.push(`<p class="muted small"><strong>${escapeHtml(t("admin.df.layers_size"))}</strong> ${fmtBytes(ls)}</p>`);
    }
    const cats = [
      [t("admin.df.category.images"), layers.Images ?? layers.images],
      [t("admin.df.category.containers"), layers.Containers ?? layers.containers],
      [t("admin.df.category.volumes"), layers.LocalVolumes ?? layers.local_volumes ?? layers.Volumes ?? layers.volumes],
      [t("admin.df.category.build_cache"), layers.BuildCache ?? layers.build_cache],
    ];
    let anyTable = false;
    for (const [title, block] of cats) {
      if (!Array.isArray(block) || !block.length) continue;
      anyTable = true;
      const sumSize = block.reduce((acc, row) => acc + (Number(row.Size ?? row.size ?? 0) || 0), 0);
      bits.push(
        `<h4 class="admin-df-cat">${escapeHtml(title)}</h4><p class="muted small">${escapeHtml(t("admin.df.entries_summary", { count: block.length, size: fmtBytes(sumSize) }))}</p>`
      );
      const slice = block.slice(0, 25);
      const tr = slice
        .map((row) => {
          const lab = escapeHtml(_dfRowLabel(row));
          return `<tr><td>${lab}</td><td>${fmtBytes(row.Size ?? row.size)}</td><td>${fmtBytes(row.SharedSize ?? row.shared_size)}</td></tr>`;
        })
        .join("");
      bits.push(
        `<table class="admin-df-table"><thead><tr><th>${escapeHtml(t("admin.df.col.name_tags"))}</th><th>${escapeHtml(t("admin.df.col.size"))}</th><th>${escapeHtml(t("admin.df.col.shared"))}</th></tr></thead><tbody>${tr}</tbody></table>`
      );
      if (block.length > 25) {
        bits.push(`<p class="muted small">${escapeHtml(t("admin.df.showing_partial", { total: block.length }))}</p>`);
      }
    }
    if (anyTable) {
      wrap.innerHTML = bits.join("");
      return;
    }
    wrap.innerHTML = `<pre class="admin-inline-json">${escapeHtml(JSON.stringify(layers, null, 2))}</pre>`;
    return;
  }
  wrap.innerHTML = `<p class="muted small">${escapeHtml(String(layers))}</p>`;
}

async function adminLoadDf() {
  const wrap = $("#adminDfWrap");
  const raw = $("#adminDfRaw");
  if (wrap) wrap.innerHTML = `<span class="muted small">${escapeHtml(t("admin.df.loading"))}</span>`;
  const r = await fetch("/api/admin/docker/df");
  const data = await r.json().catch(() => ({}));
  if (raw) raw.textContent = JSON.stringify(data, null, 2);
  if (!r.ok) {
    if (wrap) wrap.innerHTML = `<p class="muted small">${escapeHtml(apiDetailMessage(data, r.statusText))}</p>`;
    return;
  }
  renderAdminDiskUsage(data);
}

async function loadAdmin() {
  const pingBadge = $("#adminPingBadge");
  const verBadge = $("#adminVerBadge");
  const healthLine = $("#adminHealthLine");
  if (healthLine) healthLine.textContent = "";

  const [settingsRes, infoRes, filesRes] = await Promise.all([
    fetch("/api/settings"),
    fetch("/api/admin/info"),
    fetch("/api/admin/data-files"),
  ]);

  if (settingsRes.ok) {
    const s = await settingsRes.json();
    const urlEl = $("#adminDockerUrl");
    if (urlEl) urlEl.value = typeof s.docker_base_url === "string" ? s.docker_base_url : "";
    const displayNameEl = $("#adminAppDisplayName");
    if (displayNameEl) {
      const dn = typeof s.app_display_name === "string" ? s.app_display_name.trim() : "";
      displayNameEl.value = dn || DEFAULT_APP_DISPLAY_NAME;
    }
    syncAdminDashCardScaleUi(s.dash_bookmark_card_scale_percent ?? 100);
    applyDashBookmarkCardScaleFromSettings(s);
    syncAdminUiThemeUi(s.ui_theme ?? DEFAULT_UI_THEME);
    syncAdminUiLanguageUi(s.ui_language);
    const lc = $("#adminLinksCount");
    if (lc) lc.textContent = String(s.links_saved_count ?? 0);
    const bc = $("#adminDashBookmarksCount");
    if (bc) bc.textContent = String(s.dash_bookmarks_count ?? 0);
    if (verBadge) verBadge.textContent = t("admin.app_version", { version: s.app_version || t("common.em_dash") });
  }

  if (infoRes.ok) {
    const info = await infoRes.json();
    const box = $("#adminInfoBox");
    if (box) box.textContent = JSON.stringify(info, null, 2);
    if (pingBadge) {
      const ok = !!info.docker_ping;
      pingBadge.textContent = ok ? t("admin.docker.connected") : t("admin.docker.disconnected");
      pingBadge.classList.remove("admin-chip--muted", "admin-chip--ok", "admin-chip--bad");
      pingBadge.classList.add(ok ? "admin-chip--ok" : "admin-chip--bad");
    }
    const lc = $("#adminLinksCount");
    const bc = $("#adminDashBookmarksCount");
    if (lc && info.links_saved_count != null) lc.textContent = String(info.links_saved_count);
    if (bc && info.dash_bookmarks_count != null) bc.textContent = String(info.dash_bookmarks_count);
    if (verBadge && info.app_version) verBadge.textContent = t("admin.app_version", { version: info.app_version });
  }

  if (filesRes.ok) {
    const j = await filesRes.json().catch(() => ({}));
    renderAdminDataFiles(j.files || []);
  }

  const dockRes = $("#adminDockerResult");
  if (dockRes) dockRes.hidden = true;
  const pruneOut = $("#adminPruneOut");
  if (pruneOut) pruneOut.hidden = true;
}

document.addEventListener("DOMContentLoaded", async () => {
  unwrapStaleLiquidGlassWrapper();
  wireBrandLogo();
  window.DashFlexI18n.initLocale();
  window.addEventListener("dashflex:locale", () => {
    refreshUiAfterLocaleChange();
  });
  await applySettingsFromServer();

  $$(".nav-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const v = b.dataset.view;
      showView(v);
      loadViewPrimaryData(v);
    });
  });

  window.addEventListener("hashchange", () => {
    const v = viewFromLocationHash();
    if (!v) return;
    showView(v, { skipHash: true });
    loadViewPrimaryData(v);
  });

  $("#dashAddBtn")?.addEventListener("click", () => openDashBookmarkModal(null));
  $("#dashImportBtn")?.addEventListener("click", () => openDashImportModal());
  $("#dashImportClose")?.addEventListener("click", closeDashImportModal);
  $("#dashImportCancelBtn")?.addEventListener("click", closeDashImportModal);
  $("#dashImportSubmitBtn")?.addEventListener("click", () => submitDashImportFromModal());
  $("#dashImportIncludeStopped")?.addEventListener("change", () => loadDashImportModalTable());
  $("#dashImportHost")?.addEventListener("input", () => {
    if (dashImportModalCache) renderDashImportTableRows();
  });
  $("#dashImportSelectAll")?.addEventListener("click", () =>
    dashImportSelectByPredicate((_cb, inp) => dashImportValidHttpUrl(inp?.value))
  );
  $("#dashImportSelectNone")?.addEventListener("click", () => dashImportSelectByPredicate(() => false));
  $("#dashImportSelectSuggested")?.addEventListener("click", () =>
    dashImportSelectByPredicate(
      (_cb, inp, tr) => tr.dataset.importSuggested === "1" && dashImportValidHttpUrl(inp?.value)
    )
  );

  $("#dashGrid")?.addEventListener("dragstart", (ev) => {
    if (!dashBookmarkDragReorderEnabled()) {
      ev.preventDefault();
      return;
    }
    const wrap = ev.target.closest(".dash-tile-wrap");
    if (!wrap?.dataset.bookmarkId) return;
    dashDragBookmarkEl = wrap;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", wrap.dataset.bookmarkId);
    wrap.classList.add("dash-tile-wrap--dragging");
  });

  $("#dashGrid")?.addEventListener("dragend", () => {
    if (dashDragBookmarkEl) {
      dashDragBookmarkEl.classList.remove("dash-tile-wrap--dragging");
    }
    dashDragBookmarkEl = null;
  });

  $("#dashGrid")?.addEventListener("dragover", (ev) => {
    if (!dashDragBookmarkEl) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  });

  $("#dashGrid")?.addEventListener("drop", async (ev) => {
    if (!dashDragBookmarkEl) return;
    ev.preventDefault();
    const grid = $("#dashGrid");
    const dragged = dashDragBookmarkEl;
    const targetWrap = ev.target.closest(".dash-tile-wrap");

    if (targetWrap && targetWrap !== dragged) {
      const rect = targetWrap.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      if (before) grid.insertBefore(dragged, targetWrap);
      else grid.insertBefore(dragged, targetWrap.nextSibling);
    } else if (!targetWrap && (ev.target === grid || grid.contains(ev.target))) {
      grid.appendChild(dragged);
    } else {
      return;
    }

    syncLastDashBookmarksOrderFromDom();
    try {
      await persistDashBookmarkOrder();
    } catch (e) {
      alert(e.message || t("dash.error.reorder"));
      await loadDashBookmarks();
    }
  });

  $("#dashGrid")?.addEventListener("click", (ev) => {
    const logBtn = ev.target.closest('[data-act="dash-logs-live"]');
    if (logBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const id = logBtn.dataset.containerId;
      if (!id) return;
      const wrap = logBtn.closest(".dash-tile-wrap");
      const title = wrap?.querySelector(".dash-tile-title")?.textContent?.trim() || id;
      void showLogsLive(id, title);
      return;
    }
    const editBtn = ev.target.closest('[data-act="dash-edit"]');
    if (editBtn) {
      ev.preventDefault();
      const wrap = editBtn.closest(".dash-tile-wrap");
      const bid = wrap?.dataset.bookmarkId;
      const row = lastDashBookmarks.find((x) => x.id === bid);
      if (row) openDashBookmarkModal(row);
      return;
    }
    const delBtn = ev.target.closest('[data-act="dash-remove"]');
    if (delBtn) {
      ev.preventDefault();
      const wrap = delBtn.closest(".dash-tile-wrap");
      const bid = wrap?.dataset.bookmarkId;
      if (!bid || !confirm(t("dash.confirm.remove_tile"))) return;
      fetch(`/api/dash-bookmarks/${encodeURIComponent(bid)}`, { method: "DELETE" }).then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          alert(apiDetailMessage(j, t("dash.alert.remove_failed")));
          return;
        }
        loadDashBookmarks();
      });
    }
  });

  $("#dashBmForm")?.addEventListener("submit", saveDashBookmarkFromForm);
  $("#dashBmClose")?.addEventListener("click", closeDashBookmarkModal);
  $("#dashBmCancelBtn")?.addEventListener("click", closeDashBookmarkModal);
  $("#dashBmDelete")?.addEventListener("click", deleteDashBookmarkConfirmed);
  $("#dashBmIconUrl")?.addEventListener("input", () => {
    if (!$("#dashBmIconFile")?.files?.[0]) renderDashBmPreview();
  });
  wireTapClick($("#dashBmRemoveIconBtn"), () => {
    dashBmRemoveIconOnSave = true;
    syncDashBmRemoveIconBtn();
    renderDashBmPreview();
  });
  $("#dashBmIconFile")?.addEventListener("change", () => {
    if ($("#dashBmIconFile")?.files?.[0]) {
      dashBmRemoveIconOnSave = false;
      syncDashBmRemoveIconBtn();
    }
    renderDashBmPreview();
  });
  $("#dashBmIcon")?.addEventListener("input", () => {
    if (!$("#dashBmIconFile")?.files?.[0]) renderDashBmPreview();
  });

  $("#dashBookmarkModal")?.addEventListener("cancel", (ev) => {
    if (ev.target === $("#dashBookmarkModal")) closeDashBookmarkModal();
  });

  $("#dashImportModal")?.addEventListener("cancel", (ev) => {
    if (ev.target === $("#dashImportModal")) closeDashImportModal();
  });

  $("#refreshContainers")?.addEventListener("click", () => loadContainers());
  $("#showAllContainers")?.addEventListener("change", async () => {
    loadContainers();
    const chk = $("#showAllContainers");
    if (!chk) return;
    try {
      const r = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ containers_show_stopped_default: !!chk.checked }),
      });
      if (r.ok) await applySettingsFromServer();
    } catch (_) {
      
    }
  });

  $("#containersTable thead")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".th-sort");
    if (!btn?.dataset.sort) return;
    const k = btn.dataset.sort;
    if (containerSort.key === k) {
      containerSort.dir = containerSort.dir === "asc" ? "desc" : "asc";
    } else {
      containerSort.key = k;
      containerSort.dir = "asc";
    }
    renderContainerTableBody();
  });

  $("#refreshImages")?.addEventListener("click", () => loadImages());

  $("#adminSaveDocker")?.addEventListener("click", async () => {
    const dockerUrl = $("#adminDockerUrl")?.value.trim() ?? "";
    const r = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docker_base_url: dockerUrl }),
    });
    if (!r.ok) {
      alert(t("admin.alert.save_docker_url"));
      return;
    }
    await applySettingsFromServer();
    await loadAdmin();
    alert(t("admin.alert.docker_saved"));
  });

  $("#adminSaveInterface")?.addEventListener("click", async () => {
    const raw = $("#adminAppDisplayName")?.value ?? "";
    const scale = clampDashBookmarkCardScalePct($("#adminDashCardScale")?.value ?? 100);
    const theme = $("#adminUiTheme")?.value ?? DEFAULT_UI_THEME;
    const uiLanguage = ($("#adminUiLanguage")?.value || "").trim().toLowerCase();
    const r = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_display_name: raw.trim(),
        dash_bookmark_card_scale_percent: scale,
        ui_theme: normalizeUiTheme(theme),
        ui_language: uiLanguage === "en" ? "en" : "pt",
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(apiDetailMessage(j, t("admin.alert.save_interface")));
      return;
    }
    await applySettingsFromServer();
    await loadAdmin();
  });

  $("#adminUiLanguage")?.addEventListener("change", () => {
    const lang = ($("#adminUiLanguage")?.value || "").trim().toLowerCase();
    if (lang === "pt" || lang === "en") {
      window.DashFlexI18n.setLocale(lang, { persistLocal: true });
    }
  });

  $("#adminDashCardScale")?.addEventListener("input", () => {
    const rng = $("#adminDashCardScale");
    const lab = $("#adminDashCardScaleVal");
    const v = rng ? clampDashBookmarkCardScalePct(rng.value) : 100;
    if (lab) lab.textContent = String(v);
    applyDashBookmarkCardScaleFromSettings({ dash_bookmark_card_scale_percent: v });
  });

  $("#adminUiTheme")?.addEventListener("change", () => {
    const theme = $("#adminUiTheme")?.value ?? DEFAULT_UI_THEME;
    applyUiTheme(theme);
  });

  $("#adminTestDocker")?.addEventListener("click", async () => {
    const dockerUrl = $("#adminDockerUrl")?.value.trim() ?? "";
    const out = $("#adminDockerResult");
    if (!out) return;
    out.hidden = false;
    out.textContent = t("admin.docker.testing");
    const r = await fetch("/api/admin/docker/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: dockerUrl }),
    });
    const j = await r.json().catch(() => ({}));
    out.textContent = JSON.stringify(j, null, 2);
  });

  $("#adminClearLinks")?.addEventListener("click", async () => {
    if (!confirm(t("admin.confirm.clear_links"))) return;
    const r = await fetch("/api/admin/links", { method: "DELETE" });
    if (!r.ok) {
      alert(t("admin.alert.clear_links_failed"));
      return;
    }
    await loadAdmin();
    await loadContainers();
  });

  $("#adminClearDashBookmarks")?.addEventListener("click", async () => {
    if (!confirm(t("admin.confirm.clear_bookmarks"))) return;
    const r = await fetch("/api/admin/dash-bookmarks", { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(apiDetailMessage(j, t("admin.alert.clear_bookmarks_failed")));
      return;
    }
    await loadAdmin();
    lastDashBookmarks = [];
    if (!$("#view-dash")?.classList.contains("hidden")) await loadDashBookmarks();
    if (isOverviewVisible()) void loadOverviewLive();
    else void refreshDockerMeta();
  });

  $("#adminRefreshDf")?.addEventListener("click", () => adminLoadDf());

  $("#adminRunPrune")?.addEventListener("click", async () => {
    const dangling = !!$("#adminPruneImages")?.checked;
    const stopped = !!$("#adminPruneStopped")?.checked;
    const nets = !!$("#adminPruneNetworks")?.checked;
    if (!dangling && !stopped && !nets) {
      alert(t("admin.prune.alert.select_option"));
      return;
    }
    const labels = [];
    if (dangling) labels.push(t("admin.prune.label.dangling"));
    if (stopped) labels.push(t("admin.prune.label.stopped"));
    if (nets) labels.push(t("admin.prune.label.networks"));
    if (
      !confirm(
        `${t("admin.prune.confirm.title")}\n\n${t("admin.prune.confirm.irreversible")}\n• ${labels.join("\n• ")}\n\n${t("admin.prune.confirm.continue")}`
      )
    ) {
      return;
    }
    const out = $("#adminPruneOut");
    if (out) {
      out.hidden = false;
      out.textContent = t("admin.prune.running");
    }
    const r = await fetch("/api/admin/docker/prune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dangling_images: dangling,
        stopped_containers: stopped,
        unused_networks: nets,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (out) out.textContent = JSON.stringify(j, null, 2);
    if (!r.ok) {
      alert(apiDetailMessage(j, t("admin.prune.alert.failed")));
    } else if (j.errors && j.errors.length) {
      alert(t("admin.prune.alert.partial_errors"));
    }
    await adminLoadDf();
    maybeRefreshOverview();
    if (!$("#view-images")?.classList.contains("hidden")) loadImages();
  });

  $("#adminPingHealth")?.addEventListener("click", async () => {
    const line = $("#adminHealthLine");
    if (line) line.textContent = t("admin.health.querying");
    try {
      const r = await fetch("/api/health");
      const j = await r.json().catch(() => ({}));
      if (line) {
        line.textContent = r.ok
          ? `${r.status} ${r.statusText || "OK"} · ${JSON.stringify(j)}`
          : `${r.status} · ${apiDetailMessage(j, r.statusText)}`;
      }
    } catch (e) {
      if (line) line.textContent = String(e?.message || e);
    }
  });

  $("#containersTable")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const id = tr?.dataset?.id;
    if (!id) return;
    const act = btn.dataset.act;
    if (act === "logs") {
      const name = tr.querySelector("strong")?.textContent || id;
      showLogs(id, name);
      return;
    }
    if (act === "remove") {
      removeContainer(id);
      return;
    }
    actOnContainer(id, act);
  });

  $("#logsClose")?.addEventListener("click", () => {
    stopLogsLive();
    $("#logsModal")?.close();
  });
  $("#logsModal")?.addEventListener("close", stopLogsLive);

  updateContainerSortHeaders();
  const initial = restoreInitialView();
  if (initial === "overview") {
    void loadDashboard().then(() => scheduleOverviewLive());
  } else {
    void refreshDockerMeta();
  }
  loadDashBookmarks();
  let dashLayoutResizeTimer = null;
  const reflowDashLayout = () => {
    if ($("#view-dash")?.classList.contains("hidden")) return;
    if (!lastDashBookmarks.length) return;
    renderDashBookmarks(lastDashBookmarks, lastDashBookmarkContainers);
  };
  window.addEventListener("resize", () => {
    clearTimeout(dashLayoutResizeTimer);
    dashLayoutResizeTimer = setTimeout(reflowDashLayout, 220);
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(reflowDashLayout, 350);
  });
  if (initial === "containers") loadContainers();
  if (initial === "images") loadImages();
  if (initial === "admin") loadAdmin();
});
