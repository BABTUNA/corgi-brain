#!/usr/bin/env bash
# Renders the diagram pages to PNG at 2x with headless Chrome.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
shot() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox --allow-file-access-from-files --virtual-time-budget=6000 \
  --force-device-scale-factor=2 --window-size="$2" --screenshot="$PWD/$1.png" "file://$PWD/$1.html" >/dev/null 2>&1; echo "wrote $1.png"; }
shot overview 1560,760
shot architecture 1680,780
