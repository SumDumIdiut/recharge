#!/usr/bin/env bash
# Installs (or updates to) the latest Recharge release. Nothing here is tied to
# a version: it asks GitHub for the newest release each time it runs.
#
#   curl -fsSL https://github.com/SumDumIdiut/recharge/releases/download/installer/install.sh | bash
#
# Options: --user (install under ~/.local, no root), --system (use dpkg/apt),
#          --no-launch, --dry-run (just print the download URL)
set -euo pipefail

REPO="SumDumIdiut/recharge"
MODE=auto
LAUNCH=1
DRY=0
for arg in "$@"; do
  case "$arg" in
    --user) MODE=user ;;
    --system) MODE=system ;;
    --no-launch) LAUNCH=0 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }

echo "Looking up the latest Recharge release..."
json=$(curl -fsSL -H "User-Agent: RechargeSetup" "https://api.github.com/repos/$REPO/releases/latest")
tag=$(printf '%s' "$json" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
url=$(printf '%s' "$json" | grep -o '"browser_download_url": *"[^"]*\.deb"' | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/')
[ -n "$url" ] || { echo "No Linux package found in release ${tag:-?}." >&2; exit 1; }
echo "Latest version: $tag"

if [ "$DRY" = 1 ]; then echo "$url"; exit 0; fi

if [ "$MODE" = auto ]; then
  if command -v dpkg >/dev/null && command -v apt-get >/dev/null; then MODE=system; else MODE=user; fi
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
deb="$work/recharge.deb"
echo "Downloading..."
curl -fL --progress-bar -o "$deb" "$url"

if [ "$MODE" = system ]; then
  echo "Installing with apt (you may be asked for your password)..."
  sudo apt-get install -y "$deb"
  BIN=recharge
else
  PREFIX="${HOME}/.local"
  echo "Installing to $PREFIX (no root needed)..."
  mkdir -p "$work/x" "$work/root"
  ( cd "$work/x" && { ar x "$deb" 2>/dev/null || bsdtar -xf "$deb"; } )
  data=$(ls "$work"/x/data.tar.* 2>/dev/null | head -1)
  [ -n "$data" ] || { echo "Couldn't read the package (need 'ar' from binutils, or 'bsdtar')." >&2; exit 1; }
  tar -xf "$data" -C "$work/root"
  mkdir -p "$PREFIX"
  # --remove-destination so a running recharge binary can be replaced
  cp -a --remove-destination "$work/root/usr/." "$PREFIX/"
  desktop="$PREFIX/share/applications/Recharge.desktop"
  if [ -f "$desktop" ]; then sed -i "s|^Exec=.*|Exec=$PREFIX/bin/recharge|" "$desktop"; fi
  mkdir -p "$PREFIX/share/recharge" && : > "$PREFIX/share/recharge/.user-install"
  command -v update-desktop-database >/dev/null && update-desktop-database "$PREFIX/share/applications" 2>/dev/null || true
  BIN="$PREFIX/bin/recharge"
fi

echo "Recharge $tag is installed."
if [ "$LAUNCH" = 1 ]; then nohup "$BIN" >/dev/null 2>&1 & fi
