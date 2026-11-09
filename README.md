# Sticky Notes

Sticky notes on the desktop, in soft pastel colors. Notes stay off the dock, the app switcher, and the overview. They can sit on every workspace, and an unfocused note tucks behind other windows.

Sticky Notes is free software under the GNU General Public License, version 2 or any later version. See [LICENSE](LICENSE).

## Daily use

The top-bar icon creates a note, hides or shows every note, and keeps a recycle bin. Settings live in the same menu.

| Action | Default shortcut |
| --- | --- |
| New note at the pointer | Ctrl+Super+N |
| Show or hide every note | Ctrl+Super+H |

Both shortcuts can be changed or turned off in the extension settings. Backspace clears a shortcut.

Notes are stored in `~/.local/share/sticky-notes/notes.json`.

## How it works

The notes are actors in the Shell session, the same kind of widget as the top bar. They are not separate windows, so they stay off the dock, the app switcher, and the overview. Creating a note does not start another process.

`src/` is an earlier GTK notes program. The extension does not launch it, and changes to the extension do not need it.

## Local development

You need GNOME Shell 51 on Wayland, plus `git`, `python3`, and `glib-compile-schemas` (from the GLib development tools, usually already installed with GNOME).

Clone the repository and install the extension from your checkout:

```bash
git clone https://github.com/johanan-23/gnome-sticky-notes.git
cd gnome-sticky-notes
./install.sh
```

`install.sh` copies `extension/` into `~/.local/share/gnome-shell/extensions/sticky-notes@johanan.in/`, compiles the settings schema there, and enables the extension. The first time, log out and back in so GNOME Shell picks it up.

### Edit, reload, repeat

GNOME Shell on Wayland cannot reload an extension's JavaScript in a running session. After each change, run `./install.sh` again and then either:

- log out and back in, or
- test in a nested Shell so your own session is untouched:

  ```bash
  dbus-run-session gnome-shell --devkit --wayland
  ```

  The nested Shell loads the extension from the same install folder. Notes created there are written to the same `notes.json`, so back it up first if you care about your own notes.

### Logs and settings

Watch Shell output, including errors and `console.log` calls from the extension:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Open the settings window directly:

```bash
gnome-extensions prefs sticky-notes@johanan.in
```

If you add or rename a key in `extension/schemas/org.gnome.shell.extensions.sticky-notes.gschema.xml`, `install.sh` recompiles the schema. Do not commit `gschemas.compiled`.

### Lint (optional)

[shexli](https://pypi.org/project/shexli/) checks the extension against the rules extensions.gnome.org uses. Running it before a PR catches most problems a reviewer would raise:

```bash
./tools/pack.sh
python3 -m venv .venv
. .venv/bin/activate
pip install -U shexli
shexli dist/sticky-notes@johanan.in.shell-extension.zip
```

Shexli may report `shell-version` 51 as a future release. That is expected; leave `"51"` in `extension/metadata.json`.

## Contributing

1. Fork the repository on GitHub and clone your fork.
2. Create a branch from `main` with a short descriptive name, for example `fix-note-resize`.
3. Make your change, install it with `./install.sh`, and try it in a real or nested Shell. Check the journal for errors.
4. Keep commits focused, and write commit messages that say what changed and why.
5. Push the branch to your fork and open a pull request against `main`. In the description, say what the change does, how you tested it, and include a screenshot or short recording for anything visible.

Please do not bump `version` in `extension/metadata.json` or commit anything from `dist/`; the maintainer handles releases.

If you are unsure whether a change is wanted, open an issue first to discuss it.

## Project layout

| Path | What it is |
| --- | --- |
| `extension/` | The Shell extension: `extension.js`, the notes, `prefs.js`, settings schema, icon |
| `assets/` | Icon source (SVG) and the PNG used on the extension's listing page |
| `src/` | The earlier GTK notes program. The extension does not run it. |
| `install.sh` | Install the extension from this checkout for the current user |
| `tools/pack.sh` | Build the extension zip into `dist/` |
| `tools/cc`, `tools/gen-sysroot.sh` | Fallback linker for building `src/` on a machine without a C compiler or gtk4 development files. Not needed for extension work. |
