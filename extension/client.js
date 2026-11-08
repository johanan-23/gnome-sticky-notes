// Talks to the sticky-notes process over its runtime socket.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class NotesClient {
    constructor(dir) {
        this._dir = dir;
        this._syncId = 0;
    }

    installed() {
        return GLib.file_test(this._binary(), GLib.FileTest.IS_EXECUTABLE);
    }

    command(text) {
        this.send(text);
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
    }

    _binary() {
        const bundled = GLib.build_filenamev([this._dir, 'bin', 'sticky-notes']);
        if (GLib.file_test(bundled, GLib.FileTest.IS_EXECUTABLE))
            return bundled;
        return GLib.find_program_in_path('sticky-notes') ?? bundled;
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
