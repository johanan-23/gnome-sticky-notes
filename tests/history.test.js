import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {EditHistory, HISTORY_LIMIT, MERGE_MS} from '../extension/history.js';

const state = (text, cursor = Array.from(text).length) => ({text, spans: [], sizes: [], cursor});

describe('EditHistory', () => {
    it('undoes and redoes a single edit', () => {
        const history = new EditHistory();
        history.record(state('a'), 'edit');
        assert.equal(history.canUndo(), true);
        const back = history.undo(state('ab'));
        assert.equal(back.text, 'a');
        assert.equal(history.canRedo(), true);
        const forward = history.redo(state('a'));
        assert.equal(forward.text, 'ab');
        assert.equal(history.canRedo(), false);
    });

    it('folds a run of typing into one step', () => {
        const history = new EditHistory();
        history.record(state(''), 'insert', 0, 1000);
        history.record(state('h'), 'insert', 1, 1100);
        history.record(state('hi'), 'insert', 2, 1200);
        assert.equal(history.undo(state('hi!')).text, '');
        assert.equal(history.canUndo(), false);
    });

    it('splits typing after a pause, a seal, or a jump', () => {
        const paused = new EditHistory();
        paused.record(state(''), 'insert', 0, 0);
        paused.record(state('a'), 'insert', 1, MERGE_MS + 1);
        assert.equal(paused.undo(state('ab')).text, 'a');

        const sealed = new EditHistory();
        sealed.record(state(''), 'insert', 0, 0);
        sealed.seal();
        sealed.record(state('a'), 'insert', 1, 1);
        assert.equal(sealed.undo(state('ab')).text, 'a');

        const jumped = new EditHistory();
        jumped.record(state('xy'), 'insert', 0, 0);
        jumped.record(state('axy'), 'insert', 3, 1);
        assert.equal(jumped.undo(state('axyb')).text, 'axy');
    });

    it('folds backspace runs and keeps typing and deleting apart', () => {
        const history = new EditHistory();
        history.record(state('abc'), 'delete', 2, 0);
        history.record(state('ab'), 'delete', 1, 1);
        history.record(state('a'), 'insert', 1, 2);
        assert.equal(history.undo(state('az')).text, 'a');
        assert.equal(history.undo(state('a')).text, 'abc');
    });

    it('drops redo once something new is recorded', () => {
        const history = new EditHistory();
        history.record(state('a'), 'edit');
        history.undo(state('ab'));
        history.record(state('a'), 'edit');
        assert.equal(history.canRedo(), false);
    });

    it('keeps its own copy of spans', () => {
        const history = new EditHistory();
        const before = {text: 'a', spans: [{start: 0, end: 1, style: 1}], sizes: [], cursor: 1};
        history.record(before, 'edit');
        before.spans[0].style = 4;
        assert.equal(history.undo(state('b')).spans[0].style, 1);
    });

    it('forgets the oldest steps past the limit', () => {
        const history = new EditHistory();
        for (let i = 0; i < HISTORY_LIMIT + 5; i++)
            history.record(state(String(i)), 'edit');
        let steps = 0;
        while (history.undo(state('x')))
            steps++;
        assert.equal(steps, HISTORY_LIMIT);
    });

    it('returns null with nothing to undo or redo', () => {
        const history = new EditHistory();
        assert.equal(history.undo(state('')), null);
        assert.equal(history.redo(state('')), null);
    });
});
