// Tiny fetch helpers around the local backend API.
async function jget(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

export const api = {
  getSettings: () => jget("/api/settings"),
  saveSettings: (patch) => jpost("/api/settings", patch),
  weather: () => jget("/api/weather"),
  geocode: (q) => jget("/api/geocode?q=" + encodeURIComponent(q)),
  bt: {
    status: () => jget("/api/bluetooth/status"),
    devices: () => jget("/api/bluetooth/devices"),
    scan: (seconds = 15) => jpost("/api/bluetooth/scan", { seconds }),
    pair: (mac) => jpost("/api/bluetooth/pair", { mac }),
    connect: (mac) => jpost("/api/bluetooth/connect", { mac }),
    disconnect: (mac) => jpost("/api/bluetooth/disconnect", { mac }),
    remove: (mac) => jpost("/api/bluetooth/remove", { mac }),
  },
  exitKiosk: () => jpost("/api/system/exit-kiosk", {}),
  yt: {
    playlists: (force) =>
      jget("/api/youtube/playlists" + (force ? "?refresh=1" : "")),
  },
  google: {
    status: () => jget("/api/google/status"),
    signin: () => jpost("/api/google/signin", {}),
  },
};
