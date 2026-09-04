// Settings screen: location, units, clock, stations, API key, display.
import { store } from "./store.js";
import { api } from "./api.js";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const $ = (id) => document.getElementById(id);

function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme === "light" ? "light" : "dark");
}

// Reflect current settings into the form controls.
function syncForm(s) {
  if (!s) return;
  $("loc-current").textContent = s.location?.name || "—";
  $("unit-temp").value = s.units?.temperature || "fahrenheit";
  $("clk-24h").checked = !!s.clock?.format24h;
  $("clk-secs").checked = !!s.clock?.showSeconds;
  $("clk-date").checked = !!s.clock?.showDate;
  $("yt-api-key").value = s.youtube?.apiKey || "";
  $("yt-channel").value = s.youtube?.channel || "";
  $("yt-oauth-id").value = s.youtube?.oauthClientId || "";
  $("yt-oauth-secret").value = s.youtube?.oauthClientSecret || "";
  $("theme-select").value = s.display?.theme || "dark";
  $("default-view").value = s.display?.defaultView || "home";
  applyTheme(s.display?.theme);
  renderStationEditor(s);
}

function renderStationEditor(s) {
  const wrap = $("station-editor");
  const stations = s.youtube?.stations || [];
  wrap.innerHTML = "";
  stations.forEach((st) => {
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `<div><div>${esc(st.name)}</div>` +
      `<div class="meta">${esc(st.url)}</div></div>` +
      `<div class="actions"><button class="btn btn-ghost" data-del="${st.id}">Remove</button></div>`;
    wrap.appendChild(el);
  });
}

async function locationSearch() {
  const q = $("loc-search").value.trim();
  const box = $("loc-results");
  if (!q) return;
  box.innerHTML = '<div class="muted">Searching…</div>';
  try {
    const data = await api.geocode(q);
    box.innerHTML = "";
    (data.results || []).forEach((r) => {
      const label = [r.name, r.admin1, r.country_code].filter(Boolean).join(", ");
      const el = document.createElement("div");
      el.className = "list-item";
      el.innerHTML = `<div>${esc(label)}</div>` +
        `<div class="actions"><button class="btn">Use</button></div>`;
      el.querySelector("button").addEventListener("click", async () => {
        await store.save({ location: {
          name: label, latitude: r.latitude, longitude: r.longitude,
          timezone: r.timezone || "auto",
        }});
        box.innerHTML = "";
        window.dispatchEvent(new CustomEvent("location-changed"));
      });
      box.appendChild(el);
    });
    if (!box.children.length) box.innerHTML = '<div class="muted">No matches.</div>';
  } catch (_) {
    box.innerHTML = '<div class="muted">Search failed.</div>';
  }
}

function slug(name) {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    || "st") + "-" + Math.abs(hash(name)).toString(36);
}
function hash(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

// ---- Google session ----------------------------------------------------
// Reported from real auth cookies, so "Signed in" here means private playlists
// and history are actually reachable — not just that a sign-in was attempted.
export async function refreshGoogleStatus() {
  const el = $("g-acct-state");
  if (!el) return;
  try {
    const s = await api.google.status();
    if (s.signedIn) {
      el.textContent = `Signed in (${s.cookies.length} auth cookies)`;
      el.style.color = "var(--accent-2)";
    } else if (s.known) {
      el.textContent = "Not signed in";
      el.style.color = "var(--muted)";
    } else {
      el.textContent = "Unknown";
      el.style.color = "var(--muted)";
    }
  } catch (_) {
    el.textContent = "Unavailable";
    el.style.color = "var(--muted)";
  }
}

function wireGoogleSignin() {
  $("g-signin")?.addEventListener("click", async () => {
    const note = $("g-signin-state");
    if (note) note.textContent = "Opening sign-in…";
    try {
      const r = await api.google.signin();
      if (!r.ok && note) note.textContent = "Couldn't start: " + (r.error || "unknown");
    } catch (_) {
      // Expected: the browser is being closed out from under this request.
      if (note) note.textContent = "Opening…";
    }
  });
}

// ---- YouTube OAuth (all playlists, incl. Liked) ------------------------
let _ytPollTimer = null;

async function refreshYtAuthState() {
  const state = $("yt-oauth-state");
  const signout = $("yt-signout");
  const connect = $("yt-connect");
  if (!state) return;
  try {
    const s = await api.yt.auth.state();
    state.textContent = s.signedIn ? "Connected" : "Not connected";
    state.style.color = s.signedIn ? "var(--accent-2)" : "var(--muted)";
    signout?.classList.toggle("hidden", !s.signedIn);
    connect?.classList.toggle("hidden", !!s.signedIn);
  } catch (_) {
    state.textContent = "Unavailable";
  }
}

function stopYtPoll() {
  if (_ytPollTimer) { clearTimeout(_ytPollTimer); _ytPollTimer = null; }
}

function schedulePoll(seconds) {
  stopYtPoll();
  _ytPollTimer = setTimeout(pollYtAuth, Math.max(seconds, 2) * 1000);
}

async function pollYtAuth() {
  const codeBox = $("yt-device-code");
  const state = $("yt-oauth-state");
  let r;
  try {
    r = await api.yt.auth.poll();
  } catch (_) {
    schedulePoll(5);
    return;
  }
  if (r.status === "signed_in") {
    codeBox?.classList.add("hidden");
    if (state) state.textContent = "Connected";
    await refreshYtAuthState();
    window.dispatchEvent(new CustomEvent("youtube-account-changed"));
    return;
  }
  if (r.status === "pending") { schedulePoll(5); return; }
  // expired / error / none
  codeBox?.classList.add("hidden");
  if (state) state.textContent = r.error || (r.status === "expired" ? "Code expired — try again." : "Not connected");
}

function wireYtOAuth() {
  $("save-oauth")?.addEventListener("click", () =>
    store.save({ youtube: {
      oauthClientId: $("yt-oauth-id").value.trim(),
      oauthClientSecret: $("yt-oauth-secret").value.trim(),
    } }));

  $("yt-connect")?.addEventListener("click", async () => {
    const state = $("yt-oauth-state");
    const codeBox = $("yt-device-code");
    if (state) state.textContent = "Starting…";
    let r;
    try {
      r = await api.yt.auth.start();
    } catch (_) {
      if (state) state.textContent = "Couldn't reach the backend.";
      return;
    }
    if (!r.ok) { if (state) state.textContent = r.error || "Couldn't start sign-in."; return; }
    if (codeBox) {
      codeBox.classList.remove("hidden");
      codeBox.innerHTML = `Go to <b>${esc(r.verificationUrl || "google.com/device")}</b> ` +
        `on your phone and enter code <b>${esc(r.userCode)}</b>`;
    }
    if (state) state.textContent = "Waiting for approval…";
    schedulePoll(r.interval || 5);
  });

  $("yt-signout")?.addEventListener("click", async () => {
    stopYtPoll();
    await api.yt.auth.signout();
    await refreshYtAuthState();
    window.dispatchEvent(new CustomEvent("youtube-account-changed"));
  });
}

export function initSettings() {
  store.subscribe(syncForm);
  wireGoogleSignin();
  refreshGoogleStatus();
  wireYtOAuth();
  refreshYtAuthState();

  $("loc-search-go").addEventListener("click", locationSearch);
  $("loc-search").addEventListener("keydown", (e) => { if (e.key === "Enter") locationSearch(); });

  $("unit-temp").addEventListener("change", (e) =>
    store.save({ units: { temperature: e.target.value } })
      .then(() => window.dispatchEvent(new CustomEvent("location-changed"))));

  $("clk-24h").addEventListener("change", (e) => store.save({ clock: { format24h: e.target.checked } }));
  $("clk-secs").addEventListener("change", (e) => store.save({ clock: { showSeconds: e.target.checked } }));
  $("clk-date").addEventListener("change", (e) => store.save({ clock: { showDate: e.target.checked } }));

  $("theme-select").addEventListener("change", (e) => {
    applyTheme(e.target.value);
    store.save({ display: { theme: e.target.value } });
  });
  $("default-view").addEventListener("change", (e) =>
    store.save({ display: { defaultView: e.target.value } }));

  // Both saves report back through the same line, since either one failing is
  // the difference between seeing playlists and seeing an empty section.
  const libState = (msg) => { const el = $("yt-lib-state"); if (el) el.textContent = msg; };

  async function saveLib(patch) {
    libState("Saving…");
    await store.save({ youtube: patch });
    try {
      const r = await api.yt.playlists(true);
      if (r.ok) libState(`Found ${r.playlists.length} public playlist(s).`);
      else if (r.needs === "apiKey") libState("Add an API key to list playlists.");
      else if (r.needs === "channel") libState("Add your channel to list playlists.");
      else libState(r.error || "Couldn't list playlists.");
    } catch (_) {
      libState("Saved, but the playlist check failed.");
    }
  }

  $("save-api-key").addEventListener("click", () =>
    saveLib({ apiKey: $("yt-api-key").value.trim() }));
  $("save-channel").addEventListener("click", () =>
    saveLib({ channel: $("yt-channel").value.trim() }));

  $("add-station").addEventListener("click", () => {
    const name = $("new-station-name").value.trim();
    const url = $("new-station-url").value.trim();
    if (!name || !url) return;
    const stations = (store.get()?.youtube?.stations || []).slice();
    stations.push({ id: slug(name), name, url });
    store.save({ youtube: { stations } });
    $("new-station-name").value = ""; $("new-station-url").value = "";
  });

  $("station-editor").addEventListener("click", (e) => {
    const id = e.target.getAttribute("data-del");
    if (!id) return;
    const stations = (store.get()?.youtube?.stations || []).filter((s) => s.id !== id);
    store.save({ youtube: { stations } });
  });
}
