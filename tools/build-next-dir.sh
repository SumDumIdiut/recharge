#!/usr/bin/env bash
# build-next-dir.sh - assemble the folder the Recharge launcher installs as app/ for one platform, from a `dotnet publish` of next/src/Recharge.App
# (self-contained, with the built UI: next/src/Recharge.App/ui/). This is exactly what tools/publish-update.mjs --platform <name>=<dir> publishes.
#
#   tools/build-next-dir.sh --platform linux-x64|windows-x64 --publish <dotnet publish output dir> --out <dir>
#
# The manifest's launch file is `recharge` / `recharge.exe` (what the launcher runs, with RECHARGE_* in the environment). The project builds
# Recharge.App[.exe]; the apphost finds its dll by name, so it is renamed here unless the project already builds it under the launch name.
# The folder also carries icon.png (the launcher's .desktop / start-menu icon, copied by the project) and ui/ (the screens the app serves).
set -euo pipefail
plat="" pub="" out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) plat="$2"; shift 2 ;;
    --publish) pub="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$plat" in
  linux-x64) exe=recharge; built=Recharge.App ;;
  windows-x64) exe=recharge.exe; built=Recharge.App.exe ;;
  *) echo "--platform must be linux-x64 or windows-x64" >&2; exit 2 ;;
esac
[ -n "$pub" ] && [ -d "$pub" ] || { echo "--publish must be the dotnet publish output folder" >&2; exit 2; }
[ -n "$out" ] || { echo "--out is required" >&2; exit 2; }

rm -rf "$out"
mkdir -p "$out"
cp -a "$pub/." "$out/"
if [ ! -f "$out/$exe" ]; then
  [ -f "$out/$built" ] || { echo "neither $exe nor $built in the publish output" >&2; exit 1; }
  mv "$out/$built" "$out/$exe"
fi
[ -f "$out/ui/index.html" ] || { echo "the built UI is missing (ui/index.html): run node next/tools/build-ui.mjs before publishing" >&2; exit 1; }
[ -f "$out/icon.png" ] || { echo "icon.png missing from the publish output" >&2; exit 1; }
find "$out" -name '*.pdb' -type f -delete

# deterministic modes: only the launch file is executable (the manifest carries the exec bit)
find "$out" -type f -exec chmod 644 {} +
[ "$plat" = linux-x64 ] && chmod 755 "$out/$exe"

echo "update dir for $plat: $out ($(find "$out" -type f | wc -l) files, launch $exe)"
