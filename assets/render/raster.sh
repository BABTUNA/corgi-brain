#!/usr/bin/env bash
# PNG versions of the logo for slides, forms and the demo: transparent logos, 16:9 covers, square tiles.
# Usage: bash raster.sh   (writes into ../png)
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PNG="$PWD/../png"; TMP=$(mktemp -d); mkdir -p "$PNG"
shot() { # <svg> <bg css> <w> <h> <scale> <out> <logo width %> [tagline colour]
  local tag=""; [ -n "${8:-}" ] && tag="<p style=\"color:$8\">Your org's know-how for every web app, in one place people and agents can ask.</p>"
  cat > "$TMP/p.html" <<EOF
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@500&display=swap">
<style>html,body{margin:0;background:$2}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:${3}px;height:${4}px}img{display:block;width:$7%}p{margin:0;font:500 34px Onest,sans-serif;letter-spacing:-.01em}</style></head>
<body><img src="file://$PWD/../logo/$1">$tag</body></html>
EOF
  local extra=""; [ "$2" = "transparent" ] && extra="--default-background-color=00000000"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox --allow-file-access-from-files --virtual-time-budget=5000 \
    --force-device-scale-factor="$5" $extra --window-size="$3,$4" --screenshot="$PNG/$6" "file://$TMP/p.html" >/dev/null 2>&1; echo "wrote png/$6"; }

# transparent logos
shot supabrain-mark.svg          transparent 512 512 4 supabrain-mark.png          100
shot supabrain-mark-dark.svg     transparent 512 512 4 supabrain-mark-dark.png     100
shot supabrain-wordmark.svg      transparent 1731 512 2 supabrain-wordmark.png      100
shot supabrain-wordmark-dark.svg transparent 1731 512 2 supabrain-wordmark-dark.png 100
shot supabrain-icon.svg          transparent 512 512 4 supabrain-icon.png          100
shot supabrain-icon-green.svg    transparent 512 512 4 supabrain-icon-green.png    100
# 16:9 covers, 1920x1080, with the tagline
shot supabrain-wordmark.svg          '#FFFFFF' 1920 1080 1 cover-white.png 62 '#555555'
shot supabrain-wordmark-dark.svg     '#171717' 1920 1080 1 cover-dark.png  62 '#B4B4B4'
shot supabrain-wordmark-on-green.svg '#3ECF8E' 1920 1080 1 cover-green.png 62 '#171717'
# square tiles, 1080x1080
shot supabrain-mark.svg          '#FFFFFF' 1080 1080 1 square-white.png 80
shot supabrain-mark-dark.svg     '#171717' 1080 1080 1 square-dark.png  80
shot supabrain-mark-on-green.svg '#3ECF8E' 1080 1080 1 square-green.png 80
rm -rf "$TMP"
