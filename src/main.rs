//! Sticky Notes.
//!
//! GNOME Shell can only load a JavaScript extension. This process is the
//! whole note UI. The extension adopts each window, keeps it off the dock
//! and the window list, and moves it — Wayland clients cannot place themselves.

mod edit;
mod geom;
mod store;
mod ui;

use std::cell::RefCell;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::rc::{Rc, Weak};

use gtk4::gio;
use gtk4::glib::{self, ControlFlow};
use gtk4::prelude::*;

use crate::geom::Rect;
use crate::ui::App;

const APP_ID: &str = "com.johanan.PastelNotes";
const SIGTERM: i32 = 15;

fn main() {
    // A GL renderer costs about 100 MB and a multi-second startup for a
    // window that almost never redraws. Cairo paints the note once and sits idle.
    std::env::set_var("GSK_RENDERER", "cairo");
    glib::set_prgname(Some("pastel-notes"));
    let application = gtk4::Application::builder()
        .application_id(APP_ID)
        .flags(gio::ApplicationFlags::empty())
        .build();
    // The guard must stay alive. Dropping it releases the hold, and the
    // process would exit once the last note is deleted.
    let _hold = application.hold();

    let path = store::data_path();
    let app_slot: Rc<RefCell<Option<Rc<RefCell<App>>>>> = Rc::new(RefCell::new(None));

    let slot = app_slot.clone();
    let path_for_start = path.clone();
    application.connect_startup(move |application| {
        let app = ui::start(application.clone(), path_for_start.clone());
        serve(&app);
        *slot.borrow_mut() = Some(app);
    });
    application.connect_activate(|_| {});

    let slot = app_slot.clone();
    application.connect_shutdown(move |_| {
        if let Some(app) = slot.borrow().clone() {
            ui::shutdown(&app);
            remove_socket();
        }
    });

    let slot = app_slot.clone();
    glib::unix_signal_add_local(SIGTERM, move || {
        if let Some(app) = slot.borrow().clone() {
            ui::shutdown(&app);
            remove_socket();
            app.borrow().application.quit();
        }
        ControlFlow::Break
    });

    application.run();
}

fn socket_path() -> PathBuf {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    dir.join("pastel-notes.sock")
}

fn remove_socket() {
    let _ = std::fs::remove_file(socket_path());
}

fn serve(app: &Rc<RefCell<App>>) {
    let path = socket_path();
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("pastel-notes: command socket unavailable: {error}");
            return;
        }
    };
    if let Err(error) = listener.set_nonblocking(true) {
        eprintln!("pastel-notes: command socket unavailable: {error}");
        return;
    }
    let fd = listener.as_raw_fd();
    // The listener lives in the source closure so the fd stays open.
    let listener = Rc::new(listener);
    let listener_for_source = listener.clone();
    let weak = Rc::downgrade(app);
    glib::unix_fd_add_local(fd, glib::IOCondition::IN, move |_fd, _condition| {
        let Some(app) = weak.upgrade() else {
            return ControlFlow::Break;
        };
        loop {
            match listener_for_source.accept() {
                Ok((stream, _)) => watch_client(stream, Rc::downgrade(&app)),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => {
                    eprintln!("pastel-notes: command socket: {error}");
                    break;
                }
            }
        }
        ControlFlow::Continue
    });
}

/// Read until the sender closes its write side. Complete lines run as they
/// arrive, so a status request is answered even if the wake-up comes early.
fn watch_client(stream: UnixStream, app: Weak<RefCell<App>>) {
    let _ = stream.set_nonblocking(true);
    let fd = stream.as_raw_fd();
    let state = Rc::new(RefCell::new(ClientState {
        stream,
        buf: Vec::new(),
    }));
    let state_fd = state.clone();
    glib::unix_fd_add_local(fd, glib::IOCondition::IN, move |_fd, _condition| {
        let Some(app) = app.upgrade() else {
            return ControlFlow::Break;
        };
        let mut state = state_fd.borrow_mut();
        let mut tmp = [0u8; 1024];
        loop {
            match state.stream.read(&mut tmp) {
                Ok(0) => {
                    if !state.buf.is_empty() {
                        let tail = String::from_utf8_lossy(&state.buf).into_owned();
                        state.buf.clear();
                        let reply = reply_for(&app, &tail);
                        let _ = write_reply(&mut state.stream, &reply);
                    }
                    return ControlFlow::Break;
                }
                Ok(n) => {
                    state.buf.extend_from_slice(&tmp[..n]);
                    let reply = drain_lines(&app, &mut state.buf);
                    if write_reply(&mut state.stream, &reply).is_err() {
                        return ControlFlow::Break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    return ControlFlow::Continue;
                }
                Err(error) => {
                    eprintln!("pastel-notes: command socket: {error}");
                    return ControlFlow::Break;
                }
            }
        }
    });
}

struct ClientState {
    stream: UnixStream,
    buf: Vec<u8>,
}

fn drain_lines(app: &Rc<RefCell<App>>, buf: &mut Vec<u8>) -> String {
    let mut reply = String::new();
    while let Some(end) = buf.iter().position(|byte| *byte == b'\n') {
        let line: Vec<u8> = buf.drain(..=end).collect();
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\n', '\r']);
        if text.is_empty() {
            continue;
        }
        if let Some(part) = dispatch(app, text) {
            reply.push_str(&part);
            if !part.ends_with('\n') {
                reply.push('\n');
            }
        }
    }
    reply
}

fn reply_for(app: &Rc<RefCell<App>>, text: &str) -> String {
    let mut reply = String::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(part) = dispatch(app, line) {
            reply.push_str(&part);
            if !part.ends_with('\n') {
                reply.push('\n');
            }
        }
    }
    reply
}

fn write_reply(stream: &mut UnixStream, reply: &str) -> std::io::Result<()> {
    if reply.is_empty() {
        return Ok(());
    }
    stream.set_nonblocking(false)?;
    stream.write_all(reply.as_bytes())?;
    stream.flush()?;
    let _ = stream.set_nonblocking(true);
    Ok(())
}

fn dispatch(app: &Rc<RefCell<App>>, line: &str) -> Option<String> {
    if let Some(rest) = line.strip_prefix("option ") {
        let mut parts = rest.splitn(2, char::is_whitespace);
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("").trim();
        ui::apply_option(app, key, value);
        return None;
    }
    let mut parts = line.split_whitespace();
    match parts.next() {
        Some("workarea") => {
            if let (Some(x), Some(y), Some(w), Some(h)) = (
                parts.next().and_then(|v| v.parse().ok()),
                parts.next().and_then(|v| v.parse().ok()),
                parts.next().and_then(|v| v.parse().ok()),
                parts.next().and_then(|v| v.parse().ok()),
            ) {
                app.borrow_mut().pending_push(Rect { x, y, w, h });
            }
        }
        Some("workareas-end") => {
            let areas = app.borrow_mut().pending_take();
            ui::set_workareas(app, areas);
        }
        Some("create") => {
            let x = parts.next().and_then(|v| v.parse().ok()).unwrap_or(180);
            let y = parts.next().and_then(|v| v.parse().ok()).unwrap_or(140);
            ui::create_note(app, Some((x, y)), true);
        }
        Some("new") => ui::create_note(app, None, true),
        Some("delete-all") => ui::delete_all(app),
        Some("empty-trash") => ui::empty_trash(app),
        Some("restore-all") => ui::restore_all(app),
        Some("restore") => {
            let id = parts.next().and_then(|v| v.parse().ok());
            ui::restore_deleted(app, id);
        }
        Some("status") => return Some(ui::status_report(app)),
        Some("placed") => {
            let id = parts.next().and_then(|v| v.parse().ok());
            let x = parts.next().and_then(|v| v.parse().ok());
            let y = parts.next().and_then(|v| v.parse().ok());
            let w = parts.next().and_then(|v| v.parse().ok());
            let h = parts.next().and_then(|v| v.parse().ok());
            if let (Some(id), Some(x), Some(y), Some(w), Some(h)) = (id, x, y, w, h) {
                ui::note_moved(app, id, x, y, w, h);
            }
        }
        Some("toggle") => ui::toggle_hidden(app),
        Some("quit") => {
            ui::shutdown(app);
            remove_socket();
            app.borrow().application.quit();
        }
        _ => {}
    }
    None
}

/// Pending work areas live next to the store, on the app, so the socket
/// parser does not need a second channel.
trait PendingAreas {
    fn pending_push(&mut self, area: Rect);
    fn pending_take(&mut self) -> Vec<Rect>;
}

impl PendingAreas for App {
    fn pending_push(&mut self, area: Rect) {
        self.pending.push(area);
    }
    fn pending_take(&mut self) -> Vec<Rect> {
        std::mem::take(&mut self.pending)
    }
}
