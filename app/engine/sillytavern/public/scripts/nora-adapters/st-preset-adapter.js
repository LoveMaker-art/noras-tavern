export function createStPresetAdapter(runtime) {
    const manager = () => runtime().getPresetManager('openai');
    function listPresets() {
        const current = manager();
        const { presets, preset_names } = current.getPresetList();
        return { selected: current.getSelectedPresetName(), items: Object.entries(preset_names).map(([name, index]) => ({
            name, preset: structuredClone(presets[index]),
        })) };
    }

    async function importPreset(name, preset) {
        if (typeof name !== 'string' || !name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name.length > 150
            || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('请填写有效的预设名称。');
        if (!preset || Array.isArray(preset) || typeof preset !== 'object'
            || !Array.isArray(preset.prompts) || !Array.isArray(preset.prompt_order)
            || preset.prompts.some(item => !item || typeof item.identifier !== 'string')
            || preset.prompt_order.some(item => !item || !Array.isArray(item.order))) throw new Error('请选择 ST 聊天补全预设 JSON，必须包含 prompts 和 prompt_order。');
        const current = manager();
        if (current.getAllPresets().includes(name.trim())) throw new Error('已有同名预设，请修改名称后导入。');
        // ST updateList also selects the preset. Import only stores it; application is explicit.
        await current.savePreset(name.trim(), preset, { skipUpdate: true });
        const { presets, preset_names } = current.getPresetList();
        preset_names[name.trim()] = presets.length;
        presets.push(structuredClone(preset));
    }

    async function applyPreset(name, { enableScripts = false } = {}) {
        const context = runtime();
        const current = manager();
        if (!current.getAllPresets().includes(name)) throw new Error('预设不存在，请重新打开预设库。');
        const settings = context.chatCompletionSettings;
        const previousBinding = settings.bind_preset_to_connection;
        const { presets, preset_names } = current.getPresetList();
        const index = preset_names[name];
        const original = presets[index];
        const projected = structuredClone(original);
        if (!enableScripts) {
            const extensions = { ...projected.extensions };
            delete extensions.tavern_helper;
            delete extensions.TavernHelper_scripts;
            delete extensions.TavernHelper_characterScriptVariables;
            projected.extensions = extensions;
        }
        // Filter before ST emits preset events, so helper subscribers never see unapproved scripts.
        presets[index] = projected;
        settings.bind_preset_to_connection = false;
        try { await current.selectPreset(current.findPreset(name)); }
        finally {
            settings.bind_preset_to_connection = previousBinding;
            presets[index] = original;
        }
    }
    return { listPresets, importPreset, applyPreset };
}
