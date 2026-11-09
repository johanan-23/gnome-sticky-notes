#!/bin/bash
# Build the zip accepted by extensions.gnome.org.
# The compiled notes program is intentionally left out. The review rules
# forbid bundled executables, and the website does not compile Rust.
set -euo pipefail
cd "$(dirname "$0")/.."

uuid="$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["uuid"])')"
stage="dist/stage"
out="dist/${uuid}.shell-extension.zip"
rm -rf "$stage"
mkdir -p "$stage/schemas" "$stage/icons"

cp extension/metadata.json extension/*.js extension/stylesheet.css "$stage/"
cp LICENSE "$stage/LICENSE"
cp extension/schemas/org.gnome.shell.extensions.sticky-notes.gschema.xml "$stage/schemas/"
cp -a extension/icons/. "$stage/icons/"

python3 - "$stage" <<'PY'
import os
import sys

stage = sys.argv[1]
bad = []
for dirpath, _, names in os.walk(stage):
    for name in names:
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, stage)
        if name == "gschemas.compiled" or name.endswith((".so", ".a", ".o")):
            bad.append(rel)
            continue
        with open(path, "rb") as handle:
            if handle.read(4) == b"\x7fELF":
                bad.append(rel)
if bad:
    sys.exit("refusing to pack bundled binaries:\n  " + "\n  ".join(bad))
PY

if ! python3 -c 'import json,sys; data=json.load(open("extension/metadata.json")); sys.exit(0 if data.get("url") else 1)'; then
    echo "metadata.json has no url. Add the GitHub address before uploading." >&2
fi

rm -f "$out"
(
    cd "$stage"
    zip -qr "../$(basename "$out")" .
)
rm -rf "$stage"
echo "wrote $out"
echo "Notes are drawn by the extension. This zip has no separate notes program."
