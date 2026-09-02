function runtimeContext() {
    return globalThis.SillyTavern?.getContext?.();
}

export async function reportMvuDiagnostic(diagnostic, {
    fetcher = globalThis.fetch,
    getContext = runtimeContext,
} = {}) {
    const current = getContext?.();
    if (!current || typeof fetcher !== 'function') return false;
    const response = await fetcher('/api/nora-mvu-diagnostics/report', {
        method: 'POST',
        headers: current.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
            ...diagnostic,
            chatId: String(current.chatId || current.getCurrentChatId?.() || ''),
        }),
    });
    if (!response.ok) throw new Error(`MVU diagnostic report failed with HTTP ${response.status}.`);
    return true;
}
