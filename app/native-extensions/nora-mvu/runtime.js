export const MVU_SCRIPT_ID = 'nora-mvu-headless-runtime';
export const MVU_UPSTREAM_COMMIT = '0a730cd4a9b99689d1135a49b542c780b977c24c';
export const NORA_MVU_SETTINGS_VERSION = 1;
export const NORA_MVU_MODEL_PROXY_URL = 'https://nora-mvu.invalid/v1';

const MVU_ENTRY_MARKER = /\[(?:initvar|mvu_update|mvu_plot)\]/i;

const BUNDLE_URL = `/scripts/extensions/third-party/nora-mvu/vendor/bundle.js?v=${MVU_UPSTREAM_COMMIT.slice(0, 12)}`;

const HEADLESS_DEFAULTS = Object.freeze({
    '通知': {
        'MVU框架加载成功': false,
        '变量初始化成功': false,
        '变量更新出错': false,
        '额外模型解析中': false,
    },
    '更新方式': '额外模型解析',
    '额外模型解析配置': {
        '破限方案': '使用内置破限',
        '其他预设名称': '',
        '应答格式': '聊天消息',
        '关闭thinking': false,
        '兼容假流式': false,
        '随机头部': true,
        '启用自动请求': true,
        '请求方式': '依次请求，失败后重试',
        '请求次数': 3,
        '世界书条目白名单正则': '',
        '世界书条目黑名单正则': '',
        '模型来源': '与插头相同',
        'api地址': '',
        '密钥': '',
        '模型名称': '',
        '温度': 1,
        '频率惩罚': 0,
        '存在惩罚': 0,
        'top_p': 1,
        'top_k': 0,
        'max_chat_history': 2,
        '最大回复token数': 4096,
        'api方案列表': [],
        '当前api方案': '',
    },
    '自动清理变量': {
        '启用': true,
        '快照保留间隔': 50,
        '要保留变量的最近楼层数': 20,
        '触发恢复变量的最近楼层数': 10,
    },
    '兼容性': {
        '更新到聊天变量': false,
        '显示老旧功能': false,
        'sendas不视为user消息': false,
    },
});

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasMvuDeclaration(entries = []) {
    return Array.isArray(entries) && entries.some(entry => MVU_ENTRY_MARKER.test(String(entry?.comment || '')));
}

export function hasInitializedMvuData(value) {
    return isRecord(value) && isRecord(value.stat_data) && value.schema !== undefined;
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function mergeDefaults(defaults, current) {
    if (!isRecord(defaults) || !isRecord(current)) {
        return current === undefined ? clone(defaults) : clone(current);
    }
    const result = {};
    for (const key of new Set([...Object.keys(defaults), ...Object.keys(current)])) {
        result[key] = mergeDefaults(defaults[key], current[key]);
    }
    return result;
}

function mergePatch(current, patch) {
    if (!isRecord(current) || !isRecord(patch)) return clone(patch);
    const result = clone(current);
    for (const [key, value] of Object.entries(patch)) {
        result[key] = isRecord(value) && isRecord(result[key])
            ? mergePatch(result[key], value)
            : clone(value);
    }
    return result;
}

export function createHeadlessMvuSettings(current = {}) {
    return mergeDefaults(HEADLESS_DEFAULTS, current);
}

export function updateHeadlessMvuSettings(current, patch) {
    return createHeadlessMvuSettings(mergePatch(current ?? {}, patch ?? {}));
}

export function isMvuVariableModelEnabled(settings = {}) {
    return settings['更新方式'] === '额外模型解析'
        && settings['额外模型解析配置']?.['启用自动请求'] !== false;
}

export function setMvuVariableModelEnabled(context, enabled) {
    const automaticRequests = Boolean(enabled);
    return applyMvuSettings(context, {
        '更新方式': automaticRequests ? '额外模型解析' : '随AI输出',
        '额外模型解析配置': { '启用自动请求': automaticRequests },
    });
}

function managedScript(enabled = true) {
    return {
        type: 'script',
        enabled,
        name: 'Nora MVU Runtime',
        id: MVU_SCRIPT_ID,
        content: `await import('${BUNDLE_URL}');`,
        info: `Headless MagVarUpdate runtime pinned to ${MVU_UPSTREAM_COMMIT}.`,
        button: { enabled: false, buttons: [] },
        data: {},
        export_with: { data: false, button: false },
    };
}

function sameManagedScript(current, expected) {
    return current.enabled === expected.enabled
        && current.name === expected.name
        && current.content === expected.content
        && current.info === expected.info
        && current.button?.enabled === false;
}

function reconcileManagedScript(scripts, enabled = true) {
    const expected = managedScript(enabled);
    const index = scripts.findIndex(script => script?.id === MVU_SCRIPT_ID);
    if (index === -1) return { registration: 'installed', scripts: [...scripts, expected] };
    if (sameManagedScript(scripts[index], expected)) return { registration: 'unchanged', scripts };

    const next = [...scripts];
    next[index] = expected;
    return { registration: 'updated', scripts: next };
}

export function ensureHeadlessMvuScriptInSettings(context) {
    if (!context?.extensionSettings) throw new Error('ST extension settings are unavailable.');
    const helperSettings = context.extensionSettings.tavern_helper ??= {};
    const scriptSettings = helperSettings.script ??= {};
    const scripts = Array.isArray(scriptSettings.scripts) ? scriptSettings.scripts : [];
    const enabled = context.extensionSettings.nora_mvu?.managedRuntimeEnabled !== false;
    const result = reconcileManagedScript(scripts, enabled);
    scriptSettings.scripts = result.scripts;
    scriptSettings.enabled ??= { global: true, presets: [], characters: [] };
    if (enabled) scriptSettings.enabled.global = true;
    return result.registration;
}

export function ensureHeadlessMvuScript(helper) {
    if (typeof helper?.getScriptTrees !== 'function' || typeof helper?.replaceScriptTrees !== 'function') {
        throw new TypeError('TavernHelper script API is unavailable.');
    }

    const option = { type: 'global' };
    const result = reconcileManagedScript(helper.getScriptTrees(option));
    if (result.registration !== 'unchanged') helper.replaceScriptTrees(result.scripts, option);
    return result.registration;
}

export async function waitForTavernHelper({
    read = () => globalThis.TavernHelper,
    timeoutMs = 3000,
    intervalMs = 25,
} = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const helper = read();
        if (typeof helper?.getScriptTrees === 'function' && typeof helper?.replaceScriptTrees === 'function') {
            return helper;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('TavernHelper did not expose its script API in time.');
}

export async function waitForMvuRuntime({
    read = () => globalThis.Mvu,
    timeoutMs = 5000,
    intervalMs = 25,
} = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const runtime = read();
        if (typeof runtime?.getMvuData === 'function') {
            return runtime;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('MVU variable runtime did not initialize in time.');
}

export function createRetryableMvuLoader(load) {
    if (typeof load !== 'function') throw new TypeError('MVU runtime loader is required.');
    let pending = null;
    let ready = null;
    return async function ensureReady() {
        if (ready) return ready;
        pending ??= Promise.resolve()
            .then(load)
            .then((runtime) => {
                ready = runtime;
                return runtime;
            })
            .catch((error) => {
                pending = null;
                throw error;
            });
        return pending;
    };
}

export function applyMvuSettings(context, patch = null, { save = true, reloadRuntime = true } = {}) {
    if (!context?.extensionSettings) throw new Error('ST extension settings are unavailable.');
    const current = context.extensionSettings.mvu_settings ?? {};
    const next = patch === null
        ? createHeadlessMvuSettings(current)
        : updateHeadlessMvuSettings(current, patch);
    context.extensionSettings.mvu_settings = next;
    if (reloadRuntime) globalThis.Mvu?.reloadSettings?.();
    if (save) context.saveSettingsDebounced?.();
    return clone(next);
}

export function initializeHeadlessMvuSettings(context) {
    if (!context?.extensionSettings) throw new Error('ST extension settings are unavailable.');
    const marker = context.extensionSettings.nora_mvu ?? {};
    const isFirstHeadlessActivation = marker.settingsVersion !== NORA_MVU_SETTINGS_VERSION;
    const patch = isFirstHeadlessActivation ? {
        '更新方式': '额外模型解析',
        '通知': clone(HEADLESS_DEFAULTS['通知']),
        '额外模型解析配置': {
            '破限方案': '使用内置破限',
            '应答格式': '聊天消息',
            '启用自动请求': true,
            '模型来源': '与插头相同',
        },
    } : null;
    const settings = applyMvuSettings(context, patch, { save: false });
    context.extensionSettings.nora_mvu = {
        ...marker,
        settingsVersion: NORA_MVU_SETTINGS_VERSION,
        upstreamCommit: MVU_UPSTREAM_COMMIT,
    };
    context.saveSettingsDebounced?.();
    return settings;
}
