import fs from 'node:fs/promises';
import path from 'node:path';

// Old ownership labels are not proof of exclusivity. Unreadable references fail closed.
export async function isExclusiveWorldbook(world, name, { worlds, roots, cardCodec }) {
    if (!Array.isArray(worlds) || !worlds.some(other => other.world_id === world.world_id)
        || worlds.some(other => other.world_id !== world.world_id
        && other.knowledge?.some(resource => resource.binding?.name === name))) return false;
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
