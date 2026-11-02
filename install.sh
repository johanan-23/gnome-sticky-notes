#!/bin/bash
# Build the notes process and install the shell extension for this user.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
fi

have_gtk=0
have_cc=0
if pkg-config --exists gtk4 2>/dev/null; then
    have_gtk=1
fi
if command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; then
    have_cc=1
fi

# A normal build uses the system C compiler and the gtk4 development files.
# The fallback is for a machine that has the GNOME libraries installed but
# not those development packages. It only knows Debian/Ubuntu x86_64 paths.
if [[ "$have_gtk" -eq 0 || "$have_cc" -eq 0 ]]; then
    chmod +x tools/cc tools/gen-sysroot.sh
    tools/gen-sysroot.sh
    export PKG_CONFIG_PATH="$PWD/tools/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    export PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1
    export PKG_CONFIG_ALLOW_SYSTEM_LIBS=1
    if [[ "$(uname -m)" == "x86_64" ]]; then
        export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$PWD/tools/cc"
    fi
fi

cargo build --release

uuid="$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["uuid"])')"
ext="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/${uuid}"
mkdir -p "$ext/bin" "$ext/schemas"
cp extension/metadata.json extension/extension.js extension/prefs.js "$ext/"
rm -rf "$ext/icons"
cp -a extension/icons "$ext/"
cp extension/schemas/org.gnome.shell.extensions.pastel-notes.gschema.xml "$ext/schemas/"
glib-compile-schemas "$ext/schemas"
target_dir="${CARGO_TARGET_DIR:-target}"
install -m 0755 "$target_dir/release/pastel-notes" "$ext/bin/pastel-notes"

if gnome-extensions info "$uuid" >/dev/null 2>&1; then
    gnome-extensions disable "$uuid" || true
fi
gnome-extensions enable "$uuid"
echo "installed $ext"
