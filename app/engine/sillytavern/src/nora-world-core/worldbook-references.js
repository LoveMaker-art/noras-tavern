import fs from 'node:fs/promises';
import path from 'node:path';

// Old ownership labels are not proof of exclusivity. Unreadable references fail closed.
export async function isExclusiveWorldbook(world, name, { worlds, roots, cardCodec }) {
    if (!Array.isArray(worlds) || !worlds.some(other => other.world_id === world.world_id)
        || worlds.some(other => other.world_id !== world.world_id
        && other.knowledge?.some(resource => resource.binding?.name === name))) return false;
    return hasNoExternalReferences(name, { roots, cardCodec });
}

async function hasNoExternalReferences(name, { roots, cardCodec }) {
    try {
        let settings = {};
        try {
            settings = JSON.parse(await fs.readFile(path.join(path.dirname(roots.worlds), 'settings.json'), 'utf8'));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const configured = (settings.world_info_settings || settings).world_info;
        const info = configured || {};
        if ([configured, ...(Array.isArray(configured) ? configured : [])].includes(name)
            || info.globalSelect?.includes(name) || info.charLore?.some(item => item.extraBooks?.includes(name))
            || settings.power_user?.persona_description_lorebook === name
            || Object.values(settings.power_user?.persona_descriptions || {}).some(persona => persona?.lorebook === name)) return false;
        for (const item of await fs.readdir(roots.characters, { withFileTypes: true })) {
            if (!item.name.endsWith('.png')) continue;
            if (!item.isFile()) return false;
            const sourcePath = path.join(roots.characters, item.name);
            const { card } = await cardCodec.decode({ buffer: await fs.readFile(sourcePath), format: 'png', sourcePath });
            const data = card?.data || card;
            if (data?.extensions?.world === name) return false;
        }
        return true;
    } catch { return false; }
}

// Library deletion must protect legacy chat bindings as well as active World manifests.
export async function isUnreferencedWorldbook(name, { worlds, roots, cardCodec }) {
    if (!Array.isArray(worlds) || worlds.some(world => world.knowledge?.some(item => item.binding?.name === name))) return false;
    if (!await hasNoExternalReferences(name, { roots, cardCodec })) return false;
    const contains = value => value === name || Boolean(value && typeof value === 'object' && Object.values(value).some(contains));
    async function scan(directory, headerOnly = false) {
        let entries;
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) return false;
            if (entry.isDirectory()) { if (!await scan(file, headerOnly)) return false; }
            else if (headerOnly ? entry.name.endsWith('.jsonl') : entry.name.endsWith('.json')) {
                if (!entry.isFile()) return false;
                if (headerOnly) {
                    const handle = await fs.open(file, 'r');
                    try {
                        for await (const line of handle.readLines()) {
                            if (contains(JSON.parse(line).chat_metadata)) return false;
                            break;
                        }
                    } finally { await handle.close(); }
                } else if (contains(JSON.parse(await fs.readFile(file, 'utf8')))) return false;
            }
        }
        return true;
    }
    try {
        const root = path.dirname(roots.worlds);
        return await scan(roots.chats, true) && await scan(path.join(root, 'group chats'), true)
            && await scan(path.join(root, 'groups'));
    } catch { return false; }
}
