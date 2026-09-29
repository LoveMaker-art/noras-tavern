import fs from 'node:fs/promises';
import sync, { constants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { NoraWorldCoreError } from './errors.js';

const changed = () => { throw new NoraWorldCoreError('NORA_WORLD_DELETE_PLAN_CHANGED', '删除目标已变化，请重新查看并确认删除。'); };
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

// Names come from authoritative bindings, never caller-supplied filesystem paths.
function inspect(root, name) {
    if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) changed();
    let target = path.resolve(root);
    const parts = name.split(path.sep);
    for (let i = -1; i < parts.length; i++) {
        if (i >= 0) target = path.join(target, parts[i]);
        let stat;
        try { stat = sync.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) changed();
        if (i === parts.length - 1) return { target, stat };
    }
}

export async function snapshotRemovalFile(root, name) {
    const before = inspect(root, name);
    if (!before) return { snapshot: null, remove() { if (inspect(root, name)) changed(); return false; } };
    const handle = await fs.open(before.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let hash;
    try {
        if (!same(before.stat, await handle.stat())) changed();
        const digest = crypto.createHash('sha256');
        const buffer = Buffer.alloc(1024 * 1024);
        let offset = 0;
        while (offset < before.stat.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.stat.size - offset), offset);
            if (!bytesRead) changed();
            digest.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
        if (!same(before.stat, await handle.stat())) changed();
        hash = digest.digest('hex');
    } finally { await handle.close(); }
    const after = inspect(root, name);
    if (!after || !same(before.stat, after.stat)) changed();
    return {
        snapshot: { sha256: hash, bytes: before.stat.size },
        remove() {
            const current = inspect(root, name);
            if (!current) return false;
            if (!same(before.stat, current.stat)) changed();
            // No asynchronous gap between final identity check and unlink.
            sync.unlinkSync(current.target);
            return true;
        },
    };
}

export function assertRemovalSnapshot(actual, expected) {
    // Absence is safe on retry. A formerly absent target that now exists is not.
    if (actual && (!expected || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)) changed();
}
