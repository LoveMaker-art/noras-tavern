export function createStModelAdapter(runtime, { reportStage = () => {} } = {}) {
    let reconnectPromise = null;
    const customSecretKey = 'api_key_custom';

    async function secretRequest(path, body) {
        const response = await fetch(`/api/secrets/${path}`, {
            method: 'POST',
            headers: runtime().getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Model credential operation failed (${response.status}).`);
        if (response.status === 204) return {};
        return response.json();
    }

    async function activeModelSecretId() {
        const state = await secretRequest('read', {});
        return state?.[customSecretKey]?.find(secret => secret?.active)?.id || '';
    }

    async function rotateModelSecret(secretId) {
        if (!secretId) return;
        await secretRequest('rotate', { key: customSecretKey, id: secretId });
    }

    async function deleteModelSecret(secretId) {
        if (!secretId) return;
        await secretRequest('delete', { key: customSecretKey, id: secretId });
    }

    function modelConfigurationError() {
        return Object.assign(
            new Error('文本模型配置缺失。请先完成文本模型配置。'),
            { code: 'NORA_MODEL_CONFIGURATION_REQUIRED' },
        );
    }

    function ensureCustomBackendAuth(current) {
        const settings = current.chatCompletionSettings;
        if (current.mainApi !== 'openai' || settings?.chat_completion_source !== 'custom') return;
        const hasProfile = String(settings.custom_url || '').trim() && String(settings.custom_model || '').trim();
        if (!hasProfile) {
            throw modelConfigurationError();
        }
    }

    function assertModelConfigured() {
        ensureCustomBackendAuth(runtime());
        return true;
    }

    async function ensureReady() {
        const current = runtime();
        reportStage('send-backend-check', {
            onlineStatus: current.onlineStatus,
            mainApi: current.mainApi,
        });
        assertModelConfigured();
        // Interactive Nora replies use the native SSE path; quiet/sidecar calls retain ST rules.
        if (current.mainApi === 'openai' && current.chatCompletionSettings) current.chatCompletionSettings.stream_openai = true;
        if (current.onlineStatus !== 'no_connection') return;

        const settings = current.chatCompletionSettings;
        if (current.mainApi !== 'openai' || settings?.chat_completion_source !== 'custom') {
            throw new Error('The configured model backend is not connected.');
        }

        reconnectPromise ??= current.configureCustomChatCompletion({
            url: settings.custom_url,
            model: settings.custom_model,
            context: settings.openai_max_context,
            maxTokens: settings.openai_max_tokens,
        });
        try {
            await reconnectPromise;
        } finally {
            reconnectPromise = null;
        }

        const refreshed = runtime();
        if (refreshed.mainApi === 'openai' && refreshed.chatCompletionSettings) refreshed.chatCompletionSettings.stream_openai = true;
        reportStage('send-backend-ready', { onlineStatus: refreshed.onlineStatus });
        if (refreshed.onlineStatus === 'no_connection') {
            throw new Error('The configured model backend could not be connected.');
        }
    }

    async function configureModel(profile, apiKey = '') {
        const previousSecretId = await activeModelSecretId();
        let secretId = String(profile?.secretId || '').trim();
        try {
            if (String(apiKey).trim()) {
                const saved = await secretRequest('write', {
                    key: customSecretKey,
                    value: String(apiKey).trim(),
                    label: `Nora model: ${String(profile?.name || profile?.model || 'custom')}`,
                });
                secretId = String(saved?.id || '').trim();
                if (!secretId) throw new Error('Model credential was not saved.');
            } else if (secretId && secretId !== previousSecretId) {
                await rotateModelSecret(secretId);
            }
            await runtime().configureCustomChatCompletion({
                url: profile.base,
                model: profile.model,
                apiKey: '',
                context: profile.context,
                maxTokens: profile.tokens,
            });
            return Object.freeze({ secretId: secretId || previousSecretId });
        } catch (error) {
            if (previousSecretId && previousSecretId !== secretId) {
                await rotateModelSecret(previousSecretId).catch(() => {});
            }
            throw error;
        }
    }

    function clearModelConfiguration() {
        return runtime().clearCustomChatCompletion();
    }

    return Object.freeze({
        ensureReady,
        actions: Object.freeze({ configureModel, clearModelConfiguration, deleteModelSecret, assertModelConfigured }),
    });
}
