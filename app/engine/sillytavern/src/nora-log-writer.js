import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export function userLogPaths(directories, name) {
    if (!directories?.root || typeof directories.root !== 'string') {
        throw new Error('Nora logs require a user data root.');
    }
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid Nora log name.');
    const directory = path.resolve(directories.root, 'nora-telemetry');
    return {
        directory,
        active: path.join(directory, `${name}.ndjson`),
        rotated: path.join(directory, `${name}.1.ndjson`),
    };
}

export function createUserLogWriter({ name, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
    const queues = new Map();

    async function write(paths, event) {
        const line = `${JSON.stringify(event)}\n`;
        await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
        // mkdir's mode does not tighten a directory created by an older writer.
        await fs.chmod(paths.directory, 0o700);
        let currentSize = 0;
        try {
            currentSize = (await fs.stat(paths.active)).size;
            await fs.chmod(paths.active, 0o600);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        if (currentSize > 0 && currentSize + Buffer.byteLength(line, 'utf8') > maxFileBytes) {
            await fs.rm(paths.rotated, { force: true });
            await fs.rename(paths.active, paths.rotated);
        }
        await fs.appendFile(paths.active, line, { encoding: 'utf8', mode: 0o600 });
    }

    return Object.freeze({
        async append(directories, event) {
            const paths = userLogPaths(directories, name);
            const key = paths.active;
            const previous = queues.get(key) || Promise.resolve();
            const pending = previous.catch(() => {}).then(() => write(paths, event));
            queues.set(key, pending);
            try {
                await pending;
            } finally {
                if (queues.get(key) === pending) queues.delete(key);
            }
        },
    });
}
