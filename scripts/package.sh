#!/bin/bash
# Build the app bundle (no DMG), applying the trims in electron-builder.yml.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
npx electron-builder --mac --dir --arm64
echo "packaged dist/mac-arm64/Meridiem.app ($(du -sh dist/mac-arm64/Meridiem.app | cut -f1))"
