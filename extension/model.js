// Note documents and placement. No Shell or GI imports, so the rules can be
// checked outside a session. The on-disk shape matches notes.json.

import {lineMark} from './format.js';

export const PALETTE = [
    'sand', 'blossom', 'mint', 'sky', 'lilac', 'peach', 'lemon', 'cream',
    'apricot', 'coral', 'rose', 'mauve', 'iris', 'mist', 'sage', 'aqua',
];

export const COLOR_LABELS = {
    sand: 'Sand',
    blossom: 'Blossom',
    mint: 'Mint',
    sky: 'Sky',
    lilac: 'Lilac',
    peach: 'Peach',
    lemon: 'Lemon',
    cream: 'Cream',
    apricot: 'Apricot',
    coral: 'Coral',
    rose: 'Rose',
    mauve: 'Mauve',
    iris: 'Iris',
    mist: 'Mist',
    sage: 'Sage',
    aqua: 'Aqua',
};

// Hue order for the swatch grid. Values are palette indexes, so a note
// saved before the extra colors keeps the swatch it already used.
export const SWATCH_ORDER = [0, 6, 7, 5, 8, 9, 1, 10, 11, 4, 12, 3, 13, 2, 14, 15];

export const MIN_W = 168;
export const MIN_H = 112;
export const TRASH_LIMIT = 40;
export const NOTE_GAP = 16;

export const WELCOME_TEXT = [
    'Drag the top edge to move.',
    'Drag the corner to resize.',
    'Right-click to pick a color.',
    'Click the text for bold, italic, and lists.',
    '',
    'The note icon on the top bar opens the note menu.',
    '',
    'Ctrl+Super+N    new note',
    'Ctrl+Super+H    hide notes',
    '',
].join('\n');

export function emptyStore() {
    return {
        version: 1,
        hidden: false,
        next_id: 1,
        notes: [],
        trash: [],
    };
}

export function normalizeSize(size) {
    const value = Number(size);
    if (value === 0)
        return 11;
    if (value === 1)
        return 13;
    if (value === 2)
        return 16;
    if (Number.isInteger(value) && value >= 11 && value <= 16)
        return value;
    return 13;
}

function colorIndex(value) {
    const n = Number(value);
    if (!Number.isInteger(n))
        return 0;
    return ((n % PALETTE.length) + PALETTE.length) % PALETTE.length;
}

function copySpans(spans) {
    if (!Array.isArray(spans))
        return [];
    const out = [];
    for (const span of spans) {
        if (!span || typeof span !== 'object')
            continue;
        const {start, end, style} = span;
        if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(style))
            continue;
        if (start < 0 || end <= start || style < 0 || style > 15)
            continue;
        out.push({start, end, style});
    }
    return out;
}

function copySizes(sizes) {
    if (!Array.isArray(sizes))
        return [];
    const out = [];
    for (const run of sizes) {
        if (!run || typeof run !== 'object')
            continue;
        const {start, end, size} = run;
        if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(size))
            continue;
        if (start < 0 || end <= start || size < 6 || size > 72)
            continue;
        out.push({start, end, size});
    }
    return out;
}

function normalizeNote(raw, workspace) {
    if (!raw || typeof raw !== 'object')
        return null;
    const id = Number(raw.id);
    if (!Number.isInteger(id) || id <= 0)
        return null;
    let h = Number.isInteger(raw.h) ? raw.h : 180;
    let expanded = Number.isInteger(raw.expanded_h) ? raw.expanded_h : h;
    if (raw.collapsed) {
        h = Math.max(expanded, h, MIN_H);
        expanded = h;
    }
    if (expanded < MIN_H)
        expanded = Math.max(h, MIN_H);
    const storedSpace = Number.isInteger(raw.workspace) ? raw.workspace : workspace;
    return {
        id,
        x: Number.isInteger(raw.x) ? raw.x : 0,
        y: Number.isInteger(raw.y) ? raw.y : 0,
        w: Number.isInteger(raw.w) ? raw.w : 230,
        h,
        expanded_h: expanded,
        color: colorIndex(raw.color),
        size: normalizeSize(raw.size),
        collapsed: false,
        locked: raw.locked === true,
        text: typeof raw.text === 'string' ? raw.text : '',
        spans: copySpans(raw.spans),
        sizes: copySizes(raw.sizes),
        workspace: storedSpace,
    };
}

export function normalizeStore(data, workspace = 0) {
    const store = emptyStore();
    if (!data || typeof data !== 'object')
        return store;
    store.hidden = data.hidden === true;
    store.next_id = Number.isInteger(data.next_id) && data.next_id > 0 ? data.next_id : 1;
    const seen = new Set();
    const take = (raw, into) => {
        const note = normalizeNote(raw, workspace);
        if (!note || seen.has(note.id))
            return;
        seen.add(note.id);
        if (note.id >= store.next_id)
            store.next_id = note.id + 1;
        into.push(note);
    };
    if (Array.isArray(data.notes)) {
        for (const raw of data.notes)
            take(raw, store.notes);
    }
    if (Array.isArray(data.trash)) {
        for (const raw of data.trash)
            take(raw, store.trash);
    }
    trimTrash(store);
    return store;
}

// A damaged file is not a notes collection. The caller starts a new one.
export function decodeStore(bytes, workspace = 0) {
    const text = new TextDecoder().decode(bytes);
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.notes))
        return null;
    return normalizeStore(data, workspace);
}

export function encodeStore(store) {
    const note = item => ({
        id: item.id,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        expanded_h: item.expanded_h,
        color: item.color,
        size: item.size,
        collapsed: false,
        locked: item.locked === true,
        text: item.text,
        spans: item.spans,
        sizes: item.sizes ?? [],
        workspace: item.workspace,
    });
    return {
        version: 1,
        hidden: store.hidden === true,
        next_id: store.next_id,
        notes: store.notes.map(note),
        trash: store.trash.map(note),
    };
}

export function trimTrash(store) {
    if (store.trash.length > TRASH_LIMIT)
        store.trash.splice(0, store.trash.length - TRASH_LIMIT);
}

export function welcomeNote(areas, id, workspace) {
    const w = 240;
    const h = 220;
    const area = areas[0];
    const x = area ? area.x + Math.trunc((area.w - w) / 2) : 160;
    const y = area ? area.y + Math.trunc((area.h - h) / 2) : 120;
    return {
        id,
        x,
        y,
        w,
        h,
        expanded_h: h,
        color: 0,
        size: 13,
        collapsed: false,
        locked: false,
        text: WELCOME_TEXT,
        spans: [],
        sizes: [],
        workspace,
    };
}

export function trashLabel(text) {
    let preview = 'Note';
    for (const line of String(text).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const mark = lineMark(trimmed);
        const body = (mark ? [...trimmed].slice(mark.chars).join('') : trimmed).trim();
        if (body) {
            preview = body;
            break;
        }
    }
    if (preview === 'Note')
        preview = 'Empty note';
    let label = '';
    for (const ch of [...preview].slice(0, 48)) {
        const code = ch.codePointAt(0);
        label += code < 32 || code === 127 ? ' ' : ch;
    }
    return label;
}

function clampInt(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function clamp(x, y, w, h, areas, minW, minH, maxW, maxH) {
    maxW = Math.max(maxW, minW);
    maxH = Math.max(maxH, minH);
    w = clampInt(w, minW, maxW);
    h = clampInt(h, minH, maxH);
    if (!areas.length)
        return [x, y, w, h];

    const cx = x + Math.trunc(w / 2);
    const cy = y + Math.trunc(h / 2);
    let best = areas[0];
    let bestD = Infinity;
    let inside = null;
    for (const area of areas) {
        if (cx >= area.x && cx < area.x + area.w && cy >= area.y && cy < area.y + area.h) {
            inside = area;
            break;
        }
        const dx = cx - (area.x + Math.trunc(area.w / 2));
        const dy = cy - (area.y + Math.trunc(area.h / 2));
        const d = dx * dx + dy * dy;
        if (d < bestD) {
            bestD = d;
            best = area;
        }
    }
    const area = inside ?? best;
    const margin = 8;
    w = Math.min(w, Math.max(area.w - margin * 2, minW));
    h = Math.min(h, Math.max(area.h - margin * 2, minH));
    const minX = area.x + margin;
    const minY = area.y + margin;
    const maxX = Math.max(area.x + area.w - margin - w, minX);
    const maxY = Math.max(area.y + area.h - margin - h, minY);
    return [clampInt(x, minX, maxX), clampInt(y, minY, maxY), w, h];
}

export function overlaps(x, y, w, h, gap, obstacles) {
    return obstacles.some(([ox, oy, ow, oh]) =>
        x < ox + ow + gap &&
        x + w + gap > ox &&
        y < oy + oh + gap &&
        y + h + gap > oy);
}

export function freeOrigin(obstacles, areas, w, h, prefer) {
    const gap = NOTE_GAP;
    const step = 24;
    const ordered = areas.length
        ? areas.map(area => ({...area}))
        : [{x: 48, y: 48, w: 1280, h: 800}];
    if (prefer) {
        const [px, py] = prefer;
        const index = ordered.findIndex(area =>
            px >= area.x && px < area.x + area.w && py >= area.y && py < area.y + area.h);
        if (index > 0) {
            const [preferred] = ordered.splice(index, 1);
            ordered.unshift(preferred);
        }
    }
    if (!obstacles.length && !prefer) {
        const area = ordered[0];
        return [
            area.x + Math.trunc((area.w - w) / 2),
            area.y + Math.trunc((area.h - h) / 2),
        ];
    }
    const [px, py] = prefer ?? [ordered[0].x + 8, ordered[0].y + 8];
    let best = null;
    for (const area of ordered) {
        const margin = 8;
        const minX = area.x + margin;
        const minY = area.y + margin;
        const maxX = Math.max(area.x + area.w - margin - w, minX);
        const maxY = Math.max(area.y + area.h - margin - h, minY);
        for (let y = minY; y <= maxY; y += step) {
            for (let x = minX; x <= maxX; x += step) {
                if (overlaps(x, y, w, h, gap, obstacles))
                    continue;
                const dx = x - px;
                const dy = y - py;
                const d = dx * dx + dy * dy;
                if (!best || d < best[2])
                    best = [x, y, d];
            }
        }
    }
    return best ? [best[0], best[1]] : [px, py];
}

export function freshOrigin(obstacles, areas, w, h, at, prefer) {
    if (at) {
        const origin = [at[0] - 20, at[1] - 10];
        if (!overlaps(origin[0], origin[1], w, h, NOTE_GAP, obstacles))
            return origin;
    }
    return freeOrigin(obstacles, areas, w, h, at ?? prefer);
}
