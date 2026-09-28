// Per-record compatibility failures are data outcomes, not transaction failures.
// I/O, unsafe filesystem entries and programming errors still abort the update.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class DeferredData extends Error {}
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export function parseData(bytes) {
    try { return JSON.parse(bytes.toString('utf8')); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // JSON parser messages may contain private source text.
        throw new DeferredData('Invalid JSON; original bytes retained');
    }
}

export class ImportPlan {
    outputs = new Map();
    deferred = [];
    archived = [];
    sourceDigests = {};

    remember(name, bytes) {
        this.sourceDigests[name] = crypto.createHash('sha256').update(bytes).digest('hex');
    }

    put(name, value) {
        if (path.isAbsolute(name) || name.split('/').includes('..') || this.outputs.has(name)) throw new Error('Unsafe or duplicate migration output');
        this.outputs.set(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + '\n'));
    }

    async record(kind, id, file, convert) {
        const previous = new Set(this.outputs.keys());
        try { await convert(); return true; }
        catch (error) {
            if (!(error instanceof DeferredData)) throw error;
            // Failed Worlds never leave cards, chats or manifests behind.
            for (const name of this.outputs.keys()) if (!previous.has(name)) this.outputs.delete(name);
            this.deferred.push({ kind, id, file, code: 'PENDING_CONVERSION', reason: error.message });
            return false;
        }
    }

    async namespace(root, name) {
        const result = new Map();
        let entries;
        try { entries = await fs.readdir(path.join(root, name), { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return result; throw error; }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const file = name + '/' + entry.name;
            if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('Unsafe Python source entry: ' + file);
            // Preserve auxiliary directories in the archive; never interpret their contents as active records.
            if (entry.isDirectory()) {
                const scan = async directory => {
                    this.remember(directory + '/', Buffer.from('directory'));
                    for (const child of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
                        const relative = directory + '/' + child.name;
                        if (child.isDirectory()) await scan(relative);
                        else if (child.isFile()) this.remember(relative, await fs.readFile(path.join(root, relative)));
                        else throw new Error('Unsafe Python source entry: ' + relative);
                    }
                };
                await scan(file);
                this.archived.push({ kind: name, file, code: 'AUXILIARY_ARCHIVED' });
                continue;
            }
            const bytes = await fs.readFile(path.join(root, file));
            this.remember(file, bytes);
            if (!entry.name.endsWith('.json')) {
                this.archived.push({ kind: name, file, code: 'AUXILIARY_ARCHIVED' });
                continue;
            }
            await this.record(name, null, file, () => {
                const item = parseData(bytes);
                if (!object(item) || !validId(item.id) || entry.name !== item.id + '.json' || result.has(item.id)) throw new DeferredData('Invalid record identity');
                result.set(item.id, item);
            });
        }
        return result;
    }
}
