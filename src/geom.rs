//! Work-area clamping in compositor logical pixels.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Keep a note inside the monitor work area that contains its center,
/// and between the minimum and maximum size.
/// Empty `areas` leaves the origin unchanged and only enforces the size.
pub fn clamp(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    areas: &[Rect],
    min_w: i32,
    min_h: i32,
    max_w: i32,
    max_h: i32,
) -> (i32, i32, i32, i32) {
    let max_w = max_w.max(min_w);
    let max_h = max_h.max(min_h);
    let w = w.clamp(min_w, max_w);
    let h = h.clamp(min_h, max_h);
    if areas.is_empty() {
        return (x, y, w, h);
    }

    let cx = x.saturating_add(w / 2);
    let cy = y.saturating_add(h / 2);
    let mut best = &areas[0];
    let mut best_d = i64::MAX;
    let mut inside = None;
    for area in areas {
        if cx >= area.x && cx < area.x.saturating_add(area.w) && cy >= area.y && cy < area.y.saturating_add(area.h)
        {
            inside = Some(area);
            break;
        }
        let dx = cx as i64 - (area.x as i64 + area.w as i64 / 2);
        let dy = cy as i64 - (area.y as i64 + area.h as i64 / 2);
        let d = dx * dx + dy * dy;
        if d < best_d {
            best_d = d;
            best = area;
        }
    }
    let area = inside.unwrap_or(best);
    let margin = 8;
    let max_w = (area.w - margin * 2).max(min_w);
    let max_h = (area.h - margin * 2).max(min_h);
    let w = w.min(max_w);
    let h = h.min(max_h);
    let min_x = area.x + margin;
    let min_y = area.y + margin;
    let max_x = (area.x + area.w - margin - w).max(min_x);
    let max_y = (area.y + area.h - margin - h).max(min_y);
    let x = x.clamp(min_x, max_x);
    let y = y.clamp(min_y, max_y);
    (x, y, w, h)
}

/// True when a `w`×`h` rectangle at `(x, y)`, expanded by `gap`, hits an obstacle.
pub fn overlaps(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    gap: i32,
    obstacles: &[(i32, i32, i32, i32)],
) -> bool {
    obstacles.iter().any(|&(ox, oy, ow, oh)| {
        x < ox.saturating_add(ow).saturating_add(gap)
            && x.saturating_add(w).saturating_add(gap) > ox
            && y < oy.saturating_add(oh).saturating_add(gap)
            && y.saturating_add(h).saturating_add(gap) > oy
    })
}

/// Nearest free origin to `prefer` on a 24px grid. The preferred monitor is
/// searched first. An empty `areas` list uses a small fallback desk.
pub fn free_origin(
    obstacles: &[(i32, i32, i32, i32)],
    areas: &[Rect],
    w: i32,
    h: i32,
    prefer: Option<(i32, i32)>,
) -> (i32, i32) {
    let gap = 16;
    let step = 24;
    let mut ordered: Vec<Rect> = if areas.is_empty() {
        vec![Rect { x: 48, y: 48, w: 1280, h: 800 }]
    } else {
        areas.to_vec()
    };
    if let Some((px, py)) = prefer {
        if let Some(index) = ordered.iter().position(|area| {
            px >= area.x
                && px < area.x.saturating_add(area.w)
                && py >= area.y
                && py < area.y.saturating_add(area.h)
        }) {
            let preferred = ordered.remove(index);
            ordered.insert(0, preferred);
        }
    }
    // An empty desktop has nothing to cascade from, so the note opens in
    // the middle of the screen. A pointer position still wins.
    if obstacles.is_empty() && prefer.is_none() {
        let area = &ordered[0];
        let x = area.x + (area.w - w) / 2;
        let y = area.y + (area.h - h) / 2;
        return (x, y);
    }
    let (px, py) = prefer.unwrap_or((ordered[0].x + 8, ordered[0].y + 8));
    let mut best: Option<(i32, i32, i64)> = None;
    for area in &ordered {
        let margin = 8;
        let min_x = area.x + margin;
        let min_y = area.y + margin;
        let max_x = (area.x + area.w - margin - w).max(min_x);
        let max_y = (area.y + area.h - margin - h).max(min_y);
        let mut y = min_y;
        while y <= max_y {
            let mut x = min_x;
            while x <= max_x {
                if !overlaps(x, y, w, h, gap, obstacles) {
                    let dx = x as i64 - px as i64;
                    let dy = y as i64 - py as i64;
                    let d = dx * dx + dy * dy;
                    if best.map(|(_, _, best_d)| d < best_d).unwrap_or(true) {
                        best = Some((x, y, d));
                    }
                }
                x += step;
            }
            y += step;
        }
    }
    best.map(|(x, y, _)| (x, y)).unwrap_or((px, py))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> Rect {
        Rect { x: 100, y: 40, w: 800, h: 600 }
    }

    #[test]
    fn stays_put_when_already_inside() {
        let (x, y, w, h) = clamp(200, 120, 220, 180, &[area()], 160, 96, 4000, 4000);
        assert_eq!((x, y, w, h), (200, 120, 220, 180));
    }

    #[test]
    fn pulls_a_note_back_from_the_panel() {
        let (x, y, _, _) = clamp(0, 0, 220, 180, &[area()], 160, 96, 4000, 4000);
        assert_eq!((x, y), (108, 48));
    }

    #[test]
    fn enforces_minimum_size() {
        let (_, _, w, h) = clamp(200, 120, 10, 10, &[area()], 160, 96, 4000, 4000);
        assert_eq!((w, h), (160, 96));
    }

    #[test]
    fn refuses_to_grow_past_the_ceiling() {
        let (_, _, w, h) = clamp(200, 120, 900, 900, &[area()], 160, 96, 440, 460);
        assert_eq!((w, h), (440, 460));
    }

    #[test]
    fn empty_desk_opens_in_the_centre() {
        let (x, y) = free_origin(&[], &[area()], 230, 180, None);
        assert_eq!((x, y), (385, 250));
    }

    #[test]
    fn new_note_avoids_the_note_already_there() {
        let occupied = [(108, 48, 230, 180)];
        let (x, y) = free_origin(&occupied, &[area()], 230, 180, Some((108, 48)));
        assert!(!overlaps(x, y, 230, 180, 16, &occupied));
        assert_eq!((x, y), (108, 264));
    }

    #[test]
    fn prefers_the_monitor_under_the_pointer() {
        let other = Rect { x: 2000, y: 0, w: 800, h: 600 };
        let (x, y) = free_origin(&[], &[area(), other], 230, 180, Some((2100, 100)));
        assert!(x >= other.x && x < other.x + other.w);
        assert!((x - 2100).abs() <= 24);
        assert!((y - 100).abs() <= 24);
    }
}
