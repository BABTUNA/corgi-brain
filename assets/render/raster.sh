#!/usr/bin/env bash
# PNG versions of the logo for slides, forms and the demo: transparent logos, 16:9 covers, square tiles.
# Usage: bash raster.sh   (writes into ../png)
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PNG="$PWD/../png"; TMP=$(mktemp -d); mkdir -p "$PNG"
shot() { # <svg> <bg css> <w> <h> <scale> <out> <logo width %> [tagline colour]
  local tag=""; [ -n "${8:-}" ] && tag="<p style=\"color:$8\">Your team's know-how for every web app, kept current by an agent.</p>"
  cat > "$TMP/p.html" <<EOF
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@500&display=swap">
<style>html,body{margin:0;background:$2}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:${3}px;height:${4}px}img{display:block;width:$7%}p{margin:0;font:500 34px Onest,sans-serif;letter-spacing:-.01em}</style></head>
<body><img src="file://$PWD/../logo/$1">$tag</body></html>
EOF
  local extra=""; [ "$2" = "transparent" ] && extra="--default-background-color=00000000"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox --allow-file-access-from-files --virtual-time-budget=5000 \
    --force-device-scale-factor="$5" $extra --window-size="$3,$4" --screenshot="$PNG/$6" "file://$TMP/p.html" >/dev/null 2>&1; echo "wrote png/$6"; }

# transparent logos
shot corgibrain-mark.svg          transparent 512 512 4 corgibrain-mark.png          100
shot corgibrain-mark-dark.svg     transparent 512 512 4 corgibrain-mark-dark.png     100
shot corgibrain-wordmark.svg      transparent 1360 512 2 corgibrain-wordmark.png      100
shot corgibrain-wordmark-dark.svg transparent 1360 512 2 corgibrain-wordmark-dark.png 100
shot corgibrain-icon.svg          transparent 512 512 4 corgibrain-icon.png          100
shot corgibrain-icon-fawn.svg    transparent 512 512 4 corgibrain-icon-fawn.png    100
# 16:9 covers, 1920x1080, with the tagline
shot corgibrain-wordmark.svg          '#FFFFFF' 1920 1080 1 cover-white.png 62 '#6E665E'
shot corgibrain-wordmark-dark.svg     '#1E1B18' 1920 1080 1 cover-dark.png  62 '#B9AFA4'
shot corgibrain-wordmark-on-fawn.svg '#E8873A' 1920 1080 1 cover-fawn.png 62 '#1E1B18'
# square tiles, 1080x1080
shot corgibrain-mark.svg          '#FFFFFF' 1080 1080 1 square-white.png 80
shot corgibrain-mark-dark.svg     '#1E1B18' 1080 1080 1 square-dark.png  80
shot corgibrain-mark-on-fawn.svg '#E8873A' 1080 1080 1 square-fawn.png 80
rm -rf "$TMP"
