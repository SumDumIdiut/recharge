#!/bin/bash
# End-to-end launcher test on Linux in temp dirs (HOME/XDG overridden; real ~/.local untouched).
# usage: tests/integration.sh [path-to-launcher-binary]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${1:-${CARGO_TARGET_DIR:-$HERE/../target}/release/recharge-launcher}"
W="$(mktemp -d "${TMPDIR:-/tmp}/rl-int.XXXXXX")"
SITE="$W/site"; mkdir -p "$SITE"
export HOME="$W/home" XDG_DATA_HOME="$W/home/share" XDG_CONFIG_HOME="$W/home/config"
mkdir -p "$HOME"; unset DISPLAY WAYLAND_DISPLAY
PORT=$((20000 + RANDOM % 20000))
export RECHARGE_UPDATE_BASE="http://127.0.0.1:$PORT"
ROOT="$XDG_DATA_HOME/recharge"; LOG="$W/server.log"
pass=0; failn=0
ok()   { echo "  ok   $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL $1"; failn=$((failn+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }
fetches() { grep -c "GET /update/files/" "$LOG"; }
mark()    { : > "$LOG"; }
serve()   { (cd "$SITE" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>"$LOG") & SRV=$!; sleep 0.7; }
unserve() { kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; }
trap 'unserve; rm -rf "$W"' EXIT
gen() { python3 -I "$HERE/gen_site.py" "$SITE" "$@"; }

echo "== fresh install (v1)"
gen 1 ok; serve; mark
"$BIN" --no-ui; rc=$?
check "exit 0" "[ $rc -eq 0 ]"
check "launcher copied to root" "[ -x $ROOT/recharge-launcher ]"
check "desktop entry written" "grep -q 'Exec=.*recharge-launcher' $XDG_DATA_HOME/applications/recharge.desktop"
check "app files present" "[ -x $ROOT/app/recharge ] && [ -f $ROOT/app/old.txt ] && [ -f $ROOT/app/data/big.bin ]"
check "5 files downloaded" "[ $(fetches) -eq 5 ]"
check "health marker created" "[ -f $ROOT/started-1.ok ]"
check "app launched once" "[ \"\$(cat $ROOT/launches.log)\" = v1 ]"
check "log written" "grep -q 'build 1 confirmed healthy' $ROOT/launcher.log"
L="$ROOT/recharge-launcher"

echo "== no-op start"
mark; $L --no-ui; rc=$?
check "exit 0" "[ $rc -eq 0 ]"
check "no file downloads" "[ $(fetches) -eq 0 ]"
check "manifest checked" "grep -q 'GET /update/stable/manifest.json' $LOG"
check "app launched again" "[ \$(wc -l < $ROOT/launches.log) -eq 2 ]"

echo "== update to v2"
gen 2 ok; mark
out=$($L --check); check "--check reports 3 files" "echo '$out' | grep -q 'would update: 3 file'"
check "--check changed nothing" "[ ! -d $ROOT/app.new ] && [ -f $ROOT/app/old.txt ]"
mark; $L --no-ui; rc=$?
check "exit 0" "[ $rc -eq 0 ]"
check "only changed files downloaded (script, b.txt, new.txt)" "[ $(fetches) -eq 3 ]"
check "big file not re-downloaded" "! grep -q $(sha256sum $ROOT/app/data/big.bin | cut -c1-64) $LOG"
check "removed file gone" "[ ! -e $ROOT/app/old.txt ] && [ -f $ROOT/app/sub/new.txt ]"
check "app.old holds v1" "[ -f $ROOT/app.old/old.txt ]"
check "marker for build 2" "[ -f $ROOT/started-2.ok ] && [ ! -f $ROOT/started-1.ok ]"
check "v2 launched" "[ \"\$(tail -1 $ROOT/launches.log)\" = v2 ]"
check "state says build 2" "grep -q '\"build\": 2' $ROOT/state.json"

echo "== offline start"
unserve; mark
RECHARGE_UPDATE_BASE="http://127.0.0.1:1" $L --no-ui; rc=$?
check "exit 0 and app launched" "[ $rc -eq 0 ] && [ \"\$(tail -1 $ROOT/launches.log)\" = v2 ]"
check "log says offline" "grep -q 'manifest unavailable' $ROOT/launcher.log"
RECHARGE_UPDATE_BASE="http://127.0.0.1:1" $L --check; rc=$?
check "--check offline exits 3" "[ $rc -eq 3 ]"

echo "== corruption and --repair"
serve
A=$ROOT/app/data/a.txt; cp -p "$A" "$W/a.bak"; printf 'ALPHA UNCHANGED\n' > "$A"; touch -r "$W/a.bak" "$A"  # same size + mtime
mark; $L --no-ui
check "normal start trusts size+mtime cache (no download)" "[ $(fetches) -eq 0 ] && grep -q ALPHA $A"
mark; $L --no-ui --repair
check "--repair re-downloads exactly the corrupt file" "[ $(fetches) -eq 1 ] && grep -q 'alpha unchanged' $A"
printf 'short' > "$A"   # size changes: detected without --repair
mark; $L --no-ui
check "size change auto-repaired" "grep -q 'alpha unchanged' $A"

echo "== bad hash from server aborts update, keeps v2"
gen 5 badhash; mark; $L --no-ui; rc=$?
check "exit 0, still v2 running" "[ $rc -eq 0 ] && [ \"\$(tail -1 $ROOT/launches.log)\" = v2 ]"
check "app dir untouched" "[ -f $ROOT/app/sub/new.txt ] && grep -q '\"build\": 2' $ROOT/state.json"
check "retried once then gave up" "grep -c 'download recharge failed' $ROOT/launcher.log | grep -q 2"

echo "== bad v3 (exit 1, no marker) -> rollback"
gen 3 fail; mark; $L --no-ui; rc=$?
check "launcher exits 1" "[ $rc -eq 1 ]"
check "v2 restored" "[ \"\$(tail -1 $ROOT/launches.log)\" = v2 ] && grep -q 'echo \"v2\"' $ROOT/app/recharge"
check "build 3 recorded bad" "grep -A1 bad_builds $ROOT/state.json | grep -q 3"
mark; $L --no-ui; rc=$?
check "next start: v3 skipped, nothing fetched, exit 0" "[ $rc -eq 0 ] && [ $(fetches) -eq 0 ] && grep -q 'build 3 previously failed' $ROOT/launcher.log"

echo "== bad v4 (hangs, no marker) -> timeout rollback"
gen 4 hang; mark; t0=$SECONDS; $L --no-ui; rc=$?
check "launcher exits 1 after ~20s" "[ $rc -eq 1 ] && [ $((SECONDS-t0)) -ge 19 ]"
check "v2 back" "grep -q 'echo \"v2\"' $ROOT/app/recharge && grep -q 'killing app' $ROOT/launcher.log"

echo "== good v6 after bad ones"
gen 6 ok; mark; $L --no-ui
check "newer build installs" "[ -f $ROOT/started-6.ok ] && grep -q '\"build\": 6' $ROOT/state.json"

echo "== channel switch"
gen 7 ok beta; mark; $L --no-ui --channel beta
check "beta manifest used" "grep -q 'GET /update/beta/manifest.json' $LOG && grep -q beta $ROOT/channel.txt && [ -f $ROOT/started-7.ok ]"

echo "== env passed to the app"
check "RECHARGE_BUILD/CHANNEL reach the app" "[ \"\$(tail -1 $ROOT/env.log)\" = '7 beta' ] && grep -q '^6 stable' $ROOT/env.log"

echo "== --stage while the app runs, then --wait-pid swap"
gen 8 stay beta; mark; $L --no-ui
check "v8 running" "[ -f $ROOT/started-8.ok ] && kill -0 \$(cat $ROOT/running.pid)"
PID=$(cat $ROOT/running.pid); n=$(wc -l < $ROOT/launches.log)
gen 9 ok beta; mark; out=$($L --stage --no-ui); rc=$?
check "--stage prints staged 9, exit 0" "[ $rc -eq 0 ] && [ \"$out\" = 'staged 9' ]"
check "staged but not swapped or launched" "[ -f $ROOT/app.new.json ] && grep -q '\"build\": 8' $ROOT/state.json && grep -q 'echo \"v8\"' $ROOT/app/recharge && [ \$(wc -l < $ROOT/launches.log) -eq $n ]"
mark; out=$($L --stage --no-ui)
check "second --stage reuses staged tree (no downloads)" "[ \"$out\" = 'staged 9' ] && [ $(fetches) -eq 0 ]"
$L --wait-pid "$PID" --no-ui; rc=$?
check "--wait-pid waited for exit, swapped to 9 and launched it" "[ $rc -eq 0 ] && ! kill -0 $PID 2>/dev/null && [ \"\$(tail -1 $ROOT/launches.log)\" = v9 ] && [ -f $ROOT/started-9.ok ]"
out=$($L --stage --no-ui)
check "--stage now says up to date" "[ \"$out\" = 'up to date' ]"

echo "== uninstall"
echo n | $L --uninstall >/dev/null 2>&1
check "declined: still installed" "[ -d $ROOT ]"
$L --uninstall --yes >/dev/null 2>&1; rc=$?
check "root and desktop entry removed" "[ $rc -eq 0 ] && [ ! -e $ROOT ] && [ ! -e $XDG_DATA_HOME/applications/recharge.desktop ]"

echo; echo "passed $pass, failed $failn"
[ $failn -eq 0 ]
