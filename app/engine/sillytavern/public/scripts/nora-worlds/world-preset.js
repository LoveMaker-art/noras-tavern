import { PRESET_MAX_BYTES, presetFileSize } from './preset-file.js';

// World snapshots carry generation settings, never connections or executable extensions.
export const WORLD_PRESET_PARAMETERS = Object.freeze([
    { key: 'openai_max_tokens', label: '回复上限', min: 1, max: 128000, step: 1 },
    { key: 'openai_max_context', label: '上下文上限', min: 512, max: 1000000, step: 1 },
    { key: 'temperature', label: '温度', min: 0, max: 2, step: 0.01 },
    { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01 },
].map(Object.freeze));

export function validateWorldPresetParameters(preset, limits = {}) {
    for (const field of WORLD_PRESET_PARAMETERS) {
        const value = preset[field.key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max
            || (field.step === 1 && !Number.isInteger(value))) throw new Error(`${field.label}：${field.min}–${field.max}${field.step === 1 ? '，请输入整数' : ''}`);
    }
    if (preset.openai_max_tokens >= preset.openai_max_context) throw new Error('回复上限必须小于上下文上限，以留出输入空间。');
    validateWorldPresetModelLimits(preset, limits);
}

export function validateWorldPresetModelLimits(preset, limits = {}) {
    if (limits.context && preset.openai_max_context > limits.context) throw new Error(`当前模型的上下文上限为 ${limits.context} token，请调整世界预设。`);
    if (limits.tokens && preset.openai_max_tokens > limits.tokens) throw new Error(`当前模型的回复上限为 ${limits.tokens} token，请调整世界预设。`);
}

export const WORLD_PRESET_FIELDS = Object.freeze([
    'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'top_a', 'min_p',
    'repetition_penalty', 'max_context_unlocked', 'openai_max_context', 'openai_max_tokens',
    'names_behavior', 'send_if_empty', 'impersonation_prompt', 'new_chat_prompt', 'new_example_chat_prompt',
    'continue_nudge_prompt', 'wi_format', 'scenario_format', 'personality_format', 'stream_openai',
    'assistant_prefill', 'assistant_impersonation', 'use_sysprompt', 'squash_system_messages',
    'media_inlining', 'inline_image_quality', 'continue_prefill', 'continue_postfix', 'function_calling',
    'tool_call_recurse_limit', 'tool_reasoning_mode', 'show_thoughts', 'reasoning_effort', 'verbosity',
    'enable_web_search', 'seed', 'n', 'request_images', 'request_image_aspect_ratio', 'request_image_resolution',
]);

export function normalizeWorldPreset(value) {
    const invalid = () => { throw new Error('Invalid World preset snapshot.'); };
    if (!value || value.schema !== 'nora-world-preset/v1' || typeof value.name !== 'string'
        || !value.name.trim() || value.name.length > 150 || typeof value.modified !== 'boolean') invalid();
    const preset = value.preset;
    if (!preset || !Array.isArray(preset.prompts) || !Array.isArray(preset.prompt_order)
        || presetFileSize(JSON.stringify(preset)) > PRESET_MAX_BYTES) invalid();
    const ids = new Set();
    for (const prompt of preset.prompts) {
        if (!prompt || typeof prompt.identifier !== 'string' || !prompt.identifier || ids.has(prompt.identifier)
            || (prompt.content !== undefined && typeof prompt.content !== 'string')) invalid();
        ids.add(prompt.identifier);
    }
    const group = preset.prompt_order.find(item => String(item?.character_id) === '100001');
    if (!group || !Array.isArray(group.order)) invalid();
    const seen = new Set();
    for (const entry of group.order) {
        if (!entry || !ids.has(entry.identifier) || seen.has(entry.identifier) || typeof entry.enabled !== 'boolean') invalid();
        seen.add(entry.identifier);
    }
    const parameters = {};
    for (const key of WORLD_PRESET_FIELDS) {
        if (!Object.hasOwn(preset, key)) continue;
        const field = preset[key];
        if (!['number', 'string', 'boolean'].includes(typeof field) || (typeof field === 'number' && !Number.isFinite(field))) invalid();
        parameters[key] = field;
    }
    return { schema: 'nora-world-preset/v1', name: value.name.trim(), modified: value.modified,
        preset: { ...parameters, prompts: structuredClone(preset.prompts),
            prompt_order: [{ character_id: 100001, order: group.order.map(({ identifier, enabled }) => ({ identifier, enabled })) }] } };
}

export function createWorldPreset(name, preset, modified = false) {
    return normalizeWorldPreset({ schema: 'nora-world-preset/v1', name, modified, preset });
}
