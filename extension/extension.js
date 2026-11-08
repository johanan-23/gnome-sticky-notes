import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NotesClient} from './client.js';
import {NotesMenu} from './menu.js';
import {NoteWindows} from './windows.js';

const BEHAVIOR_KEYS = [
    'stick',
    'sink-unfocused',
    'note-width',
    'note-height',
    'max-width',
    'max-height',
];

export default class StickyNotesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsIds = [];
        this._keysBound = false;
        this._client = new NotesClient(this.path);
        this._windows = new NoteWindows(this._settings, this._client);
        this._menu = new NotesMenu(this.path, this._client, () => this.openPreferences());

        this._bindKeys();
        this._keysBound = true;
        this._watchSettings();
        this._windows.watch();
        this._menu.addToPanel();
        this._windows.onClientStarted();
    }

    disable() {
        if (this._keysBound) {
            this._unbindKeys();
            this._keysBound = false;
        }
        if (this._settings) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
            this._settingsIds = [];
        }
        if (this._menu) {
            this._menu.destroy();
            this._menu = null;
        }
        if (this._windows) {
            this._windows.destroy();
            this._windows = null;
        }
        if (this._client) {
            this._client.destroy();
            this._client = null;
        }
        this._settings = null;
    }

    _bindKeys() {
        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const mode = Shell.ActionMode.NORMAL;
        Main.wm.addKeybinding('new-note', this._settings, flags, mode, () => {
            this._windows.holdFocus();
            const [x, y] = pointerCoords();
            this._client.command(`create ${x} ${y}\n`);
        });
        Main.wm.addKeybinding('toggle-notes', this._settings, flags, mode, () => {
            this._client.command('toggle\n');
        });
    }

    _unbindKeys() {
        Main.wm.removeKeybinding('new-note');
        Main.wm.removeKeybinding('toggle-notes');
    }

    _rebindKeys() {
        this._unbindKeys();
        this._bindKeys();
    }

    _watchSettings() {
        for (const key of BEHAVIOR_KEYS)
            this._watch(key, () => this._windows.applyBehavior());
        for (const key of ['new-note', 'toggle-notes'])
            this._watch(key, () => this._rebindKeys());
    }

    _watch(key, callback) {
        this._settingsIds.push(this._settings.connect(`changed::${key}`, callback));
    }
}

function pointerCoords() {
    const [x, y] = global.get_pointer();
    return [Math.round(x), Math.round(y)];
}
