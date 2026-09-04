// App bootstrap: view routing, nav, exit modal, and wiring the feature modules.
import { store } from "./store.js";
import { api } from "./api.js";
import { startClock } from "./clock.js";
import { initWeather, loadWeather } from "./weather.js";
import { initMusic } from "./music.js";
import { initBluetooth, onSettingsOpened } from "./bluetooth.js";
import { initSettings, refreshGoogleStatus } from "./settings.js";
import { initDragScroll } from "./dragscroll.js";

const VIEWS = ["home", "music", "weather", "settings"];

// Switch the active view. Exported so other modules can navigate.
export function go(view) {
  if (!VIEWS.includes(view)) view = "home";
  document.querySelectorAll(".view").forEach((el) =>
    el.classList.toggle("active", el.id === `view-${view}`));
  document.querySelectorAll(".nav-btn[data-view]").forEach((btn) =>
    btn.classList.toggle("active", btn.getAttribute("data-view") === view));
  if (view === "weather") loadWeather();
  if (view === "settings") { onSettingsOpened(); refreshGoogleStatus(); }
}

function wireNav() {
  document.querySelectorAll(".nav-btn[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => go(btn.getAttribute("data-view"))));
  document.querySelectorAll("[data-goto]").forEach((el) =>
    el.addEventListener("click", () => go(el.getAttribute("data-goto"))));
}

function wireExit() {
  const modal = document.getElementById("exit-modal");
  document.getElementById("exit-btn").addEventListener("click", () =>
    modal.classList.remove("hidden"));
  document.getElementById("exit-cancel").addEventListener("click", () =>
    modal.classList.add("hidden"));
  document.getElementById("exit-confirm").addEventListener("click", async () => {
    try { await api.exitKiosk(); } catch (_) {}
    modal.classList.add("hidden");
  });
}

function wireOnlineIndicator() {
  const el = document.getElementById("net-indicator");
  const set = () => el && el.classList.toggle("off", !navigator.onLine);
  window.addEventListener("online", set);
  window.addEventListener("offline", set);
  set();
}

async function main() {
  wireNav();
  wireExit();
  wireOnlineIndicator();
  initDragScroll(document.getElementById("content"));

  startClock();
  initSettings();
  initMusic();
  initBluetooth();
  initWeather();

  // Reload weather whenever the location or units change in Settings.
  window.addEventListener("location-changed", loadWeather);

  // ?view= still honoured so a bookmark or relaunch can land on a given screen.
  const wanted = new URLSearchParams(location.search).get("view");
  try {
    const s = await store.load();
    go(wanted || s.display?.defaultView || "home");
  } catch (e) {
    console.error("settings load failed", e);
    go(wanted || "home");
  }
}

document.addEventListener("DOMContentLoaded", main);
