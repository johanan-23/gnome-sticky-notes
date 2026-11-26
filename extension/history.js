// Undo and redo for one note. A snapshot is {text, spans, sizes, cursor}.
// Pure, so the unit tests can run it outside the Shell.

export const HISTORY_LIMIT = 200;
// Typing pauses longer than this start a new undo step.
export const MERGE_MS = 1200;

function copySnapshot(state) {
    return {
        text: state.text,
        spans: (state.spans ?? []).map(span => ({...span})),
        sizes: (state.sizes ?? []).map(run => ({...run})),
        cursor: state.cursor,
    };
}

export class EditHistory {
    constructor(limit = HISTORY_LIMIT) {
        this._limit = limit;
        this._past = [];
        this._future = [];
        this._last = null;
    }

    canUndo() {
        return this._past.length > 0;
    }

    canRedo() {
        return this._future.length > 0;
    }

    // Call with the state from before a change. Runs of single-character
    // typing, or of backspace or delete, made close together and at
    // neighbouring positions fold into one step.
    //   kind: 'insert' | 'delete' | 'edit'
    //   at:   character offset where the change happened
    record(before, kind = 'edit', at = -1, now = Date.now()) {
        const last = this._last;
        const merge = last && kind !== 'edit' && last.kind === kind &&
            now - last.time <= MERGE_MS && this._past.length > 0 &&
            (kind === 'insert' ? at === last.at + 1 : at === last.at - 1 || at === last.at);
        this._future = [];
        if (!merge) {
            this._past.push(copySnapshot(before));
            if (this._past.length > this._limit)
                this._past.splice(0, this._past.length - this._limit);
        }
        this._last = kind === 'edit' ? null : {kind, at, time: now};
    }

    // Ends the current typing run, so the next keystroke is its own step.
    seal() {
        this._last = null;
    }

    // Returns the state to show, or null. current is the state on screen.
    undo(current) {
        if (!this._past.length)
            return null;
        this._last = null;
        this._future.push(copySnapshot(current));
        return this._past.pop();
    }

    redo(current) {
        if (!this._future.length)
            return null;
        this._last = null;
        this._past.push(copySnapshot(current));
        return this._future.pop();
    }

    clear() {
        this._past = [];
        this._future = [];
        this._last = null;
    }
}
