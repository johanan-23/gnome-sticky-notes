// Talks to the sticky-notes process over its runtime socket.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SIGTERM = 15;

export class NotesClient {
    constructor(dir) {
        this._dir = dir;
        this._proc = null;
        this._wayland = null;
        this._syncId = 0;
        this._restartId = 0;
        this._crashes = 0;
        this._missingNoted = false;
        this._onStarted = null;
    }

    start(onStarted) {
        this._onStarted = onStarted;
        this.spawn();
    }

    spawn() {
        if (this._proc && !this._proc.get_if_exited())
            return;

        const binary = this._binary();
        if (!GLib.file_test(binary, GLib.FileTest.IS_EXECUTABLE)) {
            console.error(`[sticky-notes] missing ${binary}`);
            this._noteMissing();
            return;
        }

        const argv = [binary];
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.NONE,
            });
            launcher.setenv('GSK_RENDERER', 'cairo', true);
            this._wayland = Meta.WaylandClient.new_subprocess(global.context, launcher, argv);
            this._proc = this._wayland.get_subprocess();
        } catch (e) {
            logError(e, '[sticky-notes] failed to launch');
            this._wayland = null;
            try {
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.NONE,
                });
                launcher.setenv('GSK_RENDERER', 'cairo', true);
                this._proc = launcher.spawnv(argv);
            } catch (again) {
                logError(again, '[sticky-notes] failed to launch');
                this._proc = null;
                return;
            }
        }

        this._watch(this._proc);
        if (this._onStarted)
            this._onStarted();
    }

    owns(window) {
        return this._wayland !== null && this._wayland.owns_window(window);
    }

    installed() {
        return GLib.file_test(this._binary(), GLib.FileTest.IS_EXECUTABLE);
    }

    command(text) {
        if (!this.send(text))
            this.spawn();
    }

    send(text) {
        try {
            const conn = openSocket(text);
            if (!conn)
                return false;
            conn.close(null);
            return true;
        } catch (e) {
            return false;
        }
    }

    request(text) {
        try {
            const conn = openSocket(text);
            if (!conn)
                return '';
            return readReply(conn);
        } catch (e) {
            return '';
        }
    }

    sync(text) {
        this._syncText = text;
        if (this._syncId) {
            GLib.Source.remove(this._syncId);
            this._syncId = 0;
        }
        let tries = 0;
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            tries += 1;
            if (this.send(this._syncText) || tries > 25) {
                this._syncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._syncId) {
            GLib.Source.remove(this._syncId);
            this._syncId = 0;
        }
        if (this._restartId) {
            GLib.Source.remove(this._restartId);
            this._restartId = 0;
        }

        const proc = this._proc;
        this._proc = null;
        this._wayland = null;
        this._onStarted = null;
        if (!proc)
            return;

        this.send('quit\n');
        if (proc.get_if_exited())
            return;
        try {
            proc.send_signal(SIGTERM);
        } catch (e) {
            // Exited after the quit command.
        }
    }

    _binary() {
        const bundled = GLib.build_filenamev([this._dir, 'bin', 'sticky-notes']);
        if (GLib.file_test(bundled, GLib.FileTest.IS_EXECUTABLE))
            return bundled;
        return GLib.find_program_in_path('sticky-notes') ?? bundled;
    }

    _noteMissing() {
        if (this._missingNoted)
            return;
        this._missingNoted = true;
        Main.notify(
            'Sticky Notes',
            'The notes program is not installed yet. Build it from the project source with install.sh.',
        );
    }

    _watch(proc) {
        proc.wait_async(null, (p, result) => {
            try {
                p.wait_finish(result);
            } catch (e) {
                // Throws when the process was killed.
            }
            if (p !== this._proc)
                return;
            this._proc = null;
            this._wayland = null;
            const clean = p.get_if_exited() && p.get_exit_status() === 0;
            if (clean)
                return;
            this._crashes += 1;
            if (this._crashes > 3) {
                console.error('[sticky-notes] stopped after repeated exits');
                return;
            }
            this._scheduleRestart();
        });
    }

    _scheduleRestart() {
        if (this._restartId) {
            GLib.Source.remove(this._restartId);
            this._restartId = 0;
        }
        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._restartId = 0;
            this.spawn();
            return GLib.SOURCE_REMOVE;
        });
    }
}

function socketPath() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'sticky-notes.sock']);
}

function openSocket(text) {
    const path = socketPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;
    const client = new Gio.SocketClient();
    const conn = client.connect(Gio.UnixSocketAddress.new(path), null);
    conn.output_stream.write_all(new TextEncoder().encode(text), null);
    return conn;
}

function readReply(conn) {
    conn.get_socket().shutdown(false, true, null);
    const chunks = [];
    let total = 0;
    const input = conn.input_stream;
    while (total < 65536) {
        const bytes = input.read_bytes(4096, null);
        const size = bytes.get_size();
        if (size === 0)
            break;
        chunks.push(bytes.get_data());
        total += size;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    conn.close(null);
    return new TextDecoder().decode(merged);
}
