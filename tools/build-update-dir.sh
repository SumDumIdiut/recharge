#!/usr/bin/env bash
# build-update-dir.sh - assemble the folder the Recharge launcher installs as app/ for one platform.
# This is exactly what tools/publish-update.mjs --platform <name>=<dir> publishes.
#
#   tools/build-update-dir.sh --platform linux-x64|windows-x64 [--bin <path to the tauri binary>] --out <dir>
#
# Layout (next to the binary, because that is where a launcher-managed app looks; see
# app/src-tauri/src/commands/updater.rs resource_path / live.rs packaged_dir):
#   recharge | recharge.exe   the Tauri release binary
#   live.json                 API level the screens need (checked against the binary)
#   src/                      screens (the app serves these locally when launcher-managed)
#   loader/                   ModApi, Runtime, tools, build-loader.ps1 (game loader sources)
#   electron/                 game runner (main.js, package.json)
#   content/                  hub content index + bundled mods
#   icon.png                  for the launcher's .desktop / start-menu entry
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plat="" bin="" out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) plat="$2"; shift 2 ;;
    --bin) bin="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$plat" in
  linux-x64) exe=recharge ;;
  windows-x64) exe=recharge.exe ;;
  *) echo "--platform must be linux-x64 or windows-x64" >&2; exit 2 ;;
esac
[ -n "$out" ] || { echo "--out is required" >&2; exit 2; }
if [ -z "$bin" ]; then
  tdir="${CARGO_TARGET_DIR:-$repo/app/src-tauri/target}"
  if [ "$plat" = windows-x64 ] && [ -f "$tdir/x86_64-pc-windows-msvc/release/$exe" ]; then
    bin="$tdir/x86_64-pc-windows-msvc/release/$exe"
  else
    bin="$tdir/release/$exe"
  fi
fi
[ -f "$bin" ] || { echo "binary not found: $bin" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"
cp "$bin" "$out/$exe"
cp "$repo/app/live.json" "$out/live.json"
cp -r "$repo/app/src" "$out/src"
mkdir -p "$out/loader" "$out/electron"
for d in ModApi Runtime tools; do cp -r "$repo/loader/$d" "$out/loader/$d"; done
cp "$repo/loader/build-loader.ps1" "$out/loader/"
cp "$repo/electron/main.js" "$repo/electron/package.json" "$out/electron/"
cp -r "$repo/content" "$out/content"
cp "$repo/app/src-tauri/icons/128x128.png" "$out/icon.png"
# build output of local loader work never ships
find "$out/loader" \( -name bin -o -name obj \) -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$out" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true

# deterministic modes: only the binary is executable (the manifest carries the exec bit)
find "$out" -type f -exec chmod 644 {} +
[ "$plat" = linux-x64 ] && chmod 755 "$out/$exe"

echo "update dir for $plat: $out ($(find "$out" -type f | wc -l) files)"
