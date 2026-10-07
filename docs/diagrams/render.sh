#!/usr/bin/env bash
# Renders architecture.html to architecture.png at 2x with headless Chrome.
set -euo pipefail
cd "$(dirname "$0")"
"${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" --headless=new --disable-gpu --hide-scrollbars --no-sandbox --virtual-time-budget=6000 \
  --force-device-scale-factor=2 --window-size=1680,780 --screenshot="$PWD/architecture.png" "file://$PWD/architecture.html" >/dev/null 2>&1
echo "wrote architecture.png"
