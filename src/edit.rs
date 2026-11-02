//! Formatting for one note buffer.
//!
//! The buffer is the live copy. Spans are collected from tag toggles, which
//! is proportional to the number of runs, not the number of characters.
//! A checked line is a ballot box in the text plus a derived tag, so ticking
//! a box does not create widgets inside the text.

use gtk4::gdk;
use gtk4::pango;
use gtk4::prelude::*;
use gtk4::{TextBuffer, TextIter, TextTag, TextView, TextWindowType};

use crate::store::{Span, STYLE_BOLD, STYLE_ITALIC, STYLE_STRIKE, STYLE_UNDERLINE};

const STYLES: [(u8, &str); 4] = [
    (STYLE_BOLD, "bold"),
    (STYLE_ITALIC, "italic"),
    (STYLE_UNDERLINE, "underline"),
    (STYLE_STRIKE, "strike"),
];

const BOX_OPEN: char = '\u{2610}';
const BOX_DONE: char = '\u{2611}';
const TEXT_STYLE: char = '\u{FE0E}';
const BULLET: char = '\u{2022}';

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Check { done: bool, chars: usize },
    Bullet { chars: usize },
}

pub fn checkbox_prefix(done: bool) -> String {
    let box_char = if done { BOX_DONE } else { BOX_OPEN };
    format!("{box_char}{TEXT_STYLE} ")
}

pub fn bullet_prefix() -> String {
    format!("{BULLET} ")
}

pub fn line_mark(line: &str) -> Option<Mark> {
    let mut chars = line.chars();
    let first = chars.next()?;
    match first {
        BOX_OPEN | BOX_DONE => {
            let mut n = 1usize;
            if chars.as_str().starts_with(TEXT_STYLE) {
                chars.next();
                n += 1;
            }
            if chars.as_str().starts_with(' ') {
                n += 1;
            }
            Some(Mark::Check {
                done: first == BOX_DONE,
                chars: n,
            })
        }
        BULLET => {
            let n = if chars.as_str().starts_with(' ') { 2 } else { 1 };
            Some(Mark::Bullet { chars: n })
        }
        _ => None,
    }
}

pub fn is_empty_item(line: &str) -> bool {
    match line_mark(line) {
        Some(Mark::Check { chars, .. } | Mark::Bullet { chars }) => {
            line.chars().nth(chars).is_none()
        }
        None => false,
    }
}

pub fn collapsed_preview(text: &str) -> String {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let body = match line_mark(trimmed) {
            Some(Mark::Check { chars, .. } | Mark::Bullet { chars }) => {
                trimmed.chars().skip(chars).collect::<String>()
            }
            None => trimmed.to_string(),
        };
        let body = body.trim();
        if !body.is_empty() {
            return body.to_string();
        }
    }
    "Note".into()
}

pub fn prepare(buffer: &TextBuffer) {
    let table = buffer.tag_table();
    if table.lookup("bold").is_some() {
        return;
    }
    let bold = gtk4::TextTag::new(Some("bold"));
    bold.set_weight(700);
    let italic = gtk4::TextTag::new(Some("italic"));
    italic.set_style(pango::Style::Italic);
    let underline = gtk4::TextTag::new(Some("underline"));
    underline.set_underline(pango::Underline::Single);
    let strike = gtk4::TextTag::new(Some("strike"));
    strike.set_strikethrough(true);
    let done = gtk4::TextTag::new(Some("done"));
    done.set_strikethrough(true);
    let pale = gdk::RGBA::new(50.0 / 255.0, 47.0 / 255.0, 56.0 / 255.0, 0.45);
    done.set_foreground_rgba(Some(&pale));
    done.set_strikethrough_rgba(Some(&pale));
    for tag in [bold, italic, underline, strike, done] {
        table.add(&tag);
    }
}

pub fn load(buffer: &TextBuffer, text: &str, spans: &[Span]) {
    prepare(buffer);
    buffer.set_enable_undo(false);
    buffer.set_text(text);
    let len = buffer.end_iter().offset().max(0) as u32;
    for span in spans {
        if span.start >= span.end || span.start >= len {
            continue;
        }
        let end = span.end.min(len);
        let start_iter = buffer.iter_at_offset(span.start as i32);
        let end_iter = buffer.iter_at_offset(end as i32);
        for (bit, name) in STYLES {
            if span.style & bit != 0 {
                buffer.apply_tag_by_name(name, &start_iter, &end_iter);
            }
        }
    }
    paint_checks(buffer);
    buffer.set_enable_undo(true);
    let start = buffer.start_iter();
    buffer.place_cursor(&start);
}

pub fn capture(buffer: &TextBuffer) -> (String, Vec<Span>) {
    let (start, end) = buffer.bounds();
    let text = buffer.text(&start, &end, true).to_string();
    let mut spans = Vec::new();
    for (bit, name) in STYLES {
        collect(buffer, name, bit, &mut spans);
    }
    (text, spans)
}

fn collect(buffer: &TextBuffer, name: &str, bit: u8, out: &mut Vec<Span>) {
    let Some(tag) = buffer.tag_table().lookup(name) else {
        return;
    };
    let mut iter = buffer.start_iter();
    loop {
        if !iter.has_tag(&tag) && !iter.forward_to_tag_toggle(Some(&tag)) {
            break;
        }
        if !iter.has_tag(&tag) {
            break;
        }
        let start = iter.offset().max(0) as u32;
        if !iter.forward_to_tag_toggle(Some(&tag)) {
            iter = buffer.end_iter();
        }
        let end = iter.offset().max(0) as u32;
        if end > start {
            out.push(Span {
                start,
                end,
                style: bit,
            });
        }
        if iter.is_end() {
            break;
        }
    }
}

/// What a buffer change did to list continuation.
pub enum ListStep {
    /// Not a line break.
    Other,
    /// A line break that stayed ordinary text.
    Break,
    /// A line break that started another checklist (`1`) or bullet (`2`).
    /// The kind is read by the tests; the live editor continues from the key.
    #[allow(dead_code)]
    Item(u8),
}

/// Tags just-inserted text when the user picked a style, and continues a
/// checklist or bullet after Enter.
///
/// `list_mode` is 1 for a checklist and 2 for bullets. When it is off,
/// `inherit` still continues from a line that already has that marker.
/// An empty item does not end the list: Enter keeps producing items until
/// Backspace removes a marker.
pub fn after_insert(
    buffer: &TextBuffer,
    offset: u32,
    length: u32,
    pending: u8,
    hold: bool,
    list_mode: u8,
    inherit: bool,
) -> ListStep {
    if length == 0 {
        return ListStep::Other;
    }
    if hold {
        force_style(buffer, offset, length, pending);
    }
    if length != 1 {
        return ListStep::Other;
    }
    let iter = buffer.iter_at_offset(offset as i32);
    if iter.char() == '\n' {
        return continue_list(buffer, offset, list_mode, inherit);
    }
    ListStep::Other
}

fn force_style(buffer: &TextBuffer, offset: u32, length: u32, bits: u8) {
    let end_at = offset.saturating_add(length);
    for (bit, name) in STYLES {
        let start = buffer.iter_at_offset(offset as i32);
        let end = buffer.iter_at_offset(end_at as i32);
        if bits & bit != 0 {
            buffer.apply_tag_by_name(name, &start, &end);
        } else {
            buffer.remove_tag_by_name(name, &start, &end);
        }
    }
}

fn continue_list(buffer: &TextBuffer, nl_offset: u32, list_mode: u8, inherit: bool) -> ListStep {
    let nl = buffer.iter_at_offset(nl_offset as i32);
    let mut start = nl.clone();
    start.set_line_offset(0);
    let prev = buffer.text(&start, &nl, false).to_string();
    let kind = if list_mode == 1 || list_mode == 2 {
        list_mode
    } else if inherit {
        match line_mark(&prev) {
            Some(Mark::Check { .. }) => 1,
            Some(Mark::Bullet { .. }) => 2,
            None => 0,
        }
    } else {
        0
    };
    if kind == 0 {
        return ListStep::Break;
    }
    let prefix = if kind == 2 {
        bullet_prefix()
    } else {
        checkbox_prefix(false)
    };
    let mut at = buffer.iter_at_offset(nl_offset as i32);
    if !at.forward_char() {
        at = buffer.end_iter();
    }
    let at_offset = at.offset().max(0) as u32;
    buffer.insert(&mut at, &prefix);
    // The marker stays plain even when the line's text is styled.
    force_style(buffer, at_offset, prefix.chars().count() as u32, 0);
    ListStep::Item(kind)
}

/// Splits the caret line when it is a checkbox or bullet, and starts the
/// next line with the same kind of marker. Returns false for an ordinary line.
pub fn continue_at_cursor(buffer: &TextBuffer) -> bool {
    let iter = cursor(buffer);
    let line_no = iter.line();
    let Some((start, end)) = line_bounds(buffer, line_no) else {
        return false;
    };
    let text = buffer.text(&start, &end, false).to_string();
    let prefix = match line_mark(&text) {
        Some(Mark::Check { .. }) => checkbox_prefix(false),
        Some(Mark::Bullet { .. }) => bullet_prefix(),
        None => return false,
    };
    buffer.begin_user_action();
    let mut at = cursor(buffer);
    buffer.insert(&mut at, "\n");
    let at_offset = at.offset().max(0) as u32;
    buffer.insert(&mut at, &prefix);
    force_style(buffer, at_offset, prefix.chars().count() as u32, 0);
    paint_checks(buffer);
    buffer.end_user_action();
    true
}

/// Puts a checkbox or bullet on the caret line. An existing marker of the
/// same kind is left alone, including a ticked box.
pub fn ensure_marker(buffer: &TextBuffer, kind: u8) {
    let line_no = cursor(buffer).line();
    let Some((start, end)) = line_bounds(buffer, line_no) else {
        return;
    };
    let text = buffer.text(&start, &end, false).to_string();
    let already = match (kind, line_mark(&text)) {
        (2, Some(Mark::Bullet { .. })) => true,
        (1, Some(Mark::Check { .. })) => true,
        _ => false,
    };
    if already {
        return;
    }
    let old = match line_mark(&text) {
        Some(Mark::Check { chars, .. } | Mark::Bullet { chars }) => chars,
        None => 0,
    };
    let prefix = if kind == 2 {
        bullet_prefix()
    } else {
        checkbox_prefix(false)
    };
    buffer.begin_user_action();
    replace_prefix(buffer, line_no, old, &prefix);
    if old == 0 {
        place_after_prefix(buffer, line_no, prefix.chars().count() as i32);
    }
    paint_checks(buffer);
    buffer.end_user_action();
}

/// Removes the marker when Backspace is pressed on it. An empty item goes
/// away with its line, so the caret returns to the line above. Returns
/// false when the caret is in the item text, so a normal delete still happens.
pub fn backspace_marker(buffer: &TextBuffer) -> bool {
    let iter = cursor(buffer);
    let line_no = iter.line();
    let Some((start, end)) = line_bounds(buffer, line_no) else {
        return false;
    };
    let text = buffer.text(&start, &end, false).to_string();
    let Some(mark) = line_mark(&text) else {
        return false;
    };
    let chars = match mark {
        Mark::Check { chars, .. } | Mark::Bullet { chars } => chars,
    };
    if iter.line_offset() > chars as i32 {
        return false;
    }
    buffer.begin_user_action();
    if is_empty_item(&text) {
        delete_item_line(buffer, line_no);
    } else {
        replace_prefix(buffer, line_no, chars, "");
    }
    paint_checks(buffer);
    buffer.end_user_action();
    true
}

fn delete_item_line(buffer: &TextBuffer, line_no: i32) {
    let Some(line_start) = buffer.iter_at_line(line_no) else {
        return;
    };
    let mut end = line_start.clone();
    if !end.forward_line() {
        end = buffer.end_iter();
    }
    let mut start = line_start;
    if line_no > 0 {
        start.backward_char();
    }
    if start.offset() < end.offset() {
        buffer.delete(&mut start, &mut end);
    }
}

pub fn over_checkbox(view: &TextView, x: f64, y: f64) -> bool {
    let (bx, by) = view.window_to_buffer_coords(TextWindowType::Widget, x as i32, y as i32);
    let Some(iter) = view.iter_at_location(bx, by) else {
        return false;
    };
    let Some(Mark::Check { chars, .. }) = prefix_at(&view.buffer(), iter.line()) else {
        return false;
    };
    iter.line_offset() < chars as i32
}

pub fn paint_checks(buffer: &TextBuffer) {
    let Some(done_tag) = buffer.tag_table().lookup("done") else {
        return;
    };
    let lines = buffer.line_count();
    for line_no in 0..lines {
        paint_line(buffer, &done_tag, line_no);
    }
}

fn paint_line(buffer: &TextBuffer, done_tag: &TextTag, line_no: i32) {
    let Some(start) = buffer.iter_at_line(line_no) else {
        return;
    };
    match prefix_at(buffer, line_no) {
        Some(Mark::Check { done: true, chars }) => {
            if start.has_tag(done_tag) {
                if let Some(prefix_end) = buffer.iter_at_line_offset(line_no, chars as i32) {
                    let start = buffer.iter_at_line(line_no).unwrap_or(start);
                    buffer.remove_tag(done_tag, &start, &prefix_end);
                }
            }
            let Some(content) = buffer.iter_at_line_offset(line_no, chars as i32) else {
                return;
            };
            let Some(mut end) = buffer.iter_at_line(line_no) else {
                return;
            };
            end.forward_to_line_end();
            if content.offset() >= end.offset() {
                return;
            }
            let mut last = end.clone();
            if last.backward_char() && (!content.has_tag(done_tag) || !last.has_tag(done_tag)) {
                buffer.apply_tag(done_tag, &content, &end);
            }
        }
        _ => {
            if line_has_tag(buffer, done_tag, line_no) {
                let Some(start) = buffer.iter_at_line(line_no) else {
                    return;
                };
                let mut end = start.clone();
                end.forward_to_line_end();
                buffer.remove_tag(done_tag, &start, &end);
            }
        }
    }
}

fn line_has_tag(buffer: &TextBuffer, tag: &TextTag, line_no: i32) -> bool {
    let Some(start) = buffer.iter_at_line(line_no) else {
        return false;
    };
    if start.has_tag(tag) {
        return true;
    }
    let mut end = start.clone();
    end.forward_to_line_end();
    let mut probe = start;
    probe.forward_to_tag_toggle(Some(tag)) && probe.offset() < end.offset()
}

fn prefix_at(buffer: &TextBuffer, line_no: i32) -> Option<Mark> {
    let first = char_on_line(buffer, line_no, 0)?;
    match first {
        BOX_OPEN | BOX_DONE => {
            let mut n = 1i32;
            if char_on_line(buffer, line_no, 1) == Some(TEXT_STYLE) {
                n = 2;
            }
            if char_on_line(buffer, line_no, n) == Some(' ') {
                n += 1;
            }
            Some(Mark::Check {
                done: first == BOX_DONE,
                chars: n as usize,
            })
        }
        BULLET => {
            let n = if char_on_line(buffer, line_no, 1) == Some(' ') {
                2
            } else {
                1
            };
            Some(Mark::Bullet { chars: n })
        }
        _ => None,
    }
}

fn char_on_line(buffer: &TextBuffer, line_no: i32, offset: i32) -> Option<char> {
    let iter = buffer.iter_at_line_offset(line_no, offset)?;
    let ch = iter.char();
    if ch == '\0' || ch == '\n' {
        None
    } else {
        Some(ch)
    }
}

pub fn typing_style(buffer: &TextBuffer) -> u8 {
    let mut iter = cursor(buffer);
    if !iter.starts_line() {
        iter.backward_char();
    }
    bits_at(buffer, &iter)
}

pub fn selection_style(buffer: &TextBuffer) -> Option<u8> {
    let (start, end) = buffer.selection_bounds()?;
    let mut bits = 0;
    for (bit, name) in STYLES {
        if range_has(buffer, &start, &end, name) {
            bits |= bit;
        }
    }
    Some(bits)
}

fn bits_at(buffer: &TextBuffer, iter: &TextIter) -> u8 {
    let mut bits = 0;
    for (bit, name) in STYLES {
        if let Some(tag) = buffer.tag_table().lookup(name) {
            if iter.has_tag(&tag) {
                bits |= bit;
            }
        }
    }
    bits
}

fn range_has(buffer: &TextBuffer, start: &TextIter, end: &TextIter, name: &str) -> bool {
    let Some(tag) = buffer.tag_table().lookup(name) else {
        return false;
    };
    if start.offset() >= end.offset() || !start.has_tag(&tag) {
        return false;
    }
    let mut next = start.clone();
    if !next.forward_to_tag_toggle(Some(&tag)) {
        return true;
    }
    next.offset() >= end.offset()
}

/// Applies `bit` to the selection. Returns false when the caret is a point,
/// so the caller can remember the style for the next characters instead.
pub fn toggle_style(buffer: &TextBuffer, bit: u8) -> bool {
    let Some(name) = STYLES.iter().find(|(b, _)| *b == bit).map(|(_, name)| *name) else {
        return false;
    };
    let Some((start, end)) = buffer.selection_bounds() else {
        return false;
    };
    buffer.begin_user_action();
    if range_has(buffer, &start, &end, name) {
        buffer.remove_tag_by_name(name, &start, &end);
    } else {
        buffer.apply_tag_by_name(name, &start, &end);
    }
    buffer.end_user_action();
    true
}

fn place_after_prefix(buffer: &TextBuffer, line_no: i32, chars: i32) {
    if let Some(iter) = buffer.iter_at_line_offset(line_no, chars) {
        buffer.place_cursor(&iter);
    }
}

fn replace_prefix(buffer: &TextBuffer, line_no: i32, old_chars: usize, new_prefix: &str) {
    let Some(mut start) = buffer.iter_at_line(line_no) else {
        return;
    };
    let mut end = start.clone();
    if old_chars > 0 {
        end.forward_chars(old_chars as i32);
        buffer.delete(&mut start, &mut end);
    }
    if !new_prefix.is_empty() {
        buffer.insert(&mut start, new_prefix);
    }
}

fn line_bounds(buffer: &TextBuffer, line_no: i32) -> Option<(TextIter, TextIter)> {
    let start = buffer.iter_at_line(line_no)?;
    let mut end = start.clone();
    end.forward_to_line_end();
    Some((start, end))
}

fn cursor(buffer: &TextBuffer) -> TextIter {
    match buffer.mark("insert") {
        Some(mark) => buffer.iter_at_mark(&mark),
        None => buffer.start_iter(),
    }
}

/// Ticks the box under a click. Returns false when the click is ordinary text.
pub fn toggle_box_at(view: &TextView, x: f64, y: f64) -> bool {
    if !view.is_editable() {
        return false;
    }
    let (bx, by) = view.window_to_buffer_coords(TextWindowType::Widget, x as i32, y as i32);
    let Some(iter) = view.iter_at_location(bx, by) else {
        return false;
    };
    let buffer = view.buffer();
    let line_no = iter.line();
    let Some(Mark::Check { done, chars }) = prefix_at(&buffer, line_no) else {
        return false;
    };
    if iter.line_offset() >= chars as i32 {
        return false;
    }
    buffer.begin_user_action();
    let Some(mut start) = buffer.iter_at_line(line_no) else {
        buffer.end_user_action();
        return false;
    };
    let mut end = start.clone();
    if !end.forward_char() {
        buffer.end_user_action();
        return false;
    }
    buffer.delete(&mut start, &mut end);
    let next = if done { BOX_OPEN } else { BOX_DONE };
    let mut tmp = [0u8; 4];
    buffer.insert(&mut start, next.encode_utf8(&mut tmp));
    paint_checks(&buffer);
    buffer.end_user_action();
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::store::{Span, STYLE_BOLD};

    fn buffer() -> TextBuffer {
        gtk4::init().expect("gtk");
        TextBuffer::new(None)
    }

    #[test]
    fn spans_round_trip_and_checks_follow_the_box() {
        let buffer = buffer();
        let open = checkbox_prefix(false);
        let text = format!("{open}milk");
        load(
            &buffer,
            &text,
            &[Span {
                start: 3,
                end: 7,
                style: STYLE_BOLD,
            }],
        );
        let (saved, spans) = capture(&buffer);
        assert_eq!(saved, text);
        assert!(spans.iter().any(|span| span.style == STYLE_BOLD && span.start == 3));

        let mut at = buffer.end_iter();
        let nl = at.offset() as u32;
        buffer.insert(&mut at, "\n");
        assert!(matches!(
            after_insert(&buffer, nl, 1, 0, false, 1, true),
            ListStep::Item(1)
        ));
        let (saved, _) = capture(&buffer);
        let prefix = checkbox_prefix(false);
        assert_eq!(saved.matches(prefix.as_str()).count(), 2);

        let mut at = buffer.end_iter();
        let nl = at.offset() as u32;
        buffer.insert(&mut at, "\n");
        assert!(matches!(
            after_insert(&buffer, nl, 1, 0, false, 1, true),
            ListStep::Item(1)
        ));
        let (saved, _) = capture(&buffer);
        assert_eq!(saved.matches(prefix.as_str()).count(), 3);

        let done_line = format!("{}done", checkbox_prefix(true));
        load(&buffer, &done_line, &[]);
        let done_tag = buffer.tag_table().lookup("done").unwrap();
        let box_iter = buffer.start_iter();
        assert!(!box_iter.has_tag(&done_tag));
        let content = buffer.iter_at_offset(3);
        assert!(content.has_tag(&done_tag));
        let (saved, spans) = capture(&buffer);
        assert_eq!(saved, done_line);
        assert!(spans.is_empty());

        checklist_survives_empty_enter_and_backspace_leaves_it();

        load(&buffer, &format!("{open}milk"), &[]);
        buffer.place_cursor(&buffer.end_iter());
        assert!(continue_at_cursor(&buffer));
        let (saved, _) = capture(&buffer);
        assert_eq!(saved, format!("{open}milk\n{open}"));

        load(&buffer, "plain", &[]);
        buffer.place_cursor(&buffer.end_iter());
        assert!(!continue_at_cursor(&buffer));
    }

    #[test]
    fn checklist_marks_and_preview() {
        let open = checkbox_prefix(false);
        assert_eq!(
            line_mark(&open),
            Some(Mark::Check {
                done: false,
                chars: 3
            })
        );
        assert!(is_empty_item(&open));
        let item = format!("{open}milk");
        assert!(!is_empty_item(&item));
        assert_eq!(collapsed_preview(&format!("{open}milk\n")), "milk");
        assert!(matches!(
            line_mark(&checkbox_prefix(true)),
            Some(Mark::Check { done: true, .. })
        ));
        assert!(is_empty_item("☐ "));
        assert_eq!(line_mark("• item"), Some(Mark::Bullet { chars: 2 }));
        assert_eq!(collapsed_preview("• \n☐ \n"), "Note");
    }

    fn checklist_survives_empty_enter_and_backspace_leaves_it() {
        let buffer = buffer();
        let prefix = checkbox_prefix(false);
        load(&buffer, &format!("{prefix}milk"), &[]);

        let mut at = buffer.end_iter();
        let nl = at.offset() as u32;
        buffer.insert(&mut at, "\n");
        assert!(matches!(
            after_insert(&buffer, nl, 1, 0, false, 0, true),
            ListStep::Item(1)
        ));
        let (saved, _) = capture(&buffer);
        assert_eq!(saved, format!("{prefix}milk\n{prefix}"));

        let end = buffer.end_iter();
        buffer.place_cursor(&end);
        assert!(backspace_marker(&buffer));
        let (saved, _) = capture(&buffer);
        assert_eq!(saved, format!("{prefix}milk"));

        load(&buffer, &format!("{prefix}milk"), &[]);
        let mut at = buffer.end_iter();
        let nl = at.offset() as u32;
        buffer.insert(&mut at, "\n");
        assert!(matches!(
            after_insert(&buffer, nl, 1, 0, false, 0, false),
            ListStep::Break
        ));
        let (saved, _) = capture(&buffer);
        assert_eq!(saved, format!("{prefix}milk\n"));

        load(&buffer, &format!("{prefix}milk"), &[]);
        let at = buffer.iter_at_offset(prefix.chars().count() as i32);
        buffer.place_cursor(&at);
        assert!(backspace_marker(&buffer));
        let (saved, _) = capture(&buffer);
        assert_eq!(saved, "milk");
        let in_text = buffer.iter_at_offset(1);
        buffer.place_cursor(&in_text);
        assert!(!backspace_marker(&buffer));
    }
}
