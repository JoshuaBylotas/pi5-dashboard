#!/usr/bin/env python3
"""Pi5 Dashboard backend.

Serves the touchscreen dashboard frontend and exposes a small local API for:
  - persisted settings (location, clock, YouTube stations, display)
  - weather (Open-Meteo proxy + geocoding, no API key needed)
  - Bluetooth speaker management (wraps bluetoothctl)
  - kiosk/system control (exit the fullscreen browser back to the desktop)

The only third-party dependency is Flask; everything else is stdlib.
"""

import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus

from flask import Flask, jsonify, request, send_from_directory

import bluetooth as bt  # local module (backend/bluetooth.py)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend"))

DATA_DIR = os.environ.get(
    "PI5_DASHBOARD_DATA",
    os.path.join(os.path.expanduser("~"), ".config", "pi5-dashboard"),
)
SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")

DEFAULT_SETTINGS = {
    "location": {
        # Placeholder only — set your own location in Settings on first run.
        "name": "New York, New York",
        "latitude": 40.7128,
        "longitude": -74.0060,
        "timezone": "auto",
    },
    "units": {"temperature": "fahrenheit", "wind": "mph"},
    "clock": {"format24h": False, "showSeconds": True, "showDate": True},
    "youtube": {
        "apiKey": "",
        # Channel whose playlists are listed on the Music screen. Accepts a
        # UC... channel id or an @handle; the backend resolves either.
        "channel": "",
        # Live-stream ids go stale: when a 24/7 broadcast ends, the id survives
        # (oEmbed still returns its metadata) but the player refuses it with
        # "This live stream recording is not available". All three Lofi Girl ids
        # had died that way. Verified playing on 2026-08-08; if a station errors,
        # the id needs replacing, not the player.
        "stations": [
            {"id": "lofi", "name": "Chillhop Radio",
             "url": "https://www.youtube.com/watch?v=5yx6BWlEVcY"},
            {"id": "synth", "name": "Synthwave Radio",
             "url": "https://www.youtube.com/watch?v=4xDzrJKXOOY"},
        ],
        "defaultStationId": "",
        "autoplay": False,
    },
    "display": {"theme": "dark", "defaultView": "home"},
}

app = Flask(__name__, static_folder=None)
_lock = threading.Lock()


def _ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def _deep_merge(base, override):
    out = dict(base)
    for key, val in override.items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], val)
        else:
            out[key] = val
    return out


def load_settings():
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        return _deep_merge(DEFAULT_SETTINGS, stored)
    except (FileNotFoundError, json.JSONDecodeError):
        return json.loads(json.dumps(DEFAULT_SETTINGS))  # deep copy


def save_settings(new_settings):
    _ensure_data_dir()
    merged = _deep_merge(load_settings(), new_settings)
    with _lock:
        tmp = SETTINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(merged, fh, indent=2)
        os.replace(tmp, SETTINGS_PATH)
    return merged


# ----------------------------------------------------------------- static UI

@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


# ------------------------------------------------------------------ settings

@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(load_settings())


@app.route("/api/settings", methods=["POST"])
def post_settings():
    body = request.get_json(force=True, silent=True) or {}
    return jsonify(save_settings(body))


# ------------------------------------------------------------------- weather

def _http_get_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "pi5-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


@app.route("/api/weather")
def weather():
    s = load_settings()
    loc, units = s["location"], s["units"]
    params = {
        "latitude": loc["latitude"],
        "longitude": loc["longitude"],
        "current": ("temperature_2m,relative_humidity_2m,apparent_temperature,"
                    "is_day,weather_code,wind_speed_10m"),
        "hourly": "temperature_2m,weather_code,precipitation_probability",
        "daily": ("weather_code,temperature_2m_max,temperature_2m_min,"
                  "precipitation_probability_max,sunrise,sunset"),
        "temperature_unit": units["temperature"],
        "wind_speed_unit": units["wind"],
        "timezone": loc.get("timezone", "auto") or "auto",
        "forecast_days": 7,
    }
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
    try:
        data = _http_get_json(url)
        data["_location"] = loc
        return jsonify(data)
    except Exception as exc:  # noqa: BLE001 - surface upstream errors to the UI
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY


@app.route("/api/geocode")
def geocode():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"results": []})
    url = "https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode(
        {"name": query, "count": 6, "language": "en", "format": "json"}
    )
    try:
        return jsonify(_http_get_json(url))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY


# ----------------------------------------------------------------- bluetooth

@app.route("/api/bluetooth/status")
def bt_status():
    return jsonify(bt.status())


@app.route("/api/bluetooth/devices")
def bt_devices():
    return jsonify({"devices": bt.devices(), "scanning": bt.is_scanning()})


@app.route("/api/bluetooth/scan", methods=["POST"])
def bt_scan():
    seconds = int((request.get_json(silent=True) or {}).get("seconds", 15))
    bt.start_scan(seconds)
    return jsonify({"scanning": True, "seconds": seconds})


def _mac_from_request():
    return (request.get_json(force=True, silent=True) or {}).get("mac", "").strip()


@app.route("/api/bluetooth/pair", methods=["POST"])
def bt_pair():
    return jsonify(bt.pair(_mac_from_request()))


@app.route("/api/bluetooth/connect", methods=["POST"])
def bt_connect():
    return jsonify(bt.connect(_mac_from_request()))


@app.route("/api/bluetooth/disconnect", methods=["POST"])
def bt_disconnect():
    return jsonify(bt.disconnect(_mac_from_request()))


@app.route("/api/bluetooth/remove", methods=["POST"])
def bt_remove():
    return jsonify(bt.remove(_mac_from_request()))


# -------------------------------------------------------------------- system

@app.route("/api/system/exit-kiosk", methods=["POST"])
def exit_kiosk():
    """Close the kiosk browser so the user drops back to the desktop."""
    killed = []
    for name in ("chromium", "chromium-browser"):
        try:
            res = subprocess.run(["pkill", "-x", name], check=False)
            if res.returncode == 0:
                killed.append(name)
        except FileNotFoundError:
            pass
    return jsonify({"ok": True, "killed": killed})


@app.route("/api/system/info")
def system_info():
    return jsonify({
        "hostname": os.uname().nodename if hasattr(os, "uname") else "",
        "bluetoothAvailable": bt.available(),
    })


# ---------------------------------------------------------------- google session

CHROMIUM_PROFILE = os.path.join(
    os.path.expanduser("~"), ".config", "pi5-dashboard", "chromium")

# Cookie NAMES Google sets once a real session exists. Values are encrypted at
# rest but the names alone answer "is this browser signed in". The QR/TV flow
# never creates any of these, which is why it could not authenticate anything.
_AUTH_COOKIES = ("SID", "SAPISID", "HSID", "SSID", "APISID",
                 "__Secure-1PSID", "__Secure-3PSID", "__Secure-3PAPISID",
                 "LOGIN_INFO")


def google_signed_in():
    """Look for real Google auth cookies in the kiosk's own Chromium profile."""
    import shutil as _shutil
    import sqlite3
    import tempfile

    path = None
    for rel in (os.path.join("Default", "Cookies"), "Cookies"):
        cand = os.path.join(CHROMIUM_PROFILE, rel)
        if os.path.exists(cand):
            path = cand
            break
    if not path:
        return {"signedIn": False, "known": False, "reason": "no cookie store yet"}

    tmp = None
    try:
        # Chromium holds a write lock on the live DB, so always read a copy.
        fd, tmp = tempfile.mkstemp(prefix="pi5ck-")
        os.close(fd)
        _shutil.copy2(path, tmp)
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        try:
            rows = con.execute("SELECT name FROM cookies").fetchall()
        finally:
            con.close()
        hits = sorted({r[0] for r in rows} & set(_AUTH_COOKIES))
        return {"signedIn": bool(hits), "known": True, "cookies": hits}
    except Exception as exc:
        return {"signedIn": False, "known": False, "reason": str(exc)[:200]}
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


@app.route("/api/google/status")
def google_status():
    return jsonify(google_signed_in())


@app.route("/api/google/signin", methods=["POST"])
def google_signin():
    """Swap the kiosk for a real Google sign-in page with an on-screen keyboard.

    Detached on purpose: the script closes the very browser that issued this
    request, so it has to outlive both it and this worker thread.
    """
    script = os.path.normpath(
        os.path.join(BASE_DIR, "..", "kiosk", "google-signin.sh"))
    if not os.path.exists(script):
        return jsonify({"ok": False, "error": "google-signin.sh missing"}), \
            HTTPStatus.INTERNAL_SERVER_ERROR
    try:
        subprocess.Popen(
            ["setsid", "nohup", script],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, start_new_session=True,
        )
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)[:200]}), \
            HTTPStatus.INTERNAL_SERVER_ERROR
    return jsonify({"ok": True})


# --------------------------------------------------------------- youtube library

# Listing playlists is done here rather than in the browser so the API key never
# reaches the page, and so one cache serves every reload.
#
# Scope note: there is no public API for music.youtube.com. YouTube Music
# playlists are ordinary YouTube playlists underneath, so they DO show up here --
# but only the ones that are public. Private playlists need an authenticated
# session, which this device does not have (the profile holds no Google auth
# cookies; the QR/TV sign-in deposits only leanback localStorage tokens).
_YT_API = "https://www.googleapis.com/youtube/v3/"
_PLAYLIST_TTL = 600.0                       # seconds; playlists change rarely
_pl_cache = {"key": None, "at": 0.0, "data": None}
_pl_lock = threading.Lock()


def _yt_get(path, **params):
    """GET a Data API endpoint, returning (json, error_message)."""
    url = _YT_API + path + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=12) as resp:
            return json.load(resp), None
    except urllib.error.HTTPError as exc:
        # Google puts a useful reason in the body; surface it instead of a bare 403.
        detail = ""
        try:
            body = json.load(exc)
            detail = body.get("error", {}).get("message", "")
        except Exception:
            pass
        return None, f"HTTP {exc.code}: {detail or exc.reason}"
    except Exception as exc:
        return None, str(exc)[:200]


def _resolve_channel(ref, key):
    """Turn a UC... id, an @handle, or a bare name into a channel id."""
    ref = (ref or "").strip()
    if not ref:
        return None, "no channel set"
    if ref.startswith("UC") and len(ref) == 24:
        return ref, None
    handle = ref.lstrip("@")
    # forHandle is the modern lookup; forUsername only works for legacy names.
    for param in ("forHandle", "forUsername"):
        val = "@" + handle if param == "forHandle" else handle
        data, err = _yt_get("channels", part="id", key=key, **{param: val})
        if data and data.get("items"):
            return data["items"][0]["id"], None
    return None, f"could not resolve channel {ref!r}"


def _fetch_playlists(key, channel_ref):
    channel_id, err = _resolve_channel(channel_ref, key)
    if err:
        return None, err
    items, page = [], None
    while True:
        params = dict(part="snippet,contentDetails", channelId=channel_id,
                      maxResults=50, key=key)
        if page:
            params["pageToken"] = page
        data, err = _yt_get("playlists", **params)
        if err:
            return None, err
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            thumbs = sn.get("thumbnails", {})
            thumb = (thumbs.get("medium") or thumbs.get("default") or {}).get("url", "")
            items.append({
                "id": it.get("id"),
                "title": sn.get("title", "Untitled"),
                "count": it.get("contentDetails", {}).get("itemCount", 0),
                "thumb": thumb,
            })
        page = data.get("nextPageToken")
        if not page:
            break
    return items, None


@app.route("/api/youtube/playlists")
def youtube_playlists():
    """Public playlists for the configured channel, cached to protect quota."""
    cfg = load_settings().get("youtube", {})
    key, channel = cfg.get("apiKey", ""), cfg.get("channel", "")
    if not key:
        return jsonify({"ok": False, "needs": "apiKey", "playlists": []})
    if not channel:
        return jsonify({"ok": False, "needs": "channel", "playlists": []})

    cache_key = (key, channel)
    force = request.args.get("refresh") == "1"
    with _pl_lock:
        fresh = (_pl_cache["key"] == cache_key
                 and time.monotonic() - _pl_cache["at"] < _PLAYLIST_TTL)
        if fresh and not force and _pl_cache["data"] is not None:
            return jsonify({"ok": True, "cached": True,
                            "playlists": _pl_cache["data"]})

    items, err = _fetch_playlists(key, channel)
    if err:
        return jsonify({"ok": False, "error": err, "playlists": []})
    with _pl_lock:
        _pl_cache.update(key=cache_key, at=time.monotonic(), data=items)
    return jsonify({"ok": True, "cached": False, "playlists": items})


def main():
    _ensure_data_dir()
    if not os.path.exists(SETTINGS_PATH):
        save_settings({})
    host = os.environ.get("PI5_DASHBOARD_HOST", "127.0.0.1")
    port = int(os.environ.get("PI5_DASHBOARD_PORT", "8080"))
    app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
