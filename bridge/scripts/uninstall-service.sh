#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pi Bridge Service Uninstaller
# Usage:  ./scripts/uninstall-service.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/pi-bridge.service"

echo "╔══════════════════════════════════════════╗"
echo "║   pi Bridge — Systemd Service Uninstaller ║"
echo "╚══════════════════════════════════════════╝"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "Service file not found: $SERVICE_FILE"
  echo "(Nothing to uninstall.)"
  exit 0
fi

if command -v systemctl &>/dev/null; then
  echo "→ Stopping service..."
  systemctl --user stop pi-bridge 2>/dev/null || true
  echo "→ Disabling service..."
  systemctl --user disable pi-bridge 2>/dev/null || true
fi

echo "→ Removing service file..."
rm -f "$SERVICE_FILE"

if command -v systemctl &>/dev/null; then
  systemctl --user daemon-reload 2>/dev/null || true
fi

echo "✓ Service uninstalled."
