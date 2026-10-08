import path from 'node:path';
import { getConfigValue } from './util.js';
import { createChatBackupStore } from './chat-backup-store.js';

const pending = new Map();
const running = new Set();
const results = new Map();
const closing = new Set();
const enabled = () => getConfigValue('backups.chat.enabled', true, 'boolean');

export function chatBackupStore(directories) {
    return createChatBackupStore({ directories, policy: {
        maxPerSession: getConfigValue('backups.chat.retention.maxPerSession', 50, 'number'),
        maxAgeDays: getConfigValue('backups.chat.retention.maxAgeDays', 30, 'number'),
        maxBytes: getConfigValue('backups.chat.retention.maxBytes', 536870912, 'number'),
    } });
}

/** Rollback capture is best-effort. Chat revision/ownership checks belong to
 * the caller and must stay independent of optional backup availability. */
export async function protectChatBeforeRewrite({ directories, filePath, data }) {
    let result;
    try {
        result = await chatBackupStore(directories).tryCapture({ filePath, data });
    } catch (cause) {
        result = { status: 'failed', code: cause.code || 'NORA_BACKUP_WRITE_FAILED' };
    }
    const scope = JSON.parse(String(data).split('\n', 1)[0]).chat_metadata;
    return report(directories, { ...result, worldId: scope?.nora_world?.id, sessionId: scope?.nora_session?.id });
}

export function chatBackupWarning(directories, scope) {
    const latest = chatBackupStatus(directories).recent.filter(item => item.worldId === scope.worldId && item.sessionId === scope.sessionId).at(-1);
    return latest && ['failed', 'skipped'].includes(latest.status) ? { status: latest.status, code: latest.code } : null;
}

function report(directories, result) {
    const root = path.resolve(directories.root);
    const recent = results.get(root) || [];
    recent.push({ ...result, at: Date.now() });
    results.set(root, recent.slice(-20));
    if (result.status === 'failed' || result.retention?.warnings?.length) {
        console.warn('[Chat backup] Backup unavailable; foreground operations remain independent:', result.code || result.retention.warnings.map(item => item.code).join(','));
    }
    return result;
}

async function capture(entry) {
    try {
        return report(entry.directories, await chatBackupStore(entry.directories).tryCapture(entry));
    } catch (error) {
        const superseded = ['NORA_BACKUP_SOURCE_CHANGED', 'NORA_BACKUP_SOURCE_MISSING'].includes(error.code);
        return report(entry.directories, { status: superseded ? 'skipped' : 'failed', code: error.code || 'NORA_BACKUP_WRITE_FAILED' });
    }
}

function start(key) {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    const task = capture(entry).finally(() => running.delete(task));
    running.add(task);
    return task;
}

/** Called only after the canonical save succeeds. Never throw backup errors into
 * the save response; skipped transaction saves also cancel older queued work. */
export function queueChatBackup({ directories, filePath, data, skip = false, mvuState = 'unverified' }) {
    const key = path.resolve(filePath);
    const previous = pending.get(key);
    if (previous) { clearTimeout(previous.timer); pending.delete(key); }
    if (skip) return { status: 'skipped', reason: 'intermediate-save' };
    try {
        if (closing.has(path.resolve(directories.root))) return { status: 'skipped', reason: 'shutdown' };
        if (!enabled()) return { status: 'disabled' };
        const delay = Math.max(0, Number(getConfigValue('backups.chat.throttleInterval', 10000, 'number')) || 0);
        const entry = { directories, filePath, data, mvuState, timer: setTimeout(() => { void start(key); }, delay) };
        pending.set(key, entry);
        return { status: 'queued' };
    } catch (error) {
        return report(directories, { status: 'failed', code: error.code || 'NORA_BACKUP_QUEUE_FAILED' });
    }
}

export function chatBackupStatus(directories) {
    const root = path.resolve(directories.root);
    return { enabled: enabled(), pending: [...pending.values()].filter(entry => path.resolve(entry.directories.root) === root).length,
        recent: [...(results.get(root) || [])] };
}

export async function flushChatBackups() {
    for (const key of pending.keys()) start(key);
    await Promise.all([...running]);
}

/** One-time legacy upgrade, then startup/hourly managed retention. Unidentified
 * files remain untouched. The caller owns shutdown and awaits flushing. */
export function startChatBackupMaintenance(directoriesList) {
    for (const directories of directoriesList) closing.delete(path.resolve(directories.root));
    let stopped = false, active = Promise.resolve();
    const sweep = () => {
        active = active.then(async () => {
            if (stopped || !enabled()) return;
            for (const directories of directoriesList) {
                try {
                    const store = chatBackupStore(directories);
                    try {
                        const upgrade = await store.upgradeLegacy();
                        if (upgrade.removed) console.info('[Chat backup] Legacy upgrade completed:', { removed: upgrade.removed, baselines: upgrade.baselines, retained: upgrade.retained });
                    } catch (cause) {
                        console.warn('[Chat backup] Legacy upgrade postponed; current chats unchanged:', cause.code || 'NORA_BACKUP_UPGRADE_FAILED');
                        throw Object.assign(new Error('Legacy upgrade postponed'), { code: 'NORA_BACKUP_UPGRADE_PENDING' });
                    }
                    report(directories, { status: 'maintenance', retention: await store.maintain() });
                } catch (error) { report(directories, { status: 'failed', code: error.code || 'NORA_BACKUP_MAINTENANCE_FAILED' }); }
            }
        });
    };
    const initial = setTimeout(sweep, 0);
    initial.unref();
    const timer = setInterval(sweep, 3600000);
    timer.unref();
    return async () => {
        stopped = true;
        for (const directories of directoriesList) closing.add(path.resolve(directories.root));
        clearTimeout(initial);
        clearInterval(timer);
        await active;
        await flushChatBackups();
    };
}
