import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function documentFileName(identity) {
    return `${crypto.createHash('sha256').update(String(identity)).digest('hex')}.json`;
}

export async function readJsonFile(filePath, { fileSystem = fs } = {}) {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
}

async function syncDirectory(directory, fileSystem) {
    let handle;
    try {
        handle = await fileSystem.open(directory, 'r');
        await handle.sync();
    } catch {
        // Some filesystems do not allow directory fsync. The file itself was synced.
    } finally {
        await handle?.close().catch(() => {});
    }
}

export async function writeJsonAtomic(filePath, value, { fileSystem = fs } = {}) {
    const directory = path.dirname(filePath);
    await fileSystem.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    let handle;
    try {
        handle = await fileSystem.open(temporary, 'wx', 0o600);
        await handle.writeFile(text, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fileSystem.rename(temporary, filePath);
        await syncDirectory(directory, fileSystem);
    } catch (error) {
        await handle?.close().catch(() => {});
        await fileSystem.unlink(temporary).catch(() => {});
        throw error;
    }
}

export async function quarantineFile(filePath, quarantineDirectory, { fileSystem = fs } = {}) {
    await fileSystem.mkdir(quarantineDirectory, { recursive: true });
    const target = path.join(
        quarantineDirectory,
        `${path.basename(filePath)}.${crypto.randomUUID()}.invalid`,
    );
    await fileSystem.rename(filePath, target);
    return target;
}
