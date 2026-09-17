import { createMvuSettingsControls, isMvuVariableModelEnabled } from '../nora-compat/mvu-settings.js';
export { NORA_MVU_MODEL_PROXY_URL } from '../nora-compat/mvu-settings.js';

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
        if (!isRecord(value) || !isRecord(value.stat_data)) return false;
        return Object.keys(value.stat_data).length > 0 || value.schema !== undefined;
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
                enabled: isMvuVariableModelEnabled(settings),
                variableModel: model['模型来源'] ?? null,
                variableModelName: model['模型名称'] ?? null,
            });
        },
        ...createMvuSettingsControls(apply),
    });
}
