#!/bin/bash
# The fork's Android app, Julia (apps/mobile/src/fork/appConfig.ts).
#   fork/scripts/build-mobile.sh build <version> <out-dir> <published-dir>
#   fork/scripts/build-mobile.sh publish <out-dir> <published-dir>
# build stages <out-dir>/mobile: the JavaScript update (expo export) with its
# Expo Updates manifest, and, only when <published-dir> has no APK for this
# native fingerprint (the runtime version), a new signed APK. publish copies
# the stage into <published-dir> (served by artifacts-server.py), writing the
# manifest last so a phone never sees a manifest whose files are missing.
#
# Layout of <published-dir> (~/t3-fork/out/mobile on the build Mac), <apk> being
# fork.env's mobile_apk_name:
#   android/<runtime>/<apk>-<version>.apk             the binary for that fingerprint
#   android/<runtime>/updates/<update id>/...         an exported bundle and its assets
#   android/<runtime>/manifest.json                   the newest update for that binary
#   <apk>.apk                                         the newest APK (the install link)
set -euo pipefail
# mobile_package, mobile_scheme, mobile_apk_name, mobile_keystore, mobile_keystore_pass
. "$(dirname "$0")/fork.env"
artifacts_url=${T3CODE_ARTIFACTS_URL:-$artifacts_url}
# The release signing key (fork.env): Android installs an APK over an older one only when
# both are signed with the same key, so it never changes. Made once on the build Mac; never in git.
keystore=$mobile_keystore
keystore_pass=$mobile_keystore_pass

stage_dir() { echo "$1/mobile"; }

build() {
  local version=$1 out=$2 published=$3
  local repo stage rv
  repo=$(git rev-parse --show-toplevel)
  mkdir -p "$out"
  stage="$(cd "$out" && pwd)/mobile"
  rm -rf "$stage" && mkdir -p "$stage"
  export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
  export JAVA_HOME=${JAVA_HOME:-$HOME/t3-fork/toolchain/jdk21/Contents/Home}
  export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
  [ -n "$artifacts_url" ] || { echo "mobile: set build_mac_url or artifacts_url in $fork_local_config (FORK.md)" >&2; exit 1; }
  export T3CODE_MOBILE_FORK=1 APP_VARIANT=preview T3CODE_MOBILE_UPDATES_URL="$artifacts_url/mobile/manifest"
  export T3CODE_MOBILE_PACKAGE="$mobile_package" T3CODE_MOBILE_SCHEME="$mobile_scheme"
  export EXPO_NO_TELEMETRY=1 EXPO_NO_GIT_STATUS=1 CI=1
  cd "$repo/apps/mobile"

  rv=$(npx expo-updates runtimeversion:resolve --platform android |
    /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["runtimeVersion"])')
  echo "$rv" > "$stage/runtime-version"
  echo "mobile: runtime version (native fingerprint) $rv"

  if ls "$published/android/$rv"/*.apk >/dev/null 2>&1; then
    echo "mobile: an APK for $rv is already published; JavaScript update only"
  else
    echo "mobile: no APK for $rv yet; building one"
    npx expo prebuild --clean --platform android --no-install
    # arm64 only: current Android phones and the Apple-silicon emulator.
    (cd android && ./gradlew --no-daemon -PreactNativeArchitectures=arm64-v8a :app:assembleRelease)
    local built=android/app/build/outputs/apk/release/app-release.apk
    local embedded
    # The fingerprint policy's build-time answer, embedded by expo-updates.
    embedded=$(unzip -p "$built" assets/fingerprint)
    [ "$embedded" = "$rv" ] || { echo "APK runtime $embedded != resolved $rv" >&2; exit 1; }
    local build_tools
    build_tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
    "$build_tools/apksigner" sign --v4-signing-enabled false --ks "$keystore" --ks-pass "file:$keystore_pass" \
      --out "$stage/$mobile_apk_name-$version.apk" "$built"
    "$build_tools/apksigner" verify "$stage/$mobile_apk_name-$version.apk"
  fi

  npx expo export --platform android --output-dir "$stage/dist"
  npx expo config --type public --json > "$stage/expo-config.json"
  /usr/bin/python3 - "$stage" "$rv" "$artifacts_url/mobile/android/$rv/updates" <<'PY'
import base64, hashlib, json, mimetypes, os, sys, time, uuid
stage, rv, updates_url = sys.argv[1:]
dist = os.path.join(stage, "dist")
meta = json.load(open(os.path.join(dist, "metadata.json")))["fileMetadata"]["android"]
# The update id is a hash of the exported files: unchanged JavaScript keeps its id,
# so the phone downloads nothing on a day that changed only the servers.
digest = hashlib.sha256()
def asset(path, content_type, ext=None):
    data = open(os.path.join(dist, path), "rb").read()
    digest.update(path.encode() + hashlib.sha256(data).digest())
    entry = {
        "hash": base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("="),
        "key": hashlib.md5(data).hexdigest(),
        "contentType": content_type,
        "url": path,
    }
    if ext is not None:
        entry["fileExtension"] = "." + ext
    return entry
launch = asset(meta["bundle"], "application/javascript")
assets = [
    asset(a["path"], mimetypes.guess_type("x." + a["ext"])[0] or "application/octet-stream", a["ext"])
    for a in meta["assets"]
]
# The app reads unset config as absent; a null would reach it as {} (truthy), as
# app.config.ts warns, so unset values are left out.
def without_nulls(value):
    if isinstance(value, dict):
        return {k: without_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [without_nulls(v) for v in value]
    return value
update_id = str(uuid.UUID(bytes=digest.digest()[:16], version=4))
for entry in [launch, *assets]:
    entry["url"] = f"{updates_url}/{update_id}/{entry['url']}"
manifest = {
    "id": update_id,
    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    "runtimeVersion": rv,
    "launchAsset": launch,
    "assets": assets,
    "metadata": {},
    "extra": {"expoClient": without_nulls(json.load(open(os.path.join(stage, "expo-config.json"))))},
}
json.dump(manifest, open(os.path.join(stage, "manifest.json"), "w"))
open(os.path.join(stage, "update-id"), "w").write(update_id + "\n")
print(f"mobile: update {update_id} with {len(assets)} assets")
PY
}

publish() {
  local stage published rv id dst
  stage=$(stage_dir "$1")
  published=$2
  rv=$(cat "$stage/runtime-version")
  id=$(cat "$stage/update-id")
  dst="$published/android/$rv"
  mkdir -p "$dst/updates"
  [ -d "$dst/updates/$id" ] || cp -R "$stage/dist" "$dst/updates/$id"
  if ls "$stage"/*.apk >/dev/null 2>&1; then
    cp "$stage"/*.apk "$dst/"
    ln -sfn "android/$rv/$(basename "$stage"/*.apk)" "$published/$mobile_apk_name.apk"
    echo "mobile: published a new APK for $rv"
  fi
  cp "$stage/manifest.json" "$dst/manifest.json.partial"
  mv -f "$dst/manifest.json.partial" "$dst/manifest.json"
  echo "mobile: published update $id for $rv"
  # Keep this update and the one before it, and the two newest binaries, as sync.sh
  # keeps the two newest server builds.
  ls -1dt "$dst/updates"/*/ | tail -n +3 | xargs rm -rf
  ls -1dt "$published/android"/*/ | tail -n +3 | xargs rm -rf
}

case "${1:-}" in
  build) shift; build "$@" ;;
  publish) shift; publish "$@" ;;
  *) echo "usage: $0 build <version> <out-dir> <published-dir> | publish <out-dir> <published-dir>" >&2; exit 2 ;;
esac
