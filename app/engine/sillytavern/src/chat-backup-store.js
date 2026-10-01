import fs, { constants } from 'node:fs/promises';
import fsSync from 'node:fs';
import writeFileAtomicSync from 'write-file-atomic';
import path from 'node:path';
import crypto from 'node:crypto';
import { decode } from 'html-entities';
import { KeyedLock } from './nora-world-core/locks.js';
import { documentFileName, writeJsonAtomic } from './nora-world-core/atomic-json.js';
import { validateWorldManifest } from './nora-world-core/domain.js';
import { getChatRevision } from './chat-revision.js';
import { prefixText } from '../public/scripts/nora-story-ledger/history.js';

const locks = new KeyedLock();
const ID = /^[a-f0-9-]{36}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MVU_STATES = new Set(['unverified', 'pending', 'incomplete', 'confirmed']);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const equalStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const newest = (a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence || a.id.localeCompare(b.id);
// Display-only excerpt. Original messages, downloads and restore bytes stay intact.
function backupExcerpt(text) {
    return decode(text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        .replace(/<(script|style|think|thinking|reasoning|analysis|UpdateVariable|JSONPatch)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
        .replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 140);
}
function parseRestoreChat(data) {
    try {
        const lines = new TextDecoder('utf-8', { fatal: true }).decode(data).split('\n').filter(line => line.trim()).map(JSON.parse);
        if (!lines.length || lines.some(line => !line || typeof line !== 'object' || Array.isArray(line))
            || !lines[0].chat_metadata || typeof lines[0].chat_metadata !== 'object' || Array.isArray(lines[0].chat_metadata)) throw new Error('Invalid chat');
        for (const message of lines.slice(1)) {
            if (typeof message.mes !== 'string') throw new Error('Invalid message');
            if (message.swipes !== undefined && (!Array.isArray(message.swipes) || message.swipes.some(swipe => typeof swipe !== 'string'))) throw new Error('Invalid swipes');
            if (message.swipe_id !== undefined && (!Number.isInteger(message.swipe_id) || message.swipe_id < 0
                || typeof message.swipes?.[message.swipe_id] !== 'string')) throw new Error('Invalid swipe selection');
        }
        return lines;
    } catch { throw fail('NORA_BACKUP_INVALID_RESTORE_CHAT'); }
}
export const DEFAULT_CHAT_BACKUP_POLICY = Object.freeze({ maxPerSession: 20, maxAgeDays: 30, maxBytes: 512 * 1024 * 1024 });

/** Only new, committed JSONL + metadata pairs are managed. Missing, changed or
 * unrecognized records remain untouched. JSONL bytes keep the native format. */
export function createChatBackupStore({ directories, now = Date.now, policy = DEFAULT_CHAT_BACKUP_POLICY }) {
    policy = Object.freeze({ ...DEFAULT_CHAT_BACKUP_POLICY, ...policy });
    if (![policy.maxPerSession, policy.maxAgeDays, policy.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw fail('NORA_BACKUP_INVALID_POLICY');
    const configuredRoot = path.resolve(directories.root);
    let root;

    async function checked(relative) {
        root ??= await fs.realpath(configuredRoot);
        if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw fail('NORA_BACKUP_UNSAFE_PATH');
        let file = root;
        let stat = await fs.lstat(file);
        for (const part of relative.split(path.sep).filter(Boolean)) {
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('NORA_BACKUP_UNSAFE_PATH');
            file = path.join(file, part);
            stat = await fs.lstat(file);
        }
        if (stat.isSymbolicLink()) throw fail('NORA_BACKUP_UNSAFE_PATH');
        return { file, stat };
    }

    const backupRelative = path.relative(configuredRoot, path.resolve(directories.backups));
    const recordsRelative = path.join(backupRelative, '.nora-chat');
    const dataRelative = id => path.join(backupRelative, `chat_nora1_${id}.jsonl`);
    const recordRelative = id => path.join(recordsRelative, `${id}.json`);

    async function read(relative, maxBytes = MAX_FILE) {
        const before = await checked(relative);
        if (!before.stat.isFile() || before.stat.size > maxBytes) throw fail('NORA_BACKUP_UNSAFE_FILE');
        const handle = await fs.open(before.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        try {
            if (!equalStat(before.stat, await handle.stat())) throw fail('NORA_BACKUP_CHANGED');
            const data = Buffer.alloc(before.stat.size);
            let offset = 0;
            while (offset < data.length) {
                const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
                if (!bytesRead) throw fail('NORA_BACKUP_CHANGED');
                offset += bytesRead;
            }
            if (!equalStat(before.stat, await handle.stat()) || !equalStat(before.stat, (await checked(relative)).stat)) throw fail('NORA_BACKUP_CHANGED');
            return { data, stat: before.stat };
        } finally { await handle.close(); }
    }

    async function entries(relative) {
        const dir = await checked(relative);
        if (!dir.stat.isDirectory()) throw fail('NORA_BACKUP_UNSAFE_PATH');
        const result = [];
        for await (const entry of await fs.opendir(dir.file)) {
            if (result.length >= MAX_ENTRIES) throw fail('NORA_BACKUP_SCAN_LIMIT');
            result.push(entry.name);
        }
        return result;
    }

    async function record(id) {
        if (!ID.test(id)) throw fail('NORA_BACKUP_INVALID_ID');
        const { data, stat } = await read(recordRelative(id), 65536);
        const value = JSON.parse(data.toString('utf8'));
        value.mvuState ??= 'unverified';
        if (value.version !== 1 || value.id !== id || !DIGEST.test(value.sha256) || !DIGEST.test(value.sessionKey)
            || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_FILE
            || !Number.isSafeInteger(value.sequence) || value.sequence < 1
            || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
            || typeof value.protected !== 'boolean' || value.consistency !== 'chat-only' || !MVU_STATES.has(value.mvuState)
            || ![value.worldId, value.sessionId].every(v => v === null || typeof v === 'string')) throw fail('NORA_BACKUP_INVALID_RECORD');
        const snapshot = await read(dataRelative(id));
        if (snapshot.data.length !== value.bytes || digest(snapshot.data) !== value.sha256) throw fail('NORA_BACKUP_CHANGED');
        return { value, metadataStat: stat, metadataSha256: digest(data), snapshot };
    }

    async function inventory(includeSummary = false) {
        const snapshots = [], warnings = [];
        let names;
        try { names = await entries(recordsRelative); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
        for (const name of names) {
            const id = name.endsWith('.json') ? name.slice(0, -5) : '';
            if (!ID.test(id)) continue;
            try {
                const { value, snapshot } = await record(id);
                let summary = {};
                // List summaries are read-only projections, never written into old metadata.
                if (includeSummary && snapshot.data.length <= 16 * 1024 * 1024) {
                    try {
                        const messages = parseRestoreChat(snapshot.data).slice(1);
                        summary = { messageCount: messages.length,
                            preview: backupExcerpt(messages.at(-1)?.mes || '') };
                    } catch { summary = { messageCount: null, preview: '' }; }
                }
                snapshots.push({ ...value, ...summary });
            } catch (error) { warnings.push({ id, code: error.code || 'NORA_BACKUP_INVALID_RECORD' }); }
        }
        const managed = new Set(snapshots.map(item => `chat_nora1_${item.id}.jsonl`));
        let totalBytes = 0, legacyFiles = 0;
        for (const name of await entries(backupRelative)) {
            if (!name.startsWith('chat_') || !name.endsWith('.jsonl')) continue;
            const { stat } = await checked(path.join(backupRelative, name));
            if (!stat.isFile()) throw fail('NORA_BACKUP_UNSAFE_FILE');
            totalBytes += stat.size;
            if (!managed.has(name)) legacyFiles++;
        }
        return { snapshots: snapshots.sort(newest), totalBytes, legacyFiles, warnings, policy,
            overBudget: totalBytes > policy.maxBytes };
    }

    async function source(filePath, data) {
        const relative = path.relative(configuredRoot, path.resolve(filePath));
        const chatRoot = path.relative(configuredRoot, path.resolve(directories.chats));
        if (!relative.startsWith(`${chatRoot}${path.sep}`)) throw fail('NORA_BACKUP_UNSAFE_PATH');
        const current = await read(relative).catch(error => {
            if (error.code === 'ENOENT') throw fail('NORA_BACKUP_SOURCE_MISSING');
            throw error;
        });
        if (!current.data.equals(Buffer.from(data))) throw fail('NORA_BACKUP_SOURCE_CHANGED');
        const header = JSON.parse(current.data.toString('utf8').split('\n', 1)[0]);
        const worldId = header?.chat_metadata?.nora_world?.id || null;
        const sessionId = header?.chat_metadata?.nora_session?.id || null;
        if (worldId || sessionId) {
            if (typeof worldId !== 'string' || typeof sessionId !== 'string') throw fail('NORA_BACKUP_INVALID_SCOPE');
            const manifest = JSON.parse((await read(path.join('nora-world-core', 'worlds', documentFileName(worldId)), 16 * 1024 * 1024)).data);
            validateWorldManifest(manifest);
            const session = manifest.sessions.items.find(item => item.session_id === sessionId);
            const expected = path.join(chatRoot, path.basename(manifest.runtime_card.binding.avatar, '.png'), `${session?.binding.chat_id}.jsonl`);
            if (manifest.world_id !== worldId || manifest.lifecycle.status !== 'READY' || !session || expected !== relative) throw fail('NORA_BACKUP_INVALID_SCOPE');
        }
        return { worldId, sessionId, sessionKey: digest(JSON.stringify(worldId ? [worldId, sessionId] : [relative])) };
    }

    async function writeNew(relative, data) {
        const parent = await checked(path.dirname(relative));
        const handle = await fs.open(path.join(parent.file, path.basename(relative)), 'wx', 0o600);
        let failure, written;
        try { await handle.writeFile(data); await handle.sync(); } catch (error) { failure = error; written = await handle.stat().catch(() => null); } finally { await handle.close(); }
        if (failure) {
            // This operation created the file exclusively. Do not remove a
            // replacement made by another writer while handling the failure.
            try {
                const current = await checked(relative);
                if (written && equalStat(current.stat, written)) await fs.unlink(current.file);
            } catch { /* Uncertain remnants are preserved as unmanaged. */ }
            throw failure;
        }
    }

    function obsolete(snapshots) {
        const groups = new Map();
        const removed = [];
        for (const item of snapshots) {
            if (!groups.has(item.sessionKey)) groups.set(item.sessionKey, []);
            groups.get(item.sessionKey).push(item);
        }
        const cutoff = now() - policy.maxAgeDays * 86400000;
        for (const group of groups.values()) {
            let remaining = Math.max(0, policy.maxPerSession - group.filter(item => item.protected).length);
            for (const item of group.sort(newest)) {
                if (item.protected) continue;
                if (item.createdAt < cutoff || remaining <= 0) removed.push(item);
                else remaining--;
            }
        }
        return removed;
    }

    function verifyDigest(current, sha256) {
        if (sha256 !== undefined && (!DIGEST.test(sha256) || sha256 !== current.value.sha256)) throw fail('NORA_BACKUP_CHANGED');
    }

    async function remove(id, sha256) {
        const current = await record(id);
        verifyDigest(current, sha256);
        if (current.value.protected) throw fail('NORA_BACKUP_PROTECTED');
        const metadata = await checked(recordRelative(id));
        const snapshot = await checked(dataRelative(id));
        if (!equalStat(metadata.stat, current.metadataStat) || !equalStat(snapshot.stat, current.snapshot.stat)) throw fail('NORA_BACKUP_CHANGED');
        // Remove ownership first. If unlink fails afterwards the JSONL is kept as
        // unmanaged data, not silently adopted by a later automatic cleanup.
        await fs.unlink(metadata.file);
        await fs.unlink(snapshot.file);
        return { status: 'deleted', id };
    }

    async function prune(candidates) {
        const deleted = [], warnings = [];
        for (const item of candidates) {
            try { await remove(item.id); deleted.push(item.id); } catch (error) { warnings.push({ id: item.id, code: error.code || 'NORA_BACKUP_DELETE_FAILED' }); }
        }
        return { deleted, warnings };
    }

    const run = async operation => {
        const canonicalRoot = await fs.realpath(configuredRoot);
        if (root && root !== canonicalRoot) throw fail('NORA_BACKUP_UNSAFE_PATH');
        root = canonicalRoot;
        return locks.run(root, operation);
    };
    function validateUnchanged(relative, expected) {
        if (fsSync.realpathSync(configuredRoot) !== root || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw fail('NORA_BACKUP_UNSAFE_PATH');
        let target = root;
        for (const part of relative.split(path.sep)) {
            if (!fsSync.lstatSync(target).isDirectory()) throw fail('NORA_BACKUP_UNSAFE_PATH');
            target = path.join(target, part);
            if (fsSync.lstatSync(target).isSymbolicLink()) throw fail('NORA_BACKUP_UNSAFE_PATH');
        }
        if (!equalStat(fsSync.lstatSync(target), expected)) throw fail('NORA_BACKUP_CHANGED');
        return target;
    }

    // Only the World deletion coordinator may call this, after marking the
    // authoritative World DELETING. Protected means retention protection, not
    // immunity from the user's explicit permanent World deletion.
    async function planWorldRemoval(world) {
        const manifestRelative = path.join('nora-world-core', 'worlds', documentFileName(world.world_id));
        const manifestRead = await read(manifestRelative, 16 * 1024 * 1024);
        const current = validateWorldManifest(JSON.parse(manifestRead.data));
        if (current.world_id !== world.world_id) throw fail('NORA_BACKUP_INVALID_SCOPE');
        const sessions = new Set(current.sessions.items.map(item => item.session_id));
        const retained = [], candidates = [];
        let names;
        try { names = await entries(backupRelative); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
        for (const name of names) {
            if (!name.startsWith('chat_') || !name.endsWith('.jsonl')) continue;
            const relative = path.join(backupRelative, name);
            let file, metadata = null;
            try {
                file = await read(relative);
                const header = parseRestoreChat(file.data)[0].chat_metadata;
                if (!header.nora_world?.id || !header.nora_session?.id) throw fail('NORA_BACKUP_UNKNOWN_OWNER');
                if (header.nora_world.id !== current.world_id) continue;
                if (!sessions.has(header.nora_session.id)) throw fail('NORA_BACKUP_UNKNOWN_OWNER');
                if (name.startsWith('chat_nora1_')) {
                    const id = name.slice(11, -6);
                    const managed = await record(id);
                    if (managed.value.worldId !== current.world_id || managed.value.sessionId !== header.nora_session.id) throw fail('NORA_BACKUP_INVALID_SCOPE');
                    metadata = { id, sha256: managed.metadataSha256, protected: managed.value.protected };
                }
            } catch (error) {
                retained.push({ name, code: error.code || 'NORA_BACKUP_UNKNOWN_OWNER' });
                continue;
            }
            candidates.push({ name, sha256: digest(file.data), bytes: file.stat.size, metadata });
        }
        validateUnchanged(manifestRelative, manifestRead.stat);
        return { worldId: current.world_id, revision: current.revision, candidates, retained };
    }

    async function removeWorld(world, plan = null) {
        const manifestRelative = path.join('nora-world-core', 'worlds', documentFileName(world.world_id));
        const manifestRead = await read(manifestRelative, 16 * 1024 * 1024);
        const current = validateWorldManifest(JSON.parse(manifestRead.data));
        if (current.world_id !== world.world_id || current.lifecycle.status !== 'DELETING') throw fail('NORA_BACKUP_WORLD_NOT_DELETING');
        const observed = await planWorldRemoval(world);
        plan ??= observed;
        if (plan.worldId !== world.world_id || !Array.isArray(plan.candidates) || !Array.isArray(plan.retained)) throw fail('NORA_BACKUP_INVALID_DELETE_PLAN');
        const selected = new Set(plan.candidates.map(item => item.name));
        if (selected.size !== plan.candidates.length || observed.candidates.some(item => !selected.has(item.name))) throw fail('NORA_BACKUP_DELETE_PLAN_CHANGED');
        const checks = [], absent = [];
        for (const item of plan.candidates) {
            if (typeof item.name !== 'string' || path.basename(item.name) !== item.name || !/^chat_.+\.jsonl$/.test(item.name)
                || !DIGEST.test(item.sha256)) throw fail('NORA_BACKUP_INVALID_DELETE_PLAN');
            const relatives = [{ relative: path.join(backupRelative, item.name), sha256: item.sha256 }];
            if (item.metadata) {
                if (!ID.test(item.metadata.id) || !DIGEST.test(item.metadata.sha256)
                    || item.name !== `chat_nora1_${item.metadata.id}.jsonl`) throw fail('NORA_BACKUP_INVALID_DELETE_PLAN');
                relatives.push({ relative: recordRelative(item.metadata.id), sha256: item.metadata.sha256 });
            }
            for (const expected of relatives) {
                let file;
                try { file = await read(expected.relative); } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    absent.push(expected.relative);
                    continue;
                }
                if (digest(file.data) !== expected.sha256) throw fail('NORA_BACKUP_DELETE_PLAN_CHANGED');
                checks.push({ relative: expected.relative, stat: file.stat });
            }
        }
        // The durable plan, not a fresh name search, owns retry targets. Validate
        // every remaining byte before deleting, and permit only already-absent
        // entries from that same plan after an interrupted deletion.
        validateUnchanged(manifestRelative, manifestRead.stat);
        for (const item of checks) validateUnchanged(item.relative, item.stat);
        for (const item of checks) fsSync.unlinkSync(validateUnchanged(item.relative, item.stat));
        return { deleted: [...selected], alreadyAbsent: absent.length, retained: observed.retained.filter(item => !selected.has(item.name)) };
    }
    async function restoreTarget({ worldId, sessionId }) {
        if (!worldId || !sessionId) throw fail('NORA_BACKUP_RESTORE_SCOPE_MISMATCH');
        let manifest, manifestRead;
        const manifestRelative = path.join('nora-world-core', 'worlds', documentFileName(worldId));
        try {
            manifestRead = await read(manifestRelative, 16 * 1024 * 1024);
            manifest = JSON.parse(manifestRead.data);
            validateWorldManifest(manifest);
        } catch { throw fail('NORA_BACKUP_RESTORE_TARGET_UNAVAILABLE'); }
        const session = manifest.sessions.items.find(item => item.session_id === sessionId);
        if (manifest.world_id !== worldId || manifest.lifecycle.status !== 'READY' || !session) throw fail('NORA_BACKUP_RESTORE_TARGET_UNAVAILABLE');
        const relative = path.join(path.relative(configuredRoot, path.resolve(directories.chats)),
            path.basename(manifest.runtime_card.binding.avatar, '.png'), `${session.binding.chat_id}.jsonl`);
        let current;
        try { current = await read(relative); } catch (error) {
            if (error.code === 'ENOENT') throw fail('NORA_BACKUP_RESTORE_TARGET_UNAVAILABLE');
            throw error;
        }
        const owner = await source(path.join(configuredRoot, relative), current.data);
        if (owner.worldId !== worldId || owner.sessionId !== sessionId) throw fail('NORA_BACKUP_RESTORE_SCOPE_MISMATCH');
        const existing = parseRestoreChat(current.data);
        return { relative, current, existing, manifestRelative, manifestStat: manifestRead.stat };
    }
    async function inspectRestore({ id, worldId, sessionId }, target = null) {
        const { value, snapshot } = await record(id);
        if (!worldId || !sessionId || value.worldId !== worldId || value.sessionId !== sessionId) throw fail('NORA_BACKUP_RESTORE_SCOPE_MISMATCH');
        const restored = parseRestoreChat(snapshot.data);
        if (restored[0].chat_metadata.nora_world?.id !== worldId || restored[0].chat_metadata.nora_session?.id !== sessionId) throw fail('NORA_BACKUP_RESTORE_SCOPE_MISMATCH');
        target ??= await restoreTarget({ worldId, sessionId });
        const { existing } = target;
        // This is evidence for a confirmation screen, not permission to write.
        // Execution must revalidate both digests and the current World binding.
        const preview = { previewOnly: true, worldId, sessionId,
            current: { revision: getChatRevision(existing), messageCount: existing.length - 1 },
            snapshot: { id, sha256: value.sha256, createdAt: value.createdAt, bytes: value.bytes,
                mvuState: value.mvuState, messageCount: restored.length - 1,
                swipeCount: restored.slice(1).reduce((sum, message) => sum + (message.swipes?.length || 0), 0) },
            includes: ['messages', 'message-data', 'swipes'],
            excludes: ['world-card', 'worldbooks', 'library-originals', 'compression-ledger'],
            protectionRequired: true };
        return { preview, ...target, restored };
    }

    async function capture({ filePath, data, protect = false, mvuState = 'unverified' }, retainId = null, upgradeCredit = null) {
        if (typeof protect !== 'boolean') throw fail('NORA_BACKUP_INVALID_PROTECTION');
        if (!MVU_STATES.has(mvuState)) throw fail('NORA_BACKUP_INVALID_MVU_STATE');
        const owner = await source(filePath, data);
        const before = await inventory();
        const previous = before.snapshots.filter(item => item.sessionKey === owner.sessionKey).sort((a, b) => b.sequence - a.sequence)[0];
        const sha256 = digest(data);
        if (previous?.sha256 === sha256 && (upgradeCredit === null || previous.createdAt >= now() - policy.maxAgeDays * 86400000)) {
            const observedState = previous.mvuState === 'confirmed' || mvuState === 'unverified' ? previous.mvuState : mvuState;
            if ((protect && !previous.protected) || observedState !== previous.mvuState) {
                const current = await record(previous.id);
                await source(filePath, data);
                await writeJsonAtomic((await checked(recordRelative(previous.id))).file,
                    { ...current.value, protected: protect || current.value.protected, mvuState: observedState });
            }
            return { status: 'unchanged', id: previous.id };
        }
        if (protect && before.snapshots.filter(item => item.sessionKey === owner.sessionKey && item.protected).length >= policy.maxPerSession) throw fail('NORA_BACKUP_PROTECTED_LIMIT');
        const id = crypto.randomUUID();
        const value = { version: 1, id, ...owner, sha256, bytes: Buffer.byteLength(data), createdAt: now(),
            sequence: (previous?.sequence || 0) + 1, protected: protect, consistency: 'chat-only', mvuState };
        const candidates = obsolete([...before.snapshots.map(item => item.id === retainId ? { ...item, protected: true } : item), value]);
        if (candidates.some(item => item.id === id)) throw fail('NORA_BACKUP_PROTECTED_LIMIT');
        // Upgrade credit belongs only to the revalidated legacy deletion set.
        // Keep every old file until ALL replacement snapshots are verified;
        // actual disk exhaustion still fails writes without deleting old data.
        const retainedBytes = before.totalBytes + value.bytes - (upgradeCredit ?? candidates.reduce((sum, item) => sum + item.bytes, 0));
        if (before.totalBytes - (upgradeCredit ?? 0) > policy.maxBytes || value.bytes > policy.maxBytes || retainedBytes > policy.maxBytes) throw fail('NORA_BACKUP_BUDGET_EXCEEDED');
        const parent = await checked(backupRelative);
        await fs.mkdir(path.join(parent.file, '.nora-chat'), { recursive: true });
        await checked(recordsRelative);
        await source(filePath, data);
        await writeNew(dataRelative(id), data);
        // A crash before metadata commit leaves an unmanaged file, never a deletion candidate.
        const metadataBytes = Buffer.from(JSON.stringify(value));
        let metadataCommitted = false;
        try {
            await source(filePath, data);
            await writeNew(recordRelative(id), metadataBytes);
            metadataCommitted = true;
            // The World or source may change while metadata fsync is in
            // flight. Never prune the previous snapshot on that outcome.
            await source(filePath, data);
        } catch (error) {
            try {
                if (metadataCommitted) {
                    const metadata = await read(recordRelative(id), 65536);
                    const currentMetadata = await checked(recordRelative(id));
                    if (!metadata.data.equals(metadataBytes) || !equalStat(metadata.stat, currentMetadata.stat)) throw fail('NORA_BACKUP_CHANGED');
                    await fs.unlink(currentMetadata.file);
                }
                const uncommitted = await read(dataRelative(id));
                const current = await checked(dataRelative(id));
                if (digest(uncommitted.data) === sha256 && equalStat(current.stat, uncommitted.stat)) await fs.unlink(current.file);
            } catch { /* A changed or inaccessible remnant is not ours to remove. */ }
            throw error;
        }
        const retention = upgradeCredit === null ? await prune(candidates) : { deleted: [], warnings: [] };
        return { status: 'created', id, retention };
    }

    async function upgradeLegacy() {
        const receiptRelative = path.join(recordsRelative, 'legacy-upgrade-v1.json');
        try {
            const receipt = JSON.parse((await read(receiptRelative, 65536)).data);
            if (receipt.version !== 1 || receipt.status !== 'complete') throw fail('NORA_BACKUP_INVALID_UPGRADE_RECEIPT');
            return { status: 'already-complete' };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const names = await entries(backupRelative);
        const legacyNames = names.filter(name => name.startsWith('chat_') && name.endsWith('.jsonl') && !name.startsWith('chat_nora1_'));
        const worldRelative = path.join('nora-world-core', 'worlds');
        const worlds = new Map(), candidates = [], checks = [], snapshots = [];
        let retained = 0;
        // No migration means no need to read or touch World resources.
        if (legacyNames.length) {
            let worldNames;
            try {
                checks.push({ relative: worldRelative, stat: (await checked(worldRelative)).stat });
                worldNames = await entries(worldRelative);
            } catch (error) { if (error.code !== 'ENOENT') throw error; worldNames = []; }
            for (const name of worldNames.filter(name => name.endsWith('.json'))) {
                const relative = path.join(worldRelative, name);
                const file = await read(relative, 16 * 1024 * 1024);
                const world = validateWorldManifest(JSON.parse(file.data));
                if (name !== documentFileName(world.world_id)) throw fail('NORA_BACKUP_INVALID_SCOPE');
                worlds.set(world.world_id, world);
                checks.push({ relative, stat: file.stat });
            }
            for (const name of legacyNames) {
                const relative = path.join(backupRelative, name);
                try {
                    const file = await read(relative);
                    const header = parseRestoreChat(file.data)[0].chat_metadata;
                    const world = worlds.get(header.nora_world?.id);
                    if (!world || !['READY', 'DELETED'].includes(world.lifecycle.status)
                        || !world.sessions.items.some(item => item.session_id === header.nora_session?.id)) {
                        retained++; continue;
                    }
                    candidates.push({ relative, stat: file.stat });
                } catch { retained++; }
            }
        }
        if (candidates.length) {
            const credit = candidates.reduce((sum, item) => sum + item.stat.size, 0);
            // Back up every extant World session, not just the latest active tab.
            // Missing/unreadable chats stop the upgrade before any legacy delete.
            for (const world of worlds.values()) {
                if (world.lifecycle.status !== 'READY') continue;
                for (const session of world.sessions.items) {
                    const target = await restoreTarget({ worldId: world.world_id, sessionId: session.session_id });
                    const saved = await capture({ filePath: path.join(configuredRoot, target.relative), data: target.current.data }, null, credit);
                    const snapshot = await record(saved.id);
                    if (!snapshot.snapshot.data.equals(target.current.data)) throw fail('NORA_BACKUP_CHANGED');
                    snapshots.push(saved.id);
                    checks.push({ relative: target.relative, stat: target.current.stat },
                        { relative: dataRelative(saved.id), stat: snapshot.snapshot.stat },
                        { relative: recordRelative(saved.id), stat: snapshot.metadataStat });
                }
            }
            // The user-level backup lock excludes backup/restore mutations. The
            // final synchronous checks also reject concurrent chat/World edits.
            // A crash mid-delete leaves remaining legacy files for a safe retry;
            // committed matching snapshots are reused, never deleted first.
            for (const item of [...checks, ...candidates]) validateUnchanged(item.relative, item.stat);
            for (const item of candidates) fsSync.unlinkSync(validateUnchanged(item.relative, item.stat));
        }
        const parent = await checked(backupRelative);
        await fs.mkdir(path.join(parent.file, '.nora-chat'), { recursive: true });
        await checked(recordsRelative);
        const result = { version: 1, status: 'complete', at: now(), removed: candidates.length, retained, baselines: snapshots.length };
        await writeJsonAtomic(path.join(root, receiptRelative), result);
        return result;
    }

    // Caller must hold the session-operation AND ledger idle locks. The backup
    // lock additionally prevents snapshot deletion or retention during restore.
    async function restore(input, { ledgerEnabled = true } = {}) {
        const target = await restoreTarget(input);
        const receipt = target.existing[0].chat_metadata.nora_restore;
        if (receipt && receipt.snapshotId === input.id && receipt.snapshotSha256 === input.sha256
            && receipt.previousRevision === input.expectedRevision) {
            return { status: 'already-restored', worldId: input.worldId, sessionId: input.sessionId,
                revision: getChatRevision(target.existing), restoreId: receipt.id, protectedBackupId: receipt.protectedBackupId };
        }
        const inspected = await inspectRestore(input, target);
        const verify = current => {
            if (typeof input.expectedRevision !== 'string' || current.preview.current.revision !== input.expectedRevision
                || typeof input.sha256 !== 'string' || current.preview.snapshot.sha256 !== input.sha256) throw fail('NORA_BACKUP_RESTORE_STALE');
        };
        verify(inspected);
        // Keep the selected snapshot safe while making the required protection
        // point. Retention must not prune the very snapshot being restored.
        let checkpoint;
        try { checkpoint = await capture({ filePath: path.join(configuredRoot, inspected.relative), data: inspected.current.data, protect: true }, input.id); } catch (cause) {
            throw Object.assign(fail('NORA_BACKUP_REQUIRED'), { backupCode: cause.code || 'NORA_BACKUP_WRITE_FAILED' });
        }
        const latest = await inspectRestore(input);
        verify(latest);
        const metadata = latest.restored[0].chat_metadata;
        const restoreId = crypto.randomUUID();
        for (const key of ['nora_world', 'nora_session', 'integrity', 'world_info']) metadata[key] = latest.existing[0].chat_metadata[key];
        metadata.nora_restore = { id: restoreId, snapshotId: input.id, snapshotSha256: input.sha256,
            previousRevision: input.expectedRevision, protectedBackupId: checkpoint.id, ledgerEnabled, at: now(),
            historySignature: digest(prefixText(latest.restored.slice(1), latest.restored.length - 1)) };
        const data = latest.restored.map(item => JSON.stringify(item)).join('\n');
        // No await between final path/stat validation and the atomic replace.
        validateUnchanged(latest.manifestRelative, latest.manifestStat);
        const destination = validateUnchanged(latest.relative, latest.current.stat);
        writeFileAtomicSync.sync(destination, data, 'utf8');
        return { status: 'restored', worldId: input.worldId, sessionId: input.sessionId,
            revision: getChatRevision(latest.restored), restoreId, protectedBackupId: checkpoint.id };
    }

    return Object.freeze({
        list: () => run(() => inventory(true)),
        upgradeLegacy: () => run(upgradeLegacy),
        previewRestore: input => run(async () => (await inspectRestore(input)).preview),
        restore: (input, options) => run(() => restore(input, options)),
        planWorldRemoval: world => run(() => planWorldRemoval(world)),
        removeWorld: (world, plan) => run(() => removeWorld(world, plan)),
        download: (id, sha256) => run(async () => {
            const current = await record(id);
            verifyDigest(current, sha256);
            return current.snapshot.data;
        }),
        inspect: ({ id, sha256, offset = 0, limit = 20 }) => run(async () => {
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw fail('NORA_BACKUP_INVALID_WINDOW');
            const current = await record(id);
            verifyDigest(current, sha256);
            const messages = parseRestoreChat(current.snapshot.data).slice(1);
            return { id, worldId: current.value.worldId, sessionId: current.value.sessionId, sha256: current.value.sha256,
                mvuState: current.value.mvuState, messageCount: messages.length, offset, limit,
                hasMore: offset + limit < messages.length, previewOnly: true,
                messages: messages.slice(offset, offset + limit).map((message, index) => ({ index: offset + index,
                    name: typeof message.name === 'string' ? message.name.slice(0, 120) : '', isUser: message.is_user === true,
                    text: message.mes.slice(0, 4000), truncated: message.mes.length > 4000,
                    swipeCount: message.swipes?.length || 0, selectedSwipe: message.swipe_id ?? null })) };
        }),
        remove: (id, sha256) => run(() => remove(id, sha256)),
        protect: (id, protectedValue, sha256) => run(async () => {
            if (typeof protectedValue !== 'boolean') throw fail('NORA_BACKUP_INVALID_PROTECTION');
            const current = await record(id);
            verifyDigest(current, sha256);
            const target = await checked(recordRelative(id));
            if (!equalStat(target.stat, current.metadataStat)) throw fail('NORA_BACKUP_CHANGED');
            await writeJsonAtomic(target.file, { ...current.value, protected: protectedValue });
            return { status: 'updated', id, protected: protectedValue };
        }),
        maintain: () => run(async () => prune(obsolete((await inventory()).snapshots))),
        capture: input => run(() => capture(input)),
    });
}
