//! Note documents. Writes are atomic and only happen after an edit settles.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::geom::{self, Rect};

/// Stored color index. The first six stay in their original order so notes
/// already on disk keep the color they had.
pub const PALETTE: &[&str] = &[
    "sand", "blossom", "mint", "sky", "lilac", "peach", "lemon", "cream", "apricot", "coral",
    "rose", "mauve", "iris", "mist", "sage", "aqua",
];
pub const MIN_W: i32 = 168;
pub const MIN_H: i32 = 112;
/// About 48 characters at the normal text size, plus the text margins.
pub const MAX_W: i32 = 440;
/// The top edge plus about 20 lines at the normal text size.
pub const MAX_H: i32 = 460;
/// How far the size-limit settings can be raised above the defaults.
pub const LIMIT_W: i32 = 960;
pub const LIMIT_H: i32 = 1200;
/// Deleted notes kept for the top-bar recycle bin. Older ones fall off.
pub const TRASH_LIMIT: usize = 40;

pub const STYLE_BOLD: u8 = 1;
pub const STYLE_ITALIC: u8 = 2;
pub const STYLE_UNDERLINE: u8 = 4;
pub const STYLE_STRIKE: u8 = 8;

/// One character-style run. Offsets are Unicode scalars, not bytes.
/// `style` is a single bit from the `STYLE_*` constants. Checklist state is
/// not stored here; it is the ballot-box character at the start of a line.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
    pub style: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Note {
    pub id: u64,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub expanded_h: i32,
    pub color: u8,
    pub size: u8,
    pub collapsed: bool,
    pub locked: bool,
    pub text: String,
    #[serde(default)]
    pub spans: Vec<Span>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Store {
    pub version: u32,
    pub hidden: bool,
    pub next_id: u64,
    pub notes: Vec<Note>,
    #[serde(default)]
    pub trash: Vec<Note>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            hidden: false,
            next_id: 1,
            notes: Vec::new(),
            trash: Vec::new(),
        }
    }
}

impl Note {
    pub fn title(&self) -> String {
        format!("pn:{}:{}:{}:{}:{}", self.id, self.x, self.y, self.w, self.h)
    }

    pub fn clamp_to(&mut self, areas: &[Rect], max_w: i32, max_h: i32) {
        let (x, y, w, h) =
            geom::clamp(self.x, self.y, self.w, self.h, areas, MIN_W, MIN_H, max_w, max_h);
        self.x = x;
        self.y = y;
        self.w = w;
        self.h = h;
        self.expanded_h = h;
        self.collapsed = false;
        self.color %= PALETTE.len() as u8;
        self.size = normalize_size(self.size);
    }
}

/// Point size stored on a note. Older files used 0, 1 and 2 for 11, 13 and 16.
pub fn normalize_size(size: u8) -> u8 {
    match size {
        0 => 11,
        1 => 13,
        2 => 16,
        11..=16 => size,
        _ => 13,
    }
}

impl Store {
    pub fn note(&self, id: u64) -> Option<&Note> {
        self.notes.iter().find(|note| note.id == id)
    }

    pub fn note_mut(&mut self, id: u64) -> Option<&mut Note> {
        self.notes.iter_mut().find(|note| note.id == id)
    }

    pub fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }
}

pub fn trim_trash(trash: &mut Vec<Note>) {
    if trash.len() > TRASH_LIMIT {
        let extra = trash.len() - TRASH_LIMIT;
        trash.drain(0..extra);
    }
}

pub fn data_path() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("sticky-notes/notes.json")
}

pub fn load(path: &Path) -> (Store, bool) {
    let Ok(bytes) = fs::read(path) else {
        return (Store::default(), false);
    };
    match serde_json::from_slice::<Store>(&bytes) {
        Ok(mut store) => {
            store.version = 1;
            trim_trash(&mut store.trash);
            for note in store.notes.iter_mut().chain(store.trash.iter_mut()) {
                note.color %= PALETTE.len() as u8;
                note.size = normalize_size(note.size);
                if note.collapsed {
                    note.collapsed = false;
                    note.h = note.expanded_h.max(note.h).max(MIN_H);
                }
                if note.expanded_h < MIN_H {
                    note.expanded_h = note.h.max(MIN_H);
                }
            }
            (store, true)
        }
        Err(_) => (Store::default(), true),
    }
}

pub fn save(path: &Path, store: &Store) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(store).unwrap_or_else(|_| b"{}".to_vec());
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_text() {
        let dir = std::env::temp_dir().join(format!("sticky-notes-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.json");
        let mut store = Store::default();
        store.notes.push(Note {
            id: 3,
            x: 10,
            y: 20,
            w: 200,
            h: 160,
            expanded_h: 160,
            color: 2,
            size: 14,
            collapsed: false,
            locked: true,
            text: "mint".into(),
            spans: vec![Span {
                start: 0,
                end: 4,
                style: STYLE_BOLD,
            }],
        });
        save(&path, &store).unwrap();
        let (loaded, existed) = load(&path);
        assert!(existed);
        assert_eq!(loaded.notes[0], store.notes[0]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_font_steps_become_point_sizes() {
        assert_eq!(normalize_size(0), 11);
        assert_eq!(normalize_size(1), 13);
        assert_eq!(normalize_size(2), 16);
        assert_eq!(normalize_size(12), 12);
        assert_eq!(normalize_size(15), 15);
        assert_eq!(normalize_size(40), 13);
    }

    #[test]
    fn old_notes_load_without_spans() {
        let raw = r#"{
            "version": 1,
            "hidden": false,
            "next_id": 2,
            "notes": [{
                "id": 1, "x": 0, "y": 0, "w": 200, "h": 160,
                "expanded_h": 160, "color": 0, "size": 1,
                "collapsed": false, "locked": false, "text": "plain"
            }]
        }"#;
        let store: Store = serde_json::from_str(raw).unwrap();
        assert!(store.notes[0].spans.is_empty());
        assert_eq!(store.notes[0].text, "plain");
    }

    #[test]
    fn palette_names_are_unique() {
        let mut names: Vec<&str> = PALETTE.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), PALETTE.len());
        assert!(PALETTE.len() >= 12);
    }
}
