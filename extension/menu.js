import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export class NotesMenu {
    constructor(extensionPath, board, openPreferences) {
        this._board = board;
        this._openPreferences = openPreferences;

        const iconPath = GLib.build_filenamev([
            extensionPath,
            'icons',
            'hicolor',
            'scalable',
            'actions',
            'sticky-notes-symbolic.svg',
        ]);
        const indicator = new PanelMenu.Button(0.5, 'Sticky Notes');
        indicator.add_child(new St.Icon({
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)}),
            style_class: 'system-status-icon',
        }));

        const menu = indicator.menu;
        const newNote = new PopupMenu.PopupImageMenuItem('New note', 'document-new-symbolic');
        newNote.connect('activate', () => this._board.create(null));
        menu.addMenuItem(newNote);

        this._hideItem = new PopupMenu.PopupImageMenuItem('Hide notes', 'view-conceal-symbolic');
        this._hideItem.connect('activate', () => this._board.toggle());
        menu.addMenuItem(this._hideItem);

        this._deleteAll = new PopupMenu.PopupSubMenuMenuItem('Delete all notes', true);
        this._deleteAll.icon.icon_name = 'user-trash-symbolic';
        const confirmDelete = new PopupMenu.PopupImageMenuItem(
            'Move every note to the recycle bin',
            'user-trash-symbolic',
        );
        confirmDelete.connect('activate', () => this._board.deleteAll());
        this._deleteAll.menu.addMenuItem(confirmDelete);
        menu.addMenuItem(this._deleteAll);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._bin = new PopupMenu.PopupSubMenuMenuItem('Recycle bin', true);
        this._bin.icon.icon_name = 'user-trash-symbolic';
        menu.addMenuItem(this._bin);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupImageMenuItem('Settings', 'emblem-system-symbolic');
        settings.connect('activate', () => this._openPreferences());
        menu.addMenuItem(settings);

        this._menu = menu;
        this._openId = menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });
        this._indicator = indicator;
    }

    addToPanel() {
        Main.panel.addToStatusArea('sticky-notes', this._indicator, 0, 'right');
    }

    destroy() {
        if (this._openId) {
            this._menu.disconnect(this._openId);
            this._openId = 0;
        }
        this._indicator.destroy();
        this._indicator = null;
        this._menu = null;
        this._hideItem = null;
        this._deleteAll = null;
        this._bin = null;
        this._board = null;
        this._openPreferences = null;
    }

    _refresh() {
        const status = this._board.status();
        this._hideItem.label.text = status.hidden ? 'Show notes' : 'Hide notes';
        this._hideItem.setIcon(status.hidden ? 'view-reveal-symbolic' : 'view-conceal-symbolic');
        this._deleteAll.setSensitive(status.notes > 0);

        const count = status.trash.length;
        this._bin.label.text = count ? `Recycle bin (${count})` : 'Recycle bin';
        this._bin.icon.icon_name = count ? 'user-trash-full-symbolic' : 'user-trash-symbolic';
        this._bin.menu.removeAll();
        if (!count) {
            const empty = new PopupMenu.PopupMenuItem('Nothing deleted');
            empty.setSensitive(false);
            this._bin.menu.addMenuItem(empty);
            return;
        }
        if (count > 1) {
            const restoreAll = new PopupMenu.PopupImageMenuItem('Restore all', 'edit-undo-symbolic');
            restoreAll.connect('activate', () => this._board.restoreAll());
            this._bin.menu.addMenuItem(restoreAll);
            this._bin.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        const list = new PopupMenu.PopupMenuSection();
        for (const item of status.trash) {
            const row = new PopupMenu.PopupImageMenuItem(item.label, 'document-revert-symbolic');
            const id = item.id;
            row.connect('activate', () => this._board.restore(id));
            list.addMenuItem(row);
        }
        this._bin.menu.addMenuItem(list);
        this._scrollSection(this._bin.menu, list);
        this._bin.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const clear = new PopupMenu.PopupImageMenuItem('Empty recycle bin', 'edit-delete-symbolic');
        clear.connect('activate', () => this._board.emptyTrash());
        this._bin.menu.addMenuItem(clear);
    }

    // The submenu only scrolls once the whole panel menu outgrows the
    // screen, so a long bin would stretch it to full height. The deleted
    // notes scroll in their own capped box instead, and the bin actions
    // around them stay in view.
    _scrollSection(menu, section) {
        menu.box.remove_child(section.actor);
        const scroll = new St.ScrollView({
            style_class: 'sticky-notes-bin-list',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: section.actor,
        });
        menu.box.add_child(scroll);
        // removeAll() finds menu items through _delegate, and the scroll box
        // has to go when it destroys the section.
        scroll._delegate = section;
        section.connect('destroy', () => scroll.destroy());
    }
}
