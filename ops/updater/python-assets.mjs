import fs from 'node:fs/promises';
import path from 'node:path';

function assetPath(url) {
    if (typeof url !== 'string' || !/^\/(world-assets|assets)\//.test(url)) return null;
    const decoded = decodeURIComponent(url.split(/[?#]/, 1)[0].slice(1));
    if (decoded.split('/').some(part => !part || part === '.' || part === '..') || decoded.includes('\\') || [...decoded].some(char => char.charCodeAt(0) < 32)
        || !/\.(png|jpe?g|webp)$/i.test(decoded)) throw new Error('Unsafe Python asset');
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

export async function collectPythonAssets(state, productions, legacyApp) {
    const result = new Map();
    const archived = path.join(state, 'python-source-assets');
    for (const production of productions.values()) for (const url of Object.values(production.ui?.assets || {})) {
        const relative = assetPath(url);
        if (!relative || result.has(relative)) continue;
        let bytes;
        try { bytes = await readWithin(archived, relative); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (relative.startsWith('world-assets/')) bytes = await readWithin(state, relative);
            else {
                if (!legacyApp) throw new Error('Python frontend asset requires the reviewed legacy application directory');
                let frontend = path.join(legacyApp, 'frontend');
                try { await fs.stat(frontend); }
                catch (missing) { if (missing.code !== 'ENOENT') throw missing; frontend = path.join(legacyApp, 'backend/web'); }
                bytes = await readWithin(frontend, relative);
            }
        }
        result.set(relative, bytes);
    }
    return { entries: result, get: url => result.get(assetPath(url)) };
}
