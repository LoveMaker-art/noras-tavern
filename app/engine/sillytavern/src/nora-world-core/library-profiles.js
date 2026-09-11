import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './atomic-json.js';
import { stableStringify } from './domain.js';
import { NoraWorldCoreError } from './errors.js';
import { normalizeCharacterActivation, createStoryContext, editStoryCharacter } from '../../public/scripts/nora-worlds/story-context.js';

const fail = message => { throw new NoraWorldCoreError('NORA_WORLD_INVALID', message); };
const hash = value => crypto.createHash('sha256').update(stableStringify(value)).digest('hex');

function normalize(input) {
    if (!input || !['character', 'persona'].includes(input.kind)) fail('Choose character or persona.');
    const data = input.data;
    const allowed = input.kind === 'persona' ? ['name', 'description'] : ['name', 'description', 'personality', 'activation', 'profile'];
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(key => !allowed.includes(key))) fail('Unsupported profile fields.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) fail('A library name is required (at most 200 characters).');
    const result = {};
    for (const key of allowed.filter(key => !['activation', 'profile'].includes(key))) {
        if (data[key] !== undefined && typeof data[key] !== 'string') fail(`Invalid ${key}.`);
        const fromProfile = key === 'description' ? data.profile?.identity?.description : key === 'personality' ? data.profile?.personality?.summary : '';
        result[key] = data[key] ?? (typeof fromProfile === 'string' ? fromProfile : '');
        if (result[key].length > (key === 'name' ? 500 : 100000)) fail(`Oversized ${key}.`);
    }
    if (!result.name.trim()) fail('A character name is required.');
    if (input.kind === 'character') {
        try {
            result.activation = normalizeCharacterActivation(data.activation);
            if (data.profile !== undefined) result.profile = editStoryCharacter(createStoryContext(), {
                id: 'template', operation: 'create', patch: { profile: data.profile, name: result.name,
                    description: result.description, personality: result.personality },
            }).characters[0].profile;
        }
        catch (error) { fail(error.message); }
    }
    const normalized = { schema: 1, kind: input.kind, name: input.name.trim(), data: result };
    if (Buffer.byteLength(JSON.stringify(normalized)) > 900000) fail('Profile exceeds the storage size limit.');
    return normalized;
}

// Immutable named templates: retries reuse identical content; changed content needs a new name.
export function createProfileLibrary({ root, locks }) {
    const directory = path.join(root, 'library-profiles');
    function filename(id) {
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('Invalid profile identity.');
        return path.join(directory, `${id}.json`);
    }
    async function read(id) {
        const file = filename(id);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('Unsafe library profile.');
        const item = JSON.parse(await fs.readFile(file, 'utf8'));
        const normalized = normalize(item);
        if (item.id !== id || item.revision !== hash(normalized)) fail('Library profile integrity check failed.');
        return item;
    }
    async function list(kind) {
        if (!['character', 'persona'].includes(kind)) fail('Choose character or persona.');
        let files;
        try { files = await fs.readdir(directory); }
        catch (error) { if (error.code === 'ENOENT') return { items: [], warnings: [] }; throw error; }
        const items = [], warnings = [];
        for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
            try {
                const item = await read(file.slice(0, -5));
                if (item.kind === kind) items.push({ id: item.id, revision: item.revision, kind, name: item.name, character_name: item.data.name });
            } catch (error) { warnings.push({ id: file.slice(0, -5), message: error.message }); }
        }
        return { items: items.sort((a, b) => a.name.localeCompare(b.name)), warnings };
    }
    async function save(input) {
        const value = normalize(input);
        const id = hash([value.kind, value.name]);
        const revision = hash(value);
        return locks.run('library:profiles', async () => {
            let existing;
            try { existing = await read(id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (existing) {
                if (existing.revision !== revision) fail('库中已有同名资料，请更换名称后另存；不会覆盖原资料。');
                return { item: existing, reused: true };
            }
            const item = { ...value, id, revision };
            await writeJsonAtomic(filename(id), item);
            return { item, reused: false };
        });
    }
    async function remove(id, revision) {
        return locks.run('library:profiles', async () => {
            const item = await read(id);
            if (item.revision !== revision) throw new NoraWorldCoreError('NORA_WORLD_REVISION_CONFLICT', 'Profile changed; reopen its preview.');
            await fs.unlink(filename(id));
            return { deleted: true };
        });
    }
    return { list, read, save, remove };
}
