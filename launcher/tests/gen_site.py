#!/usr/bin/env python3
"""Build one fake app version into a hub-layout site dir: gen_site.py SITE BUILD MODE [channel]
MODE: ok (writes started marker) | fail (exit 1, no marker) | hang (sleeps, no marker) | stay (marker, then runs 4 s) | badhash
Files accumulate in SITE/update/files/<sha256>; manifest.json is overwritten (= publishing)."""
import hashlib, json, os, sys

site, build, mode = sys.argv[1], int(sys.argv[2]), sys.argv[3]
channel = sys.argv[4] if len(sys.argv) > 4 else "stable"
files_dir = os.path.join(site, "update", "files")
os.makedirs(files_dir, exist_ok=True)
os.makedirs(os.path.join(site, "update", channel), exist_ok=True)

marker = 'touch "$RECHARGE_INSTALL_ROOT/started-%d.ok"\n' % build
body = {"ok": marker + "exit 0\n", "badhash": marker + "exit 0\n", "stay": marker + "sleep 4\n",
        "fail": "exit 1\n", "hang": "sleep 60\n"}[mode]
script = ('#!/bin/sh\necho "v%d" >> "$RECHARGE_INSTALL_ROOT/launches.log"\n'
          'echo "$RECHARGE_BUILD $RECHARGE_CHANNEL" >> "$RECHARGE_INSTALL_ROOT/env.log"\n%s') % (build, body)

# a.txt/big.bin never change; b.txt changes from build 2; new.txt appears in 2; old.txt only in 1
content = {
    "recharge": script.encode(),
    "data/a.txt": b"alpha unchanged\n",
    "data/big.bin": os.urandom(0) + b"B" * 200000,
    "data/b.txt": (b"beta v1\n" if build < 2 else b"beta v2\n"),
}
if build == 1:
    content["old.txt"] = b"only in v1\n"
if build >= 2:
    content["sub/new.txt"] = b"new in v2\n"

entries = []
for path, data in content.items():
    sha = hashlib.sha256(data).hexdigest()
    with open(os.path.join(files_dir, sha), "wb") as f:
        # badhash: the server hands out garbage for the changed script
        f.write(b"X" * len(data) if (mode == "badhash" and path == "recharge") else data)
    e = {"path": path, "size": len(data), "sha256": sha, "component": "app"}
    if path == "recharge":
        e["exec"] = True
    entries.append(e)

manifest = {"format": 1, "channel": channel, "version": "0.0.%d" % build, "build": build,
            "apiLevel": 9, "published": "2026-01-01T00:00:00Z",
            "platforms": {"linux-x64": {"launch": "recharge", "files": entries}}}
with open(os.path.join(site, "update", channel, "manifest.json"), "w") as f:
    json.dump(manifest, f)
