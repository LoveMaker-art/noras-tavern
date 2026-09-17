// Short-lived troubleshooting for one chat. Never awaited by MVU.
export function createMvuTraceClient({ getContext, fetcher = globalThis.fetch, now = Date.now, uuid = () => globalThis.crypto?.randomUUID?.() ?? `trace-${Date.now()}-${Math.random().toString(36).slice(2)}` }) {
    let config = { enabled: false }, count = 0, sequence = 0, started = false, activeRequest = null;
    const pageId = uuid();
    const enabled = () => {
        const c = getContext();
        const chatId = String(c.chatId || c.getCurrentChatId?.() || '');
        return config.enabled && now() < config.expiresAt && (!config.chatId || config.chatId === chatId);
    };
    const record = (stage, detail = {}, requestId = '') => {
        try {
            if (!enabled() || count >= 120) return;
            count++;
            const c = getContext();
            if (activeRequest && activeRequest.chatId !== String(c.chatId || c.getCurrentChatId?.() || '')) return;
            const body = JSON.stringify({ stage, detail: { pageId, sequence: ++sequence, ...detail }, requestId: requestId || activeRequest?.requestId || '',
                chatId: String(c.chatId || c.getCurrentChatId?.() || ''), occurredAt: now() }, (key, value) => {
                if (/authorization|api.?key|secret|password|token|cookie|reasoning|thinking/i.test(key)) return undefined;
                if (typeof value !== 'string') return value;
                const safe = value.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
                    .replace(/\b(?:sk|fc)-[\w-]{12,}/g, '[redacted-key]');
                return safe.length > 128000 ? `${safe.slice(0, 64000)}\n[truncated]\n${safe.slice(-64000)}` : safe;
            });
            void fetcher('/api/nora-mvu-diagnostics/trace', {
                method: 'POST', headers: c.getRequestHeaders(), body, cache: 'no-store',
                signal: AbortSignal.timeout(5000),
            }).catch(() => {});
        } catch { /* Diagnostics cannot interrupt play. */ }
    };
    const beforeRequest = data => {
        try {
            if (!enabled() || !activeRequest) return;
            const c = getContext();
            const chatId = String(c.chatId || c.getCurrentChatId?.() || '');
            if (chatId !== activeRequest.chatId) return;
            data.nora_mvu_trace = { ...activeRequest };
        } catch { /* Backend removes this private marker before forwarding. */ }
    };
    return {
        enabled, record,
        beginRequest(protocol, requestId) {
            try {
                if (!enabled() || !['legacy', 'nora-mvu/1'].includes(protocol)) return () => {};
                const c = getContext();
                const request = { kind: 'mvu-variable', protocol, requestId: requestId || uuid(), chatId: String(c.chatId || c.getCurrentChatId?.() || '') };
                activeRequest = request;
                return () => { if (activeRequest === request) activeRequest = null; };
            } catch { return () => {}; }
        },
        endRequest(requestId) { if (activeRequest?.requestId === requestId) activeRequest = null; },
        recordScript(stage, frameName, detail = {}) {
            try {
                if (!enabled() || !String(frameName).startsWith('TH-script--')) return;
                const c = getContext();
                const card = c.characters?.[c.characterId];
                const tree = card?.data?.extensions?.tavern_helper?.scripts ?? card?.extensions?.tavern_helper?.scripts ?? [];
                const scripts = tree.flatMap(s => s.type === 'folder' ? (s.scripts ?? []) : [s]);
                const script = scripts.find(s => String(frameName).endsWith(`--${s.id}`));
                if (!script || !/registerMvuSchema\s*\(|mvu[_-]zod\.js/.test(script.content || '')) return;
                record(stage, { scriptId: script.id, scriptName: script.name, ...detail });
            } catch { /* Only selected-card schema scripts are eligible. */ }
        },
        async start() {
            if (started) return;
            started = true;
            try {
                const c = getContext();
                const response = await fetcher('/api/nora-mvu-diagnostics/trace-config', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                if (!response.ok) return;
                config = await response.json();
                if (!config.enabled) return;
                c.eventSource.on(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY, beforeRequest);
                record('trace-ready', { expiresAt: config.expiresAt });
            } catch { /* Disabled if configuration cannot be read. */ }
        },
        wrapProtocol(protocol) {
            return Object.freeze({ ...protocol, readNoraResponse(result, format) {
                record('parser-input', { format, result });
                try {
                    const parsed = protocol.readNoraResponse(result, format);
                    record('parser-accepted', { format });
                    return parsed;
                } catch (error) {
                    record('parser-rejected', { format, code: error?.code, message: String(error?.message || error) });
                    throw error;
                }
            } });
        },
    };
}
