import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class StickyNotesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_search_enabled(true);
        window.set_default_size(620, 680);

        const page = new Adw.PreferencesPage({
            title: 'Sticky Notes',
            icon_name: 'preferences-system-symbolic',
        });

        const behavior = new Adw.PreferencesGroup({
            title: 'Desktop',
            description: 'How notes sit among your windows and workspaces',
        });
        behavior.add(switchRow(
            settings,
            'stick',
            'Show on all workspaces',
            'Notes stay where you left them when you switch workspace',
        ));
        behavior.add(switchRow(
            settings,
            'sink-unfocused',
            'Keep the note you are typing in front of the other notes',
            'Notes stay on the desktop, underneath application windows.',
        ));
        page.add(behavior);

        const size = new Adw.PreferencesGroup({
            title: 'New notes',
            description: 'Size used by the top-bar menu, the note menu, and the shortcuts. A new note stays inside the size limit.',
        });
        size.add(spinRow(settings, 'note-width', 'Width', 'Pixels', 180, 960));
        size.add(spinRow(settings, 'note-height', 'Height', 'Pixels', 120, 1200));
        page.add(size);

        const limit = new Adw.PreferencesGroup({
            title: 'Size limit',
            description: 'Dragging stops at this size. The defaults are 440 by 460, and both can be raised.',
        });
        limit.add(spinRow(
            settings,
            'max-width',
            'Maximum width',
            '440 is about 48 characters. Up to 960.',
            240,
            960,
        ));
        limit.add(spinRow(
            settings,
            'max-height',
            'Maximum height',
            '460 is about 20 lines. Up to 1200.',
            180,
            1200,
        ));
        page.add(limit);

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Click a row, then press the new keys. Backspace disables it.',
        });
        const shortcutRows = [
            new ShortcutRow(settings, 'new-note', 'New note at the pointer'),
            new ShortcutRow(settings, 'toggle-notes', 'Show or hide every note'),
        ];
        for (const row of shortcutRows)
            shortcuts.add(row);
        page.add(shortcuts);

        window.add(page);
        window.connect('close-request', () => {
            for (const row of shortcutRows)
                row.disconnectSettings();
            return false;
        });
    }
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: 10,
            page_increment: 40,
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

const SHORTCUT_HINT = 'Click, then press the new keys';

const ShortcutRow = GObject.registerClass(class ShortcutRow extends Adw.ActionRow {
    constructor(settings, key, title) {
        super({
            title,
            subtitle: SHORTCUT_HINT,
            activatable: true,
        });
        this._settings = settings;
        this._key = key;
        this._listening = false;
        this.focusable = true;

        this._label = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Disabled',
            accelerator: settings.get_strv(key)[0] || '',
        });
        this.add_suffix(this._label);

        const keys = new Gtk.EventControllerKey();
        this.add_controller(keys);
        keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (!this._listening)
                return Gdk.EVENT_PROPAGATE;
            return this._onKey(keyval, state);
        });

        this.connect('activated', () => {
            this._listening = true;
            this.subtitle = 'Press a shortcut. Backspace disables it. Escape cancels.';
            this.grab_focus();
        });
        this._changedId = settings.connect(`changed::${key}`, () => {
            this._label.accelerator = settings.get_strv(key)[0] || '';
        });
    }

    disconnectSettings() {
        this._settings.disconnect(this._changedId);
    }

    _onKey(keyval, state) {
        if (keyval === Gdk.KEY_Escape) {
            this._stop();
            return Gdk.EVENT_STOP;
        }
        if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) {
            this._settings.set_strv(this._key, []);
            this._stop();
            return Gdk.EVENT_STOP;
        }
        const modifiers = [
            Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
            Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
            Gdk.KEY_Super_L, Gdk.KEY_Super_R,
            Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift,
        ];
        if (modifiers.includes(keyval))
            return Gdk.EVENT_STOP;
        const mask = state & Gtk.accelerator_get_default_mod_mask();
        const accel = Gtk.accelerator_name(keyval, mask);
        if (accel)
            this._settings.set_strv(this._key, [accel]);
        this._stop();
        return Gdk.EVENT_STOP;
    }

    _stop() {
        this._listening = false;
        this.subtitle = SHORTCUT_HINT;
    }
});
