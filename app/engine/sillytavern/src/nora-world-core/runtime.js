import path from 'node:path';

import { createNoraWorldCore } from './index.js';
import { createStBackendMaterializer } from './st-backend-materializer.js';

const coreCache = new Map();

export function worldCorePaths(directories) {
    const root = path.join(directories.root, 'nora-world-core');
    return { root, stagingRoot: path.join(root, 'staging') };
}

export function resolveNoraWorldCore(directories) {
    const paths = worldCorePaths(directories);
    const key = [paths.root, directories.characters, directories.chats, directories.worlds].join('\u0000');
    if (!coreCache.has(key)) {
        const materializer = createStBackendMaterializer({
            directories,
            stagingRoot: paths.stagingRoot,
        });
        coreCache.set(key, createNoraWorldCore({ root: paths.root, materializer }));
    }
    return coreCache.get(key);
}

export function clearNoraWorldCoreCache() {
    coreCache.clear();
}
