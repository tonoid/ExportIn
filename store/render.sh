#!/usr/bin/env bash
# Render the Chrome Web Store promo tiles from tiles.html, as 24-bit PNG with no
# alpha channel, which is what the store accepts.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-$(find "$HOME/.cache/ms-playwright" -name chrome-headless-shell -type f 2>/dev/null | head -1)}"
PROFILE=$(mktemp -d)
trap 'rm -rf "$PROFILE"' EXIT

tile() { # tile <kind> <width> <height> <file>
  timeout 60 "$CHROME" --disable-gpu --no-sandbox --hide-scrollbars --user-data-dir="$PROFILE/$1" \
    --allow-file-access-from-files --force-device-scale-factor=1 --window-size="$2,$3" \
    --virtual-time-budget=3000 --screenshot="$4" "file://$PWD/tiles.html?kind=$1" >/dev/null 2>&1 || true
  magick "$4" -background '#4e4785' -alpha remove -alpha off "PNG24:$4"
  echo "  $4"
}

tile small 440 280 promo-small-440x280.png
tile marquee 1400 560 promo-marquee-1400x560.png
