#!/bin/bash
# Point pkg-config at the GTK libraries already installed on the system.
# Development symlinks (libgtk-4.so) are not packaged without libgtk-4-dev.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
libdir="$root/tools/lib"
pcdir="$root/tools/pkgconfig"
sys="/usr/lib/x86_64-linux-gnu"
mkdir -p "$libdir" "$pcdir"

link() {
    local name="$1"
    local target="$2"
    if [[ -e "$sys/$target" ]]; then
        ln -sfn "$sys/$target" "$libdir/$name"
    fi
}

link libgtk-4.so libgtk-4.so.1
link libgdk-4.so libgtk-4.so.1
link libgsk-4.so libgtk-4.so.1
link libglib-2.0.so libglib-2.0.so.0
link libgobject-2.0.so libgobject-2.0.so.0
link libgio-2.0.so libgio-2.0.so.0
link libgmodule-2.0.so libgmodule-2.0.so.0
link libcairo.so libcairo.so.2
link libcairo-gobject.so libcairo-gobject.so.2
link libpango-1.0.so libpango-1.0.so.0
link libpangocairo-1.0.so libpangocairo-1.0.so.0
link libpangoft2-1.0.so libpangoft2-1.0.so.0
link libgdk_pixbuf-2.0.so libgdk_pixbuf-2.0.so.0
link libgraphene-1.0.so libgraphene-1.0.so.0
link libharfbuzz.so libharfbuzz.so.0
link libepoxy.so libepoxy.so.0
link libfontconfig.so libfontconfig.so.1
link libfribidi.so libfribidi.so.0
link libpng16.so libpng16.so.16
link libxkbcommon.so libxkbcommon.so.0
link libgcc_s.so libgcc_s.so.1
# glibc 2.34+ keeps these symbols in libc. The unversioned linker scripts
# are not installed, and rustc still asks for the historical names.
for legacy in libpthread.so libdl.so librt.so libutil.so; do
    ln -sfn "$sys/libc.so" "$libdir/$legacy"
done

pc() {
    local file="$1" name="$2" version="$3" lib="$4"
    cat > "$pcdir/$file" <<EOF
prefix=/usr
Name: $name
Description: $name
Version: $version
Libs: -L${libdir} -l${lib}
Cflags: -I/usr/include
EOF
}

pc gtk4.pc GTK 4.24.1 gtk-4
pc gdk-4.0.pc GDK 4.24.1 gdk-4
pc gsk-4.0.pc GSK 4.24.1 gsk-4
pc glib-2.0.pc GLib 2.90.0 glib-2.0
pc gobject-2.0.pc GObject 2.90.0 gobject-2.0
pc gmodule-2.0.pc GModule 2.90.0 gmodule-2.0
pc gio-2.0.pc GIO 2.90.0 gio-2.0
pc gio-unix-2.0.pc GIOUnix 2.90.0 gio-2.0
pc cairo.pc cairo 1.18.4 cairo
pc cairo-gobject.pc cairo-gobject 1.18.4 cairo-gobject
pc pango.pc Pango 1.58.0 pango-1.0
pc pangocairo.pc PangoCairo 1.58.0 pangocairo-1.0
pc pangoft2.pc PangoFT2 1.58.0 pangoft2-1.0
pc gdk-pixbuf-2.0.pc GdkPixbuf 2.44.0 gdk_pixbuf-2.0
pc graphene-1.0.pc Graphene 1.10.8 graphene-1.0
pc graphene-gobject-1.0.pc graphene-gobject 1.10.8 graphene-1.0
pc harfbuzz.pc HarfBuzz 10.2.0 harfbuzz
pc epoxy.pc Epoxy 1.5.10 epoxy
pc fontconfig.pc Fontconfig 2.16.0 fontconfig
pc fribidi.pc FriBidi 1.0.16 fribidi
pc libpng.pc libpng 1.6.59 png16
pc xkbcommon.pc xkbcommon 1.13.1 xkbcommon
