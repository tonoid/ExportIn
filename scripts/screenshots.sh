#!/usr/bin/env bash
# Render store and README screenshots from the real panel, fed with fake data.
#
# Usage:  ./scripts/screenshots.sh
# Output: docs/screenshots/*.png at 1280x800, the Chrome Web Store size.
set -euo pipefail

cd "$(dirname "$0")/.."

# chrome-headless-shell, not the full browser: the modern --headless mode never
# returns after --screenshot, so the run hangs until it is killed.
CHROME="${CHROME:-$(find "$HOME/.cache/ms-playwright" -name chrome-headless-shell -type f 2>/dev/null | head -1)}"
if [[ -z "$CHROME" || ! -x "$CHROME" ]]; then
  echo "✗ No chrome-headless-shell found. Set CHROME=/path/to/chrome-headless-shell and retry." >&2
  echo "  Playwright ships one: npx playwright install chromium" >&2
  exit 1
fi

node demo/build.mjs

OUT="docs/screenshots"
mkdir -p "$OUT"
PROFILE=$(mktemp -d)
trap 'rm -rf "$PROFILE"' EXIT

shot() { # shot <file> <query>
  timeout 60 "$CHROME" \
    --disable-gpu --no-sandbox --hide-scrollbars \
    --no-first-run --disable-background-networking --disable-sync --disable-component-update \
    --user-data-dir="$PROFILE/$1" \
    --force-device-scale-factor=1 \
    --window-size=1280,800 \
    --virtual-time-budget=4000 \
    --screenshot="$OUT/$1" \
    "file://$PWD/demo/index.html?$2" >/dev/null 2>&1 || true
  [[ -f "$OUT/$1" ]] || { echo "✗ Failed to render $1" >&2; exit 1; }
  echo "  $OUT/$1"
}

echo "English (Chrome Web Store):"
shot "01-connections.png" "state=done&lang=en"
shot "02-progress.png"    "state=running&lang=en"
shot "03-export.png"      "state=menu&lang=en"
shot "04-sync.png"        "state=sync&lang=en"
shot "06-recovery.png"    "state=stalled&lang=en"
shot "07-settings.png"    "state=settings&lang=en"
shot "05-disclaimer.png"  "state=disclaimer&lang=en"
shot "11-broken.png"      "state=broken&lang=en"
shot "08-facebook.png"    "state=done&lang=en&platform=facebook"
shot "09-facebook-progress.png" "state=running&lang=en&platform=facebook"
shot "10-instagram.png"   "state=done&lang=en&platform=instagram"

echo "Français (README_FR):"
shot "fr-01-connections.png" "state=done&lang=fr"
shot "fr-02-progress.png"    "state=running&lang=fr"
shot "fr-03-export.png"      "state=menu&lang=fr"
shot "fr-04-recovery.png"    "state=stalled&lang=fr"
shot "fr-05-settings.png"    "state=settings&lang=fr"
shot "fr-06-facebook.png"    "state=done&lang=fr&platform=facebook"
shot "fr-07-broken.png"      "state=broken&lang=fr"
shot "fr-08-instagram.png"   "state=done&lang=fr&platform=instagram"

echo "Español (README_ES):"
shot "es-01-connections.png" "state=done&lang=es"
shot "es-02-progress.png"    "state=running&lang=es"
shot "es-03-export.png"      "state=menu&lang=es"
shot "es-04-recovery.png"    "state=stalled&lang=es"
shot "es-05-settings.png"    "state=settings&lang=es"
shot "es-06-facebook.png"    "state=done&lang=es&platform=facebook"
shot "es-07-broken.png"      "state=broken&lang=es"
shot "es-08-instagram.png"   "state=done&lang=es&platform=instagram"

echo "✓ Done. Every face, name and address in these is invented."
