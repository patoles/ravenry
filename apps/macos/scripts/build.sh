#!/bin/sh
# Builds the native Mac app, signed ad hoc for local runs (no keychain, no
# developer account):
#
#   scripts/build.sh [OUT_DIR]      default OUT_DIR: apps/macos/build
#
# 1. GhosttyKit.xcframework (scripts/ghosttykit.sh, the repository's one
#    Ghostty pin).
# 2. ravenryd from daemon/, which goes in the app beside its executable:
#    the window runs `ravenryd attach` as its terminal's command.
# 3. The Xcode project, generated from project.yml by XcodeGen.
# 4. xcodebuild, Release, signed ad hoc.
#
# Prints the path of the .app.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
out=${1:-$here/build}
mkdir -p "$out" "$here/build"

for tool in xcodegen xcodebuild go zig; do
  command -v "$tool" >/dev/null 2>&1 || { echo "build.sh: $tool is not on PATH" >&2; exit 1; }
done

GHOSTTYKIT=$("$here/scripts/ghosttykit.sh")
export GHOSTTYKIT

RAVENRYD_BIN="$here/build/ravenryd"
export RAVENRYD_BIN
echo "build.sh: ravenryd" >&2
(cd "$repo/daemon" && PKG_CONFIG_PATH=$(scripts/libghostty.sh) \
  go build -o "$RAVENRYD_BIN" ./cmd/ravenryd)

echo "build.sh: Xcode project" >&2
(cd "$here" && xcodegen generate --quiet --spec project.yml)

echo "build.sh: xcodebuild" >&2
xcodebuild -project "$here/RavenryMac.xcodeproj" -scheme RavenryMac \
  -configuration Release -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "$here/build/DerivedData" \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
  RAVENRYD_BIN="$RAVENRYD_BIN" \
  -quiet build >&2

app="$here/build/DerivedData/Build/Products/Release/RavenryMac.app"
codesign --verify --deep --strict "$app" >&2
rm -rf "$out/RavenryMac.app"
cp -R "$app" "$out/RavenryMac.app"
echo "$out/RavenryMac.app"
