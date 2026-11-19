#!/bin/sh
# Builds the iPhone and iPad app for the App Store: an archive (Xcode's
# automatic signing, Apple Development), exported as an .ipa signed for App
# Store Connect (Apple Distribution), and uploaded when asked.
# scripts/build.sh (the simulator, signed ad hoc) is unchanged by it.
#
#   scripts/archive.sh            the archive and the .ipa: build/release/Ravenry.ipa
#   scripts/archive.sh upload     the same, then the .ipa uploaded to App Store Connect
#
# An App Store Connect API key (App Manager or Admin) lets xcodebuild make
# the development profile, scripts/profile.mjs the App Store profile, and
# altool upload; nothing here names the key:
#   ASC_KEY_ID       the key's ID
#   ASC_ISSUER_ID    the issuer ID (App Store Connect, Users and Access, Integrations)
#   ASC_KEY_PATH     the .p8 (default ~/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8,
#                    where altool also looks for it)
#   RAVENRY_IOS_TEAM the team (default the one docs/PUBLISHING.md names)
#   RAVENRY_RELAY    the relay the app's alerts go through (relay/README.md),
#                    else the first line of ~/.ravenry-release/ios-relay.txt;
#                    an App Store build is refused without one, since its
#                    alerts would go nowhere. Never written in the repository
#                    (a workers.dev address names the Cloudflare account).
# The version is the Mac app's (apps/desktop/package.json), the build
# number Android's versionCode (0.1.69 is 1069); a second upload of one
# version needs a new number: RAVENRY_IOS_BUILD=1069.1.
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
for tool in node xcodegen xcodebuild; do
  command -v "$tool" >/dev/null || { echo "archive.sh: $tool is needed" >&2; exit 1; }
done
: "${ASC_KEY_ID:?archive.sh: set ASC_KEY_ID (docs/store/apple/UPLOAD.md)}"
: "${ASC_ISSUER_ID:?archive.sh: set ASC_ISSUER_ID (docs/store/apple/UPLOAD.md)}"
key="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
[ -f "$key" ] || { echo "archive.sh: no key at $key" >&2; exit 1; }
team="${RAVENRY_IOS_TEAM:-94C83QNSZ3}"

version="$(node -p "require('$repo/apps/desktop/package.json').version")"
code="$(node -e "const [a,b,c]=process.argv[1].split('.').map(Number); if(!(b<1000&&c<1000)) process.exit(1); console.log(a*1e6+b*1e3+c)" "$version")"
build="${RAVENRY_IOS_BUILD:-$code}"

relay="${RAVENRY_RELAY:-}"
[ -n "$relay" ] || [ ! -f "$HOME/.ravenry-release/ios-relay.txt" ] || relay="$(head -n 1 "$HOME/.ravenry-release/ios-relay.txt" | tr -d '[:space:]')"
case "$relay" in https://*) ;; *) echo "archive.sh: set RAVENRY_RELAY to the relay's https address (relay/README.md)" >&2; exit 1 ;; esac

out="$here/build/release"
rm -rf "$out"; mkdir -p "$out"
node "$here/../phone/build.mjs" --out "$here/build/phone" >/dev/null
(cd "$here" && xcodegen generate --quiet --spec project.yml)

# First, so the extension's bundle ID and the app's Push Notifications exist
# before the archive signs: the App Store profiles, the app's and its
# Notification Service Extension's ({"dev.ravenry.ios": name, ...}).
profiles="$(ASC_KEY_PATH="$key" node "$here/scripts/profile.mjs")"
pick() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]] || '')" "$profiles" "$1"; }
profile="$(pick dev.ravenry.ios)"; nprofile="$(pick dev.ravenry.ios.notify)"
[ -n "$profile" ] && [ -n "$nprofile" ] || { echo "archive.sh: no App Store profiles ($profiles)" >&2; exit 1; }

auth="-allowProvisioningUpdates -authenticationKeyPath $key -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"
echo "archive.sh: Ravenry $version ($build), team $team"
# shellcheck disable=SC2086
xcodebuild -project "$here/Ravenry.xcodeproj" -scheme Ravenry -configuration Release \
  -destination "generic/platform=iOS" -derivedDataPath "$here/build/DerivedData-release" \
  -archivePath "$out/Ravenry.xcarchive" $auth archive -quiet \
  CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development" CODE_SIGNING_REQUIRED=YES \
  DEVELOPMENT_TEAM="$team" MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" RAVENRY_RELAY="$relay"

# The export signs by hand (an App Manager key cannot use Apple's
# cloud-managed certificate): the Apple Distribution identity, kept in a
# keychain of its own whose password is the login keychain item "Ravenry
# iOS distribution keychain", joins the search list for the export only;
# the App Store profile comes from scripts/profile.mjs.
kc="${RAVENRY_IOS_KEYCHAIN:-$HOME/.ravenry-release/ravenry-ios-distribution.keychain-db}"
if [ -f "$kc" ]; then
  pw="$(/usr/bin/security find-generic-password -s "Ravenry iOS distribution keychain" -w)"
  /usr/bin/security unlock-keychain -p "$pw" "$kc"
  keychains="$(/usr/bin/security list-keychains -d user | tr -d '"')"
  # shellcheck disable=SC2086
  /usr/bin/security list-keychains -d user -s $keychains "$kc"
  # shellcheck disable=SC2086
  trap '/usr/bin/security list-keychains -d user -s $keychains' EXIT
fi


cat > "$out/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>export</string>
	<key>signingStyle</key><string>manual</string>
	<key>signingCertificate</key><string>Apple Distribution</string>
	<key>provisioningProfiles</key><dict><key>dev.ravenry.ios</key><string>$profile</string><key>dev.ravenry.ios.notify</key><string>$nprofile</string></dict>
	<key>teamID</key><string>$team</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>uploadSymbols</key><true/>
</dict>
</plist>
EOF
# shellcheck disable=SC2086
xcodebuild -exportArchive -archivePath "$out/Ravenry.xcarchive" -exportPath "$out" \
  -exportOptionsPlist "$out/ExportOptions.plist" $auth -quiet
ipa="$out/Ravenry.ipa"
[ -f "$ipa" ] || { echo "archive.sh: no .ipa in $out" >&2; exit 1; }
echo "$ipa"

if [ "$1" = "upload" ]; then
  # altool reads the key from ~/.appstoreconnect/private_keys (or API_PRIVATE_KEYS_DIR).
  API_PRIVATE_KEYS_DIR="$(dirname "$key")" xcrun altool --upload-app -f "$ipa" -t ios \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
fi
