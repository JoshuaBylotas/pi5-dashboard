#!/usr/bin/env bash
# One-time interactive Google sign-in for the kiosk's Chromium profile.
#
# Why this exists: the earlier QR/TV pairing flow (youtube-signin.sh) deposits NO
# Google cookies -- only leanback localStorage tokens -- so it can authenticate
# neither the IFrame embed player, nor music.youtube.com, nor ytmusicapi. A normal
# username/password sign-in is the only thing that writes real
# SID/SAPISID/LOGIN_INFO cookies, and it has to happen in THIS profile because
# that is where the dashboard's player reads them from.
#
# There is no physical keyboard on this Pi (only the touch panel), so squeekboard
# is started alongside. Chromium does not ask the compositor for an input method
# unless --enable-wayland-ime is set, so tapping a field would otherwise focus it
# and pop up nothing at all.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="$HOME/.config/pi5-dashboard/chromium"
URL="${PI5_SIGNIN_URL:-https://accounts.google.com/}"

# Generous, because typing a password and clearing 2FA on a touchscreen is slow.
# Still bounded so an abandoned sign-in can never strand the user off-dashboard.
MAX_SECONDS="${PI5_SIGNIN_TIMEOUT:-1800}"

# This may be launched from the backend, i.e. from the systemd *user* service,
# whose environment never inherited the compositor's variables. Same trap that
# made the dashboard fail to come back on 2026-08-08.
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  for _sock in "$XDG_RUNTIME_DIR"/wayland-[0-9]*; do
    if [ -S "$_sock" ]; then
      WAYLAND_DISPLAY="$(basename "$_sock")"
      export WAYLAND_DISPLAY
      break
    fi
  done
fi

CHROME=""
for c in chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
  echo "Chromium not found" >&2
  exit 1
fi

# Let the HTTP response that triggered us flush before killing its browser.
sleep 1
pkill -x chromium
sleep 3

pkill -x squeekboard 2>/dev/null || true
sleep 1
setsid nohup squeekboard >/tmp/pi5-squeekboard.log 2>&1 </dev/null &
sleep 2

# Deliberately NOT --kiosk: a labwc titlebar gives a tappable close button, which
# is how the user signals they are done. Default user-agent on purpose -- Google
# rejects sign-in from unusual UAs, and the TV UA that used to be set here is
# exactly the kind it refuses.
timeout "$MAX_SECONDS" "$CHROME" \
  --user-data-dir="$PROFILE" \
  --password-store=basic \
  --touch-events=enabled \
  --ozone-platform=wayland \
  --enable-wayland-ime \
  --wayland-text-input-version=3 \
  --no-first-run \
  --window-size=1024,560 \
  --window-position=0,0 \
  --disable-features=Translate,TranslateUI,WebRtcPipeWireCamera \
  "$URL" >/dev/null 2>&1

# Whether they closed it or the timeout fired, put the dashboard back.
sleep 2
pkill -x squeekboard 2>/dev/null || true
pkill -x chromium
sleep 2
exec "$DIR/start-kiosk.sh"
