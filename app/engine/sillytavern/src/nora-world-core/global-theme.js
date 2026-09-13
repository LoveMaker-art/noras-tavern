import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { SETTINGS_FILE } from '../constants.js';
import { NoraWorldCoreError } from './errors.js';
import { normalizeWorldTheme } from '../../public/scripts/nora-worlds/world-theme.js';
import { validateThemeAssets } from './theme-assets.js';

function read(directories) {
    return JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8'));
}
function describe(settings) {
    const value = settings.extension_settings?.nora_ui?.globalTheme ?? null;
    const revision = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    try { return { ui: normalizeWorldTheme(value ?? {}), revision, invalid: false }; }
    catch { return { ui: normalizeWorldTheme({}), revision, invalid: true }; }
}
export function readGlobalTheme(directories) { return describe(read(directories)); }

export async function saveGlobalTheme(directories, input) {
    if (!input || !Object.hasOwn(input, 'ui') || typeof input.expectedRevision !== 'string') {
        throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'Explicit ui and expectedRevision are required.');
    }
    let ui;
    try { ui = await validateThemeAssets(input.ui, directories.backgrounds); }
    catch (error) { throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'Invalid global theme or unavailable background.', { cause: error }); }
    // After async asset validation, compare and atomically publish without yielding.
    // Keep every non-theme setting from the latest file, not a page's stale snapshot.
    const settings = read(directories);
    if (describe(settings).revision !== input.expectedRevision) throw new NoraWorldCoreError('NORA_WORLD_REVISION_CONFLICT', 'Global theme changed; inspect again.');
    settings.extension_settings ??= {};
    settings.extension_settings.nora_ui ??= {};
    settings.extension_settings.nora_ui.globalTheme = ui;
    writeFileAtomicSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify(settings, null, 4), 'utf8');
    return { saved: true, ...describe(settings) };
}
