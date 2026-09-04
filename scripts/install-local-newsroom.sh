#!/bin/zsh
set -euo pipefail

RAPWIRE_REPO_DIR="${RAPWIRE_REPO:-$HOME/Library/Application Support/RapWire/publisher-runtime}"
PLIST="$HOME/Library/LaunchAgents/com.rapwire247.newsroom.plist"

command -v ollama >/dev/null || { echo "Install Ollama first, then rerun."; exit 1; }
command -v git >/dev/null || { echo "git is required."; exit 1; }

[[ -d "$RAPWIRE_REPO_DIR/.git" ]] || { echo "Repository not found: $RAPWIRE_REPO_DIR"; exit 1; }
cd "$RAPWIRE_REPO_DIR"
ollama pull "${OLLAMA_MODEL:-qwen3:4b}"
chmod +x scripts/local-rapwire-autonomous.py scripts/run-local-newsroom.sh
mkdir -p "$HOME/Library/LaunchAgents"
cp launchd/com.rapwire247.newsroom.plist "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.rapwire247.newsroom"
python3 scripts/local-rapwire-autonomous.py --health

echo "RapWire autonomous newsroom installed."
echo "Runs every 5 minutes while this Mac user session is active."
echo "Logs: /tmp/rapwire247-newsroom.out.log and /tmp/rapwire247-newsroom.err.log"
