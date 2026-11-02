// Shell-side host for Sticky Notes.
//
// GNOME Shell only loads JavaScript. The notes themselves are the Rust
// process next to this file. On Wayland a client cannot place its own
// windows or reliably leave the dock, so this host does three things:
// launch that process, keep each note window off the dock and the window
// switcher, move it to the rectangle encoded in its title, and report the
// frame back after the compositor finishes a drag or resize.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const APP_ID = 'com.johanan.PastelNotes';

const TITLE_RE = /^pn:(\d+):(-?\d+):(-?\d+):(\d+):(\d+)$/;

function isUserGeometryOp(op) {
    const value = op & ~1024;
    const grab = Meta.GrabOp;
    switch (value) {
    case grab.MOVING:
    case grab.KEYBOARD_MOVING:
    case grab.RESIZING_N:
    case grab.RESIZING_S:
    case grab.RESIZING_E:
    case grab.RESIZING_W:
    case grab.RESIZING_NE:
    case grab.RESIZING_NW:
    case grab.RESIZING_SE:
    case grab.RESIZING_SW:
    case grab.KEYBOARD_RESIZING_N:
    case grab.KEYBOARD_RESIZING_S:
    case grab.KEYBOARD_RESIZING_E:
    case grab.KEYBOARD_RESIZING_W:
    case grab.KEYBOARD_RESIZING_NE:
    case grab.KEYBOARD_RESIZING_NW:
    case grab.KEYBOARD_RESIZING_SE:
    case grab.KEYBOARD_RESIZING_SW:
        return true;
    default:
        return false;
    }
}

export default class PastelNotesExtension extends Extension {
    enable() {
        this._stopping = false;
        this._crashes = 0;
        this._client = null;
        this._subprocess = null;
        this._focusNext = false;
        this._lastForeign = global.display.focus_window ?? null;
        this._windows = new Set();
        this._placeToken = new Map();
        this._signals = [];
        this._laters = new Set();
        this._hideActivate = 0;
        this._menuOpen = 0;
        this._missingNoted = false;

        this._settings = this.getSettings();
        this._Limit = sizeLimitClass(this);
        this._watchSettings();
        this._addKeybindings();

        this._track(global.display, global.display.connect('window-created', (_display, window) => {
            this._adopt(window, false);
        }));
        this._track(global.window_manager, global.window_manager.connect_after('map', (_wm, actor) => {
            this._onMapped(actor.meta_window);
        }));
        this._track(global.display, global.display.connect('notify::focus-window', () => {
            const focus = global.display.focus_window;
            if (focus && !this._windows.has(focus))
                this._lastForeign = focus;
            this._restack();
        }));
        this._track(Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => {
            this._send(this._workareasMessage());
            this._placeAll();
            this._scheduleRestack();
        }));
        this._track(global.display, global.display.connect('grab-op-end', (_display, window, op) => {
            if (op !== undefined && !isUserGeometryOp(op))
                return;
            this._reportFrame(window);
        }));

        for (const actor of global.get_window_actors())
            this._adopt(actor.meta_window, true);

        this._spawn();
        this._syncWorkareas();
        this._addPanel();
    }

    disable() {
        this._stopping = true;
        this._clearLaters();
        if (this._hideItem && this._hideActivate) {
            try {
                this._hideItem.disconnect(this._hideActivate);
            } catch (e) {
                // The item may already be destroyed.
            }
        }
        this._hideActivate = 0;
        if (this._menuOpen && this._indicator?.menu) {
            try {
                this._indicator.menu.disconnect(this._menuOpen);
            } catch (e) {
                // The menu may already be destroyed.
            }
        }
        this._menuOpen = 0;
        if (this._hideItem) {
            try {
                this._hideItem.destroy();
            } catch (e) {
                // Already destroyed with the panel button.
            }
            this._hideItem = null;
        }
        if (this._deleteAll) {
            try {
                this._deleteAll.destroy();
            } catch (e) {
                // Already destroyed with the panel button.
            }
            this._deleteAll = null;
        }
        if (this._bin) {
            try {
                this._bin.destroy();
            } catch (e) {
                // Already destroyed with the panel button.
            }
            this._bin = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
        this._removeKeybindings();
        this._clearSync();
        if (this._restackId) {
            GLib.source_remove(this._restackId);
            this._restackId = 0;
        }

        for (const [object, id] of this._signals) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Already disconnected.
            }
        }
        this._signals = [];

        for (const window of [...this._windows])
            this._dropWindow(window);

        const proc = this._subprocess;
        this._send('quit\n');
        if (proc) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                try {
                    if (!proc.get_if_exited())
                        proc.force_exit();
                } catch (e) {
                    // Already gone.
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        this._subprocess = null;
        this._client = null;
        this._windows.clear();
    }

    _track(object, id) {
        this._signals.push([object, id]);
    }

    _later(delay, fn) {
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._laters?.delete(id);
            if (!this._stopping)
                fn();
            return GLib.SOURCE_REMOVE;
        });
        this._laters.add(id);
        return id;
    }

    _clearLaters() {
        if (!this._laters)
            return;
        for (const id of this._laters) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Already removed.
            }
        }
        this._laters.clear();
    }

    _dropWindow(window) {
        const ids = window._pastelSignals;
        window._pastelSignals = null;
        if (ids) {
            for (const id of ids) {
                try {
                    window.disconnect(id);
                } catch (e) {
                    // Already unmanaged.
                }
            }
        }
        try {
            if (window._pastelLimit)
                window.remove_external_constraint(window._pastelLimit);
        } catch (e) {
            // The window may already be unmanaged.
        }
        window._pastelLimit = null;
        this._windows.delete(window);
        this._placeToken.delete(window);
    }

    _addKeybindings() {
        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const mode = Shell.ActionMode.NORMAL;
        Main.wm.addKeybinding('new-note', this._settings, flags, mode, () => {
            this._focusNext = true;
            const [x, y] = this._pointer();
            if (!this._send(`create ${x} ${y}\n`))
                this._spawn();
        });
        Main.wm.addKeybinding('toggle-notes', this._settings, flags, mode, () => {
            if (!this._send('toggle\n'))
                this._spawn();
        });
    }

    _removeKeybindings() {
        Main.wm.removeKeybinding('new-note');
        Main.wm.removeKeybinding('toggle-notes');
    }

    _pointer() {
        try {
            const tracker = Meta.Backend.get_backend().get_cursor_tracker();
            const result = tracker.get_pointer();
            const point = result && result.x !== undefined ? result : result[0];
            return [Math.round(point.x), Math.round(point.y)];
        } catch (e) {
            return [180, 140];
        }
    }

    _binary() {
        const bundled = GLib.build_filenamev([this.path, 'bin', 'pastel-notes']);
        if (GLib.file_test(bundled, GLib.FileTest.IS_EXECUTABLE))
            return bundled;
        return GLib.find_program_in_path('pastel-notes') || bundled;
    }

    _noteMissing() {
        if (this._missingNoted || this._stopping)
            return;
        this._missingNoted = true;
        try {
            Main.notify(
                'Sticky Notes',
                'The notes program is not installed yet. Build it from the project source with install.sh.',
            );
        } catch (e) {
            // The panel menu says the same thing.
        }
    }

    _spawn() {
        const binary = this._binary();
        if (!GLib.file_test(binary, GLib.FileTest.IS_EXECUTABLE)) {
            console.error(`[pastel-notes] missing ${binary}`);
            this._noteMissing();
            return;
        }
        const argv = [binary];
        try {
            if (Meta.WaylandClient?.new_subprocess) {
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.NONE,
                });
                launcher.setenv('GSK_RENDERER', 'cairo', true);
                const context = global.context ?? global.create_app_launch_context(0, -1);
                this._client = Meta.WaylandClient.new_subprocess(context, launcher, argv);
                this._subprocess = this._client.get_subprocess();
            } else {
                this._client = null;
                this._subprocess = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            }
        } catch (e) {
            logError(e, '[pastel-notes] failed to launch');
            try {
                this._client = null;
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.NONE,
                });
                launcher.setenv('GSK_RENDERER', 'cairo', true);
                this._subprocess = launcher.spawnv(argv);
            } catch (again) {
                logError(again, '[pastel-notes] failed to launch');
                return;
            }
        }
        this._armWatch();
        this._syncWorkareas();
        this._later(400, () => this._placeAll());
    }

    _armWatch() {
        const proc = this._subprocess;
        if (!proc)
            return;
        proc.wait_async(null, (p, result) => {
            try {
                p.wait_finish(result);
            } catch (e) {
                // wait_finish throws when the process was killed.
            }
            if (this._stopping)
                return;
            const clean = p.get_if_exited?.() && p.get_exit_status() === 0;
            if (clean)
                return;
            this._crashes += 1;
            if (this._crashes > 3) {
                console.error('[pastel-notes] notes process exited repeatedly; not restarting');
                return;
            }
            this._later(1500, () => this._spawn());
        });
    }

    _onMapped(window) {
        if (!window)
            return;
        const ours = this._owns(window);
        this._adopt(window, true);
        this._scheduleRestack();
        if (!ours)
            return;
        if (this._focusNext) {
            this._focusNext = false;
            return;
        }
        if (global.display.focus_window === window && this._lastForeign && this._lastForeign !== window) {
            try {
                this._lastForeign.focus(global.get_current_time());
            } catch (e) {
                // The previous window may already be gone.
            }
        }
    }

    _owns(window) {
        try {
            if (this._client?.owns_window?.(window))
                return true;
        } catch (e) {
            // owns_window is only meaningful for a live Wayland client.
        }
        const appId = window.gtk_application_id || '';
        if (appId === APP_ID)
            return true;
        return (window.title || '').startsWith('pn:');
    }

    _adopt(window, mapped) {
        if (!window || !this._owns(window))
            return;
        if (!this._windows.has(window)) {
            this._windows.add(window);
            try {
                // Utility windows stay out of the dock and the window list,
                // and they can still take keyboard focus. GTK 4.24 no longer
                // has a skip-taskbar hint the app can set itself.
                window.set_type(Meta.WindowType.UTILITY);
                window.hide_from_window_list();
            } catch (e) {
                logError(e, '[pastel-notes] utility window');
            }
            try {
                if (this._bool('stick', true))
                    window.stick();
                else
                    window.unstick();
            } catch (e) {
                logError(e, '[pastel-notes] stick');
            }
            this._attachLimit(window);
            const titleId = window.connect('notify::title', () => this._applyTitle(window, 0));
            const unmanagedId = window.connect('unmanaged', () => this._dropWindow(window));
            window._pastelSignals = [titleId, unmanagedId];
        }
        if (mapped)
            this._applyTitle(window, 0);
    }

    _placeAll() {
        for (const window of this._windows)
            this._applyTitle(window, 0);
    }

    _applyTitle(window, attempt) {
        if (!window || this._stopping)
            return;
        attempt = attempt || 0;
        try {
            const op = window.get_grab_op();
            if (op && op !== Meta.GrabOp.NONE) {
                if (attempt >= 40)
                    return;
                const token = (this._placeToken.get(window) ?? 0) + 1;
                this._placeToken.set(window, token);
                this._later(50, () => {
                    if (this._placeToken.get(window) === token)
                        this._applyTitle(window, attempt + 1);
                });
                return;
            }
        } catch (e) {
            // This mutter build has no grab query. Title moves still apply.
        }
        const title = window.title || '';
        const match = TITLE_RE.exec(title);
        if (!match)
            return;
        let x = Number(match[2]);
        let y = Number(match[3]);
        let w = Number(match[4]);
        let h = Number(match[5]);
        [x, y, w, h] = this._clamp(x, y, w, h);
        let frame;
        try {
            frame = window.get_frame_rect();
        } catch (e) {
            return;
        }
        if (Math.abs(frame.x - x) <= 1 && Math.abs(frame.y - y) <= 1 &&
            Math.abs(frame.width - w) <= 1 && Math.abs(frame.height - h) <= 1)
            return;
        try {
            window.move_resize_frame(true, x, y, w, h);
        } catch (e) {
            logError(e, '[pastel-notes] move');
        }
    }

    _reportFrame(window) {
        if (!window || !this._windows.has(window))
            return;
        let frame;
        try {
            frame = window.get_frame_rect();
        } catch (e) {
            return;
        }
        const match = TITLE_RE.exec(window.title || '');
        if (!match)
            return;
        let [x, y, w, h] = this._clamp(frame.x, frame.y, frame.width, frame.height);
        if (Math.abs(frame.x - x) > 1 || Math.abs(frame.y - y) > 1 ||
            Math.abs(frame.width - w) > 1 || Math.abs(frame.height - h) > 1) {
            try {
                window.move_resize_frame(true, x, y, w, h);
            } catch (e) {
                logError(e, '[pastel-notes] size limit');
            }
        }
        if (Math.abs(Number(match[2]) - x) <= 1 && Math.abs(Number(match[3]) - y) <= 1 &&
            Math.abs(Number(match[4]) - w) <= 1 && Math.abs(Number(match[5]) - h) <= 1)
            return;
        this._send(`placed ${match[1]} ${x} ${y} ${w} ${h}\n`);
    }

    _clamp(x, y, w, h) {
        const monitors = Main.layoutManager.monitors;
        if (!monitors.length) {
            const capW = this._int('max-width', 440);
            const capH = this._int('max-height', 460);
            return [x, y, Math.min(Math.max(w, 168), capW), Math.min(Math.max(h, 112), capH)];
        }
        const cx = x + w / 2;
        const cy = y + h / 2;
        let index = Main.layoutManager.primaryIndex ?? 0;
        for (let i = 0; i < monitors.length; i++) {
            const monitor = monitors[i];
            if (cx >= monitor.x && cx < monitor.x + monitor.width &&
                cy >= monitor.y && cy < monitor.y + monitor.height) {
                index = monitor.index ?? i;
                break;
            }
        }
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        const margin = 8;
        const minW = 168;
        const minH = 112;
        const capW = this._int('max-width', 440);
        const capH = this._int('max-height', 460);
        const maxW = Math.max(minW, Math.min(capW, area.width - margin * 2));
        const maxH = Math.max(minH, Math.min(capH, area.height - margin * 2));
        w = Math.min(Math.max(w, minW), maxW);
        h = Math.min(Math.max(h, minH), maxH);
        const minX = area.x + margin;
        const minY = area.y + margin;
        x = Math.min(Math.max(x, minX), Math.max(minX, area.x + area.width - margin - w));
        y = Math.min(Math.max(y, minY), Math.max(minY, area.y + area.height - margin - h));
        return [x, y, w, h];
    }

    _attachLimit(window) {
        if (!this._Limit || window._pastelLimit || !window.add_external_constraint)
            return;
        try {
            const limit = new this._Limit();
            window.add_external_constraint(limit);
            window._pastelLimit = limit;
        } catch (e) {
            logError(e, '[pastel-notes] size limit');
        }
    }

    // Mutter asks this while the pointer is still down, so the frame never
    // grows past the limit and then snaps back.
    _constrainSize(info) {
        const flags = info.flags || 0;
        if (flags && !(flags & Meta.ExternalConstraintFlags.RESIZE))
            return;
        const rect = info.new_rect;
        if (!rect)
            return;
        const minW = 168;
        const minH = 112;
        const capW = this._int('max-width', 440);
        const capH = this._int('max-height', 460);
        let maxW = capW;
        let maxH = capH;
        const area = this._areaAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (area) {
            const margin = 8;
            maxW = Math.min(capW, Math.max(minW, area.width - margin * 2));
            maxH = Math.min(capH, Math.max(minH, area.height - margin * 2));
        }
        const w = Math.min(Math.max(rect.width, minW), maxW);
        const h = Math.min(Math.max(rect.height, minH), maxH);
        if (w === rect.width && h === rect.height)
            return;
        let x = rect.x;
        let y = rect.y;
        const g = info.resize_gravity;
        const G = Meta.Gravity;
        if (g === G.NORTH_EAST || g === G.EAST || g === G.SOUTH_EAST)
            x += rect.width - w;
        else if (g === G.NORTH || g === G.SOUTH || g === G.CENTER)
            x += Math.round((rect.width - w) / 2);
        if (g === G.SOUTH_WEST || g === G.SOUTH || g === G.SOUTH_EAST)
            y += rect.height - h;
        else if (g === G.WEST || g === G.EAST || g === G.CENTER)
            y += Math.round((rect.height - h) / 2);
        info.set_rect(new Mtk.Rectangle({x, y, width: w, height: h}));
    }

    _areaAt(cx, cy) {
        const monitors = Main.layoutManager.monitors;
        if (!monitors.length)
            return null;
        let index = Main.layoutManager.primaryIndex ?? 0;
        for (let i = 0; i < monitors.length; i++) {
            const monitor = monitors[i];
            if (cx >= monitor.x && cx < monitor.x + monitor.width &&
                cy >= monitor.y && cy < monitor.y + monitor.height) {
                index = monitor.index ?? i;
                break;
            }
        }
        return Main.layoutManager.getWorkAreaForMonitor(index);
    }

    _scheduleRestack() {
        if (this._restackId || this._stopping)
            return;
        this._restackId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._restackId = 0;
            if (!this._stopping)
                this._restack();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restack() {
        // Unfocused notes sit at the bottom of the normal layer: above the
        // desktop icons, underneath every other application. The focused
        // note stays where the click raised it, so it can be typed in.
        if (!this._bool('sink-unfocused', true))
            return;
        const focus = global.display.focus_window;
        for (const window of this._windows) {
            if (window === focus)
                continue;
            try {
                window.lower();
            } catch (e) {
                // Unmanaged during shutdown.
            }
        }
    }

    _workareasMessage() {
        const lines = [];
        const count = Main.layoutManager.monitors.length;
        const primary = Main.layoutManager.primaryIndex ?? 0;
        const order = [];
        if (primary >= 0 && primary < count)
            order.push(primary);
        for (let i = 0; i < count; i++) {
            if (i !== primary)
                order.push(i);
        }
        for (const i of order) {
            const area = Main.layoutManager.getWorkAreaForMonitor(i);
            lines.push(`workarea ${area.x} ${area.y} ${area.width} ${area.height}`);
        }
        lines.push('workareas-end');
        lines.push(...this._optionLines());
        return `${lines.join('\n')}\n`;
    }

    _watchSettings() {
        const apply = () => this._applyBehavior();
        for (const key of ['stick', 'sink-unfocused', 'note-width', 'note-height', 'max-width', 'max-height'])
            this._watch(key, apply);
        for (const key of ['new-note', 'toggle-notes']) {
            this._watch(key, () => {
                this._removeKeybindings();
                this._addKeybindings();
                this._sendOptions();
            });
        }
    }

    _watch(key, callback) {
        try {
            this._track(this._settings, this._settings.connect(`changed::${key}`, callback));
        } catch (e) {
            logError(e, `[pastel-notes] ${key}`);
        }
    }

    _bool(key, fallback) {
        try {
            return this._settings.get_boolean(key);
        } catch (e) {
            return fallback;
        }
    }

    _int(key, fallback) {
        try {
            return this._settings.get_int(key);
        } catch (e) {
            return fallback;
        }
    }

    _applyBehavior() {
        const stick = this._bool('stick', true);
        for (const window of this._windows) {
            try {
                if (stick)
                    window.stick();
                else
                    window.unstick();
            } catch (e) {
                // The window may already be unmanaged.
            }
        }
        this._restack();
        this._sendOptions();
        this._placeAll();
    }

    _optionLines() {
        return [
            `option note-width ${this._int('note-width', 230)}`,
            `option note-height ${this._int('note-height', 180)}`,
            `option max-width ${this._int('max-width', 440)}`,
            `option max-height ${this._int('max-height', 460)}`,
        ];
    }

    _sendOptions() {
        this._send(`${this._optionLines().join('\n')}\n`);
    }

    _syncWorkareas() {
        this._clearSync();
        this._syncTries = 0;
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._syncTries += 1;
            const sent = this._send(this._workareasMessage());
            if (sent || this._syncTries > 25) {
                this._syncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearSync() {
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
    }

    _addPanel() {
        const path = GLib.build_filenamev([
            this.path,
            'icons',
            'hicolor',
            'scalable',
            'actions',
            'pastel-notes-symbolic.svg',
        ]);
        const indicator = new PanelMenu.Button(0.5, 'Sticky Notes');
        indicator.add_child(new St.Icon({
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(path)}),
            style_class: 'system-status-icon',
        }));

        const menu = indicator.menu;
        const newNote = new PopupMenu.PopupImageMenuItem('New note', 'document-new-symbolic');
        newNote.connect('activate', () => this._command('new\n'));
        menu.addMenuItem(newNote);

        this._hideItem = new PopupMenu.PopupImageMenuItem('Hide notes', 'view-conceal-symbolic');
        this._hideActivate = this._hideItem.connect('activate', () => this._command('toggle\n'));
        menu.addMenuItem(this._hideItem);

        this._deleteAll = new PopupMenu.PopupSubMenuMenuItem('Delete all notes', true);
        setMenuIcon(this._deleteAll, 'user-trash-symbolic');
        const confirmDelete = new PopupMenu.PopupImageMenuItem(
            'Move every note to the recycle bin',
            'user-trash-symbolic',
        );
        confirmDelete.connect('activate', () => this._command('delete-all\n'));
        this._deleteAll.menu.addMenuItem(confirmDelete);
        menu.addMenuItem(this._deleteAll);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._bin = new PopupMenu.PopupSubMenuMenuItem('Recycle bin', true);
        setMenuIcon(this._bin, 'user-trash-symbolic');
        menu.addMenuItem(this._bin);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupImageMenuItem('Settings', 'emblem-system-symbolic');
        settings.connect('activate', () => {
            try {
                this.openPreferences();
            } catch (e) {
                logError(e, '[pastel-notes] settings');
            }
        });
        menu.addMenuItem(settings);

        this._menuOpen = menu.connect('open-state-changed', (_menu, open) => {
            if (open && !this._stopping)
                this._refreshPanelMenu();
        });

        this._indicator = indicator;
        Main.panel.addToStatusArea('pastel-notes', indicator, 0, 'right');
    }

    _refreshPanelMenu() {
        const status = parseStatus(this._request('status\n'));
        const hidden = status.hidden;
        setMenuLabel(this._hideItem, hidden ? 'Show notes' : 'Hide notes');
        setMenuIcon(this._hideItem, hidden ? 'view-reveal-symbolic' : 'view-conceal-symbolic');
        this._deleteAll.setSensitive(status.notes > 0);

        const count = status.trash.length;
        setMenuLabel(this._bin, count ? `Recycle bin (${count})` : 'Recycle bin');
        setMenuIcon(this._bin, count ? 'user-trash-full-symbolic' : 'user-trash-symbolic');
        this._bin.menu.removeAll();
        if (!status.alive) {
            const installed = GLib.file_test(this._binary(), GLib.FileTest.IS_EXECUTABLE);
            const missing = new PopupMenu.PopupMenuItem(
                installed ? 'Notes are not running' : 'The notes program is not installed',
            );
            missing.setSensitive(false);
            this._bin.menu.addMenuItem(missing);
            return;
        }
        if (!count) {
            const empty = new PopupMenu.PopupMenuItem('Nothing deleted');
            empty.setSensitive(false);
            this._bin.menu.addMenuItem(empty);
            return;
        }
        if (count > 1) {
            const restoreAll = new PopupMenu.PopupImageMenuItem('Restore all', 'edit-undo-symbolic');
            restoreAll.connect('activate', () => this._command('restore-all\n'));
            this._bin.menu.addMenuItem(restoreAll);
            this._bin.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        for (const item of status.trash) {
            const row = new PopupMenu.PopupImageMenuItem(item.label, 'document-revert-symbolic');
            const id = item.id;
            row.connect('activate', () => this._command(`restore ${id}\n`));
            this._bin.menu.addMenuItem(row);
        }
        this._bin.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const clear = new PopupMenu.PopupImageMenuItem('Empty recycle bin', 'edit-delete-symbolic');
        clear.connect('activate', () => this._command('empty-trash\n'));
        this._bin.menu.addMenuItem(clear);
    }

    _command(text) {
        if (!this._send(text))
            this._spawn();
    }

    _request(text) {
        try {
            const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'pastel-notes.sock']);
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                return '';
            const client = new Gio.SocketClient();
            const conn = client.connect(Gio.UnixSocketAddress.new(path), null);
            conn.output_stream.write_all(new TextEncoder().encode(text), null);
            conn.get_socket().shutdown(false, true, null);
            const chunks = [];
            const input = conn.input_stream;
            while (chunks.join('').length < 65536) {
                const bytes = input.read_bytes(4096, null);
                if (bytes.get_size() === 0)
                    break;
                const data = bytes.get_data();
                if (data)
                    chunks.push(new TextDecoder().decode(data));
            }
            conn.close(null);
            return chunks.join('');
        } catch (e) {
            return '';
        }
    }

    _send(text) {
        try {
            const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'pastel-notes.sock']);
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                return false;
            const client = new Gio.SocketClient();
            const conn = client.connect(Gio.UnixSocketAddress.new(path), null);
            conn.output_stream.write_all(new TextEncoder().encode(text), null);
            conn.close(null);
            return true;
        } catch (e) {
            return false;
        }
    }
}

function setMenuLabel(item, text) {
    if (item?.label)
        item.label.text = text;
}

function setMenuIcon(item, name) {
    const icon = item?.icon ?? item?._icon;
    if (icon)
        icon.icon_name = name;
}

function sizeLimitClass(extension) {
    return GObject.registerClass({
        GTypeName: `PastelNotesSizeLimit${GLib.get_monotonic_time()}`,
        Implements: [Meta.ExternalConstraint],
    }, class PastelSizeLimit extends GObject.Object {
        vfunc_constrain(_window, info) {
            try {
                extension._constrainSize(info);
            } catch (e) {
                logError(e, '[pastel-notes] size limit');
            }
            return false;
        }
    });
}

function parseStatus(text) {
    const status = {hidden: false, notes: 0, trash: [], alive: text.includes('\nend') || text.endsWith('end\n') || text.trim() === 'end'};
    for (const line of text.split('\n')) {
        if (line.startsWith('hidden '))
            status.hidden = line.slice(7).trim() === '1';
        else if (line.startsWith('notes '))
            status.notes = Number(line.slice(6)) || 0;
        else if (line.startsWith('trash ')) {
            const rest = line.slice(6);
            const space = rest.indexOf(' ');
            if (space > 0) {
                status.trash.push({
                    id: rest.slice(0, space),
                    label: rest.slice(space + 1) || 'Empty note',
                });
            }
        }
    }
    return status;
}
