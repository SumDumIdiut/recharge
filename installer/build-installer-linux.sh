#!/usr/bin/env bash
# Builds Recharge's Linux installer artifacts (.deb + .AppImage) via Tauri's
# own bundler and stages them into installer/output/, mirroring what
# build-installer.ps1 does for the Windows NSIS build. Unlike the Windows
# side, there's no hand-rolled installer script here - Tauri's deb/AppImage
# bundlers already produce a correct, FHS-placed package (see
# installer/arch/PKGBUILD, which just re-packages the .deb's own payload).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$root/app"
out_dir="$root/installer/output"

if [ ! -d "$app_dir/node_modules" ]; then
  echo "app/node_modules missing - run 'npm install' in app/ first." >&2
  exit 1
fi

mkdir -p "$out_dir"

(
  cd "$app_dir"
  npm run tauri -- build --bundles deb,appimage
)

bundle_dir="$app_dir/src-tauri/target/release/bundle"
shopt -s nullglob
copied=0
for f in "$bundle_dir"/deb/*.deb "$bundle_dir"/appimage/*.AppImage; do
  cp -v "$f" "$out_dir/"
  copied=$((copied + 1))
done

if [ "$copied" -eq 0 ]; then
  echo "No .deb/.AppImage found under $bundle_dir - did the build actually produce Linux bundles?" >&2
  exit 1
fi

echo "Linux installer artifacts staged in $out_dir"
