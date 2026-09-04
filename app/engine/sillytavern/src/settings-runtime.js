export const SETTINGS_SCOPES = Object.freeze({
    FULL: 'full',
    RUNTIME: 'runtime',
    WORLD_INFO: 'world-info',
});

const RUNTIME_SETTING_KEYS = Object.freeze([
    'firstRun',
    'accountStorage',
    'currentVersion',
    'username',
    'active_character',
    'user_avatar',
    'amount_gen',
    'max_context',
    'main_api',
    'world_info_settings',
    'swipes',
    'power_user',
    'extension_settings',
    'tags',
    'tag_map',
    'background',
    'selected_button',
]);

const PROVIDER_SETTING_KEYS = Object.freeze({
    kobold: ['kai_settings'],
    koboldhorde: ['horde_settings'],
    novel: ['nai_settings'],
    openai: ['oai_settings', 'proxies', 'selected_proxy'],
    textgenerationwebui: ['textgenerationwebui_settings'],
});

export function normalizeMainApi(mainApi) {
    if (mainApi === 'poe') return 'openai';
    return Object.hasOwn(PROVIDER_SETTING_KEYS, mainApi) ? mainApi : 'kobold';
}

export function normalizeSettingsScope(scope) {
    return Object.values(SETTINGS_SCOPES).includes(scope) ? scope : SETTINGS_SCOPES.FULL;
}

export function selectRuntimeSettings(source) {
    const mainApi = normalizeMainApi(source?.main_api);
    const keys = [...RUNTIME_SETTING_KEYS, ...PROVIDER_SETTING_KEYS[mainApi]];
    const selected = {};

    for (const key of keys) {
        if (Object.hasOwn(source ?? {}, key)) {
            selected[key] = source[key];
        }
    }

    selected.main_api = mainApi;
    return selected;
}

export function mergeRuntimeSettings(current, update) {
    return {
        ...current,
        ...update,
    };
}

export function selectNoraLastWorldId(source) {
    return String(source?.extension_settings?.nora_ui?.lastWorldId || '').trim();
}
