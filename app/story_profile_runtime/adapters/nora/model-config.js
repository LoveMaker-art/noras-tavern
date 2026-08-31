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

    return Object.freeze({
        base_url: baseUrl.replace(/\/$/, ''),
        model: modelId,
        api_key: requiredText(readApiKey(directories)),
        max_tokens: Math.max(1, Number.parseInt(model.openai_max_tokens, 10) || 1600),
    });
}
