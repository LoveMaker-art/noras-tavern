import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sync as writeAtomic } from 'write-file-atomic';
import { validateControl, controlError } from '../public/scripts/nora-controls/contract.js';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['completed', 'failed', 'unknown', 'expired']);
// One broker per authenticated user. Durable receipts contain metadata/digests,
// never script bodies, keys or chat content. Completed work is not retained in RAM.
export function createControlBroker(root, { now = Date.now, leaseMs = 45000, queueMs = 45000, executionMs = 420000 } = {}) {
    const directory = path.join(root, 'nora-controls');
    const epoch = crypto.randomUUID();
    const clients = new Map();
    const jobs = new Map();
    const results = new Map();
    const waiters = new Map();
    function location(id) {
        if (typeof id !== 'string' || !/^control:[a-f0-9]{32}$/.test(id)) throw controlError('NORA_CONTROL_INVALID', 'Invalid operation ID.');
        return path.join(directory, id.slice(8, 10), id.slice(8) + '.json');
    }
    function persist(job) {
        const file = location(job.id);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const record = { ...job };
        delete record.input;
        writeAtomic(file, JSON.stringify(record), { mode: 0o600 });
    }
    function get(id) {
        if (jobs.has(id)) return jobs.get(id);
        const file = location(id);
        if (!fs.existsSync(file)) return null;
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (record.id !== id) throw controlError('NORA_CONTROL_JOURNAL_INVALID', 'Receipt identity mismatch.');
        if (!terminal.has(record.status) && record.epoch !== epoch) {
            record.status = 'unknown'; persist(record);
        }
        return record;
    }
    function rememberResult(id, result) {
        results.set(id, result);
        if (results.size > 64) results.delete(results.keys().next().value);
    }
    function sweep() {
        for (const [id, client] of clients) if (now() - client.seen > leaseMs) clients.delete(id);
        for (const job of jobs.values()) {
            if (job.status === 'queued' && now() - job.created > queueMs) job.status = 'expired';
            if (job.status === 'running' && now() - job.started > executionMs) job.status = 'unknown';
            if (terminal.has(job.status)) { job.input = null; persist(job); jobs.delete(job.id); }
        }
    }
    function inspect(id) {
        sweep(); const job = get(id);
        if (!job) throw controlError('NORA_CONTROL_NOT_FOUND', 'Operation unknown or outside retained history; do not blindly repeat.');
        const record = { ...job };
        delete record.input;
        delete record.epoch;
        return { ...record, resultAvailable: results.has(id), result: results.get(id) ?? null };
    }
    function list() { sweep(); return [...clients.values()].map(({ token, ...item }) => item); }
    function hello({ clientId, worldId = '', sessionId = '', busy = false }) {
        sweep();
        if (typeof clientId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(clientId)) throw controlError('NORA_CONTROL_INVALID', 'Invalid client ID.');
        if (clients.size >= 16 && !clients.has(clientId)) throw controlError('NORA_CONTROL_LIMIT', 'Too many connected clients.');
        const client = { clientId, worldId: String(worldId).slice(0, 192), sessionId: String(sessionId).slice(0, 192), busy: Boolean(busy), token: crypto.randomUUID(), seen: now() };
        clients.set(clientId, client); return { token: client.token };
    }
    function authenticate(input) {
        const client = clients.get(input.clientId);
        if (!client || client.token !== input.token) throw controlError('NORA_CONTROL_CLIENT_STALE', 'Reconnect this runtime client.');
        client.seen = now();
        client.worldId = String(input.worldId ?? client.worldId).slice(0, 192);
        client.sessionId = String(input.sessionId ?? client.sessionId).slice(0, 192);
        client.busy = Boolean(input.busy);
        return client;
    }
    function submit(input, options = {}) {
        sweep(); validateControl(input, options);
        if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw controlError('NORA_CONTROL_INVALID', 'Stable idempotencyKey required.');
        const id = 'control:' + digest(input.idempotencyKey).slice(0, 32);
        const fingerprint = digest([input.action, input.params ?? {}, input.clientId, input.worldId, input.sessionId]);
        const previous = get(id);
        if (previous) {
            if (previous.fingerprint !== fingerprint) throw controlError('NORA_CONTROL_CONFLICT', 'Idempotency key already used for a different action.');
            return inspect(id);
        }
        if ([...jobs.values()].filter(job => !terminal.has(job.status)).length >= 32) throw controlError('NORA_CONTROL_LIMIT', 'Control queue is full.');
        const client = clients.get(input.clientId);
        if (!client) throw controlError('NORA_CONTROL_OFFLINE', 'No live target page. Open Tavern and query clients again.');
        if (input.worldId !== client.worldId || input.sessionId !== client.sessionId) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'Target World/Session changed.');
        const record = { id, fingerprint, epoch, action: input.action, clientId: input.clientId, worldId: input.worldId, sessionId: input.sessionId, status: 'queued', created: now(), input };
        jobs.set(id, record);
        try { persist(record); } catch (error) { jobs.delete(id); throw error; }
        waiters.get(input.clientId)?.();
        return inspect(id);
    }
    async function poll(input, signal, timeoutMs = 20000) {
        authenticate(input); sweep();
        function take() {
            const client = authenticate(input);
            const job = [...jobs.values()].find(item => item.clientId === input.clientId && item.status === 'queued');
            if (!job) return null;
            if (job.worldId !== client.worldId || job.sessionId !== client.sessionId) {
                job.status = 'failed'; job.input = null; persist(job); jobs.delete(job.id); rememberResult(job.id, { code: 'NORA_CONTROL_SCOPE_CHANGED' }); return null;
            }
            job.status = 'running'; job.started = now(); persist(job);
            return { id: job.id, ...job.input };
        }
        const immediate = take(); if (immediate || signal?.aborted) return immediate;
        if (waiters.has(input.clientId)) throw controlError('NORA_CONTROL_BUSY', 'Only one poll per runtime client.');
        await new Promise(resolve => {
            const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); waiters.delete(input.clientId); resolve(); };
            const timer = setTimeout(done, Math.min(20000, timeoutMs));
            waiters.set(input.clientId, done); signal?.addEventListener('abort', done, { once: true });
        });
        return signal?.aborted ? null : take();
    }
    function ack(input) {
        authenticate(input); const job = get(input.id);
        if (!job || job.clientId !== input.clientId) throw controlError('NORA_CONTROL_NOT_FOUND', 'Unknown client operation.');
        if (terminal.has(job.status)) return inspect(job.id);
        if (job.status !== 'running' || !['completed', 'failed', 'unknown'].includes(input.status)) throw controlError('NORA_CONTROL_INVALID', 'Invalid acknowledgment.');
        const raw = JSON.stringify(input.result ?? null);
        const result = raw.length <= 512000 ? input.result : { code: 'NORA_CONTROL_RESULT_LIMIT', truncated: true };
        job.status = input.status; job.finished = now(); job.input = null; persist(job); jobs.delete(job.id);
        rememberResult(job.id, result);
        return inspect(job.id);
    }
    return Object.freeze({ list, hello, submit, poll, ack, inspect });
}
