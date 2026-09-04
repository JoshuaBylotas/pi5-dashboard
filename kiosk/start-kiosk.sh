#!/usr/bin/env bash
# Launch the dashboard fullscreen in Chromium kiosk mode.
# Waits for the backend, then opens it as an app window. Closing Chromium
# (or the in-app "Close" button) drops back to the desktop.
set -u

URL="http://127.0.0.1:8080"
PROFILE="$HOME/.config/pi5-dashboard/chromium"
mkdir -p "$PROFILE"

# Locate the Chromium binary (name varies across Raspberry Pi OS releases).
CHROME=""
for c in chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
  echo "Chromium not found. Install with: sudo apt install -y chromium" >&2
  exit 1
fi

# Wait for the backend to answer (up to ~30s).
for _ in $(seq 1 60); do
  if curl -fsS "$URL/api/system/info" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

# Suppress the "restore pages / didn't shut down correctly" bubble.
PREF="$PROFILE/Default/Preferences"
if [ -f "$PREF" ]; then
  sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$PREF" 2>/dev/null || true
fi

# Use Wayland ozone backend when in a Wayland session (labwc/wayfire on Pi 5).
#
# Do NOT just trust an inherited WAYLAND_DISPLAY. When the backend re-execs this
# script (the YouTube sign-in flow does exactly that), the environment comes from
# the systemd *user* service, which never inherited the compositor's variables.
# The conditional then silently fell through to X11, there is no X server, and
# Chromium died on launch — the dashboard just never came back. So recover the
# socket from XDG_RUNTIME_DIR before deciding.
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  for _sock in "$XDG_RUNTIME_DIR"/wayland-[0-9]*; do
    # The glob also matches wayland-N.lock, which is a regular file, not a socket.
    if [ -S "$_sock" ]; then
      WAYLAND_DISPLAY="$(basename "$_sock")"
      export WAYLAND_DISPLAY
      break
    fi
  done
fi

OZONE=()
if [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  OZONE=(--ozone-platform=wayland)
fi

# Hide the mouse cursor when idle, if unclutter is available.
command -v unclutter >/dev/null 2>&1 && unclutter -idle 3 &

# The TV/leanback app is no longer used: it always boots through an account
# picker and paints over the injected rail once a video goes fullscreen, leaving
# no way back. Playback now happens in the dashboard's own IFrame embed.
#
# Consequently the TV-class user-agent is GONE. Keeping it actively hurt: the
# embed player refuses some videos for a TV client (a live lofi stream failed
# while another station played, with both perfectly healthy per oEmbed). Default
# UA it is -- which also makes music.youtube.com render normally if ever needed.

exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --password-store=basic \
  --touch-events=enabled \
  --enable-features=TouchpadAndWheelScrollLatching \
  "$URL" \
  --kiosk \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate,TranslateUI,WebRtcPipeWireCamera \
  --no-first-run \
  --fast --fast-start \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  "${OZONE[@]}" \
  "$@"    # extra flags pass through, e.g. --remote-debugging-port=9222
