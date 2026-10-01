import fs from 'node:fs';
import path from 'node:path';
import { sync as writeAtomic } from 'write-file-atomic';
import { builtinPlugins } from '../public/scripts/nora-controls/plugin-catalog.js';
export { builtinPlugins };

export const managedExtensions = new Set(['nora-ui', 'nora-ledger', 'nora-mvu', 'JS-Slash-Runner', 'ST-Prompt-Template']);
export const isManagedExtension = name => [...managedExtensions].some(item => item.toLowerCase() === name.toLowerCase());
// Product features users can manage, not every module discovered by ST.
const stateFile = directory => path.join(path.dirname(directory), 'nora-extension-library.json');

export function readExtensionLibraryState(directory) {
    try {
        const state = JSON.parse(fs.readFileSync(stateFile(directory), 'utf8'));
        if (!state || Array.isArray(state) || typeof state !== 'object') throw new Error('Invalid plugin library state');
        return state;
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error; // Do not silently enable plugins when the policy file cannot be read.
    }
}

export function setExtensionLibraryState(directory, name, patch) {
    if (!name || path.basename(name) !== name || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Invalid extension name');
    const state = readExtensionLibraryState(directory);
    state[name] = { ...state[name], ...patch };
    writeAtomic(stateFile(directory), JSON.stringify(state, null, 2));
}

export function discoverInstalledExtensions(userDirectory, systemDirectory, globalDirectory) {
    const names = directory => fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => {
            if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) return false;
            try {
                return fs.statSync(path.join(directory, entry.name, 'manifest.json')).isFile();
            } catch (error) {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
                throw error;
            }
        }).map(entry => entry.name) : [];
    const state = readExtensionLibraryState(userDirectory);
    const local = names(userDirectory).map(folder => ({ type: 'local', name: `third-party/${folder}`,
        ...(Object.hasOwn(state, folder) ? { libraryEnabled: state[folder]?.enabled === true } : {}) }));
    return [
        ...names(systemDirectory).filter(name => name !== 'third-party').map(name => ({ type: 'system', name })),
        ...local,
        ...names(globalDirectory).map(name => ({ type: 'global', name: `third-party/${name}` })).filter(item => !local.some(other => other.name === item.name)),
    ];
}

// Clone outside the discovery directory. Persist the disabled state BEFORE publishing
// the folder, so another tab can never discover an unapproved executable extension.
export async function installDisabledExtension({ directory, name, url, clone }) {
    if (isManagedExtension(name)) throw new Error('内置扩展随诺拉更新，不能覆盖安装。');
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, name);
    if (!name || path.basename(name) !== name || fs.existsSync(target)) throw new Error('同名插件已存在，未覆盖。');
    const staging = fs.mkdtempSync(path.join(path.dirname(directory), '.nora-plugin-install-'));
    const checkout = path.join(staging, 'checkout');
    try {
        await clone(url, checkout);
        const manifestPath = path.join(checkout, 'manifest.json');
        if (!fs.lstatSync(manifestPath).isFile()) throw new Error('扩展清单必须是普通 JSON 文件。');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('缺少有效的 ST 前端扩展 manifest.json。');
        if (fs.existsSync(target)) throw new Error('同名插件已存在，未覆盖。');
        setExtensionLibraryState(directory, name, { enabled: false, source: url });
        fs.renameSync(checkout, target);
        return { folderName: name, display_name: manifest.display_name, version: manifest.version, author: manifest.author };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}
