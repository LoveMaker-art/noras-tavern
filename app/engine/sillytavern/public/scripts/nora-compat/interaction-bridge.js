const KEY = Symbol.for('nora.interaction-bridge.v1');
const MARKER = Symbol.for('nora.helper-facade.v1');
const ASYNC = new Set(['generate', 'generateRaw', 'triggerSlash', 'triggerSlashWithResult',
    'setChatMessages', 'setChatMessage', 'createChatMessages', 'deleteChatMessages', 'rotateChatMessages']);
const STOP = new Set(['stopGenerationById', 'stopAllGeneration']);

export function createInteractionBridge() {
    let helper = null;
    let executor = null;
    let guard = null;
    const waiters = new Set();
    function wake() { for (const check of [...waiters]) check(); }
    function waitFor(read, timeoutMs = 15000) {
        if (read()) return Promise.resolve(read());
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiters.delete(check);
                reject(Object.assign(new Error('角色卡接口尚未就绪，请重试。'), { code: 'NORA_HELPER_NOT_READY' }));
            }, timeoutMs);
            const check = () => {
                const value = read();
                if (!value) return;
                clearTimeout(timer); waiters.delete(check); resolve(value);
            };
            waiters.add(check); check();
        });
    }
    function publish(candidate) {
        if (!candidate || typeof candidate.generate !== 'function' || typeof candidate.generateRaw !== 'function') return null;
        if (candidate[MARKER]) { helper = candidate; wake(); return helper; }
        const wrappers = new Map();
        helper = new Proxy(candidate, {
            get(target, key, receiver) {
                if (key === MARKER) return true;
                if (!ASYNC.has(key) && !STOP.has(key)) return Reflect.get(target, key, receiver);
                if (typeof target[key] !== 'function') return undefined;
                if (!wrappers.has(key)) {
                    const native = (...args) => Reflect.apply(target[key], target, args);
                    const stop = id => target.stopGenerationById?.(id);
                    wrappers.set(key, STOP.has(key)
                        ? (...args) => executor ? executor(key, args, native, stop) : native(...args)
                        : async (...args) => (await waitFor(() => executor))(key, args, native, stop));
                }
                return wrappers.get(key);
            },
        });
        wake(); return helper;
    }
    function install(next, sessionGuard = () => {}) {
        if (executor && executor !== next) throw new Error('Interaction executor already installed');
        executor = next; guard = sessionGuard; wake();
        return () => { if (executor === next) { executor = null; guard = null; } };
    }
    return Object.freeze({ publish, install, ready: () => waitFor(() => helper && executor && helper), assertSessionIdle: () => guard?.() });
}
// The shell is bundled; Helper is independently imported. Both must use the same registry.
export const interactionBridge = globalThis[KEY] ??= createInteractionBridge();
export const publishTavernHelper = candidate => interactionBridge.publish(candidate);
