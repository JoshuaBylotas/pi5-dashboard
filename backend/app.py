#!/usr/bin/env python3
"""Pi5 Dashboard backend.

Serves the touchscreen dashboard frontend and exposes a small local API for:
  - persisted settings (location, clock, YouTube stations, display)
  - weather (Open-Meteo proxy + geocoding, no API key needed)
  - Bluetooth speaker management (wraps bluetoothctl)
  - kiosk/system control (exit the fullscreen browser back to the desktop)

Third-party dependencies: Flask; yt-dlp (audio-only fallback for videos the
YouTube IFrame embed refuses to play -- see README.md for the tradeoffs);
msal (Entra ID sign-in for the public shopping list).
"""

import json
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from functools import wraps
from http import HTTPStatus

import msal
from flask import (Flask, jsonify, redirect, request, send_from_directory,
                    session, url_for)
from werkzeug.middleware.proxy_fix import ProxyFix

import bluetooth as bt  # local module (backend/bluetooth.py)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend"))

DATA_DIR = os.environ.get(
    "PI5_DASHBOARD_DATA",
    os.path.join(os.path.expanduser("~"), ".config", "pi5-dashboard"),
)
SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")
# Kept separate from settings.json (and its private-repo snapshot) since this
# holds a live refresh token rather than plain config.
TOKEN_PATH = os.path.join(DATA_DIR, "youtube_token.json")
SHOPPING_PATH = os.path.join(DATA_DIR, "shopping.json")
SECRET_KEY_PATH = os.path.join(DATA_DIR, "flask_secret.key")

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
        # OAuth client for the device-code sign-in that lists ALL of your
        # playlists (including Liked videos). Create a "TV and Limited Input
        # Devices" OAuth client in Google Cloud Console; see README.md.
        "oauthClientId": "",
        "oauthClientSecret": "",
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
    "entra": {
        # Single-tenant app registration for the public shopping list at
        # shopping.bylotas.com. NOT the transcore.com work tenant -- see
        # README.md for why, and for how to register the app.
        "tenantId": "",
        "clientId": "",
        "clientSecret": "",
        "redirectUri": "https://shopping.bylotas.com/auth/callback",
    },
}

def _load_or_create_secret_key():
    try:
        with open(SECRET_KEY_PATH, "r", encoding="utf-8") as fh:
            key = fh.read().strip()
            if key:
                return key
    except FileNotFoundError:
        pass
    os.makedirs(DATA_DIR, exist_ok=True)
    key = secrets.token_hex(32)
    with open(SECRET_KEY_PATH, "w", encoding="utf-8") as fh:
        fh.write(key)
    os.chmod(SECRET_KEY_PATH, 0o600)
    return key


app = Flask(__name__, static_folder=None)
app.secret_key = _load_or_create_secret_key()
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    # Not Secure-only: the kiosk itself hits /shopping over plain HTTP via
    # 127.0.0.1, alongside HTTPS from the public reverse proxy. Fine for a
    # family shopping list; wouldn't be for anything more sensitive.
)

# The backend binds to every interface (see main()) so the shopping list can
# be reached through a reverse proxy at shopping.bylotas.com. PI5_DASHBOARD_
# PROXY_HOPS must match the number of reverse-proxy hops actually in front of
# it (1 for a single proxy) -- get this wrong and either real client IPs are
# lost, or, worse, a client can forge X-Forwarded-For to impersonate 127.0.0.1
# and slip past @localhost_only. See README.md.
_PROXY_HOPS = int(os.environ.get("PI5_DASHBOARD_PROXY_HOPS", "1"))
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=_PROXY_HOPS, x_proto=_PROXY_HOPS,
                        x_host=_PROXY_HOPS)

_lock = threading.Lock()


def localhost_only(fn):
    """Restrict a route to the Pi itself. Nothing here -- settings (which
    holds OAuth/Entra secrets), Bluetooth control, kiosk control, and the
    Google/YouTube endpoints -- should ever be reachable from another device,
    on the LAN or (via the reverse proxy) the public internet."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if request.remote_addr not in ("127.0.0.1", "::1"):
            return jsonify({"ok": False, "error": "not available on the network"}), HTTPStatus.FORBIDDEN
        return fn(*args, **kwargs)
    return wrapper


def login_required(fn):
    """Restrict a route to a signed-in Entra ID session (the shopping list)."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "sign-in required"}), HTTPStatus.UNAUTHORIZED
            return redirect(url_for("auth_login", next=request.path))
        return fn(*args, **kwargs)
    return wrapper


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
@localhost_only
def get_settings():
    return jsonify(load_settings())


@app.route("/api/settings", methods=["POST"])
@localhost_only
def post_settings():
    body = request.get_json(force=True, silent=True) or {}
    return jsonify(save_settings(body))


# ------------------------------------------------------------------- weather

def _http_get_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "pi5-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


@app.route("/api/weather")
@localhost_only
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
@localhost_only
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
@localhost_only
def bt_status():
    return jsonify(bt.status())


@app.route("/api/bluetooth/devices")
@localhost_only
def bt_devices():
    return jsonify({"devices": bt.devices(), "scanning": bt.is_scanning()})


@app.route("/api/bluetooth/scan", methods=["POST"])
@localhost_only
def bt_scan():
    seconds = int((request.get_json(silent=True) or {}).get("seconds", 15))
    bt.start_scan(seconds)
    return jsonify({"scanning": True, "seconds": seconds})


def _mac_from_request():
    return (request.get_json(force=True, silent=True) or {}).get("mac", "").strip()


@app.route("/api/bluetooth/pair", methods=["POST"])
@localhost_only
def bt_pair():
    return jsonify(bt.pair(_mac_from_request()))


@app.route("/api/bluetooth/connect", methods=["POST"])
@localhost_only
def bt_connect():
    return jsonify(bt.connect(_mac_from_request()))


@app.route("/api/bluetooth/disconnect", methods=["POST"])
@localhost_only
def bt_disconnect():
    return jsonify(bt.disconnect(_mac_from_request()))


@app.route("/api/bluetooth/remove", methods=["POST"])
@localhost_only
def bt_remove():
    return jsonify(bt.remove(_mac_from_request()))


# -------------------------------------------------------------------- system

@app.route("/api/system/exit-kiosk", methods=["POST"])
@localhost_only
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
@localhost_only
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
@localhost_only
def google_status():
    return jsonify(google_signed_in())


@app.route("/api/google/signin", methods=["POST"])
@localhost_only
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
@localhost_only
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


# ------------------------------------------------------- youtube account (oauth)

# A plain API key can only read public data. Listing ALL of a user's playlists
# (and the Liked videos playlist, which is always private) needs a real user
# token. This uses the OAuth 2.0 device-code grant, which fits a screen with
# no keyboard: show a short code, the user approves it on their phone, and we
# poll until Google hands back tokens. See README.md for creating the OAuth
# client ("TV and Limited Input Devices" type).
_GOOGLE_DEVICE_URL = "https://oauth2.googleapis.com/device/code"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
# The same sign-in also covers the Calendar view -- one token, two scopes.
_GOOGLE_SCOPES = ("https://www.googleapis.com/auth/youtube.readonly "
                  "https://www.googleapis.com/auth/calendar.readonly")

_device_lock = threading.Lock()
_device_flow = {}   # in-memory only; one pending sign-in at a time
_token_lock = threading.Lock()

_DURATION_RE = re.compile(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?")


def _parse_duration(iso):
    """ISO-8601 'PT#H#M#S' -> seconds."""
    m = _DURATION_RE.match(iso or "")
    if not m:
        return 0
    h, mnt, s = (int(g) if g else 0 for g in m.groups())
    return h * 3600 + mnt * 60 + s


def _post_form(url, params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return json.load(resp), None
    except urllib.error.HTTPError as exc:
        try:
            body = json.load(exc)
        except Exception:
            body = {}
        return body, body.get("error", f"HTTP {exc.code}")
    except Exception as exc:
        return None, str(exc)[:200]


def _load_token():
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _save_token(data):
    _ensure_data_dir()
    tmp = TOKEN_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.chmod(tmp, 0o600)
    os.replace(tmp, TOKEN_PATH)


def _clear_token():
    try:
        os.remove(TOKEN_PATH)
    except FileNotFoundError:
        pass


def _get_access_token():
    """Return (token, error), refreshing from the stored refresh token as needed."""
    with _token_lock:
        tok = _load_token()
        if not tok or not tok.get("refresh_token"):
            return None, "not signed in"
        if tok.get("access_token") and time.time() < tok.get("expires_at", 0) - 60:
            return tok["access_token"], None
        cfg = load_settings().get("youtube", {})
        data, err = _post_form(_GOOGLE_TOKEN_URL, {
            "client_id": cfg.get("oauthClientId", ""),
            "client_secret": cfg.get("oauthClientSecret", ""),
            "refresh_token": tok["refresh_token"],
            "grant_type": "refresh_token",
        })
        if not data or not data.get("access_token"):
            return None, (data or {}).get("error", err or "refresh failed")
        tok["access_token"] = data["access_token"]
        tok["expires_at"] = time.time() + data.get("expires_in", 3600)
        _save_token(tok)
        return tok["access_token"], None


def _authed_get(url, token, **params):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return json.load(resp), None
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            body = json.load(exc)
            detail = body.get("error", {}).get("message", "")
        except Exception:
            pass
        return None, f"HTTP {exc.code}: {detail or exc.reason}"
    except Exception as exc:
        return None, str(exc)[:200]


def _yt_get_auth(path, token, **params):
    return _authed_get(_YT_API + path, token, **params)


@app.route("/api/youtube/auth/state")
@localhost_only
def youtube_auth_state():
    tok = _load_token()
    return jsonify({"signedIn": bool(tok and tok.get("refresh_token"))})


@app.route("/api/youtube/auth/start", methods=["POST"])
@localhost_only
def youtube_auth_start():
    cfg = load_settings().get("youtube", {})
    client_id = cfg.get("oauthClientId", "")
    if not client_id:
        return jsonify({"ok": False, "error": "Add an OAuth client id in Settings first."})
    data, err = _post_form(_GOOGLE_DEVICE_URL, {"client_id": client_id, "scope": _GOOGLE_SCOPES})
    if err or not data or "device_code" not in data:
        return jsonify({"ok": False, "error": (data or {}).get("error_description", err) or "request failed"})
    with _device_lock:
        _device_flow.clear()
        _device_flow.update(
            device_code=data["device_code"],
            expires_at=time.time() + data.get("expires_in", 1800),
        )
    return jsonify({
        "ok": True,
        "userCode": data["user_code"],
        "verificationUrl": data.get("verification_url"),
        "interval": data.get("interval", 5),
        "expiresIn": data.get("expires_in", 1800),
    })


@app.route("/api/youtube/auth/poll", methods=["POST"])
@localhost_only
def youtube_auth_poll():
    cfg = load_settings().get("youtube", {})
    with _device_lock:
        flow = dict(_device_flow)
    if not flow.get("device_code"):
        return jsonify({"ok": False, "status": "none"})
    if time.time() > flow["expires_at"]:
        with _device_lock:
            _device_flow.clear()
        return jsonify({"ok": False, "status": "expired"})

    data, err = _post_form(_GOOGLE_TOKEN_URL, {
        "client_id": cfg.get("oauthClientId", ""),
        "client_secret": cfg.get("oauthClientSecret", ""),
        "device_code": flow["device_code"],
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    })
    if data and data.get("access_token"):
        _save_token({
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token"),
            "expires_at": time.time() + data.get("expires_in", 3600),
        })
        with _device_lock:
            _device_flow.clear()
        return jsonify({"ok": True, "status": "signed_in"})

    reason = (data or {}).get("error", err or "unknown")
    if reason in ("authorization_pending", "slow_down"):
        return jsonify({"ok": False, "status": "pending"})
    with _device_lock:
        _device_flow.clear()
    return jsonify({"ok": False, "status": "error", "error": reason})


@app.route("/api/youtube/auth/signout", methods=["POST"])
@localhost_only
def youtube_auth_signout():
    _clear_token()
    return jsonify({"ok": True})


@app.route("/api/youtube/my/playlists")
@localhost_only
def youtube_my_playlists():
    """Every playlist the signed-in user owns, including Liked videos.

    Liked videos never shows up in a plain playlists.list(mine=true) call --
    it has to be resolved via the channel's relatedPlaylists.likes id.
    """
    token, err = _get_access_token()
    if err:
        return jsonify({"ok": False, "needs": "signin", "error": err, "playlists": []})

    def _playlist_entry(it, liked):
        sn = it.get("snippet", {})
        thumbs = sn.get("thumbnails", {})
        thumb = (thumbs.get("medium") or thumbs.get("default") or {}).get("url", "")
        return {"id": it.get("id"), "title": "Liked videos" if liked else sn.get("title", "Untitled"),
                "count": it.get("contentDetails", {}).get("itemCount", 0),
                "thumb": thumb, "liked": liked}

    items = []
    chan, e = _yt_get_auth("channels", token, part="contentDetails", mine="true")
    likes_id = None
    if chan and chan.get("items"):
        likes_id = chan["items"][0]["contentDetails"].get("relatedPlaylists", {}).get("likes")
    if likes_id:
        pdata, _e = _yt_get_auth("playlists", token, part="snippet,contentDetails", id=likes_id)
        for it in (pdata or {}).get("items", []):
            items.append(_playlist_entry(it, liked=True))

    page = None
    while True:
        params = dict(part="snippet,contentDetails", mine="true", maxResults=50)
        if page:
            params["pageToken"] = page
        data, e = _yt_get_auth("playlists", token, **params)
        if e:
            return jsonify({"ok": False, "error": e, "playlists": items})
        for it in data.get("items", []):
            items.append(_playlist_entry(it, liked=False))
        page = data.get("nextPageToken")
        if not page:
            break
    return jsonify({"ok": True, "playlists": items})


@app.route("/api/youtube/my/playlists/<playlist_id>/items")
@localhost_only
def youtube_my_playlist_items(playlist_id):
    """Tracks in one of the signed-in user's playlists, with duration and
    per-video embeddability (a private playlist can hold public videos)."""
    token, err = _get_access_token()
    if err:
        return jsonify({"ok": False, "needs": "signin", "error": err, "tracks": []})

    video_ids, meta = [], {}
    page = None
    while True:
        params = dict(part="snippet,contentDetails", playlistId=playlist_id, maxResults=50)
        if page:
            params["pageToken"] = page
        data, e = _yt_get_auth("playlistItems", token, **params)
        if e:
            return jsonify({"ok": False, "error": e, "tracks": []})
        for it in data.get("items", []):
            vid = it.get("contentDetails", {}).get("videoId")
            if not vid:
                continue
            sn = it.get("snippet", {})
            thumbs = sn.get("thumbnails", {})
            thumb = (thumbs.get("medium") or thumbs.get("default") or {}).get("url", "")
            video_ids.append(vid)
            meta[vid] = {"videoId": vid, "title": sn.get("title", "Untitled"),
                         "thumb": thumb, "position": sn.get("position", 0)}
        page = data.get("nextPageToken")
        if not page:
            break

    for i in range(0, len(video_ids), 50):
        chunk = video_ids[i:i + 50]
        data, e = _yt_get_auth("videos", token, part="contentDetails,status", id=",".join(chunk))
        if e:
            continue
        for it in data.get("items", []):
            info = meta.get(it.get("id"))
            if not info:
                continue
            info["duration"] = _parse_duration(it.get("contentDetails", {}).get("duration"))
            info["embeddable"] = bool(it.get("status", {}).get("embeddable"))

    # A video missing from the videos.list response (deleted, or otherwise
    # inaccessible) never got an embeddable flag -- treat that as unplayable.
    for info in meta.values():
        info.setdefault("embeddable", False)
        info.setdefault("duration", 0)

    tracks = sorted(meta.values(), key=lambda t: t["position"])
    return jsonify({"ok": True, "tracks": tracks})


# --------------------------------------------------------- audio-only fallback

# Not an official API -- yt-dlp scrapes YouTube's own player response. This is
# a ToS violation and breaks whenever YouTube changes its player internals;
# it exists only as a last resort for a video the IFrame embed flatly refuses
# to play (embedding disabled, region licensing, etc.), where the alternative
# is no audio at all. Keep yt-dlp updated (see requirements.txt) or this rots.
@app.route("/api/youtube/audio/<video_id>")
@localhost_only
def youtube_audio_url(video_id):
    try:
        import yt_dlp
    except ImportError:
        return jsonify({"ok": False, "error": "yt-dlp not installed"})
    opts = {
        "format": "bestaudio/best",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except Exception as exc:  # noqa: BLE001 - yt-dlp raises many exception types
        return jsonify({"ok": False, "error": str(exc)[:300]})
    url = info.get("url")
    if not url:
        return jsonify({"ok": False, "error": "no audio stream found"})
    return jsonify({"ok": True, "url": url, "title": info.get("title", "")})


# ------------------------------------------------------------------- calendar

# Reuses the same Google sign-in as the YouTube playlists (see _GOOGLE_SCOPES)
# -- one device-code flow covers both. Read-only: no create/edit here.
_CAL_API = "https://www.googleapis.com/calendar/v3/"


@app.route("/api/calendar/upcoming")
@localhost_only
def calendar_upcoming():
    token, err = _get_access_token()
    if err:
        return jsonify({"ok": False, "needs": "signin", "error": err, "events": []})
    params = dict(timeMin=datetime.now(timezone.utc).isoformat(), maxResults=20,
                  singleEvents="true", orderBy="startTime")
    data, e = _authed_get(_CAL_API + "calendars/primary/events", token, **params)
    if e:
        return jsonify({"ok": False, "error": e, "events": []})
    events = []
    for it in data.get("items", []):
        start = it.get("start", {})
        events.append({
            "id": it.get("id"),
            "title": it.get("summary", "(no title)"),
            "start": start.get("dateTime") or start.get("date"),
            "allDay": "date" in start,
            "location": it.get("location", ""),
        })
    return jsonify({"ok": True, "events": events})


# ---------------------------------------------------------------- air quality

@app.route("/api/airquality")
@localhost_only
def air_quality():
    s = load_settings()
    loc = s["location"]
    params = {
        "latitude": loc["latitude"], "longitude": loc["longitude"],
        "current": "us_aqi,pm2_5,pm10,ozone,uv_index",
        # Pollen coverage is the CAMS European model -- only Europe gets real
        # values; other locations get nulls the frontend shows as "unavailable".
        "hourly": ("us_aqi,alder_pollen,birch_pollen,grass_pollen,"
                   "mugwort_pollen,olive_pollen,ragweed_pollen"),
        "timezone": loc.get("timezone", "auto") or "auto",
    }
    url = "https://air-quality-api.open-meteo.com/v1/air-quality?" + urllib.parse.urlencode(params)
    try:
        return jsonify(_http_get_json(url))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY


# ------------------------------------------------------- entra id (shopping list)

# Sign-in for the public shopping list at shopping.bylotas.com, via a
# single-tenant Entra ID app registration. See README.md for registering it
# (redirect URI, client secret) -- deliberately NOT the transcore.com work
# tenant, since this is a personal/family tool.
_ENTRA_SCOPES = ["User.Read"]  # openid/profile/offline_access are implicit


def _msal_app():
    cfg = load_settings().get("entra", {})
    authority = f"https://login.microsoftonline.com/{cfg.get('tenantId', '')}"
    return msal.ConfidentialClientApplication(
        cfg.get("clientId", ""), authority=authority,
        client_credential=cfg.get("clientSecret", ""))


@app.route("/auth/login")
def auth_login():
    cfg = load_settings().get("entra", {})
    if not cfg.get("tenantId") or not cfg.get("clientId"):
        return "Entra ID isn't configured yet -- see Settings on the dashboard.", \
            HTTPStatus.SERVICE_UNAVAILABLE
    session["auth_state"] = secrets.token_hex(16)
    session["next"] = request.args.get("next", "/shopping")
    auth_url = _msal_app().get_authorization_request_url(
        _ENTRA_SCOPES, state=session["auth_state"], redirect_uri=cfg.get("redirectUri"))
    return redirect(auth_url)


@app.route("/auth/callback")
def auth_callback():
    if not session.get("auth_state") or request.args.get("state") != session.get("auth_state"):
        return "Invalid sign-in state -- please try again.", HTTPStatus.BAD_REQUEST
    code = request.args.get("code")
    if not code:
        return f"Sign-in failed: {request.args.get('error_description', 'no code returned')}", \
            HTTPStatus.BAD_REQUEST
    cfg = load_settings().get("entra", {})
    result = _msal_app().acquire_token_by_authorization_code(
        code, scopes=_ENTRA_SCOPES, redirect_uri=cfg.get("redirectUri"))
    if "id_token_claims" not in result:
        return f"Sign-in failed: {result.get('error_description', 'unknown error')}", \
            HTTPStatus.BAD_REQUEST
    claims = result["id_token_claims"]
    session.pop("auth_state", None)
    session.permanent = True
    session["user"] = {
        "name": claims.get("name", "Someone"),
        "email": claims.get("preferred_username", ""),
    }
    return redirect(session.pop("next", "/shopping"))


@app.route("/auth/logout")
def auth_logout():
    session.clear()
    return redirect("/shopping")


# ------------------------------------------------------------------ shopping list

# Public (via the reverse proxy) but gated by @login_required, not
# @localhost_only -- this is the one feature meant to be reachable off the Pi.
_shopping_lock = threading.Lock()


def _load_shopping():
    try:
        with open(SHOPPING_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"lists": []}


def _save_shopping(data):
    _ensure_data_dir()
    tmp = SHOPPING_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, SHOPPING_PATH)


def _find_list(data, list_id):
    return next((lst for lst in data["lists"] if lst["id"] == list_id), None)


@app.route("/shopping")
@login_required
def shopping_page():
    return send_from_directory(FRONTEND_DIR, "shopping.html")


@app.route("/api/shopping/whoami")
@login_required
def shopping_whoami():
    return jsonify({"ok": True, "user": session["user"]})


@app.route("/api/shopping/lists", methods=["GET"])
@login_required
def shopping_lists():
    data = _load_shopping()
    summary = [{"id": lst["id"], "name": lst["name"], "count": len(lst["items"]),
                "uncheckedCount": sum(1 for it in lst["items"] if not it["checked"])}
               for lst in data["lists"]]
    return jsonify({"ok": True, "lists": summary})


@app.route("/api/shopping/lists", methods=["POST"])
@login_required
def shopping_create_list():
    name = (request.get_json(force=True, silent=True) or {}).get("name", "").strip()
    if not name:
        return jsonify({"ok": False, "error": "name required"}), HTTPStatus.BAD_REQUEST
    with _shopping_lock:
        data = _load_shopping()
        new_list = {"id": uuid.uuid4().hex[:10], "name": name[:60], "items": []}
        data["lists"].append(new_list)
        _save_shopping(data)
    return jsonify({"ok": True, "list": new_list})


@app.route("/api/shopping/lists/<list_id>", methods=["DELETE"])
@login_required
def shopping_delete_list(list_id):
    with _shopping_lock:
        data = _load_shopping()
        data["lists"] = [lst for lst in data["lists"] if lst["id"] != list_id]
        _save_shopping(data)
    return jsonify({"ok": True})


@app.route("/api/shopping/lists/<list_id>/items", methods=["GET"])
@login_required
def shopping_items(list_id):
    data = _load_shopping()
    lst = _find_list(data, list_id)
    if not lst:
        return jsonify({"ok": False, "error": "list not found"}), HTTPStatus.NOT_FOUND
    return jsonify({"ok": True, "name": lst["name"], "items": lst["items"]})


@app.route("/api/shopping/lists/<list_id>/items", methods=["POST"])
@login_required
def shopping_add_item(list_id):
    text = (request.get_json(force=True, silent=True) or {}).get("text", "").strip()
    if not text:
        return jsonify({"ok": False, "error": "empty"}), HTTPStatus.BAD_REQUEST
    with _shopping_lock:
        data = _load_shopping()
        lst = _find_list(data, list_id)
        if not lst:
            return jsonify({"ok": False, "error": "list not found"}), HTTPStatus.NOT_FOUND
        item = {"id": uuid.uuid4().hex[:10], "text": text[:200], "checked": False,
                "addedBy": session["user"]["name"], "addedAt": time.time()}
        lst["items"].append(item)
        _save_shopping(data)
    return jsonify({"ok": True, "item": item})


@app.route("/api/shopping/lists/<list_id>/items/<item_id>/toggle", methods=["POST"])
@login_required
def shopping_toggle_item(list_id, item_id):
    with _shopping_lock:
        data = _load_shopping()
        lst = _find_list(data, list_id)
        if not lst:
            return jsonify({"ok": False, "error": "list not found"}), HTTPStatus.NOT_FOUND
        for it in lst["items"]:
            if it["id"] == item_id:
                it["checked"] = not it["checked"]
        _save_shopping(data)
    return jsonify({"ok": True})


@app.route("/api/shopping/lists/<list_id>/items/<item_id>", methods=["DELETE"])
@login_required
def shopping_delete_item(list_id, item_id):
    with _shopping_lock:
        data = _load_shopping()
        lst = _find_list(data, list_id)
        if lst:
            lst["items"] = [it for it in lst["items"] if it["id"] != item_id]
            _save_shopping(data)
    return jsonify({"ok": True})


@app.route("/api/shopping/lists/<list_id>/clear-checked", methods=["POST"])
@login_required
def shopping_clear_checked(list_id):
    with _shopping_lock:
        data = _load_shopping()
        lst = _find_list(data, list_id)
        if lst:
            lst["items"] = [it for it in lst["items"] if not it["checked"]]
            _save_shopping(data)
    return jsonify({"ok": True})


def main():
    _ensure_data_dir()
    if not os.path.exists(SETTINGS_PATH):
        save_settings({})
    # 0.0.0.0 by default so the reverse proxy for shopping.bylotas.com can
    # reach this process; @localhost_only + ProxyFix (see module docstring
    # near _PROXY_HOPS) keep everything else off the network regardless.
    host = os.environ.get("PI5_DASHBOARD_HOST", "0.0.0.0")
    port = int(os.environ.get("PI5_DASHBOARD_PORT", "8080"))
    app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
