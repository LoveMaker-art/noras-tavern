import fs from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import { KeyedLock } from './locks.js';
import { resolveNoraWorldCore, worldCorePaths } from './runtime.js';
import { stageWelcomeWorld } from './st-import-staging.js';

const locks = new KeyedLock();
const IDEMPOTENCY_KEY = 'nora:builtin-welcome:v1';

async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function hasResources(directory) {
    try {
        return (await fs.readdir(directory)).some(name => !name.startsWith('.'));
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

// Run before the HTTP server accepts requests, so settings cannot race a user save.
export async function ensureBuiltinWelcome(directories) {
    const { root, stagingRoot } = worldCorePaths(directories);
    return locks.run(root, async () => {
        const markerPath = path.join(root, 'builtin-welcome.json');
        const marker = await readJson(markerPath);
        if (marker?.status === 'complete' || marker?.status === 'skipped') return marker;
        if (marker && marker.status !== 'pending') throw new Error('Invalid Tavern welcome initialization state.');

        const settingsPath = path.join(directories.root, 'settings.json');
        const settings = await readJson(settingsPath) || {};
        const core = resolveNoraWorldCore(directories);
        await fs.mkdir(root, { recursive: true });
        const persist = value => writeFileAtomic(markerPath, JSON.stringify(value), { mode: 0o600 });

        if (!marker) {
            const resources = await Promise.all([
                core.listWorlds(),
                hasResources(directories.characters),
                hasResources(directories.chats),
                hasResources(directories.worlds),
            ]);
            if (resources[0].length || resources.slice(1).some(Boolean)
                || settings.extension_settings?.nora_ui?.lastWorldId) {
                const skipped = { status: 'skipped' };
                await persist(skipped);
                return skipped;
            }
        }

        // Persist the exact command before importing; a restart resumes the same
        // operation, even if the bundled opening has changed in a later release.
        const command = marker?.command || await stageWelcomeWorld({ idempotencyKey: IDEMPOTENCY_KEY, stagingRoot });
        if (!marker) await persist({ status: 'pending', command });
        const { world } = await core.createWorld(command, { idempotencyKey: IDEMPOTENCY_KEY });
        if (!settings.extension_settings?.nora_ui?.lastWorldId) {
            settings.extension_settings ??= {};
            settings.extension_settings.nora_ui ??= {};
            settings.extension_settings.nora_ui.lastWorldId = world.world_id;
            await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 4), { mode: 0o600 });
        }
        const complete = { status: 'complete', worldId: world.world_id };
        await persist(complete);
        return complete;
    });
}
