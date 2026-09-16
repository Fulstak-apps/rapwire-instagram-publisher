#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
plist_dir="$HOME/Library/LaunchAgents"
log_dir="$repo_dir/logs"
plist_path="$plist_dir/com.rapwire.repost-monitor.plist"
awake_plist_path="$plist_dir/com.rapwire.keep-awake.plist"

mkdir -p "$plist_dir" "$log_dir"

# Keep the logged-in collector host awake without keeping its display lit.
# `-i` prevents idle sleep on AC or battery; `-s` additionally prevents system
# sleep while on AC. launchd restarts caffeinate if it exits unexpectedly.
cat > "$awake_plist_path" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rapwire.keep-awake</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>-s</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rapwire.repost-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; cd "$repo_dir" &amp;&amp; /opt/homebrew/bin/python3 scripts/repost-monitor-runner.py</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_dir/repost-monitor.out.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/repost-monitor.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$plist_path" 2>/dev/null || true
launchctl load "$plist_path"
launchctl unload "$awake_plist_path" 2>/dev/null || true
launchctl load "$awake_plist_path"
echo "Installed RapWire repost monitor: $plist_path"
echo "Installed RapWire awake guard: $awake_plist_path"
