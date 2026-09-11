import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { stableStringify } from './domain.js';
import { writeJsonAtomic } from './atomic-json.js';
import { NoraWorldCoreError } from './errors.js';
import { persistImmutable } from './st-import-staging.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = message => { throw new NoraWorldCoreError('NORA_WORLD_INVALID', message); };
const runtimeName = name => /--nora-(?:[a-f0-9]{10}|internal)\.png$/.test(name);

async function readSafe(root, name) {
    if (typeof name !== 'string' || !name || /[/\\\0]/.test(name) || path.basename(name) !== name || name === '.' || name === '..') invalid('Invalid card filename.');
    const handle = await fs.open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 100 * 1024 * 1024) invalid('Invalid card file.');
        return await handle.readFile();
    } finally { await handle.close(); }
}

function fingerprint(decoded) {
    const bytes = decoded.runtimeCardBuffer;
    let image = digest(bytes);
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        const chunks = extract(new Uint8Array(bytes)).filter(chunk => chunk.name !== 'tEXt'
            || !['chara', 'ccv3'].includes(PNGtext.decode(chunk.data).keyword.toLowerCase()));
        image = digest(Buffer.concat(chunks.flatMap(chunk => [Buffer.from(chunk.name), Buffer.from(chunk.data)])));
    }
    const assets = [...(decoded.extractedAssetBuffers || new Map())].map(([name, bytes]) => [name, digest(bytes)]).sort(([a], [b]) => a.localeCompare(b));
    const card = structuredClone(decoded.card);
    // ST's import timestamp/chat locator are storage metadata, not authored content.
    for (const key of ['create_date', 'chat', 'avatar', 'date_added', 'date_last_chat', 'chat_size']) delete card[key];
    if (card.data?.extensions) delete card.data.extensions.nora_import;
    if (['chara_card_v2', 'chara_card_v3'].includes(card.spec)) {
        card.spec = 'tavern-card'; delete card.spec_version;
        for (const key of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'tags']) {
            if (stableStringify(card[key]) === stableStringify(card.data?.[key])) delete card[key];
        }
    }
    return digest(stableStringify({ card, image, assets, auxiliary: decoded.auxiliaryAssets || [] }));
}

export function createCardLibrary({ roots, stagingRoot, cardCodec, locks }) {
    const directory = path.join(path.dirname(stagingRoot), 'library-cards');
    const archives = path.join(directory, 'sources');
    async function records() {
        let files;
        try { files = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        const result = [];
        for (const name of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
            const item = JSON.parse((await readSafe(directory, name)).toString());
            if (item.id !== name.slice(0, -5) || typeof item.avatar !== 'string' || !Array.isArray(item.aliases)) invalid('Invalid library index.');
            result.push(item);
        }
        return result;
    }
    async function scan(worlds = []) {
        const protectedAvatars = new Set(worlds.flatMap(world => [world.runtime_card?.binding?.avatar,
            ...(world.sessions?.items || []).map(session => session.binding?.avatar)]));
        const indexed = await records();
        const items = [], warnings = [];
        let files = [];
        try { files = await fs.readdir(roots.characters); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const name of files.filter(name => name.endsWith('.png')).sort()) {
            if (runtimeName(name) || protectedAvatars.has(name)) continue;
            try {
                const buffer = await readSafe(roots.characters, name);
                let decoded = await cardCodec.decode({ buffer, format: 'png' });
                if ((decoded.card.data || decoded.card).extensions?.nora_internal) continue;
                const record = indexed.find(item => item.avatar === name && item.png_digest === digest(buffer));
                if (record) {
                    const original = await readSafe(archives, record.source_file);
                    if (digest(original) !== record.source_digest) invalid('Library source checksum mismatch.');
                    const source = await cardCodec.decode({ buffer: original, format: record.format });
                    decoded = { ...source, card: decoded.card, runtimeCardBuffer: buffer };
                }
                const id = fingerprint(decoded);
                items.push({ id, avatar: name, name: String((decoded.card.data || decoded.card).name || name), buffer, record, decoded });
            } catch (error) { warnings.push({ avatar: name, message: error.message }); }
        }
        return { items, warnings };
    }
    async function isReferenced(avatar, worlds) {
        if (runtimeName(avatar) || worlds.some(world => world.runtime_card?.binding?.avatar === avatar
            || world.sessions?.items?.some(session => session.binding?.avatar === avatar))) return true;
        const basename = path.parse(avatar).name;
        for (const root of [roots.chats, roots.characters]) {
            try { if ((await fs.readdir(path.join(root, basename))).length) return true; }
            catch (error) { if (error.code !== 'ENOENT') return true; }
        }
        const parent = path.dirname(roots.characters);
        const references = value => typeof value === 'string' ? value.includes(avatar)
            : Array.isArray(value) ? value.some(references)
                : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) => key.includes(avatar) || references(item)) : false;
        try {
            let settings;
            try { settings = JSON.parse(await fs.readFile(path.join(parent, 'settings.json'), 'utf8')); }
            catch (error) { if (error.code !== 'ENOENT') return true; }
            if (references(settings)) return true;
            let groups = [];
            try { groups = await fs.readdir(path.join(parent, 'groups')); } catch (error) { if (error.code !== 'ENOENT') return true; }
            for (const file of groups.filter(name => name.endsWith('.json'))) {
                if (references(JSON.parse((await readSafe(path.join(parent, 'groups'), file)).toString()))) return true;
            }
        } catch { return true; }
        return false;
    }
    async function save({ buffer, format }, worlds = []) {
        if (!['png', 'json', 'yaml', 'yml', 'charx', 'byaf'].includes(format)) invalid('Unsupported card format.');
        if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 100 * 1024 * 1024) invalid('Invalid card size.');
        return locks.run('library:cards', async () => {
            const decoded = await cardCodec.decode({ buffer, format });
            // Hash the PNG round-trip representation, also used when inspecting existing files.
            const canonical = await cardCodec.decode({ buffer: decoded.runtimeCardBuffer, format: 'png' });
            const complete = { ...decoded, ...canonical };
            const id = fingerprint(complete);
            const scanned = await scan(worlds);
            const matches = scanned.items.filter(item => item.id === id);
            const keeper = matches.find(item => item.record) || matches[0];
            let avatar = keeper?.avatar || `nora-card-${id}.png`;
            if (!keeper) {
                try { await fs.lstat(path.join(roots.characters, avatar)); avatar = `nora-card-${id}-${crypto.randomUUID()}.png`; }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            await fs.mkdir(archives, { recursive: true });
            await fs.mkdir(roots.characters, { recursive: true });
            const sourceFile = keeper?.record?.source_file || `${digest(buffer)}.${format}`;
            if (!keeper?.record) await persistImmutable(path.join(archives, sourceFile), buffer);
            if (!keeper) await persistImmutable(path.join(roots.characters, avatar), complete.runtimeCardBuffer);
            const record = { id, avatar, name: String((complete.card.data || complete.card).name || avatar), format: keeper?.record?.format || format,
                source_file: sourceFile, source_digest: keeper?.record?.source_digest || digest(buffer),
                source_digests: [...new Set([...(keeper?.record?.source_digests || []), keeper?.record?.source_digest, digest(buffer)].filter(Boolean))],
                png_digest: digest(keeper?.buffer || complete.runtimeCardBuffer),
                aliases: [...new Set([...(keeper?.record?.aliases || []), ...matches.filter(item => item.avatar !== avatar).map(item => item.avatar)])] };
            await writeJsonAtomic(path.join(directory, `${id}.json`), record);
            const removed = [], retained = [];
            for (const duplicate of matches.filter(item => item.avatar !== avatar)) {
                if (await isReferenced(duplicate.avatar, worlds)) { retained.push(duplicate.avatar); continue; }
                // Recheck bytes immediately before removal; never clean by name or an old index hash.
                try {
                    if (!(await readSafe(roots.characters, duplicate.avatar)).equals(duplicate.buffer)) { retained.push(duplicate.avatar); continue; }
                    await fs.unlink(path.join(roots.characters, duplicate.avatar)); removed.push(duplicate.avatar);
                } catch (error) { if (error.code !== 'ENOENT') retained.push(duplicate.avatar); }
            }
            return { file_name: path.parse(avatar).name, avatar, id, reused: Boolean(keeper), removed, retained, warnings: scanned.warnings,
                same_name_different: scanned.items.some(item => item.name === record.name && item.id !== id) };
        });
    }
    async function list(worlds = []) {
        const { items, warnings } = await locks.run('library:cards', () => scan(worlds));
        const groups = new Map();
        for (const item of items) {
            const previous = groups.get(item.id);
            if (!previous || item.record) groups.set(item.id, item);
        }
        const catalog = [...groups.values()].map(item => ({ id: item.id, avatar: item.avatar, name: item.name }));
        const sources = new Set(items.flatMap(item => item.record ? [item.record.source_digest, ...(item.record.source_digests || [])] : []));
        // Pre-library installs may have ONLY runtime cards. Keep one explicitly labelled
        // snapshot accessible until its source is enrolled; never delete or rewrite it.
        const legacySources = new Set();
        for (const world of worlds) {
            const avatar = world.runtime_card?.binding?.avatar;
            const key = world.source?.sha256 || avatar;
            if (!avatar || sources.has(key) || legacySources.has(key) || world.source?.type === 'blank-world') continue;
            if (catalog.some(item => item.avatar === avatar)) continue;
            legacySources.add(key);
            try {
                const decoded = await cardCodec.decode({ buffer: await readSafe(roots.characters, avatar), format: 'png' });
                if (groups.has(fingerprint(decoded))) continue;
            } catch (error) { warnings.push({ avatar, message: error.message }); continue; }
            catalog.push({ id: `legacy:${key}`, avatar, name: world.name, legacy: true });
        }
        return { items: catalog, warnings };
    }
    async function source(avatar) {
        const indexed = await records();
        let buffer;
        try { buffer = await readSafe(roots.characters, avatar); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const alias = indexed.find(item => item.aliases.includes(avatar));
            if (!alias) throw error;
            avatar = alias.avatar; buffer = await readSafe(roots.characters, avatar);
        }
        const record = indexed.find(item => item.avatar === avatar && item.png_digest === digest(buffer));
        if (!record) return { buffer, format: 'png' };
        const original = await readSafe(archives, record.source_file);
        if (digest(original) !== record.source_digest) invalid('Library source checksum mismatch.');
        return { buffer: original, format: record.format };
    }
    return { save, list, source };
}
