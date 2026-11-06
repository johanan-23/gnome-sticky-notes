//! One small undecorated window per note. Nothing animates, and nothing
//! runs on a timer unless an edit is waiting to be saved.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gtk4::gdk;
use gtk4::gio;
use gtk4::glib;
use gtk4::prelude::*;
use gtk4::{self, ApplicationWindow};

use crate::edit;
use crate::geom::{self, Rect};
use crate::store::{
    self, Note, Store, LIMIT_H, LIMIT_W, MAX_H, MAX_W, MIN_H, MIN_W, PALETTE, STYLE_BOLD,
    STYLE_ITALIC, STYLE_STRIKE, STYLE_UNDERLINE,
};

pub struct NoteUi {
    window: ApplicationWindow,
    card: gtk4::Box,
    view: gtk4::TextView,
    ribbon: gtk4::Box,
    size_label: gtk4::Label,
    size_down: gtk4::Button,
    size_up: gtk4::Button,
}

pub struct App {
    pub application: gtk4::Application,
    pub store: Store,
    pub path: PathBuf,
    pub workareas: Vec<Rect>,
    pub pending: Vec<Rect>,
    windows: HashMap<u64, NoteUi>,
    save_id: Option<glib::SourceId>,
    dirty_place: Vec<u64>,
    pub fresh: bool,
    pub note_w: i32,
    pub note_h: i32,
    pub max_w: i32,
    pub max_h: i32,
}

pub fn start(application: gtk4::Application, path: PathBuf) -> Rc<RefCell<App>> {
    if let Some(settings) = gtk4::Settings::default() {
        settings.set_gtk_enable_animations(false);
    }
    let provider = gtk4::CssProvider::new();
    provider.load_from_string(include_str!("style.css"));
    if let Some(display) = gdk::Display::default() {
        gtk4::style_context_add_provider_for_display(
            &display,
            &provider,
            gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }

    let (mut store, existed) = store::load(&path);
    let fresh = !existed;
    if fresh {
        let id = store.alloc_id();
        store.notes.push(Note {
            id,
            x: 160,
            y: 120,
            w: 240,
            h: 196,
            expanded_h: 196,
            color: 0,
            size: 13,
            collapsed: false,
            locked: false,
            text: "Drag the top edge to move.\nRight-click to pick a color.\nClick the text to format it.\n\nThe note icon on the top bar opens the note menu.\n\nCtrl+Super+N    new note\nCtrl+Super+H    hide notes\n".into(),
            spans: Vec::new(),
        });
    }

    let app = Rc::new(RefCell::new(App {
        application: application.clone(),
        store,
        path,
        workareas: Vec::new(),
        pending: Vec::new(),
        windows: HashMap::new(),
        save_id: None,
        dirty_place: Vec::new(),
        fresh,
        note_w: 230,
        note_h: 180,
        max_w: MAX_W,
        max_h: MAX_H,
    }));

    install_app_actions(&app);
    let ids: Vec<u64> = app.borrow().store.notes.iter().map(|note| note.id).collect();
    for id in ids {
        open_note(&app, id, false);
    }
    if fresh {
        flush_save(&app);
    }
    app
}

fn install_app_actions(app: &Rc<RefCell<App>>) {
    let application = app.borrow().application.clone();

    let new_note = gio::SimpleAction::new("new-note", None);
    let app_new = Rc::downgrade(app);
    new_note.connect_activate(move |_, _| {
        let Some(app) = app_new.upgrade() else { return };
        create_note(&app, None, true);
    });
    application.add_action(&new_note);
    application.set_accels_for_action("app.new-note", &["<primary>n"]);

    let restore = gio::SimpleAction::new("restore", None);
    let app_restore = Rc::downgrade(app);
    restore.connect_activate(move |_, _| {
        let Some(app) = app_restore.upgrade() else { return };
        restore_deleted(&app, None);
    });
    application.add_action(&restore);
    refresh_restore(&app);
}

const NOTE_GAP: i32 = 16;

/// Pointer clicks land on empty space. Menu and shortcut notes take the
/// nearest open slot on the monitor the user is already working on.
fn fresh_origin(app: &Rc<RefCell<App>>, at: Option<(i32, i32)>, w: i32, h: i32) -> (i32, i32) {
    let prefer = at.or_else(|| focused_origin(app));
    let a = app.borrow();
    let obstacles: Vec<(i32, i32, i32, i32)> = a
        .store
        .notes
        .iter()
        .map(|note| (note.x, note.y, note.w, note.h))
        .collect();
    if let Some((px, py)) = at {
        let origin = (px - 20, py - 10);
        if !geom::overlaps(origin.0, origin.1, w, h, NOTE_GAP, &obstacles) {
            return origin;
        }
    }
    geom::free_origin(&obstacles, &a.workareas, w, h, prefer)
}

fn focused_origin(app: &Rc<RefCell<App>>) -> Option<(i32, i32)> {
    let a = app.borrow();
    let active = a.application.active_window()?;
    for note in &a.store.notes {
        if let Some(ui) = a.windows.get(&note.id) {
            if ui.window.eq(&active) {
                return Some((note.x, note.y));
            }
        }
    }
    None
}

pub fn create_note(app: &Rc<RefCell<App>>, at: Option<(i32, i32)>, focus: bool) {
    if app.borrow().store.hidden {
        set_hidden(app, false);
    }
    let (w, h) = {
        let a = app.borrow();
        (a.note_w.min(a.max_w), a.note_h.min(a.max_h))
    };
    let (x, y) = fresh_origin(app, at, w, h);
    let id = {
        let mut a = app.borrow_mut();
        let color = (a.store.notes.len() % PALETTE.len()) as u8;
        let id = a.store.alloc_id();
        let mut note = Note {
            id,
            x,
            y,
            w,
            h,
            expanded_h: h,
            color,
            size: 13,
            collapsed: false,
            locked: false,
            text: String::new(),
            spans: Vec::new(),
        };
        let areas = a.workareas.clone();
        let max_w = a.max_w;
        let max_h = a.max_h;
        note.clamp_to(&areas, max_w, max_h);
        a.store.notes.push(note);
        id
    };
    open_note(app, id, focus);
    flush_save(app);
}

pub fn toggle_hidden(app: &Rc<RefCell<App>>) {
    let hidden = !app.borrow().store.hidden;
    set_hidden(app, hidden);
    flush_save(app);
}

fn set_hidden(app: &Rc<RefCell<App>>, hidden: bool) {
    let windows: Vec<ApplicationWindow> = {
        let mut a = app.borrow_mut();
        a.store.hidden = hidden;
        a.windows.values().map(|ui| ui.window.clone()).collect()
    };
    for window in windows {
        window.set_visible(!hidden);
    }
    if !hidden {
        mark_all_dirty(app);
        flush_place(app);
    }
}

pub fn set_workareas(app: &Rc<RefCell<App>>, areas: Vec<Rect>) {
    let areas: Vec<Rect> = areas
        .into_iter()
        .filter(|area| area.w >= 320 && area.h >= 240)
        .collect();
    if areas.is_empty() {
        return;
    }
    {
        let mut a = app.borrow_mut();
        a.workareas = areas;
        let fresh = a.fresh;
        a.fresh = false;
        let area = a.workareas.first().copied();
        if fresh {
            if let (Some(area), Some(note)) = (area, a.store.notes.first_mut()) {
                note.x = area.x + (area.w - note.w) / 2;
                note.y = area.y + (area.h - note.h) / 2;
            }
        }
        let areas = a.workareas.clone();
        let max_w = a.max_w;
        let max_h = a.max_h;
        for note in &mut a.store.notes {
            note.clamp_to(&areas, max_w, max_h);
        }
    }
    mark_all_dirty(app);
    flush_place(app);
    flush_save(app);
}

fn mark_all_dirty(app: &Rc<RefCell<App>>) {
    let mut a = app.borrow_mut();
    a.dirty_place = a.store.notes.iter().map(|note| note.id).collect();
}

fn open_note(app: &Rc<RefCell<App>>, id: u64, focus: bool) {
    let snapshot = {
        let a = app.borrow();
        a.store.note(id).cloned()
    };
    let Some(note) = snapshot else { return };

    let window = ApplicationWindow::builder()
        .application(&app.borrow().application)
        .title(note.title())
        .decorated(false)
        .resizable(true)
        .deletable(false)
        .default_width(note.w)
        .default_height(note.h)
        .show_menubar(false)
        .build();
    window.add_css_class("noteshell");
    window.set_hide_on_close(true);
    window.set_size_request(MIN_W, MIN_H);

    let card = gtk4::Box::new(gtk4::Orientation::Vertical, 0);
    card.add_css_class("card");
    card.set_hexpand(true);
    card.set_vexpand(true);

    let grip = gtk4::Box::new(gtk4::Orientation::Vertical, 0);
    grip.add_css_class("grip");
    let pill = gtk4::Box::new(gtk4::Orientation::Horizontal, 0);
    pill.add_css_class("pill");
    pill.set_halign(gtk4::Align::Center);
    pill.set_valign(gtk4::Align::Center);
    pill.set_can_target(false);
    grip.append(&pill);
    grip.set_cursor_from_name(Some("grab"));

    let view = gtk4::TextView::builder()
        .wrap_mode(gtk4::WrapMode::WordChar)
        .accepts_tab(false)
        .left_margin(12)
        .right_margin(14)
        .top_margin(4)
        .bottom_margin(12)
        .monospace(false)
        .build();
    edit::load(&view.buffer(), &note.text, &note.spans);

    let scroll = gtk4::ScrolledWindow::builder()
        .child(&view)
        .hscrollbar_policy(gtk4::PolicyType::Never)
        .vscrollbar_policy(gtk4::PolicyType::Automatic)
        .propagate_natural_height(false)
        .hexpand(true)
        .vexpand(true)
        .build();

    let (ribbon, size_label, size_down, size_up) = install_editor(app, id, &view);
    card.append(&grip);
    card.append(&scroll);
    card.append(&ribbon);

    let resize = gtk4::Box::new(gtk4::Orientation::Horizontal, 0);
    resize.add_css_class("resize");
    resize.set_halign(gtk4::Align::End);
    resize.set_valign(gtk4::Align::End);
    resize.set_cursor_from_name(Some("se-resize"));
    resize.set_size_request(16, 16);

    let overlay = gtk4::Overlay::new();
    overlay.set_child(Some(&card));
    overlay.add_overlay(&resize);
    window.set_child(Some(&overlay));

    let ui = NoteUi {
        window: window.clone(),
        card: card.clone(),
        view: view.clone(),
        ribbon: ribbon.clone(),
        size_label,
        size_down,
        size_up,
    };
    apply_look(&ui, &note, true);
    app.borrow_mut().windows.insert(id, ui);

    install_note_actions(app, id, &window);
    install_drag(&grip);
    install_resize(&resize);
    install_menu(app, id, &grip, &view);

    let app_close = Rc::downgrade(app);
    window.connect_close_request(move |window| {
        window.set_visible(false);
        if let Some(app) = app_close.upgrade() {
            // Closing the frame hides every note; the process stays up for the shortcut.
            set_hidden(&app, true);
            flush_save(&app);
        }
        glib::Propagation::Stop
    });

    if !app.borrow().store.hidden {
        window.set_visible(true);
    }
    mark_dirty(app, id);
    flush_place(app);
    if focus && !note.locked {
        view.grab_focus();
    }
}

fn install_note_actions(app: &Rc<RefCell<App>>, id: u64, window: &ApplicationWindow) {
    let group = gio::SimpleActionGroup::new();

    let duplicate = gio::SimpleAction::new("duplicate", None);
    let app_d = Rc::downgrade(app);
    duplicate.connect_activate(move |_, _| {
        let Some(app) = app_d.upgrade() else { return };
        duplicate_note(&app, id);
    });
    group.add_action(&duplicate);

    let delete = gio::SimpleAction::new("delete", None);
    let app_x = Rc::downgrade(app);
    delete.connect_activate(move |_, _| {
        let Some(app) = app_x.upgrade() else { return };
        delete_note(&app, id);
    });
    group.add_action(&delete);

    window.insert_action_group("note", Some(&group));
}

/// Hue order for the swatch grid. Values are palette indexes, so notes
/// saved before the extra colors keep the swatch they already used.
const SWATCH_ORDER: [u8; 16] = [0, 6, 7, 5, 8, 9, 1, 10, 11, 4, 12, 3, 13, 2, 14, 15];

fn color_label(name: &str) -> &'static str {
    match name {
        "sand" => "Sand",
        "blossom" => "Blossom",
        "mint" => "Mint",
        "sky" => "Sky",
        "lilac" => "Lilac",
        "peach" => "Peach",
        "lemon" => "Lemon",
        "cream" => "Cream",
        "apricot" => "Apricot",
        "coral" => "Coral",
        "rose" => "Rose",
        "mauve" => "Mauve",
        "iris" => "Iris",
        "mist" => "Mist",
        "sage" => "Sage",
        "aqua" => "Aqua",
        _ => "Color",
    }
}

fn custom_item(id: &str) -> gio::MenuItem {
    let item = gio::MenuItem::new(None, None);
    item.set_attribute_value("custom", Some(&id.to_variant()));
    item
}

fn action_item(label: &str, action: &str, icon: &str) -> gio::MenuItem {
    let item = gio::MenuItem::new(Some(label), Some(action));
    item.set_icon(&gio::ThemedIcon::new(icon));
    item
}

fn note_actions() -> gio::Menu {
    let menu = gio::Menu::new();
    menu.append_item(&action_item(
        "New note",
        "app.new-note",
        "document-new-symbolic",
    ));
    menu.append_item(&action_item(
        "Duplicate",
        "note.duplicate",
        "view-dual-symbolic",
    ));
    menu.append_item(&custom_item("lock"));
    menu.append_item(&action_item("Delete", "note.delete", "user-trash-symbolic"));
    menu
}

fn note_menu() -> gio::Menu {
    let menu = gio::Menu::new();
    menu.append_item(&custom_item("colors"));
    menu.append_section(None, &note_actions());
    menu
}

fn text_menu() -> gio::Menu {
    let menu = gio::Menu::new();
    menu.append_item(&custom_item("colors"));
    menu.append_item(&action_item("Cut", "clipboard.cut", "edit-cut-symbolic"));
    menu.append_item(&action_item("Copy", "clipboard.copy", "edit-copy-symbolic"));
    menu.append_item(&action_item(
        "Paste",
        "clipboard.paste",
        "edit-paste-symbolic",
    ));
    menu.append_item(&action_item(
        "Select all",
        "selection.select-all",
        "edit-select-all-symbolic",
    ));
    menu.append_section(None, &note_actions());
    menu
}

fn color_picker(app: &Rc<RefCell<App>>, id: u64) -> (gtk4::Box, gtk4::Grid) {
    let wrap = gtk4::Box::new(gtk4::Orientation::Vertical, 6);
    wrap.set_margin_top(2);
    wrap.set_margin_bottom(4);
    wrap.set_margin_start(8);
    wrap.set_margin_end(8);
    let caption = gtk4::Label::new(Some("Color"));
    caption.add_css_class("swatch-caption");
    caption.set_halign(gtk4::Align::Start);
    wrap.append(&caption);

    let grid = gtk4::Grid::new();
    grid.set_column_spacing(6);
    grid.set_row_spacing(6);
    grid.set_halign(gtk4::Align::Center);
    let columns = 8;
    for (place, index) in SWATCH_ORDER.iter().copied().enumerate() {
        let name = PALETTE.get(index as usize).copied().unwrap_or("sand");
        let button = gtk4::Button::new();
        button.add_css_class("swatch");
        button.add_css_class(name);
        button.set_size_request(22, 22);
        button.set_tooltip_text(Some(color_label(name)));
        button.set_can_focus(false);
        button.set_focus_on_click(false);
        let app_b = Rc::downgrade(app);
        let grid_b = grid.clone();
        button.connect_clicked(move |clicked| {
            let Some(app) = app_b.upgrade() else { return };
            mutate_note(&app, id, false, |note| note.color = index);
            mark_swatches(&grid_b, index);
            clicked.add_css_class("current");
        });
        grid.attach(
            &button,
            (place % columns) as i32,
            (place / columns) as i32,
            1,
            1,
        );
    }
    wrap.append(&grid);
    (wrap, grid)
}

fn mark_swatches(grid: &gtk4::Grid, color: u8) {
    let want = PALETTE.get(color as usize).copied().unwrap_or("");
    let mut child = grid.first_child();
    while let Some(widget) = child {
        let next = widget.next_sibling();
        if !want.is_empty() && widget.has_css_class(want) {
            widget.add_css_class("current");
        } else {
            widget.remove_css_class("current");
        }
        child = next;
    }
}

fn install_menu(app: &Rc<RefCell<App>>, id: u64, grip: &gtk4::Box, view: &gtk4::TextView) {
    let (grip_colors, grip_grid) = color_picker(app, id);
    let (text_colors, text_grid) = color_picker(app, id);
    attach_popover(app, id, grip, &note_menu(), grip_colors, grip_grid, false);
    attach_popover(app, id, view, &text_menu(), text_colors, text_grid, true);
}

fn lock_row() -> (gtk4::Button, gtk4::Image, gtk4::Label) {
    let image = gtk4::Image::from_icon_name("changes-allow-symbolic");
    image.set_pixel_size(16);
    let label = gtk4::Label::new(Some("Lock"));
    label.set_halign(gtk4::Align::Start);
    label.set_hexpand(true);
    label.set_xalign(0.0);
    let row = gtk4::Box::new(gtk4::Orientation::Horizontal, 10);
    row.append(&image);
    row.append(&label);
    let button = gtk4::Button::new();
    button.set_child(Some(&row));
    button.add_css_class("lockrow");
    button.set_can_focus(false);
    button.set_focus_on_click(false);
    button.set_hexpand(true);
    (button, image, label)
}

fn sync_lock(image: &gtk4::Image, label: &gtk4::Label, locked: bool) {
    if locked {
        image.set_icon_name(Some("changes-prevent-symbolic"));
        label.set_text("Unlock");
    } else {
        image.set_icon_name(Some("changes-allow-symbolic"));
        label.set_text("Lock");
    }
}

fn attach_popover(
    app: &Rc<RefCell<App>>,
    id: u64,
    widget: &impl IsA<gtk4::Widget>,
    menu: &gio::Menu,
    colors: gtk4::Box,
    grid: gtk4::Grid,
    focus_text: bool,
) {
    let popover = gtk4::PopoverMenu::from_model(Some(menu));
    popover.set_parent(widget);
    popover.set_has_arrow(false);
    popover.set_position(gtk4::PositionType::Bottom);
    popover.add_child(&colors, "colors");
    let (lock, lock_image, lock_label) = lock_row();
    popover.add_child(&lock, "lock");
    let app_lock = Rc::downgrade(app);
    let pop_lock = popover.clone();
    lock.connect_clicked(move |_| {
        pop_lock.popdown();
        let Some(app) = app_lock.upgrade() else { return };
        mutate_note(&app, id, false, |note| note.locked = !note.locked);
    });
    let app_show = Rc::downgrade(app);
    let grid_show = grid.clone();
    let image_show = lock_image.clone();
    let label_show = lock_label.clone();
    popover.connect_show(move |_| {
        let Some(app) = app_show.upgrade() else { return };
        let (color, locked) = app
            .borrow()
            .store
            .note(id)
            .map(|note| (note.color, note.locked))
            .unwrap_or((0, false));
        mark_swatches(&grid_show, color);
        sync_lock(&image_show, &label_show, locked);
    });
    let pop = popover.clone();
    let text = focus_text.then(|| widget.clone().upcast::<gtk4::Widget>());
    let app_press = Rc::downgrade(app);
    let click = gtk4::GestureClick::new();
    click.set_button(gdk::BUTTON_SECONDARY);
    click.set_propagation_phase(gtk4::PropagationPhase::Capture);
    click.connect_pressed(move |gesture, _, x, y| {
        if let Some(text) = text.as_ref().and_then(|w| w.downcast_ref::<gtk4::TextView>()) {
            text.grab_focus();
        }
        if let Some(app) = app_press.upgrade() {
            let locked = app
                .borrow()
                .store
                .note(id)
                .map(|note| note.locked)
                .unwrap_or(false);
            sync_lock(&lock_image, &lock_label, locked);
        }
        pop.set_pointing_to(Some(&gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
        pop.popup();
        gesture.set_state(gtk4::EventSequenceState::Claimed);
    });
    widget.add_controller(click);
    let pop = popover.clone();
    widget.connect_destroy(move |_| {
        pop.unparent();
    });
}

fn install_drag(grip: &gtk4::Box) {
    let drag = gtk4::GestureDrag::new();
    drag.set_button(gdk::BUTTON_PRIMARY);
    drag.connect_drag_begin(|gesture, _, _| {
        start_window_op(gesture, None);
    });
    grip.add_controller(drag);
}

fn install_resize(resize: &gtk4::Box) {
    let drag = gtk4::GestureDrag::new();
    drag.set_button(gdk::BUTTON_PRIMARY);
    drag.connect_drag_begin(|gesture, _, _| {
        start_window_op(gesture, Some(gdk::SurfaceEdge::SouthEast));
    });
    resize.add_controller(drag);
}

/// Hand the pointer grab to the compositor. Widget-relative offsets lag
/// behind the window, so the note and the cursor drift apart.
fn start_window_op(gesture: &gtk4::GestureDrag, edge: Option<gdk::SurfaceEdge>) {
    let Some(widget) = gesture.widget() else { return };
    let Some(root) = widget.root() else { return };
    let Ok(window) = root.downcast::<gtk4::Window>() else { return };
    let Some(surface) = window.surface() else { return };
    let Ok(toplevel) = surface.downcast::<gdk::Toplevel>() else { return };
    let Some(device) = gesture.device() else { return };
    let Some((x, y)) = gesture.start_point() else { return };
    let point = gtk4::graphene::Point::new(x as f32, y as f32);
    let Some(mapped) = widget.compute_point(&window, &point) else { return };
    let (sx, sy) = (mapped.x() as f64, mapped.y() as f64);
    let time = gesture.current_event_time();
    let button = gdk::BUTTON_PRIMARY as i32;
    if let Some(edge) = edge {
        toplevel.begin_resize(edge, Some(&device), button, sx, sy, time);
    } else {
        toplevel.begin_move(&device, button, sx, sy, time);
    }
}

/// The shell reports the frame after an interactive move or resize.
pub fn note_moved(app: &Rc<RefCell<App>>, id: u64, x: i32, y: i32, w: i32, h: i32) {
    {
        let mut a = app.borrow_mut();
        let areas = a.workareas.clone();
        let max_w = a.max_w;
        let max_h = a.max_h;
        let Some(note) = a.store.note_mut(id) else { return };
        note.x = x;
        note.y = y;
        note.w = w;
        note.h = h;
        note.clamp_to(&areas, max_w, max_h);
    }
    refresh_note(app, id, true);
    flush_save(app);
}

/// Bottom bar, in the card, so showing it never changes the window frame.
/// Buttons cannot take focus: the caret has to stay in the note.
fn install_editor(
    app: &Rc<RefCell<App>>,
    id: u64,
    view: &gtk4::TextView,
) -> (gtk4::Box, gtk4::Label, gtk4::Button, gtk4::Button) {
    let buffer = view.buffer();
    let busy = Rc::new(Cell::new(false));
    let pending = Rc::new(Cell::new(0u8));
    let hold = Rc::new(Cell::new(false));
    // Backspace on a marker makes the next Enter a plain line, even when
    // that lands the caret on the checkbox above.
    let skip_list = Rc::new(Cell::new(false));

    let ribbon = gtk4::Box::new(gtk4::Orientation::Horizontal, 0);
    ribbon.add_css_class("ribbon");
    ribbon.set_visible(false);
    let bold = tool_icon("format-text-bold-symbolic", "Bold");
    let italic = tool_icon("format-text-italic-symbolic", "Italic");
    let underline = tool_icon("format-text-underline-symbolic", "Underline");
    let strike = tool_icon("format-text-strikethrough-symbolic", "Strikethrough");
    let check = tool_icon("checkbox-symbolic", "Checkbox");
    let bullet = tool_icon("view-list-bullet-symbolic", "Bullet");
    let size_down = tool_text("−", "Smaller text");
    let size_label = gtk4::Label::new(Some("13"));
    size_label.add_css_class("size");
    size_label.set_width_chars(2);
    let size_up = tool_text("+", "Larger text");
    for button in [&bold, &italic, &underline, &strike, &check, &bullet] {
        ribbon.append(button);
    }
    ribbon.append(&size_down);
    ribbon.append(&size_label);
    ribbon.append(&size_up);

    let tools = Tools {
        bold: bold.clone(),
        italic: italic.clone(),
        underline: underline.clone(),
        strike: strike.clone(),
    };
    wire_style(&buffer, &bold, STYLE_BOLD, &pending, &hold, &tools);
    wire_style(&buffer, &italic, STYLE_ITALIC, &pending, &hold, &tools);
    wire_style(&buffer, &underline, STYLE_UNDERLINE, &pending, &hold, &tools);
    wire_style(&buffer, &strike, STYLE_STRIKE, &pending, &hold, &tools);

    let buffer_check = buffer.clone();
    let skip_check = skip_list.clone();
    check.connect_clicked(move |_| {
        skip_check.set(false);
        edit::ensure_marker(&buffer_check, 1);
    });
    let buffer_bullet = buffer.clone();
    let skip_bullet = skip_list.clone();
    bullet.connect_clicked(move |_| {
        skip_bullet.set(false);
        edit::ensure_marker(&buffer_bullet, 2);
    });

    let app_down = Rc::downgrade(app);
    size_down.connect_clicked(move |_| {
        let Some(app) = app_down.upgrade() else { return };
        step_font(&app, id, -1);
    });
    let app_up = Rc::downgrade(app);
    size_up.connect_clicked(move |_| {
        let Some(app) = app_up.upgrade() else { return };
        step_font(&app, id, 1);
    });

    let pending_move = pending.clone();
    let hold_move = hold.clone();
    let tools_move = tools.clone();
    buffer.connect_mark_set(move |buffer, _, mark| {
        let Some(name) = mark.name() else { return };
        if name.as_str() != "insert" && name.as_str() != "selection_bound" {
            return;
        }
        refresh_tools(buffer, &pending_move, &hold_move, &tools_move);
    });

    let keys = gtk4::EventControllerKey::new();
    keys.set_propagation_phase(gtk4::PropagationPhase::Capture);
    let hold_key = hold.clone();
    let skip_key = skip_list.clone();
    let buffer_key = buffer.clone();
    let view_key = view.clone();
    keys.connect_key_pressed(move |_, key, _, state| {
        use gtk4::gdk::Key;
        const MOVE: &[Key] = &[
            Key::Left,
            Key::Right,
            Key::Up,
            Key::Down,
            Key::Home,
            Key::End,
            Key::Page_Up,
            Key::Page_Down,
        ];
        if MOVE.contains(&key) {
            hold_key.set(false);
        }
        if !view_key.is_editable() {
            return glib::Propagation::Proceed;
        }
        let plain = !state.contains(gdk::ModifierType::CONTROL_MASK)
            && !state.contains(gdk::ModifierType::ALT_MASK)
            && !state.contains(gdk::ModifierType::SHIFT_MASK)
            && !state.contains(gdk::ModifierType::SUPER_MASK);
        if plain && (key == Key::Return || key == Key::KP_Enter) {
            if skip_key.get() {
                skip_key.set(false);
                return glib::Propagation::Proceed;
            }
            if edit::continue_at_cursor(&buffer_key) {
                return glib::Propagation::Stop;
            }
        }
        if key == Key::BackSpace && edit::backspace_marker(&buffer_key) {
            skip_key.set(true);
            return glib::Propagation::Stop;
        }
        glib::Propagation::Proceed
    });
    view.add_controller(keys);

    let motion = gtk4::EventControllerMotion::new();
    let view_motion = view.clone();
    motion.connect_motion(move |_, x, y| {
        let name = if edit::over_checkbox(&view_motion, x, y) {
            "default"
        } else {
            "text"
        };
        view_motion.set_cursor_from_name(Some(name));
    });
    let view_leave = view.clone();
    motion.connect_leave(move |_| {
        view_leave.set_cursor_from_name(Some("text"));
    });
    view.add_controller(motion);

    let tick = gtk4::GestureClick::new();
    tick.set_button(gdk::BUTTON_PRIMARY);
    tick.set_propagation_phase(gtk4::PropagationPhase::Capture);
    let view_tick = view.clone();
    let busy_tick = busy.clone();
    let hold_tick = hold.clone();
    let app_tick = Rc::downgrade(app);
    tick.connect_pressed(move |gesture, _, x, y| {
        hold_tick.set(false);
        if busy_tick.get() {
            return;
        }
        busy_tick.set(true);
        let toggled = edit::toggle_box_at(&view_tick, x, y);
        if toggled {
            if let Some(app) = app_tick.upgrade() {
                remember_buffer(&app, id, &view_tick.buffer());
                schedule_save(&app);
            }
            gesture.set_state(gtk4::EventSequenceState::Claimed);
        }
        busy_tick.set(false);
    });
    view.add_controller(tick);

    let app_changed = Rc::downgrade(app);
    let busy_changed = busy.clone();
    buffer.connect_changed(move |buffer| {
        if busy_changed.get() {
            return;
        }
        busy_changed.set(true);
        edit::paint_checks(buffer);
        let Some(app) = app_changed.upgrade() else {
            busy_changed.set(false);
            return;
        };
        remember_buffer(&app, id, buffer);
        busy_changed.set(false);
        schedule_save(&app);
    });

    let app_commit = Rc::downgrade(app);
    let busy_commit = busy.clone();
    let pending_commit = pending.clone();
    let hold_commit = hold.clone();
    let tools_commit = tools.clone();
    buffer.add_commit_notify(
        gtk4::TextBufferNotifyFlags::AFTER_INSERT,
        move |buffer, flags, offset, length| {
            if !flags.contains(gtk4::TextBufferNotifyFlags::AFTER_INSERT) || busy_commit.get() {
                return;
            }
            busy_commit.set(true);
            // Enter continuation is handled on the key itself. Doing it here
            // as well inserts a second checkbox.
            let _ = edit::after_insert(
                buffer,
                offset,
                length,
                pending_commit.get(),
                hold_commit.get(),
                0,
                false,
            );
            edit::paint_checks(buffer);
            refresh_tools(buffer, &pending_commit, &hold_commit, &tools_commit);
            if let Some(app) = app_commit.upgrade() {
                remember_buffer(&app, id, buffer);
                schedule_save(&app);
            }
            busy_commit.set(false);
        },
    );

    let ribbon_focus = ribbon.clone();
    view.connect_has_focus_notify(move |view| {
        sync_ribbon(view, &ribbon_focus);
    });

    (ribbon, size_label, size_down, size_up)
}

#[derive(Clone)]
struct Tools {
    bold: gtk4::Button,
    italic: gtk4::Button,
    underline: gtk4::Button,
    strike: gtk4::Button,
}

fn tool_icon(icon: &str, tip: &str) -> gtk4::Button {
    let button = gtk4::Button::from_icon_name(icon);
    prep_tool(&button, tip);
    button
}

fn tool_text(text: &str, tip: &str) -> gtk4::Button {
    let button = gtk4::Button::with_label(text);
    prep_tool(&button, tip);
    button
}

fn prep_tool(button: &gtk4::Button, tip: &str) {
    button.set_tooltip_text(Some(tip));
    button.add_css_class("tool");
    button.set_can_focus(false);
    button.set_focus_on_click(false);
    button.set_hexpand(true);
}

fn wire_style(
    buffer: &gtk4::TextBuffer,
    button: &gtk4::Button,
    bit: u8,
    pending: &Rc<Cell<u8>>,
    hold: &Rc<Cell<bool>>,
    tools: &Tools,
) {
    let buffer = buffer.clone();
    let pending = pending.clone();
    let hold = hold.clone();
    let tools = tools.clone();
    button.connect_clicked(move |_| {
        if edit::toggle_style(&buffer, bit) {
            pending.set(edit::selection_style(&buffer).unwrap_or(0));
            hold.set(true);
        } else {
            pending.set(pending.get() ^ bit);
            hold.set(true);
        }
        refresh_tools(&buffer, &pending, &hold, &tools);
    });
}

fn step_font(app: &Rc<RefCell<App>>, id: u64, delta: i16) {
    {
        let mut a = app.borrow_mut();
        if let Some(note) = a.store.note_mut(id) {
            let current = store::normalize_size(note.size) as i16;
            note.size = (current + delta).clamp(11, 16) as u8;
        }
    }
    // Font never changes the window frame. A size request here would snap
    // a note the user had resized back to the stored width and height.
    refresh_note(app, id, false);
    schedule_save(app);
}

fn refresh_tools(
    buffer: &gtk4::TextBuffer,
    pending: &Cell<u8>,
    hold: &Cell<bool>,
    tools: &Tools,
) {
    let bits = if let Some(bits) = edit::selection_style(buffer) {
        bits
    } else if hold.get() {
        pending.get()
    } else {
        let bits = edit::typing_style(buffer);
        pending.set(bits);
        bits
    };
    set_on(&tools.bold, bits & STYLE_BOLD != 0);
    set_on(&tools.italic, bits & STYLE_ITALIC != 0);
    set_on(&tools.underline, bits & STYLE_UNDERLINE != 0);
    set_on(&tools.strike, bits & STYLE_STRIKE != 0);
}

fn set_on(button: &gtk4::Button, on: bool) {
    if on {
        button.add_css_class("on");
    } else {
        button.remove_css_class("on");
    }
}

fn sync_ribbon(view: &gtk4::TextView, ribbon: &gtk4::Box) {
    let show = view.has_focus() && view.is_editable();
    if ribbon.is_visible() != show {
        ribbon.set_visible(show);
    }
}

fn remember_buffer(app: &Rc<RefCell<App>>, id: u64, buffer: &gtk4::TextBuffer) {
    let (text, spans) = edit::capture(buffer);
    let mut a = app.borrow_mut();
    if let Some(note) = a.store.note_mut(id) {
        note.text = text;
        note.spans = spans;
    }
}

fn mutate_note(app: &Rc<RefCell<App>>, id: u64, frame: bool, f: impl FnOnce(&mut Note)) {
    let (areas, max_w, max_h) = {
        let a = app.borrow();
        (a.workareas.clone(), a.max_w, a.max_h)
    };
    {
        let mut a = app.borrow_mut();
        if let Some(note) = a.store.note_mut(id) {
            f(note);
            if frame {
                note.clamp_to(&areas, max_w, max_h);
            }
        }
    }
    refresh_note(app, id, frame);
    if frame {
        mark_dirty(app, id);
        flush_place(app);
    }
    flush_save(app);
}

fn duplicate_note(app: &Rc<RefCell<App>>, id: u64) {
    let copy = {
        let mut a = app.borrow_mut();
        let Some(source) = a.store.note(id).cloned() else { return };
        let obstacles: Vec<(i32, i32, i32, i32)> = a
            .store
            .notes
            .iter()
            .map(|note| (note.x, note.y, note.w, note.h))
            .collect();
        let (x, y) = geom::free_origin(
            &obstacles,
            &a.workareas,
            source.w,
            source.h,
            Some((source.x, source.y)),
        );
        let new_id = a.store.alloc_id();
        let mut note = source;
        note.id = new_id;
        note.x = x;
        note.y = y;
        note.locked = false;
        let areas = a.workareas.clone();
        let max_w = a.max_w;
        let max_h = a.max_h;
        note.clamp_to(&areas, max_w, max_h);
        a.store.notes.push(note);
        new_id
    };
    open_note(app, copy, true);
    flush_save(app);
}

fn delete_note(app: &Rc<RefCell<App>>, id: u64) {
    let window = {
        let mut a = app.borrow_mut();
        let Some(index) = a.store.notes.iter().position(|note| note.id == id) else {
            return;
        };
        let note = a.store.notes.remove(index);
        push_trash(&mut a.store, note);
        a.windows.remove(&id).map(|ui| ui.window)
    };
    close_window(window);
    refresh_restore(app);
    flush_save(app);
}

pub fn delete_all(app: &Rc<RefCell<App>>) {
    let windows = {
        let mut a = app.borrow_mut();
        let notes = std::mem::take(&mut a.store.notes);
        for note in notes {
            a.store.trash.push(note);
        }
        store::trim_trash(&mut a.store.trash);
        a.windows
            .drain()
            .map(|(_, ui)| ui.window)
            .collect::<Vec<_>>()
    };
    for window in windows {
        close_window(Some(window));
    }
    refresh_restore(app);
    flush_save(app);
}

pub fn empty_trash(app: &Rc<RefCell<App>>) {
    app.borrow_mut().store.trash.clear();
    refresh_restore(app);
    flush_save(app);
}

/// `id` restores that deleted note. `None` restores the most recent one.
pub fn restore_deleted(app: &Rc<RefCell<App>>, id: Option<u64>) {
    let was_hidden = app.borrow().store.hidden;
    let Some(note_id) = take_trashed(app, id) else { return };
    if was_hidden {
        set_hidden(app, false);
    }
    open_note(app, note_id, true);
    refresh_restore(app);
    flush_save(app);
}

pub fn restore_all(app: &Rc<RefCell<App>>) {
    let ids = {
        let mut a = app.borrow_mut();
        let notes = std::mem::take(&mut a.store.trash);
        if notes.is_empty() {
            return;
        }
        let areas = a.workareas.clone();
        let max_w = a.max_w;
        let max_h = a.max_h;
        let mut ids = Vec::with_capacity(notes.len());
        for mut note in notes {
            note.clamp_to(&areas, max_w, max_h);
            ids.push(note.id);
            a.store.notes.push(note);
        }
        ids
    };
    if app.borrow().store.hidden {
        set_hidden(app, false);
    }
    let last = ids.last().copied();
    for id in ids {
        open_note(app, id, last == Some(id));
    }
    refresh_restore(app);
    flush_save(app);
}

fn take_trashed(app: &Rc<RefCell<App>>, id: Option<u64>) -> Option<u64> {
    let mut a = app.borrow_mut();
    let mut note = match id {
        Some(id) => {
            let index = a.store.trash.iter().position(|note| note.id == id)?;
            a.store.trash.remove(index)
        }
        None => a.store.trash.pop()?,
    };
    let areas = a.workareas.clone();
    let max_w = a.max_w;
    let max_h = a.max_h;
    note.clamp_to(&areas, max_w, max_h);
    let id = note.id;
    a.store.notes.push(note);
    if a.store.hidden {
        a.store.hidden = false;
    }
    Some(id)
}

fn push_trash(store: &mut Store, note: Note) {
    store.trash.push(note);
    store::trim_trash(&mut store.trash);
}

fn close_window(window: Option<ApplicationWindow>) {
    if let Some(window) = window {
        window.set_visible(false);
        window.destroy();
    }
}

pub fn apply_option(app: &Rc<RefCell<App>>, key: &str, value: &str) {
    let resize = {
        let mut a = app.borrow_mut();
        match key {
            "note-width" => {
                if let Ok(width) = value.parse::<i32>() {
                    a.note_w = width.clamp(180, LIMIT_W);
                }
                false
            }
            "note-height" => {
                if let Ok(height) = value.parse::<i32>() {
                    a.note_h = height.clamp(120, LIMIT_H);
                }
                false
            }
            "max-width" => {
                if let Ok(width) = value.parse::<i32>() {
                    a.max_w = width.clamp(240, LIMIT_W);
                    a.note_w = a.note_w.min(a.max_w);
                    true
                } else {
                    false
                }
            }
            "max-height" => {
                if let Ok(height) = value.parse::<i32>() {
                    a.max_h = height.clamp(180, LIMIT_H);
                    a.note_h = a.note_h.min(a.max_h);
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    };
    if resize {
        clamp_open(app);
    }
}

fn clamp_open(app: &Rc<RefCell<App>>) {
    {
        let mut a = app.borrow_mut();
        let areas = a.workareas.clone();
        let max_w = a.max_w;
        let max_h = a.max_h;
        for note in &mut a.store.notes {
            note.clamp_to(&areas, max_w, max_h);
        }
    }
    mark_all_dirty(app);
    flush_place(app);
    flush_save(app);
}

/// One status block for the top-bar menu. Trash lines are newest first.
pub fn status_report(app: &Rc<RefCell<App>>) -> String {
    let a = app.borrow();
    let mut lines = Vec::new();
    lines.push(format!("hidden {}", u8::from(a.store.hidden)));
    lines.push(format!("notes {}", a.store.notes.len()));
    for note in a.store.trash.iter().rev() {
        lines.push(format!("trash {} {}", note.id, trash_label(&note.text)));
    }
    lines.push("end".into());
    let mut report = lines.join("\n");
    report.push('\n');
    report
}

fn trash_label(text: &str) -> String {
    let preview = edit::collapsed_preview(text);
    let preview = if preview == "Note" {
        "Empty note".to_string()
    } else {
        preview
    };
    let mut label = String::new();
    for ch in preview.chars().take(48) {
        if ch.is_control() {
            label.push(' ');
        } else {
            label.push(ch);
        }
    }
    label
}

fn refresh_restore(app: &Rc<RefCell<App>>) {
    let (application, enabled) = {
        let a = app.borrow();
        (a.application.clone(), !a.store.trash.is_empty())
    };
    if let Some(action) = application.lookup_action("restore") {
        if let Some(action) = action.downcast_ref::<gio::SimpleAction>() {
            action.set_enabled(enabled);
        }
    }
}

fn refresh_note(app: &Rc<RefCell<App>>, id: u64, frame: bool) {
    let note = app.borrow().store.note(id).cloned();
    let Some(note) = note else { return };
    let a = app.borrow();
    if let Some(ui) = a.windows.get(&id) {
        apply_look(ui, &note, frame);
    }
}

fn apply_look(ui: &NoteUi, note: &Note, frame: bool) {
    for name in PALETTE {
        ui.card.remove_css_class(name);
    }
    ui.card.add_css_class(PALETTE[note.color as usize]);
    for size in 11..=16 {
        ui.card.remove_css_class(&format!("size-{size}"));
    }
    let points = store::normalize_size(note.size);
    ui.card.add_css_class(&format!("size-{points}"));
    ui.view.set_editable(!note.locked);
    ui.view.set_cursor_visible(!note.locked);
    ui.size_label.set_text(&points.to_string());
    ui.size_down.set_sensitive(points > 11);
    ui.size_up.set_sensitive(points < 16);
    sync_ribbon(&ui.view, &ui.ribbon);
    if frame {
        ui.window.set_default_size(note.w, note.h);
        let title = note.title();
        if ui.window.title().as_deref() != Some(title.as_str()) {
            ui.window.set_title(Some(&title));
        }
    }
}

fn mark_dirty(app: &Rc<RefCell<App>>, id: u64) {
    let mut a = app.borrow_mut();
    if !a.dirty_place.contains(&id) {
        a.dirty_place.push(id);
    }
}

fn flush_place(app: &Rc<RefCell<App>>) {
    let pending: Vec<u64> = std::mem::take(&mut app.borrow_mut().dirty_place);
    for id in pending {
        refresh_note(app, id, true);
    }
}

fn schedule_save(app: &Rc<RefCell<App>>) {
    if let Some(id) = app.borrow_mut().save_id.take() {
        id.remove();
    }
    let weak = Rc::downgrade(app);
    let id = glib::timeout_add_local_once(Duration::from_millis(450), move || {
        let Some(app) = weak.upgrade() else { return };
        app.borrow_mut().save_id = None;
        flush_save(&app);
    });
    app.borrow_mut().save_id = Some(id);
}

pub fn flush_save(app: &Rc<RefCell<App>>) {
    if let Some(id) = app.borrow_mut().save_id.take() {
        id.remove();
    }
    let a = app.borrow();
    if let Err(error) = store::save(&a.path, &a.store) {
        eprintln!("sticky-notes: could not save notes: {error}");
    }
}

pub fn shutdown(app: &Rc<RefCell<App>>) {
    // The text buffer is the live copy; pull it in before the last write.
    let ids: Vec<u64> = app.borrow().windows.keys().copied().collect();
    for id in ids {
        let captured = {
            let a = app.borrow();
            let Some(ui) = a.windows.get(&id) else { continue };
            Some(edit::capture(&ui.view.buffer()))
        };
        let Some((text, spans)) = captured else { continue };
        if let Some(note) = app.borrow_mut().store.note_mut(id) {
            note.text = text;
            note.spans = spans;
        }
    }
    flush_save(app);
}
