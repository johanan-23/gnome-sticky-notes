#!/bin/bash
# Install the shell extension for this user. Notes are drawn by the extension.
set -euo pipefail
cd "$(dirname "$0")"

uuid="$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["uuid"])')"
ext="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/${uuid}"
mkdir -p "$ext/schemas"
cp extension/metadata.json extension/*.js extension/stylesheet.css "$ext/"
# Drop the socket client and window adopter from older installs.
rm -f "$ext/client.js" "$ext/windows.js"
rm -rf "$ext/icons" "$ext/bin"
cp -a extension/icons "$ext/"
cp extension/schemas/org.gnome.shell.extensions.sticky-notes.gschema.xml "$ext/schemas/"
glib-compile-schemas "$ext/schemas"

if gnome-extensions info "$uuid" >/dev/null 2>&1; then
    gnome-extensions disable "$uuid" || true
fi
gnome-extensions enable "$uuid"
echo "installed $ext"
