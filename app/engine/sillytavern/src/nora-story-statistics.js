import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 'nora-story-statistics/v1';
const runtimes = new Map();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => String(value ?? '').trim();

/** Preserve the original UI and reflection counters, including their different empty-message rules. */
export function summarizeStoryChat(messages) {
    let turns = 0;
    let words = 0;
    let reflectionTurns = 0;
    let storyIndex = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
        if (message?.is_user && text(message?.mes)) reflectionTurns += 1;
        if (!message || typeof message.is_user !== 'boolean' || typeof message.mes !== 'string') continue;
        if (message.is_user) turns += 1;
        else if (storyIndex > 0) {
            // Count Unicode code points, not UTF-16 units or model tokens.
            // eslint-disable-next-line no-unused-vars -- Iterate without allocating a second copy of the message.
            for (const _character of message.mes) words += 1;
        }
        storyIndex += 1;
    }
    return { turns, words, reflectionTurns };
}

function bindingOf(directories, world) {
    const worldId = text(world?.world_id);
    const sessionId = text(world?.sessions?.default_session_id);
    const session = world?.sessions?.items?.find(item => item.session_id === sessionId);
    const avatar = text(world?.runtime_card?.binding?.avatar);
    const chatId = text(session?.binding?.chat_id);
    const safe = value => value && value !== '.' && value !== '..' && path.basename(value) === value;
    const identity = [path.resolve(directories.root), path.resolve(directories.chats), worldId, sessionId, avatar, chatId];
    return {
        worldId, sessionId, identity,
        // One current-default-session record per World; rebinding replaces it.
        key: hash(worldId),
        filePath: safe(avatar) && safe(chatId)
            ? path.join(directories.chats, avatar.replace(/\.png$/i, ''), `${chatId}.jsonl`) : null,
    };
}

function validRecord(record, revision) {
    return record?.schema === SCHEMA && record.revision === revision
        && ['turns', 'words', 'reflectionTurns'].every(key => Number.isSafeInteger(record.stats?.[key]) && record.stats[key] >= 0)
        && record.checksum === hash(record.stats);
}

/** Derived, disposable statistics only. Every read validates the canonical file, not a TTL. */
export function createStoryStatistics(directories, { io = fs, report = () => {} } = {}) {
    if (!directories?.root || !directories?.chats) throw new TypeError('Chat directories are required.');
    const cacheRoot = path.join(directories.root, 'nora-story-statistics');
    const jobs = new Map();

    async function revisionOf(binding) {
        if (!binding.filePath) return null;
        try {
            const info = await io.stat(binding.filePath, { bigint: true });
            return hash([SCHEMA, ...binding.identity, ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(info[key]))]);
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async function persist(binding, record) {
        const filename = path.join(cacheRoot, `${binding.key}.json`);
        const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
        try {
            await io.mkdir(cacheRoot, { recursive: true });
            await io.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
            await io.rename(temporary, filename);
        } catch (error) {
            report({ event: 'cache_write_failed', code: error.code });
        } finally {
            await io.unlink(temporary).catch(error => {
                if (error.code !== 'ENOENT') report({ event: 'cache_cleanup_failed', code: error.code });
            });
        }
    }

    async function load(binding, includeMessages) {
        const start = performance.now();
        const result = (revision, stats, messages) => ({
            world_id: binding.worldId, session_id: binding.sessionId, revision, ...stats,
            ...(includeMessages ? { messages } : {}),
        });
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const revision = await revisionOf(binding);
            if (revision === null) return result(null, summarizeStoryChat([]), []);
            if (!includeMessages) {
                let cached;
                try {
                    cached = JSON.parse(await io.readFile(path.join(cacheRoot, `${binding.key}.json`), 'utf8'));
                } catch (error) {
                    if (error.code !== 'ENOENT') report({ event: 'cache_read_failed', code: error.code || 'invalid_json' });
                }
                if (validRecord(cached, revision) && await revisionOf(binding) === revision) {
                    report({ event: 'hit', durationMs: performance.now() - start });
                    return result(revision, cached.stats);
                }
            }
            let content;
            try {
                content = await io.readFile(binding.filePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw error;
            }
            // A parse error is not an empty conversation. Do not persist false zeroes.
            const messages = content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
            const stats = summarizeStoryChat(messages);
            if (await revisionOf(binding) !== revision) continue;
            await persist(binding, { schema: SCHEMA, revision, stats, checksum: hash(stats) });
            if (await revisionOf(binding) !== revision) continue;
            report({ event: 'rebuild', durationMs: performance.now() - start, chatBytes: Buffer.byteLength(content) });
            return result(revision, stats, messages);
        }
        throw new Error('Story changed during statistics read; retry the request.');
    }

    function read(world, { includeMessages = false } = {}) {
        const binding = bindingOf(directories, world);
        const pending = jobs.get(binding.key);
        if (pending) {
            if (pending.identity === hash(binding.identity) && (!includeMessages || pending.includeMessages)) return pending.promise;
            return pending.promise.catch(() => {}).then(() => read(world, { includeMessages }));
        }
        const job = { identity: hash(binding.identity), includeMessages };
        job.promise = load(binding, includeMessages).finally(() => {
            if (jobs.get(binding.key) === job) jobs.delete(binding.key);
        });
        jobs.set(binding.key, job);
        return job.promise;
    }

    async function prune(worlds) {
        const retained = new Set(worlds.map(world => `${hash(text(world.world_id))}.json`));
        try {
            for (const name of await io.readdir(cacheRoot)) {
                if (!/^[a-f0-9]{64}\.json$/.test(name) || retained.has(name) || jobs.has(name.slice(0, -5))) continue;
                await io.unlink(path.join(cacheRoot, name)).catch(error => {
                    if (error.code !== 'ENOENT') throw error;
                });
            }
        } catch (error) {
            if (error.code !== 'ENOENT') report({ event: 'cache_prune_failed', code: error.code });
        }
    }

    return Object.freeze({ read, prune });
}

export function resolveStoryStatistics(directories) {
    const key = JSON.stringify([path.resolve(directories.root), path.resolve(directories.chats)]);
    if (!runtimes.has(key)) {
        runtimes.set(key, createStoryStatistics(directories, {
            report: event => {
                if (event.event.endsWith('_failed')) console.warn('[Story Profile statistics]', event);
                else if (process.env.TAVERN_PROFILE_STATS_TRACE === '1') console.info('[Story Profile statistics]', event);
            },
        }));
    }
    return runtimes.get(key);
}
