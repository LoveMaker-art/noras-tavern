import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
const STORY_SCOPE = 'story';
const SIDECAR_SUGGEST_SCOPE = 'sidecar:suggest-replies';

export function createStoryActionDispatcher({
    messages,
    hasWorld = () => true,
    getSessionKey = () => null,
    restoreDraft = () => {},
    onGenerationState = () => {},
    onGenerationError = () => {},
    onGenerationCompleted = () => {},
    onGenerationSettled = () => {},
    onMissingWorld = () => {},
    onTaskEvent = () => {},
    now = () => performance.now(),
    createActionId = (() => {
        let sequence = 0;
        return () => `nora-action-${Date.now()}-${++sequence}`;
    })(),
} = {}) {
    if (!messages) throw new Error('Story action dispatcher requires the story messages interface.');

    const active = new Map();
    let lastFailure = null;

    function status(scope = STORY_SCOPE) {
        if (lastFailure && lastFailure.sessionKey !== getSessionKey()) lastFailure = null;
        if (scope === 'all' || scope === 'visible') return Object.freeze({ active: [...active.values()].some(task => scope === 'all' || task.visible) });
        const task = active.get(String(scope));
        return Object.freeze({
            active: Boolean(task),
            type: task?.type || null,
            retryable: String(scope) === STORY_SCOPE && Boolean(lastFailure),
            persisted: String(scope) === STORY_SCOPE && lastFailure ? lastFailure.persisted : null,
        });
    }

    function commandScope(command) {
        if (command.type === 'sidecar.suggest-replies') return SIDECAR_SUGGEST_SCOPE;
        if (command.type === 'sidecar.run') return `sidecar:${String(command.key || command.actionId || 'default')}`;
        return STORY_SCOPE;
    }

    function isGenerationCommand(command) {
        return command.visible === true || ['story.send', 'story.regenerate', 'story.edit-and-regenerate', 'story.swipe', 'story.slash'].includes(command.type);
    }

    function notify(callback, value) {
        try { callback(value); } catch { /* Observers never change an action result. */ }
    }

    function runCommand(command, task) {
        if (task.controller.signal.aborted) throw Object.assign(new Error(tr("操作已取消。")), { name: 'AbortError' });
        if (task.sessionKey !== getSessionKey()) throw Object.assign(new Error(tr("世界已切换，请重新操作。")), { code: 'NORA_STALE_SESSION' });
        switch (command.type) {
            case 'story.slash': return messages.runSlash(String(command.text || ''), { signal: task.controller.signal });
            case 'story.send': return messages.sendText(String(command.text || '').trim(), { signal: task.controller.signal });
            case 'story.regenerate': return messages.regenerate({ signal: task.controller.signal });
            case 'story.edit-and-regenerate': return messages.editAndRegenerate(command.id, String(command.text ?? ''), { signal: task.controller.signal });
            case 'sidecar.suggest-replies': return messages.suggestReplies();
            case 'story.swipe': return messages.swipe(command.id, command.direction);
            case 'story.edit': return messages.editMessage(command.id, String(command.text ?? ''));
            case 'sidecar.run': {
                if (typeof command.run !== 'function') throw new TypeError('Sidecar actions require a run function.');
                if (task.controller.signal.aborted) throw Object.assign(new Error('Sidecar action cancelled before dispatch.'), { name: 'AbortError' });
                return command.run({ actionId: task.actionId, signal: task.controller.signal });
            }
            default: {
                const error = new Error(`Unsupported story action: ${String(command.type || 'unknown')}`);
                error.code = 'NORA_UNSUPPORTED_STORY_ACTION';
                throw error;
            }
        }
    }

    function execute(command = {}) {
        if (lastFailure && lastFailure.sessionKey !== getSessionKey()) lastFailure = null;
        if (command.type === 'story.retry') {
            if (!lastFailure) {
                return Promise.resolve(Object.freeze({ status: 'ignored', type: command.type, scope: STORY_SCOPE }));
            }
            command = lastFailure.persisted
                ? { type: 'story.regenerate' }
                : { ...lastFailure.command };
        }
        const scope = commandScope(command);
        const actionId = String(command.actionId || createActionId());
        if (!hasWorld()) {
            notify(onMissingWorld);
            const blocked = Object.freeze({ status: 'blocked', type: command.type, scope, actionId, reason: 'no-world' });
            notify(onTaskEvent, Object.freeze({ ...blocked, phase: 'blocked' }));
            return Promise.resolve(blocked);
        }

        if (command.type === 'story.send' && !String(command.text || '').trim()) {
            return Promise.resolve(Object.freeze({ status: 'ignored', type: command.type, scope, actionId }));
        }
        if (active.has(scope)) {
            const existing = active.get(scope);
            if (command.actionId && existing.actionId === command.actionId && existing.commandKey === JSON.stringify([command.type, command.text, command.id, command.direction])) return existing.promise;
            const error = Object.assign(new Error(tr("当前操作尚未结束，请等待完成或先停止。")), { code: 'NORA_ACTION_BUSY' });
            try { onGenerationError(error, { scope, actionId, type: command.type }); } catch { /* Observers cannot change routing. */ }
            return Promise.resolve(Object.freeze({ status: 'blocked', type: command.type, scope, actionId, error, reason: 'busy' }));
        }

        const startedAt = now();
        const generation = isGenerationCommand(command);
        const task = {
            actionId,
            sessionKey: getSessionKey(),
            commandKey: JSON.stringify([command.type, command.text, command.id, command.direction]),
            visible: generation,
            type: command.type,
            promise: null,
            controller: new AbortController(),
            cancelled: false,
            cancel: typeof command.cancel === 'function' ? command.cancel : null,
        };
        if (generation) notify(onGenerationState, true);
        notify(onTaskEvent, Object.freeze({ phase: 'started', actionId, type: command.type, scope }));
        task.promise = Promise.resolve()
            .then(() => runCommand(command, task))
            .then((value) => {
                if (task.cancelled || task.controller.signal.aborted) throw Object.assign(new Error(tr("操作已取消。")), { name: 'AbortError' });
                if (task.sessionKey !== getSessionKey()) throw Object.assign(new Error(tr("世界已切换，本次操作已过期。")), { code: 'NORA_STALE_SESSION' });
                if (scope === STORY_SCOPE && command.type !== 'story.edit') lastFailure = null;
                const result = Object.freeze({ status: 'completed', type: command.type, scope, actionId, value });
                if (command.type === 'story.send') notify(onGenerationCompleted);
                notify(onTaskEvent, Object.freeze({ ...result, phase: 'completed' }));
                return result;
            })
            .catch((error) => {
                if (task.cancelled || task.controller.signal.aborted || error?.name === 'AbortError') {
                    const result = Object.freeze({ status: 'cancelled', type: command.type, scope, actionId, error });
                    notify(onTaskEvent, Object.freeze({ ...result, phase: 'cancelled' }));
                    return result;
                }
                const persisted = command.type === 'story.regenerate'
                    || command.type === 'story.edit-and-regenerate'
                    || Boolean(error?.noraMessagePersisted);
                if (task.sessionKey === getSessionKey() && scope === STORY_SCOPE && !['story.edit', 'story.swipe', 'story.slash'].includes(command.type)) {
                    lastFailure = Object.freeze({ command: Object.freeze({ ...command }), persisted, sessionKey: task.sessionKey });
                    if (command.type === 'story.send' && !persisted) restoreDraft(String(command.text || ''));
                }
                const result = Object.freeze({ status: 'failed', type: command.type, scope, actionId, error, persisted });
                try { onGenerationError(error, { persisted, type: command.type, scope, actionId }); } catch { /* UI errors never change task results. */ }
                notify(onTaskEvent, Object.freeze({ ...result, phase: 'failed' }));
                return result;
            })
            .finally(() => {
                if (active.get(scope) === task) active.delete(scope);
                if (generation) notify(onGenerationState, status('visible').active);
            });
        task.promise = task.promise.then((result) => {
            notify(onGenerationSettled, Object.freeze({
                actionId,
                type: command.type,
                scope,
                status: result.status,
                persisted: result.persisted,
                duration: Math.max(0, now() - startedAt),
            }));
            return result;
        });
        active.set(scope, task);
        return task.promise;
    }

    function cancel(scope = STORY_SCOPE) {
        if (scope === 'visible') {
            return Promise.all([...active].filter(([, task]) => task.visible).map(([key]) => cancel(key)))
                .then(() => messages.isGenerating?.() ? messages.stop?.() : undefined);
        }
        const key = String(scope || STORY_SCOPE);
        if (key !== STORY_SCOPE) {
            const task = active.get(key);
            if (!task) return Promise.resolve(Object.freeze({ status: 'ignored', scope: key }));
            task.cancelled = true;
            task.controller.abort();
            try { task.cancel?.(task.actionId); } catch { /* The running task still observes its abort signal. */ }
            notify(onTaskEvent, Object.freeze({ phase: 'cancelling', actionId: task.actionId, type: task.type, scope: key }));
            return Promise.resolve(Object.freeze({ status: 'cancelling', scope: key, actionId: task.actionId }));
        }
        if (!active.has(STORY_SCOPE) && !messages.isGenerating?.()) {
            return Promise.resolve(Object.freeze({ status: 'ignored', scope: key }));
        }
        const task = active.get(STORY_SCOPE);
        if (task) {
            task.cancelled = true;
            task.controller.abort();
            notify(onTaskEvent, Object.freeze({
                phase: 'cancelling',
                actionId: task.actionId,
                type: task.type,
                scope: STORY_SCOPE,
            }));
        }
        return Promise.resolve(messages.stop?.())
            .then(() => Object.freeze({ status: 'stopping', scope: STORY_SCOPE }));
    }

    return Object.freeze({ execute, cancel, status });
}
