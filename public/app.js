"use strict";

const $ = (id) => document.getElementById(id);

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
  bar.style.background = clamped > 88 ? "var(--red)" : clamped > 68 ? "var(--amber)" : "var(--green)";
}

function uptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function refresh() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const data = await response.json();

  const server = data.cs2.server;
  $("server-name").textContent = server.name || "CS2-ZM-Test";
  $("server-ip").textContent = server.ip;
  $("server-port").textContent = server.port;
  $("map").textContent = server.map || "-";
  $("players").textContent = `${server.players || 0}/${server.maxPlayers || 0}`;
  $("bots").textContent = server.bots ?? 0;

  const pill = $("online-pill");
  pill.textContent = server.online ? "online" : "offline";
  pill.className = `status-pill ${server.online ? "online" : "offline"}`;

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
}

refresh().catch(console.error);
setInterval(() => refresh().catch(console.error), 2000);
