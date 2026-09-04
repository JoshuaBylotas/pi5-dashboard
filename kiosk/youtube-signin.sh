#!/usr/bin/env bash
# One-time YouTube account link.
#
# Chromium's user-agent is fixed per browser process, and the QR/code sign-in
# screen is only served to a TV-class user-agent. So we can't do this inside the
# running kiosk: we briefly close it, reopen the SAME profile with a TV
# user-agent, let the user link their phone, then restore the dashboard. Using
# the same profile is the whole point — the auth cookies have to land where the
# dashboard's player will read them.
#
# The UA must NOT contain "CrKey": that marks the client as a Chromecast, and
# youtube.com/tv then serves the cast-receiver page ("Ready to cast"), which has
# no sign-in and no way to navigate off it. "Large Screen" gets the TV UI, whose
# splash is one Enter away from the code (see tv-advance.py).
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="$HOME/.config/pi5-dashboard/chromium"
PAIR_URL="https://www.youtube.com/tv"
TV_UA="Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) \
Chrome/125.0.0.0 Safari/537.36 Large Screen Safari/537.36"
CDP_PORT=9222
VENV_PY="$HOME/pi5-dashboard/.venv/bin/python"

# Hard ceiling so a failed/abandoned sign-in can never strand the user away
# from the dashboard.
MAX_SECONDS="${PI5_SIGNIN_TIMEOUT:-900}"

CHROME=""
for c in chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
  echo "Chromium not found" >&2
  exit 1
fi

# Let the HTTP response that triggered us flush before we kill its browser.
sleep 1

# -x so the pattern can't match this script's own command line.
pkill -x chromium
sleep 3

# Skip the "Get started" splash so the code is on screen unattended. The debug
# port is bound to localhost and only for as long as this window lives; it is
# how the Enter key gets delivered (no wtype/ydotool on this Pi).
( "$VENV_PY" "$DIR/tv-advance.py" "$CDP_PORT" >>/tmp/pi5-tv-signin.log 2>&1 & )

# Deliberately NOT --kiosk and NOT --app: a normal window gets a title bar from
# labwc, giving a touch-tappable close button when the linking is done.
timeout "$MAX_SECONDS" "$CHROME" \
  --user-data-dir="$PROFILE" \
  --password-store=basic \
  --touch-events=enabled \
  --no-first-run \
  --ozone-platform=wayland \
  --user-agent="$TV_UA" \
  --window-size=1024,560 \
  --window-position=0,0 \
  --remote-debugging-port="$CDP_PORT" \
  --disable-features=Translate,TranslateUI,WebRtcPipeWireCamera \
  "$PAIR_URL" >/dev/null 2>&1

# Whether they closed it or the timeout fired, put the dashboard back.
sleep 2
pkill -x chromium
sleep 2
exec "$DIR/start-kiosk.sh"
