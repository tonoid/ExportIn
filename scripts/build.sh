#!/usr/bin/env bash
# Build a Chrome Web Store-ready zip of the extension.
#
# Usage:  ./scripts/build.sh
# Output: build/exportin-<version>.zip
#
# Note: the unpacked extension lives in dist/, so the zip lands in build/ to
# keep the two apart. Chrome needs manifest.json at the root of the archive,
# hence the zip is made from inside dist/.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v zip >/dev/null 2>&1; then
  echo "✗ 'zip' is not installed. On macOS it ships with the OS; on Linux: apt install zip" >&2
  exit 1
fi

node -e "JSON.parse(require('fs').readFileSync('dist/manifest.json','utf8'))" \
  || { echo "✗ dist/manifest.json is not valid JSON" >&2; exit 1; }

VERSION=$(node -p "require('./dist/manifest.json').version")
[[ -n "$VERSION" ]] || { echo "✗ Could not read version from dist/manifest.json" >&2; exit 1; }

while IFS= read -r -d '' f; do
  node --check "$f" >/dev/null || { echo "✗ Syntax error in $f" >&2; exit 1; }
done < <(find dist -name "*.js" -print0)

node test.mjs || { echo "✗ Tests failed" >&2; exit 1; }

mkdir -p build
ZIP="$PWD/build/exportin-${VERSION}.zip"
rm -f "$ZIP"

( cd dist && zip -rq "$ZIP" . -x "**/.DS_Store" -x "**/*.map" )

SIZE=$(du -h "$ZIP" | awk '{print $1}')
COUNT=$(unzip -l "$ZIP" | tail -1 | awk '{print $2}')

echo "✓ Built build/exportin-${VERSION}.zip ($SIZE, $COUNT files)"
echo "  Upload at: https://chrome.google.com/webstore/devconsole"
