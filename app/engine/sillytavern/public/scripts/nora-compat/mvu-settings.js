export const NORA_MVU_MODEL_PROXY_URL = 'https://nora-mvu.invalid/v1';

export function isMvuVariableModelEnabled(settings = {}) {
    return settings?.['更新方式'] === '额外模型解析'
        && settings?.['额外模型解析配置']?.['启用自动请求'] !== false;
}

// Both managed and embedded runtimes use these rules. Their callers retain
// ownership of readiness checks, defaults, reload and persistence.
export function createMvuSettingsControls(apply) {
    return Object.freeze({
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
        useIndependentModel({ model, contextLimit = 30000, maxTokens = 4000 }) {
            return apply({
                '更新方式': '额外模型解析',
                '额外模型解析配置': {
                    '模型来源': '自定义',
                    'api地址': NORA_MVU_MODEL_PROXY_URL,
                    '密钥': '',
                    '模型名称': String(model || '').trim(),
                    '最大上下文token数': Math.min(1000000, Math.max(512, Number(contextLimit) || 30000)),
                    '最大回复token数': Math.min(128000, Math.max(1, Number(maxTokens) || 4000)),
                },
            });
        },
    });
}
