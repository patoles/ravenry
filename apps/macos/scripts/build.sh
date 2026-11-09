#!/bin/sh
# Builds the native Mac app, signed ad hoc for local runs (no keychain, no
# developer account):
#
#   scripts/build.sh [OUT_DIR]      default OUT_DIR: apps/macos/build
#
# 1. ravenryd from daemon/, which goes in the app beside its executable:
#    the app asks it which daemons run (`ravenryd daemons`), and
#    open-native.sh can start one from it.
# 2. The Xcode project, generated from project.yml by XcodeGen.
# 3. xcodebuild, Release, signed ad hoc.
#
# The Metal shaders are compiled when the app starts, so the build needs
# no Metal Toolchain.
#
# Prints the path of the .app.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
out=${1:-$here/build}
mkdir -p "$out" "$here/build"

for tool in xcodegen xcodebuild go; do
  command -v "$tool" >/dev/null 2>&1 || { echo "build.sh: $tool is not on PATH" >&2; exit 1; }
done

RAVENRYD_BIN="$here/build/ravenryd"
export RAVENRYD_BIN
echo "build.sh: ravenryd" >&2
# CGO_CPPFLAGS names the libghostty-vt build (its folder, named after its
# patches): Go's build cache does not see a rebuilt library otherwise.
(cd "$repo/daemon" && pc=$(scripts/libghostty.sh) && \
  PKG_CONFIG_PATH=$pc CGO_CPPFLAGS="${CGO_CPPFLAGS:-} -DRAVENRY_LIBGHOSTTY=$(basename "$(dirname "$(dirname "$pc")")")" \
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
