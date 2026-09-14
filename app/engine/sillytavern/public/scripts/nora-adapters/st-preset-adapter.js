export function createStPresetAdapter(runtime) {
    const manager = () => runtime().getPresetManager('openai');
    let saving = false;
    const globalOrder = preset => preset.prompt_order?.find(item => String(item.character_id) === '100001')?.order || [];
    const liveRevision = () => {
        const settings = runtime().chatCompletionSettings;
        return JSON.stringify([manager().getSelectedPresetName(), settings.prompts, settings.prompt_order]);
    };

    function toggleablePresetEntries(preset) {
        const promptManager = runtime().getChatCompletionPromptManager();
        return (preset.prompts || []).filter(prompt => promptManager.isPromptToggleAllowed(prompt)).map(prompt => prompt.identifier);
    }

    function readPreset(name, { storedOnly = false } = {}) {
        const current = manager();
        const { presets, preset_names } = current.getPresetList();
        const stored = presets[preset_names[name]];
        if (!stored) throw new Error('预设不存在，请重新打开预设库。');
        const promptManager = runtime().getChatCompletionPromptManager();
        const active = !storedOnly && current.getSelectedPresetName() === name;
        const settings = runtime().chatCompletionSettings;
        const preset = structuredClone(active ? { ...stored, prompts: settings.prompts, prompt_order: settings.prompt_order } : stored);
        return { name, current: active, storedOnly, preset, revision: JSON.stringify(stored), runtimeRevision: liveRevision(),
            toggleable: (preset.prompts || []).filter(prompt => promptManager.isPromptToggleAllowed(prompt)).map(prompt => prompt.identifier) };
    }

    async function savePresetEntries(snapshot, changes, { apply = false, enableScripts = false } = {}) {
        if (saving || runtime().isGenerating?.()) throw new Error('请等待当前生成或保存完成。');
        const latest = readPreset(snapshot.name, { storedOnly: snapshot.storedOnly });
        if (latest.revision !== snapshot.revision || (!snapshot.storedOnly && latest.runtimeRevision !== snapshot.runtimeRevision)) {
            throw new Error('预设已改变，请重新打开后再编辑。');
        }
        if (!Array.isArray(changes)) throw new Error('预设条目修改无效。');
        const current = manager(), { presets, preset_names } = current.getPresetList();
        const index = preset_names[snapshot.name];
        const updated = structuredClone(presets[index]);
        const running = structuredClone(runtime().chatCompletionSettings.prompt_order || []);
        const patch = (target, change) => {
            target.prompt_order ||= [];
            let group = target.prompt_order.find(item => String(item.character_id) === '100001');
            if (!group) target.prompt_order.push(group = { character_id: 100001, order: [] });
            const entry = group.order.find(item => item.identifier === change.identifier);
            if (entry) entry.enabled = change.enabled;
            else group.order.push({ identifier: change.identifier, enabled: change.enabled });
        };
        const seen = new Set();
        for (const change of changes) {
            const prompt = latest.preset.prompts?.find(item => item.identifier === change.identifier);
            const listed = globalOrder(latest.preset).some(item => item.identifier === change.identifier);
            if (!prompt || !latest.toggleable.includes(change.identifier) || typeof change.enabled !== 'boolean'
                || seen.has(change.identifier) || (!listed && change.add !== true)) throw new Error('预设条目不可切换，请重新打开检查。');
            seen.add(change.identifier);
            // Runtime defaults may be absent from an older imported preset.
            if (!updated.prompts.some(item => item.identifier === change.identifier)) updated.prompts.push(structuredClone(prompt));
            patch(updated, change);
            patch({ prompt_order: running }, change);
        }
        saving = true;
        try {
            // Native updateList also reapplies the preset and fires script events.
            await current.savePreset(snapshot.name, updated, { skipUpdate: true });
            if (JSON.stringify(presets[index]) !== snapshot.revision) {
                throw Object.assign(new Error('预设已保存，但本地状态已改变，请重新加载后检查。'), { saved: true });
            }
            presets[index] = updated;
            if (apply) {
                try {
                    if (liveRevision() !== snapshot.runtimeRevision || runtime().isGenerating?.()) throw new Error('当前使用状态已改变');
                    if (snapshot.current) {
                        const settings = runtime().chatCompletionSettings;
                        const previous = settings.prompt_order;
                        settings.prompt_order = running;
                        try { await runtime().saveSettingsStrict(); } catch (error) {
                            if (settings.prompt_order === running) settings.prompt_order = previous;
                            throw error;
                        }
                        const prompts = runtime().getChatCompletionPromptManager();
                        if (prompts.containerElement) prompts.render(false);
                    } else {
                        await applyPreset(snapshot.name, { enableScripts });
                        await runtime().saveSettingsStrict();
                    }
                } catch (error) {
                    throw Object.assign(new Error('预设已保存，但未能完成应用，请重试应用。', { cause: error }), { saved: true });
                }
            }
            return readPreset(snapshot.name);
        } finally { saving = false; }
    }
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
        try { await current.selectPreset(current.findPreset(name)); } finally {
            settings.bind_preset_to_connection = previousBinding;
            presets[index] = original;
        }
    }
    async function deletePreset(snapshot) {
        if (saving || runtime().isGenerating?.()) throw new Error('请等待当前生成或保存完成。');
        const latest = readPreset(snapshot.name, { storedOnly: true });
        if (latest.revision !== snapshot.revision) throw new Error('预设已改变，请重新打开后再编辑。');
        saving = true;
        try {
            if (!await manager().deletePreset(snapshot.name, { skipSwitch: true })) {
                throw new Error('模板删除失败，请重试。');
            }
        } finally { saving = false; }
    }
    return { listPresets, importPreset, applyPreset, readPreset, savePresetEntries, toggleablePresetEntries, deletePreset };
}
