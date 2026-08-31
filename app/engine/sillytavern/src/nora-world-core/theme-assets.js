import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { NoraWorldCoreError } from './errors.js';
import { normalizeWorldTheme } from '../../public/scripts/nora-worlds/world-theme.js';

const invalid = message => { throw new NoraWorldCoreError('NORA_WORLD_INVALID', message); };
export async function validateThemeAssets(value, backgroundsRoot) {
    let ui; try { ui = normalizeWorldTheme(value); } catch (error) { invalid(error.message); }
    for (const url of Object.values(ui.assets)) {
        if (!url.startsWith('/backgrounds/')) continue;
        const file = path.join(backgroundsRoot, decodeURIComponent(url.slice(13)));
        const stat = await fs.lstat(file).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) invalid('Background file is missing or not a regular image. Import it first.');
    }
    return ui;
}
export async function importThemeBackground(uploadPath, backgroundsRoot) {
    const stat = await fs.lstat(uploadPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12 * 1024 * 1024) invalid('Background must be a regular image, at most 12 MiB.');
    const bytes = await fs.readFile(uploadPath);
    const extension = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg'
            : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : '';
    if (!extension) invalid('Supported background formats: PNG, JPEG, WebP.');
    const filename = `world-${crypto.createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    const destination = path.join(backgroundsRoot, filename);
    await fs.mkdir(backgroundsRoot, { recursive: true });
    const temporary = path.join(backgroundsRoot, `.world-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try { await fs.link(temporary, destination); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.lstat(destination);
        if (!existing.isFile() || existing.isSymbolicLink() || !(await fs.readFile(destination)).equals(bytes)) invalid('Background storage conflict.');
    } finally { await fs.unlink(temporary); }
    return { filename, url: `/backgrounds/${filename}`, bytes: bytes.length, worldChanged: false };
}
