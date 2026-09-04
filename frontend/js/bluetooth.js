// Bluetooth speaker management (Settings screen) + top-bar indicator.
import { api } from "./api.js";

let scanPoll = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const msg = (t) => { const el = document.getElementById("bt-msg"); if (el) el.textContent = t; };

export async function refreshIndicator() {
  try {
    const s = await api.bt.status();
    const chip = document.getElementById("bt-indicator");
    const name = document.getElementById("bt-name");
    if (!chip || !name) return;
    if (s.connected) {
      name.textContent = s.connected.name;
      chip.firstChild.textContent = "🔊 ";
    } else {
      name.textContent = s.available ? "No speaker" : "BT off";
      chip.firstChild.textContent = "🔇 ";
    }
  } catch (_) { /* backend momentarily busy */ }
}

async function renderDevices() {
  const wrap = document.getElementById("bt-list");
  if (!wrap) return;
  try {
    const { devices, scanning } = await api.bt.devices();
    document.getElementById("bt-scan-state").textContent = scanning ? "Scanning…" : "";
    wrap.innerHTML = "";
    if (!devices.length) {
      wrap.innerHTML = '<div class="muted">No devices yet. Put your speaker in pairing mode and tap Scan.</div>';
      return;
    }
    for (const d of devices) {
      const el = document.createElement("div");
      el.className = "list-item";
      const badge = d.connected ? '<span class="badge">Connected</span>'
        : d.paired ? '<span class="badge warn">Paired</span>' : "";
      const btn = d.connected
        ? `<button class="btn btn-ghost" data-act="disconnect" data-mac="${d.mac}">Disconnect</button>`
        : d.paired
          ? `<button class="btn" data-act="connect" data-mac="${d.mac}">Connect</button>`
          : `<button class="btn" data-act="pair" data-mac="${d.mac}">Pair</button>`;
      const forget = d.paired
        ? `<button class="btn btn-ghost" data-act="remove" data-mac="${d.mac}">Forget</button>` : "";
      el.innerHTML =
        `<div><div>${d.audio ? "🔊 " : ""}${esc(d.name)}${badge}</div>` +
        `<div class="meta">${d.mac}</div></div>` +
        `<div class="actions">${btn}${forget}</div>`;
      wrap.appendChild(el);
    }
  } catch (e) {
    wrap.innerHTML = '<div class="muted">Bluetooth service unavailable.</div>';
  }
}

async function doAction(act, mac) {
  msg(act === "pair" ? "Pairing… (keep the speaker in pairing mode)" : `${act}…`);
  try {
    const res = await api.bt[act](mac);
    msg(res.ok ? "Done." : "That didn't work — try again or re-enter pairing mode.");
  } catch (_) {
    msg("Request failed.");
  }
  await renderDevices();
  await refreshIndicator();
}

export function initBluetooth() {
  document.getElementById("bt-scan")?.addEventListener("click", async () => {
    msg(""); document.getElementById("bt-scan-state").textContent = "Scanning…";
    try { await api.bt.scan(15); } catch (_) {}
    clearInterval(scanPoll);
    let ticks = 0;
    scanPoll = setInterval(async () => {
      await renderDevices();
      if (++ticks >= 9) { clearInterval(scanPoll); }
    }, 2000);
    renderDevices();
  });

  document.getElementById("bt-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) doAction(btn.getAttribute("data-act"), btn.getAttribute("data-mac"));
  });

  refreshIndicator();
  setInterval(refreshIndicator, 15000);
}

// Called when the Settings view is opened, to show a fresh list.
export function onSettingsOpened() {
  renderDevices();
}
