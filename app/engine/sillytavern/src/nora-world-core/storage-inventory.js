import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateWorldManifest } from './domain.js';
import { documentFileName } from './atomic-json.js';
import { ledgerStatePath } from '../nora-story-ledger/state-file.js';
import sanitize from 'sanitize-filename';

const unknown = reason => ({ confidence: 'unknown', reason });
const failure = code => Object.assign(new Error(code), { code });
const portablePath = relative => relative.split(path.sep).join('/');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const LIMITS = Object.freeze({ manifestBytes: 16 * 1024 * 1024, snapshotBytes: 256 * 1024 * 1024,
    scanBytes: 512 * 1024 * 1024, lineBytes: 4 * 1024 * 1024, directoryEntries: 10000 });

// Validate descendants, not the installation root's spelling (/var -> /private/var
// is normal on macOS). A configured root is resolved once; child links are refused.
async function checkedPath(root, relative) {
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.some(part => part === '..') || path.isAbsolute(relative)) throw failure('unsafe-path');
    let file = root;
    let stat = await fs.lstat(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('unsafe-path');
    for (const [index, part] of parts.entries()) {
        file = path.join(file, part);
        stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw failure('unsafe-path');
    }
    return { file, stat };
}

async function entries(root, relative, warnings, versions) {
    let observed = false;
    try {
        const before = await checkedPath(root, relative);
        observed = true;
        if (!before.stat.isDirectory()) throw failure('unsafe-path');
        versions.set(relative, before.stat);
        const result = [];
        for await (const entry of await fs.opendir(before.file)) {
            if (result.length >= LIMITS.directoryEntries) throw failure('directory-too-large');
            result.push(entry);
        }
        const after = await checkedPath(root, relative);
        if (!sameFile(before.stat, after.stat)) throw failure('changed-during-scan');
        return result.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
        if (error.code === 'ENOENT' && !observed) versions.set(relative, null);
        else if (error.code === 'ENOENT') warnings.push({ path: relative, code: 'changed-during-scan' });
        else warnings.push({ path: relative, code: error.code || 'read-failed' });
        return [];
    }
}

async function readRegular(root, relative, metrics, consume = null) {
    const before = await checkedPath(root, relative);
    if (!before.stat.isFile()) throw failure('unsafe-path');
    const maxBytes = consume ? LIMITS.snapshotBytes : LIMITS.manifestBytes;
    if (before.stat.size > maxBytes) throw failure('file-too-large');
    if (metrics.readBytes + before.stat.size > LIMITS.scanBytes) throw failure('scan-budget-exceeded');
    const handle = await fs.open(before.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
        if (!sameFile(before.stat, await handle.stat())) throw failure('changed-during-scan');
        const chunks = [];
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let readBytes = 0;
        while (true) {
            const read = await handle.read(buffer, 0, buffer.length, null);
            if (!read.bytesRead) break;
            readBytes += read.bytesRead;
            metrics.readBytes += read.bytesRead;
            if (readBytes > maxBytes || metrics.readBytes > LIMITS.scanBytes) throw failure('scan-budget-exceeded');
            const chunk = buffer.subarray(0, read.bytesRead);
            hash.update(chunk);
            if (consume) consume(chunk);
            else chunks.push(Buffer.from(chunk));
        }
        const after = await checkedPath(root, relative);
        if (!sameFile(before.stat, await handle.stat()) || !sameFile(before.stat, after.stat)) throw failure('changed-during-scan');
        return { data: consume ? null : Buffer.concat(chunks), stat: after.stat, sha256: hash.digest('hex') };
    } finally { await handle.close(); }
}

function jsonlReader() {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', header = null, messageCount = 0, error = null;
    function line(text) {
        if (!text.trim()) return;
        if (Buffer.byteLength(text) > LIMITS.lineBytes) throw failure('line-too-large');
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid-jsonl');
        if (!header) {
            if (!(value.chat_metadata && typeof value.chat_metadata === 'object' && !Array.isArray(value.chat_metadata))
                && typeof value.user_name !== 'string' && typeof value.character_name !== 'string') throw failure('invalid-jsonl');
            header = value;
        } else {
            if (typeof value.mes !== 'string') throw failure('invalid-jsonl');
            messageCount++;
        }
    }
    function consume(chunk) {
        if (error) return;
        try {
            pending += decoder.decode(chunk, { stream: Boolean(chunk) });
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) {
                line(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
            }
            if (Buffer.byteLength(pending) > LIMITS.lineBytes) throw failure('line-too-large');
            if (!chunk) { line(pending); pending = ''; if (!header) throw failure('invalid-jsonl'); }
        } catch (cause) {
            error = cause.code === 'line-too-large' ? cause.code : 'invalid-jsonl';
            pending = ''; header = null;
        }
    }
    return { consume, finish() { consume(); return { header, messageCount: error ? null : messageCount, error }; } };
}

function identify(header, worlds, ambiguous, names) {
    const worldId = header?.chat_metadata?.nora_world?.id;
    const sessionId = header?.chat_metadata?.nora_session?.id;
    if (!worldId && !sessionId) {
        const candidates = names.get(header?.character_name) || [];
        if (candidates.length > 20) return unknown('ambiguous-legacy-name');
        return candidates.length ? { confidence: 'candidate', worldIds: [...candidates].sort(),
            reason: 'legacy-name-only' } : unknown('missing-identity');
    }
    if (!worldId || !sessionId) return unknown('partial-identity');
    if (ambiguous.has(worldId)) return unknown('ambiguous-world');
    const world = worlds.get(worldId);
    if (!world) return unknown('world-unavailable');
    if (!world.sessions.items.some(session => session.session_id === sessionId)) return unknown('session-mismatch');
    return { confidence: 'identified', worldId, sessionId, worldStatus: world.lifecycle.status, reason: 'identity-match' };
}

async function changedPaths(root, versions, warnings) {
    const paths = new Set();
    for (const [relative, before] of versions) {
        try {
            const after = await checkedPath(root, relative);
            if (!before || !sameFile(before, after.stat)) paths.add(relative);
        } catch (error) {
            if (before || error.code !== 'ENOENT') paths.add(relative);
        }
    }
    for (const relative of paths) warnings.push({ path: relative, code: 'changed-during-scan' });
    return paths;
}

async function readWorldIndex(root, warnings, metrics, versions) {
    const worlds = new Map();
    const ambiguous = new Set();
    const manifestRoot = path.join('nora-world-core', 'worlds');
    for (const entry of await entries(root, manifestRoot, warnings, versions)) {
        if (!entry.name.endsWith('.json')) continue;
        const relative = path.join(manifestRoot, entry.name);
        try {
            const { data, stat } = await readRegular(root, relative, metrics);
            versions.set(relative, stat);
            const world = validateWorldManifest(JSON.parse(data.toString()));
            if (worlds.has(world.world_id) || ambiguous.has(world.world_id)) {
                ambiguous.add(world.world_id);
                worlds.delete(world.world_id);
                warnings.push({ path: relative, code: 'duplicate-world-identity' });
            } else worlds.set(world.world_id, { world_id: world.world_id, name: world.name,
                lifecycle: { status: world.lifecycle.status }, runtime_card: world.runtime_card,
                sessions: world.sessions, knowledge: world.knowledge });
        } catch (error) {
            warnings.push({ path: relative, code: error.code === 'NORA_WORLD_INVALID' || error instanceof SyntaxError
                ? 'invalid-manifest' : error.code || 'read-failed' });
        }
    }
    return { worlds, ambiguous };
}

/** Read-only inventory; never calls WorldStore.load (which can quarantine files).
 * Identity evidence is not restoration validation or authorization to delete.
 * No persistent index: every call rebuilds the view from current files.
 * @param {{root: string, backups: string}} directories Authenticated user directories
 * @returns {Promise<object>} Metadata only, without chat text or manifest contents
 */
export async function inspectChatBackups(directories) {
    const started = performance.now();
    const warnings = [];
    const backups = [];
    const metrics = { readBytes: 0 };
    const manifestVersions = new Map();
    const backupVersions = new Map();
    const backupRelative = path.relative(path.resolve(directories.root), path.resolve(directories.backups));
    if (!backupRelative || backupRelative.startsWith(`..${path.sep}`) || backupRelative === '..' || path.isAbsolute(backupRelative)) {
        throw new TypeError('Backup directory is outside the user root.');
    }
    const root = await fs.realpath(directories.root);
    const { worlds, ambiguous } = await readWorldIndex(root, warnings, metrics, manifestVersions);
    const names = new Map();
    for (const world of worlds.values()) {
        if (!names.has(world.name)) names.set(world.name, []);
        names.get(world.name).push(world.world_id);
    }
    for (const entry of await entries(root, backupRelative, warnings, backupVersions)) {
        if (!entry.name.startsWith('chat_') || !entry.name.endsWith('.jsonl')) continue;
        let stat, sha256;
        const reader = jsonlReader();
        try {
            ({ stat, sha256 } = await readRegular(root, path.join(backupRelative, entry.name), metrics, reader.consume));
            backupVersions.set(path.join(backupRelative, entry.name), stat);
        } catch (error) {
            const code = error.code || 'read-failed';
            warnings.push({ path: path.join(backupRelative, entry.name), code });
            backups.push({ name: entry.name, bytes: null, modifiedAt: null, sha256: null, format: 'unreadable',
                messageCount: null, owner: unknown(code) });
            continue;
        }
        const parsed = reader.finish();
        if (parsed.error) warnings.push({ path: path.join(backupRelative, entry.name), code: parsed.error });
        backups.push({ name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString(),
            sha256, format: parsed.error ? 'invalid' : 'jsonl', messageCount: parsed.messageCount,
            owner: parsed.error ? unknown(parsed.error) : identify(parsed.header, worlds, ambiguous, names) });
    }
    // A World may be deleted or a snapshot replaced during a long scan. Results
    // are observations, never durable authority for a later destructive action.
    const ownershipChanged = (await changedPaths(root, manifestVersions, warnings)).size > 0;
    const changedBackups = await changedPaths(root, backupVersions, warnings);
    for (const backup of backups) {
        if (ownershipChanged) backup.owner = unknown('ownership-changed-during-scan');
        if (changedBackups.has(path.join(backupRelative, backup.name))) {
            backup.owner = unknown('changed-during-scan');
            backup.format = 'unreadable'; backup.sha256 = null; backup.messageCount = null;
        }
    }
    const digests = new Map();
    const summary = { files: backups.length, bytes: 0, duplicateFiles: 0, duplicateBytes: 0 };
    for (const backup of backups) {
        summary.bytes += backup.bytes || 0;
        backup.duplicateOf = backup.sha256 ? digests.get(backup.sha256) || null : null;
        if (backup.duplicateOf) { summary.duplicateFiles++; summary.duplicateBytes += backup.bytes; } else if (backup.sha256) {
            digests.set(backup.sha256, backup.name);
        }
    }
    return { version: 1, readOnly: true, complete: warnings.length === 0, backups, warnings, summary, limits: LIMITS,
        metrics: { ...metrics, durationMs: Math.round((performance.now() - started) * 10) / 10 } };
}

function storageCategory(relative, references) {
    if (references.length) return { category: 'world-resource', reason: 'manifest-reference-preserved' };
    const name = portablePath(relative);
    if (name.startsWith('nora-world-core/library-cards/sources/')) return { category: 'source-archive', reason: 'source-archive-preserved' };
    if (/^nora-world-core\/(operations|mutations)\//.test(name)) return { category: 'operation-record', reason: 'retry-record-preserved' };
    if (/^nora-world-core\/(staging|quarantine)\//.test(name)) return { category: 'recovery-material', reason: 'recovery-material-preserved' };
    if (/^nora-world-core\/library-/.test(name)) return { category: 'library-record', reason: 'library-record-preserved' };
    if (name.startsWith('characters/')) return { category: 'unassigned-card', reason: 'unassigned-card-preserved' };
    if (name.startsWith('chats/')) return { category: 'unassigned-chat', reason: 'unassigned-chat-preserved' };
    if (name.startsWith('worlds/')) return { category: 'unassigned-worldbook', reason: 'unassigned-worldbook-preserved' };
    if (name.startsWith('backups/')) return { category: 'backup', reason: 'backup-policy-not-applied' };
    if (name.startsWith('thumbnails/')) return { category: 'derived-file', reason: 'not-authorized-for-cleanup' };
    return { category: 'unclassified', reason: 'unclassified-file-preserved' };
}

/** Inventory known user storage, without decoding cards, secrets or scripts.
 * References describe manifests' claims, not proof a resource can be deleted.
 * Installation rollback packages and shared native caches are outside user scope.
 * @param {{root: string, characters: string, chats: string, worlds: string, backups: string}} directories User directories
 * @returns {Promise<object>} Metadata and conservative retention reasons
 */
export async function inspectUserStorage(directories) {
    const started = performance.now();
    const root = await fs.realpath(directories.root);
    const relativeDirectory = key => {
        const value = path.relative(path.resolve(directories.root), path.resolve(directories[key] || path.join(directories.root, key)));
        if (!value || value === '..' || value.startsWith(`..${path.sep}`) || path.isAbsolute(value)) throw new TypeError('Storage directory is outside the user root.');
        return value;
    };
    const roots = Object.fromEntries(['characters', 'chats', 'worlds', 'backups'].map(key => [key, relativeDirectory(key)]));
    const scope = [...new Set([...Object.values(roots), 'nora-world-core', 'nora-story-ledger',
        'nora-story-statistics', 'nora-controls', 'nora-telemetry', 'thumbnails', 'extensions', 'OpenAI Settings'])];
    const warnings = [], files = [], metrics = { readBytes: 0 };
    const manifestVersions = new Map(), versions = new Map(), references = new Map();
    const { worlds } = await readWorldIndex(root, warnings, metrics, manifestVersions);
    const leaf = value => typeof value === 'string' && value && !/[/\\\0]/.test(value) && !['.', '..'].includes(value);
    function reference(relative, world, kind, id) {
        if (!references.has(relative)) references.set(relative, []);
        references.get(relative).push({ worldId: world.world_id, worldStatus: world.lifecycle.status, kind, id });
    }
    for (const world of worlds.values()) {
        reference(path.join('nora-world-core', 'worlds', documentFileName(world.world_id)), world, 'world', world.world_id);
        const avatar = world.runtime_card.binding.avatar;
        if (leaf(avatar)) {
            reference(path.join(roots.characters, avatar), world, 'runtime-card', world.runtime_card.resource_id);
            for (const session of world.sessions.items) {
                const chatId = session.binding.chat_id;
                if (!leaf(chatId)) { warnings.push({ path: 'nora-world-core/worlds', code: 'invalid-session-binding' }); continue; }
                reference(path.join(roots.chats, path.parse(avatar).name, sanitize(`${chatId}.jsonl`)), world, 'session', session.session_id);
                reference(path.relative(root, ledgerStatePath(root, { worldId: world.world_id, sessionId: session.session_id })),
                    world, 'ledger', session.session_id);
            }
        } else warnings.push({ path: 'nora-world-core/worlds', code: 'invalid-runtime-binding' });
        for (const resource of world.knowledge) {
            if (leaf(resource.binding.name)) reference(path.join(roots.worlds, `${resource.binding.name}.json`), world, 'worldbook', resource.resource_id);
            else warnings.push({ path: 'nora-world-core/worlds', code: 'invalid-knowledge-binding' });
        }
    }
    const pending = scope.map(relative => ({ relative, depth: 0 }));
    const visitedDirectories = new Set();
    let visited = 0;
    while (pending.length) {
        const { relative, depth } = pending.shift();
        if (visitedDirectories.has(relative)) continue;
        visitedDirectories.add(relative);
        if (depth > 16 || visited >= 20000) {
            warnings.push({ path: relative, code: 'inventory-limit-reached' });
            continue;
        }
        for (const entry of await entries(root, relative, warnings, versions)) {
            if (++visited > 20000) { warnings.push({ path: relative, code: 'inventory-limit-reached' }); break; }
            const file = path.join(relative, entry.name);
            try {
                const { stat } = await checkedPath(root, file);
                versions.set(file, stat);
                if (stat.isDirectory()) { pending.push({ relative: file, depth: depth + 1 }); continue; }
                if (!stat.isFile()) throw failure('unsafe-path');
                const refs = references.get(file) || [];
                files.push({ path: file, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), references: refs,
                    ...storageCategory(file, refs) });
            } catch (error) {
                warnings.push({ path: file, code: error.code || 'read-failed' });
                files.push({ path: file, bytes: null, modifiedAt: null, references: [],
                    category: 'unclassified', reason: 'unreadable-file-preserved' });
            }
        }
    }
    const ownershipChanged = (await changedPaths(root, manifestVersions, warnings)).size > 0;
    const changes = await changedPaths(root, versions, warnings);
    const summary = { files: files.length, bytes: 0, categories: {} };
    for (const file of files) {
        if (changes.has(file.path) || ownershipChanged) {
            file.references = [];
            file.category = 'unclassified'; file.reason = 'changed-during-scan-preserved';
        }
        summary.bytes += file.bytes || 0;
        const category = summary.categories[file.category] ||= { files: 0, bytes: 0 };
        category.files++; category.bytes += file.bytes || 0;
    }
    // Physical scans and change detection use native paths. The public inventory
    // uses the same relative path format on every platform, including Windows.
    return { version: 1, readOnly: true, complete: !warnings.length, scope: scope.map(portablePath),
        files: files.map(file => ({ ...file, path: portablePath(file.path) })).sort((a, b) => a.path.localeCompare(b.path)),
        warnings: warnings.map(warning => ({ ...warning, path: portablePath(warning.path) })),
        summary, metrics: { ...metrics, durationMs: Math.round((performance.now() - started) * 10) / 10 } };
}
