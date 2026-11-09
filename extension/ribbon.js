// Formatting bar shown on the note while its text is focused.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {
    STYLE_BOLD,
    STYLE_ITALIC,
    STYLE_STRIKE,
    STYLE_UNDERLINE,
} from './format.js';

const STYLES = [
    {bit: STYLE_BOLD, icon: 'format-text-bold-symbolic', name: 'Bold'},
    {bit: STYLE_ITALIC, icon: 'format-text-italic-symbolic', name: 'Italic'},
    {bit: STYLE_UNDERLINE, icon: 'format-text-underline-symbolic', name: 'Underline'},
    {bit: STYLE_STRIKE, icon: 'format-text-strikethrough-symbolic', name: 'Strikethrough'},
];

export class NoteRibbon {
    constructor(handlers) {
        this._onKeep = handlers.onKeep;
        this._offset = 0;
        this._laterId = 0;
        this.actor = new St.Widget({
            style_class: 'sticky-note-ribbon',
            layout_manager: new Clutter.BinLayout(),
            // Only as wide as the tools, so a wide note does not stretch the bar.
            x_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
            visible: false,
            reactive: true,
            // The note body under the bar shows a text cursor.
            cursor_type: Clutter.CursorType.DEFAULT,
        });
        // The tools ask for no minimum width here. A narrow note then clips
        // them instead of pushing the bar past the card's right edge.
        this._view = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            x_expand: true,
            min_width: 0,
        });
        this._row = new St.BoxLayout({style_class: 'sticky-note-ribbon-row'});
        this._view.add_child(this._row);
        // The arrows sit over the ends of the row, so showing one never
        // changes how much room the tools have.
        this._left = this._arrow('go-previous-symbolic', 'Show earlier tools', Clutter.ActorAlign.START, -1);
        this._right = this._arrow('go-next-symbolic', 'Show later tools', Clutter.ActorAlign.END, 1);
        this.actor.add_child(this._view);
        this.actor.add_child(this._left);
        this.actor.add_child(this._right);

        this._styles = [];
        this._tracked = [this._left, this._right];
        for (const style of STYLES)
            this._styles.push([style.bit, this._add(style.icon, style.name, () => handlers.onStyle(style.bit))]);
        this._lists = [
            ['check', this._add('checkbox-symbolic', 'Checkbox', () => handlers.onList('check'))],
            ['bullet', this._add('view-list-bullet-symbolic', 'Bullet', () => handlers.onList('bullet'))],
        ];
        this._add('zoom-out-symbolic', 'Smaller text', () => handlers.onSize(-1));
        this._size = new St.Label({
            text: '13',
            style_class: 'sticky-note-size',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._row.add_child(this._size);
        this._add('zoom-in-symbolic', 'Larger text', () => handlers.onSize(1));

        this.actor.connectObject(
            'captured-event', (_actor, event) => this._onCapture(event, handlers),
            this);
        this._view.connectObject('notify::allocation', () => this._queueRefresh(), this);
        this._row.connectObject('notify::allocation', () => this._queueRefresh(), this);
    }

    _onCapture(event, handlers) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        handlers.onPointer();
        return Clutter.EVENT_PROPAGATE;
    }

    _arrow(icon, name, align, direction) {
        const button = this._tool(icon, name, 'sticky-note-tool sticky-note-ribbon-arrow');
        // A bin layout centers a child that does not expand, whatever its align.
        button.x_expand = true;
        button.x_align = align;
        button.y_align = Clutter.ActorAlign.FILL;
        button.visible = false;
        this._onPress(button, () => this._step(direction));
        return button;
    }

    _add(icon, name, onClick) {
        const button = this._tool(icon, name, 'sticky-note-tool');
        this._onPress(button, onClick);
        this._tracked.push(button);
        this._row.add_child(button);
        return button;
    }

    // A plain widget, not St.Button. The button's click gesture claims the
    // press before a "clicked" handler runs, and the text selection is gone
    // by the time the style toggle reads it.
    _tool(icon, name, styleClass) {
        const button = new St.Widget({
            style_class: styleClass,
            reactive: true,
            can_focus: false,
            track_hover: true,
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
            accessible_name: name,
        });
        button.add_child(new St.Icon({
            icon_name: icon,
            icon_size: 14,
        }));
        return button;
    }

    _onPress(button, onClick) {
        button.connectObject('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            onClick();
            return Clutter.EVENT_STOP;
        }, this);
    }

    _overflow() {
        const viewW = this._view.get_allocation_box().get_width();
        const [, rowW] = this._row.get_preferred_width(-1);
        return [viewW, Math.max(0, Math.ceil(rowW - viewW))];
    }

    // One page per press. Each page starts where the arrow covered the last,
    // and a page that would stop within an arrow's width of an end goes there.
    _step(direction) {
        const [viewW, max] = this._overflow();
        const [, arrowW] = this._right.get_preferred_width(-1);
        let offset = this._offset + direction * Math.max(arrowW, viewW - 2 * arrowW);
        if (offset < arrowW)
            offset = 0;
        else if (offset > max - arrowW)
            offset = max;
        this._offset = offset;
        this._refresh();
        this._onKeep();
    }

    // Allocation is still running when it is announced. Showing an arrow
    // from inside it would ask for another layout pass mid-pass.
    _queueRefresh() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        if (!this.actor.visible || !this.actor.get_stage())
            return;
        const [, max] = this._overflow();
        this._offset = Math.max(0, Math.min(this._offset, max));
        this._showArrow(this._left, this._offset > 0);
        this._showArrow(this._right, this._offset < max);
        if (this._row.translation_x !== -this._offset)
            this._row.translation_x = -this._offset;
    }

    _showArrow(button, show) {
        if (button.visible !== show)
            button.visible = show;
    }

    setVisible(show) {
        if (this.actor.visible === show)
            return;
        this.actor.visible = show;
        if (show)
            this._queueRefresh();
    }

    visible() {
        return this.actor.visible;
    }

    // Null when the selection mixes sizes.
    setSize(size) {
        const label = size === null ? '\u2013' : String(size);
        if (this._size.text !== label)
            this._size.text = label;
    }

    setMarks(bits) {
        for (const [bit, button] of this._styles)
            this._light(button, (bits & bit) !== 0);
    }

    setList(kind) {
        for (const [name, button] of this._lists)
            this._light(button, name === kind);
    }

    _light(button, on) {
        if (on)
            button.add_style_class_name('on');
        else
            button.remove_style_class_name('on');
    }

    destroy() {
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        this.actor.disconnectObject(this);
        this._view.disconnectObject(this);
        this._row.disconnectObject(this);
        for (const button of this._tracked)
            button.disconnectObject(this);
        this._tracked = [];
        this._styles = [];
        this._lists = [];
        this.actor.destroy();
    }
}
