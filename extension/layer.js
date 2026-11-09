import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DING_APP_IDS = new Set(['com.rastersoft.ding', 'com.rastersoft.dingtest']);

// The desktop icons window is fullscreen and transparent, so a note painted
// underneath it is visible and still cannot be clicked. The layer is kept
// directly above that window and below ordinary windows. It is never parented
// above the window group: that paints it over Alt+Tab.
export class DesktopLayer {
    constructor() {
        this._seatLater = 0;
        this._seatTimers = new Set();
        this._watched = new Set();
        this.actor = new St.Widget({
            name: 'sticky-notes',
            reactive: false,
            x: 0,
            y: 0,
        });
        this.actor.set_no_layout(true);

        global.stage.connectObject(
            'notify::width', () => this._syncSize(),
            'notify::height', () => this._syncSize(),
            this);
        global.window_group.connectObject(
            'child-added', (_group, child) => {
                if (child !== this.actor)
                    this._seatSoon();
            },
            this);
        // Mutter emits this right after it restacks the window actors. That
        // lowers every window under the layer, so seat it again before the
        // frame is drawn, or the notes flash above every window.
        global.display.connectObject(
            'restacked', () => this.seat(),
            'window-created', (_display, meta) => {
                this._watchWindow(meta);
                this._seatSoon();
            },
            this);
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);
        this._armSeatRetries();
        this.seat();
        this._syncSize();
    }

    destroy() {
        if (this._seatLater) {
            global.compositor.get_laters().remove(this._seatLater);
            this._seatLater = 0;
        }
        for (const id of this._seatTimers)
            GLib.Source.remove(id);
        this._seatTimers.clear();
        for (const meta of this._watched)
            meta.disconnectObject(this);
        this._watched.clear();
        global.stage.disconnectObject(this);
        global.window_group.disconnectObject(this);
        global.display.disconnectObject(this);
        this.actor.destroy();
        this.actor = null;
    }

    seat() {
        const windows = global.window_group;
        const desktop = this._topDesktop(windows);
        const parent = this.actor.get_parent();
        if (desktop) {
            if (parent !== windows)
                windows.insert_child_above(this.actor, desktop);
            else if (desktop.get_next_sibling() !== this.actor)
                windows.set_child_above_sibling(this.actor, desktop);
        } else if (parent !== windows) {
            windows.insert_child_at_index(this.actor, 0);
        } else if (windows.get_first_child() !== this.actor) {
            windows.set_child_at_index(this.actor, 0);
        }
    }

    // Before the next frame, not on idle: an idle runs after the frame is
    // drawn, so a misplaced layer would show for that frame.
    _seatSoon() {
        if (this._seatLater)
            return;
        this._seatLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._seatLater = 0;
            this.seat();
            return GLib.SOURCE_REMOVE;
        });
    }

    // DING's desktop window is created as a normal window and only later
    // renamed and marked DESKTOP. Seat again once that identity arrives,
    // without waiting for a restack.
    _armSeatRetries() {
        for (const delay of [50, 250, 1000]) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._seatTimers.delete(id);
                this.seat();
                return GLib.SOURCE_REMOVE;
            });
            this._seatTimers.add(id);
        }
    }

    _watchWindow(meta) {
        if (this._watched.has(meta))
            return;
        this._watched.add(meta);
        meta.connectObject(
            'notify::title', () => this._seatSoon(),
            'notify::window-type', () => this._seatSoon(),
            'unmanaged', () => {
                meta.disconnectObject(this);
                this._watched.delete(meta);
            },
            this);
    }

    // The highest wallpaper or desktop actor below every visible ordinary
    // window. A desktop window that is still stacked as a normal window, before
    // it is marked DESKTOP, can sit above other windows; following it there
    // would paint the notes over them.
    _topDesktop(windows) {
        const background = Main.layoutManager._backgroundGroup;
        let desktop = null;
        for (let child = windows.get_first_child(); child; child = child.get_next_sibling()) {
            if (child === this.actor)
                continue;
            if (child === background || this._isDesktopActor(child))
                desktop = child;
            else if (child.meta_window && child.visible)
                break;
        }
        return desktop;
    }

    _isDesktopActor(actor) {
        const meta = actor.meta_window;
        if (!meta)
            return false;
        if (meta.window_type === Meta.WindowType.DESKTOP)
            return true;
        const title = meta.title?.trim() ?? '';
        if (title.startsWith('Desktop Icons') || title.startsWith('DING '))
            return true;
        return DING_APP_IDS.has(meta.get_gtk_application_id());
    }

    _syncSize() {
        this.actor.set_size(global.stage.width, global.stage.height);
    }
}
