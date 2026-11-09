import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NotesMenu} from './menu.js';
import {NoteBoard} from './notes.js';

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
        this._board = new NoteBoard(this._settings);
        this._menu = new NotesMenu(this.path, this._board, () => this.openPreferences());

        this._bindKeys();
        this._watchSettings();
        this._menu.addToPanel();
    }

    disable() {
        this._unbindKeys();
        this._settings.disconnectObject(this);
        this._menu.destroy();
        this._menu = null;
        this._board.destroy();
        this._board = null;
        this._settings = null;
    }

    _bindKeys() {
        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const mode = Shell.ActionMode.NORMAL;
        Main.wm.addKeybinding('new-note', this._settings, flags, mode, () => {
            const [x, y] = pointerCoords();
            this._board.create([x, y]);
        });
        Main.wm.addKeybinding('toggle-notes', this._settings, flags, mode, () => {
            this._board.toggle();
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
            this._settings.connectObject(`changed::${key}`, () => this._board.applySettings(), this);
        for (const key of ['new-note', 'toggle-notes'])
            this._settings.connectObject(`changed::${key}`, () => this._rebindKeys(), this);
    }
}

function pointerCoords() {
    const [x, y] = global.get_pointer();
    return [Math.round(x), Math.round(y)];
}
