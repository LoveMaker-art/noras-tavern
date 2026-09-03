export const NORA_MVU_MODEL_PROXY_URL = 'https://nora-mvu.invalid/v1';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
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

function hasInitializedData(runtime) {
    try {
        const value = runtime?.getMvuData?.({ type: 'message', message_id: 'latest' });
        return isRecord(value) && isRecord(value.stat_data) && value.schema !== undefined;
    } catch {
        return false;
    }
}

export function createStMvuSettingsAdapter(runtime, {
    readMvuRuntime = () => globalThis.Mvu,
} = {}) {
    function requireMvuRuntime() {
        const value = readMvuRuntime();
        if (typeof value?.getMvuData !== 'function') throw new Error('MVU variable runtime is not ready.');
        return value;
    }

    function currentSettings() {
        const current = runtime();
        current.extensionSettings ??= {};
        return current.extensionSettings.mvu_settings ?? {};
    }

    function apply(patch) {
        const mvuRuntime = requireMvuRuntime();
        const current = runtime();
        current.extensionSettings ??= {};
        const next = mergePatch(current.extensionSettings.mvu_settings ?? {}, patch);
        current.extensionSettings.mvu_settings = next;
        mvuRuntime.reloadSettings?.();
        current.saveSettingsDebounced?.();
        return clone(next);
    }

    return Object.freeze({
        status() {
            const mvuRuntime = readMvuRuntime();
            const settings = currentSettings();
            const model = settings['额外模型解析配置'] ?? {};
            const runtimeAvailable = typeof mvuRuntime?.getMvuData === 'function';
            return Object.freeze({
                phase: runtimeAvailable ? 'ready' : 'unavailable',
                runtimeAvailable,
                initialized: hasInitializedData(mvuRuntime),
                enabled: settings['更新方式'] === '额外模型解析' && model['启用自动请求'] !== false,
                variableModel: model['模型来源'] ?? null,
                variableModelName: model['模型名称'] ?? null,
            });
        },
        setEnabled(enabled) {
            const automaticRequests = Boolean(enabled);
            return apply({
                '更新方式': automaticRequests ? '额外模型解析' : '随AI输出',
                '额外模型解析配置': { '启用自动请求': automaticRequests },
            });
        },
        useStoryModel() {
            return apply({
                '更新方式': '额外模型解析',
                '额外模型解析配置': { '模型来源': '与插头相同' },
            });
        },
        useIndependentModel({ model, contextLimit = 64000, maxTokens = 20000 }) {
            return apply({
                '更新方式': '额外模型解析',
                '额外模型解析配置': {
                    '模型来源': '自定义',
                    'api地址': NORA_MVU_MODEL_PROXY_URL,
                    '密钥': '',
                    '模型名称': String(model || '').trim(),
                    '最大上下文token数': Math.min(1000000, Math.max(512, Number(contextLimit) || 64000)),
                    '最大回复token数': Math.min(128000, Math.max(1, Number(maxTokens) || 20000)),
                },
            });
        },
    });
}
