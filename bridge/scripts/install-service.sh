#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pi Bridge Service Installer (systemd user service)
#
# Usage:  ./install-service.sh
#
# Effect:
#   1. Builds the bridge (npm run build)
#   2. Writes ~/.config/systemd/user/pi-bridge.service
#   3. Runs systemctl --user daemon-reload
#
# After install:
#     systemctl --user start  pi-bridge     # Start now
#     systemctl --user enable pi-bridge     # Auto-start on login
#     journalctl --user -u pi-bridge -f     # Watch logs
#
# To uninstall:
#     ./scripts/uninstall-service.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Resolve paths ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/pi-bridge.service"

# ── Detect node binary ─────────────────────────────────────────────────────
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ node not found on PATH. Please install Node.js 22+."
  exit 1
fi

echo "╔══════════════════════════════════════════════════╗"
echo "║   pi Bridge — Systemd Service Installer          ║"
echo "╚══════════════════════════════════════════════════╝"
echo "  Bridge dir:  $BRIDGE_DIR"
echo "  Node binary: $NODE_BIN"
echo "  Service:     $SERVICE_FILE"
echo ""

# ── Build ──────────────────────────────────────────────────────────────────
if [ ! -d "$BRIDGE_DIR/node_modules" ]; then
  echo "→ Installing dependencies..."
  cd "$BRIDGE_DIR" && npm install
fi

echo "→ Building bridge..."
cd "$BRIDGE_DIR"
npm run build

# ── Write service unit ────────────────────────────────────────────────────
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=pi Browser Companion Bridge Service
After=network.target
Documentation=https://github.com/Youpen-y/pi-chrome-extension

[Service]
Type=simple
ExecStart=${NODE_BIN} ${BRIDGE_DIR}/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
WorkingDirectory=${BRIDGE_DIR}

[Install]
WantedBy=default.target
UNIT

echo "✓ Service unit written"
echo ""

# ── Reload systemd ────────────────────────────────────────────────────────
if command -v systemctl &>/dev/null; then
  systemctl --user daemon-reload || true
  echo "→ systemd user daemon reloaded"
  echo ""
  echo "────────────────────────────────────────────────────"
  echo "  Start now:   systemctl --user start pi-bridge"
  echo "  Auto-start:  systemctl --user enable pi-bridge"
  echo "  Status:      systemctl --user status pi-bridge"
  echo "  Logs:        journalctl --user -u pi-bridge -f"
  echo "────────────────────────────────────────────────────"
else
  echo "⚠ systemctl not found — you may not be on systemd (Linux)."
  echo "  The service file is ready at: $SERVICE_FILE"
  echo "  On macOS / Windows, use alternative process managers."
fi

echo ""
echo "✓ Done."
