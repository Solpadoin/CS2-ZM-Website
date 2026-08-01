"use strict";

const dgram = require("node:dgram");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const net = require("node:net");

const execFileAsync = promisify(execFile);

const VERSION = "1.8.0";
const PORT = Number(process.env.PORT || 3000);
// Frontend lives in the repo root (GitHub Pages serves the site). Locally this
// lets `node server.js` preview the site; on the API host it only holds
// server.js/package.json, so non-/api requests simply 404 there.
const PUBLIC_DIR = __dirname;
const CS2_HOST = process.env.CS2_HOST || "127.0.0.1";
const CS2_PORT = Number(process.env.CS2_PORT || 27015);
const SERVER_IP = process.env.SERVER_IP || "195.137.244.196";
const SERVER_NAME = process.env.SERVER_NAME || "CS2-ZM-Test";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const MAP_ASSET_BASE = process.env.MAP_ASSET_BASE || "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images";
// Path to the ZombiePlague persisted player profiles (leaderboard source).
// Empty/missing file => /api/leaderboard reports available:false and the site
// falls back to preview data. Point this at the live profiles file once the
// plugin's profile persistence is enabled.
const PROFILES_PATH = process.env.PROFILES_PATH || "/opt/cs2/server/game/csgo/addons/cs2fixes/data/account_profiles.json";

// --- Steam Sign-In (OpenID 2.0) ---
const STEAM_API_KEY = process.env.STEAM_API_KEY || "";                 // from steamcommunity.com/dev/apikey
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-secret";
const SITE_URL = process.env.SITE_URL || "https://zm2.ghostbe.site";   // frontend origin (redirect target)
const SELF_URL = process.env.SELF_URL || "https://api.zm2.ghostbe.site"; // this API origin (OpenID realm)
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ".ghostbe.site";     // shared across sub-domains
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

// --- Admin bridge (website -> plugin) ---
const ADMINS_PATH = process.env.ADMINS_PATH || "/opt/cs2/server/game/csgo/addons/cs2fixes/configs/admins.jsonc";
const ADMIN_DATA_DIR = process.env.ADMIN_DATA_DIR || "/opt/cs2/server/game/csgo/addons/cs2fixes/data";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ""; // cs2zm-logs admin-action feed
const DISCORD_REPORTS_WEBHOOK_URL = process.env.DISCORD_REPORTS_WEBHOOK_URL || ""; // cs2zm-reports feed
const RCON_PASSWORD = process.env.RCON_PASSWORD || ""; // to reload admins after granting/revoking

// ---- admin roles (flag presets) ----
const ADMIN_ROLES = [
  { id: "root",       label: "Root",        flags: "z" },              // everything + can manage admins
  { id: "superadmin", label: "Super-Admin", flags: "abcdefghijklmn" }, // all serious perms incl. rcon, not root
  { id: "admin",      label: "Admin",       flags: "bcde" },           // kick + ban + unban
  { id: "moder",      label: "Moder",       flags: "bcd" },            // kick + ban
  { id: "helper",     label: "Helper",      flags: "bc" }              // kick
];
function roleFromFlags(flags) {
  const f = String(flags || "");
  if (f.includes("z")) return ADMIN_ROLES[0];
  const set = new Set(f.replace(/[^a-y]/g, "").split(""));
  for (const r of ADMIN_ROLES) {
    if (r.id === "root") continue;
    const rset = new Set(r.flags.split(""));
    if (set.size === rset.size && [...rset].every((c) => set.has(c))) return r;
  }
  return { id: "custom", label: "Custom", flags: f };
}
function roleById(id) { return ADMIN_ROLES.find((r) => r.id === id) || null; }

// CORS_ORIGIN may be "*", a single origin, or a comma-separated allowlist.
const ALLOWED_ORIGINS = CORS_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean);
const ALLOW_ANY_ORIGIN = ALLOWED_ORIGINS.includes("*");

let lastCpu = null;

// Local dev frontends (localhost / 127.0.0.1 / ::1 on any port) are always allowed,
// so a developer can run the page locally without loosening the production allowlist.
function isLocalhostOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

// Reflect the request's Origin when it is allowed; otherwise fall back to the
// first configured origin so production behaviour is unchanged.
function corsOriginFor(req) {
  // Reflect the request origin (needed for credentialed requests / cookies).
  if (ALLOW_ANY_ORIGIN) return req.headers.origin || "*";
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || isLocalhostOrigin(origin))) {
    return origin;
  }
  return ALLOWED_ORIGINS[0] || "*";
}

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": corsOriginFor(req),
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function sendJson(req, res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...corsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...(extraHeaders || {})
  });
  res.end(body);
}

function mapAssets(mapName) {
  const map = (mapName || "de_dust2").toLowerCase().replace(/[^a-z0-9_]/g, "");
  return {
    icon: `${MAP_ASSET_BASE}/${map}.png`,
    radar: `${MAP_ASSET_BASE}/radars/${map}_radar_psd.png`,
    thumbnail: `${MAP_ASSET_BASE}/thumbs/${map}_png.png`,
    hero: `${MAP_ASSET_BASE}/thumbs/${map}_1_png.png`
  };
}

async function readCpuSnapshot() {
  const stat = await fs.readFile("/proc/stat", "utf8");
  const line = stat.split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = line[3] + line[4];
  const total = line.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

async function getCpuUsage() {
  const current = await readCpuSnapshot();
  if (!lastCpu) {
    lastCpu = current;
    await new Promise((resolve) => setTimeout(resolve, 120));
    return getCpuUsage();
  }

  const idleDelta = current.idle - lastCpu.idle;
  const totalDelta = current.total - lastCpu.total;
  lastCpu = current;

  return totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
}

async function getMemoryUsage() {
  const meminfo = await fs.readFile("/proc/meminfo", "utf8");
  const values = Object.fromEntries(
    meminfo.split("\n").filter(Boolean).map((line) => {
      const [key, raw] = line.split(":");
      return [key, Number(raw.trim().split(/\s+/)[0]) * 1024];
    })
  );

  const total = values.MemTotal || os.totalmem();
  const available = values.MemAvailable || os.freemem();
  const used = total - available;

  return { total, used, available, percent: total ? (used / total) * 100 : 0 };
}

async function getSwapUsage() {
  const meminfo = await fs.readFile("/proc/meminfo", "utf8");
  const values = Object.fromEntries(
    meminfo.split("\n").filter(Boolean).map((line) => {
      const [key, raw] = line.split(":");
      return [key, Number(raw.trim().split(/\s+/)[0]) * 1024];
    })
  );
  const total = values.SwapTotal || 0;
  const free = values.SwapFree || 0;
  const used = total - free;
  return { total, used, free, percent: total ? (used / total) * 100 : 0 };
}

async function getDiskUsage() {
  const { stdout } = await execFileAsync("df", ["-B1", "/"]);
  const [, row] = stdout.trim().split("\n");
  const parts = row.trim().split(/\s+/);
  const total = Number(parts[1]);
  const used = Number(parts[2]);
  const available = Number(parts[3]);
  return { total, used, available, percent: total ? (used / total) * 100 : 0 };
}

async function getCs2Process() {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "game/bin/linuxsteamrt64/cs2"]);
    const pid = stdout.trim().split("\n")[0];
    if (!pid) return null;

    const [stat, status] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile(`/proc/${pid}/status`, "utf8")
    ]);
    const statParts = stat.split(/\s+/);
    const rssPages = Number(statParts[23] || 0);
    const rssBytes = rssPages * 4096;
    const threads = /Threads:\s+(\d+)/.exec(status)?.[1];
    const vmrssKb = /VmRSS:\s+(\d+)/.exec(status)?.[1];

    return {
      pid: Number(pid),
      running: true,
      rss: vmrssKb ? Number(vmrssKb) * 1024 : rssBytes,
      threads: threads ? Number(threads) : null
    };
  } catch {
    return { running: false };
  }
}

function readCString(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return { value: buffer.toString("utf8", offset, end), offset: end + 1 };
}

function querySourceInfo(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, timeoutMs);

    socket.on("message", (message) => {
      clearTimeout(timer);
      socket.close();

      try {
        let offset = 4;
        if (message.readInt32LE(0) !== -1 || message[offset] !== 0x49) {
          resolve(null);
          return;
        }
        offset += 2;
        const name = readCString(message, offset); offset = name.offset;
        const map = readCString(message, offset); offset = map.offset;
        const folder = readCString(message, offset); offset = folder.offset;
        const game = readCString(message, offset); offset = game.offset;
        offset += 2;
        const players = message[offset++];
        const maxPlayers = message[offset++];
        const bots = message[offset++];

        resolve({
          online: true,
          name: name.value,
          map: map.value,
          mapAssets: mapAssets(map.value),
          folder: folder.value,
          game: game.value,
          players,
          maxPlayers,
          bots,
          ip: SERVER_IP,
          port
        });
      } catch {
        resolve(null);
      }
    });

    socket.on("error", () => {
      clearTimeout(timer);
      socket.close();
      resolve(null);
    });

    socket.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54, ...Buffer.from("Source Engine Query\0")]), port, host);
  });
}

// A2S_PLAYER: challenge handshake, then parse the live player list.
function queryPlayers(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { try { socket.close(); } catch {} resolve(null); }, timeoutMs);

    const sendRequest = (challenge) => {
      const buf = Buffer.alloc(9);
      buf.writeInt32LE(-1, 0);        // 0xFFFFFFFF
      buf.writeUInt8(0x55, 4);        // A2S_PLAYER header 'U'
      buf.writeInt32LE(challenge, 5); // challenge (or -1 to request one)
      socket.send(buf, port, host);
    };

    socket.on("message", (msg) => {
      try {
        if (msg.readInt32LE(0) !== -1) return;
        const type = msg.readUInt8(4);
        if (type === 0x41) { // S2C_CHALLENGE -> resend with the given challenge
          sendRequest(msg.readInt32LE(5));
          return;
        }
        if (type === 0x44) { // player list
          clearTimeout(timer);
          let offset = 5;
          const count = msg.readUInt8(offset); offset += 1;
          const players = [];
          for (let i = 0; i < count && offset < msg.length; i++) {
            offset += 1; // player index (always 0 in practice)
            const name = readCString(msg, offset); offset = name.offset;
            const score = msg.readInt32LE(offset); offset += 4;
            const duration = msg.readFloatLE(offset); offset += 4;
            players.push({ name: name.value, score, duration: Math.max(0, Math.round(duration)) });
          }
          try { socket.close(); } catch {}
          resolve(players);
        }
      } catch {
        clearTimeout(timer);
        try { socket.close(); } catch {}
        resolve(null);
      }
    });

    socket.on("error", () => { clearTimeout(timer); try { socket.close(); } catch {} resolve(null); });
    sendRequest(-1); // request a challenge first
  });
}

// Read + normalise the ZombiePlague profile store into leaderboard rows.
async function readLeaderboard() {
  const raw = await fs.readFile(PROFILES_PATH, "utf8");
  const data = JSON.parse(raw);
  const profiles = Array.isArray(data) ? data : (data.profiles || []);
  return profiles.map((p) => ({
    name: p.lastName || p.name || "Unknown",
    steamId: String(p.steamId ?? ""),
    level: p.level ?? 1,
    experience: p.experience ?? 0,
    prestige: p.prestige ?? 0,
    totalKills: p.totalKills ?? ((p.humanKills || 0) + (p.zombieKills || 0)),
    infections: p.infections ?? 0,
    totalWins: p.totalWins ?? ((p.humanWins || 0) + (p.zombieWins || 0)),
    roundsPlayed: p.roundsPlayed ?? 0,
    bestWinStreak: p.bestWinStreak ?? 0,
    ammoPacks: p.ammoPacks ?? 0
  })).sort((a, b) => b.experience - a.experience);
}

// ---- session (HMAC-signed cookie) ----
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
function sessionCookie(value, maxAgeSec) {
  return `zm_session=${value}; Domain=${COOKIE_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAgeSec}`;
}

// ---- Steam OpenID 2.0 ----
function validRedirect(target) {
  try {
    const u = new URL(target);
    const site = new URL(SITE_URL);
    if (u.hostname === site.hostname || u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.toString();
  } catch {}
  return `${SITE_URL}/profile.html`;
}
function steamLoginRedirect(returnTo) {
  const p = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": SELF_URL,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select"
  });
  return `https://steamcommunity.com/openid/login?${p.toString()}`;
}
async function verifySteamReturn(searchParams) {
  const body = new URLSearchParams(searchParams);
  body.set("openid.mode", "check_authentication");
  const r = await fetch("https://steamcommunity.com/openid/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const text = await r.text();
  if (!/is_valid\s*:\s*true/i.test(text)) return null;
  const claimed = searchParams.get("openid.claimed_id") || "";
  const m = claimed.match(/\/id\/(\d{17})$/);
  return m ? m[1] : null;
}
async function fetchSteamSummary(steamId) {
  const fallback = { steamId, name: `Survivor ${steamId.slice(-4)}`, avatar: "", profileUrl: `https://steamcommunity.com/profiles/${steamId}` };
  if (!STEAM_API_KEY) return fallback;
  try {
    const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`);
    const j = await r.json();
    const p = j?.response?.players?.[0];
    if (!p) return fallback;
    return { steamId, name: p.personaname || fallback.name, avatar: p.avatarfull || p.avatarmedium || "", profileUrl: p.profileurl || fallback.profileUrl };
  } catch { return fallback; }
}

// ---- admin bridge helpers ----
function stripJsonc(text) {
  // admins.jsonc uses // comments and no URLs/`//` inside strings, so this is safe.
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^\n"]*$/gm, "");
}
async function readAdmins() {
  try {
    const data = JSON.parse(stripJsonc(await fs.readFile(ADMINS_PATH, "utf8")));
    return data && typeof data.Admins === "object" ? data.Admins : {};
  } catch { return {}; }
}
async function getAdmin(steamId) {
  if (!steamId) return null;
  const entry = (await readAdmins())[String(steamId)];
  if (!entry) return null;
  const flags = String(entry.flags || "");
  const root = flags.includes("z");
  const role = roleFromFlags(flags);
  return {
    name: entry.name || "",
    flags,
    role: role.id,
    roleLabel: role.label,
    perms: {
      kick: root || flags.includes("c"),
      ban: root || flags.includes("d"),
      unban: root || flags.includes("e"),
      root
    }
  };
}
async function requireAdmin(req) {
  const s = verifySession(getCookie(req, "zm_session"));
  if (!s || !s.steamId) return null;
  const admin = await getAdmin(s.steamId);
  if (!admin) return null;
  return {
    steamId: String(s.steamId),
    name: s.name || admin.name,
    perms: admin.perms,
    role: admin.role,
    roleLabel: admin.roleLabel
  };
}
function csrfOk(req) {
  // Credentialed admin POSTs must come from our own site origin (blocks cross-site CSRF).
  return (req.headers.origin || "") === SITE_URL;
}
async function readAdminData(file, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(ADMIN_DATA_DIR, file), "utf8")); }
  catch { return fallback; }
}
function readRequestBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > limit) { req.destroy(); resolve(null); } });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(null));
  });
}
function humanDuration(min) {
  if (min <= 0) return "Permanent";
  if (min % 1440 === 0) { const d = min / 1440; return `${d} day${d === 1 ? "" : "s"}`; }
  if (min % 60 === 0) { const h = min / 60; return `${h} hour${h === 1 ? "" : "s"}`; }
  return `${min} min`;
}

async function lookupPlayerName(steamId) {
  try {
    const rows = await readLeaderboard();
    const hit = rows.find((r) => r.steamId === String(steamId));
    return hit ? hit.name : null;
  } catch { return null; }
}

// Fire-and-forget: mirror an admin action into the Discord cs2zm-logs channel.
async function postDiscordAdminLog(cmd) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const name = await lookupPlayerName(cmd.targetSteamId);
    const colors = { kick: 0xE67E22, ban: 0xE23C3C, unban: 0x2ECC71 };
    const titles = { kick: "👢 Player kicked", ban: "⛔ Player banned", unban: "✅ Player unbanned" };
    const profileUrl = `https://steamcommunity.com/profiles/${cmd.targetSteamId}`;
    const fields = [
      { name: "Player", value: `${name ? name + "\n" : ""}[\`${cmd.targetSteamId}\`](${profileUrl})`, inline: true },
      { name: "Admin", value: cmd.adminName || `\`${cmd.adminSteamId}\``, inline: true }
    ];
    if (cmd.action === "ban") fields.push({ name: "Duration", value: humanDuration(cmd.minutes), inline: true });
    fields.push({ name: "Reason", value: String(cmd.reason || "No reason given").slice(0, 1024), inline: false });
    const embed = {
      title: titles[cmd.action] || "Admin action",
      color: colors[cmd.action] ?? 0x888888,
      fields,
      footer: { text: "Ghostbe Studio · admin log" },
      timestamp: new Date(cmd.createdAt || Date.now()).toISOString()
    };
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Admin Log", allowed_mentions: { parse: [] }, embeds: [embed] })
    });
  } catch (e) { console.error("discord webhook failed:", e.message); }
}

// Append an in-game report to the on-disk log (kept for a future admin view).
async function appendReport(rec) {
  const file = path.join(ADMIN_DATA_DIR, "reports.json");
  let data = { reports: [] };
  try {
    const j = JSON.parse(await fs.readFile(file, "utf8"));
    if (Array.isArray(j.reports)) data = j;
  } catch {}
  data.reports.push(rec);
  if (data.reports.length > 500) data.reports = data.reports.slice(-500);
  await fs.writeFile(file, JSON.stringify(data), "utf8");
  try { await execFileAsync("chown", ["steam:steam", file]); } catch {}
  try { await fs.chmod(file, 0o664); } catch {}
}

// Fire-and-forget: mirror an in-game report into the Discord cs2zm-reports channel.
async function postDiscordReport(rec) {
  if (!DISCORD_REPORTS_WEBHOOK_URL) return;
  try {
    const profileUrl = rec.targetSteamId ? `https://steamcommunity.com/profiles/${rec.targetSteamId}` : null;
    const embed = {
      title: "🚨 Player report",
      color: 0xE23C3C,
      fields: [
        { name: "Reported", value: profileUrl ? `${rec.targetName}\n[\`${rec.targetSteamId}\`](${profileUrl})` : (rec.targetName || "—"), inline: true },
        { name: "By", value: rec.reporterName ? `${rec.reporterName}${rec.reporterSteamId ? `\n\`${rec.reporterSteamId}\`` : ""}` : "—", inline: true },
        { name: "Reason", value: String(rec.reason || "—").slice(0, 1024), inline: false }
      ],
      footer: { text: "Ghostbe Studio · in-game !report" },
      timestamp: new Date(rec.createdAt || Date.now()).toISOString()
    };
    await fetch(DISCORD_REPORTS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Reports", allowed_mentions: { parse: [] }, embeds: [embed] })
    });
  } catch (e) { console.error("discord report webhook failed:", e.message); }
}

// Minimal Source RCON client (used only to reload admins after a file edit).
function rconCommand(command) {
  return new Promise((resolve) => {
    if (!RCON_PASSWORD) { resolve({ ok: false, error: "no rcon password" }); return; }
    const sock = net.connect(CS2_PORT, CS2_HOST);
    let buf = Buffer.alloc(0), authed = false, out = "";
    const finish = (ok, data) => { try { sock.destroy(); } catch {} resolve({ ok, data }); };
    const pkt = (id, type, body) => {
      const b = Buffer.from(body, "utf8");
      const p = Buffer.alloc(b.length + 14);
      p.writeInt32LE(b.length + 10, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8);
      b.copy(p, 12);
      return p;
    };
    sock.setTimeout(4000);
    sock.on("timeout", () => finish(false, "timeout"));
    sock.on("error", () => finish(false, "error"));
    sock.on("connect", () => sock.write(pkt(1, 3, RCON_PASSWORD))); // AUTH
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < size + 4) break;
        const id = buf.readInt32LE(4), type = buf.readInt32LE(8);
        const body = buf.slice(12, size + 2).toString("utf8");
        buf = buf.slice(size + 4);
        if (!authed) {
          if (id === -1) return finish(false, "auth failed");
          if (type === 2) { authed = true; sock.write(pkt(2, 2, command)); }
        } else {
          out += body;
          setTimeout(() => finish(true, out), 120); // gather any trailing packet
        }
      }
    });
  });
}

const ADMINS_HEADER = `//---------------------
// Managed by the OldSchool ZP website admin panel.
// Flags: a reserved | b generic | c kick | d ban | e unban | f slay | g map
//        h cvars | i config | j chat | k vote | l password | m rcon | n cheats | z ROOT
//---------------------
`;
async function readAdminsFull() {
  try {
    const data = JSON.parse(stripJsonc(await fs.readFile(ADMINS_PATH, "utf8")));
    return {
      Groups: (data && typeof data.Groups === "object") ? data.Groups : {},
      Admins: (data && typeof data.Admins === "object") ? data.Admins : {}
    };
  } catch { return { Groups: {}, Admins: {} }; }
}
async function writeAdmins(full) {
  const body = ADMINS_HEADER + JSON.stringify({ Groups: full.Groups || {}, Admins: full.Admins || {} }, null, "\t") + "\n";
  await fs.writeFile(ADMINS_PATH, body, "utf8");
  try { await execFileAsync("chown", ["steam:steam", ADMINS_PATH]); } catch {}
  try { await fs.chmod(ADMINS_PATH, 0o664); } catch {}
}

// Fire-and-forget Discord notice when an admin role is granted, changed or removed.
async function postDiscordAdminRole({ action, targetSteamId, targetName, roleLabel, actorName, actorSteamId }) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const colors = { grant: 0x2ECC71, update: 0xE6B800, revoke: 0xE23C3C };
    const titles = { grant: "🛡 Admin granted", update: "🔁 Admin role changed", revoke: "🚫 Admin removed" };
    const profileUrl = `https://steamcommunity.com/profiles/${targetSteamId}`;
    const fields = [
      { name: "Player", value: `${targetName || "—"}\n[\`${targetSteamId}\`](${profileUrl})`, inline: true },
      { name: "By", value: `${actorName || "—"}${actorSteamId ? `\n\`${actorSteamId}\`` : ""}`, inline: true }
    ];
    if (action !== "revoke") fields.push({ name: "Role", value: roleLabel || "—", inline: true });
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Admin Log",
        allowed_mentions: { parse: [] },
        embeds: [{ title: titles[action] || "Admin change", color: colors[action] ?? 0x888888, fields, footer: { text: "Ghostbe Studio · admin management" }, timestamp: new Date().toISOString() }]
      })
    });
  } catch (e) { console.error("discord admin-role webhook failed:", e.message); }
}

async function enqueueAdminCommand(cmd) {
  const file = path.join(ADMIN_DATA_DIR, "admin_commands.json");
  let queue = { commands: [] };
  try {
    const j = JSON.parse(await fs.readFile(file, "utf8"));
    if (Array.isArray(j.commands)) queue = j;
  } catch {}
  queue.commands.push(cmd);
  await fs.writeFile(file, JSON.stringify(queue), "utf8");
  // Let the plugin (steam user) read and clear the queue.
  try { await execFileAsync("chown", ["steam:steam", file]); } catch {}
  try { await fs.chmod(file, 0o664); } catch {}
}

async function getStatus() {
  const [cpu, memory, swap, disk, cs2Process, query] = await Promise.all([
    getCpuUsage(),
    getMemoryUsage(),
    getSwapUsage(),
    getDiskUsage(),
    getCs2Process(),
    querySourceInfo(CS2_HOST, CS2_PORT)
  ]);

  const status = {
    updatedAt: new Date().toISOString(),
    host: {
      cpu: { cores: os.cpus().length, percent: cpu },
      memory,
      swap,
      disk,
      loadAverage: os.loadavg(),
      uptime: os.uptime()
    },
    cs2: {
      process: cs2Process,
      server: query || {
        online: false,
        name: SERVER_NAME,
        ip: SERVER_IP,
        port: CS2_PORT,
        players: 0,
        maxPlayers: 0,
        bots: 0,
        map: null,
        mapAssets: mapAssets(null)
      }
    }
  };

  status.cs2.server.mapAssets = mapAssets(status.cs2.server.map);
  return status;
}

async function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const filePath = path.join(PUBLIC_DIR, requested === "/" ? "index.html" : requested);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".png": "image/png"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.url?.startsWith("/api/health")) {
    sendJson(req, res, 200, { ok: true, version: VERSION, updatedAt: new Date().toISOString() });
    return;
  }

  if (req.url?.startsWith("/api/status")) {
    try {
      sendJson(req, res, 200, await getStatus());
    } catch (error) {
      sendJson(req, res, 500, { error: error.message });
    }
    return;
  }

  if (req.url?.startsWith("/api/players")) {
    // Source of truth is the plugin's players_online.json (real names, incl.
    // bots). A2S is unreliable in CS2 (blank player names). SteamIDs are
    // stripped here for public privacy.
    const data = await readAdminData("players_online.json", { players: [] });
    const players = (data.players || []).map((p) => ({ name: p.name, team: p.team, bot: !!p.bot }));
    sendJson(req, res, 200, { online: true, count: players.length, players });
    return;
  }

  if (req.url?.startsWith("/api/leaderboard")) {
    try {
      const players = await readLeaderboard();
      sendJson(req, res, 200, { available: true, count: players.length, players });
    } catch {
      // No profile store yet — the site falls back to preview data.
      sendJson(req, res, 200, { available: false, count: 0, players: [] });
    }
    return;
  }

  // ---- Steam Sign-In ----
  if (req.url?.startsWith("/api/auth/steam/login")) {
    const u = new URL(req.url, SELF_URL);
    const redirect = validRedirect(u.searchParams.get("redirect") || `${SITE_URL}/profile.html`);
    const returnTo = `${SELF_URL}/api/auth/steam/return?redirect=${encodeURIComponent(redirect)}`;
    res.writeHead(302, { Location: steamLoginRedirect(returnTo) });
    res.end();
    return;
  }

  if (req.url?.startsWith("/api/auth/steam/return")) {
    const u = new URL(req.url, SELF_URL);
    const redirect = validRedirect(u.searchParams.get("redirect") || `${SITE_URL}/profile.html`);
    let steamId = null;
    try { steamId = await verifySteamReturn(u.searchParams); } catch {}
    if (!steamId) { res.writeHead(302, { Location: `${redirect}?login=failed` }); res.end(); return; }
    const user = await fetchSteamSummary(steamId);
    const token = signSession({ ...user, exp: Date.now() + SESSION_TTL_MS });
    res.writeHead(302, { "Set-Cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)), Location: `${redirect}?login=ok` });
    res.end();
    return;
  }

  if (req.url?.startsWith("/api/auth/logout")) {
    sendJson(req, res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    return;
  }

  if (req.url?.startsWith("/api/auth/me")) {
    const s = verifySession(getCookie(req, "zm_session"));
    sendJson(req, res, 200, s
      ? { authenticated: true, steamId: s.steamId, name: s.name, avatar: s.avatar, profileUrl: s.profileUrl }
      : { authenticated: false });
    return;
  }

  // ---- Admin bridge (all require an authenticated admin session) ----
  if (req.url?.startsWith("/api/admin/me")) {
    const auth = await requireAdmin(req);
    sendJson(req, res, 200, auth
      ? { isAdmin: true, steamId: auth.steamId, name: auth.name, perms: auth.perms,
          role: auth.role, roleLabel: auth.roleLabel, canManageAdmins: !!auth.perms.root }
      : { isAdmin: false });
    return;
  }

  // ---- Root-only admin management (grant / revoke / list) ----
  if (req.url?.startsWith("/api/admin/roles")) {
    const auth = await requireAdmin(req);
    if (!auth) { sendJson(req, res, 403, { error: "forbidden" }); return; }
    sendJson(req, res, 200, { roles: ADMIN_ROLES.map((r) => ({ id: r.id, label: r.label })) });
    return;
  }

  if (req.url?.startsWith("/api/admin/list")) {
    const auth = await requireAdmin(req);
    if (!auth || !auth.perms.root) { sendJson(req, res, 403, { error: "forbidden" }); return; }
    const admins = await readAdmins();
    const list = Object.entries(admins).map(([sid, e]) => {
      const role = roleFromFlags(String(e.flags || ""));
      return { steamId: String(sid), name: e.name || "", flags: String(e.flags || ""), role: role.id, roleLabel: role.label };
    });
    sendJson(req, res, 200, { admins: list, self: auth.steamId });
    return;
  }

  if (req.url?.startsWith("/api/admin/grant") || req.url?.startsWith("/api/admin/revoke")) {
    if (req.method !== "POST") { sendJson(req, res, 405, { error: "method" }); return; }
    if (!csrfOk(req)) { sendJson(req, res, 403, { error: "bad origin" }); return; }
    const auth = await requireAdmin(req);
    if (!auth || !auth.perms.root) { sendJson(req, res, 403, { error: "forbidden" }); return; }

    let body;
    try { body = JSON.parse((await readRequestBody(req)) || "{}"); } catch { body = null; }
    if (!body) { sendJson(req, res, 400, { error: "bad body" }); return; }

    const targetSteamId = String(body.targetSteamId || "");
    if (!/^\d{17}$/.test(targetSteamId)) { sendJson(req, res, 400, { error: "bad steamid" }); return; }
    if (targetSteamId === auth.steamId) { sendJson(req, res, 400, { error: "You cannot change your own admin rights." }); return; }

    const full = await readAdminsFull();
    const isRevoke = req.url.startsWith("/api/admin/revoke");
    const existed = !!full.Admins[targetSteamId];

    if (isRevoke) {
      if (!existed) { sendJson(req, res, 404, { error: "not an admin" }); return; }
      const targetName = full.Admins[targetSteamId].name || "";
      delete full.Admins[targetSteamId];
      await writeAdmins(full);
      const rc = await rconCommand("c_reload_admins");
      postDiscordAdminRole({ action: "revoke", targetSteamId, targetName, actorName: auth.name, actorSteamId: auth.steamId }).catch(() => {});
      sendJson(req, res, 200, { ok: true, reloaded: rc.ok });
      return;
    }

    const role = roleById(String(body.role || ""));
    if (!role) { sendJson(req, res, 400, { error: "bad role" }); return; }
    const name = String(body.name || full.Admins[targetSteamId]?.name || "Admin").replace(/["\\\r\n\t]/g, "").slice(0, 32) || "Admin";
    full.Admins[targetSteamId] = { name, flags: role.flags };
    await writeAdmins(full);
    const rc = await rconCommand("c_reload_admins");
    postDiscordAdminRole({ action: existed ? "update" : "grant", targetSteamId, targetName: name, roleLabel: role.label, actorName: auth.name, actorSteamId: auth.steamId }).catch(() => {});
    sendJson(req, res, 200, { ok: true, reloaded: rc.ok, role: role.id, roleLabel: role.label });
    return;
  }

  if (req.url?.startsWith("/api/admin/players")) {
    const auth = await requireAdmin(req);
    if (!auth) { sendJson(req, res, 403, { error: "forbidden" }); return; }
    const onlineData = await readAdminData("players_online.json", { players: [] });
    const online = (onlineData.players || []).filter((p) => !p.bot); // real players only (bans need SteamID)
    const cutoff = Math.floor(Date.now() / 1000) - 3600;
    let recent = [];
    try {
      const profs = (await readAdminData("account_profiles.json", { profiles: [] })).profiles || [];
      recent = profs
        .filter((p) => (p.lastSeen || 0) >= cutoff)
        .map((p) => ({ steamId: String(p.steamId), name: p.lastName || "", lastSeen: p.lastSeen || 0 }));
    } catch {}
    sendJson(req, res, 200, { online, recent });
    return;
  }

  if (req.url?.startsWith("/api/admin/chat")) {
    const auth = await requireAdmin(req);
    if (!auth) { sendJson(req, res, 403, { error: "forbidden" }); return; }
    const log = await readAdminData("chat_log.json", { messages: [] });
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 60;
    const messages = (log.messages || []).filter((m) => (m.t || 0) >= cutoff);
    sendJson(req, res, 200, { messages });
    return;
  }

  if (req.url?.startsWith("/api/admin/log")) {
    const auth = await requireAdmin(req);
    if (!auth) { sendJson(req, res, 403, { error: "forbidden" }); return; }
    const log = await readAdminData("admin_log.json", { entries: [] });
    sendJson(req, res, 200, { entries: (log.entries || []).slice(-100).reverse() });
    return;
  }

  if (req.url?.startsWith("/api/admin/action")) {
    if (req.method !== "POST") { sendJson(req, res, 405, { error: "method" }); return; }
    if (!csrfOk(req)) { sendJson(req, res, 403, { error: "bad origin" }); return; }
    const auth = await requireAdmin(req);
    if (!auth) { sendJson(req, res, 403, { error: "forbidden" }); return; }

    let body;
    try { body = JSON.parse((await readRequestBody(req)) || "{}"); } catch { body = null; }
    if (!body) { sendJson(req, res, 400, { error: "bad body" }); return; }

    const action = String(body.action || "");
    const targetSteamId = String(body.targetSteamId || "");
    let reason = String(body.reason || "").slice(0, 80).trim();
    const minutes = Math.max(0, Math.min(525600, parseInt(body.minutes, 10) || 0));

    if (!["kick", "ban", "unban"].includes(action)) { sendJson(req, res, 400, { error: "bad action" }); return; }
    if (!/^\d{17}$/.test(targetSteamId)) { sendJson(req, res, 400, { error: "bad steamid" }); return; }
    const need = action === "kick" ? "kick" : action === "unban" ? "unban" : "ban";
    if (!auth.perms[need]) { sendJson(req, res, 403, { error: "no permission" }); return; }
    if (!reason) reason = "No reason given";

    const cmd = {
      id: crypto.randomUUID(),
      action, targetSteamId, minutes, reason,
      adminSteamId: auth.steamId,
      adminName: auth.name,
      createdAt: Date.now()
    };
    await enqueueAdminCommand(cmd);
    postDiscordAdminLog(cmd).catch(() => {});
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.url === "/api/report" && req.method === "POST") {
    // Only the local plugin may file reports; public requests arrive via nginx
    // (which sets x-forwarded-for), so reject those.
    if (req.headers["x-forwarded-for"]) { sendJson(req, res, 403, { error: "forbidden" }); return; }
    let body;
    try { body = JSON.parse((await readRequestBody(req)) || "{}"); } catch { body = null; }
    if (!body) { sendJson(req, res, 400, { error: "bad body" }); return; }
    const rec = {
      id: crypto.randomUUID(),
      reporterName: String(body.reporterName || "").slice(0, 64),
      reporterSteamId: String(body.reporterSteamId || ""),
      targetName: String(body.targetName || "").slice(0, 64),
      targetSteamId: String(body.targetSteamId || ""),
      reason: String(body.reason || "").slice(0, 200),
      createdAt: Date.now()
    };
    await appendReport(rec);
    postDiscordReport(rec).catch(() => {});
    sendJson(req, res, 200, { ok: true });
    return;
  }

  await serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CS2 monitor listening on http://127.0.0.1:${PORT}`);
});
