#!/usr/bin/env bash
# Rebuild dist/icons/*.png from icon.svg.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist/icons
for size in 16 32 48 128; do
  magick -background none -density 384 icon.svg -resize "${size}x${size}" -depth 8 -strip "dist/icons/${size}.png"
done
echo "wrote dist/icons/{16,32,48,128}.png"
