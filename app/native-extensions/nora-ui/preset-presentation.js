import { normalizeTavernHelperScripts } from '../../engine/sillytavern/public/scripts/nora-compat/mvu-compatibility.js';

export function describePreset(preset = {}) {
    const prompts = (Array.isArray(preset.prompts) ? preset.prompts : []).filter(item => item && typeof item.identifier === 'string');
    // Match OpenAI PromptManager's global dummy character, not a different preset order.
    const order = (Array.isArray(preset.prompt_order) ? preset.prompt_order : [])
        .find(item => String(item?.character_id) === '100001')?.order;
    const configured = Array.isArray(order) && order.length > 0;
    const byId = new Map(prompts.map(item => [item.identifier, item]));
    const seen = new Set();
    const rows = [];
    if (configured) for (const reference of order) {
        const prompt = byId.get(reference?.identifier);
        if (!prompt || seen.has(prompt.identifier)) continue;
        seen.add(prompt.identifier);
        rows.push({ ...prompt, enabled: Boolean(reference.enabled), listed: true });
    }
    for (const prompt of prompts) {
        if (!seen.has(prompt.identifier)) rows.push({ ...prompt, enabled: configured ? false : null, listed: false });
    }
    const parameters = [
        ['temperature', '温度'], ['top_p', 'Top P'], ['openai_max_tokens', '回复上限'], ['openai_max_context', '上下文上限'],
    ].flatMap(([key, label]) => typeof preset[key] === 'number' && Number.isFinite(preset[key]) ? [{ key, label, value: preset[key] }] : []);
    return { rows, configured, parameters, scripts: normalizeTavernHelperScripts({ data: { extensions: preset.extensions || {} } }).length };
}
