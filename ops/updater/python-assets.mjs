import fs from 'node:fs/promises';
import path from 'node:path';
import { DeferredData, object } from './python-import-plan.mjs';

function assetPath(url) {
    if (typeof url !== 'string' || !/^\/(world-assets|assets)\//.test(url)) return null;
    let decoded;
    try { decoded = decodeURIComponent(url.split(/[?#]/, 1)[0].slice(1)); }
    catch (error) { if (error instanceof URIError) throw new DeferredData('Invalid Python asset URL encoding'); throw error; }
    if (decoded.split('/').some(part => !part || part === '.' || part === '..') || decoded.includes('\\') || [...decoded].some(char => char.charCodeAt(0) < 32)) throw new Error('Unsafe Python asset');
    if (!/\.(png|jpe?g|webp)$/i.test(decoded)) throw new DeferredData('Unsupported legacy background image format');
    return decoded;
}

async function readWithin(root, relative) {
    const base = path.resolve(root);
    let file = base;
    for (const part of ['', ...relative.split('/')]) {
        file = path.join(file, part);
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Unsafe Python asset symlink');
    }
    if (!(await fs.stat(file)).isFile()) throw new Error('Unsafe Python asset type');
    return fs.readFile(file);
}

export async function collectPythonAssets(state, productions, legacyApp, legacyWeb = 'frontend') {
    if (!['web', 'frontend', 'backend/web'].includes(legacyWeb)) throw new Error('Invalid Python web root');
    const result = new Map();
    const archived = path.join(state, 'python-source-assets');
    for (const production of productions.values()) {
        if (production.ui !== undefined && !object(production.ui)) throw new DeferredData('Invalid Python UI configuration');
        if (production.ui?.assets !== undefined && !object(production.ui.assets)) throw new DeferredData('Invalid Python asset configuration');
        for (const url of Object.values(production.ui?.assets || {})) {
            if (typeof url !== 'string') throw new DeferredData('Invalid Python asset URL');
            const relative = assetPath(url);
            if (!relative || result.has(relative)) continue;
            let bytes;
            try { bytes = await readWithin(archived, relative); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                try {
                    if (relative.startsWith('world-assets/')) bytes = await readWithin(state, relative);
                    else {
                        if (!legacyApp) throw new DeferredData('Python frontend asset requires the legacy application directory');
                        bytes = await readWithin(path.join(legacyApp, legacyWeb), relative);
                    }
                } catch (sourceError) {
                    if (sourceError.code === 'ENOENT') throw new DeferredData('Original Python background asset is missing');
                    throw sourceError;
                }
            }
            result.set(relative, bytes);
        }
    }
    return { entries: result, get: url => result.get(assetPath(url)) };
}
