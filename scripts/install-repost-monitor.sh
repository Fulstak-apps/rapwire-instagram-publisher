#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
plist_dir="$HOME/Library/LaunchAgents"
log_dir="$repo_dir/logs"
plist_path="$plist_dir/com.rapwire.repost-monitor.plist"

mkdir -p "$plist_dir" "$log_dir"

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
    <string>export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; cd "$repo_dir" &amp;&amp; npm run repost:monitor</string>
  </array>
  <key>StartInterval</key>
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
echo "Installed RapWire repost monitor: $plist_path"
