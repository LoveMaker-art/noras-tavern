#!/usr/bin/env node
// Offline adapter around the existing World v1 migration. Never calls a model.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

async function entries(root) {
    try { return await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function filename(name) {
    if (typeof name !== 'string' || !name || path.basename(name) !== name || name === '..' || name === '.') throw new Error('Unsafe resource name');
    return name;
}

async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function requireFile(file) { if (!(await fs.stat(file)).isFile()) throw new Error('Missing resource: ' + file); }
async function copy(source, target) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target); }
function chatBody(bytes) { const index = bytes.indexOf(10); return index < 0 ? Buffer.alloc(0) : bytes.subarray(index + 1); }

export async function migrateState(state, app) {
    const stateFiles = new Set((await entries(state)).map(entry => entry.name));
    if (stateFiles.has('story_profile.json')) {
        const profile = await json(path.join(state, 'story_profile.json'));
        if (profile?.schema_version !== 1 || !Array.isArray(profile.preferences) || !Array.isArray(profile.recent_timeline)
            || !Array.isArray(profile.shared_story_memory)) throw new Error('Unsupported Story Profile schema; original data must be reviewed');
    }
    if (stateFiles.has('profile_eras.json') && !Array.isArray(await json(path.join(state, 'profile_eras.json')))) {
        throw new Error('Invalid Story Profile eras');
    }
    if (stateFiles.has('profile_events.jsonl')) {
        for (const line of (await fs.readFile(path.join(state, 'profile_events.jsonl'), 'utf8')).split('\n').filter(line => line.trim())) {
            const value = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Story Profile event');
        }
    }
    const core = path.join(app, 'engine/sillytavern/src/nora-world-core');
    const { validateWorldManifest, deriveStableId } = await import(pathToFileURL(path.join(core, 'domain.js')));
    const { ResourceCatalog } = await import(pathToFileURL(path.join(core, 'resource-catalog.js')));
    const { migrateLegacyWorlds } = await import(pathToFileURL(path.join(core, 'legacy-migration.js')));
    const { read: readCard } = await import(pathToFileURL(path.join(core, '../character-card-parser.js')));
    const identity = id => /^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(id) ? id : deriveStableId('legacy-world-id', id, 'world');
    async function readWorlds(root) {
        const worlds = [];
        for (const file of await entries(path.join(root, 'nora-world-core/worlds'))) {
            if (!file.isFile() || !file.name.endsWith('.json')) throw new Error('Unknown World record: ' + file.name);
            worlds.push(validateWorldManifest(await json(path.join(root, 'nora-world-core/worlds', file.name))));
        }
        if (new Set(worlds.map(w => w.world_id)).size !== worlds.length) throw new Error('Duplicate World identity');
        new ResourceCatalog(worlds.filter(w => w.lifecycle.status !== 'DELETED'));
        const imports = worlds.map(w => w.source.import_operation_id).filter(Boolean);
        if (new Set(imports).size !== imports.length) throw new Error('Duplicate import operation');
        return worlds;
    }
    async function validateBindings(root, worlds) {
        for (const world of worlds.filter(w => w.lifecycle.status !== 'DELETED')) {
            if (world.lifecycle.status !== 'READY') throw new Error('World needs repair: ' + world.world_id);
            const avatar = filename(world.runtime_card.binding.avatar);
            await requireFile(path.join(root, 'characters', avatar));
            JSON.parse(readCard(await fs.readFile(path.join(root, 'characters', avatar))));
            for (const session of world.sessions.items) {
                const file = path.join(root, 'chats', filename(session.binding.avatar || avatar).replace(/\.png$/i, ''),
                    filename(session.binding.chat_id).replace(/\.jsonl$/i, '') + '.jsonl');
                const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
                const metadata = lines[0]?.chat_metadata;
                if (metadata?.nora_world?.id !== world.world_id || metadata?.nora_session?.id !== session.session_id) {
                    throw new Error('World/Session projection mismatch: ' + world.world_id);
                }
            }
            for (const knowledge of world.knowledge) {
                await json(path.join(root, 'worlds', filename(knowledge.binding.name) + '.json'));
            }
        }
    }
    const reports = [];
    for (const user of await entries(path.join(state, 'native'))) {
        if (!user.isDirectory() || user.name.startsWith('_')) continue;
        const root = path.join(state, 'native', user.name);
        const before = await readWorlds(root); // WorldStore must not silently quarantine records.
        await validateBindings(root, before);
        const existing = new Map(before.map(w => [w.world_id, w]));
        const work = await fs.mkdtemp(path.join(path.dirname(state), 'migration-'));
        const directories = { root: work, noraWorlds: path.join(work, 'nora-worlds'), chats: path.join(work, 'chats'),
            characters: path.join(root, 'characters'), worlds: path.join(root, 'worlds') };
        for (const file of await entries(path.join(root, 'nora-worlds'))) {
            if (!file.isFile() || !file.name.endsWith('.json')) throw new Error('Unknown legacy registry entry');
            const source = path.join(root, 'nora-worlds', file.name);
            const record = await json(source);
            if (record.schema !== 'nora-world/v1' || !record.id) throw new Error('Unknown legacy World schema');
            const current = existing.get(identity(record.id));
            if (current) {
                const session = current.sessions.items.find(s => s.session_id === current.sessions.default_session_id);
                if (record.runtime?.character_avatar !== current.runtime_card.binding.avatar
                    || String(record.runtime?.chat_id).replace(/\.jsonl$/i, '') !== session.binding.chat_id.replace(/\.jsonl$/i, '')) {
                    throw new Error('Legacy/v2 binding mismatch: ' + current.world_id);
                }
                continue; // A retained v1 registry does not create another World.
            }
            await copy(source, path.join(directories.noraWorlds, file.name));
        }
        const chats = [];
        for (const directory of await entries(path.join(root, 'chats'))) {
            if (!directory.isDirectory()) continue;
            for (const file of await entries(path.join(root, 'chats', directory.name))) {
                if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
                const source = path.join(root, 'chats', directory.name, file.name);
                const bytes = await fs.readFile(source);
                const header = JSON.parse(bytes.toString('utf8').split('\n')[0]);
                const id = header.chat_metadata?.nora_world?.id
                    || (header.chat_metadata?.nora_legacy_production_id ? 'legacy:' + header.chat_metadata.nora_legacy_production_id : '');
                if (!id || existing.has(identity(id))) continue;
                const target = path.join(directories.chats, directory.name, file.name);
                await copy(source, target);
                chats.push({ source, target, body: chatBody(bytes) });
            }
        }
        const worldCoreRoot = path.join(root, 'nora-world-core');
        const analysis = await migrateLegacyWorlds({ directories, worldCoreRoot, apply: false });
        if (analysis.summary.corrupt_records || analysis.summary.needs_repair || analysis.reconciliation.binding_mismatch.length) {
            throw new Error('Legacy data requires repair; migration not committed: ' + JSON.stringify(analysis.summary));
        }
        const result = await migrateLegacyWorlds({ directories, worldCoreRoot, apply: true });
        if (result.reconciliation.unexplained.length) throw new Error('Migration reconciliation failed');
        for (const chat of chats) {
            const bytes = await fs.readFile(chat.target);
            if (!chat.body.equals(chatBody(bytes))) throw new Error('Migration changed conversation contents');
            await copy(chat.target, chat.source);
        }
        const after = await readWorlds(root);
        await validateBindings(root, after);
        if (before.some(w => !after.some(a => a.world_id === w.world_id))) throw new Error('Existing World lost');
        reports.push({ user: user.name, before: before.length, after: after.length,
            migrated: result.migration.applied, retained: before.map(w => w.world_id),
            active: after.filter(w => w.lifecycle.status !== 'DELETED').map(w => w.world_id) });
    }
    return { schema: 'tavern-state-migration/v1', modelsCalled: 0, users: reports, pythonMigration: false,
        profile: stateFiles.has('story_profile.json') ? { schema: 1, preserved: true } : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const [state, app] = process.argv.slice(2);
        if (!state || !app || !path.isAbsolute(state) || !path.isAbsolute(app)) throw new Error('Absolute copied-state and app paths required');
        // CLI is an internal worker, not an entrypoint to mutate active data.
        if (path.basename(state) !== 'state' || path.basename(path.dirname(state)) !== 'prepared') throw new Error('Only a prepared state copy is accepted');
        const transaction = path.dirname(path.dirname(state));
        const home = path.dirname(path.dirname(transaction));
        const marker = await json(path.join(home, '.tavern-isolated-update.json'));
        const temporaryRoots = await Promise.all([os.tmpdir(), '/tmp'].map(root => fs.realpath(root)));
        const resolvedHome = await fs.realpath(home);
        if (!temporaryRoots.some(root => resolvedHome.startsWith(root + path.sep))
            || marker.schema !== 1 || marker.home !== resolvedHome || marker.purpose !== 'isolated-update-test'
            || !path.basename(transaction).startsWith('review-') || path.resolve(app) !== path.join(transaction, 'source/app')) {
            throw new Error('Migration worker requires a marked isolated transaction');
        }
        console.log(JSON.stringify(await migrateState(state, app)));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
