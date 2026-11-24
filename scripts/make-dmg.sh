#!/bin/bash
# Build a distributable DMG from the packaged app, using only macOS tooling
# (hdiutil) — no network access, no downloaded helper bundles.
#
#   1. npm run build                      (renderer + main bundles)
#   2. npx electron-builder --mac --dir   (packs Meridiem.app, applies the
#                                          electron-builder.yml file filters)
#   3. scripts/make-dmg.sh                (this script → dist/Meridiem-<ver>.dmg)
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/mac-arm64/Meridiem.app"
[ -d "$APP" ] || APP="dist/mac/Meridiem.app"
[ -d "$APP" ] || { echo "No packaged app in dist/ — run ./scripts/package.sh first"; exit 1; }

VERSION=$(node -p "require('./package.json').version")

# Trim Chromium's locale resources to English (the UI is English): ~40 MB off
# the download. electron-builder's electronLanguages option needs a network
# round-trip, this does not.
for loc in "$APP/Contents/Resources"/*.lproj; do
  case "$(basename "$loc")" in
    en.lproj|en_GB.lproj|Base.lproj) ;;
    *) rm -rf "$loc" ;;
  esac
done
NAME="Meridiem"
VOL="$NAME $VERSION"
STAGE="dist/dmg-stage"
DMG="dist/$NAME-$VERSION-arm64.dmg"

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "$VOL" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  -fs HFS+ \
  "$DMG" >/dev/null

rm -rf "$STAGE"
echo "built $DMG ($(du -h "$DMG" | cut -f1))"
