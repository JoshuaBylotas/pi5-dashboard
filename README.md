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
- The default location shipped in `backend/app.py` is a **placeholder** —
  set your own in Settings on first run.
- Settings are stored at `~/.config/pi5-dashboard/settings.json`, and those
  stored values **shadow** the defaults in code.
- The backend listens only on `127.0.0.1:8080` (local to the Pi).

## Troubleshooting

See **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — the kiosk, touch, Bluetooth
and YouTube-embed failures that cost real time here, and what actually fixed
them.
