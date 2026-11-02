# Sticky Notes

Sticky notes on the desktop, in soft pastel colors. Notes stay off the dock, the app switcher, and the overview. They can sit on every workspace, and an unfocused note tucks behind other windows.

Sticky Notes is free software under the GNU General Public License, version 2 or any later version. See [LICENSE](LICENSE).

## Install

You need GNOME Shell 51 on Wayland, the Rust compiler, and the GTK 4 development files.

On Debian or Ubuntu:

```bash
sudo apt install build-essential pkg-config libgtk-4-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone <repository-url>
cd pastel-notes
./install.sh
```

On Fedora:

```bash
sudo dnf install gcc pkg-config gtk4-devel
```

Then install Rust the same way and run `./install.sh`.

`install.sh` builds the notes program and copies the extension into `~/.local/share/gnome-shell/extensions/`. If the notes do not appear, log out and back in.

Notes are stored in `~/.local/share/pastel-notes/notes.json`.

## Daily use

The top-bar icon creates a note, hides or shows every note, and keeps a recycle bin. Settings live in the same menu.

| Action | Default shortcut |
| --- | --- |
| New note at the pointer | Ctrl+Super+N |
| Show or hide every note | Ctrl+Super+H |

Both shortcuts can be changed or turned off in the extension settings. Backspace clears a shortcut.

## Why there is a Rust program

GNOME Shell extensions are JavaScript. The notes themselves are a separate program, `pastel-notes`, written in Rust and GTK 4. Shell JavaScript launches that program, keeps its windows off the dock, and places them. A Wayland application cannot place its own windows.

Rust is only needed on a computer that **builds** the program. It is not needed to run it.

- Installing the extension does not install Rust, Cargo, or a compiler.
- The built program uses GTK 4, which is already part of GNOME. It does not carry its own copy of GTK.
- The program is built for one processor type. A build on x86_64 does not run on an ARM computer. That computer builds its own copy with `./install.sh`.
- This project's release build asks for glibc 2.34 or newer and links to the system `libgtk-4.so.1`. A GNOME 51 desktop already has those libraries.

extensions.gnome.org does not compile projects, and its review rules forbid putting an executable inside the extension zip. A zip from that website can carry the JavaScript only. The notes program has to come from this repository, built on the computer that will run it.

## Publishing to extensions.gnome.org

Before the first upload, set `url` in `extension/metadata.json` to this repository. Reviewers and users follow that link to the source.

```bash
chmod +x tools/pack.sh
./tools/pack.sh
python3 -m venv .venv
. .venv/bin/activate
pip install -U shexli
shexli dist/sticky-notes@johanan.in.shell-extension.zip
```

Upload that zip on [extensions.gnome.org](https://extensions.gnome.org/upload/). The archive's files sit at the root of the zip, not inside an extra folder. It contains no compiled program and no `gschemas.compiled`.

Shexli 0.2.1 reports `shell-version` 51 as a future release. That package was published before GNOME 51. This project targets GNOME Shell 51, which is the version it was built against, so leave `"51"` in place.

The upload form asks you to confirm that the extension may be used under GNOME Shell's license. This project is GPL-2.0-or-later, the same license as GNOME Shell.

Each later upload needs a higher integer in `version` inside `extension/metadata.json`.

## Project layout

| Path | What it is |
| --- | --- |
| `extension/` | The Shell extension: `extension.js`, `prefs.js`, settings schema, icon |
| `src/` | The notes program |
| `install.sh` | Build and install for the current user |
| `tools/pack.sh` | Build the zip for extensions.gnome.org |
| `tools/cc`, `tools/gen-sysroot.sh` | Fallback linker for a machine that has GTK but no C compiler or gtk4 development files. A normal build does not use them. |

`.cargo/` is a local build setting and is not part of the source.
