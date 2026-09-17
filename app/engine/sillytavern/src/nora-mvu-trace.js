// Opt-in, per-user diagnostic capture. Never forwards diagnostic metadata upstream.
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { mvuDiagnosticStore } from './nora-mvu-diagnostics.js';

const LIMIT = 128000;
const SECRET = /authorization|api.?key|secret|password|token|cookie|reasoning|thinking/i;
const SAFE_NUMERIC = new Set(['max_tokens', 'max_completion_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens']);
const wireCaptures = new WeakMap();
const REQUEST_FIELDS = ['model', 'chat_completion_source', 'stream', 'messages', 'tools', 'tool_choice', 'json_schema', 'response_format', 'temperature', 'max_tokens', 'max_completion_tokens'];
const requestDetail = body => Object.fromEntries(REQUEST_FIELDS.filter(k => k in body).map(k => [k, body[k]]));

/** Exact custom/OpenAI payload after provider transforms, immediately before dispatch. */
export function traceProviderRequest(request, body) {
    try { wireCaptures.get(request)?.('provider-request', requestDetail(body)); } catch { /* Diagnostics are fail-open. */ }
}
const identifier = value => String(value ?? '').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 160);
const redact = text => String(text)
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|fc)-[\w-]{12,}/g, '[redacted-key]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted-jwt]')
    .replace(/((?:api[_ -]?key|authorization|secret|password|token)["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, '$1[redacted]')
    .replace(/data:[^;\s]+;base64,[a-zA-Z0-9+/=]+/g, '[omitted-inline-media]');

export async function traceConfig(directories) {
    try {
        const config = JSON.parse(await fs.readFile(path.join(directories.root, '.nora-mvu-trace.json'), 'utf8'));
        const expiresAt = Number(config.expiresAt);
        return { enabled: expiresAt > Date.now() && expiresAt <= Date.now() + 86400000, expiresAt, chatId: identifier(config.chatId) };
    } catch { return { enabled: false }; }
}

export function normalizeTrace(payload = {}, user = 'unknown') {
    let remaining = LIMIT;
    let truncated = false;
    function clean(value, depth = 0) {
        if (depth > 12 || remaining <= 0) { truncated = true; return '[truncated]'; }
        if (typeof value === 'string') {
            const safe = redact(value);
            if (safe.length > remaining) {
                const half = Math.floor(Math.max(0, remaining - 40) / 2);
                remaining = 0; truncated = true;
                return `${safe.slice(0, half)}\n[truncated; head and tail retained]\n${half ? safe.slice(-half) : ''}`;
            }
            remaining -= safe.length;
            return safe;
        }
        if (Array.isArray(value)) {
            if (value.length > 256) truncated = true;
            return value.slice(0, 256).map(v => clean(v, depth + 1));
        }
        if (value && typeof value === 'object') {
            const entries = Object.entries(value);
            if (entries.length > 64) truncated = true;
            return Object.fromEntries(entries.slice(0, 64).filter(([k, v]) => !SECRET.test(k) ||
                (SAFE_NUMERIC.has(k) && typeof v === 'number' && Number.isFinite(v)) || (k === 'hasReasoning' && typeof v === 'boolean'))
                .map(([k, v]) => [k.slice(0, 100), clean(v, depth + 1)]));
        }
        return value;
    }
    const detail = JSON.stringify(clean(payload.detail ?? {}));
    return {
        schemaVersion: 1, kind: 'mvu-test-trace', receivedAt: new Date().toISOString(),
        user: identifier(user), chatId: identifier(payload.chatId), requestId: identifier(payload.requestId),
        stage: identifier(payload.stage), occurredAt: Number(payload.occurredAt) || Date.now(),
        detail, truncated: truncated || payload.truncated === true,
    };
}

const budgets = new Map();
export async function appendTrace(directories, payload, user, config) {
    if (!config?.enabled || (config.chatId && config.chatId !== payload.chatId)) return;
    const key = directories.root;
    if (budgets.size > 128) budgets.clear();
    const budget = budgets.get(key);
    const count = budget?.expiresAt === config.expiresAt ? budget.count : 0;
    if (count >= 600) return;
    budgets.set(key, { count: count + 1, expiresAt: config.expiresAt });
    await mvuDiagnosticStore.append(directories, normalizeTrace(payload, user));
}

export async function traceGeneration(request, response, next, {
    config = traceConfig, append = appendTrace,
} = {}) {
    const marker = request.body?.nora_mvu_trace;
    if (request.body) delete request.body.nora_mvu_trace;
    // No scanning other conversations, response wrapping, or file reads when unmarked.
    if (!marker || typeof marker !== 'object') return next();
    const isMvu = (marker.kind === 'mvu-variable' && ['legacy', 'nora-mvu/1'].includes(marker.protocol)) ||
        (Array.isArray(request.body.messages) && request.body.messages.some(m => typeof m?.content === 'string' && m.content.includes('Use nora-mvu/1.')))
        || (Array.isArray(request.body.tools) && request.body.tools.some(t => t?.function?.name === 'nora_mvu_update'));
    if (!isMvu) return next();
    try {
        const directories = request.user?.directories;
        const setting = await config(directories);
        const chatId = identifier(marker.chatId);
        if (!setting.enabled || (setting.chatId && setting.chatId !== chatId)) return next();
        const requestId = identifier(marker.requestId) || randomUUID();
        const save = (stage, detail, truncated = false) => {
            void Promise.resolve().then(() => append(directories, { stage, requestId, chatId, detail, truncated }, request.user?.profile?.handle, setting)).catch(() => {});
        };
        wireCaptures.set(request, save);
        save('model-request', { ...requestDetail(request.body), protocol: marker.protocol });
        const decoder = new StringDecoder('utf8');
        const chunks = [], choices = new Map();
        let pending = '', totalBytes = 0, truncated = false, streaming = false, finished = false, usage;
        function concatenate(previous = '', addition = '') {
            const text = previous + addition;
            if (text.length <= LIMIT) return text;
            truncated = true;
            return text.slice(0, LIMIT / 2 - 30) + '\n[truncated]\n' + text.slice(-LIMIT / 2);
        }
        function record(text) {
            if (!text || text === '[DONE]') return;
            let data;
            try { data = JSON.parse(text); } catch { data = { unparsed: `[non-JSON response: ${text.length} characters]` }; }
            if (data.usage && typeof data.usage === 'object') usage = Object.fromEntries(
                ['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(k => Number.isFinite(data.usage[k])).map(k => [k, data.usage[k]]));
            // Persist visible output/tool calls, not hidden model reasoning.
            if (Array.isArray(data.choices)) {
                for (const c of data.choices.slice(0, 8)) {
                    const key = c.index ?? 0;
                    if (!choices.has(key) && choices.size >= 8) { truncated = true; continue; }
                    const item = choices.get(key) ?? { index: key, content: '', contentLength: 0, contentType: 'missing', hasReasoning: false, tool_calls: [] };
                    const part = c.delta ?? c.message ?? {};
                    if ('content' in part) item.contentType = part.content === null ? 'null' : Array.isArray(part.content) ? 'array' : typeof part.content;
                    item.hasReasoning ||= Boolean(part.reasoning_content || part.reasoning || part.thinking);
                    if (typeof (part.content ?? c.text) === 'string') item.contentLength += (part.content ?? c.text).length;
                    if (typeof (part.content ?? c.text) === 'string') item.content = concatenate(item.content, part.content ?? c.text);
                    if (c.finish_reason != null) item.finish_reason = c.finish_reason;
                    for (const [position, call] of (part.tool_calls ?? []).slice(0, 16).entries()) {
                        const index = call.index ?? position;
                        if (!Number.isInteger(index) || index < 0 || index >= 16) { truncated = true; continue; }
                        const tool = item.tool_calls[index] ?? { function: { name: '', arguments: '' } };
                        if (call.id) tool.id = call.id;
                        if (call.function?.name) tool.function.name = concatenate(tool.function.name, call.function.name);
                        if (call.function?.arguments) tool.function.arguments = concatenate(tool.function.arguments, call.function.arguments);
                        item.tool_calls[index] = tool;
                    }
                    choices.set(key, item);
                }
            } else {
                if (chunks.length >= 8) { truncated = true; return; }
                chunks.push({ content: data.content, tool_calls: data.tool_calls, error: data.error, unparsed: data.unparsed });
            }
        }
        function capture(chunk, encoding) {
            if (!chunk) return;
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk;
            totalBytes += bytes.length;
            pending += decoder.write(bytes);
            if (/^(?:data:|event:|:)/.test(pending)) streaming = true;
            if (streaming) {
                let at;
                while ((at = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1);
                    if (line.startsWith('data:')) record(line.slice(5).trim());
                }
            }
            if (pending.length > LIMIT * 4) { pending = ''; truncated = true; }
        }
        const write = response.write, end = response.end;
        response.write = function (...args) { try { capture(args[0], args[1]); } catch { truncated = true; } return write.apply(this, args); };
        response.end = function (...args) { try { capture(args[0], args[1]); } catch { truncated = true; } return end.apply(this, args); };
        const startedAt = Date.now();
        function complete(aborted) {
            if (finished) return;
            finished = true;
            wireCaptures.delete(request);
            try {
                pending += decoder.end();
                if (pending.trim()) record(pending.replace(/^data:\s*/, '').trim());
                save('model-response', { status: response.statusCode, durationMs: Date.now() - startedAt, aborted, streaming, totalBytes, choices: [...choices.values()], chunks, usage }, truncated);
            } catch { /* A diagnostic must never affect generation. */ }
        }
        response.once('finish', () => complete(false));
        response.once('close', () => complete(true));
    } catch { /* Fail open: trace configuration cannot block generation. */ }
    return next();
}
