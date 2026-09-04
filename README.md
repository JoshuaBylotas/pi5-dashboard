# Pi5 Dashboard

A fullscreen, touch-friendly dashboard for a Raspberry Pi 5 with a tablet-sized
touchscreen. Shows the **time**, **weather (current + 7-day forecast)**, and a
**YouTube music player**, with a **Settings** area — including **Bluetooth
speaker** pairing. Runs automatically at boot in Chromium kiosk mode and can be
closed back to the desktop at any time.

## Layout

- **Home** — big clock/date, a weather glance, and now-playing.
- **Music** — YouTube player, saved "stations", paste-a-link, optional search.
- **Weather** — current conditions + 7-day forecast (Open-Meteo, no API key).
- **Settings** — location, units, clock options, Bluetooth speaker, stations,
  theme, and the default start screen.

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
- **All your playlists, including Liked videos:** Settings → *YouTube
  Playlists* needs its own OAuth client (a plain API key can only read public
  data). One-time setup in [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
  1. Same project as your API key. Enable **YouTube Data API v3** if not
     already on.
  2. **OAuth consent screen** → User type **External** → add scope
     `.../auth/youtube.readonly` → under **Test users**, add your own Google
     account (required while the app is unverified).
  3. **Credentials** → **Create Credentials** → **OAuth client ID** →
     Application type **TV and Limited Input Devices**. Copy the **Client ID**
     and **Client secret**.
  4. Paste both into Settings → *YouTube Playlists* → **Save**, then tap
     **Connect account**: it shows a short code and a URL — open that URL on
     your phone, sign in, and enter the code.
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
- The backend listens only on `127.0.0.1:8080` (local to the Pi).

## Troubleshooting

See **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — the kiosk, touch, Bluetooth
and YouTube-embed failures that cost real time here, and what actually fixed
them.
