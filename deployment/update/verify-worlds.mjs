import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWorlds(appRoot, nativeRoot) {
    const users = await fs.readdir(nativeRoot, { withFileTypes: true });
    const result = {};
    let Store;
    for (const user of users.filter(entry => entry.isDirectory())) {
        const root = path.join(nativeRoot, user.name, 'nora-world-core');
        try {
            await fs.access(path.join(root, 'worlds'));
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        Store ??= (await import(pathToFileURL(path.join(appRoot, 'engine/sillytavern/src/nora-world-core/store.js')))).WorldStore;
        // Use the product's loader, but never let validation quarantine user data.
        const readOnly = {
            readFile: (...args) => fs.readFile(...args),
            readdir: (...args) => fs.readdir(...args),
            mkdir: async () => {},
            rename: async file => { throw new Error(`World validation failed: ${user.name}/${path.basename(file)}`); },
        };
        const store = new Store({ root, fileSystem: readOnly });
        await store.load();
        result[user.name] = (await store.list()).map(world => ({
            worldId: world.world_id,
            sessions: world.sessions.items.map(session => session.session_id).sort(),
        })).sort((a, b) => a.worldId.localeCompare(b.worldId));
    }
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        console.log(JSON.stringify(await verifyWorlds(process.argv[2], process.argv[3])));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
