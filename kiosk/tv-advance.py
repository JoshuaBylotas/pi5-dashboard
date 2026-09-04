#!/usr/bin/env python3
"""Advance the YouTube TV app from its onboarding screen to the pairing code.

youtube.com/tv opens on a "Get started" splash; the QR code and activation code
are one Enter press further in. The TV app is keyboard-driven and no Wayland
key-injection tool is installed on this Pi, so the press is delivered over CDP.

Exits quietly on any failure -- the user can always press Enter themselves, so
this must never be the reason sign-in is unavailable.
"""
import json
import sys
import time
import urllib.request

try:
    import websocket
except ImportError:
    sys.exit(0)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9222
DEADLINE = time.time() + 45


def page_socket():
    """Wait for a page target to exist, then return a CDP connection to it."""
    while time.time() < DEADLINE:
        try:
            targets = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{PORT}/json", timeout=3))
            page = next((t for t in targets if t.get("type") == "page"), None)
            if page:
                # suppress_origin: Chromium 403s the handshake if Origin is set.
                return websocket.create_connection(
                    page["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
        except Exception:
            pass
        time.sleep(1)
    return None


ws = page_socket()
if ws is None:
    sys.exit(0)

_id = [0]


def call(method, **params):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            return msg


def js(expr):
    r = call("Runtime.evaluate", expression=expr, returnByValue=True)
    return r.get("result", {}).get("result", {}).get("value")


def body_text():
    return (js("document.body ? document.body.innerText : ''") or "")

# Wait for the splash to render. If the profile is already signed in, or the
# code screen came up on its own, there is nothing to advance past.
while time.time() < DEADLINE:
    text = body_text()
    if "activate" in text or "Enter the code" in text:
        sys.exit(0)
    if "Get started" in text:
        break
    time.sleep(1)
else:
    sys.exit(0)

for event in ("keyDown", "keyUp"):
    call("Input.dispatchKeyEvent", type=event, key="Enter", code="Enter",
         windowsVirtualKeyCode=13, nativeVirtualKeyCode=13)

# Confirm the code screen actually appeared, so a silent failure is visible in
# the log rather than looking like success.
for _ in range(12):
    time.sleep(1)
    if "activate" in body_text():
        print("tv-advance: pairing code screen reached")
        break
else:
    print("tv-advance: Enter sent but no code screen; press Enter on the panel")

ws.close()
