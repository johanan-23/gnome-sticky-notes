import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    attributeRuns,
    backspaceMarker,
    bulletPrefix,
    charOffset,
    checkboxPrefix,
    editRange,
    editSizes,
    endList,
    ensureMarker,
    inheritedStyle,
    lineMark,
    listContinuation,
    markAt,
    paintStyle,
    selectionSize,
    selectionStyle,
    shiftSpans,
    stepSize,
    toggleBit,
    toggleBoxAt,
    utf8Length,
    STYLE_BOLD,
    STYLE_ITALIC,
} from '../extension/format.js';

const BOX = checkboxPrefix(false);
const DONE = checkboxPrefix(true);
const BULLET = bulletPrefix();

describe('lineMark', () => {
    it('reads checkbox and bullet markers', () => {
        assert.deepEqual(lineMark(`${BOX}task`), {kind: 'check', done: false, chars: 3});
        assert.deepEqual(lineMark(`${DONE}task`), {kind: 'check', done: true, chars: 3});
        assert.deepEqual(lineMark(`${BULLET}item`), {kind: 'bullet', chars: 2});
    });

    it('returns null for plain and empty lines', () => {
        assert.equal(lineMark('plain'), null);
        assert.equal(lineMark(''), null);
    });
});

describe('editRange', () => {
    it('finds an insertion', () => {
        assert.deepEqual(editRange('abc', 'abXc'), {start: 2, removed: 0, inserted: 1});
    });

    it('finds a replacement', () => {
        assert.deepEqual(editRange('hello', 'hEllo'), {start: 1, removed: 1, inserted: 1});
    });

    it('counts characters, not UTF-16 units', () => {
        assert.deepEqual(editRange('a😀b', 'a😀xb'), {start: 2, removed: 0, inserted: 1});
    });
});

describe('style spans', () => {
    it('shifts spans after an insertion', () => {
        const spans = [{start: 2, end: 4, style: STYLE_BOLD}];
        assert.deepEqual(shiftSpans(spans, 5, 0, 0, 2), [{start: 4, end: 6, style: STYLE_BOLD}]);
    });

    it('drops styling for removed characters', () => {
        const spans = [{start: 0, end: 3, style: STYLE_BOLD}];
        assert.deepEqual(shiftSpans(spans, 3, 0, 3, 0), []);
    });

    it('toggles a bit on and back off', () => {
        const on = toggleBit([], 5, 1, 3, STYLE_ITALIC);
        assert.deepEqual(on.spans, [{start: 1, end: 3, style: STYLE_ITALIC}]);
        assert.equal(on.bits, STYLE_ITALIC);
        const off = toggleBit(on.spans, 5, 1, 3, STYLE_ITALIC);
        assert.deepEqual(off.spans, []);
    });

    it('reports a shared selection style', () => {
        const spans = paintStyle([], 6, 0, 6, STYLE_BOLD | STYLE_ITALIC);
        assert.equal(selectionStyle(spans, 6, 1, 4), STYLE_BOLD | STYLE_ITALIC);
        assert.equal(selectionStyle(spans, 6, 2, 2), null);
    });

    it('inherits only bits shared by both neighbours', () => {
        const spans = [{start: 0, end: 2, style: STYLE_BOLD | STYLE_ITALIC}, {start: 2, end: 4, style: STYLE_BOLD}];
        assert.equal(inheritedStyle(spans, 4, 2), STYLE_BOLD);
        assert.equal(inheritedStyle(spans, 4, 0), 0);
    });
});

describe('list markers', () => {
    it('continues a bullet list after Enter', () => {
        assert.equal(listContinuation(`${BULLET}one\n`, 5), BULLET);
        assert.equal(listContinuation('plain\n', 5), null);
    });

    it('continues a checklist with an open box', () => {
        assert.equal(listContinuation(`${DONE}done\n`, 7), BOX);
    });

    it('adds and removes a marker on the cursor line', () => {
        const added = ensureMarker('one\ntwo', 5, 'bullet');
        assert.equal(added.text, `one\n${BULLET}two`);
        assert.equal(added.cursor, 7);
        const removed = ensureMarker(added.text, added.cursor, 'bullet');
        assert.equal(removed.text, 'one\ntwo');
    });

    it('swaps one marker kind for the other', () => {
        assert.equal(ensureMarker(`${BULLET}x`, 2, 'check').text, `${BOX}x`);
    });

    it('backspace inside a marker removes only the marker', () => {
        assert.deepEqual(backspaceMarker(`${BULLET}item`, 2), {text: 'item', cursor: 0});
        assert.equal(backspaceMarker(`${BULLET}item`, 4), null);
    });

    it('Enter on an empty item ends the list', () => {
        assert.deepEqual(endList(`a\n${BULLET}`, 4), {text: 'a\n', cursor: 2});
        assert.equal(endList(`${BULLET}x`, 3), null);
    });

    it('toggles a checkbox only on its marker', () => {
        assert.equal(toggleBoxAt(`${BOX}task`, 0), `${DONE}task`);
        assert.equal(toggleBoxAt(`${DONE}task`, 0), `${BOX}task`);
        assert.equal(toggleBoxAt(`${BOX}task`, 4), null);
        assert.equal(toggleBoxAt('plain', 0), null);
    });

    it('reports the marker kind at the cursor', () => {
        assert.equal(markAt(`x\n${BOX}y`, 3), 'check');
        assert.equal(markAt(`x\n${BOX}y`, 0), null);
    });
});

describe('utf-8 offsets', () => {
    it('measures bytes', () => {
        assert.equal(utf8Length('aé€😀'), 1 + 2 + 3 + 4);
    });

    it('maps a byte index back to characters', () => {
        assert.equal(charOffset('aé€😀', 0), 0);
        assert.equal(charOffset('aé€😀', 3), 2);
        assert.equal(charOffset('aé€😀', 10), 4);
    });
});

describe('text sizes', () => {
    it('steps through the size list and stops at its ends', () => {
        assert.equal(stepSize(13, 1), 14);
        assert.equal(stepSize(14, 1), 16);
        assert.equal(stepSize(13, -1), 12);
        assert.equal(stepSize(32, 1), 32);
        assert.equal(stepSize(8, -1), 8);
    });

    it('gives typed text the size of the character before it', () => {
        const sizes = [{start: 0, end: 3, size: 20}];
        assert.deepEqual(editSizes(sizes, 'abc', 3, 0, 2), [{start: 0, end: 5, size: 20}]);
    });

    it('uses an explicit size for typed text', () => {
        assert.deepEqual(editSizes([], 'abc', 3, 0, 1, 24), [{start: 3, end: 4, size: 24}]);
    });

    it('reports null for a mixed selection', () => {
        const sizes = [{start: 0, end: 2, size: 20}];
        assert.equal(selectionSize(sizes, 4, 0, 2, 13), 20);
        assert.equal(selectionSize(sizes, 4, 0, 4, 13), null);
        assert.equal(selectionSize([], 4, 0, 4, 13), 13);
    });
});

describe('attributeRuns', () => {
    it('emits byte offsets for Pango', () => {
        const runs = attributeRuns('é bold', [{start: 2, end: 6, style: STYLE_BOLD}]);
        assert.deepEqual(runs, [{start: 3, end: 7, style: STYLE_BOLD, done: false, size: 0}]);
    });

    it('marks the text of a ticked checkbox as done', () => {
        const runs = attributeRuns(`${DONE}ok`, []);
        assert.equal(runs.length, 1);
        assert.equal(runs[0].done, true);
    });

    it('returns nothing for plain text', () => {
        assert.deepEqual(attributeRuns('plain', []), []);
    });
});
