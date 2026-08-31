import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
const EMPTY_STATUS = Object.freeze({
    phase: 'unavailable',
    supported: false,
    initialized: false,
    enabled: false,
    declarationChecked: false,
    variableModel: null,
    variableModelName: null,
});

async function readJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || body.error || `MVU model request failed (${response.status}).`);
    return body;
}

export function createMvuModelAdapter({
    readApi = () => globalThis.NoraMvu,
    controlApi = null,
    requestHeaders = () => ({ 'Content-Type': 'application/json' }),
    fetcher = (...args) => fetch(...args),
} = {}) {
    function project(liveStatus, worldCapabilities = null) {
        const declared = Array.isArray(worldCapabilities?.declared)
            && worldCapabilities.declared.includes('mvu');
        const capability = worldCapabilities?.items?.mvu || null;
        const runtimeReady = Boolean(
            capability?.evidence?.runtime_ready
            ?? capability?.evidence?.api_visible
            ?? liveStatus?.runtimeAvailable,
        );
        return {
            ...liveStatus,
            phase: capability?.status === 'DEGRADED' ? 'failed' : liveStatus?.phase,
            declared: declared || Boolean(liveStatus?.declared),
            declarationChecked: Boolean(worldCapabilities) || Boolean(liveStatus?.declarationChecked),
            supported: declared || Boolean(liveStatus?.supported) || Boolean(liveStatus?.initialized),
            runtimeReady,
            capabilityStatus: capability?.status || null,
            capabilityError: capability?.error || null,
        };
    }

    function status(worldCapabilities = null) {
        let liveStatus;
        try {
            liveStatus = readApi()?.status?.() ?? controlApi?.status?.() ?? EMPTY_STATUS;
        } catch {
            liveStatus = EMPTY_STATUS;
        }
        return project(liveStatus, worldCapabilities);
    }

    async function inspect(worldCapabilities = null) {
        const api = readApi();
        if (worldCapabilities) return status(worldCapabilities);
        if (typeof api?.inspectCurrentCard !== 'function') return status();
        try {
            return project(await api.inspectCurrentCard());
        } catch {
            return status();
        }
    }

    async function request(path, body = {}) {
        const response = await fetcher(`/api/nora-mvu-model/${path}`, {
            method: 'POST',
            headers: requestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify(body),
        });
        return readJson(response);
    }

    function requireApi(method) {
        const api = readApi();
        if (typeof api?.[method] === 'function') return api;
        if (typeof controlApi?.[method] === 'function') return controlApi;
        throw new Error('MVU variable runtime is not ready.');
    }

    const config = () => request('config');

    function setEnabled(enabled) {
        return requireApi('setEnabled').setEnabled(Boolean(enabled));
    }

    function useStoryModel() {
        return requireApi('useStoryModel').useStoryModel();
    }

    async function configureIndependent({ baseUrl, model, apiKey = '' }) {
        const saved = await request('configure', {
            base_url: String(baseUrl || '').trim(),
            model: String(model || '').trim(),
            api_key: String(apiKey || '').trim(),
        });
        requireApi('useIndependentModel').useIndependentModel({ model: saved.model });
        return saved;
    }

    async function useIndependentModel() {
        const saved = await config();
        if (!saved.base_url || !saved.model || !saved.has_api_key) {
            throw new Error(tr("请先完成独立 MVU 模型配置。"));
        }
        requireApi('useIndependentModel').useIndependentModel({ model: saved.model });
        return saved;
    }

    return Object.freeze({
        status,
        inspect,
        config,
        setEnabled,
        useStoryModel,
        useIndependentModel,
        configureIndependent,
    });
}
