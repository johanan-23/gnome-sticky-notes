import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    MIN_H,
    MIN_W,
    TRASH_LIMIT,
    clamp,
    decodeStore,
    encodeStore,
    freshOrigin,
    normalizeSize,
    normalizeStore,
    overlaps,
    trashLabel,
    trimTrash,
    welcomeNote,
} from '../extension/model.js';

const encode = value => new TextEncoder().encode(JSON.stringify(value));
const AREA = {x: 0, y: 0, w: 1920, h: 1080};

describe('decodeStore', () => {
    it('rejects damaged files so the caller can keep a copy', () => {
        assert.equal(decodeStore(new TextEncoder().encode('{not json')), null);
        assert.equal(decodeStore(encode({notes: 'nope'})), null);
        assert.equal(decodeStore(encode(null)), null);
    });

    it('accepts an empty collection', () => {
        const store = decodeStore(encode({notes: []}));
        assert.deepEqual(store.notes, []);
        assert.equal(store.next_id, 1);
    });
});

describe('normalizeStore', () => {
    it('drops invalid and duplicate notes and raises next_id past every id', () => {
        const store = normalizeStore({
            next_id: 1,
            notes: [{id: 4, text: 'a'}, {id: 4, text: 'dup'}, {id: -1}, null, 'x'],
            trash: [{id: 9}],
        });
        assert.deepEqual(store.notes.map(note => note.id), [4]);
        assert.deepEqual(store.trash.map(note => note.id), [9]);
        assert.equal(store.next_id, 10);
    });

    it('fills defaults and keeps a stored workspace', () => {
        const [note] = normalizeStore({notes: [{id: 1, workspace: 2}]}, 0).notes;
        assert.equal(note.w, 230);
        assert.equal(note.h, 180);
        assert.equal(note.text, '');
        assert.equal(note.workspace, 2);
        assert.equal(note.locked, false);
    });

    it('wraps colour indexes into the palette', () => {
        const [note] = normalizeStore({notes: [{id: 1, color: -1}]}).notes;
        assert.equal(note.color, 15);
    });

    it('drops malformed style and size runs', () => {
        const [note] = normalizeStore({
            notes: [{
                id: 1,
                spans: [{start: 0, end: 2, style: 1}, {start: 3, end: 1, style: 1}, {start: 0, end: 1, style: 99}],
                sizes: [{start: 0, end: 1, size: 20}, {start: 0, end: 1, size: 500}],
            }],
        }).notes;
        assert.deepEqual(note.spans, [{start: 0, end: 2, style: 1}]);
        assert.deepEqual(note.sizes, [{start: 0, end: 1, size: 20}]);
    });

    it('expands a note saved collapsed', () => {
        const [note] = normalizeStore({notes: [{id: 1, h: 40, expanded_h: 300, collapsed: true}]}).notes;
        assert.equal(note.h, 300);
        assert.equal(note.collapsed, false);
    });
});

describe('encodeStore', () => {
    it('round-trips through decodeStore', () => {
        const store = normalizeStore({
            hidden: true,
            notes: [{id: 1, x: 10, y: 20, w: 300, h: 200, text: 'hello', spans: [{start: 0, end: 5, style: 1}]}],
        });
        const again = decodeStore(encode(encodeStore(store)));
        assert.deepEqual(again, store);
    });
});

describe('trimTrash', () => {
    it('keeps only the newest notes', () => {
        const store = {trash: Array.from({length: TRASH_LIMIT + 5}, (_, i) => ({id: i + 1}))};
        trimTrash(store);
        assert.equal(store.trash.length, TRASH_LIMIT);
        assert.equal(store.trash[0].id, 6);
    });
});

describe('normalizeSize', () => {
    it('maps the legacy 0/1/2 sizes and rejects nonsense', () => {
        assert.equal(normalizeSize(0), 11);
        assert.equal(normalizeSize(1), 13);
        assert.equal(normalizeSize(2), 16);
        assert.equal(normalizeSize(14), 14);
        assert.equal(normalizeSize(99), 13);
        assert.equal(normalizeSize('x'), 13);
    });
});

describe('trashLabel', () => {
    it('uses the first line with text, without its list marker', () => {
        assert.equal(trashLabel('\n\n• Groceries\nmilk'), 'Groceries');
    });

    it('labels empty notes and strips control characters', () => {
        assert.equal(trashLabel('   \n'), 'Empty note');
        assert.equal(trashLabel('a\tb'), 'a b');
    });

    it('caps the label at 48 characters', () => {
        assert.equal([...trashLabel('x'.repeat(100))].length, 48);
    });
});

describe('clamp', () => {
    it('keeps a note inside the work area with an 8px margin', () => {
        assert.deepEqual(clamp(-50, -50, 200, 150, [AREA], MIN_W, MIN_H, 440, 460), [8, 8, 200, 150]);
        assert.deepEqual(clamp(5000, 5000, 200, 150, [AREA], MIN_W, MIN_H, 440, 460), [1712, 922, 200, 150]);
    });

    it('enforces the minimum and maximum size', () => {
        const [, , w, h] = clamp(100, 100, 10, 9999, [AREA], MIN_W, MIN_H, 440, 460);
        assert.equal(w, MIN_W);
        assert.equal(h, 460);
    });

    it('moves a note to the monitor its centre is on', () => {
        const right = {x: 1920, y: 0, w: 1280, h: 1024};
        const [x] = clamp(2000, 100, 200, 150, [AREA, right], MIN_W, MIN_H, 440, 460);
        assert.equal(x, 2000);
    });

    it('passes the note through when there are no monitors', () => {
        assert.deepEqual(clamp(1, 2, 300, 300, [], MIN_W, MIN_H, 440, 460), [1, 2, 300, 300]);
    });
});

describe('placement', () => {
    it('detects overlap including the gap', () => {
        assert.equal(overlaps(0, 0, 100, 100, 16, [[110, 0, 100, 100]]), true);
        assert.equal(overlaps(0, 0, 100, 100, 16, [[200, 0, 100, 100]]), false);
    });

    it('centres the first note', () => {
        assert.deepEqual(freshOrigin([], [AREA], 200, 100, null, null), [860, 490]);
    });

    it('opens at the pointer when that spot is free', () => {
        assert.deepEqual(freshOrigin([], [AREA], 200, 100, [500, 500], null), [480, 490]);
    });

    it('never places a new note on top of another', () => {
        const obstacles = [[480, 490, 200, 100]];
        const [x, y] = freshOrigin(obstacles, [AREA], 200, 100, [500, 500], null);
        assert.equal(overlaps(x, y, 200, 100, 16, obstacles), false);
    });

    it('centres the welcome note on the primary monitor', () => {
        const note = welcomeNote([AREA], 1, 0);
        assert.equal(note.x, 840);
        assert.equal(note.y, 430);
        assert.ok(note.text.length > 0);
    });
});
