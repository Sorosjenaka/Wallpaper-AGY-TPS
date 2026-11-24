#!/bin/sh
set -eu
export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
kit="$HOME/Library/Application Support/Wallpaper-AGY-TPS"
IFS= read -r node < "$kit/node-path.txt"
if [ ! -x "$node" ]; then node=$(command -v node); fi
export PATH="$(dirname "$node"):$PATH"
exec "$node" "$kit/launcher/launch.mjs"
