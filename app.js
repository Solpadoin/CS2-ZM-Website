"use strict";

/* ============================================================
   OldSchool Zombie Plague — front-end
   ============================================================ */

const DEFAULT_API_BASE = "https://api.zm2.ghostbe.site";
const MAP_BASE = "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- pagination (shared) ---------- */
const PAGER = {};        // key -> current page
const PAGER_CFG = {};    // key -> render config + data
function padRow(cols) { return `<tr class="pad-row"><td colspan="${cols}">&nbsp;</td></tr>`; }
function pagerControls(key, page, pages) {
  return `<div class="pager">
    <button class="btn btn--ghost btn--tiny" data-pager="${key}" data-dir="-1"${page <= 1 ? " disabled" : ""}>‹</button>
    <span class="muted">${page} / ${pages}</span>
    <button class="btn btn--ghost btn--tiny" data-pager="${key}" data-dir="1"${page >= pages ? " disabled" : ""}>›</button></div>`;
}
function renderPaged(key, rows, cfg) { PAGER_CFG[key] = { rows, ...cfg }; renderPagedFromCache(key); }
function renderPagedFromCache(key) {
  const c = PAGER_CFG[key];
  if (!c) return;
  const per = c.perPage;
  const pages = Math.max(1, Math.ceil(c.rows.length / per));
  let page = PAGER[key] || 1;
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  PAGER[key] = page;
  const slice = c.rows.slice((page - 1) * per, page * per);
  const host = $(c.hostSel);
  if (host) {
    if (c.div) {
      host.innerHTML = slice.length ? slice.map(c.rowMapper).join("")
        : `<p class="muted" style="text-align:center;padding:24px">${escapeHtml(c.emptyMsg)}</p>`;
    } else {
      let body = slice.length ? slice.map(c.rowMapper).join("") : emptyRow(c.cols, c.emptyMsg);
      for (let i = (slice.length || 1); i < per; i++) body += padRow(c.cols);
      host.innerHTML = body;
    }
  }
  const pg = $(c.pagerSel);
  if (pg) pg.innerHTML = pages > 1 ? pagerControls(key, page, pages) : "";
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pager]");
  if (!b) return;
  const key = b.dataset.pager;
  PAGER[key] = (PAGER[key] || 1) + Number(b.dataset.dir);
  renderPagedFromCache(key);
});

let apiBase = "";

/* ---------- api base resolution (same logic as before) ---------- */
async function loadConfig() {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("api");
  if (fromQuery) localStorage.setItem("zm-api-base", fromQuery);

  const host = window.location.hostname;
  if (host === "195.137.244.196") { apiBase = ""; return; }

  const stored = localStorage.getItem("zm-api-base");
  if (stored) { apiBase = stored; return; }

  try {
    const r = await fetch("./config.json", { cache: "no-store" });
    if (r.ok) { apiBase = (await r.json()).apiBaseUrl || ""; return; }
  } catch { /* static hosting works without config */ }

  apiBase = (host === "localhost" || host === "127.0.0.1") ? "" : DEFAULT_API_BASE;
}

function apiUrl(path) { return `${apiBase.replace(/\/$/, "")}${path}`; }

async function api(path) {
  const r = await fetch(apiUrl(path), { cache: "no-store" });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

/* ---------- formatting ---------- */
const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  const ss = s % 60;
  return m ? `${m}m ${ss}s` : `${ss}s`;
}
function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
const initials = (name) => (name || "?").trim().slice(0, 2).toUpperCase();
const mapThumb = (map) => `${MAP_BASE}/thumbs/${(map || "de_dust2").toLowerCase().replace(/[^a-z0-9_]/g, "")}_png.png`;

/* ============================================================
   DEMO DATA — used as a visual placeholder until the stats
   endpoints (profiles.json / A2S_PLAYER) are wired on the API.
   Shape mirrors the real ZombiePlague profile schema.
   ============================================================ */
const DEMO_LEADERBOARD = [
  { name: "Krelions",     level: 12, experience: 4820, prestige: 1, totalKills: 1843, infections: 402, totalWins: 219, roundsPlayed: 1310, bestWinStreak: 11, ammoPacks: 640 },
  { name: "NoScope_Nina", level: 11, experience: 4310, prestige: 1, totalKills: 1720, infections: 388, totalWins: 205, roundsPlayed: 1244, bestWinStreak: 9,  ammoPacks: 512 },
  { name: "PatientZero",  level: 10, experience: 3980, prestige: 0, totalKills: 1655, infections: 511, totalWins: 176, roundsPlayed: 1188, bestWinStreak: 14, ammoPacks: 470 },
  { name: "GraveDigger",  level: 9,  experience: 3540, prestige: 0, totalKills: 1490, infections: 297, totalWins: 168, roundsPlayed: 1090, bestWinStreak: 8,  ammoPacks: 421 },
  { name: "biteMe",       level: 9,  experience: 3390, prestige: 0, totalKills: 1402, infections: 344, totalWins: 151, roundsPlayed: 1033, bestWinStreak: 7,  ammoPacks: 388 },
  { name: "ColdSteel",    level: 8,  experience: 2980, prestige: 0, totalKills: 1290, infections: 210, totalWins: 149, roundsPlayed: 980,  bestWinStreak: 10, ammoPacks: 351 },
  { name: "Mother_Hydra", level: 8,  experience: 2870, prestige: 0, totalKills: 1188, infections: 470, totalWins: 122, roundsPlayed: 940,  bestWinStreak: 6,  ammoPacks: 333 },
  { name: "Reflex",       level: 7,  experience: 2510, prestige: 0, totalKills: 1077, infections: 188, totalWins: 131, roundsPlayed: 870,  bestWinStreak: 9,  ammoPacks: 299 },
  { name: "ash_fall",     level: 7,  experience: 2380, prestige: 0, totalKills: 996,  infections: 276, totalWins: 110, roundsPlayed: 812,  bestWinStreak: 5,  ammoPacks: 274 },
  { name: "Vector",       level: 6,  experience: 1990, prestige: 0, totalKills: 861,  infections: 165, totalWins: 98,  roundsPlayed: 720,  bestWinStreak: 6,  ammoPacks: 240 },
  { name: "SilentK",      level: 6,  experience: 1840, prestige: 0, totalKills: 792,  infections: 203, totalWins: 84,  roundsPlayed: 690,  bestWinStreak: 4,  ammoPacks: 211 },
  { name: "rotten_ray",   level: 5,  experience: 1520, prestige: 0, totalKills: 640,  infections: 149, totalWins: 71,  roundsPlayed: 588,  bestWinStreak: 5,  ammoPacks: 180 },
];
const DEMO_PLAYERS = [
  { name: "PatientZero",  score: 34, duration: 2115 },
  { name: "Krelions",     score: 29, duration: 1890 },
  { name: "biteMe",       score: 22, duration: 1420 },
  { name: "ColdSteel",    score: 18, duration: 1180 },
  { name: "ash_fall",     score: 15, duration: 940 },
  { name: "Reflex",       score: 11, duration: 610 },
  { name: "Vector",       score: 7,  duration: 360 },
];

/* ============================================================
   Shared chrome: nav, toast
   ============================================================ */
function initChrome() {
  const toggle = $("[data-nav-toggle]");
  const links = $(".nav-links");
  if (toggle && links) toggle.addEventListener("click", () => links.classList.toggle("open"));

  // active nav link
  const page = document.body.dataset.page;
  $$(".nav-links a").forEach((a) => { if (a.dataset.nav === page) a.classList.add("active"); });

  // copy endpoint buttons
  $$("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy;
      try { await copyText(text); toast(`Copied ${text}`); } catch { toast("Copy failed"); }
    });
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const i = document.createElement("textarea");
  i.value = text; i.style.position = "fixed"; i.style.opacity = "0";
  document.body.appendChild(i); i.select(); document.execCommand("copy"); i.remove();
}

let toastTimer = 0;
function toast(msg) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1900);
}

/* ============================================================
   Live server status (shared: nav pill + home widgets)
   ============================================================ */
function setLivePill(online, players) {
  const pill = $("[data-live-pill]");
  if (!pill) return;
  pill.classList.toggle("is-online", !!online);
  pill.classList.toggle("is-offline", !online);
  const label = $("[data-live-label]", pill);
  if (label) label.innerHTML = online ? `<b>${players}</b> online` : "Offline";
}

async function refreshStatus() {
  try {
    const data = await api("/api/status");
    const srv = data.cs2?.server || {};
    const online = !!srv.online;
    const players = srv.players ?? 0, max = srv.maxPlayers ?? 0, bots = srv.bots ?? 0;

    setLivePill(online, players);

    setText("[data-map]", (srv.map || "de_dust2"));
    setText("[data-players]", `${players}/${max || 32}`);
    setText("[data-maxslots]", max || 64);
    setText("[data-bots]", bots);
    setText("[data-uptime]", data.host ? fmtUptime(data.host.uptime) : "-");
    setText("[data-status-word]", online ? "Online" : "Offline");

    const img = $("[data-map-img]");
    if (img) { img.onerror = () => { img.style.display = "none"; }; img.src = mapThumb(srv.map); img.alt = srv.map || "map"; }

    // telemetry meters (home side panel)
    if (data.host) {
      setMeter("cpu", data.host.cpu?.percent, `${data.host.cpu?.cores ?? "-"} cores`);
      setMeter("ram", data.host.memory?.percent, bytes(data.host.memory?.used) + " / " + bytes(data.host.memory?.total));
      setMeter("disk", data.host.disk?.percent, bytes(data.host.disk?.used) + " / " + bytes(data.host.disk?.total));
    }
    return true;
  } catch {
    setLivePill(false, 0);
    setText("[data-status-word]", "Offline");
    return false;
  }
}

function setText(sel, val) { $$(sel).forEach((el) => { el.textContent = val; }); }
function setMeter(key, pct, meta) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const fill = $(`[data-meter="${key}"] .meter-fill`);
  const val = $(`[data-meter="${key}"] [data-meter-val]`);
  const m = $(`[data-meter="${key}"] [data-meter-meta]`);
  if (fill) fill.style.width = `${p}%`;
  if (val) val.textContent = `${Math.round(p)}%`;
  if (m && meta) m.textContent = meta;
}
function bytes(v) {
  if (!Number.isFinite(v)) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"]; let s = v, i = 0;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/* ============================================================
   Home: live players + leaderboard teaser
   ============================================================ */
async function initHome() {
  await refreshStatus();
  setInterval(refreshStatus, 5000);
  loadPlayers();
  loadLeaderboard($("[data-lb-teaser]"), 5, true);
}

async function loadPlayers() {
  const host = $("[data-players-table]");
  if (!host) return;
  let rows = [];
  try { const data = await api("/api/players"); rows = data.players || []; } catch { rows = []; }
  // humans first, then bots
  rows = rows.slice().sort((a, b) => (a.bot === b.bot) ? 0 : a.bot ? 1 : -1).map((p, i) => ({ ...p, _rank: i + 1 }));
  const count = $("[data-players-count]");
  if (count) count.textContent = `${rows.length} online`;

  renderPaged("home-players", rows, {
    perPage: 7, hostSel: "[data-players-table]", pagerSel: "[data-players-pager]", cols: 3,
    emptyMsg: "No players on the server right now.",
    rowMapper: (p) => `
      <tr>
        <td class="rank ${rankClass(p._rank - 1)}">${p._rank}</td>
        <td><div class="pname"><span class="pav">${initials(p.name)}</span>${escapeHtml(p.name)}${p.bot ? ' <span class="tag" style="padding:2px 7px;font-size:10px">BOT</span>' : ""}</div></td>
        <td class="num">${p.team === 3 ? "Human" : p.team === 2 ? "Zombie" : "—"}</td>
      </tr>`
  });
}

async function loadLeaderboard(host, limit, teaser) {
  if (!host) return;
  let rows = [];
  try {
    const data = await api("/api/leaderboard");
    rows = data.players || [];
  } catch { rows = []; }
  window.__LB = { rows };
  renderLeaderboard(rows.slice(0, limit || rows.length), host, teaser);
}

function renderLeaderboard(rows, host, teaser) {
  if (!rows.length) { host.innerHTML = emptyRow(teaser ? 4 : 6, "No ranked players yet."); return; }
  host.innerHTML = rows.map((p, i) => `
    <tr>
      <td class="rank ${rankClass(i)}">${medal(i)}</td>
      <td><div class="pname"><span class="pav">${initials(p.name)}</span>${escapeHtml(p.name)}</div></td>
      <td><span class="lvl">LVL ${p.level}${p.prestige ? ` · P${p.prestige}` : ""}</span></td>
      <td class="num pscore">${fmtInt(p.experience)}</td>
      ${teaser ? "" : `<td class="num">${fmtInt(p.totalKills)}</td><td class="num">${fmtInt(p.infections)}</td>`}
      <td class="num">${fmtInt(p.totalWins)}</td>
    </tr>`).join("");
}

/* ============================================================
   Leaderboard page: search + sort
   ============================================================ */
async function refreshLB() {
  try { const d = await api("/api/leaderboard"); window.__LB = { rows: d.players || [] }; }
  catch { window.__LB = { rows: [] }; }
}

function initLeaderboardPage() {
  refreshStatus(); setInterval(refreshStatus, 8000);
  const host = $("[data-lb-full]");
  if (!host) return;

  let sortKey = "experience", query = "";
  const apply = () => {
    const data = window.__LB?.rows || [];
    const rows = data
      .filter((p) => (p.name || "").toLowerCase().includes(query.toLowerCase()))
      .slice().sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0))
      .map((p, i) => ({ ...p, _rank: i + 1 }));
    renderPaged("lb-full", rows, {
      perPage: 12, hostSel: "[data-lb-full]", pagerSel: "[data-lb-pager]", cols: 7,
      emptyMsg: query ? "No survivors match your search." : "No ranked survivors yet.",
      rowMapper: (p) => `
        <tr>
          <td class="rank ${rankClass(p._rank - 1)}">${medal(p._rank - 1)}</td>
          <td><div class="pname"><span class="pav">${initials(p.name)}</span>${escapeHtml(p.name)}</div></td>
          <td><span class="lvl">LVL ${p.level}${p.prestige ? ` · P${p.prestige}` : ""}</span></td>
          <td class="num pscore">${fmtInt(p.experience)}</td>
          <td class="num">${fmtInt(p.totalKills)}</td>
          <td class="num">${fmtInt(p.infections)}</td>
          <td class="num">${fmtInt(p.totalWins)}</td>
        </tr>`
    });
  };

  refreshLB().then(apply);

  const search = $("[data-lb-search]");
  if (search) search.addEventListener("input", (e) => { query = e.target.value; PAGER["lb-full"] = 1; apply(); });
  $$("[data-sort]").forEach((btn) => btn.addEventListener("click", () => {
    $$("[data-sort]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active"); sortKey = btn.dataset.sort; PAGER["lb-full"] = 1; apply();
  }));

  setInterval(() => refreshLB().then(apply), 20000);
}

/* ============================================================
   helpers
   ============================================================ */
const rankClass = (i) => i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
const medal = (i) => i < 3 ? ["01", "02", "03"][i] : String(i + 1).padStart(2, "0");
function emptyRow(cols, msg) { return `<tr><td colspan="${cols}" style="text-align:center;color:var(--muted);padding:34px">${escapeHtml(msg)}</td></tr>`; }
function togglePreview(sel, on) { const el = $(sel); if (el) el.classList.toggle("hidden", !on); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ============================================================
   Cabinet: Steam sign-in
   ============================================================ */
async function initProfile() {
  refreshStatus(); setInterval(refreshStatus, 8000);

  const loginBtn = $("[data-steam-login]");
  if (loginBtn) {
    const redirect = `${location.origin}/profile.html`;
    loginBtn.href = apiUrl(`/api/auth/steam/login?redirect=${encodeURIComponent(redirect)}`);
  }

  // reflect ?login=failed and clean the query string
  const params = new URLSearchParams(location.search);
  if (params.get("login") === "failed") $("[data-login-error]")?.classList.remove("hidden");
  if (params.has("login")) history.replaceState({}, "", location.pathname);

  let me = { authenticated: false };
  try {
    const r = await fetch(apiUrl("/api/auth/me"), { credentials: "include", cache: "no-store" });
    me = await r.json();
  } catch {}

  const loginCard = $("[data-login-card]");
  const userCard = $("[data-user-card]");
  if (me.authenticated) {
    setText("[data-user-name]", me.name || "Survivor");
    setText("[data-user-steamid]", me.steamId || "—");
    const av = $("[data-user-avatar]"); if (av && me.avatar) av.src = me.avatar;
    const url = $("[data-user-steamurl]"); if (url) url.href = me.profileUrl || `https://steamcommunity.com/profiles/${me.steamId}`;
    loginCard?.classList.add("hidden");
    userCard?.classList.remove("hidden");
  } else {
    loginCard?.classList.remove("hidden");
    userCard?.classList.add("hidden");
  }

  $("[data-logout]")?.addEventListener("click", async (e) => {
    e.preventDefault();
    try { await fetch(apiUrl("/api/auth/logout"), { credentials: "include" }); } catch {}
    location.href = "./profile.html";
  });
}

/* ============================================================
   Admin (staff panel)
   ============================================================ */
let ADMIN_PERMS = null;
function adminApi(path, opts = {}) {
  return fetch(apiUrl(path), { credentials: "include", cache: "no-store", ...opts });
}
const teamName = (t) => t === 3 ? "CT" : t === 2 ? "Zombie" : "—";
function fmtClock(unixSec) {
  return new Date((unixSec || 0) * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

async function setupAdminNav() {
  let me;
  try { me = await (await adminApi("/api/admin/me")).json(); } catch { return; }
  if (!me || !me.isAdmin) return;
  ADMIN_PERMS = me.perms || {};
  const link = $('.nav-links a[data-nav="profile"]');
  if (!link || $(".cab-menu")) return;
  const wrap = document.createElement("div");
  wrap.className = "cab-menu";
  wrap.innerHTML = `<a href="#" data-nav="profile">Cabinet ▾</a>
    <div class="cab-menu-list"><a href="./profile.html">Profile</a><a href="./admin.html">Administration</a></div>`;
  link.replaceWith(wrap);
  const toggle = $("a", wrap), list = $(".cab-menu-list", wrap);
  toggle.addEventListener("click", (e) => { e.preventDefault(); list.classList.toggle("open"); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) list.classList.remove("open"); });
}

function actionButtons(steamId, name, offline) {
  const b = [];
  if (!offline && ADMIN_PERMS?.kick) b.push(`<button class="btn btn--ghost btn--tiny" data-act="kick" data-sid="${steamId}" data-name="${escapeHtml(name)}">Kick</button>`);
  if (ADMIN_PERMS?.ban) b.push(`<button class="btn btn--danger btn--tiny" data-act="ban" data-sid="${steamId}" data-name="${escapeHtml(name)}">Ban</button>`);
  if (offline && ADMIN_PERMS?.unban) b.push(`<button class="btn btn--ghost btn--tiny" data-act="unban" data-sid="${steamId}" data-name="${escapeHtml(name)}">Unban</button>`);
  return b.join(" ") || '<span class="muted" style="font-size:12px">—</span>';
}

async function loadAdminData() {
  try {
    const [players, chat, log] = await Promise.all([
      adminApi("/api/admin/players").then(r => r.json()),
      adminApi("/api/admin/chat").then(r => r.json()),
      adminApi("/api/admin/log").then(r => r.json())
    ]);
    const online = players.online || [];
    setText("[data-admin-online-count]", `${online.length} online`);
    renderPaged("adm-online", online, {
      perPage: 8, hostSel: "[data-admin-online]", pagerSel: "[data-admin-online-pager]", cols: 3,
      emptyMsg: "No players online.",
      rowMapper: (p) => `<tr><td><div class="pname"><span class="pav">${initials(p.name)}</span>${escapeHtml(p.name)}</div></td>
        <td class="muted">${teamName(p.team)}</td>
        <td class="num">${actionButtons(String(p.steamId), p.name, false)}</td></tr>`
    });

    const recent = players.recent || [];
    renderPaged("adm-recent", recent, {
      perPage: 8, hostSel: "[data-admin-recent]", pagerSel: "[data-admin-recent-pager]", cols: 2,
      emptyMsg: "No players in the last hour.",
      rowMapper: (p) => `<tr><td><div class="pname"><span class="pav">${initials(p.name || "?")}</span>${escapeHtml(p.name || p.steamId)}</div></td>
        <td class="num">${actionButtons(String(p.steamId), p.name || String(p.steamId), true)}</td></tr>`
    });

    const msgs = chat.messages || [];
    const ch = $("[data-admin-chat]");
    ch.innerHTML = msgs.length ? msgs.map(m => `
      <div class="chat-line"><span class="ct">${fmtClock(m.t)}</span>
      <span class="cn ${m.team === 3 ? "" : "t2"}">${escapeHtml(m.name)}${m.teamOnly ? " (team)" : ""}:</span>
      <span class="cx">${escapeHtml(m.text)}</span></div>`).join("")
      : `<p class="muted" style="text-align:center;padding:24px">No chat in the last 30 minutes.</p>`;
    ch.scrollTop = ch.scrollHeight;

    const entries = log.entries || [];
    renderPaged("adm-log", entries, {
      div: true, perPage: 8, hostSel: "[data-admin-log]", pagerSel: "[data-admin-log-pager]",
      emptyMsg: "No actions yet.",
      rowMapper: (e) => `<div class="log-entry"><span class="la ${escapeHtml(e.action)}">${escapeHtml(e.action)}</span>
        <b> ${escapeHtml(String(e.targetSteamId))}</b> · <span class="lm">${escapeHtml(e.result || "")}</span><br>
        <span class="lm">by ${escapeHtml(e.adminName || "?")} · ${fmtClock(e.t)} · "${escapeHtml(e.reason || "")}"</span></div>`
    });
  } catch {}
}

function initAdminModal() {
  const modal = $("[data-admin-modal]");
  let cur = { action: "", steamId: "", name: "" };
  const durWrap = $("[data-modal-duration-wrap]");
  const reasonInput = $("[data-modal-reason]");
  const errEl = $("[data-modal-error]");
  const close = () => modal.classList.add("hidden");

  window.__openAction = (action, steamId, name) => {
    cur = { action, steamId, name };
    setText("[data-modal-title]", action.charAt(0).toUpperCase() + action.slice(1) + " player");
    setText("[data-modal-target]", `${name} · ${steamId}`);
    reasonInput.value = ""; errEl.classList.add("hidden");
    durWrap.classList.toggle("hidden", action !== "ban");
    $$("[data-dur]").forEach(b => b.classList.toggle("active", b.dataset.dur === "0"));
    modal.classList.remove("hidden");
  };
  $("[data-modal-close]").addEventListener("click", (e) => { e.preventDefault(); close(); });
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  $$("[data-reason-preset]").forEach(b => b.addEventListener("click", () => { reasonInput.value = b.dataset.reasonPreset; }));
  $$("[data-dur]").forEach(b => b.addEventListener("click", () => { $$("[data-dur]").forEach(x => x.classList.remove("active")); b.classList.add("active"); }));

  $("[data-modal-confirm]").addEventListener("click", async () => {
    const reason = reasonInput.value.trim().slice(0, 80);
    if (!reason) { errEl.textContent = "Please provide a reason."; errEl.classList.remove("hidden"); return; }
    const minutes = cur.action === "ban" ? Number($("[data-dur].active")?.dataset.dur || 0) : 0;
    try {
      const r = await adminApi("/api/admin/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: cur.action, targetSteamId: cur.steamId, reason, minutes })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { errEl.textContent = j.error || "Action failed."; errEl.classList.remove("hidden"); return; }
      close(); toast(`${cur.action} sent`); setTimeout(loadAdminData, 800);
    } catch { errEl.textContent = "Network error."; errEl.classList.remove("hidden"); }
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (btn) window.__openAction(btn.dataset.act, btn.dataset.sid, btn.dataset.name);
  });
}

async function initAdminPage() {
  refreshStatus(); setInterval(refreshStatus, 8000);
  let me;
  try { me = await (await adminApi("/api/admin/me")).json(); } catch { me = { isAdmin: false }; }
  if (!me.isAdmin) { $("[data-admin-denied]").classList.remove("hidden"); return; }
  ADMIN_PERMS = me.perms || {};
  $("[data-admin-body]").classList.remove("hidden");
  initAdminModal();
  loadAdminData();
  setInterval(loadAdminData, 5000);
}

/* ============================================================
   boot
   ============================================================ */
loadConfig().then(() => {
  initChrome();
  setupAdminNav();
  const page = document.body.dataset.page;
  if (page === "home") initHome();
  else if (page === "leaderboard") initLeaderboardPage();
  else if (page === "profile") initProfile();
  else if (page === "admin") initAdminPage();
  else { refreshStatus(); setInterval(refreshStatus, 8000); } // other pages still show live pill
});
