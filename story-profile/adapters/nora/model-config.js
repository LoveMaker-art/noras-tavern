export class NoraTextModelConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NoraTextModelConfigurationError';
        this.code = 'NORA_MODEL_CONFIGURATION_REQUIRED';
    }
}

function requiredText(value) {
    return String(value ?? '').trim();
}

/**
 * Resolve the same persisted custom text model used by Nora foreground chat.
 * The returned secret is only for the local reflection child process and must
 * never be returned through an HTTP response or written to Story Profile data.
 */
export function readActiveNoraTextModel(
    directories,
    {
        readSettings,
        readApiKey,
        parseYaml = JSON.parse,
        resolveProxy = () => '',
    },
) {
    if (!directories?.root) {
        throw new TypeError('Nora user directories are required.');
    }
    if (typeof readSettings !== 'function' || typeof readApiKey !== 'function') {
        throw new TypeError('Nora model settings and secret readers are required.');
    }

    const payload = readSettings(directories);
    const settings = typeof payload?.settings === 'string'
        ? JSON.parse(payload.settings)
        : payload?.settings;
    const mainApi = requiredText(payload?.active_api || settings?.main_api);
    const model = settings?.oai_settings || {};
    const source = requiredText(model.chat_completion_source);
    const baseUrl = requiredText(model.custom_url);
    const modelId = requiredText(model.custom_model);

    if (mainApi !== 'openai' || source !== 'custom' || !baseUrl || !modelId) {
        throw new NoraTextModelConfigurationError(
            '文本模型尚未配置，Story Profile 暂时不会执行偏好复盘。',
        );
    }

    function parsedOption(name, fallback) {
        const raw = model[name];
        if (!raw || (typeof raw === 'string' && !raw.trim())) return fallback;
        try {
            const value = typeof raw === 'string' ? parseYaml(raw) : raw;
            if (Array.isArray(fallback) ? !Array.isArray(value) : !value || Array.isArray(value) || typeof value !== 'object') throw new TypeError('invalid option');
            return value;
        } catch {
            const error = new NoraTextModelConfigurationError(`文本模型的 ${name} 配置格式不正确；复盘未执行。`);
            error.code = 'NORA_MODEL_TRANSPORT_OPTIONS_INVALID';
            throw error;
        }
    }
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const configuredTemperature = model.temp_openai;
    const hasTemperature = configuredTemperature !== undefined && configuredTemperature !== null && configuredTemperature !== '';
    if (hasTemperature && (typeof configuredTemperature === 'boolean' || !Number.isFinite(Number(configuredTemperature)))) {
        throw new NoraTextModelConfigurationError('文本模型的温度配置无效，复盘未执行。');
    }
    let proxyUrl;
    try {
        proxyUrl = resolveProxy(normalizedBase + '/chat/completions');
        if (typeof proxyUrl !== 'string') throw new TypeError('Proxy resolver must return an explicit route.');
    } catch {
        const error = new NoraTextModelConfigurationError('无法确认当前酒馆的模型网络路由，复盘未执行。');
        error.code = 'NORA_MODEL_NETWORK_POLICY_INVALID';
        throw error;
    }
    return Object.freeze({
        base_url: normalizedBase,
        proxy_url: proxyUrl,
        model: modelId,
        api_key: requiredText(readApiKey(directories)),
        max_tokens: Math.max(1, Number.parseInt(model.openai_max_tokens, 10) || 1600),
        context_tokens: Math.max(1, Number.parseInt(model.openai_max_context, 10) || 8192),
        context_budget_estimated: !Number.isFinite(Number.parseInt(model.openai_max_context, 10)),
        ...(hasTemperature ? { temperature: Number(configuredTemperature) } : {}),
        headers: parsedOption('custom_include_headers', {}),
        body_parameters: parsedOption('custom_include_body', {}),
        exclude_body: parsedOption('custom_exclude_body', []),
    });
}
