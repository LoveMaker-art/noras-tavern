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
import { snapshotRemovalFile, assertRemovalSnapshot } from './file-removal.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = message => { throw new NoraWorldCoreError('NORA_WORLD_INVALID', message); };
const runtimeName = name => /--nora-(?:[a-f0-9]{10}|[a-f0-9]{24}|internal)\.png$/.test(name);

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
    const deletions = path.join(directory, 'deletions');
    const deletionName = (avatar, key) => `${digest(`${avatar}\0${key || ''}`)}.json`;
    async function deletionReceipts() {
        let names;
        try { names = await fs.readdir(deletions); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        const result = [];
        for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
            const item = JSON.parse((await readSafe(deletions, name)).toString());
            if (item.schema !== 'nora-library-deletion/1' || deletionName(item.avatar, item.key) !== name
                || !Array.isArray(item.sources) || item.sources.some(value => !/^[a-f0-9]{64}$/.test(value))) invalid('Invalid library deletion receipt.');
            result.push(item);
        }
        return result;
    }
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
            try { if ((await fs.readdir(path.join(root, basename))).length) return true; } catch (error) { if (error.code !== 'ENOENT') return true; }
        }
        const parent = path.dirname(roots.characters);
        const references = value => typeof value === 'string' ? value.includes(avatar)
            : Array.isArray(value) ? value.some(references)
                : value && typeof value === 'object' ? Object.entries(value).some(([key, item]) => key.includes(avatar) || references(item)) : false;
        try {
            let settings;
            try { settings = JSON.parse(await fs.readFile(path.join(parent, 'settings.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') return true; }
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
            if ((await records()).some(item => item.id === id && item.removal)) {
                throw new NoraWorldCoreError('NORA_WORLD_RESOURCE_DELETING', '这张库卡的删除尚未完成，请先重试删除。');
            }
            const scanned = await scan(worlds);
            const matches = scanned.items.filter(item => item.id === id);
            const keeper = matches.find(item => item.record) || matches[0];
            let avatar = keeper?.avatar || `nora-card-${id}.png`;
            if (!keeper) {
                try { await fs.lstat(path.join(roots.characters, avatar)); avatar = `nora-card-${id}-${crypto.randomUUID()}.png`; } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
            const { removed, retained } = await removeUnreferenced(matches.filter(item => item.avatar !== avatar), worlds,
                { avatar, buffer: keeper?.buffer || complete.runtimeCardBuffer });
            return { file_name: path.parse(avatar).name, avatar, id, reused: Boolean(keeper), removed, retained: retained.map(item => item.avatar), warnings: scanned.warnings,
                same_name_different: scanned.items.some(item => item.name === record.name && item.id !== id) };
        });
    }
    async function removeUnreferenced(candidates, worlds, keeper) {
        const removed = [], retained = [];
        for (const candidate of candidates) {
            if (await isReferenced(candidate.avatar, worlds)) { retained.push({ avatar: candidate.avatar, reason: 'referenced' }); continue; }
            try {
                if (keeper && !(await readSafe(roots.characters, keeper.avatar)).equals(keeper.buffer)) {
                    retained.push({ avatar: candidate.avatar, reason: 'keeper-changed' }); continue;
                }
                if (!(await readSafe(roots.characters, candidate.avatar)).equals(candidate.buffer)) {
                    retained.push({ avatar: candidate.avatar, reason: 'changed' }); continue;
                }
                await fs.unlink(path.join(roots.characters, candidate.avatar)); removed.push(candidate.avatar);
            } catch (error) { retained.push({ avatar: candidate.avatar, reason: error.code === 'ENOENT' ? 'missing' : 'unavailable' }); }
        }
        return { removed, retained };
    }
    async function list(worlds = []) {
        const { items, warnings } = await locks.run('library:cards', () => scan(worlds));
        const groups = new Map();
        for (const item of items) {
            const previous = groups.get(item.id);
            if (!previous || item.record) groups.set(item.id, item);
        }
        const catalog = [...groups.values()].map(item => ({ id: item.id, avatar: item.avatar, name: item.name,
            revision: digest(item.buffer), duplicates: items.filter(candidate => candidate.id === item.id && candidate.avatar !== item.avatar)
                .map(candidate => ({ avatar: candidate.avatar, revision: digest(candidate.buffer) })) }));
        const sources = new Set(items.flatMap(item => item.record ? [item.record.source_digest, ...(item.record.source_digests || [])] : []));
        for (const receipt of await deletionReceipts()) for (const source of receipt.sources) sources.add(source);
        // Pre-library installs may have ONLY runtime cards. Keep one explicitly labelled
        // snapshot accessible until its source is enrolled; never delete or rewrite it.
        const legacySources = new Set();
        for (const world of worlds) {
            const avatar = world.runtime_card?.binding?.avatar;
            const key = world.source?.sha256 || avatar;
            if (!avatar || sources.has(key) || legacySources.has(key) || ['blank-world', 'world-restart'].includes(world.source?.type)) continue;
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
        if (indexed.some(item => item.removal && (item.avatar === avatar || item.aliases.includes(avatar)))) {
            throw new NoraWorldCoreError('NORA_WORLD_RESOURCE_DELETING', '这张库卡正在删除，暂不能导入。');
        }
        let buffer;
        try { buffer = await readSafe(roots.characters, avatar); } catch (error) {
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
    async function removeOwned(avatar, worlds = [], { idempotencyKey = null, expectedRevision = null } = {}) {
        if (typeof avatar !== 'string' || !avatar.endsWith('.png') || /[/\\\0]/.test(avatar) || path.basename(avatar) !== avatar) invalid('Invalid card filename.');
        if (runtimeName(avatar) || worlds.some(world => world.runtime_card?.binding?.avatar === avatar
            || world.sessions?.items?.some(session => session.binding?.avatar === avatar))) {
            throw new NoraWorldCoreError('NORA_WORLD_RESOURCE_IN_USE', '世界运行卡不能通过库删除，请从世界入口操作。');
        }
        const indexed = await records();
        let record = indexed.find(item => item.avatar === avatar);
        const receipt = (await deletionReceipts()).find(item => item.avatar === avatar && item.key === idempotencyKey);
        if (receipt) {
            // A crash after writing the receipt may leave its pending index.
            // A subsequently re-imported card has no matching pending marker.
            if (record?.removal?.key === idempotencyKey) {
                const index = await snapshotRemovalFile(path.dirname(stagingRoot), `library-cards/${record.id}.json`);
                assertRemovalSnapshot(index.snapshot, receipt.index);
                index.remove();
            }
            return { ...receipt.result, alreadyAbsent: true };
        }
        const card = await snapshotRemovalFile(roots.characters, avatar);
        if (expectedRevision !== null && card.snapshot?.sha256 !== expectedRevision) {
            throw new NoraWorldCoreError('NORA_ST_RESOURCE_CONFLICT', 'Library card changed; inspect again.');
        }
        const coreRoot = path.dirname(stagingRoot);
        let archive = null, archiveState = 'none';
        if (record) {
            // The archive must agree with both the managed filename and its bytes.
            if (!/^[a-f0-9]{64}\.(png|json|yaml|yml|charx|byaf)$/.test(record.source_file || '')
                || !record.source_file.startsWith(`${record.source_digest}.`)) invalid('Invalid library source identity.');
            archive = await snapshotRemovalFile(coreRoot, `library-cards/sources/${record.source_file}`);
            const shared = indexed.some(item => item.id !== record.id && item.source_file === record.source_file)
                || worlds.some(world => world.source?.sha256 === record.source_digest);
            archiveState = shared ? 'retained-referenced'
                : archive.snapshot && archive.snapshot.sha256 !== record.source_digest ? 'retained-changed'
                    : 'deleted';
            if (record.removal && record.removal.key === idempotencyKey) {
                assertRemovalSnapshot(card.snapshot, record.removal.card);
                if (record.removal.archiveState !== archiveState) {
                    throw new NoraWorldCoreError('NORA_WORLD_DELETE_PLAN_CHANGED', '库卡原始存档的引用或内容已变化，已保留文件。');
                }
                if (archiveState === 'deleted') assertRemovalSnapshot(archive.snapshot, record.removal.archive);
            } else {
                record = { ...record, removal: { key: idempotencyKey, card: card.snapshot, archive: archive.snapshot, archiveState } };
                await writeJsonAtomic(path.join(directory, `${record.id}.json`), record);
            }
        }
        // Clear aliases explicitly deleted by the user. Otherwise an old
        // preview could resolve that deleted name back to another original.
        for (const alias of indexed.filter(item => item.id !== record?.id && item.aliases.includes(avatar))) {
            await writeJsonAtomic(path.join(directory, `${alias.id}.json`), { ...alias, aliases: alias.aliases.filter(name => name !== avatar) });
        }
        const index = record ? await snapshotRemovalFile(coreRoot, `library-cards/${record.id}.json`) : null;
        if (record) {
            const bytes = await readSafe(directory, `${record.id}.json`);
            if (digest(bytes) !== index.snapshot?.sha256 || stableStringify(JSON.parse(bytes)) !== stableStringify(record)) {
                throw new NoraWorldCoreError('NORA_WORLD_DELETE_PLAN_CHANGED', '库卡索引已变化，请重新确认删除。');
            }
        }
        const existed = card.remove();
        if (archiveState === 'deleted') archive.remove();
        const result = { deleted: true, alreadyAbsent: !existed, archive: archiveState };
        await fs.mkdir(deletions, { recursive: true });
        await writeJsonAtomic(path.join(deletions, deletionName(avatar, idempotencyKey)), {
            schema: 'nora-library-deletion/1', avatar, key: idempotencyKey,
            index: index?.snapshot || null, created_at: new Date().toISOString(),
            sources: [...new Set([record?.source_digest, ...(record?.source_digests || [])].filter(Boolean))], result,
        });
        index?.remove();
        return result;
    }
    async function manage({ action, avatar, revision: expectedRevision }, worlds = []) {
        if (!['delete', 'deduplicate'].includes(action) || typeof expectedRevision !== 'string') invalid('Invalid library operation.');
        return locks.run('library:cards', async () => {
            const { items } = await scan(worlds);
            const target = items.find(item => item.avatar === avatar);
            if (!target) invalid('Expected an independent library card.');
            if (digest(target.buffer) !== expectedRevision) throw new NoraWorldCoreError('NORA_ST_RESOURCE_CONFLICT', 'Library card changed; inspect again.');
            if (action === 'delete') {
                if (await isReferenced(avatar, worlds)) return { action, avatar, removed: [], retained: [{ avatar, reason: 'referenced' }], deleted: false, worldsUnchanged: true };
                const result = await removeOwned(avatar, worlds, { idempotencyKey: target.record?.removal?.key || crypto.randomUUID(), expectedRevision });
                return { ...result, action, avatar, removed: [avatar], retained: [], worldsUnchanged: true };
            }
            const candidates = items.filter(item => item.id === target.id && item.avatar !== avatar);
            const { removed, retained } = await removeUnreferenced(candidates, worlds, target);
            return { action, avatar, removed, retained, deleted: action === 'delete' && removed.includes(avatar), worldsUnchanged: true };
        });
    }
    return { save, list, source: avatar => locks.run('library:cards', () => source(avatar)), manage,
        remove: (avatar, worlds, options) => locks.run('library:cards', () => removeOwned(avatar, worlds, options)) };
}
