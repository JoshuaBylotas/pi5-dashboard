// Calendar view: upcoming Google Calendar events (read-only), via the same
// OAuth sign-in used for YouTube playlists (Settings → YouTube Playlists).
import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtWhen(ev) {
  const d = new Date(ev.start);
  if (ev.allDay) return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export async function loadCalendar() {
  const wrap = $("cal-events");
  if (!wrap) return;
  wrap.innerHTML = '<div class="muted">Loading…</div>';
  let data;
  try {
    data = await api.calendar.upcoming();
  } catch (_) {
    wrap.innerHTML = '<div class="muted">Couldn\'t reach the backend.</div>';
    return;
  }
  if (data.needs === "signin") {
    wrap.innerHTML = '<div class="muted">Sign in to Google in Settings → YouTube Playlists to see your calendar.</div>';
    return;
  }
  if (!data.ok) {
    wrap.innerHTML = `<div class="muted">${esc(data.error || "Couldn't load events.")}</div>`;
    return;
  }
  const events = data.events || [];
  if (!events.length) {
    wrap.innerHTML = '<div class="muted">Nothing on the calendar.</div>';
    return;
  }
  wrap.innerHTML = "";
  for (const ev of events) {
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `<div>${esc(ev.title)}` +
      (ev.location ? `<div class="meta">${esc(ev.location)}</div>` : "") +
      `</div><div class="meta">${esc(fmtWhen(ev))}</div>`;
    wrap.appendChild(el);
  }
}

export function initCalendar() {
  $("cal-refresh")?.addEventListener("click", loadCalendar);
}
