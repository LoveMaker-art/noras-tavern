import { normalizeWorldPreset, scriptCode, regexCode } from './world-preset.js';

// One projection of the authoritative World snapshot. Library files are never
// used as writable scratch space. Native regex and Helper keep their executors.
export function createWorldPresetExtensions() {
    let active = null;
    let writer = null;
    let pending = false;
    const listeners = new Set();
    const notify = () => { for (const listener of listeners) listener(); };
    const api = {
        get active() { return active !== null; },
        get source() { return active ? `nora-world:${active.worldId}:${active.value.name}` : null; },
        get name() { return active?.value.name || ''; },
        snapshot() { return active ? structuredClone(active.value) : null; },
        setWriter(save) { writer = save; },
        bind(worldId, value) {
            const next = { worldId, value: normalizeWorldPreset(value) };
            if (JSON.stringify(next) === JSON.stringify(active)) return;
            active = next; notify();
        },
        clear() { active = null; notify(); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        enabled(kind) { return active?.value.extension_permissions?.[kind] === true; },
        async save(preset, { permissions, expectedSource = api.source } = {}) {
            if (!active || api.source !== expectedSource || !writer || pending) throw new Error('世界预设已改变或正在保存，请重新打开后再试。');
            const owner = active;
            const next = normalizeWorldPreset({ ...owner.value, preset, modified: true,
                extension_permissions: permissions || owner.value.extension_permissions });
            // Changing executable code invalidates permission; toggles and script
            // data do not. Imported flags cannot authorize a different program.
            if (scriptCode(owner.value.preset) !== scriptCode(next.preset)) next.extension_permissions.scripts = false;
            if (regexCode(owner.value.preset) !== regexCode(next.preset)) next.extension_permissions.regex = false;
            pending = true;
            try { return await writer(owner.worldId, next); }
            finally { pending = false; }
        },
        async permission(kind, enabled) {
            if (!['regex', 'scripts'].includes(kind) || !active) throw new Error('当前世界预设尚未就绪。');
            return api.save(active.value.preset, { permissions: { ...active.value.extension_permissions, [kind]: Boolean(enabled) } });
        },
        async extension(key, value, expectedSource = api.source) {
            if (!active) throw new Error('当前世界预设尚未就绪。');
            const preset = structuredClone(active.value.preset);
            preset.extensions = { ...preset.extensions, [key]: structuredClone(value) };
            return api.save(preset, { expectedSource });
        },
    };
    return api;
}

export const worldPresetExtensions = globalThis[Symbol.for('tavern.world-preset-extensions')] ??= createWorldPresetExtensions();

// Used only by the managed Helper, not by Nora's preset library editor.
export function worldPresetManager(native, projection = worldPresetExtensions) {
    return new Proxy(native, { get(target, property) {
        const source = () => projection.source;
        if (property === 'getSelectedPresetName') return () => source() || target.getSelectedPresetName();
        if (property === 'getSelectedPreset') return () => projection.active ? '0' : target.getSelectedPreset();
        if (property === 'getAllPresets') return () => projection.active ? [source()] : target.getAllPresets();
        if (property === 'getPresetList') return () => projection.active
            ? { presets: [projection.snapshot().preset], preset_names: { [source()]: 0 }, settings: projection.snapshot().preset }
            : target.getPresetList();
        if (property === 'savePreset') return async (name, preset, options) => {
            if (String(name).startsWith('nora-world:')) return projection.save(preset, { expectedSource: name });
            return target.savePreset(name, preset, options);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}
