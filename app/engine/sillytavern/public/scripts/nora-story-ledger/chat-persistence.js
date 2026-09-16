/** One queue for native saves and authoritative edits. A rejected write must
 * not poison the queue; a queued job must check its chat identity when it runs. */
export function createChatWriteQueue(onBusy = () => {}) {
    let tail = Promise.resolve();
    let pending = 0;
    return function enqueue(operation) {
        pending++;
        onBusy(true);
        const result = tail.then(operation);
        tail = result.catch(() => {});
        return result.finally(() => { if (--pending === 0) onBusy(false); });
    };
}

/** Bound both the HTTP request and reading its response. Aborting a request
 * does not prove that the server did not commit it: retries still use CAS. */
export async function requestChatWrite(url, request, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...request, signal: controller.signal });
        return { ok: response.ok, status: response.status, statusText: response.statusText, data: await response.json() };
    } catch (cause) {
        throw Object.assign(new Error(controller.signal.aborted
            ? '聊天保存请求超时，尚未确认保存结果。请重试保存，不必重新生成正文。'
            : '聊天保存请求失败，尚未确认保存结果。请重试保存。', { cause }), {
            code: controller.signal.aborted ? 'NORA_CHAT_SAVE_TIMEOUT' : 'NORA_CHAT_SAVE_FAILED',
            phase: 'save',
        });
    } finally {
        clearTimeout(timer);
    }
}
