export const MVU_SCRIPT_ID = 'nora-mvu-headless-runtime';
export const MVU_UPSTREAM_COMMIT = '7fe9ae7cfe01f13d606f7a2e533a458431fe318c';
export const NORA_MVU_SETTINGS_VERSION = 5;
export const NORA_MVU_BUNDLE_REVISION = 10;
export const NORA_MVU_MODEL_PROXY_URL = 'https://nora-mvu.invalid/v1';

const MVU_ENTRY_MARKER = /\[(?:initvar|mvu_update|mvu_plot)\]/i;

export const MVU_BUNDLE_URL = `/scripts/extensions/third-party/nora-mvu/vendor/bundle.js?v=${MVU_UPSTREAM_COMMIT.slice(0, 12)}-nora${NORA_MVU_BUNDLE_REVISION}`;
export const MVU_ZOD_PATH = './vendor/zod.iife.js?v=4.1.11';
export const MVU_IMPORT_ERROR_KEY = '__NORA_MVU_IMPORT_ERROR__';
export const MVU_LOADER_VERSION = 2;

export function resolveMvuZodUrl(moduleUrl = import.meta.url) {
    return new URL(MVU_ZOD_PATH, moduleUrl).href;
}

const dependencyPromises = new Map();
function loadClassicDependency({ name, url, read, afterLoad = () => {} }, documentRef) {
    const current = read();
    if (current) return Promise.resolve(current);
    if (dependencyPromises.has(name)) return dependencyPromises.get(name);
    if (!documentRef?.createElement || !documentRef?.head?.append) {
        return Promise.reject(new Error(`MVU ${name} dependency cannot be loaded without a document.`));
    }

    const pending = new Promise((resolve, reject) => {
        const script = documentRef.createElement('script');
        script.src = url;
        script.async = true;
        script.dataset.noraMvuDependency = name;
        script.addEventListener('load', () => {
            afterLoad();
            const runtime = read();
            if (runtime) resolve(runtime);
            else reject(new Error(`MVU ${name} dependency loaded without exposing its runtime.`));
        }, { once: true });
        script.addEventListener('error', () => {
            reject(new Error(`MVU ${name} dependency failed to load: ${url}`));
        }, { once: true });
        documentRef.head.append(script);
    }).catch((error) => {
        dependencyPromises.delete(name);
        throw error;
    });
    dependencyPromises.set(name, pending);
    return pending;
}

export function ensureMvuZodRuntime({
    read = () => globalThis.z,
    readUmd = () => globalThis.Zod,
    publish = runtime => { globalThis.z = runtime; },
    documentRef = globalThis.document,
    url = resolveMvuZodUrl(),
} = {}) {
    return loadClassicDependency({
        name: 'Zod',
        url,
        read,
        afterLoad: () => {
            if (!read()) publish(readUmd());
        },
    }, documentRef);
}

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
        '请求次数': 1,
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
        '最大上下文token数': 64000,
        '最大回复token数': 20000,
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
    if (!isRecord(value) || !isRecord(value.stat_data)) return false;
    return Object.keys(value.stat_data).length > 0 || value.schema !== undefined;
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
        content: `
window.parent.${MVU_IMPORT_ERROR_KEY} = null;
try {
    const mvuBundleUrl = new URL('${MVU_BUNDLE_URL}', window.parent.location.href).href;
    await import(mvuBundleUrl);
} catch (error) {
    window.parent.${MVU_IMPORT_ERROR_KEY} = {
        loaderVersion: ${MVU_LOADER_VERSION},
        name: String(error?.name || ''),
        message: String(error?.message || error),
        stack: String(error?.stack || ''),
    };
    throw error;
}`.trim(),
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

export async function ensureHeadlessMvuScript(helper, enabled = true) {
    if (typeof helper?.getScriptTrees !== 'function' || typeof helper?.replaceScriptTrees !== 'function') {
        throw new TypeError('TavernHelper script API is unavailable.');
    }

    const option = { type: 'global' };
    const scripts = helper.getScriptTrees(option);
    const result = reconcileManagedScript(Array.isArray(scripts) ? scripts : [], enabled);
    if (result.registration !== 'unchanged') await helper.replaceScriptTrees(result.scripts, option);
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
    readImportError = () => globalThis[MVU_IMPORT_ERROR_KEY],
    timeoutMs = 5000,
    intervalMs = 25,
} = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const runtime = read();
        if (typeof runtime?.getMvuData === 'function') {
            return runtime;
        }
        const importError = readImportError();
        if (importError?.message && importError.loaderVersion === MVU_LOADER_VERSION) {
            const error = new Error(`MVU bundle import failed: ${importError.message}`);
            error.name = importError.name || error.name;
            if (importError.stack) error.stack += `\nCaused by:\n${importError.stack}`;
            throw error;
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

export function createManagedMvuRuntimeLoader({
    waitForHelper = waitForTavernHelper,
    ensureScript = ensureHeadlessMvuScript,
    waitForRuntime = waitForMvuRuntime,
    onRegistration = () => {},
    timeoutMs = 15000,
} = {}) {
    return createRetryableMvuLoader(async () => {
        const helper = await waitForHelper({ timeoutMs });
        onRegistration(await ensureScript(helper));
        return waitForRuntime({ timeoutMs });
    });
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
    const previousVersion = Number(marker.settingsVersion) || 0;
    const currentContextLimit = context.extensionSettings.mvu_settings?.['额外模型解析配置']?.['最大上下文token数'];
    const currentTokenLimit = context.extensionSettings.mvu_settings?.['额外模型解析配置']?.['最大回复token数'];
    const patch = previousVersion === 0 ? {
        '更新方式': '额外模型解析',
        '通知': clone(HEADLESS_DEFAULTS['通知']),
        '额外模型解析配置': {
            '破限方案': '使用内置破限',
            '应答格式': '聊天消息',
            '启用自动请求': true,
            '模型来源': '与插头相同',
            '请求方式': '依次请求，失败后重试',
            '请求次数': 1,
            '最大上下文token数': 64000,
            '最大回复token数': 20000,
        },
    } : previousVersion < 5 ? {
        '额外模型解析配置': {
            ...(currentContextLimit === undefined || currentContextLimit === 128000
                ? { '最大上下文token数': 64000 }
                : {}),
            ...(currentTokenLimit === undefined || currentTokenLimit === 4096 ? { '最大回复token数': 20000 } : {}),
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
