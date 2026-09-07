// Standalone shopping-list page (frontend/shopping.html). Separate from the
// kiosk SPA on purpose: this is the one thing reachable off the Pi (over the
// reverse proxy at shopping.bylotas.com), so it carries none of the kiosk-only
// features (Bluetooth, exit-kiosk, etc.) that would just fail for a phone.
import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let currentListId = null;
let pollTimer = null;

function showLists() {
  currentListId = null;
  $("view-items").hidden = true;
  $("view-lists").hidden = false;
  $("back").hidden = true;
  $("title").textContent = "Shopping";
  loadLists();
}

function showItems(id, name) {
  currentListId = id;
  $("view-lists").hidden = true;
  $("view-items").hidden = false;
  $("back").hidden = false;
  $("title").textContent = name;
  loadItems();
}

async function loadWhoAmI() {
  try {
    const r = await api.shopping.whoami();
    if (r.ok) $("who-name").textContent = r.user.name;
  } catch (_) { /* not signed in yet -- /auth/login will have redirected */ }
}

async function loadLists() {
  const wrap = $("lists");
  let data;
  try {
    data = await api.shopping.lists();
  } catch (_) {
    wrap.innerHTML = '<div class="muted">Couldn\'t reach the server.</div>';
    return;
  }
  if (!data.ok) { wrap.innerHTML = '<div class="muted">Couldn\'t load lists.</div>'; return; }
  const lists = data.lists || [];
  wrap.innerHTML = lists.length ? "" : '<div class="muted">No lists yet — add one below.</div>';
  for (const l of lists) {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `<div>${esc(l.name)}<div class="muted small">${l.count} item${l.count === 1 ? "" : "s"}</div></div>` +
      (l.uncheckedCount ? `<span class="badge">${l.uncheckedCount}</span>` : "");
    el.addEventListener("click", () => showItems(l.id, l.name));
    wrap.appendChild(el);
  }
}

async function loadItems() {
  const wrap = $("items");
  let data;
  try {
    data = await api.shopping.items(currentListId);
  } catch (_) {
    wrap.innerHTML = '<div class="muted">Couldn\'t reach the server.</div>';
    return;
  }
  if (!data.ok) { wrap.innerHTML = '<div class="muted">Couldn\'t load items.</div>'; return; }
  const items = (data.items || []).slice().sort((a, b) => a.checked - b.checked);
  wrap.innerHTML = items.length ? "" : '<div class="muted">Nothing on this list yet.</div>';
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "item" + (it.checked ? " checked" : "");
    el.innerHTML =
      `<input type="checkbox" ${it.checked ? "checked" : ""} />` +
      `<div class="item-text">${esc(it.text)}` +
      `<div class="item-meta">added by ${esc(it.addedBy || "someone")}</div></div>` +
      `<button class="btn btn-ghost btn-icon" aria-label="Remove">×</button>`;
    el.querySelector("input[type=checkbox]").addEventListener("change", async () => {
      await api.shopping.toggleItem(currentListId, it.id);
      loadItems();
    });
    el.querySelector("button").addEventListener("click", async () => {
      await api.shopping.deleteItem(currentListId, it.id);
      loadItems();
    });
    wrap.appendChild(el);
  }
}

function wire() {
  $("back").addEventListener("click", showLists);

  $("add-list").addEventListener("click", async () => {
    const name = $("new-list-name").value.trim();
    if (!name) return;
    $("new-list-name").value = "";
    await api.shopping.createList(name);
    loadLists();
  });
  $("new-list-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("add-list").click(); });

  $("add-item").addEventListener("click", async () => {
    const text = $("new-item-text").value.trim();
    if (!text || !currentListId) return;
    $("new-item-text").value = "";
    await api.shopping.addItem(currentListId, text);
    loadItems();
  });
  $("new-item-text").addEventListener("keydown", (e) => { if (e.key === "Enter") $("add-item").click(); });

  $("clear-checked").addEventListener("click", async () => {
    if (!currentListId) return;
    await api.shopping.clearChecked(currentListId);
    loadItems();
  });
}

// Simple polling so two phones editing the same list stay roughly in sync --
// no need for websockets for a casual family list.
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentListId) loadItems(); else loadLists();
  }, 5000);
}

wire();
loadWhoAmI();
showLists();
startPolling();
