#!/bin/sh
set -eu
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin"

if [ "$(uname -s)" != Darwin ]; then
  echo 'Skrip ini perlu dijalankan di macOS.' >&2
  exit 1
fi

repo=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
bundle="$HOME/Applications/Antigravity Kit.app"
kit="$HOME/Library/Application Support/Wallpaper-AGY-TPS"
agent="$HOME/Library/LaunchAgents/io.github.sorosjenaka.antigravity-kit.plist"
node=$(command -v node)

if [ "${1:-}" = --uninstall ]; then
  "$node" "$repo/scripts/setup.mjs" uninstall
  if [ -f "$agent" ]; then
    launchctl bootout "gui/$(id -u)" "$agent" 2>/dev/null || true
    rm -f -- "$agent"
  fi
  rm -f -- "$bundle/Contents/MacOS/start-kit" "$bundle/Contents/Info.plist" "$kit/node-path.txt"
  rmdir "$bundle/Contents/MacOS" "$bundle/Contents" "$bundle" 2>/dev/null || true
  exit
fi

login=false
if [ "${1:-}" = --start-at-login ]; then
  login=true
  shift
fi
ffmpeg=$(command -v ffmpeg)
"$node" "$repo/scripts/setup.mjs" install --ffmpeg-path "$ffmpeg" "$@"

mkdir -p "$bundle/Contents/MacOS"
cp "$repo/scripts/Info.plist" "$bundle/Contents/Info.plist"
install -m 755 "$repo/scripts/start-macos.sh" "$bundle/Contents/MacOS/start-kit"

if [ "$login" = true ]; then
  mkdir -p "$(dirname "$agent")"
  "$node" --input-type=module - "$bundle" "$agent" <<'JS'
import { writeFileSync } from 'node:fs';
const [, , bundle, agent] = process.argv;
const path = bundle.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
writeFileSync(agent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.sorosjenaka.antigravity-kit</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>${path}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`);
JS
fi

echo "Buka Antigravity Kit di $HOME/Applications."
