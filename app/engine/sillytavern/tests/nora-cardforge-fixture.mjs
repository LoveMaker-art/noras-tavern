import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// Test the same compiler in the authored tree and the projected delivery tree.
export const cardForgeRoot = ['nora', 'ops']
    .map(root => new URL(`../../../../${root}/skills/creative/nora-cardforge/`, import.meta.url))
    .find(root => existsSync(new URL('package.json', root)));
if (!cardForgeRoot) throw new Error('CardForge fixture is missing from the source/delivery tree.');
export const requireCardForge = createRequire(new URL('package.json', cardForgeRoot));
