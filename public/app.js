"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULT_API_BASE = "https://api.zm2.ghostbe.site";
const DEFAULT_MAP = "de_dust2";
const MAP_BASE = "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images";

let apiBase = "";

function mapAssets(mapName) {
  const map = (mapName || DEFAULT_MAP).toLowerCase().replace(/[^a-z0-9_]/g, "") || DEFAULT_MAP;
  return {
    thumbnail: `${MAP_BASE}/thumbs/${map}_png.png`,
    hero: `${MAP_BASE}/thumbs/${map}_1_png.png`
  };
}

function bytes(value) {
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function percent(value) {
  return `${Math.round(value || 0)}%`;
}

function setBar(id, value) {
  const bar = $(id);
  const clamped = Math.max(0, Math.min(100, value || 0));
  bar.style.width = `${clamped}%`;
  bar.style.background = clamped > 88 ? "var(--red)" : clamped > 68 ? "var(--orange)" : "var(--green)";
}

function uptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusUrl() {
  const base = apiBase.replace(/\/$/, "");
  return `${base}/api/status`;
}

async function loadConfig() {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("api");
  if (fromQuery) {
    localStorage.setItem("zm-api-base", fromQuery);
  }

  const stored = localStorage.getItem("zm-api-base");
  if (stored) {
    apiBase = stored;
    return;
  }

  try {
    const response = await fetch("./config.json", { cache: "no-store" });
    if (response.ok) {
      const config = await response.json();
      apiBase = config.apiBaseUrl || "";
      return;
    }
  } catch {
    // Static hosting can work without a config file.
  }

  apiBase = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "" : DEFAULT_API_BASE;
}

function applyServer(data) {
  const server = data.cs2.server;
  const assets = server.mapAssets || mapAssets(server.map);

  $("server-name").textContent = server.name || "CS2-ZM-Test";
  $("server-ip").textContent = server.ip;
  $("server-port").textContent = server.port;
  $("map").textContent = server.map || DEFAULT_MAP;
  $("players").textContent = `${server.players || 0}/${server.maxPlayers || 0}`;
  $("bots").textContent = server.bots ?? 0;
  $("map-image").onerror = () => {
    $("map-image").src = mapAssets(server.map).thumbnail;
  };
  $("map-image").src = assets.thumbnail || mapAssets(server.map).thumbnail;
  $("map-image").alt = server.map ? `${server.map} thumbnail` : "CS2 map thumbnail";
  document.documentElement.style.setProperty("--map-bg", `url("${assets.hero || assets.thumbnail}")`);

  const onlineClass = server.online ? "online" : "offline";
  $("signal").textContent = onlineClass;
  $("signal").className = `signal ${onlineClass}`;
  $("online-pill").textContent = onlineClass;
  $("online-pill").className = onlineClass;

  $("cpu-value").textContent = percent(data.host.cpu.percent);
  $("cpu-meta").textContent = `${data.host.cpu.cores} cores, load ${data.host.loadAverage[0].toFixed(2)}`;
  setBar("cpu-bar", data.host.cpu.percent);

  $("ram-value").textContent = percent(data.host.memory.percent);
  $("ram-meta").textContent = `${bytes(data.host.memory.used)} / ${bytes(data.host.memory.total)}`;
  setBar("ram-bar", data.host.memory.percent);

  $("disk-value").textContent = percent(data.host.disk.percent);
  $("disk-meta").textContent = `${bytes(data.host.disk.used)} / ${bytes(data.host.disk.total)}`;
  setBar("disk-bar", data.host.disk.percent);

  const proc = data.cs2.process;
  $("process-value").textContent = proc?.running ? `PID ${proc.pid}` : "offline";
  $("process-rss").textContent = proc?.rss ? bytes(proc.rss) : "-";
  $("process-threads").textContent = proc?.threads ?? "-";
  $("swap-meta").textContent = `${bytes(data.host.swap.used)} / ${bytes(data.host.swap.total)}`;
  $("uptime").textContent = uptime(data.host.uptime);
  $("updated-at").textContent = new Date(data.updatedAt).toLocaleTimeString();
  $("api-state").textContent = apiBase || "same-origin";
}

async function refresh() {
  try {
    const response = await fetch(statusUrl(), { cache: "no-store" });
    if (!response.ok) throw new Error(`API ${response.status}`);
    applyServer(await response.json());
  } catch {
    $("signal").textContent = "api down";
    $("signal").className = "signal offline";
    $("online-pill").textContent = "offline";
    $("online-pill").className = "offline";
    $("api-state").textContent = "unreachable";
  }
}

$("copy-endpoint").addEventListener("click", async () => {
  const endpoint = `${$("server-ip").textContent}:${$("server-port").textContent}`;
  await navigator.clipboard?.writeText(endpoint);
});

loadConfig().then(() => {
  refresh();
  setInterval(refresh, 2000);
});
