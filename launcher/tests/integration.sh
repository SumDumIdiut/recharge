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

echo "== old installs are found (--scan-old) and removed by a first run"
L0="$HOME/.local"; DATA_OLD="$XDG_DATA_HOME/co.za.codecade.recharge"
mkdir -p "$L0/share/recharge" "$L0/bin" "$L0/lib/Recharge/loader" "$L0/share/applications" "$L0/share/icons/hicolor/128x128/apps" \
         "$HOME/Applications" "$XDG_DATA_HOME/applications" "$DATA_OLD" "$XDG_CONFIG_HOME/co.za.codecade.recharge" "$W/other" "$W/fakebin"
: > "$L0/share/recharge/.user-install"; echo bin > "$L0/bin/recharge"; echo x > "$L0/lib/Recharge/loader/l.dll"
printf '[Desktop Entry]\nName=Recharge\nExec=%s/bin/recharge\n' "$L0" > "$L0/share/applications/Recharge.desktop"
echo png > "$L0/share/icons/hicolor/128x128/apps/recharge.png"
echo AI > "$HOME/Applications/Recharge_1.4.3_amd64.AppImage"; echo AI > "$HOME/Applications/Unrelated.AppImage"
printf '[Desktop Entry]\nName=Recharge\nExec="%s/Applications/Recharge_1.4.3_amd64.AppImage" %%U\n' "$HOME" > "$XDG_DATA_HOME/applications/appimagekit_ab-Recharge.desktop"
printf '[Desktop Entry]\nName=Recharge\nExec=/nonexistent/recharge\n' > "$XDG_DATA_HOME/applications/recharge-dead.desktop"
printf '[Desktop Entry]\nName=Recharge notes\nExec=/usr/bin/gedit\n' > "$XDG_DATA_HOME/applications/recharge-notes.desktop"
echo '{}' > "$W/other/state.json"; : > "$W/other/recharge-launcher"
printf '[Desktop Entry]\nName=Recharge\nExec="%s/other/recharge-launcher"\n' "$W" > "$XDG_DATA_HOME/applications/recharge-other.desktop"
echo '{"settings":1}' > "$DATA_OLD/settings.json"; echo mod > "$XDG_CONFIG_HOME/co.za.codecade.recharge/mod.txt"
printf '#!/bin/sh\necho "install ok installed"\n' > "$W/fakebin/dpkg-query"
printf '#!/bin/sh\necho "$@" >> "%s/pkexec.log"\n' "$W" > "$W/fakebin/pkexec"; chmod +x "$W/fakebin/"*
OLDPATH="$PATH"; export PATH="$W/fakebin:$PATH"
out=$("$BIN" --scan-old); rc=$?
check "--scan-old exits 0" "[ $rc -eq 0 ]"
for pat in '.local/bin/recharge' 'Recharge.desktop' 'recharge.png' 'lib/Recharge' '.user-install' 'Recharge_1.4.3_amd64.AppImage' 'appimagekit_ab-Recharge.desktop' 'recharge-dead.desktop' 'other' 'apt-get remove -y recharge'; do
  check "--scan-old lists $pat" "echo '$out' | grep -q -- '$pat'"
done
check "--scan-old leaves unrelated entries alone" "! echo '$out' | grep -q 'Unrelated\|recharge-notes'"
check "--scan-old removed nothing" "[ -f $L0/bin/recharge ] && [ -f $HOME/Applications/Recharge_1.4.3_amd64.AppImage ] && [ ! -e $ROOT ] && [ ! -e $W/pkexec.log ]"

echo "== fresh install (v1)"
gen 1 ok; serve; mark
"$BIN" --no-ui; rc=$?
export PATH="$OLDPATH"
check "old user install gone" "[ ! -e $L0/bin/recharge ] && [ ! -e $L0/lib/Recharge ] && [ ! -e $L0/share/applications/Recharge.desktop ] && [ ! -e $L0/share/recharge/.user-install ] && [ ! -e $L0/share/icons/hicolor/128x128/apps/recharge.png ]"
check "old AppImage + its desktop entry gone, unrelated AppImage kept" "[ ! -e $HOME/Applications/Recharge_1.4.3_amd64.AppImage ] && [ ! -e $XDG_DATA_HOME/applications/appimagekit_ab-Recharge.desktop ] && [ -f $HOME/Applications/Unrelated.AppImage ]"
check "dead desktop entry gone, unrelated one kept" "[ ! -e $XDG_DATA_HOME/applications/recharge-dead.desktop ] && [ -f $XDG_DATA_HOME/applications/recharge-notes.desktop ]"
check "other launcher root + entry gone" "[ ! -e $W/other ] && [ ! -e $XDG_DATA_HOME/applications/recharge-other.desktop ]"
check "package removal went through pkexec" "grep -q 'apt-get remove -y recharge' $W/pkexec.log"
check "user data kept" "[ -f $DATA_OLD/settings.json ] && [ -f $XDG_CONFIG_HOME/co.za.codecade.recharge/mod.txt ]"
check "removals logged" "grep -q 'removing file .*Recharge_1.4.3_amd64.AppImage' $ROOT/launcher.log"
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
check "retried then gave up" "grep -c 'download recharge failed' $ROOT/launcher.log | grep -q 4"

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

echo "== swap retried while files are briefly locked, and a stale running.pid does not block it"
gen 10 stay beta; mark; $L --no-ui
PID=$(cat $ROOT/running.pid)
gen 11 ok beta; mark; $L --stage --no-ui >/dev/null
chmod a-w "$ROOT"; ( sleep 6.5; chmod u+w "$ROOT" ) & UNLOCK=$!
$L --wait-pid "$PID" --no-ui; rc=$?; wait $UNLOCK
check "locked swap retried, v11 swapped in and launched" "[ $rc -eq 0 ] && [ \"\$(tail -1 $ROOT/launches.log)\" = v11 ] && grep -q '\"build\": 11' $ROOT/state.json"
check "each failed rename was logged" "grep -q 'rename .* failed (try 1/20)' $ROOT/launcher.log"
gen 12 stay beta; mark; $L --no-ui
PID=$(cat $ROOT/running.pid)
gen 13 ok beta; mark; $L --stage --no-ui >/dev/null
sleep 30 & STALE=$!
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
echo "$STALE" > $ROOT/running.pid
$L --wait-pid "$PID" --no-ui; rc=$?
kill $STALE 2>/dev/null; wait $STALE 2>/dev/null
check "stale live pid in running.pid does not block the swap" "[ $rc -eq 0 ] && [ \"\$(tail -1 $ROOT/launches.log)\" = v13 ]"

echo "== launcher does not keep the app dir as its cwd"
out=$(cd "$ROOT/app" && RECHARGE_LAUNCHER_LOG_CWD=1 $L --scan-old 2>&1)
check "launcher moved away from app/ at start" "echo '$out' | grep -q 'launcher-cwd ' && ! echo '$out' | grep -q 'launcher-cwd $ROOT/app'"

echo "== state records channel"
check "state records channel and version" "grep -q '\"channel\": \"beta\"' $ROOT/state.json && grep -q '\"version\"' $ROOT/state.json"

echo "== uninstall"
check "desktop entry has an Uninstall action" "grep -q 'Actions=Uninstall' $XDG_DATA_HOME/applications/recharge.desktop && grep -q -- '--uninstall' $XDG_DATA_HOME/applications/recharge.desktop"
echo n | $L --uninstall >/dev/null 2>&1
check "declined: still installed" "[ -d $ROOT ]"
$L --uninstall --yes >/dev/null 2>&1; rc=$?
check "root and desktop entry removed" "[ $rc -eq 0 ] && [ ! -e $ROOT ] && [ ! -e $XDG_DATA_HOME/applications/recharge.desktop ]"
check "plain uninstall keeps user data" "[ -f $DATA_OLD/settings.json ] && [ -f $XDG_CONFIG_HOME/co.za.codecade.recharge/mod.txt ]"
mkdir -p "$ROOT"; echo '{}' > "$ROOT/state.json"
"$BIN" --uninstall --yes --delete-data >/dev/null 2>&1; rc=$?
check "--uninstall --delete-data also removes app data" "[ ! -e $ROOT ] && [ ! -e $DATA_OLD ] && [ ! -e $XDG_CONFIG_HOME/co.za.codecade.recharge ]"

echo "== reinstall over a leftover root recreates the desktop entry"
mkdir -p "$ROOT/app"; echo '{}' > "$ROOT/state.json"; echo junk > "$ROOT/launcher.log"
rm -f "$XDG_DATA_HOME/applications/recharge.desktop"
mark; "$BIN" --no-ui >/dev/null 2>&1
check "reinstall wrote the desktop entry" "grep -q 'Exec=.*recharge-launcher' $XDG_DATA_HOME/applications/recharge.desktop"
rm -f "$XDG_DATA_HOME/applications/recharge.desktop"
$ROOT/recharge-launcher --no-ui >/dev/null 2>&1
check "a plain run recreates a deleted desktop entry" "[ -f $XDG_DATA_HOME/applications/recharge.desktop ]"

echo "== uninstall closes a running app (temp copy) and --delete-data empties data dirs"
cp "$(command -v sleep)" "$ROOT/app/fakeapp"
"$ROOT/app/fakeapp" 300 & FAKE=$!
sleep 0.3
mkdir -p "$DATA_OLD/EBWebView" "$XDG_CONFIG_HOME/co.za.codecade.recharge"; echo c > "$DATA_OLD/EBWebView/c"; echo m > "$XDG_CONFIG_HOME/co.za.codecade.recharge/mod.txt"
"$ROOT/recharge-launcher" --uninstall --yes --delete-data >/dev/null 2>&1; rc=$?
check "uninstall exit 0" "[ $rc -eq 0 ]"
check "running fake app was killed" "! kill -0 $FAKE 2>/dev/null"
check "root removed despite the running app" "[ ! -e $ROOT ]"
check "data dirs removed" "[ ! -e $DATA_OLD ] && [ ! -e $XDG_CONFIG_HOME/co.za.codecade.recharge ]"
check "desktop entry removed" "[ ! -e $XDG_DATA_HOME/applications/recharge.desktop ]"
check "temp copy removed itself" "[ -z \"\$(ls ${TMPDIR:-/tmp}/recharge-uninstall-* 2>/dev/null | grep -v '\.log$')\" ]"
wait $FAKE 2>/dev/null

echo "== first install picks the channel (--channel > file name > old settings > stable)"
gen 1 ok; serve
export RECHARGE_LAUNCHER_NO_HEALTHCHECK=1
fresh() { rm -rf "$ROOT" "$DATA_OLD"; }
chan() { cat "$ROOT/channel.txt" 2>/dev/null; }
mkdir -p "$W/dl"; cp "$BIN" "$W/dl/recharge-beta"; cp "$BIN" "$W/dl/Recharge-Beta.exe"; cp "$BIN" "$W/dl/recharge"
fresh; "$W/dl/recharge" --no-ui >/dev/null 2>&1
check "plain name -> stable" "[ \"\$(chan)\" = stable ]"
fresh; "$W/dl/recharge-beta" --no-ui >/dev/null 2>&1
check "file named recharge-beta -> beta" "[ \"\$(chan)\" = beta ]"
fresh; "$W/dl/Recharge-Beta.exe" --no-ui >/dev/null 2>&1
check "Recharge-Beta.exe (any case) -> beta" "[ \"\$(chan)\" = beta ]"
fresh; mkdir -p "$DATA_OLD"; echo '{"update_channel":"beta"}' > "$DATA_OLD/settings.json"
"$W/dl/recharge" --no-ui >/dev/null 2>&1
check "old settings.json says beta -> beta" "[ \"\$(chan)\" = beta ]"
check "old settings.json left alone" "grep -q beta $DATA_OLD/settings.json"
fresh; mkdir -p "$DATA_OLD"; echo 'not json {' > "$DATA_OLD/settings.json"
"$W/dl/recharge" --no-ui >/dev/null 2>&1
check "invalid settings.json -> stable" "[ \"\$(chan)\" = stable ]"
fresh; mkdir -p "$DATA_OLD"; echo '{"update_channel":"beta"}' > "$DATA_OLD/settings.json"
"$W/dl/recharge-beta" --channel stable --no-ui >/dev/null 2>&1
check "--channel stable overrides name and settings" "[ \"\$(chan)\" = stable ]"
fresh; "$W/dl/recharge" --channel beta --no-ui >/dev/null 2>&1
check "--channel beta on plain name -> beta" "[ \"\$(chan)\" = beta ]"
echo stable > "$ROOT/channel.txt"; rm -f "$ROOT/state.json"
"$W/dl/recharge-beta" --no-ui >/dev/null 2>&1
check "existing channel.txt is kept" "[ \"\$(chan)\" = stable ]"
unset RECHARGE_LAUNCHER_NO_HEALTHCHECK
unserve; fresh

echo; echo "passed $pass, failed $failn"
[ $failn -eq 0 ]
