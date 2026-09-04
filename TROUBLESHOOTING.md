# Troubleshooting

Failures that cost real time building this, and what actually fixed them. Most
will recur on any fresh Raspberry Pi OS Chromium-kiosk build.

## Chromium shows a pure white window and never loads

GNOME Keyring blocks Chromium *before any network I/O*. A modal "Choose password
for new keyring" appears offscreen and unanswered: no HTTP request ever reaches
the server, navigation never returns, and there are **zero console errors**.

```
--password-store=basic
```

Diagnose this class of fault by screenshotting the framebuffer (`grim`), not by
reading logs — there is nothing in the logs.

## UI icons render as empty boxes

No emoji font ships by default on Debian 13 / Pi OS.

```bash
sudo apt install fonts-noto-color-emoji
```

## Taps work but drag-to-scroll does nothing

The touch panel delivers real finger input as emulated **pointer** events, not
`wl_touch`, so native touch panning never engages — which is why
`--touch-events=enabled` plus `touch-action: pan-y` looks like the right fix and
isn't (a *synthetic* touch swipe scrolls fine, masking the problem).

`frontend/js/dragscroll.js` drives `scrollTop` from Pointer Events with a
momentum glide, with `#content` set to `touch-action: none`.

## "This button does nothing"

Suspect `dragscroll.js` first. An 8px drag threshold is smaller than a finger's
drift on a small button, and a drag deliberately swallows the click — so buttons
look dead while scrolling works fine. Presses that start on a control
(`button, a, input, select, textarea, label, [role=button], [data-act]`) now get
a 26px threshold, and the click is only swallowed if `scrollTop` actually moved.

## A Bluetooth speaker vanishes from the picker while you're looking at it

BlueZ flushes discovered-but-unpaired devices as soon as discovery stops.
`backend/bluetooth.py` keeps its own 15-minute cache of what it has seen.

The cache then fills with junk, because unnamed BLE beacons use privacy
addresses that rotate every few minutes — every phone, watch and tag re-enters
under a fresh MAC. `devices()` drops placeholder-named entries unless they are
already bonded, then keeps one row per name ranked
connected > paired > audio > most-recently-seen.

## Pairing always fails

One-shot `bluetoothctl pair <mac>` fails twice over: no agent is registered to
answer the authentication request, and discovery has usually stopped, so BlueZ
has already discarded the device object.

`_drive()` feeds `agent NoInputNoOutput` / `default-agent` / `scan on` / `pair` /
`trust` / `connect` into **one** session with discovery still running, and judges
success from `info <mac>` reporting `Connected: yes` rather than from the log —
an already-paired speaker prints `Failed to pair: AlreadyExists` and then
connects fine, which log-scraping calls a failure.

## A soundbar that "isn't discoverable"

Samsung soundbars distinguish `BT` from `BT PAIRING` on the front display.
Pressing Source until it reads `BT` only enables reconnect-to-known-devices — the
bar is **not** discoverable in that state and answers no classic inquiry. Press
and *hold* Source until it reads `BT PAIRING`.

Beware the decoy: the bar constantly broadcasts a SmartThings BLE beacon under a
model-ish name whether or not it is discoverable. It is not an A2DP sink,
pairing to it can never give audio, and it flickers between scans (which reads
as a picker bug). The real A2DP endpoint is a *classic* address that only
appears during the pairing window.

Discoverability is a ~2-minute window by design and cannot be pinned on — but it
is only needed **once**, to form the bond. After that the Pi is the initiator and
`connect <mac>` works indefinitely.

## Bluetooth connects but there is no sound

Check the volume before believing anything is broken — the sink can come up at
9%, which sounds exactly like "Bluetooth doesn't work".

```bash
wpctl get-volume @DEFAULT_AUDIO_SINK@
```

Also: a speaker takes one sink at a time, so a phone that auto-reconnects locks
the Pi out.

## Every paired device suddenly reads as unpaired

`bluetoothctl paired-devices` **no longer exists in BlueZ 5.82** — it answers
`Invalid command in menu main`, and parsing that error text yields an empty set.
`_paired_raw()` tries `devices Paired` first and falls back.

General lesson: this module scrapes a CLI, so an *empty result can mean the
command was rejected*. Check for `Invalid command` explicitly.

## The kiosk "never comes back" after a script relaunches it

`start-kiosk.sh` must not trust an inherited `WAYLAND_DISPLAY`. That variable is
set when the compositor's autostart launches the kiosk, but **any script the
backend launches gets the systemd *user* environment**, which never inherited
the compositor's variables — so the launcher silently falls through to X11,
finds no X server, and dies with `The platform failed to initialize. Exiting.`

The script now recovers the socket by globbing `$XDG_RUNTIME_DIR/wayland-[0-9]*`
and testing `-S` (the glob also matches `wayland-0.lock`, a regular file).

Anything graphical spawned from the backend — or from an SSH session — must
supply its own environment:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u) WAYLAND_DISPLAY=wayland-0
```

## `pkill -f chromium` kills your shell

It matches its own command line, so "kill then relaunch" one-liners silently
never relaunch. Use `pkill -x chromium`.

## A station's video won't play, but its title is correct

Live-stream ids go stale and **oEmbed will not tell you**. When a 24/7 broadcast
ends the id survives — oEmbed still returns 200 with the right title — but the
player refuses it with *"This live stream recording is not available"*. Only
playing it and watching `video.currentTime` advance is a real test.

Remember that stored settings in `~/.config/pi5-dashboard/settings.json` shadow
`DEFAULT_SETTINGS`, so replacing a dead id in code fixes nothing on a Pi that has
already saved its settings.

## No backend logs

`journalctl --user -u pi5-dashboard` reports "No journal files were found", so
server-side debugging is blind. Diagnose from the browser over CDP
(`kiosk/start-kiosk.sh --remote-debugging-port=9222` — the launcher ends in `"$@"`
so ad-hoc flags reach Chromium), or add a log file first.

### CDP gotchas

- `websocket-client` needs `suppress_origin=True`, or Chromium rejects the
  handshake with `403 Rejected an incoming WebSocket connection from the
  http://127.0.0.1:9222 origin`.
- Test drags with `Input.dispatchMouseEvent`, **not** `dispatchTouchEvent` —
  only the mouse path reproduces what the panel actually sends.
- Re-measure a button's box before *every* simulated gesture; an action
  re-renders the list and cached coordinates stop pointing at a button.
- Test scrolling on **Settings**. Home has nothing to scroll, so any drag test
  there passes vacuously.
- Never navigate to `/embed/…` top-level to test embedding — it always fails
  with *Error 153, video player configuration error*. It must be inside an
  iframe with a real parent origin.
- The embed iframe keeps its bare `/embed/?…` URL forever (the IFrame API swaps
  videos in place), so matching `/embed/([\w-]{11})` never finds the player
  frame. Match `youtube.com/embed/` and read `<video>.currentTime` in that
  out-of-process frame. The idle player is also an `/embed/` frame with no video
  loaded, so attaching to the first match can measure the wrong thing.

## Signed-in YouTube: don't

Two dead ends, both fully explored:

- **Phone/QR (TV) pairing deposits no Google session cookies.** The credential
  lands in `localStorage` as `yt.leanback.default::cached-access-tokens`, scoped
  to the leanback app. There is no `SID`/`SAPISID`/`LOGIN_INFO` and no
  `.google.com` cookie at all, so QR pairing can never authenticate an
  IFrame-embed player.
- **Framing the TV app.** `x-frame-options: SAMEORIGIN` is strippable with a
  `declarativeNetRequest` extension, but framed, youtube.com is third-party:
  `localStorage` throws `SecurityError`, cookies are empty, and leanback hangs
  on its splash.

The leanback app was also tried as its own top-level page and **removed**: it
always boots through an account picker (its own flow, not suppressible), and a
fullscreen video paints over any injected navigation rail, leaving no way back
to the dashboard.

There is **no public API for YouTube Music** — no home feed, no library, no
mixes — and the Data API has never exposed YouTube's recommended feed. YTM
playlists are ordinary YouTube playlists underneath, so they list fine, **but
only public ones**. Listing or embedding private playlists needs a normal
interactive Google sign-in in the kiosk profile, which needs a keyboard on the
Pi.
