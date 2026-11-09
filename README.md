# Sticky Notes

Sticky notes on the desktop, in soft pastel colors. Notes stay off the dock, the app switcher, and the overview. They can sit on every workspace, and an unfocused note tucks behind other windows.

Sticky Notes is free software under the GNU General Public License, version 2 or any later version. See [LICENSE](LICENSE).

## Install

You need GNOME Shell 51 on Wayland.

Install Sticky Notes from Extension Manager, or from a checkout of this repository:

```bash
./install.sh
```

`install.sh` copies the extension into `~/.local/share/gnome-shell/extensions/`. Log out and back in if the top-bar icon does not appear. The first time it runs, a note is already on the desktop. The top-bar icon creates another.

Notes are stored in `~/.local/share/sticky-notes/notes.json`.

## Daily use

The top-bar icon creates a note, hides or shows every note, and keeps a recycle bin. Settings live in the same menu.

| Action | Default shortcut |
| --- | --- |
| New note at the pointer | Ctrl+Super+N |
| Show or hide every note | Ctrl+Super+H |

Both shortcuts can be changed or turned off in the extension settings. Backspace clears a shortcut.

## Where the notes are drawn

The notes are actors in the Shell session, the same kind of widget as the top bar. They are not separate windows, so they stay off the dock, the app switcher, and the overview. An unfocused note can sit behind other windows. Creating a note does not start another process.

`src/` is an earlier GTK notes program. The extension does not launch it. A command sent to that program's socket only works while the program is already running, and extensions.gnome.org does not ship the executable, which is why an install from Extension Manager showed nothing after the extension was no longer allowed to start a process.

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
| `extension/` | The Shell extension: `extension.js`, the notes, `prefs.js`, settings schema, icon |
| `src/` | The earlier GTK notes program. The extension does not run it. |
| `install.sh` | Install the extension for the current user |
| `tools/pack.sh` | Build the zip for extensions.gnome.org |
| `tools/cc`, `tools/gen-sysroot.sh` | Fallback linker for a machine that has GTK but no C compiler or gtk4 development files. A normal build does not use them. |

`.cargo/` is a local build setting and is not part of the source.
