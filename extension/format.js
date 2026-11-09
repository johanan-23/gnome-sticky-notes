// Character styles and list markers. Offsets are Unicode scalars, matching notes.json.

export const STYLE_BOLD = 1;
export const STYLE_ITALIC = 2;
export const STYLE_UNDERLINE = 4;
export const STYLE_STRIKE = 8;

const BOX_OPEN = '\u2610';
const BOX_DONE = '\u2611';
const TEXT_STYLE = '\ufe0e';
const BULLET = '\u2022';

export function checkboxPrefix(done) {
    return `${done ? BOX_DONE : BOX_OPEN}${TEXT_STYLE} `;
}

export function bulletPrefix() {
    return `${BULLET} `;
}

export function lineMark(line) {
    const chars = Array.from(line);
    if (!chars.length)
        return null;
    const first = chars[0];
    if (first === BOX_OPEN || first === BOX_DONE) {
        let n = 1;
        if (chars[1] === TEXT_STYLE)
            n += 1;
        if (chars[n] === ' ')
            n += 1;
        return {kind: 'check', done: first === BOX_DONE, chars: n};
    }
    if (first === BULLET)
        return {kind: 'bullet', chars: chars[1] === ' ' ? 2 : 1};
    return null;
}

export function editRange(before, after) {
    const older = Array.from(before);
    const newer = Array.from(after);
    let start = 0;
    const limit = Math.min(older.length, newer.length);
    while (start < limit && older[start] === newer[start])
        start += 1;
    let oldEnd = older.length;
    let newEnd = newer.length;
    while (oldEnd > start && newEnd > start && older[oldEnd - 1] === newer[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
    }
    return {start, removed: oldEnd - start, inserted: newEnd - start};
}

function expand(spans, length) {
    const bits = new Uint8Array(length);
    for (const span of spans) {
        const style = span.style & 15;
        if (!style)
            continue;
        const from = Math.max(0, Math.min(length, span.start));
        const to = Math.max(from, Math.min(length, span.end));
        for (let i = from; i < to; i++)
            bits[i] |= style;
    }
    return bits;
}

function compact(values, key = 'style') {
    const runs = [];
    let i = 0;
    while (i < values.length) {
        const value = values[i];
        let j = i + 1;
        while (j < values.length && values[j] === value)
            j += 1;
        if (value)
            runs.push({start: i, end: j, [key]: value});
        i = j;
    }
    return runs;
}

function shiftValues(values, start, removed, inserted, fill) {
    const length = values.length;
    const from = Math.max(0, Math.min(start, length));
    const drop = Math.max(0, Math.min(removed, length - from));
    const added = Math.max(0, inserted);
    const next = new Uint8Array(length - drop + added);
    next.set(values.subarray(0, from), 0);
    next.fill(fill, from, from + added);
    const tail = values.subarray(from + drop);
    const dest = from + added;
    if (tail.length && dest < next.length)
        next.set(tail.subarray(0, next.length - dest), dest);
    return next;
}

export function shiftSpans(spans, length, start, removed, inserted) {
    return compact(shiftValues(expand(spans, length), start, removed, inserted, 0));
}

export function retargetSpans(spans, before, after) {
    const edit = editRange(before, after);
    return shiftSpans(spans, Array.from(before).length, edit.start, edit.removed, edit.inserted);
}

export function paintStyle(spans, length, start, end, style) {
    const bits = expand(spans, Math.max(length, end, 0));
    const mask = style & 15;
    const from = Math.max(0, start);
    const to = Math.min(bits.length, end);
    for (let i = from; i < to; i++)
        bits[i] = mask;
    return compact(bits);
}

export function styleAt(spans, length, index) {
    if (index < 0 || index >= length)
        return 0;
    let bits = 0;
    for (const span of spans) {
        if (index >= span.start && index < span.end)
            bits |= span.style & 15;
    }
    return bits;
}

// Bits shared by the characters on either side of an insertion.
export function inheritedStyle(spans, length, index) {
    if (index <= 0 || index >= length)
        return 0;
    return styleAt(spans, length, index - 1) & styleAt(spans, length, index);
}

export function typingStyle(spans, length, cursor) {
    if (length <= 0)
        return 0;
    const index = cursor > 0 ? Math.min(cursor - 1, length - 1) : 0;
    return styleAt(spans, length, index);
}

export function selectionStyle(spans, length, start, end) {
    if (end <= start)
        return null;
    const bits = expand(spans, length);
    let style = 15;
    const to = Math.min(end, bits.length);
    if (to <= start)
        return 0;
    for (let i = Math.max(0, start); i < to; i++)
        style &= bits[i];
    return style & 15;
}

export function toggleBit(spans, length, start, end, bit) {
    if (end <= start)
        return {spans, bits: 0};
    const styles = expand(spans, Math.max(length, end));
    let covered = true;
    for (let i = start; i < end && i < styles.length; i++) {
        if ((styles[i] & bit) === 0) {
            covered = false;
            break;
        }
    }
    for (let i = Math.max(0, start); i < end && i < styles.length; i++) {
        if (covered)
            styles[i] &= ~bit;
        else
            styles[i] |= bit;
    }
    let bits = 15;
    for (let i = Math.max(0, start); i < end && i < styles.length; i++)
        bits &= styles[i];
    return {spans: compact(styles), bits: bits & 15};
}

export function listContinuation(text, newlineAt) {
    const chars = Array.from(text);
    if (chars[newlineAt] !== '\n')
        return null;
    let lineStart = 0;
    for (let i = newlineAt - 1; i >= 0; i--) {
        if (chars[i] === '\n') {
            lineStart = i + 1;
            break;
        }
    }
    const mark = lineMark(chars.slice(lineStart, newlineAt).join(''));
    if (!mark)
        return null;
    return mark.kind === 'bullet' ? bulletPrefix() : checkboxPrefix(false);
}

function lineBounds(chars, index) {
    const at = Math.max(0, Math.min(index, chars.length));
    let start = 0;
    for (let i = at - 1; i >= 0; i--) {
        if (chars[i] === '\n') {
            start = i + 1;
            break;
        }
    }
    let end = chars.length;
    for (let i = at; i < chars.length; i++) {
        if (chars[i] === '\n') {
            end = i;
            break;
        }
    }
    return {start, end};
}

export function ensureMarker(text, cursor, kind) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
    const {start, end} = lineBounds(chars, at);
    const mark = lineMark(chars.slice(start, end).join(''));
    if (mark && mark.kind === kind) {
        const next = chars.slice(0, start).concat(chars.slice(start + mark.chars));
        const nextCursor = at < start + mark.chars ? start : Math.max(start, at - mark.chars);
        return {text: next.join(''), cursor: nextCursor};
    }
    const old = mark ? mark.chars : 0;
    const prefix = Array.from(kind === 'bullet' ? bulletPrefix() : checkboxPrefix(false));
    const next = chars.slice(0, start).concat(prefix, chars.slice(start + old));
    const nextCursor = at < start + old ? start + prefix.length : at + prefix.length - old;
    return {text: next.join(''), cursor: nextCursor};
}

// Backspace inside a marker removes only the marker. The line stays, now
// plain, so Enter on it no longer continues the list.
export function backspaceMarker(text, cursor) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
    const {start, end} = lineBounds(chars, at);
    const mark = lineMark(chars.slice(start, end).join(''));
    if (!mark || at - start > mark.chars)
        return null;
    return {
        text: chars.slice(0, start).concat(chars.slice(start + mark.chars)).join(''),
        cursor: start,
    };
}

// Enter on an item that holds nothing but its marker ends the list there.
export function endList(text, cursor) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
    const {start, end} = lineBounds(chars, at);
    const mark = lineMark(chars.slice(start, end).join(''));
    if (!mark || end !== start + mark.chars || at !== end)
        return null;
    return {
        text: chars.slice(0, start).concat(chars.slice(end)).join(''),
        cursor: start,
    };
}

export function markAt(text, cursor) {
    const chars = Array.from(text);
    const {start, end} = lineBounds(chars, cursor);
    const mark = lineMark(chars.slice(start, end).join(''));
    return mark ? mark.kind : null;
}

export function toggleBoxAt(text, index) {
    const chars = Array.from(text);
    if (index < 0 || index >= chars.length)
        return null;
    const {start, end} = lineBounds(chars, index);
    const mark = lineMark(chars.slice(start, end).join(''));
    if (!mark || mark.kind !== 'check' || index - start >= mark.chars)
        return null;
    chars[start] = mark.done ? BOX_OPEN : BOX_DONE;
    return chars.join('');
}

function utf8Size(ch) {
    const code = ch.codePointAt(0);
    if (code < 0x80)
        return 1;
    if (code < 0x800)
        return 2;
    if (code < 0x10000)
        return 3;
    return 4;
}

export function utf8Length(text) {
    let bytes = 0;
    for (const ch of text)
        bytes += utf8Size(ch);
    return bytes;
}

// Character offset of a Pango byte index.
export function charOffset(text, bytes) {
    let used = 0;
    let chars = 0;
    for (const ch of text) {
        if (used >= bytes)
            break;
        used += utf8Size(ch);
        chars += 1;
    }
    return chars;
}

// Point sizes the text size buttons step through. A size run stores one of
// these; 0 means the note's own size.
const SIZE_STEPS = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32];

export function stepSize(size, delta) {
    if (delta > 0)
        return SIZE_STEPS.find(step => step > size) ?? SIZE_STEPS[SIZE_STEPS.length - 1];
    return SIZE_STEPS.findLast(step => step < size) ?? SIZE_STEPS[0];
}

function expandSizes(sizes, length) {
    const values = new Uint8Array(length);
    for (const run of sizes) {
        const from = Math.max(0, Math.min(length, run.start));
        const to = Math.max(from, Math.min(length, run.end));
        values.fill(run.size, from, to);
    }
    return values;
}

// Text typed at the start of a line takes the size of that line. Anywhere
// else it takes the size of the character before it.
function insertSize(chars, values, at, removed) {
    if (removed > 0)
        return values[at];
    if (at > 0 && chars[at - 1] !== '\n')
        return values[at - 1];
    if (at < chars.length && chars[at] !== '\n')
        return values[at];
    return at > 0 ? values[at - 1] : 0;
}

// Inserted characters take `size`, or the size of the text around them when it is null.
export function editSizes(sizes, before, start, removed, inserted, size = null) {
    const chars = Array.from(before);
    const values = expandSizes(sizes, chars.length);
    const fill = size ?? insertSize(chars, values, start, removed);
    return compact(shiftValues(values, start, removed, inserted, fill), 'size');
}

export function retargetSizes(sizes, before, after) {
    const edit = editRange(before, after);
    return editSizes(sizes, before, edit.start, edit.removed, edit.inserted);
}

export function typingSize(sizes, text, cursor) {
    const chars = Array.from(text);
    const at = Math.max(0, Math.min(cursor, chars.length));
    return insertSize(chars, expandSizes(sizes, chars.length), at, 0);
}

// The size shared by every selected character, or null when they differ.
export function selectionSize(sizes, length, start, end, base) {
    const values = expandSizes(sizes, length);
    const to = Math.min(end, length);
    let size = null;
    for (let i = Math.max(0, start); i < to; i++) {
        const value = values[i] || base;
        if (size !== null && value !== size)
            return null;
        size = value;
    }
    return size ?? base;
}

export function stepSizes(sizes, length, start, end, base, delta) {
    const values = expandSizes(sizes, length);
    const to = Math.min(end, length);
    for (let i = Math.max(0, start); i < to; i++) {
        const next = stepSize(values[i] || base, delta);
        values[i] = next === base ? 0 : next;
    }
    return compact(values, 'size');
}

export function attributeRuns(text, spans, sizes = []) {
    const chars = Array.from(text);
    const length = chars.length;
    const bits = expand(spans, length);
    const points = expandSizes(sizes, length);
    const done = new Uint8Array(length);
    let lineStart = 0;
    for (let i = 0; i <= length; i++) {
        if (i !== length && chars[i] !== '\n')
            continue;
        const mark = lineMark(chars.slice(lineStart, i).join(''));
        if (mark && mark.kind === 'check' && mark.done) {
            for (let n = lineStart + mark.chars; n < i; n++)
                done[n] = 1;
        }
        lineStart = i + 1;
    }
    const offset = new Array(length + 1);
    offset[0] = 0;
    for (let i = 0; i < length; i++)
        offset[i + 1] = offset[i] + utf8Size(chars[i]);
    const runs = [];
    let i = 0;
    while (i < length) {
        let j = i + 1;
        while (j < length && bits[j] === bits[i] && done[j] === done[i] && points[j] === points[i])
            j += 1;
        if (bits[i] || done[i] || points[i]) {
            runs.push({
                start: offset[i],
                end: offset[j],
                style: bits[i],
                done: done[i] === 1,
                size: points[i],
            });
        }
        i = j;
    }
    return runs;
}
