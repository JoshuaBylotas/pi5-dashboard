"""Thin wrapper around `bluetoothctl` for speaker pairing/connection.

Everything shells out to `bluetoothctl`; output parsing is intentionally
forgiving so a change in its format degrades gracefully instead of crashing the
dashboard. Designed for the common case: a keyless A2DP speaker/headset.
"""

import re
import shutil
import subprocess
import threading
import time

_scan_thread = None
_scan_until = 0.0
_scan_lock = threading.Lock()

# BlueZ drops discovered-but-unpaired devices from `bluetoothctl devices`
# shortly after discovery stops, which made the picker empty itself out while
# the user was still looking at it. Remember what we've seen for a while so the
# list stays stable between scans.
_seen = {}                      # mac -> {"mac", "name", "last_seen"}
_seen_lock = threading.Lock()
_SEEN_TTL = 900.0               # 15 minutes

_MAC_RE = re.compile(r"([0-9A-F]{2}(?::[0-9A-F]{2}){5})", re.IGNORECASE)

# bluetoothctl colourises its prompt and emits a flood of RSSI/TxPower churn for
# every device in range. Left in, that noise fills the whole error message shown
# in Settings and buries the one line that says why pairing failed.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
# Advertising churn is per-device and takes many shapes (RSSI:, TxPower:,
# ManufacturerData.Key:, plus raw hex dumps), so filter by *which device* a line
# is about rather than trying to enumerate the fields.
_EVENT_RE = re.compile(r"^\[(CHG|NEW|DEL)\]")
_HEXDUMP_RE = re.compile(r"^[0-9a-f]{2}( [0-9a-f]{2})+")


def _clean(text, mac=None):
    """Strip colour codes and other devices' advertising churn."""
    out = []
    for line in _ANSI_RE.sub("", text).splitlines():
        line = line.replace("[bluetoothctl]>", "").strip()
        if not line or _HEXDUMP_RE.match(line):
            continue
        # Keep events for the device being paired; drop every other radio's.
        if _EVENT_RE.match(line) and not (mac and mac.lower() in line.lower()):
            continue
        out.append(line)
    # Late lines carry the verdict, so keep the tail when trimming.
    return "\n".join(out[-25:])


def available():
    return shutil.which("bluetoothctl") is not None


def _bctl(*args, timeout=20, stdin=None):
    try:
        proc = subprocess.run(
            ["bluetoothctl", *args],
            capture_output=True, text=True, timeout=timeout, input=stdin,
        )
        return proc.stdout + proc.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        return f"__error__ {exc}"


def _power_on():
    _bctl("power", "on", timeout=10)


def is_scanning():
    with _scan_lock:
        return time.monotonic() < _scan_until


def start_scan(seconds=15):
    """Kick off a background discovery scan for `seconds`."""
    global _scan_thread, _scan_until
    if not available():
        return
    _power_on()
    with _scan_lock:
        _scan_until = time.monotonic() + seconds
        if _scan_thread and _scan_thread.is_alive():
            return
        _scan_thread = threading.Thread(
            target=_scan_worker, args=(seconds,), daemon=True
        )
        _scan_thread.start()


def _scan_worker(seconds):
    # `--timeout N scan on` scans for N seconds then exits cleanly.
    _bctl("--timeout", str(int(seconds)), "scan", "on", timeout=seconds + 5)


def _parse_device_lines(text):
    devices = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("Device "):
            continue
        match = _MAC_RE.search(line)
        if not match:
            continue
        mac = match.group(1)
        name = line.split(mac, 1)[-1].strip() or mac
        devices.append({"mac": mac, "name": name})
    return devices


def _paired_raw():
    """List paired devices, tolerating the BlueZ 5.8x command rename.

    `paired-devices` was dropped from the main menu in newer BlueZ (5.82 on this
    Pi answers "Invalid command in menu main"). That failure was silent: the
    caller parsed the error text into an empty set, so every paired device
    looked unpaired and the placeholder-name filter below lost the safety net
    that keeps a bonded speaker visible while it advertises without a name.
    Try the modern form first, then fall back for older releases.
    """
    out = _bctl("devices", "Paired", timeout=10)
    if "Invalid command" in out or "Invalid argument" in out:
        out = _bctl("paired-devices", timeout=10)
    return "" if "Invalid command" in out else out


def _is_placeholder_name(name, mac):
    """True when the 'name' is just the MAC in disguise (unnamed BLE beacon)."""
    return name.replace("-", ":").upper() == mac.upper()


def devices():
    """Known + recently discovered devices, annotated with pair/connect state."""
    if not available():
        return []
    now = time.monotonic()
    with _seen_lock:
        for dev in _parse_device_lines(_bctl("devices")):
            mac, name = dev["mac"], dev["name"]
            prev = _seen.get(mac)
            # Never let a real name regress to a MAC placeholder.
            if prev and _is_placeholder_name(name, mac):
                name = prev["name"]
            _seen[mac] = {"mac": mac, "name": name, "last_seen": now}
        for mac in [m for m, e in _seen.items() if now - e["last_seen"] > _SEEN_TTL]:
            del _seen[mac]
        remembered = list(_seen.values())

    # One cheap call, so the filter below can keep a paired device even if it is
    # currently advertising without a name.
    paired_macs = {d["mac"].upper() for d in _parse_device_lines(_paired_raw())}

    # Unnamed devices are BLE beacons — phones, watches, TVs and tags in range.
    # They can never be the speaker you want, and because BLE privacy addresses
    # rotate every few minutes each one keeps reappearing under a fresh MAC,
    # which is what filled the picker with junk rows. Drop them unless paired.
    candidates = [e for e in remembered
                  if e["mac"].upper() in paired_macs
                  or not _is_placeholder_name(e["name"], e["mac"])]

    result = []
    for entry in candidates:
        mac = entry["mac"]
        info = _bctl("info", mac, timeout=10)
        dev = {"mac": mac, "name": entry["name"]}
        dev["paired"] = "Paired: yes" in info
        dev["connected"] = "Connected: yes" in info
        dev["trusted"] = "Trusted: yes" in info
        # Flag likely audio devices so the UI can surface speakers first.
        dev["audio"] = any(tok in info for tok in ("Audio", "audio-card", "Sink", "Headset"))
        dev["_last_seen"] = entry["last_seen"]
        result.append(dev)

    # A rotating device can still be cached under two addresses within the TTL,
    # showing the same name twice. Keep the most useful row for each name.
    def rank(d):
        return (d["connected"], d["paired"], d["audio"], d["_last_seen"])

    best = {}
    for dev in result:
        key = dev["name"].strip().lower()
        if key not in best or rank(dev) > rank(best[key]):
            best[key] = dev
    result = list(best.values())

    # Speakers first, then anything else with a real name.
    result.sort(key=lambda d: (not d["connected"], not d["paired"], not d["audio"],
                               _is_placeholder_name(d["name"], d["mac"]),
                               d["name"].lower()))
    for dev in result:
        del dev["_last_seen"]
    return result


def status():
    if not available():
        return {"available": False, "powered": False, "connected": None}
    show = _bctl("show", timeout=10)
    connected = None
    for dev in devices():
        if dev.get("connected"):
            connected = {"mac": dev["mac"], "name": dev["name"]}
            break
    return {
        "available": True,
        "powered": "Powered: yes" in show,
        "connected": connected,
    }


def _result(text):
    low = text.lower()
    ok = any(tok in low for tok in ("successful", "changing", "already"))
    fail = text.startswith("__error__") or any(
        tok in low for tok in ("failed", "not available", "not ready")
    )
    return {"ok": ok and not fail, "output": text.strip()[-600:]}


# Speakers use "Just Works" pairing, so the agent never has a PIN to show; it
# only has to exist to answer the authentication request.
_AGENT_CAP = "NoInputNoOutput"


def _drive(steps, timeout=100):
    """Run several commands inside ONE persistent `bluetoothctl` session.

    A one-shot `bluetoothctl pair` cannot pair a speaker, for two reasons:

    * No agent. Pairing raises an authentication request, and with no agent
      registered to answer it BlueZ just rejects the attempt.
    * No discovery. BlueZ discards unpaired device objects once discovery
      stops, so the separate `pair` process would often find the device already
      gone ("not available") — the same flush that used to empty the picker.

    Each step is (command, done_tokens_or_None, seconds). A step with tokens
    finishes as soon as one appears rather than burning its whole budget.
    """
    proc = subprocess.Popen(
        ["bluetoothctl"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    lines = []

    def reader():
        try:
            for line in proc.stdout:
                lines.append(line.rstrip())
        except Exception:
            pass

    threading.Thread(target=reader, daemon=True).start()
    deadline = time.monotonic() + timeout
    try:
        for cmd, done, budget in steps:
            try:
                proc.stdin.write(cmd + "\n")
                proc.stdin.flush()
            except (BrokenPipeError, ValueError):
                break
            if not done:
                time.sleep(min(budget, max(0, deadline - time.monotonic())))
                continue
            stop = min(deadline, time.monotonic() + budget)
            while time.monotonic() < stop:
                # stdout is a pipe, so bluetoothctl may block-buffer; the final
                # state check is what decides success, this is just pacing.
                if any(tok in ln for ln in lines[-60:] for tok in done):
                    break
                time.sleep(0.25)
    finally:
        try:
            proc.stdin.write("quit\n")
            proc.stdin.flush()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    return "\n".join(lines)


def _state(mac):
    """Ground truth from `info`, rather than scraping the pairing chatter."""
    info = _bctl("info", mac, timeout=10)
    return {
        "paired": "Paired: yes" in info,
        "connected": "Connected: yes" in info,
        "info": info,
    }


def pair(mac):
    _power_on()
    log = _drive([
        # bluetoothctl prints "Waiting to connect to bluetoothd..." on startup,
        # so wait for the registration to be confirmed rather than guessing.
        (f"agent {_AGENT_CAP}", ("Agent registered",), 8),
        ("default-agent", ("Default agent request successful",), 5),
        # Discovery stays on across the pair so the device object survives.
        ("scan on", None, 3.0),
        (f"pair {mac}", ("Pairing successful", "Failed to pair",
                         "AlreadyExists", "AuthenticationFailed"), 40),
        (f"trust {mac}", None, 1.0),
        (f"connect {mac}", ("Connection successful", "Failed to connect"), 25),
        ("scan off", None, 0.5),
    ])
    st = _state(mac)
    # Already-paired devices report "Failed to pair: AlreadyExists" and then
    # connect fine, so the log alone would call that a failure. Judge on state.
    return {
        "ok": st["connected"],
        "paired": st["paired"],
        "connected": st["connected"],
        "output": _clean(log + "\n" + st["info"], mac),
    }


def connect(mac):
    _power_on()
    log = _drive([
        # bluetoothctl prints "Waiting to connect to bluetoothd..." on startup,
        # so wait for the registration to be confirmed rather than guessing.
        (f"agent {_AGENT_CAP}", ("Agent registered",), 8),
        ("default-agent", ("Default agent request successful",), 5),
        (f"trust {mac}", None, 1.0),
        (f"connect {mac}", ("Connection successful", "Failed to connect"), 25),
    ])
    st = _state(mac)
    return {
        "ok": st["connected"],
        "paired": st["paired"],
        "connected": st["connected"],
        "output": _clean(log + "\n" + st["info"], mac),
    }


def disconnect(mac):
    return _result(_bctl("disconnect", mac, timeout=15))


def remove(mac):
    return _result(_bctl("remove", mac, timeout=15))
