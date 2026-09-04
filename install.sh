#!/usr/bin/env bash
# Installer for the Pi5 Dashboard. Idempotent — safe to re-run.
#   - installs system packages (chromium, python venv, bluez, unclutter)
#   - creates a Python venv and installs Flask
#   - installs a systemd *user* service for the backend
#   - wires the Chromium kiosk into desktop autostart (labwc / wayfire / X11)
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"
echo "==> Installing Pi5 Dashboard from: $INSTALL_DIR (user: $USER_NAME)"

# 1. System packages --------------------------------------------------------
echo "==> Installing system packages (sudo)…"
sudo apt-get update
sudo apt-get install -y \
  python3 python3-venv python3-pip \
  chromium curl unclutter \
  bluez pipewire-pulse libspa-0.2-bluetooth || \
  sudo apt-get install -y python3 python3-venv python3-pip chromium-browser curl unclutter bluez

# 2. Python venv ------------------------------------------------------------
echo "==> Creating virtualenv…"
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/.venv/bin/pip" install -r "$INSTALL_DIR/backend/requirements.txt"

# 3. Make scripts executable ------------------------------------------------
chmod +x "$INSTALL_DIR/kiosk/start-kiosk.sh"

# 4. Backend systemd user service ------------------------------------------
echo "==> Installing backend service…"
mkdir -p "$HOME/.config/systemd/user"
sed "s#__INSTALL_DIR__#$INSTALL_DIR#g" \
  "$INSTALL_DIR/kiosk/pi5-dashboard.service" \
  > "$HOME/.config/systemd/user/pi5-dashboard.service"

# Let the user service start at boot without an interactive login.
sudo loginctl enable-linger "$USER_NAME" || true
systemctl --user daemon-reload
systemctl --user enable --now pi5-dashboard.service

# 5. Kiosk autostart --------------------------------------------------------
KIOSK="$INSTALL_DIR/kiosk/start-kiosk.sh"
echo "==> Configuring kiosk autostart…"

add_line_once() {  # file, line
  local file="$1" line="$2"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  grep -qF "$line" "$file" || echo "$line" >> "$file"
}

configured=0
# labwc (default on Raspberry Pi OS "Trixie" / Pi 5)
if command -v labwc >/dev/null 2>&1 || [ -d "$HOME/.config/labwc" ]; then
  add_line_once "$HOME/.config/labwc/autostart" "$KIOSK &"
  echo "   - labwc autostart configured"
  configured=1
fi
# wayfire (Raspberry Pi OS "Bookworm" / Pi 4-5)
if [ -f "$HOME/.config/wayfire.ini" ] || command -v wayfire >/dev/null 2>&1; then
  if ! grep -q "pi5dashboard" "$HOME/.config/wayfire.ini" 2>/dev/null; then
    mkdir -p "$HOME/.config"
    if grep -q "^\[autostart\]" "$HOME/.config/wayfire.ini" 2>/dev/null; then
      sed -i "/^\[autostart\]/a pi5dashboard = $KIOSK" "$HOME/.config/wayfire.ini"
    else
      printf "\n[autostart]\npi5dashboard = %s\n" "$KIOSK" >> "$HOME/.config/wayfire.ini"
    fi
  fi
  echo "   - wayfire autostart configured"
  configured=1
fi
# Freedesktop XDG autostart (X11 / LXDE fallback)
DESKTOP="$HOME/.config/autostart/pi5-dashboard.desktop"
mkdir -p "$HOME/.config/autostart"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Pi5 Dashboard
Exec=$KIOSK
X-GNOME-Autostart-enabled=true
EOF
echo "   - XDG autostart entry written ($DESKTOP)"

echo
echo "==> Done."
echo "    Backend:   systemctl --user status pi5-dashboard"
echo "    Open now:  $KIOSK"
echo "    Reboot to start the dashboard automatically."
