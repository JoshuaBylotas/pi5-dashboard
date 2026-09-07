# Pi5 Dashboard

A fullscreen, touch-friendly dashboard for a Raspberry Pi 5 with a tablet-sized
touchscreen. Shows the **time**, **weather (current + 7-day forecast)**, **air
quality & pollen**, a **calendar**, and a **YouTube music player**, with a
**Settings** area — including **Bluetooth speaker** pairing. A public
**shopping list** (separate from the kiosk, Entra ID sign-in required) is
reachable from phones too. Runs automatically at boot in Chromium kiosk mode
and can be closed back to the desktop at any time.

## Layout

- **Home** — big clock/date, a weather glance, and now-playing.
- **Music** — YouTube player, saved "stations", paste-a-link, optional search.
- **Weather** — current conditions + 7-day forecast (Open-Meteo, no API key).
- **Calendar** — upcoming Google Calendar events (read-only).
- **Air Quality** — US AQI, PM2.5/PM10/ozone/UV, and pollen (Open-Meteo, no
  API key).
- **Settings** — location, units, clock options, Bluetooth speaker, stations,
  theme, and the default start screen.
- **Shopping** (`/shopping`, and `shopping.bylotas.com` off the Pi) — a
  separate, Entra ID-gated page for shared shopping lists. See its own section
  below; it's not part of the kiosk SPA.

A left nav rail (bottom bar on narrow/portrait screens) switches areas; a mini
player stays visible while music plays; the **Close** button exits fullscreen.

## Architecture

- `backend/` — a small Flask app that serves the UI and provides local APIs for
  settings, weather (Open-Meteo proxy), Bluetooth (`bluetoothctl`), and kiosk
  control. Only dependency: Flask.
- `frontend/` — vanilla HTML/CSS/ES-module JS (no build step).
- `kiosk/` — the Chromium launcher and the systemd service.
- `install.sh` — one-shot installer (packages, venv, service, autostart).

## Install (on the Pi)

```bash
cd ~/pi5-dashboard
./install.sh
sudo reboot        # or run kiosk/start-kiosk.sh to launch immediately
```

## Common tasks

```bash
# backend logs / status
systemctl --user status pi5-dashboard
journalctl --user -u pi5-dashboard -f

# restart after changing code
systemctl --user restart pi5-dashboard

# launch the kiosk window manually
kiosk/start-kiosk.sh
```

## Notes

- **Bluetooth speaker:** Settings → *Bluetooth Speaker* → **Scan** (put the
  speaker in pairing mode) → **Pair** → **Connect**. PipeWire routes audio to it
  automatically once connected.
- **YouTube search** is optional and needs a *YouTube Data API v3* key entered
  in Settings. Without it, use saved stations and pasted links.
- **All your playlists (incl. Liked videos) and Calendar:** Settings →
  *Google Account* needs its own OAuth client (a plain API key can only read
  public data). One-time setup in [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
  1. Same project as your API key. Enable **YouTube Data API v3** and
     **Google Calendar API** if not already on.
  2. **OAuth consent screen** → User type **External** → add scopes
     `.../auth/youtube.readonly` and `.../auth/calendar.readonly` → under
     **Test users**, add your own Google account (required while the app is
     unverified).
  3. **Credentials** → **Create Credentials** → **OAuth client ID** →
     Application type **TV and Limited Input Devices**. Copy the **Client ID**
     and **Client secret**.
  4. Paste both into Settings → *Google Account* → **Save**, then tap
     **Connect account**: it shows a short code and a URL — open that URL on
     your phone, sign in, and enter the code. This one sign-in covers both the
     Music and Calendar screens.
  5. While the app is unverified ("Testing" status), Google expires the
     session after **7 days**; just tap **Connect account** again when that
     happens. Submitting the app for verification removes this limit but
     isn't required for personal use.
  - Playback: playlists you own that are themselves public/unlisted still play
    in the normal embedded player. A playlist that's private (including Liked
    videos, which is always private) can't be loaded as a playlist embed —
    Google blocks that outright, authenticated or not — so those are instead
    listed as individual tracks and played one video at a time.
  - Some individual videos still refuse to embed (owner disabled embedding,
    regional licensing, a video removed after being liked, etc.) — YouTube
    doesn't always report this cleanly; a blocked video often shows "Video
    unavailable" without ever firing an error event, so the frontend also
    runs a short watchdog timer to catch it. When that happens, the backend
    falls back to pulling just the audio via **yt-dlp**
    (`/api/youtube/audio/<id>`) and plays that in a plain `<audio>` element
    instead of skipping the track outright. This is **not an official API** —
    it's scraping YouTube's player response, which violates YouTube's Terms
    of Service and breaks whenever YouTube changes something internally. Keep
    it updated (`.venv/bin/pip install -U yt-dlp`) if it stops working; if a
    track still can't be pulled at all, it's skipped for real.
- The default location shipped in `backend/app.py` is a **placeholder** —
  set your own in Settings on first run.
- Settings are stored at `~/.config/pi5-dashboard/settings.json`, and those
  stored values **shadow** the defaults in code.
- **Network exposure:** every route except `/api/shopping/*`, `/shopping`,
  `/auth/*`, and the static frontend files is restricted to `127.0.0.1` by
  `@localhost_only` — settings (which holds OAuth/Entra secrets), Bluetooth
  control, kiosk control, and the Google/YouTube endpoints never answer to
  another device, even though the process itself listens on every interface
  (`PI5_DASHBOARD_HOST`, default `0.0.0.0`) so the shopping list can be reached
  through a reverse proxy.

## Shopping list (public, Entra ID sign-in)

The shopping list is deliberately its **own page** (`frontend/shopping.html` +
`frontend/js/shopping.js`), not part of the kiosk single-page app — it's the
one feature meant to be reachable from phones, on or off the home network, so
it carries none of the kiosk-only code (Bluetooth, exit-kiosk, Settings) that
would just fail there anyway.

**Reverse proxy.** You're fronting `shopping.bylotas.com` with your own
reverse proxy pointed at the Pi. Two things matter for this to be safe:
- `@localhost_only` (used on everything *except* the shopping list) checks
  `request.remote_addr`. Behind a reverse proxy, Flask sees the *proxy's*
  address on every request unless the proxy's real client IP is trusted via
  `X-Forwarded-For` — this app wraps the WSGI app in Werkzeug's `ProxyFix` for
  exactly that. **`PI5_DASHBOARD_PROXY_HOPS`** (default `1`) must equal the
  number of reverse-proxy hops actually in front of the backend. Too low and
  real client IPs get mixed up; too high, and a client can forge
  `X-Forwarded-For` to make a public request look like it came from
  `127.0.0.1`, slipping past `@localhost_only` entirely. If your proxy chain
  is just "your reverse proxy → the Pi", leave it at `1`.
- Make sure your reverse proxy itself **overwrites** `X-Forwarded-For` based
  on the real TCP connection rather than blindly forwarding whatever a client
  sends — any competent reverse proxy (nginx, Caddy, Traefik) does this by
  default, but it's worth double-checking, since ProxyFix's trust model
  depends on it.

**Entra ID app registration** (single-tenant, `bylotas.com` — deliberately
*not* a work/organizational tenant):
1. In the Entra admin center for the `bylotas.com` tenant: **App registrations**
   → **New registration**. Single tenant. Redirect URI (Web):
   `https://shopping.bylotas.com/auth/callback`.
2. **Certificates & secrets** → new client secret — copy it immediately (shown
   once).
3. **API permissions**: `User.Read` (delegated) is enough — used only to read
   the signed-in user's display name for "added by".
4. Paste the **Tenant ID** (or the `bylotas.com` domain), **Application
   (client) ID**, **client secret**, and the redirect URI into Settings →
   *Shopping List (Entra ID)* on the dashboard.

**Data model.** Each list has a name and its own items; each item records who
added it (`session["user"]["name"]` from the ID token) and when. Stored at
`~/.config/pi5-dashboard/shopping.json` (separate from `settings.json`).

**Trust model note:** this shares one Flask process with the kiosk backend.
`@localhost_only` plus a correctly-configured `ProxyFix` keeps the sensitive
routes off the public internet, but it depends on getting the proxy-hop count
right and trusting the reverse proxy to sanitize `X-Forwarded-For`. A fully
isolated process on its own port would remove that dependency entirely if this
ever needs hardening further.

## Troubleshooting

See **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — the kiosk, touch, Bluetooth
and YouTube-embed failures that cost real time here, and what actually fixed
them.
