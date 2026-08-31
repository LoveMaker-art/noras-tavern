export function createStSettingsAdapter(runtime) {
    function uiSettings() {
        const current = runtime();
        current.extensionSettings ??= {};
        current.extensionSettings.nora_ui ||= {};
        const value = current.extensionSettings.nora_ui;
        value.schema = 2;
        value.modelProfiles ||= [];
        value.activeModel ||= '';
        value.profile ||= { firstSeenAt: Date.now(), hostPersonality: '', preferences: [], timeline: [] };
        value.profile.preferences ||= [];
        value.profile.timeline ||= [];
        return value;
    }

    function saveUiSettings({ immediate = false } = {}) {
        if (immediate) return runtime().saveSettingsStrict();
        return runtime().saveSettingsDebounced?.();
    }

    function setHostPersonality(personality) {
        runtime().setExtensionPrompt(
            'nora_ui_host_personality',
            personality ? `# 主理人的人格\n${personality}` : '',
            0,
            4,
            false,
            0,
        );
    }

    return Object.freeze({ uiSettings, saveUiSettings, setHostPersonality });
}
