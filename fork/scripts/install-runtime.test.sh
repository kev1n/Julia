#!/bin/bash
# On Linux install-runtime.sh switches versions with the new runtime's own
# `t3 service install` (the systemd unit starts the runtime it was installed from),
# which also installs the service on a machine that has none yet.
#   fork/scripts/install-runtime.test.sh
# Runs the real script against a scratch HOME with uname, curl and the runtime stubbed.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/archive/t3-1.0.0+fork.abc-linux-x64"
printf '#!/bin/bash\necho Linux\n' > "$tmp/bin/uname"
# The server reports the version the state file names.
printf '#!/bin/bash\n/usr/bin/python3 -c %s "%s"\n' \
  "'import json,sys; print(json.dumps({\"serverVersion\": json.load(open(sys.argv[1]))[\"activeVersion\"]}))'" \
  "$tmp/.t3/runtime/service-state.json" > "$tmp/bin/curl"
# The runtime: --version, and `service install`, which records its arguments and writes the state.
cat > "$tmp/archive/t3-1.0.0+fork.abc-linux-x64/t3" <<STUB
#!/bin/bash
[ "\$1" = --version ] && { echo "t3 v1.0.0+fork.abc"; exit 0; }
echo "\$*" >> "$tmp/service-install"
echo '{"protocol": 1, "activeVersion": "1.0.0+fork.abc"}' > "$tmp/.t3/runtime/service-state.json"
STUB
chmod +x "$tmp/bin/uname" "$tmp/bin/curl" "$tmp/archive/t3-1.0.0+fork.abc-linux-x64/t3"
archive="$tmp/t3-1.0.0+fork.abc-linux-x64.tar.gz"
tar -czf "$archive" -C "$tmp/archive" t3-1.0.0+fork.abc-linux-x64
status=0
# Without T3CODE_HOME, which a T3 chat's shell inherits and which would aim at the real ~/.t3.
out=$(env -u T3CODE_HOME HOME="$tmp" PATH="$tmp/bin:$PATH" /bin/bash "$here/install-runtime.sh" "$archive" 2>&1) ||
  { echo "FAIL: the first install on Linux failed"; status=1; }
grep -qx "service install --base-dir $tmp/.t3 --allow-downgrade" "$tmp/service-install" 2>/dev/null ||
  { echo "FAIL: the switch was not the runtime's own service install"; status=1; }
[ -x "$tmp/.t3/runtime/versions/1.0.0+fork.abc/t3" ] ||
  { echo "FAIL: the runtime was not unpacked under its version"; status=1; }
[ "$status" = 0 ] && echo ok || printf 'output:\n%s\n' "$out"
exit "$status"
