#!/bin/sh
# Builds the iPhone app headless, for the iOS simulator, signed ad hoc (no
# Apple account, no team):
#
#   scripts/build.sh               the app: build/DerivedData/Build/Products/Debug-iphonesimulator/Ravenry.app
#   scripts/build.sh test UDID     the unit tests (Tests/RavenryTests) on that simulator
#
# 1. The phone board's own screens and the app's layer (apps/phone), built
#    into build/phone, which the app carries.
# 2. The Xcode project, generated from project.yml by XcodeGen (not committed).
# 3. xcodebuild. DERIVED_DATA: Xcode's build folder (default build/DerivedData).
# For the unit tests' live cases, TEST_RUNNER_RAVENRY_TEST_HUB, _PIN and
# _TOKEN name a test hub (tools/ios-e2e.mjs sets them).
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
for tool in node xcodegen xcodebuild; do
  command -v "$tool" >/dev/null || { echo "build.sh: $tool is needed" >&2; exit 1; }
done
node "$here/../phone/build.mjs" --out "$here/build/phone" >/dev/null
(cd "$here" && xcodegen generate --quiet --spec project.yml)
dd="${DERIVED_DATA:-$here/build/DerivedData}"
if [ "$1" = "test" ]; then
  [ -n "$2" ] || { echo "build.sh test: give the simulator's UDID" >&2; exit 1; }
  xcodebuild -project "$here/Ravenry.xcodeproj" -scheme Ravenry -configuration Debug \
    -destination "id=$2" -derivedDataPath "$dd" test -quiet
else
  xcodebuild -project "$here/Ravenry.xcodeproj" -scheme Ravenry -configuration Debug \
    -sdk iphonesimulator -destination "generic/platform=iOS Simulator" -derivedDataPath "$dd" build -quiet
  echo "$dd/Build/Products/Debug-iphonesimulator/Ravenry.app"
fi
