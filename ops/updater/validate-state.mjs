// Read-only validation for an already-current Node installation. No schema upgrade.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function entries(directory) {
    try { return await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const json = file => fs.readFile(file, 'utf8').then(JSON.parse);
const filename = value => {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || path.basename(value) !== value) throw new Error('Unsafe native resource name');
    return value;
};
export async function validateState(state, app) {
    const engine = path.join(app, 'engine/sillytavern');
    const { validateWorldManifest } = await import(pathToFileURL(path.join(engine, 'src/nora-world-core/domain.js')));
    const { ResourceCatalog } = await import(pathToFileURL(path.join(engine, 'src/nora-world-core/resource-catalog.js')));
    const { read: readCard } = await import(pathToFileURL(path.join(engine, 'src/character-card-parser.js')));
    const users = [];
    for (const user of await entries(path.join(state, 'native'))) {
        if (!user.isDirectory() || user.name.startsWith('_')) continue;
        const root = path.join(state, 'native', user.name);
        if ((await entries(path.join(root, 'nora-worlds'))).length) throw new Error('Node v1 migration is outside the updater scope');
        const worlds = [];
        for (const file of await entries(path.join(root, 'nora-world-core/worlds'))) {
            if (!file.isFile() || !file.name.endsWith('.json')) throw new Error('Unknown World record');
            worlds.push(validateWorldManifest(await json(path.join(root, 'nora-world-core/worlds', file.name))));
        }
        if (new Set(worlds.map(world => world.world_id)).size !== worlds.length) throw new Error('Duplicate World identity');
        const active = worlds.filter(world => world.lifecycle.status !== 'DELETED');
        new ResourceCatalog(active);
        for (const world of active) {
            if (world.lifecycle.status !== 'READY') throw new Error('World requires repair');
            const avatar = filename(world.runtime_card.binding.avatar);
            JSON.parse(readCard(await fs.readFile(path.join(root, 'characters', avatar))));
            for (const session of world.sessions.items) {
                const lines = (await fs.readFile(path.join(root, 'chats', avatar.replace(/\.png$/i, ''), filename(session.binding.chat_id) + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
                if (lines[0]?.chat_metadata?.nora_world?.id !== world.world_id || lines[0]?.chat_metadata?.nora_session?.id !== session.session_id) throw new Error('World/Session identity mismatch');
            }
            for (const book of world.knowledge) await json(path.join(root, 'worlds', filename(book.binding.name) + '.json'));
        }
        users.push({ user: user.name, before: worlds.length, after: worlds.length, active: active.map(world => world.world_id) });
    }
    let profile = null;
    try {
        const value = await json(path.join(state, 'story_profile.json'));
        if (value.schema_version !== 1 || !['preferences', 'recent_timeline', 'shared_story_memory'].every(key => Array.isArray(value[key]))) throw new Error('Unsupported Story Profile schema');
        profile = { schema: 1, preserved: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { schema: 'tavern-state-validation/v1', users, profile, migration: false, modelsCalled: 0 };
}
