#!/usr/bin/env bash
# Renders the Supa Brain PNGs from assets/render/*.html with headless Chrome.
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"; ASSETS="$(dirname "$R")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
B="$ASSETS/banner"; I="$ASSETS/icons"
mkdir -p "$B" "$I"
shot() { local file=$1 out=$2 w=$3 h=$4 bg=${5:-} scale=${6:-2}; local extra=""; [ "$bg" = "transparent" ] && extra="--default-background-color=00000000"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox --allow-file-access-from-files --virtual-time-budget=6000 --force-device-scale-factor=$scale $extra --window-size="$w,$h" --screenshot="$out" "file://$R/$file" >/dev/null 2>&1; echo "wrote $out"; }
W=$(node -e "console.log(Math.round(JSON.parse(require('fs').readFileSync('$R/wordmark-geom.json')).totalW/2))")
shot banner.html       "$B/readme-banner.png"       1280 640
shot banner-dark.html  "$B/readme-banner-dark.png"  1280 640
shot wordmark.html       "$B/corgibrain-wordmark.png"       $W 256 transparent
shot wordmark-dark.html  "$B/corgibrain-wordmark-dark.png"  $W 256 transparent
shot wordmark.html       "$B/corgibrain-wordmark@4x.png"    $W 256 transparent 4
shot icon.html "$I/icon-512.png" 512 512 transparent 1
for s in 256 128 48 32 16; do sips -s format png -z $s $s "$I/icon-512.png" --out "$I/icon-$s.png" >/dev/null && echo "wrote $I/icon-$s.png"; done
shot sheet.html "$B/logo-sheet.png" 1600 1180 "" 1
