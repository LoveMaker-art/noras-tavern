import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sync as writeAtomic } from 'write-file-atomic';
import { editPreset } from '../public/scripts/nora-worlds/preset-edit.js';
import { createWorldPreset, validateWorldPresetParameters } from '../public/scripts/nora-worlds/world-preset.js';
import { PRESET_MAX_BYTES, presetFileSize, encodePresetFile } from '../public/scripts/nora-worlds/preset-file.js';

const revision = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
function file(directory, name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 150
        || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
        || /^(?:__proto__|constructor|prototype|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        throw error('NORA_PRESET_INVALID', 'Invalid preset name.');
    }
    return path.join(directory, `${name}.json`);
}
function readRaw(directory, name) {
    const target = file(directory, name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw error('NORA_PRESET_INVALID', 'Unsafe preset file.');
    if (stat.size > PRESET_MAX_BYTES) throw error('NORA_PRESET_TOO_LARGE', 'Preset exceeds 10 MB.');
    return JSON.parse(fs.readFileSync(target, 'utf8'));
}
export function readPresetTemplate(directory, name) {
    const raw = readRaw(directory, name);
    return { name, revision: revision(raw), preset: createWorldPreset(name, raw).preset, storedPreset: raw };
}
export function listPresetTemplates(directory) {
    return fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
}
export function importPresetTemplate(directory, input) {
    const target = file(directory, input.name);
    if (typeof input.json !== 'string') throw error('NORA_PRESET_INVALID', 'Expected a JSON file.');
    if (presetFileSize(input.json) > PRESET_MAX_BYTES) throw error('NORA_PRESET_TOO_LARGE', 'Preset exceeds 10 MB.');
    let raw;
    try { raw = JSON.parse(input.json); } catch { throw error('NORA_PRESET_INVALID', 'Invalid JSON.'); }
    let snapshot;
    try { snapshot = createWorldPreset(input.name, raw); } catch { throw error('NORA_PRESET_INVALID', 'Invalid ST chat-completion preset structure.'); }
    const warnings = [];
    try { validateWorldPresetParameters(snapshot.preset); } catch (cause) {
        warnings.push({ code: 'NORA_PRESET_PARAMETERS_INVALID', message: cause.message });
    }
    let reused = false;
    if (fs.existsSync(target)) {
        if (revision(readRaw(directory, input.name)) !== revision(raw)) throw error('NORA_PRESET_CONFLICT', 'A different preset already uses this name.');
        reused = true;
    } else {
        // Exclusive creation cannot overwrite an existing template, even across processes.
        const temporary = path.join(directory, `.preset-${crypto.randomUUID()}.tmp`);
        try {
            fs.writeFileSync(temporary, input.json, { flag: 'wx', mode: 0o600 });
            fs.linkSync(temporary, target);
        } catch (cause) {
            if (cause.code === 'EEXIST') throw error('NORA_PRESET_CONFLICT', 'Preset name already exists.');
            throw cause;
        } finally { fs.rmSync(temporary, { force: true }); }
    }
    return { name: input.name, revision: revision(raw), saved: true, reused, runtimeApplied: false,
        reloadRequired: true, worldUnchanged: true, warnings, canApply: warnings.length === 0 };
}
// Synchronous compare-and-write cannot interleave with another request on this server.
export function savePresetTemplate(directory, input) {
    const target = file(directory, input.name);
    let value;
    if (input.mode === 'create') {
        if (fs.existsSync(target)) throw error('NORA_PRESET_CONFLICT', 'Preset name already exists.');
        if (input.source) {
            const source = readRaw(directory, input.source.name);
            if (revision(source) !== input.source.revision) throw error('NORA_PRESET_STALE', 'Source changed; read it again.');
            value = editPreset(source, input.edits);
        } else value = createWorldPreset(input.name, input.preset).preset;
    } else if (input.mode === 'edit') {
        const previous = readRaw(directory, input.name);
        if (revision(previous) !== input.expectedRevision) throw error('NORA_PRESET_STALE', 'Preset changed; read it again.');
        value = editPreset(previous, input.edits);
    } else throw error('NORA_PRESET_INVALID', 'Unsupported preset operation.');
    // Validate snapshots, but preserve existing extensions and other native fields on library edits.
    createWorldPreset(input.name, value);
    validateWorldPresetParameters(value);
    const encoded = encodePresetFile(value);
    writeAtomic(target, encoded, { encoding: 'utf8' });
    return { ...readPresetTemplate(directory, input.name), saved: true, runtimeApplied: false };
}
