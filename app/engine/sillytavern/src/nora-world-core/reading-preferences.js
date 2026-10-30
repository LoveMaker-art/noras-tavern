import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { NoraWorldCoreError } from './errors.js';
import { READING_SCHEMA, normalizeReadingDocument, normalizeReadingValues, describeReading, readingTarget } from '../../public/scripts/nora-worlds/reading-preferences.js';

export const READING_FILE = 'nora-reading-preferences.json';
const empty = () => ({ schema: READING_SCHEMA, defaults: {}, worlds: {} });
const revision = raw => crypto.createHash('sha256').update(raw).digest('hex');
function read(directories) {
    const file = path.join(directories.root, READING_FILE);
    let raw;
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Expected a bounded regular file.');
        raw = fs.readFileSync(file, 'utf8');
    } catch (cause) {
        if (cause.code === 'ENOENT') return { file, document: empty(), revision: revision('') };
        throw new NoraWorldCoreError('NORA_READING_UNREADABLE', 'Reading preferences could not be read; the file was preserved.', { cause });
    }
    try { return { file, document: normalizeReadingDocument(JSON.parse(raw)), revision: revision(raw) }; }
    catch (cause) { throw new NoraWorldCoreError('NORA_READING_UNREADABLE', 'Reading preferences are invalid; the file was preserved.', { cause }); }
}
function invalid(cause) {
    return new NoraWorldCoreError('NORA_READING_INVALID', cause.message, { cause });
}
export function readReadingPreferences(directories, { scope, worldId } = {}) {
    try { readingTarget(scope, worldId); } catch (error) { throw invalid(error); }
    const state = read(directories);
    return { ...describeReading(state.document, scope, worldId), revision: state.revision };
}
export function saveReadingPreferences(directories, input, { write = writeFileAtomicSync } = {}) {
    let target, patch;
    try {
        if (!input || typeof input.expectedRevision !== 'string' || Object.keys(input).some(key => !['scope', 'worldId', 'values', 'expectedRevision'].includes(key))) throw new Error('Explicit values and expectedRevision are required.');
        target = readingTarget(input.scope, input.worldId);
        patch = normalizeReadingValues(input.values, { patch: true });
    } catch (error) { throw invalid(error); }
    // Synchronous read/compare/atomic publish: API writers cannot interleave after CAS.
    const state = read(directories);
    if (state.revision !== input.expectedRevision) throw new NoraWorldCoreError('NORA_READING_REVISION_CONFLICT', 'Reading preferences changed; inspect again before editing.');
    const before = describeReading(state.document, target.scope, target.worldId).values;
    const values = { ...before };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete values[key]; else values[key] = value;
    }
    const changed = JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(values).sort());
    if (!changed) return { ...readReadingPreferences(directories, target), saved: true, changed: false };
    if (target.scope === 'global') state.document.defaults = values;
    else if (Object.keys(values).length) Object.defineProperty(state.document.worlds, target.worldId, { value: values, enumerable: true, configurable: true, writable: true });
    else delete state.document.worlds[target.worldId];
    const raw = JSON.stringify(state.document, null, 2) + '\n';
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new NoraWorldCoreError('NORA_READING_INVALID', 'Reading preferences exceed the storage limit.');
    try { write(state.file, raw, { encoding: 'utf8', mode: 0o600 }); }
    catch (cause) { throw new NoraWorldCoreError('NORA_READING_WRITE_FAILED', 'Reading preferences were not saved.', { cause }); }
    return { ...describeReading(state.document, target.scope, target.worldId), revision: revision(raw), saved: true, changed: true };
}
