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

// A "queue" is our own track list (from a private-owning playlist, played
// video-by-video since the whole playlist can't be loaded via listId).
// Empty queue means Next/Prev fall back to the native YT.Player playlist.
let queue = [];
let queueIndex = -1;

// Audio-only fallback (yt-dlp) for a queued video the IFrame embed refuses to
// play. `playToken` invalidates a pending watchdog/fallback when the user
// moves on (next/prev/a different pick) before either resolves.
let audioEl = null;
let usingAudio = false;
let watchdogTimer = null;
let playToken = 0;

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
      onError: onPlayerError,
    },
  });
}

function onState(e) {
  const playing = e.data === YT.PlayerState.PLAYING;
  setPlayIcons(playing);
  if (playing) clearWatchdog();
  if (e.data === YT.PlayerState.ENDED) {
    // A blocked/failed video often doesn't fire onError at all -- it just
    // jumps straight to "ended" within a fraction of a second of loading.
    // Treat a near-instant "end" as a failed load, not a finished song.
    let elapsed = 0;
    try { elapsed = player.getCurrentTime() || 0; } catch (_) {}
    if (queue.length && elapsed < 2) {
      handleQueueFailure("blocked or unavailable");
      return;
    }
    playNextInQueue();
    return;
  }
  try {
    const d = player.getVideoData();
    if (d && d.title) { currentTitle = d.title; updateTitles(); }
  } catch (_) {}
}

// A queued video that turns out to be unplayable fires here instead of
// onStateChange -- skip it automatically. The Data API's `embeddable` flag
// (used to filter the track list) only reflects the uploader's embedding
// toggle; it says nothing about regional licensing blocks, Content ID claims,
// or a video removed after being liked, which only show up here, live.
const YT_ERROR_REASONS = {
  2: "invalid video",
  5: "playback error",
  100: "removed or made private",
  101: "embedding disabled by uploader",
  150: "embedding disabled by uploader",
};
function onPlayerError(e) {
  if (!queue.length) return;
  clearWatchdog();
  const reason = YT_ERROR_REASONS[e?.data] || `unavailable (code ${e?.data})`;
  console.warn("YT playback error", e?.data, queue[queueIndex]?.title);
  handleQueueFailure(reason);
}

// Some blocked videos fire neither onError nor a usable ENDED -- the player
// just shows "Video unavailable" and sits at UNSTARTED forever. Catch that by
// checking, a few seconds after loading, whether playback ever actually began.
function armWatchdog() {
  clearWatchdog();
  const myToken = playToken;
  watchdogTimer = setTimeout(() => {
    if (myToken !== playToken || !ready) return;
    if (player.getPlayerState() === YT.PlayerState.UNSTARTED) {
      console.warn("YT stuck at UNSTARTED (likely blocked)", queue[queueIndex]?.title);
      handleQueueFailure("blocked or unavailable");
    }
  }, 7000);
}
function clearWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

// The IFrame embed couldn't play this queued track. Try pulling just the
// audio via the backend's yt-dlp fallback before giving up and skipping.
async function handleQueueFailure(reason) {
  const myToken = playToken;
  const track = queue[queueIndex];
  setNowTitle(`Loading audio-only fallback…`);
  let data;
  try {
    data = track ? await api.yt.audioUrl(track.videoId) : null;
  } catch (_) {
    data = null;
  }
  if (myToken !== playToken) return; // user moved on while we were waiting
  if (data && data.ok && data.url) {
    playAudioFallback(track, data.url);
  } else {
    setNowTitle(`Skipped — ${reason}`);
    playNextInQueue();
  }
}

// ---- Audio-only fallback (yt-dlp) --------------------------------------
function getAudioEl() {
  if (audioEl) return audioEl;
  audioEl = document.getElementById("yt-audio-fallback");
  audioEl.addEventListener("play", () => setPlayIcons(true));
  audioEl.addEventListener("pause", () => setPlayIcons(false));
  audioEl.addEventListener("ended", () => { usingAudio = false; playNextInQueue(); });
  audioEl.addEventListener("error", () => {
    if (!usingAudio) return; // stale error from stopAudioFallback() clearing src
    usingAudio = false;
    setNowTitle("Skipped — audio fallback failed");
    playNextInQueue();
  });
  return audioEl;
}
function stopAudioFallback() {
  usingAudio = false;
  if (!audioEl) return;
  audioEl.pause();
  audioEl.removeAttribute("src");
  audioEl.load();
}
function playAudioFallback(track, url) {
  if (player) { try { player.stopVideo(); } catch (_) {} }
  document.getElementById("yt-player")?.classList.add("hidden");
  const el = getAudioEl();
  usingAudio = true;
  el.volume = (store.get()?.youtube?.volume ?? 60) / 100;
  el.src = url;
  el.play().catch(() => {});
  setNowTitle(`${track.title} (audio only)`);
  showMini(true);
}

// ---- Custom queue (individual videos from a private-owning playlist) --
function playQueueAt(i) {
  const t = queue[i];
  if (!t) return;
  playToken++;
  clearWatchdog();
  stopAudioFallback();
  queueIndex = i;
  setNowTitle(t.title);
  play({ videoId: t.videoId });
  armWatchdog();
}
function playNextInQueue() {
  if (!queue.length) { if (ready) player.nextVideo(); return; }
  if (queueIndex < queue.length - 1) playQueueAt(queueIndex + 1);
}
function playPrevInQueue() {
  if (!queue.length) { if (ready) player.previousVideo(); return; }
  if (queueIndex > 0) playQueueAt(queueIndex - 1);
}

// ---- Playback ----------------------------------------------------------
export function play(parsed) {
  if (!parsed) return;
  document.getElementById("yt-player")?.classList.remove("hidden");
  if (!ready) { pendingLoad = parsed; return; }
  if (parsed.listId) {
    player.loadPlaylist({ list: parsed.listId, listType: "playlist" });
  } else if (parsed.videoId) {
    player.loadVideoById(parsed.videoId);
  }
  showMini(true);
}

function playUrl(url) {
  playToken++;
  clearWatchdog();
  stopAudioFallback();
  queue = []; queueIndex = -1;
  const parsed = parseYouTube(url);
  if (!parsed) { setNowTitle("Couldn't read that link"); return; }
  play(parsed);
}

function togglePlay() {
  if (usingAudio) {
    const el = getAudioEl();
    if (el.paused) el.play().catch(() => {}); else el.pause();
    return;
  }
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
    el.addEventListener("click", () => { queue = []; queueIndex = -1; setNowTitle(st.name); playUrl(st.url); });
    wrap.appendChild(el);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Your playlists ----------------------------------------------------
// Signed in (OAuth): every playlist you own, incl. Liked videos, played
// track-by-track via the queue below. Otherwise: public playlists on the
// configured channel, listed by the backend so the API key stays server-side.
async function refreshLibrary(force) {
  const wrap = document.getElementById("playlists");
  if (!wrap) return;
  wrap.innerHTML = '<div class="muted">Loading…</div>';
  let signedIn = false;
  try {
    signedIn = !!(await api.yt.auth.state()).signedIn;
  } catch (_) {}
  if (signedIn) await renderMyPlaylists(wrap);
  else await renderPublicPlaylists(wrap, force);
}

async function renderPublicPlaylists(wrap, force) {
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
      playToken++; clearWatchdog(); stopAudioFallback();
      queue = []; queueIndex = -1;
      setNowTitle(pl.title);
      play({ listId: pl.id });
    });
    wrap.appendChild(el);
  }
}

async function renderMyPlaylists(wrap) {
  let data;
  try {
    data = await api.yt.mine.playlists();
  } catch (_) {
    wrap.innerHTML = '<div class="muted">Couldn\'t reach the backend.</div>';
    return;
  }
  if (!data.ok) {
    wrap.innerHTML = `<div class="muted">${escapeHtml(data.error || "Couldn't list playlists.")}</div>`;
    return;
  }
  const lists = data.playlists || [];
  if (!lists.length) {
    wrap.innerHTML = '<div class="muted">No playlists found.</div>';
    return;
  }
  wrap.innerHTML = "";
  for (const pl of lists) {
    const el = document.createElement("div");
    el.className = "station";
    const art = pl.thumb
      ? `<img class="st-art" src="${escapeHtml(pl.thumb)}" alt="" />`
      : '<div class="st-ico">🎧</div>';
    el.innerHTML = `${art}<div>${escapeHtml(pl.title)}${pl.liked ? " 💜" : ""}` +
      `<div class="muted small">${pl.count} track${pl.count === 1 ? "" : "s"}</div></div>`;
    el.addEventListener("click", () => openTrackList(pl));
    wrap.appendChild(el);
  }
}

function fmtDuration(sec) {
  sec = sec || 0;
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Individual tracks of one of the signed-in user's playlists. Played one
// video at a time (loadVideoById), not as a native YT playlist, since the
// playlist itself is often private and can't be loaded by listId at all.
async function openTrackList(pl) {
  document.getElementById("stations-card")?.classList.add("hidden");
  const view = document.getElementById("track-view");
  const list = document.getElementById("track-list");
  const title = document.getElementById("track-view-title");
  view?.classList.remove("hidden");
  if (title) title.textContent = pl.title;
  if (list) list.innerHTML = '<div class="muted">Loading tracks…</div>';

  let data;
  try {
    data = await api.yt.mine.items(pl.id);
  } catch (_) {
    if (list) list.innerHTML = '<div class="muted">Couldn\'t reach the backend.</div>';
    return;
  }
  if (!data.ok) {
    if (list) list.innerHTML = `<div class="muted">${escapeHtml(data.error || "Couldn't load tracks.")}</div>`;
    return;
  }
  const tracks = data.tracks || [];
  if (!tracks.length) {
    if (list) list.innerHTML = '<div class="muted">No tracks.</div>';
    return;
  }
  if (!list) return;
  list.innerHTML = "";
  // Every track is clickable -- even one the Data API marks non-embeddable
  // may still play via the audio-only fallback if the video embed fails.
  for (const t of tracks) {
    const el = document.createElement("div");
    el.className = "track-item";
    const art = t.thumb
      ? `<img class="track-thumb" src="${escapeHtml(t.thumb)}" alt="" />`
      : '<div class="track-thumb st-ico">🎵</div>';
    el.innerHTML = `${art}<div class="track-info"><div class="track-title">${escapeHtml(t.title)}</div>` +
      `<div class="muted small">${fmtDuration(t.duration)}${t.embeddable === false ? " · audio-only likely" : ""}</div></div>`;
    el.addEventListener("click", () => {
      queue = tracks;
      playQueueAt(queue.findIndex((x) => x.videoId === t.videoId));
    });
    list.appendChild(el);
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
      el.addEventListener("click", () => {
        playToken++; clearWatchdog(); stopAudioFallback();
        queue = []; queueIndex = -1;
        setNowTitle(sn.title); play({ videoId: vid }); go("music");
      });
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
  refreshLibrary(false);
  // The key/channel live in settings, so a save there should re-list.
  let lastLib = libKey();
  store.subscribe(() => {
    renderStations();
    refreshSearchVisibility();
    if (libKey() !== lastLib) { lastLib = libKey(); refreshLibrary(true); }
  });
  // Signing in/out of the OAuth account isn't part of settings, so it fires
  // its own event (see settings.js) rather than going through the store.
  window.addEventListener("youtube-account-changed", () => refreshLibrary(true));

  document.getElementById("pl-refresh")?.addEventListener("click", () =>
    refreshLibrary(true));
  document.getElementById("track-back")?.addEventListener("click", () => {
    document.getElementById("track-view")?.classList.add("hidden");
    document.getElementById("stations-card")?.classList.remove("hidden");
  });

  document.getElementById("player-controls")?.addEventListener("click", (e) => {
    const act = e.target.getAttribute("data-act");
    if (act === "playpause") togglePlay();
    else if (act === "next") playNextInQueue();
    else if (act === "prev") playPrevInQueue();
  });
  document.getElementById("vol")?.addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (ready) player.setVolume(v);
    if (audioEl) audioEl.volume = v / 100;
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
