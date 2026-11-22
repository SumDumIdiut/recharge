#!/usr/bin/env bash
# stage-loader.sh - rebuild the game-facing Recharge assemblies from next/src and copy them into
# src/Recharge.App/loader/, the committed folder the app ships as loader/ and installs into the game.
#
# Run this after changing anything under next/src/Recharge.ModApi, Recharge.Module.*, Recharge.Loader*,
# Recharge.Core, Recharge.Link, Recharge.MapDoc or Recharge.Net: CI has no game to compile against
# (these projects reference the game's Managed DLLs), so it ships whatever binaries are committed here.
# Forgetting it means the app updates while the in-game loader keeps running the old code.
#
#   next/tools/stage-loader.sh                 # build + stage
#   next/tools/stage-loader.sh --check         # stamp the staged files with their source (no build)
#   GAME_MANAGED_DIR=/path/to/Managed next/tools/stage-loader.sh
#
# The DLLs are netstandard2.1 and built against the game's own assemblies; nothing is copied from the game.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
next="$(dirname "$here")"
out="$next/src/Recharge.App/loader"
projects=(
  Recharge.Core
  Recharge.Link
  Recharge.Loader.Core
  Recharge.Loader
  Recharge.MapDoc
  Recharge.ModApi
  Recharge.Module.Maps
  Recharge.Module.Net
  Recharge.Module.Skins
  Recharge.Net
)

if [ "${1:-}" != "--check" ]; then
  game="${GAME_MANAGED_DIR:-}"
  if [ -z "$game" ]; then
    game="$HOME/.local/share/Steam/steamapps/common/IGTAP an Incremental Game That's Also a Platformer/IGTAPfullGame_Data/Managed"
  fi
  if [ ! -f "$game/UnityEngine.CoreModule.dll" ]; then
    echo "the game's Managed folder was not found: $game" >&2
    echo "set GAME_MANAGED_DIR to it (the assemblies are compiled against the game, never copied)" >&2
    exit 1
  fi
  for p in "${projects[@]}"; do
    printf '  build %s\n' "$p"
    dotnet build "$next/src/$p/$p.csproj" -c Release -v q --nologo -p:GameManagedDir="$game" >/dev/null
  done
fi

mkdir -p "$out"
for p in "${projects[@]}"; do
  src="$next/src/$p/bin/Release/netstandard2.1/$p.dll"
  [ -f "$src" ] || { echo "missing build output: $src (run without --check)" >&2; exit 1; }
  cp -f "$src" "$out/$p.dll"
done

rel="${out#$next/}"
echo "staged ${#projects[@]} assemblies into $rel"
ls -l "$out" | sed 's/^/  /'
