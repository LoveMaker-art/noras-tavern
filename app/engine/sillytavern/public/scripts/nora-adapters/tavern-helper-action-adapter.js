import { interactionBridge } from '../nora-compat/interaction-bridge.js';
export const NORA_TAVERN_HELPER_READY_HOOK = '__NORA_TAVERN_HELPER_READY__';

export function createTavernHelperActionAdapter({ storyActions, messages = {}, globalRef = globalThis,
    bridge = interactionBridge, createGenerationId = () => 'nora-helper-' + crypto.randomUUID() } = {}) {
    if (!storyActions?.execute || !storyActions?.cancel || !storyActions?.status) throw new Error('Helper requires story action dispatcher');
    let release = null;
    const tracked = new Set();
    const unwrap = async promise => {
        const result = await promise;
        if (result.status === 'completed') return result.value;
        if (result.status === 'cancelled') throw Object.assign(new Error('生成已取消。'), { name: 'AbortError' });
        throw result.error || new Error('角色卡操作未执行：' + result.status);
    };
    function invoke(method, args, native, nativeStop) {
        if (method === 'stopGenerationById') {
            const id = String(args[0] || '');
            if (!tracked.has(id)) return native(...args);
            void storyActions.cancel('sidecar:' + id); return true;
        }
        if (method === 'stopAllGeneration') {
            for (const id of tracked) void storyActions.cancel('sidecar:' + id);
            return native(...args);
        }
        if (method === 'triggerSlash' || method === 'triggerSlashWithResult') {
            if (!messages.runSlash) return native(...args);
            return unwrap(storyActions.execute({ type: 'sidecar.run', key: createGenerationId(), origin: 'helper.' + method,
                run: ({ signal }) => messages.runSlash(String(args[0] || ''), { signal }),
            }));
        }
        const generation = method === 'generate' || method === 'generateRaw';
        const options = args[0] || {};
        const id = generation ? String(options.generation_id || createGenerationId()) : createGenerationId();
        if (tracked.has(id)) throw new Error('生成 ID 已在使用：' + id);
        tracked.add(id);
        const request = generation ? [{ ...options, generation_id: id }] : args;
        return unwrap(storyActions.execute({
            type: 'sidecar.run', key: id, actionId: id, origin: 'helper.' + method,
            visible: generation && options.bindToStopButton !== false,
            run: async ({ signal }) => {
                await messages.prepareMutation?.();
                if (signal.aborted) throw Object.assign(new Error('操作已取消。'), { name: 'AbortError' });
                return native(...request);
            },
            cancel: generation ? () => nativeStop(id) : undefined,
        })).finally(() => tracked.delete(id));
    }
    function attach(candidate = globalRef.TavernHelper) {
        if (!candidate) return false;
        const facade = bridge.publish(candidate);
        if (!facade) return false;
        globalRef.TavernHelper = facade; return true;
    }
    async function ready() { attach(); await bridge.ready(); return true; }
    function start() {
        if (release) return;
        release = bridge.install(invoke, () => {
            if (storyActions.status('all').active || messages.isGenerating?.()) {
                throw Object.assign(new Error('当前操作尚未结束，请先停止或等待完成再切换世界。'), { code: 'NORA_SESSION_BUSY' });
            }
        });
        globalRef[NORA_TAVERN_HELPER_READY_HOOK] = ready; attach();
    }
    function stop() {
        release?.(); release = null;
        if (globalRef[NORA_TAVERN_HELPER_READY_HOOK] === ready) delete globalRef[NORA_TAVERN_HELPER_READY_HOOK];
    }
    return Object.freeze({ start, stop, attach });
}
