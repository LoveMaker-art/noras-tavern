import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NoraWorldCoreError } from './errors.js';
import { withWorldbookLock } from '../worldbook-lock.js';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw new NoraWorldCoreError(code, message); };

export async function prepareWorldbookEntryEdit({ world, input, directory, exclusive = false, embedded = null }) {
    const resource = embedded ? {
        resource_id: `resource:${digest([world.world_id, 'embedded']).slice(0, 32)}`,
        source_key: 'embedded-worldbook:0', engine: 'sillytavern', ownership: 'external', binding: { name: '', embedded: true },
    } : world.knowledge.find(item => item.binding?.name === input?.name);
    if (!resource) fail('NORA_WORLD_INVALID', 'This Worldbook does not belong to the current World.');
    const name = resource.binding.name;
    if (path.basename(name) !== name || name === '.' || name === '..') fail('NORA_WORLD_INVALID', 'Invalid Worldbook binding.');
    const patch = input?.patch;
    const deleting = input?.operation === 'delete';
    if (input?.operation !== undefined && !['update', 'delete'].includes(input.operation)) fail('NORA_WORLD_INVALID', 'Invalid Worldbook operation.');
    if (deleting && patch != null) fail('NORA_WORLD_INVALID', 'Deletion cannot include entry changes.');
    if (!deleting && (!patch || Array.isArray(patch) || typeof patch !== 'object' || !Object.keys(patch).length
        || Object.keys(patch).some(key => !['comment', 'content', 'key', 'constant', 'disable'].includes(key))
        || ['comment', 'content'].some(key => key in patch && (typeof patch[key] !== 'string' || patch[key].length > 100000))
        || ('constant' in patch && typeof patch.constant !== 'boolean')
        || ('disable' in patch && typeof patch.disable !== 'boolean')
        || ('key' in patch && (!Array.isArray(patch.key) || patch.key.length > 100 || patch.key.some(key => typeof key !== 'string' || key.length > 500))))) {
        fail('NORA_WORLD_INVALID', 'Invalid Worldbook entry changes.');
    }
    return withWorldbookLock(path.join(directory, `${name || world.world_id}.json`), async () => {
        const sourcePath = path.join(directory, `${name}.json`);
        if (!embedded) {
            const stat = await fs.lstat(sourcePath);
            if (!stat.isFile() || stat.isSymbolicLink()) fail('NORA_WORLD_INVALID', 'Unsafe Worldbook file.');
        }
        const source = embedded?.book || JSON.parse(await fs.readFile(sourcePath, 'utf8'));
        if (typeof input.expected_revision !== 'string' || digest(embedded?.raw || source) !== input.expected_revision) {
            fail('NORA_WORLD_REVISION_CONFLICT', 'Worldbook changed; reopen the editor before saving.');
        }
        const id = String(embedded?.entry_id ?? input.entry_id);
        if (!Object.hasOwn(source.entries || {}, id) || !source.entries[id] || typeof source.entries[id] !== 'object') {
            fail('NORA_WORLD_INVALID', 'Worldbook entry no longer exists.');
        }
        const book = structuredClone(source);
        if (deleting) {
            // Keep sibling IDs stable even when an imported book used an array.
            book.entries = Object.fromEntries(Object.entries(book.entries).filter(([key]) => key !== id));
        } else Object.assign(book.entries[id], patch);
        const owned = resource.ownership === 'owned' && exclusive;
        const targetName = owned ? name : `nora-worldbook-${digest([world.world_id, resource.resource_id]).slice(0, 24)}-${crypto.randomUUID()}`;
        const targetPath = path.join(directory, `${targetName}.json`);
        const targetResource = owned ? resource : {
            ...resource,
            resource_id: `resource:${digest([world.world_id, targetName]).slice(0, 32)}`,
            binding: { ...resource.binding, name: targetName, original_name: resource.binding.original_name || name,
                original_names: [...new Set([...(resource.binding.original_names || []), resource.binding.original_name, name].filter(Boolean))] },
            ownership: 'owned',
        };
        // Publish the private copy before changing the World manifest; the source stays intact.
        const temporary = `${targetPath}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, `${JSON.stringify(book, null, 4)}\n`, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, targetPath);
        } finally {
            await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        return {
            resource: targetResource, book, entry_id: id, source_name: name,
            abort: async () => { if (!owned) await fs.unlink(targetPath); },
        };
    });
}
