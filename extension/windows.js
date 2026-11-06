// Places note windows and keeps them out of the dock and the window list.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const APP_ID = 'com.johanan.StickyNotes';
const TITLE_RE = /^pn:(\d+):(-?\d+):(-?\d+):(\d+):(\d+)$/;
const MIN_W = 168;
const MIN_H = 112;
const MARGIN = 8;

// Mutter ORs this into a grab op when the move ignores constraints.
const GRAB_UNCONSTRAINED = Meta.GrabOp.MOVING_UNCONSTRAINED ^ Meta.GrabOp.MOVING;

const USER_GRABS = new Set([
    Meta.GrabOp.MOVING,
    Meta.GrabOp.KEYBOARD_MOVING,
    Meta.GrabOp.RESIZING_N,
    Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_E,
    Meta.GrabOp.RESIZING_W,
    Meta.GrabOp.RESIZING_NE,
    Meta.GrabOp.RESIZING_NW,
    Meta.GrabOp.RESIZING_SE,
    Meta.GrabOp.RESIZING_SW,
    Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
    Meta.GrabOp.KEYBOARD_RESIZING_N,
    Meta.GrabOp.KEYBOARD_RESIZING_S,
    Meta.GrabOp.KEYBOARD_RESIZING_E,
    Meta.GrabOp.KEYBOARD_RESIZING_W,
    Meta.GrabOp.KEYBOARD_RESIZING_NE,
    Meta.GrabOp.KEYBOARD_RESIZING_NW,
    Meta.GrabOp.KEYBOARD_RESIZING_SE,
    Meta.GrabOp.KEYBOARD_RESIZING_SW,
]);

const NoteSizeLimit = GObject.registerClass({
    GTypeName: 'StickyNotesSizeLimit',
    Implements: [Meta.ExternalConstraint],
}, class NoteSizeLimit extends GObject.Object {
    vfunc_constrain(_window, info) {
        constrainSize(this._settings, info);
        return false;
    }
});

export class NoteWindows {
    constructor(settings, client) {
        this._settings = settings;
        this._client = client;
        this._adopted = new Set();
        this._grabbed = new Set();
        this._signals = new Map();
        this._limits = new Map();
        this._placeIds = new Map();
        this._shellSignals = [];
        this._restackId = 0;
        this._placeLater = 0;
        this._focusNext = false;
        this._lastForeign = null;
    }

    watch() {
        const track = (object, signal, callback) => {
            this._shellSignals.push([object, object.connect(signal, callback)]);
        };
        track(global.display, 'window-created', (_display, window) => {
            this._adopt(window, false);
        });
        this._shellSignals.push([
            global.window_manager,
            global.window_manager.connect_after('map', (_wm, actor) => {
                this._onMapped(actor.meta_window);
            }),
        ]);
        track(global.display, 'notify::focus-window', () => {
            const focus = global.display.focus_window;
            if (focus && !this._adopted.has(focus))
                this._lastForeign = focus;
            this._scheduleRestack();
        });
        track(Main.layoutManager, 'monitors-changed', () => {
            this._client.sync(desktopMessage(this._settings));
            this._placeAll();
            this._scheduleRestack();
        });
        track(global.display, 'grab-op-begin', (_display, window, op) => {
            if (this._adopted.has(window) && isUserGrab(op))
                this._grabbed.add(window);
        });
        track(global.display, 'grab-op-end', (_display, window, op) => {
            this._grabbed.delete(window);
            if (isUserGrab(op))
                this._reportFrame(window);
        });

        this._lastForeign = global.display.focus_window;
        for (const actor of global.get_window_actors())
            this._adopt(actor.meta_window, true);
    }

    holdFocus() {
        this._focusNext = true;
    }

    onClientStarted() {
        this._client.sync(desktopMessage(this._settings));
        if (this._placeLater) {
            GLib.Source.remove(this._placeLater);
            this._placeLater = 0;
        }
        this._placeLater = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._placeLater = 0;
            this._placeAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    applyBehavior() {
        for (const window of this._adopted)
            this._stickOne(window);
        this._restack();
        this._client.send(`${optionLines(this._settings).join('\n')}\n`);
        this._placeAll();
    }

    destroy() {
        for (const [object, id] of this._shellSignals)
            object.disconnect(id);
        this._shellSignals = [];

        if (this._restackId) {
            GLib.Source.remove(this._restackId);
            this._restackId = 0;
        }
        if (this._placeLater) {
            GLib.Source.remove(this._placeLater);
            this._placeLater = 0;
        }
        for (const window of [...this._adopted])
            this._drop(window);

        this._settings = null;
        this._client = null;
    }

    _onMapped(window) {
        if (!window)
            return;
        const ours = this._owns(window);
        this._adopt(window, true);
        this._scheduleRestack();
        if (ours)
            this._restoreFocus(window);
    }

    _owns(window) {
        if (this._client.owns(window))
            return true;
        if (window.gtk_application_id === APP_ID)
            return true;
        return (window.title ?? '').startsWith('pn:');
    }

    _adopt(window, place) {
        if (!window || !this._owns(window))
            return;
        if (!this._adopted.has(window)) {
            this._adopted.add(window);
            window.set_type(Meta.WindowType.UTILITY);
            window.hide_from_window_list();
            this._stickOne(window);
            this._attachLimit(window);
            const titleId = window.connect('notify::title', () => {
                this._applyTitle(window, 0);
            });
            const unmanagedId = window.connect('unmanaged', () => {
                this._drop(window);
            });
            this._signals.set(window, [titleId, unmanagedId]);
        }
        if (place)
            this._applyTitle(window, 0);
    }

    _drop(window) {
        const ids = this._signals.get(window);
        if (!ids)
            return;
        this._signals.delete(window);
        for (const id of ids)
            window.disconnect(id);

        const limit = this._limits.get(window);
        if (limit) {
            window.remove_external_constraint(limit);
            limit._settings = null;
            this._limits.delete(window);
        }
        const placeId = this._placeIds.get(window);
        if (placeId) {
            GLib.Source.remove(placeId);
            this._placeIds.delete(window);
        }
        this._adopted.delete(window);
        this._grabbed.delete(window);
    }

    _stickOne(window) {
        if (this._settings.get_boolean('stick'))
            window.stick();
        else
            window.unstick();
    }

    _attachLimit(window) {
        const limit = new NoteSizeLimit();
        limit._settings = this._settings;
        window.add_external_constraint(limit);
        this._limits.set(window, limit);
    }

    _placeAll() {
        for (const window of this._adopted)
            this._applyTitle(window, 0);
    }

    _applyTitle(window, attempt) {
        if (!this._adopted.has(window))
            return;
        if (this._grabbed.has(window)) {
            if (attempt >= 40)
                return;
            this._deferPlace(window, attempt + 1);
            return;
        }

        const title = window.title ?? '';
        const match = TITLE_RE.exec(title);
        if (!match)
            return;
        let x = Number(match[2]);
        let y = Number(match[3]);
        let w = Number(match[4]);
        let h = Number(match[5]);
        [x, y, w, h] = clampFrame(this._settings, x, y, w, h);
        const frame = window.get_frame_rect();
        if (Math.abs(frame.x - x) <= 1 && Math.abs(frame.y - y) <= 1 &&
            Math.abs(frame.width - w) <= 1 && Math.abs(frame.height - h) <= 1)
            return;
        window.move_resize_frame(true, x, y, w, h);
    }

    _deferPlace(window, attempt) {
        const pending = this._placeIds.get(window);
        if (pending) {
            GLib.Source.remove(pending);
            this._placeIds.delete(window);
        }
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._placeIds.delete(window);
            this._applyTitle(window, attempt);
            return GLib.SOURCE_REMOVE;
        });
        this._placeIds.set(window, id);
    }

    _reportFrame(window) {
        if (!this._adopted.has(window))
            return;
        const frame = window.get_frame_rect();
        const match = TITLE_RE.exec(window.title ?? '');
        if (!match)
            return;
        const [x, y, w, h] = clampFrame(
            this._settings, frame.x, frame.y, frame.width, frame.height);
        if (Math.abs(frame.x - x) > 1 || Math.abs(frame.y - y) > 1 ||
            Math.abs(frame.width - w) > 1 || Math.abs(frame.height - h) > 1)
            window.move_resize_frame(true, x, y, w, h);
        if (Math.abs(Number(match[2]) - x) <= 1 && Math.abs(Number(match[3]) - y) <= 1 &&
            Math.abs(Number(match[4]) - w) <= 1 && Math.abs(Number(match[5]) - h) <= 1)
            return;
        this._client.send(`placed ${match[1]} ${x} ${y} ${w} ${h}\n`);
    }

    _restoreFocus(window) {
        if (this._focusNext) {
            this._focusNext = false;
            return;
        }
        const previous = this._lastForeign;
        if (global.display.focus_window !== window || !previous || previous === window)
            return;
        if (!previous.get_compositor_private())
            return;
        previous.focus(global.get_current_time());
    }

    _scheduleRestack() {
        if (this._restackId)
            return;
        this._restackId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._restackId = 0;
            this._restack();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restack() {
        if (!this._settings.get_boolean('sink-unfocused'))
            return;
        const focus = global.display.focus_window;
        for (const window of this._adopted) {
            if (window !== focus)
                window.lower();
        }
    }
}

function isUserGrab(op) {
    return USER_GRABS.has(op & ~GRAB_UNCONSTRAINED);
}

function workAreaAt(x, y) {
    const monitors = Main.layoutManager.monitors;
    if (!monitors.length)
        return null;
    let index = Main.layoutManager.primaryIndex;
    if (index < 0)
        index = 0;
    for (let i = 0; i < monitors.length; i++) {
        const monitor = monitors[i];
        if (x >= monitor.x && x < monitor.x + monitor.width &&
            y >= monitor.y && y < monitor.y + monitor.height) {
            index = i;
            break;
        }
    }
    return Main.layoutManager.getWorkAreaForMonitor(index);
}

function sizeCaps(settings, area) {
    const capW = settings.get_int('max-width');
    const capH = settings.get_int('max-height');
    if (!area)
        return [MIN_W, MIN_H, capW, capH];
    const maxW = Math.max(MIN_W, Math.min(capW, area.width - MARGIN * 2));
    const maxH = Math.max(MIN_H, Math.min(capH, area.height - MARGIN * 2));
    return [MIN_W, MIN_H, maxW, maxH];
}

function clampFrame(settings, x, y, w, h) {
    const area = workAreaAt(x + w / 2, y + h / 2);
    const [minW, minH, maxW, maxH] = sizeCaps(settings, area);
    w = Math.min(Math.max(w, minW), maxW);
    h = Math.min(Math.max(h, minH), maxH);
    if (!area)
        return [x, y, w, h];
    const minX = area.x + MARGIN;
    const minY = area.y + MARGIN;
    x = Math.min(Math.max(x, minX), Math.max(minX, area.x + area.width - MARGIN - w));
    y = Math.min(Math.max(y, minY), Math.max(minY, area.y + area.height - MARGIN - h));
    return [x, y, w, h];
}

function constrainSize(settings, info) {
    if (!settings)
        return;
    const flags = info.flags;
    if (flags && !(flags & Meta.ExternalConstraintFlags.RESIZE))
        return;
    const rect = info.new_rect;
    if (!rect)
        return;

    const area = workAreaAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const [minW, minH, maxW, maxH] = sizeCaps(settings, area);
    const w = Math.min(Math.max(rect.width, minW), maxW);
    const h = Math.min(Math.max(rect.height, minH), maxH);
    if (w === rect.width && h === rect.height)
        return;

    let x = rect.x;
    let y = rect.y;
    const gravity = info.resize_gravity;
    const g = Meta.Gravity;
    if (gravity === g.NORTH_EAST || gravity === g.EAST || gravity === g.SOUTH_EAST)
        x += rect.width - w;
    else if (gravity === g.NORTH || gravity === g.SOUTH || gravity === g.CENTER)
        x += Math.round((rect.width - w) / 2);
    if (gravity === g.SOUTH_WEST || gravity === g.SOUTH || gravity === g.SOUTH_EAST)
        y += rect.height - h;
    else if (gravity === g.WEST || gravity === g.EAST || gravity === g.CENTER)
        y += Math.round((rect.height - h) / 2);
    info.set_rect(new Mtk.Rectangle({x, y, width: w, height: h}));
}

function optionLines(settings) {
    return [
        `option note-width ${settings.get_int('note-width')}`,
        `option note-height ${settings.get_int('note-height')}`,
        `option max-width ${settings.get_int('max-width')}`,
        `option max-height ${settings.get_int('max-height')}`,
    ];
}

function desktopMessage(settings) {
    const lines = [];
    const monitors = Main.layoutManager.monitors;
    const primary = Main.layoutManager.primaryIndex;
    const order = [];
    if (primary >= 0 && primary < monitors.length)
        order.push(primary);
    for (let i = 0; i < monitors.length; i++) {
        if (i !== primary)
            order.push(i);
    }
    for (const i of order) {
        const area = Main.layoutManager.getWorkAreaForMonitor(i);
        lines.push(`workarea ${area.x} ${area.y} ${area.width} ${area.height}`);
    }
    lines.push('workareas-end');
    lines.push(...optionLines(settings));
    return `${lines.join('\n')}\n`;
}
