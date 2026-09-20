import { createWorldPreset, validateWorldPresetParameters, WORLD_PRESET_PARAMETERS } from './world-preset.js';

const protectedIds = new Set(['chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('Invalid preset edit or protected dynamic prompt.'); };
const protectedPrompt = prompt => prompt.marker === true || protectedIds.has(prompt.identifier);
const fields = ['name', 'content', 'role', 'injection_position', 'injection_depth', 'injection_order'];

/** Edit only explicitly requested fields; retain opaque native/plugin metadata. */
export function editPreset(source, edits) {
    if (!record(edits) || Object.keys(edits).some(key => !['prompts', 'order', 'parameters'].includes(key))) fail();
    const result = structuredClone(source);
    const normalized = createWorldPreset('validation', result).preset;
    const group = result.prompt_order.find(item => String(item.character_id) === '100001');
    const seen = new Set();
    if (edits.prompts !== undefined && !Array.isArray(edits.prompts)) fail();
    for (const change of edits.prompts || []) {
        if (!record(change) || Object.keys(change).some(key => !['operation', 'id', 'patch'].includes(key))
            || typeof change.id !== 'string' || !/^[\w.-]{1,150}$/.test(change.id) || seen.has(change.id)) fail();
        seen.add(change.id);
        const index = result.prompts.findIndex(prompt => prompt.identifier === change.id);
        const existing = result.prompts[index];
        if (protectedIds.has(change.id) || (existing && protectedPrompt(existing))) fail();
        if (change.operation === 'delete') {
            if (!existing || change.patch !== undefined) fail();
            result.prompts.splice(index, 1);
            for (const order of result.prompt_order) order.order = order.order.filter(item => item.identifier !== change.id);
            continue;
        }
        if (!['create', 'update'].includes(change.operation) || (change.operation === 'create') === Boolean(existing)
            || !record(change.patch) || Object.keys(change.patch).some(key => !fields.includes(key))) fail();
        for (const [key, value] of Object.entries(change.patch)) {
            if (['name', 'content'].includes(key) ? typeof value !== 'string'
                : key === 'role' ? !['system', 'user', 'assistant'].includes(value)
                    : !Number.isInteger(value) || value < 0 || (key === 'injection_position' ? value > 1 : value > 10000)) fail();
        }
        if (existing) Object.assign(existing, change.patch);
        else {
            if (typeof change.patch.content !== 'string') fail();
            result.prompts.push({ identifier: change.id, name: change.id, role: 'system', system_prompt: false, marker: false, ...change.patch });
            group.order.push({ identifier: change.id, enabled: true });
        }
    }
    if (edits.order !== undefined) {
        if (!Array.isArray(edits.order) || edits.order.some(item => !record(item)
            || Object.keys(item).some(key => !['identifier', 'enabled'].includes(key)))) fail();
        for (const prompt of normalized.prompts.filter(protectedPrompt)) {
            const before = normalized.prompt_order[0].order.find(item => item.identifier === prompt.identifier);
            const after = edits.order.find(item => item.identifier === prompt.identifier);
            if (before && (!after || after.enabled !== before.enabled)) fail();
        }
        group.order = edits.order.map(item => ({ ...group.order.find(old => old.identifier === item.identifier), ...item }));
    }
    if (edits.parameters !== undefined) {
        if (!record(edits.parameters) || Object.keys(edits.parameters).some(key => !WORLD_PRESET_PARAMETERS.some(field => field.key === key))) fail();
        Object.assign(result, edits.parameters);
    }
    createWorldPreset('validation', result);
    validateWorldPresetParameters(result);
    return result;
}
