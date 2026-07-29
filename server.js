"use strict";

const dgram = require("node:dgram");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const CS2_HOST = process.env.CS2_HOST || "127.0.0.1";
const CS2_PORT = Number(process.env.CS2_PORT || 27015);
const SERVER_IP = process.env.SERVER_IP || "195.137.244.196";
const SERVER_NAME = process.env.SERVER_NAME || "CS2-ZM-Test";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const MAP_ASSET_BASE = process.env.MAP_ASSET_BASE || "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images";

let lastCpu = null;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Length": Buffer.byteLength(body)
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
      ".svg": "image/svg+xml"
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
    res.writeHead(204, {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.url?.startsWith("/api/health")) {
    sendJson(res, 200, { ok: true, updatedAt: new Date().toISOString() });
    return;
  }

  if (req.url?.startsWith("/api/status")) {
    try {
      sendJson(res, 200, await getStatus());
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  await serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CS2 monitor listening on http://127.0.0.1:${PORT}`);
});
