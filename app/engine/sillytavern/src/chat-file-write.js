import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const WINDOWS_RENAME_DELAYS = [20, 50, 100, 200];

/** Replace a chat atomically, retaining the synchronous revision-check boundary. */
export function writeChatFileSync(filePath, data, { beforeWrite = null, platform = process.platform } = {}) {
    for (let attempt = 0; ; attempt++) {
        beforeWrite?.();
        // Match the same destination spelling used by write-file-atomic,
        // including native Windows short paths and an existing file's links.
        let destination = filePath;
        try { destination = fs.realpathSync(filePath); } catch { /* New chat. */ }
        try {
            return writeFileAtomicSync(filePath, data, 'utf8');
        } catch (error) {
            // Retry only replacement contention. The atomic writer removes its
            // failed temporary file; never unlink the existing chat to proceed.
            const delay = WINDOWS_RENAME_DELAYS[attempt];
            if (platform !== 'win32' || delay === undefined || error.syscall !== 'rename'
                || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
                || typeof error.dest !== 'string' || path.resolve(error.dest) !== path.resolve(destination)) throw error;
            // A short synchronous wait prevents another server operation from
            // entering between the ledger guard and commit. Recheck on retry.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        }
    }
}
