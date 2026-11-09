// Notes drawn in this Shell session. A separate notes process is not started:
// the extension zip cannot ship that program, and nothing else activates it.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    COLOR_LABELS,
    MIN_H,
    MIN_W,
    PALETTE,
    SWATCH_ORDER,
    clamp,
    decodeStore,
    emptyStore,
    encodeStore,
    freshOrigin,
    normalizeSize,
    trashLabel,
    trimTrash,
    welcomeNote,
} from './model.js';

const BUTTON_PRIMARY = 1;
const BUTTON_SECONDARY = 3;

function color4(r, g, b, a) {
    const color = new Cogl.Color();
    color.init_from_4f(r, g, b, a);
    return color;
}

function eventCoords(event) {
    const coords = event.get_coords();
    if (Array.isArray(coords))
        return coords;
    return [coords.x, coords.y];
}

export class NoteBoard {
    constructor(settings) {
        this._settings = settings;
        this._dead = false;
        this._ready = false;
        this._queue = [];
        this._views = new Map();
        this._store = emptyStore();
        this._saveId = 0;
        this._menuDropId = 0;
        this._menu = null;
        this._menuId = 0;
        this._menuView = null;
        this._menuThen = null;
        this._drag = null;
        this._focused = null;
        this._raised = null;
        this._overview = false;
        this._layer = null;
        this._path = null;
        this._ink = null;
        this._select = null;
        this.start();
    }

    start() {
        this._ink = color4(50 / 255, 47 / 255, 56 / 255, 1);
        this._select = color4(50 / 255, 47 / 255, 56 / 255, 0.16);
        this._layer = new St.Widget({
            name: 'sticky-notes',
            reactive: false,
            x: 0,
            y: 0,
        });
        this._layer.set_no_layout(true);
        this._placeLayer();

        global.stage.connectObject(
            'captured-event', (_stage, event) => this._onCaptured(event),
            'notify::width', () => this._syncLayerSize(),
            'notify::height', () => this._syncLayerSize(),
            this);
        Main.overview.connectObject(
            'showing', () => this._setOverview(true),
            'hidden', () => this._setOverview(false),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._onMonitors(),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._applyVisibility(),
            this);
        if (Main.overview.visible)
            this._overview = true;
        this._load();
    }

    destroy() {
        this._dead = true;
        this._queue = [];
        this._menuThen = null;
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
        if (this._menuDropId) {
            GLib.Source.remove(this._menuDropId);
            this._menuDropId = 0;
        }
        if (this._ready)
            this._write();
        this._closeMenu();
        this._drag = null;
        global.stage.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const view of [...this._views.values()])
            this._drop(view);
        if (this._layer)
            this._layer.destroy();
        this._layer = null;
        this._focused = null;
        this._raised = null;
        this._ready = false;
    }

    create(at) {
        this._whenReady(() => this._create(at));
    }

    toggle() {
        this._whenReady(() => this._toggle());
    }

    deleteAll() {
        this._whenReady(() => this._deleteAll());
    }

    emptyTrash() {
        this._whenReady(() => this._emptyTrash());
    }

    restore(id) {
        this._whenReady(() => this._restore(id));
    }

    restoreAll() {
        this._whenReady(() => this._restoreAll());
    }

    applySettings() {
        this._placeLayer();
        this._whenReady(() => {
            this._clampAll();
            this._applyVisibility();
            this._scheduleSave();
        });
    }

    status() {
        const trash = [];
        for (let i = this._store.trash.length - 1; i >= 0; i--) {
            const note = this._store.trash[i];
            trash.push({id: note.id, label: trashLabel(note.text)});
        }
        return {
            hidden: this._store.hidden === true,
            notes: this._store.notes.length,
            trash,
            alive: true,
        };
    }

    _whenReady(fn) {
        if (this._dead)
            return;
        if (this._ready)
            fn();
        else
            this._queue.push(fn);
    }

    _flushQueue() {
        const queue = this._queue;
        this._queue = [];
        for (const fn of queue) {
            if (!this._dead)
                fn();
        }
    }

    _load() {
        this._path = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'sticky-notes',
            'notes.json',
        ]);
        const file = Gio.File.new_for_path(this._path);
        if (!file.query_exists(null)) {
            this._useStore(null, false);
            return;
        }
        file.load_contents_async(null, (obj, res) => {
            if (this._dead)
                return;
            let contents = null;
            try {
                [, contents] = obj.load_contents_finish(res);
            } catch (error) {
                if (typeof error.matches !== 'function')
                    throw error;
                // The file is unreadable. Open an empty board and leave it in place.
                this._useStore(null, true);
                return;
            }
            this._useStore(decodeStore(contents, this._workspace()), true);
        });
    }

    _useStore(store, existed) {
        if (this._dead)
            return;
        if (!store)
            store = emptyStore();
        if (!existed) {
            const note = welcomeNote(this._workAreas(), store.next_id, this._workspace());
            store.next_id += 1;
            store.notes.push(note);
        }
        for (const note of store.notes)
            this._clampNote(note);
        this._store = store;
        this._ready = true;
        for (const note of store.notes)
            this._mount(note, false);
        this._applyVisibility();
        if (!existed) {
            const welcome = this._views.get(store.notes[store.notes.length - 1]?.id);
            if (welcome)
                this._focus(welcome, false);
            this._write();
        }
        this._flushQueue();
    }

    _write() {
        if (!this._path)
            return;
        const file = Gio.File.new_for_path(this._path);
        const dir = file.get_parent();
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
        const bytes = new TextEncoder().encode(`${JSON.stringify(encodeStore(this._store), null, 2)}\n`);
        file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    _scheduleSave() {
        if (!this._ready || this._dead)
            return;
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveId = 0;
            if (!this._dead)
                this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    _workspace() {
        return global.workspace_manager.get_active_workspace_index();
    }

    _workAreas() {
        const monitors = Main.layoutManager.monitors;
        const primary = Main.layoutManager.primaryIndex;
        const order = [];
        if (primary >= 0 && primary < monitors.length)
            order.push(primary);
        for (let i = 0; i < monitors.length; i++) {
            if (i !== primary)
                order.push(i);
        }
        const areas = [];
        for (const i of order) {
            const area = Main.layoutManager.getWorkAreaForMonitor(i);
            if (area.width >= 320 && area.height >= 240)
                areas.push({x: area.x, y: area.y, w: area.width, h: area.height});
        }
        if (!areas.length && order.length) {
            const area = Main.layoutManager.getWorkAreaForMonitor(order[0]);
            areas.push({x: area.x, y: area.y, w: area.width, h: area.height});
        }
        return areas;
    }

    _limits() {
        return [this._settings.get_int('max-width'), this._settings.get_int('max-height')];
    }

    _clampNote(note) {
        const [maxW, maxH] = this._limits();
        const [x, y, w, h] = clamp(
            note.x, note.y, note.w, note.h, this._workAreas(), MIN_W, MIN_H, maxW, maxH);
        note.x = x;
        note.y = y;
        note.w = w;
        note.h = h;
        note.expanded_h = h;
    }

    _clampAll() {
        for (const view of this._views.values()) {
            this._clampNote(view.note);
            this._layout(view);
        }
    }

    _placeLayer() {
        if (!this._layer)
            return;
        if (this._raised)
            this._sink(this._raised);
        const ui = Main.layoutManager.uiGroup;
        const windows = global.window_group;
        if (!ui.contains(windows)) {
            if (this._layer.get_parent() !== ui)
                ui.add_child(this._layer);
            this._syncLayerSize();
            return;
        }
        if (this._layer.get_parent() !== ui)
            ui.insert_child_below(this._layer, windows);
        if (this._settings.get_boolean('sink-unfocused'))
            ui.set_child_below_sibling(this._layer, windows);
        else
            ui.set_child_above_sibling(this._layer, windows);
        this._syncLayerSize();
    }

    _syncLayerSize() {
        if (!this._layer)
            return;
        this._layer.set_position(0, 0);
        this._layer.set_size(global.stage.width, global.stage.height);
    }

    _setOverview(open) {
        this._overview = open;
        this._applyVisibility();
    }

    _onMonitors() {
        this._syncLayerSize();
        this._whenReady(() => {
            this._clampAll();
            this._applyVisibility();
            this._scheduleSave();
        });
    }

    _applyVisibility() {
        const show = this._ready && !this._store.hidden && !this._overview;
        const stick = this._settings.get_boolean('stick');
        const space = this._workspace();
        for (const view of this._views.values()) {
            const onSpace = stick || view.note.workspace === space;
            view.frame.visible = show && onSpace;
        }
    }

    _create(at) {
        if (this._overview)
            Main.overview.hide();
        if (this._store.hidden) {
            this._store.hidden = false;
            this._applyVisibility();
        }
        const [maxW, maxH] = this._limits();
        const w = Math.min(this._settings.get_int('note-width'), maxW);
        const h = Math.min(this._settings.get_int('note-height'), maxH);
        const areas = this._workAreas();
        const obstacles = this._store.notes.map(note => [note.x, note.y, note.w, note.h]);
        const prefer = this._focused ? [this._focused.note.x, this._focused.note.y] : null;
        const [x, y] = freshOrigin(obstacles, areas, w, h, at, prefer);
        const id = this._store.next_id;
        this._store.next_id += 1;
        const note = {
            id,
            x,
            y,
            w,
            h,
            expanded_h: h,
            color: this._store.notes.length % PALETTE.length,
            size: 13,
            collapsed: false,
            locked: false,
            text: '',
            spans: [],
            workspace: this._workspace(),
        };
        this._clampNote(note);
        this._store.notes.push(note);
        this._mount(note, true);
        this._scheduleSave();
    }

    _toggle() {
        this._store.hidden = !this._store.hidden;
        if (this._store.hidden)
            this._blur();
        this._applyVisibility();
        this._scheduleSave();
    }

    _delete(view) {
        const index = this._store.notes.findIndex(note => note.id === view.note.id);
        if (index < 0)
            return;
        const [note] = this._store.notes.splice(index, 1);
        this._store.trash.push(note);
        trimTrash(this._store);
        this._drop(view);
        this._scheduleSave();
    }

    _deleteAll() {
        const notes = this._store.notes.splice(0);
        for (const note of notes)
            this._store.trash.push(note);
        trimTrash(this._store);
        for (const view of [...this._views.values()])
            this._drop(view);
        this._scheduleSave();
    }

    _emptyTrash() {
        this._store.trash = [];
        this._scheduleSave();
    }

    _restore(id) {
        const index = id === null || id === undefined
            ? this._store.trash.length - 1
            : this._store.trash.findIndex(note => note.id === id);
        if (index < 0)
            return;
        const [note] = this._store.trash.splice(index, 1);
        this._clampNote(note);
        note.workspace = this._workspace();
        this._store.notes.push(note);
        if (this._store.hidden)
            this._store.hidden = false;
        if (this._overview)
            Main.overview.hide();
        this._mount(note, true);
        this._scheduleSave();
    }

    _restoreAll() {
        const notes = this._store.trash.splice(0);
        if (!notes.length)
            return;
        if (this._store.hidden)
            this._store.hidden = false;
        if (this._overview)
            Main.overview.hide();
        let last = null;
        for (const note of notes) {
            this._clampNote(note);
            note.workspace = this._workspace();
            this._store.notes.push(note);
            last = this._mount(note, false);
        }
        if (last)
            this._focus(last, true);
        this._scheduleSave();
    }

    _mount(note, focus) {
        const view = this._build(note);
        this._views.set(note.id, view);
        this._layer.add_child(view.frame);
        this._layout(view);
        this._paint(view);
        this._applyVisibility();
        if (focus)
            this._focus(view, true);
        return view;
    }

    _build(note) {
        const frame = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x: note.x,
            y: note.y,
            width: note.w,
            height: note.h,
        });
        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `sticky-note ${PALETTE[note.color]}`,
            x_expand: true,
            y_expand: true,
        });
        const grip = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'sticky-note-grip',
            reactive: true,
            height: 18,
            x_expand: true,
        });
        grip.add_child(new St.Widget({
            style_class: 'sticky-note-pill',
            width: 36,
            height: 4,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const text = new Clutter.Text({
            text: note.text,
            editable: !note.locked,
            selectable: true,
            reactive: true,
            single_line_mode: false,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            font_name: `Sans ${note.size}`,
            color: this._ink,
            cursor_color: this._ink,
            selection_color: this._select,
            selected_text_color: this._ink,
            margin_top: 4,
            margin_bottom: 8,
            margin_left: 12,
            margin_right: 14,
        });
        // ScrollView.child must implement St.Scrollable. Clutter.Text does not;
        // St.BoxLayout does, and it holds the text.
        const page = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
        });
        page.add_child(text);
        const scroll = new St.ScrollView({
            style_class: 'sticky-note-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
            child: page,
        });
        const resize = new St.Widget({
            style_class: 'sticky-note-resize',
            reactive: true,
            width: 18,
            height: 18,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        card.add_child(grip);
        card.add_child(scroll);
        frame.add_child(card);
        frame.add_child(resize);

        const view = {note, frame, card, grip, text, resize};
        frame.connectObject(
            'button-press-event', (_actor, event) => this._onFramePress(view, event),
            this);
        grip.connectObject(
            'button-press-event', (_actor, event) => this._onGripPress(view, event),
            this);
        resize.connectObject(
            'button-press-event', (_actor, event) => this._onResizePress(view, event),
            this);
        text.connectObject(
            'button-press-event', (_actor, event) => this._onTextPress(view, event),
            'key-press-event', (_actor, event) => this._onTextKey(view, event),
            'key-focus-in', () => this._focus(view, false),
            'text-changed', () => this._onText(view),
            this);
        return view;
    }

    _layout(view) {
        const {note, frame, text} = view;
        frame.set_position(note.x, note.y);
        frame.set_size(note.w, note.h);
        text.width = Math.max(48, note.w - 26);
    }

    _paint(view) {
        const name = PALETTE[view.note.color] ?? PALETTE[0];
        for (const color of PALETTE)
            view.card.remove_style_class_name(color);
        view.card.add_style_class_name(name);
        view.text.editable = !view.note.locked;
        view.text.font_name = `Sans ${normalizeSize(view.note.size)}`;
    }

    _drop(view) {
        if (this._focused === view) {
            if (global.stage.get_key_focus() === view.text)
                global.stage.set_key_focus(null);
            this._focused = null;
        }
        if (this._raised === view)
            this._raised = null;
        if (this._drag && this._drag.view === view)
            this._drag = null;
        if (this._menuView === view)
            this._closeMenu();
        view.frame.disconnectObject(this);
        view.grip.disconnectObject(this);
        view.resize.disconnectObject(this);
        view.text.disconnectObject(this);
        this._views.delete(view.note.id);
        view.frame.destroy();
    }

    _focus(view, grabText) {
        this._focused = view;
        if (this._settings.get_boolean('sink-unfocused'))
            this._raise(view);
        else if (view.frame.get_parent() === this._layer)
            this._layer.set_child_above_sibling(view.frame, null);
        if (grabText && !view.note.locked && view.frame.visible)
            view.text.grab_key_focus();
    }

    _blur() {
        const view = this._focused;
        if (!view)
            return;
        this._focused = null;
        if (global.stage.get_key_focus() === view.text)
            global.stage.set_key_focus(null);
        this._sink(view);
    }

    _raise(view) {
        if (this._raised && this._raised !== view)
            this._sink(this._raised);
        const ui = Main.layoutManager.uiGroup;
        if (view.frame.get_parent() !== ui) {
            view.frame.get_parent().remove_child(view.frame);
            if (ui.contains(global.window_group))
                ui.insert_child_above(view.frame, global.window_group);
            else
                ui.add_child(view.frame);
        }
        this._raised = view;
        this._layout(view);
    }

    _sink(view) {
        if (!this._layer)
            return;
        if (view.frame.get_parent() !== this._layer) {
            const parent = view.frame.get_parent();
            if (parent)
                parent.remove_child(view.frame);
            this._layer.add_child(view.frame);
            this._layout(view);
        }
        if (this._raised === view)
            this._raised = null;
    }

    _onCaptured(event) {
        if (this._dead)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (this._drag && (type === Clutter.EventType.MOTION || type === Clutter.EventType.BUTTON_RELEASE)) {
            this._updateDrag(event);
            if (type === Clutter.EventType.BUTTON_RELEASE)
                this._endDrag();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS && !this._eventHitsUs(event.get_source()))
            this._blur();
        return Clutter.EVENT_PROPAGATE;
    }

    _eventHitsUs(actor) {
        while (actor) {
            if (actor === this._layer)
                return true;
            if (this._menu && actor === this._menu.actor)
                return true;
            for (const view of this._views.values()) {
                if (actor === view.frame)
                    return true;
            }
            actor = actor.get_parent();
        }
        return false;
    }

    _onFramePress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() === BUTTON_PRIMARY)
            this._focus(view, false);
        return Clutter.EVENT_PROPAGATE;
    }

    _onGripPress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() !== BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._focus(view, false);
        this._beginDrag(view, event, 'move');
        return Clutter.EVENT_STOP;
    }

    _onResizePress(view, event) {
        if (event.get_button() !== BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._focus(view, false);
        this._beginDrag(view, event, 'resize');
        return Clutter.EVENT_STOP;
    }

    _onTextPress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        this._focus(view, !view.note.locked);
        return Clutter.EVENT_PROPAGATE;
    }

    _onTextKey(_view, event) {
        if (event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        this._blur();
        return Clutter.EVENT_STOP;
    }

    _onText(view) {
        const text = view.text.text;
        if (text === view.note.text)
            return;
        view.note.text = text;
        view.note.spans = [];
        this._scheduleSave();
    }

    _beginDrag(view, event, mode) {
        const [x, y] = eventCoords(event);
        this._drag = {
            view,
            mode,
            x,
            y,
            originX: view.note.x,
            originY: view.note.y,
            originW: view.note.w,
            originH: view.note.h,
        };
    }

    _updateDrag(event) {
        const drag = this._drag;
        const [x, y] = eventCoords(event);
        const dx = Math.round(x - drag.x);
        const dy = Math.round(y - drag.y);
        const note = drag.view.note;
        if (drag.mode === 'move') {
            note.x = drag.originX + dx;
            note.y = drag.originY + dy;
        } else {
            note.w = drag.originW + dx;
            note.h = drag.originH + dy;
        }
        this._clampNote(note);
        this._layout(drag.view);
    }

    _endDrag() {
        const view = this._drag.view;
        this._drag = null;
        view.note.expanded_h = view.note.h;
        view.note.workspace = this._workspace();
        this._scheduleSave();
    }

    _setColor(view, index) {
        view.note.color = index % PALETTE.length;
        this._paint(view);
        this._scheduleSave();
    }

    _stepSize(view, delta) {
        const size = normalizeSize(view.note.size) + delta;
        view.note.size = Math.min(16, Math.max(11, size));
        this._paint(view);
        this._scheduleSave();
    }

    _duplicate(view) {
        const source = view.note;
        const areas = this._workAreas();
        const obstacles = this._store.notes.map(note => [note.x, note.y, note.w, note.h]);
        const [x, y] = freshOrigin(obstacles, areas, source.w, source.h, null, [source.x, source.y]);
        const id = this._store.next_id;
        this._store.next_id += 1;
        const note = {
            id,
            x,
            y,
            w: source.w,
            h: source.h,
            expanded_h: source.h,
            color: source.color,
            size: source.size,
            collapsed: false,
            locked: false,
            text: source.text,
            spans: source.spans.map(span => ({...span})),
            workspace: this._workspace(),
        };
        this._clampNote(note);
        this._store.notes.push(note);
        this._mount(note, true);
        this._scheduleSave();
    }

    _toggleLock(view) {
        view.note.locked = !view.note.locked;
        this._paint(view);
        if (view.note.locked && global.stage.get_key_focus() === view.text)
            global.stage.set_key_focus(null);
        this._scheduleSave();
    }

    _openMenu(view) {
        this._closeMenu();
        this._focus(view, false);
        const menu = new PopupMenu.PopupMenu(view.grip, 0.0, St.Side.TOP);
        const colors = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sticky-note-colors',
            x_expand: true,
        });
        colors.add_child(new St.Label({
            text: 'Color',
            style_class: 'sticky-note-caption',
            x_align: Clutter.ActorAlign.START,
        }));
        for (const row of [SWATCH_ORDER.slice(0, 8), SWATCH_ORDER.slice(8)]) {
            const line = new St.BoxLayout({
                style_class: 'sticky-swatch-row',
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (const index of row) {
                const name = PALETTE[index];
                const button = new St.Button({
                    style_class: `sticky-swatch ${name}${index === view.note.color ? ' current' : ''}`,
                    width: 22,
                    height: 22,
                    can_focus: false,
                    accessible_name: COLOR_LABELS[name],
                });
                button.connectObject('clicked', () => {
                    this._setColor(view, index);
                    this._markCurrent(colors, index);
                }, this);
                line.add_child(button);
            }
            colors.add_child(line);
        }
        menu.box.add_child(colors);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const later = fn => {
            this._menuThen = fn;
        };
        menu.addAction('New note', () => later(() => this._create(null)), 'document-new-symbolic');
        menu.addAction('Duplicate', () => later(() => this._duplicate(view)), 'view-dual-symbolic');
        menu.addAction(
            view.note.locked ? 'Unlock' : 'Lock',
            () => later(() => this._toggleLock(view)),
            view.note.locked ? 'changes-prevent-symbolic' : 'changes-allow-symbolic');
        menu.addAction('Smaller text', () => later(() => this._stepSize(view, -1)), 'zoom-out-symbolic');
        menu.addAction('Larger text', () => later(() => this._stepSize(view, 1)), 'zoom-in-symbolic');
        menu.addAction('Delete', () => later(() => this._delete(view)), 'user-trash-symbolic');

        this._menu = menu;
        this._menuView = view;
        this._menuId = menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                this._scheduleMenuDrop();
        });
        Main.layoutManager.uiGroup.add_child(menu.actor);
        menu.open();
    }

    _markCurrent(colors, index) {
        const name = PALETTE[index];
        for (const row of colors.get_children()) {
            if (!row.has_style_class_name || !row.has_style_class_name('sticky-swatch-row'))
                continue;
            for (const button of row.get_children()) {
                if (button.has_style_class_name(name))
                    button.add_style_class_name('current');
                else
                    button.remove_style_class_name('current');
            }
        }
    }

    _scheduleMenuDrop() {
        if (this._menuDropId) {
            GLib.Source.remove(this._menuDropId);
            this._menuDropId = 0;
        }
        this._menuDropId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._menuDropId = 0;
            if (this._dead)
                return GLib.SOURCE_REMOVE;
            const then = this._menuThen;
            this._menuThen = null;
            this._closeMenu();
            if (then)
                then();
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeMenu() {
        if (this._menuDropId) {
            GLib.Source.remove(this._menuDropId);
            this._menuDropId = 0;
            this._menuThen = null;
        }
        if (!this._menu)
            return;
        if (this._menuId) {
            this._menu.disconnect(this._menuId);
            this._menuId = 0;
        }
        this._menuView = null;
        this._menu.destroy();
        this._menu = null;
    }
}
