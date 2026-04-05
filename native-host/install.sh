#!/usr/bin/env bash
# install.sh — Build the Swift native host and register it with Chrome / Chromium.
#
# Usage:
#   ./native-host/install.sh <EXTENSION_ID> [GROQ_API_KEY]
#
# The GROQ_API_KEY argument is optional; the host reads LANTHRA_GROQ_KEY or
# GROQ_API_KEY from its environment, which you can also set in your shell
# profile or provide via the main Lanthra.app launchd plist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/LanthraHost"
BUILD_DIR="$HOST_DIR/.build/release"
BINARY="$BUILD_DIR/LanthraHost"
MANIFEST_TEMPLATE="$SCRIPT_DIR/com.lanthra.host.json"
CHROME_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
CHROMIUM_HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
ARC_HOST_DIR="$HOME/Library/Application Support/Arc/NativeMessagingHosts"
BRAVE_HOST_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"

EXTENSION_ID="${1:-PLACEHOLDER_REPLACE_WITH_EXTENSION_ID}"

# ── 1. Build the Swift host ───────────────────────────────────────────────────

echo "→ Building LanthraHost..."
cd "$HOST_DIR"

# Create a simple Package.swift if it doesn't exist
if [ ! -f "Package.swift" ]; then
cat > Package.swift << 'EOF'
// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "LanthraHost",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "LanthraHost",
            path: ".",
            sources: ["main.swift", "GroqClient.swift", "MessageCodec.swift"]
        )
    ]
)
EOF
fi

swift build -c release
echo "✓ Built: $BINARY"

# ── 2. Write the manifest JSON ────────────────────────────────────────────────

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "com.lanthra.host",
  "description": "Lanthra native messaging host — Groq streaming bridge",
  "path": "$BINARY",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
)

# ── 3. Install for each Chromium-based browser ────────────────────────────────

install_for() {
    local dir="$1"
    local browser="$2"
    if [ -d "$(dirname "$dir")" ]; then
        mkdir -p "$dir"
        echo "$MANIFEST_CONTENT" > "$dir/com.lanthra.host.json"
        echo "✓ Installed for $browser → $dir/com.lanthra.host.json"
    else
        echo "  (skipping $browser — application not found)"
    fi
}

install_for "$CHROME_HOST_DIR"   "Chrome"
install_for "$CHROMIUM_HOST_DIR" "Chromium"
install_for "$ARC_HOST_DIR"      "Arc"
install_for "$BRAVE_HOST_DIR"    "Brave"

# ── 4. Optional: persist the API key via launchd ─────────────────────────────

if [ -n "${2:-}" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.lanthra.env.plist"
    cat > "$PLIST" << EOF2
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>       <string>com.lanthra.env</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/launchctl</string>
        <string>setenv</string>
        <string>LANTHRA_GROQ_KEY</string>
        <string>${2}</string>
    </array>
    <key>RunAtLoad</key>   <true/>
</dict>
</plist>
EOF2
    launchctl load "$PLIST" 2>/dev/null || launchctl bootout user/"$(id -u)" "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "✓ API key persisted via launchd plist: $PLIST"
fi

echo ""
echo "Installation complete."
echo "Reload the Lanthra extension in chrome://extensions and the native bridge will connect."
