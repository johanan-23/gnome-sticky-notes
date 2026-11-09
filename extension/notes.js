import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    attributeRuns,
    backspaceMarker,
    charOffset,
    editRange,
    editSizes,
    endList,
    ensureMarker,
    inheritedStyle,
    lineMark,
    listContinuation,
    markAt,
    paintStyle,
    retargetSizes,
    retargetSpans,
    selectionSize,
    selectionStyle,
    shiftSpans,
    stepSize,
    stepSizes,
    toggleBit,
    toggleBoxAt,
    typingSize,
    typingStyle,
    utf8Length,
    STYLE_BOLD,
    STYLE_ITALIC,
    STYLE_STRIKE,
    STYLE_UNDERLINE,
} from './format.js';
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
import {DesktopLayer} from './layer.js';
import {NoteRibbon} from './ribbon.js';

const BUTTON_PRIMARY = 1;
const BUTTON_SECONDARY = 3;
const HANDLE = 18;
// Extra pixels around a checkbox glyph that still count as a hit.
const BOX_SLOP = 3;
const MOVE_KEYS = new Set([
    Clutter.KEY_Left,
    Clutter.KEY_Right,
    Clutter.KEY_Up,
    Clutter.KEY_Down,
    Clutter.KEY_Home,
    Clutter.KEY_End,
    Clutter.KEY_Page_Up,
    Clutter.KEY_Page_Down,
    Clutter.KEY_KP_Left,
    Clutter.KEY_KP_Right,
    Clutter.KEY_KP_Up,
    Clutter.KEY_KP_Down,
    Clutter.KEY_KP_Home,
    Clutter.KEY_KP_End,
    Clutter.KEY_KP_Page_Up,
    Clutter.KEY_KP_Page_Down,
]);
const ENTER_KEYS = new Set([
    Clutter.KEY_Return,
    Clutter.KEY_KP_Enter,
    Clutter.KEY_ISO_Enter,
]);
const PALE_INK = [154, 149, 142].map(channel => Math.round(channel / 255 * 65535));
const PALE_ALPHA = Math.round(0.72 * 65535);

function color4(r, g, b, a) {
    const color = new Cogl.Color();
    color.init_from_4f(r, g, b, a);
    return color;
}

export class NoteBoard {
    constructor(settings) {
        this._settings = settings;
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
        this._textDrag = null;
        this._focused = null;
        this._overview = Main.overview.visible;
        this._path = GLib.build_filenamev([GLib.get_user_data_dir(), 'sticky-notes', 'notes.json']);
        this._cancellable = new Gio.Cancellable();
        this._ink = color4(50 / 255, 47 / 255, 56 / 255, 1);
        this._select = color4(50 / 255, 47 / 255, 56 / 255, 0.16);
        this._desktop = new DesktopLayer();
        this._layer = this._desktop.actor;
        this._menuManager = new PopupMenu.PopupMenuManager(this._layer);

        global.stage.connectObject(
            'captured-event', (_stage, event) => this._onCaptured(event),
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
        this._load();
    }

    destroy() {
        this._cancellable.cancel();
        this._cancellable = null;
        this._queue = [];
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
        this._closeMenu();
        this._menuManager = null;
        if (this._ready)
            this._write();
        this._finishDrag();
        this._finishTextDrag();
        global.stage.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const view of [...this._views.values()])
            this._drop(view);
        this._desktop.destroy();
        this._desktop = null;
        this._layer = null;
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
        this._whenReady(() => {
            this._clampAll();
            if (this._focused)
                this._orderNote(this._focused);
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
        };
    }

    _whenReady(fn) {
        if (this._ready)
            fn();
        else
            this._queue.push(fn);
    }

    _flushQueue() {
        const queue = this._queue;
        this._queue = [];
        for (const fn of queue)
            fn();
    }

    _load() {
        const file = Gio.File.new_for_path(this._path);
        file.load_contents_async(this._cancellable, (_file, res) => {
            let contents;
            try {
                [, contents] = file.load_contents_finish(res);
            } catch (error) {
                if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                const missing = error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
                if (!missing)
                    console.warn(`Sticky Notes: cannot read ${this._path}: ${error.message}`);
                this._useStore(null, !missing);
                return;
            }
            this._useStore(decodeStore(contents, this._workspace()), true);
        });
    }

    _useStore(store, existed) {
        if (!store)
            store = emptyStore();
        const welcome = existed ? null : welcomeNote(this._workAreas(), store.next_id, this._workspace());
        if (welcome) {
            store.next_id += 1;
            store.notes.push(welcome);
        }
        for (const note of store.notes)
            this._clampNote(note);
        this._store = store;
        this._ready = true;
        for (const note of store.notes)
            this._mount(note, false);
        this._applyVisibility();
        if (welcome) {
            this._focus(this._views.get(welcome.id), false);
            this._write();
        }
        this._flushQueue();
    }

    _write() {
        GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o755);
        const bytes = new TextEncoder().encode(`${JSON.stringify(encodeStore(this._store), null, 2)}\n`);
        Gio.File.new_for_path(this._path).replace_contents(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    _scheduleSave() {
        if (!this._ready)
            return;
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveId = 0;
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

    _setOverview(open) {
        this._overview = open;
        this._applyVisibility();
    }

    _onMonitors() {
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
            sizes: [],
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
        const index = this._store.trash.findIndex(note => note.id === id);
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
            this._focusLater(last);
        this._scheduleSave();
    }

    _mount(note, focus) {
        const view = this._build(note);
        this._views.set(note.id, view);
        this._desktop.seat();
        this._layer.add_child(view.frame);
        this._layout(view);
        this._paint(view);
        this._applyVisibility();
        // The panel menu still owns the pointer grab inside its activate
        // handler. Focusing on the next idle lets that grab finish first.
        if (focus)
            this._focusLater(view);
        return view;
    }

    _focusLater(view) {
        if (view.focusId)
            GLib.Source.remove(view.focusId);
        view.focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            view.focusId = 0;
            // A click on another note in this same turn wins.
            if (!this._focused || this._focused === view)
                this._focus(view, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _build(note) {
        const frame = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
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
            cursor_type: Clutter.CursorType.GRAB,
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
            // Return is an activate binding. Leave it off so a newline can be inserted.
            activatable: false,
            single_line_mode: false,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            font_name: `Sans ${note.size}`,
            color: this._ink,
            cursor_color: this._ink,
            selection_color: this._select,
            selected_text_color: this._ink,
            cursor_type: note.locked ? Clutter.CursorType.DEFAULT : Clutter.CursorType.TEXT,
            margin_top: 4,
            margin_bottom: 8,
            margin_left: 12,
            margin_right: 14,
            // Fill the page, so a press below the last line still lands on the text.
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
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
            // The scroll view's pan gesture claims the press in the capture
            // phase and cancels the text's click, so a click never focuses it.
            enable_touch_scrolling: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
            child: page,
        });
        const resize = new St.Widget({
            style_class: 'sticky-note-resize',
            reactive: true,
            cursor_type: Clutter.CursorType.SE_RESIZE,
            width: HANDLE,
            height: HANDLE,
        });
        card.add_child(grip);
        card.add_child(scroll);
        frame.add_child(card);
        frame.add_child(resize);

        const editClick = new Clutter.ClickGesture();
        editClick.set_required_button(BUTTON_PRIMARY);
        // Recognize on release, so a press on the letters still places the caret.
        editClick.set_recognize_on_press(false);

        const view = {
            note, frame, card, grip, text, resize, scroll, editClick,
            editing: false,
            hold: false,
            pending: 0,
            sizeHold: false,
            pendingSize: 0,
            anchor: null,
            rewrite: false,
            rewriteId: 0,
            focusId: 0,
            newlineId: 0,
        };
        editClick.connectObject('recognize', () => {
            if (!view.note.locked)
                this._focus(view, true);
        }, this);
        scroll.add_action(editClick);
        scroll.connectObject(
            'button-press-event', (_actor, event) => this._onBodyPress(view, event),
            this);
        view.ribbon = new NoteRibbon({
            onPointer: () => this._anchor(view),
            onStyle: bit => this._toggleStyle(view, bit),
            onList: kind => this._applyMarker(view, kind),
            onSize: delta => this._stepTextSize(view, delta),
            onKeep: () => this._keepTyping(view),
        });
        card.add_child(view.ribbon.actor);
        grip.connectObject(
            'captured-event', (_actor, event) => this._onHandleEvent(view, 'move', grip, event),
            this);
        resize.connectObject(
            'captured-event', (_actor, event) => this._onHandleEvent(view, 'resize', resize, event),
            this);
        frame.connectObject(
            'captured-event', (_actor, event) => this._onBodyEvent(view, event),
            'button-press-event', (_actor, event) => this._onFramePress(view, event),
            this);
        grip.connectObject(
            'button-press-event', (_actor, event) => this._onGripPress(view, event),
            this);
        text.connectObject(
            'captured-event', (_actor, event) => this._onTextCapture(view, event),
            'button-press-event', (_actor, event) => this._onTextPress(view, event),
            'key-press-event', (_actor, event) => this._onTextKey(view, event),
            'key-focus-in', () => {
                view.editing = true;
                this._focus(view, false);
            },
            'key-focus-out', () => {
                view.editing = false;
                this._dropHold(view);
                this._syncRibbon(view);
            },
            'cursor-changed', () => this._syncRibbon(view),
            'text-changed', () => this._onText(view),
            this);
        // Key controllers run before the actor's key signal. Return's binding
        // is activate, and it does not insert a line, so the newline has to
        // be inserted from the controller that sees the key first.
        view.keyControllers = this._watchTextKeys(view, text);
        return view;
    }

    _watchTextKeys(view, text) {
        const watched = [];
        const actions = text.get_actions();
        const named = text.get_action('Clutter shortcuts key controller');
        if (named && !actions.includes(named))
            actions.push(named);
        for (const action of actions) {
            if (!(action instanceof Clutter.KeyController))
                continue;
            action.connectObject('key-press', () => this._onShortcutKey(view, action), this);
            watched.push(action);
        }
        return watched;
    }

    _layout(view) {
        const {note, frame, card, text, resize} = view;
        frame.set_position(note.x, note.y);
        frame.set_size(note.w, note.h);
        card.set_position(0, 0);
        card.set_size(note.w, note.h);
        text.width = Math.max(48, note.w - 26);
        text.min_height = 0;
        resize.set_position(Math.max(0, note.w - HANDLE), Math.max(0, note.h - HANDLE));
        resize.set_size(HANDLE, HANDLE);
    }

    _paint(view) {
        const name = PALETTE[view.note.color] ?? PALETTE[0];
        for (const color of PALETTE)
            view.card.remove_style_class_name(color);
        view.card.add_style_class_name(name);
        view.text.editable = !view.note.locked;
        const cursor = view.note.locked
            ? Clutter.CursorType.DEFAULT
            : Clutter.CursorType.TEXT;
        view.text.cursor_type = cursor;
        view.frame.cursor_type = cursor;
        view.text.font_name = `Sans ${normalizeSize(view.note.size)}`;
        this._showAttrs(view);
        this._syncRibbon(view);
    }

    _drop(view) {
        for (const key of ['rewriteId', 'focusId', 'newlineId']) {
            if (view[key]) {
                GLib.Source.remove(view[key]);
                view[key] = 0;
            }
        }
        view.pendingText = null;
        if (this._focused === view) {
            if (global.stage.get_key_focus() === view.text)
                global.stage.set_key_focus(null);
            this._focused = null;
        }
        if (this._drag && this._drag.view === view)
            this._finishDrag();
        if (this._textDrag && this._textDrag.view === view)
            this._finishTextDrag();
        if (this._menuView === view)
            this._closeMenu();
        view.resize.disconnectObject(this);
        view.editClick.disconnectObject(this);
        view.scroll.remove_action(view.editClick);
        view.scroll.disconnectObject(this);
        view.frame.disconnectObject(this);
        view.grip.disconnectObject(this);
        view.text.disconnectObject(this);
        for (const controller of view.keyControllers ?? [])
            controller.disconnectObject(this);
        view.ribbon.destroy();
        this._views.delete(view.note.id);
        view.frame.destroy();
    }

    _focus(view, grabText) {
        this._focused = view;
        const parent = view.frame.get_parent();
        if (parent && parent !== this._layer) {
            parent.remove_child(view.frame);
            this._layer.add_child(view.frame);
            this._layout(view);
        }
        this._orderNote(view);
        if (grabText && !view.note.locked && view.frame.visible) {
            view.editing = true;
            view.text.grab_key_focus();
        }
        this._syncRibbon(view);
    }

    _orderNote(view) {
        if (!this._settings.get_boolean('sink-unfocused'))
            return;
        if (view.frame.get_parent() === this._layer)
            this._layer.set_child_above_sibling(view.frame, null);
    }

    _blur() {
        const view = this._focused;
        if (!view)
            return;
        this._focused = null;
        view.editing = false;
        this._dropHold(view);
        this._syncRibbon(view);
        if (global.stage.get_key_focus() === view.text)
            global.stage.set_key_focus(null);
    }

    _onCaptured(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            !this._eventHitsUs(global.stage.get_event_actor(event)))
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
        if (event.get_button() === BUTTON_PRIMARY &&
            !this._onChrome(view, global.stage.get_event_actor(event)))
            this._focus(view, !view.note.locked);
        return Clutter.EVENT_PROPAGATE;
    }

    _onChrome(view, actor) {
        while (actor && actor !== view.frame) {
            if (actor === view.grip || actor === view.resize || actor === view.ribbon.actor)
                return true;
            actor = actor.get_parent();
        }
        return false;
    }

    _onBodyPress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() === BUTTON_PRIMARY && !view.note.locked)
            this._focus(view, true);
        return Clutter.EVENT_PROPAGATE;
    }

    _onGripPress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onTextPress(view, event) {
        if (event.get_button() === BUTTON_SECONDARY) {
            this._openMenu(view);
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() === BUTTON_PRIMARY)
            view.sizeHold = false;
        this._focus(view, !view.note.locked);
        return Clutter.EVENT_PROPAGATE;
    }

    _dropHold(view) {
        view.hold = false;
        view.sizeHold = false;
    }

    // A press on the note body outside the text, in its margins, places the
    // caret and drags a selection the way a press on the text does.
    _onBodyEvent(view, event) {
        const type = event.type();
        const drag = this._textDrag;
        if (drag && drag.view === view) {
            if (type === Clutter.EventType.MOTION) {
                if (event.get_state() & Clutter.ModifierType.BUTTON1_MASK)
                    view.text.set_selection(drag.anchor, this._indexAt(view, event));
                else
                    this._finishTextDrag();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                if (event.get_button() === BUTTON_PRIMARY)
                    this._finishTextDrag();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== BUTTON_PRIMARY ||
            view.note.locked)
            return Clutter.EVENT_PROPAGATE;
        const actor = global.stage.get_event_actor(event);
        if (actor === view.text || this._onChrome(view, actor))
            return Clutter.EVENT_PROPAGATE;
        if (this._pressBox(view, event))
            return Clutter.EVENT_STOP;
        const index = this._indexAt(view, event);
        const extend = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        view.sizeHold = false;
        this._focus(view, true);
        const anchor = extend ? this._clampIndex(view, view.text.selection_bound) : index;
        view.text.set_selection(anchor, index);
        this._textDrag = {view, anchor, grab: global.stage.grab(view.frame)};
        return Clutter.EVENT_STOP;
    }

    _finishTextDrag() {
        const drag = this._textDrag;
        if (!drag)
            return;
        this._textDrag = null;
        drag.grab.dismiss();
    }

    // Character offset nearest a pointer position, which may lie outside the
    // text. Pango indexes bytes, the note text counts characters.
    _indexAt(view, event) {
        const [sx, sy] = event.get_coords();
        const [ok, x, y] = view.text.transform_stage_point(sx, sy);
        if (!ok)
            return this._clampIndex(view, view.text.cursor_position);
        const [ox, oy] = view.text.get_layout_offsets();
        const [, index, trailing] = view.text.get_layout().xy_to_index(
            Math.round((x - ox) * Pango.SCALE),
            Math.round((y - oy) * Pango.SCALE));
        return this._clampIndex(view, charOffset(view.text.text, index) + trailing);
    }

    // Checkbox presses are taken on the way down, before Clutter.Text moves
    // the caret or starts a selection under them.
    _onTextCapture(view, event) {
        if (view.note.locked)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.MOTION) {
            const cursor = this._boxAt(view, event) < 0
                ? Clutter.CursorType.TEXT
                : Clutter.CursorType.POINTER;
            if (view.text.cursor_type !== cursor)
                view.text.cursor_type = cursor;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        return this._pressBox(view, event) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _pressBox(view, event) {
        const start = this._boxAt(view, event);
        const next = start < 0 ? null : toggleBoxAt(view.note.text, start);
        if (next === null)
            return false;
        view.sizeHold = false;
        const cursor = view.text.cursor_position;
        this._focus(view, false);
        this._commitText(view, next, cursor);
        return true;
    }

    // Character offset of the line whose checkbox glyph is under the pointer,
    // or -1. Pango indexes bytes, the note text counts characters.
    _boxAt(view, event) {
        const [sx, sy] = event.get_coords();
        const [ok, x, y] = view.text.transform_stage_point(sx, sy);
        if (!ok)
            return -1;
        const layout = view.text.get_layout();
        const [ox, oy] = view.text.get_layout_offsets();
        let bytes = 0;
        let chars = 0;
        for (const line of view.note.text.split('\n')) {
            const mark = lineMark(line);
            if (mark && mark.kind === 'check') {
                const rect = layout.index_to_pos(bytes);
                const left = ox + Math.min(rect.x, rect.x + rect.width) / Pango.SCALE;
                const top = oy + rect.y / Pango.SCALE;
                const width = Math.abs(rect.width) / Pango.SCALE;
                const height = rect.height / Pango.SCALE;
                if (x >= left - BOX_SLOP && x <= left + width + BOX_SLOP &&
                    y >= top - BOX_SLOP && y < top + height + BOX_SLOP)
                    return chars;
            }
            bytes += utf8Length(line) + 1;
            chars += Array.from(line).length + 1;
        }
        return -1;
    }

    _onShortcutKey(view, controller) {
        const [, keyval] = controller.get_key();
        const [, pressed] = controller.get_state();
        if ((pressed & Clutter.ModifierType.CONTROL_MASK) || !ENTER_KEYS.has(keyval))
            return Clutter.EVENT_PROPAGATE;
        return this._insertNewline(view) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    // The key controller and the key-press signal both see one Enter press.
    // Only the first of them inserts the newline.
    _insertNewline(view) {
        if (view.note.locked || view.newlineId)
            return false;
        view.newlineId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            view.newlineId = 0;
            return GLib.SOURCE_REMOVE;
        });
        const text = view.text;
        if (text.cursor_position === text.selection_bound) {
            const ended = endList(view.note.text, this._clampIndex(view, text.cursor_position));
            if (ended) {
                this._commitText(view, ended.text, ended.cursor);
                return true;
            }
        }
        if (text.cursor_position !== text.selection_bound)
            text.delete_selection();
        // Clutter reports -1 for the end of the text.
        const at = text.cursor_position < 0 ? Array.from(text.text).length : text.cursor_position;
        text.insert_text('\n', at);
        return true;
    }

    _onTextKey(view, event) {
        const key = event.get_key_symbol();
        const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (key === Clutter.KEY_Escape) {
            this._blur();
            return Clutter.EVENT_STOP;
        }
        if (MOVE_KEYS.has(key)) {
            this._dropHold(view);
            return Clutter.EVENT_PROPAGATE;
        }
        if (!control && ENTER_KEYS.has(key))
            return this._insertNewline(view) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (key === Clutter.KEY_BackSpace && !control && !view.note.locked &&
            view.text.cursor_position === view.text.selection_bound) {
            const next = backspaceMarker(view.note.text, view.text.cursor_position);
            if (next) {
                this._commitText(view, next.text, next.cursor);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onText(view) {
        if (view.rewrite)
            return;
        const next = view.text.text;
        const prev = view.note.text;
        if (next === prev)
            return;
        const edit = editRange(prev, next);
        if (edit.removed === 1 && edit.inserted === 0) {
            const marker = backspaceMarker(prev, edit.start + 1);
            if (marker) {
                this._queueText(view, marker.text, marker.cursor);
                return;
            }
        }
        const oldLen = Array.from(prev).length;
        let spans = shiftSpans(view.note.spans, oldLen, edit.start, edit.removed, edit.inserted);
        let sizes = editSizes(view.note.sizes, prev, edit.start, edit.removed, edit.inserted,
            view.sizeHold ? view.pendingSize : null);
        const newLen = oldLen - edit.removed + edit.inserted;
        if (edit.inserted > 0) {
            const style = view.hold
                ? view.pending
                : edit.removed === 0 ? inheritedStyle(view.note.spans, oldLen, edit.start) : 0;
            if (style)
                spans = paintStyle(spans, newLen, edit.start, edit.start + edit.inserted, style);
        }
        if (edit.inserted === 1 && edit.removed === 0 && Array.from(next)[edit.start] === '\n') {
            const prefix = listContinuation(next, edit.start);
            if (prefix) {
                const at = edit.start + 1;
                const prefixChars = Array.from(prefix);
                const merged = Array.from(next);
                merged.splice(at, 0, ...prefixChars);
                spans = shiftSpans(spans, newLen, at, 0, prefixChars.length);
                spans = paintStyle(spans, merged.length, at, at + prefixChars.length, 0);
                sizes = editSizes(sizes, next, at, 0, prefixChars.length);
                // The key handler places the caret after this signal returns.
                // Apply the marker on the next idle, or the caret lands in front of it.
                this._queueText(view, merged.join(''), at + prefixChars.length, spans, sizes);
                return;
            }
        }
        view.note.text = next;
        view.note.spans = spans;
        view.note.sizes = sizes;
        this._showAttrs(view);
        this._syncRibbon(view);
        this._scheduleSave();
    }

    // Without spans or sizes, both follow the edit from the current note text.
    _queueText(view, text, cursor, spans = null, sizes = null) {
        spans ??= retargetSpans(view.note.spans, view.note.text, text);
        sizes ??= retargetSizes(view.note.sizes, view.note.text, text);
        view.pendingText = {text, cursor, spans, sizes};
        if (view.rewriteId) {
            GLib.Source.remove(view.rewriteId);
            view.rewriteId = 0;
        }
        view.rewriteId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            view.rewriteId = 0;
            const pending = view.pendingText;
            view.pendingText = null;
            if (pending)
                this._commitText(view, pending.text, pending.cursor, pending.spans, pending.sizes);
            return GLib.SOURCE_REMOVE;
        });
    }

    _commitText(view, text, cursor, spans = null, sizes = null) {
        spans ??= retargetSpans(view.note.spans, view.note.text, text);
        sizes ??= retargetSizes(view.note.sizes, view.note.text, text);
        view.rewrite = true;
        view.note.text = text;
        view.note.spans = spans;
        view.note.sizes = sizes;
        view.text.set_text(text);
        view.text.set_cursor_position(cursor);
        view.rewrite = false;
        this._showAttrs(view);
        this._syncRibbon(view);
        this._scheduleSave();
    }

    _anchor(view) {
        view.anchor = this._range(view);
    }

    // Clutter reports -1 for the end of the text.
    _clampIndex(view, value) {
        const length = Array.from(view.note.text).length;
        return value < 0 ? length : Math.min(value, length);
    }

    _range(view) {
        const start = this._clampIndex(view, view.text.cursor_position);
        const end = this._clampIndex(view, view.text.selection_bound);
        return [Math.min(start, end), Math.max(start, end)];
    }

    _toggleStyle(view, bit) {
        if (view.note.locked)
            return;
        const length = Array.from(view.note.text).length;
        const [start, end] = view.anchor ?? this._range(view);
        if (start !== end) {
            const result = toggleBit(view.note.spans, length, start, end, bit);
            view.note.spans = result.spans;
            view.pending = result.bits;
            view.hold = true;
            this._showAttrs(view);
            view.text.set_selection(start, end);
            this._scheduleSave();
        } else {
            view.pending ^= bit;
            view.hold = true;
        }
        this._keepTyping(view);
    }

    _applyMarker(view, kind) {
        if (view.note.locked)
            return;
        const cursor = view.anchor ? view.anchor[1] : this._range(view)[1];
        const next = ensureMarker(view.note.text, cursor, kind);
        if (!next)
            return;
        this._commitText(view, next.text, next.cursor);
        this._keepTyping(view);
    }

    // Resizes the selected text. With nothing selected, it sets the size of
    // the text typed next; the note's own size changes from its menu.
    _stepTextSize(view, delta) {
        if (view.note.locked)
            return;
        const base = normalizeSize(view.note.size);
        const length = Array.from(view.note.text).length;
        const [start, end] = view.anchor ?? this._range(view);
        if (start !== end) {
            view.note.sizes = stepSizes(view.note.sizes, length, start, end, base, delta);
            this._showAttrs(view);
            view.text.set_selection(start, end);
            this._scheduleSave();
        } else {
            const current = view.sizeHold
                ? view.pendingSize
                : typingSize(view.note.sizes, view.note.text, end);
            const next = stepSize(current || base, delta);
            view.pendingSize = next === base ? 0 : next;
            view.sizeHold = true;
        }
        this._keepTyping(view);
    }

    _keepTyping(view) {
        if (!view.note.locked && global.stage.get_key_focus() !== view.text) {
            view.editing = true;
            view.text.grab_key_focus();
        }
        this._syncRibbon(view);
    }

    _toolBits(view) {
        const length = Array.from(view.note.text).length;
        const [start, end] = this._range(view);
        const selected = selectionStyle(view.note.spans, length, start, end);
        if (selected !== null)
            return selected;
        if (view.hold)
            return view.pending;
        const bits = typingStyle(view.note.spans, length, end);
        view.pending = bits;
        return bits;
    }

    // Null when the selection mixes sizes.
    _toolSize(view) {
        const base = normalizeSize(view.note.size);
        const length = Array.from(view.note.text).length;
        const [start, end] = this._range(view);
        if (start !== end)
            return selectionSize(view.note.sizes, length, start, end, base);
        if (!view.sizeHold)
            view.pendingSize = typingSize(view.note.sizes, view.note.text, end);
        return view.pendingSize || base;
    }

    _syncRibbon(view) {
        if (!view.ribbon.actor.get_parent())
            return;
        const editing = view.editing && global.stage.get_key_focus() === view.text;
        const show = !view.note.locked && view.frame.visible && editing;
        const was = view.ribbon.visible();
        view.ribbon.setVisible(show);
        view.ribbon.setSize(this._toolSize(view));
        view.ribbon.setMarks(this._toolBits(view));
        view.ribbon.setList(markAt(view.note.text, this._range(view)[1]));
        if (was !== show)
            this._layout(view);
    }

    _showAttrs(view) {
        const runs = attributeRuns(view.note.text, view.note.spans, view.note.sizes);
        if (!runs.length) {
            view.text.set_attributes(null);
            return;
        }
        const list = new Pango.AttrList();
        for (const run of runs)
            this._addRun(list, run);
        view.text.set_attributes(list);
        view.text.queue_relayout();
    }

    _addRun(list, run) {
        const add = attr => {
            attr.start_index = run.start;
            attr.end_index = run.end;
            list.insert(attr);
        };
        if (run.style & STYLE_BOLD)
            add(Pango.attr_weight_new(Pango.Weight.BOLD));
        if (run.style & STYLE_ITALIC)
            add(Pango.attr_style_new(Pango.Style.ITALIC));
        if (run.style & STYLE_UNDERLINE)
            add(Pango.attr_underline_new(Pango.Underline.SINGLE));
        if ((run.style & STYLE_STRIKE) || run.done)
            add(Pango.attr_strikethrough_new(true));
        if (run.done) {
            add(Pango.attr_foreground_new(PALE_INK[0], PALE_INK[1], PALE_INK[2]));
            add(Pango.attr_foreground_alpha_new(PALE_ALPHA));
        }
        if (run.size)
            add(Pango.attr_size_new(run.size * Pango.SCALE));
    }

    // A press on the grip or the corner holds a stage grab until the button
    // is released. Without it, once the cursor outruns the note the desktop
    // window under it receives the motion and the drag stalls.
    _onHandleEvent(view, mode, actor, event) {
        const type = event.type();
        const drag = this._drag;
        if (drag && drag.actor === actor) {
            if (type === Clutter.EventType.MOTION) {
                if (event.get_state() & Clutter.ModifierType.BUTTON1_MASK)
                    this._applyPointer(event);
                else
                    this._finishDrag();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                if (event.get_button() === BUTTON_PRIMARY)
                    this._finishDrag();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.SCROLL)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === BUTTON_PRIMARY) {
            this._beginDrag(view, mode, actor, event);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _beginDrag(view, mode, actor, event) {
        this._finishDrag();
        this._focus(view, false);
        const grab = global.stage.grab(actor);
        const [px, py] = event.get_coords();
        const cursor = mode === 'move'
            ? Clutter.CursorType.GRABBING
            : Clutter.CursorType.SE_RESIZE;
        if (mode === 'move')
            view.grip.cursor_type = cursor;
        // Shown while the pointer is ahead of the handle, until it catches up.
        const stageCursor = global.stage.cursor_type;
        global.stage.cursor_type = cursor;
        this._drag = {
            view,
            mode,
            actor,
            grab,
            stageCursor,
            originX: view.note.x,
            originY: view.note.y,
            originW: view.note.w,
            originH: view.note.h,
            pointerX: px,
            pointerY: py,
        };
    }

    _applyPointer(event) {
        const drag = this._drag;
        const [px, py] = event.get_coords();
        const dx = Math.round(px - drag.pointerX);
        const dy = Math.round(py - drag.pointerY);
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

    _finishDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        const view = drag.view;
        this._drag = null;
        drag.grab.dismiss();
        global.stage.cursor_type = drag.stageCursor;
        view.grip.cursor_type = Clutter.CursorType.GRAB;
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
            sizes: source.sizes.map(run => ({...run})),
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
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        menu.open();
    }

    _markCurrent(colors, index) {
        const name = PALETTE[index];
        for (const row of colors.get_children()) {
            if (!row.has_style_class_name('sticky-swatch-row'))
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
