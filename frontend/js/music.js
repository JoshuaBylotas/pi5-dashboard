// YouTube playback via the IFrame Player API.
// Keyless by default (stations + pasted links); search unlocks if an API key
// is saved in Settings.
import { store } from "./store.js";
import { api } from "./api.js";
import { go } from "./app.js";

// Identity of the current library config, so we only re-fetch when it changes.
function libKey() {
  const y = store.get()?.youtube || {};
  return `${y.apiKey || ""}|${y.channel || ""}`;
}

let player = null;
let ready = false;
let pendingLoad = null;
let currentTitle = "";

// ---- URL parsing -------------------------------------------------------
export function parseYouTube(url) {
  if (!url) return null;
  url = url.trim();
  // Bare 11-char video id
  if (/^[\w-]{11}$/.test(url)) return { videoId: url };
  try {
    const u = new URL(url);
    const list = u.searchParams.get("list");
    const v = u.searchParams.get("v");
    if (u.hostname.includes("youtu.be")) {
      return { videoId: u.pathname.slice(1), listId: list || undefined };
    }
    if (v) return { videoId: v, listId: list || undefined };
    if (list) return { listId: list };
    // /embed/ID or /shorts/ID
    const m = u.pathname.match(/\/(embed|shorts)\/([\w-]{11})/);
    if (m) return { videoId: m[2] };
  } catch (_) { /* not a URL */ }
  return null;
}

// ---- IFrame API bootstrap ---------------------------------------------
function loadApi() {
  if (window.YT && window.YT.Player) { onApiReady(); return; }
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
  window.onYouTubeIframeAPIReady = onApiReady;
}

function onApiReady() {
  player = new YT.Player("yt-player", {
    height: "100%", width: "100%",
    playerVars: { autoplay: 0, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: () => {
        ready = true;
        const vol = store.get()?.youtube?.volume ?? 60;
        player.setVolume(vol);
        if (pendingLoad) { play(pendingLoad); pendingLoad = null; }
      },
      onStateChange: onState,
    },
  });
}

function onState(e) {
  const playing = e.data === YT.PlayerState.PLAYING;
  setPlayIcons(playing);
  try {
    const d = player.getVideoData();
    if (d && d.title) { currentTitle = d.title; updateTitles(); }
  } catch (_) {}
}

// ---- Playback ----------------------------------------------------------
export function play(parsed) {
  if (!parsed) return;
  if (!ready) { pendingLoad = parsed; return; }
  if (parsed.listId) {
    player.loadPlaylist({ list: parsed.listId, listType: "playlist" });
  } else if (parsed.videoId) {
    player.loadVideoById(parsed.videoId);
  }
  showMini(true);
}

function playUrl(url) {
  const parsed = parseYouTube(url);
  if (!parsed) { setNowTitle("Couldn't read that link"); return; }
  play(parsed);
}

function togglePlay() {
  if (!ready) return;
  const st = player.getPlayerState();
  if (st === YT.PlayerState.PLAYING) player.pauseVideo();
  else player.playVideo();
}

function setPlayIcons(playing) {
  const icon = playing ? "⏸" : "▶";
  const main = document.querySelector('#player-controls [data-act="playpause"]');
  if (main) main.textContent = icon;
  const mini = document.getElementById("mini-toggle");
  if (mini) mini.textContent = icon;
}

function setNowTitle(t) {
  currentTitle = t; updateTitles();
}
function updateTitles() {
  const now = document.getElementById("now-title");
  const mini = document.getElementById("mini-title");
  const home = document.getElementById("home-np");
  if (now) now.textContent = currentTitle || "—";
  if (mini) mini.textContent = currentTitle || "—";
  if (home) home.textContent = currentTitle || "Nothing playing";
}
function showMini(show) {
  const el = document.getElementById("miniplayer");
  if (el) el.classList.toggle("hidden", !show);
}

// ---- Stations ----------------------------------------------------------
function renderStations() {
  const wrap = document.getElementById("stations");
  if (!wrap) return;
  const stations = store.get()?.youtube?.stations || [];
  wrap.innerHTML = "";
  if (!stations.length) {
    wrap.innerHTML = '<div class="muted">No stations yet — add some in Settings.</div>';
    return;
  }
  for (const st of stations) {
    const el = document.createElement("div");
    el.className = "station";
    el.innerHTML = `<div class="st-ico">🎵</div><div>${escapeHtml(st.name)}</div>`;
    el.addEventListener("click", () => { setNowTitle(st.name); playUrl(st.url); });
    wrap.appendChild(el);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Your playlists ----------------------------------------------------
// Listed by the backend so the API key stays out of the page. Only public
// playlists come back; see the note on /api/youtube/playlists.
async function renderPlaylists(force) {
  const wrap = document.getElementById("playlists");
  if (!wrap) return;
  wrap.innerHTML = '<div class="muted">Loading…</div>';
  let data;
  try {
    data = await api.yt.playlists(force);
  } catch (_) {
    wrap.innerHTML = '<div class="muted">Couldn\'t reach the backend.</div>';
    return;
  }
  if (data.needs === "apiKey") {
    wrap.innerHTML = '<div class="muted">Add an API key in Settings → YouTube Library.</div>';
    return;
  }
  if (data.needs === "channel") {
    wrap.innerHTML = '<div class="muted">Set your channel in Settings → YouTube Library.</div>';
    return;
  }
  if (!data.ok) {
    wrap.innerHTML = `<div class="muted">${escapeHtml(data.error || "Couldn't list playlists.")}</div>`;
    return;
  }
  const lists = data.playlists || [];
  if (!lists.length) {
    wrap.innerHTML = '<div class="muted">No public playlists on that channel.</div>';
    return;
  }
  wrap.innerHTML = "";
  for (const pl of lists) {
    const el = document.createElement("div");
    el.className = "station";
    const art = pl.thumb
      ? `<img class="st-art" src="${escapeHtml(pl.thumb)}" alt="" />`
      : '<div class="st-ico">🎧</div>';
    el.innerHTML = `${art}<div>${escapeHtml(pl.title)}` +
      `<div class="muted small">${pl.count} track${pl.count === 1 ? "" : "s"}</div></div>`;
    el.addEventListener("click", () => {
      setNowTitle(pl.title);
      play({ listId: pl.id });
    });
    wrap.appendChild(el);
  }
}

// ---- Optional search (needs API key) ----------------------------------
async function searchYouTube(q) {
  const key = store.get()?.youtube?.apiKey;
  const results = document.getElementById("yt-results");
  if (!key) { results.innerHTML = '<div class="muted">Add an API key in Settings to search.</div>'; return; }
  results.innerHTML = '<div class="muted">Searching…</div>';
  try {
    const url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8"
      + "&q=" + encodeURIComponent(q) + "&key=" + encodeURIComponent(key);
    const r = await fetch(url);
    const data = await r.json();
    results.innerHTML = "";
    (data.items || []).forEach((it) => {
      const vid = it.id.videoId;
      const sn = it.snippet;
      const el = document.createElement("div");
      el.className = "yt-result";
      el.innerHTML = `<img src="${sn.thumbnails.default.url}" alt="" />` +
        `<div>${escapeHtml(sn.title)}</div>`;
      el.addEventListener("click", () => { setNowTitle(sn.title); play({ videoId: vid }); go("music"); });
      results.appendChild(el);
    });
    if (!results.children.length) results.innerHTML = '<div class="muted">No results.</div>';
  } catch (e) {
    results.innerHTML = '<div class="muted">Search failed (check API key).</div>';
  }
}

function refreshSearchVisibility() {
  const hasKey = !!store.get()?.youtube?.apiKey;
  document.getElementById("yt-search-wrap")?.classList.toggle("hidden", !hasKey);
}

// ---- Wire up -----------------------------------------------------------
export function initMusic() {
  loadApi();
  renderStations();
  refreshSearchVisibility();
  renderPlaylists(false);
  // The key/channel live in settings, so a save there should re-list.
  let lastLib = libKey();
  store.subscribe(() => {
    renderStations();
    refreshSearchVisibility();
    if (libKey() !== lastLib) { lastLib = libKey(); renderPlaylists(true); }
  });
  document.getElementById("pl-refresh")?.addEventListener("click", () =>
    renderPlaylists(true));

  document.getElementById("player-controls")?.addEventListener("click", (e) => {
    const act = e.target.getAttribute("data-act");
    if (act === "playpause") togglePlay();
    else if (act === "next" && ready) player.nextVideo();
    else if (act === "prev" && ready) player.previousVideo();
  });
  document.getElementById("vol")?.addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (ready) player.setVolume(v);
    store.save({ youtube: { volume: v } });
  });
  document.getElementById("yt-play-url")?.addEventListener("click", () => {
    const url = document.getElementById("yt-url").value;
    setNowTitle("Loading…"); playUrl(url);
  });
  document.getElementById("yt-search-go")?.addEventListener("click", () =>
    searchYouTube(document.getElementById("yt-search").value));
  document.getElementById("mini-toggle")?.addEventListener("click", togglePlay);
  document.getElementById("mini-open")?.addEventListener("click", () => go("music"));
}
