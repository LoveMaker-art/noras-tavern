import {
    chat_metadata,
    substituteParams,
    this_chid,
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../script.js';
import { extension_settings, saveMetadataDebounced } from './extensions.js';
import { getCharaFilename } from './utils.js';
import { power_user } from './power-user.js';

const extensionName = 'cfg';
const defaultSettings = {
    global: {
        'guidance_scale': 1,
        'negative_prompt': '',
        'positive_prompt': '',
    },
    chara: [],
};
function ensureCfgState() {
    const current = extension_settings[extensionName] || {};
    const incomplete = !current.global || !Array.isArray(current.chara);
    extension_settings[extensionName] = {
        ...current,
        global: { ...defaultSettings.global, ...current.global },
        chara: Array.isArray(current.chara) ? current.chara : [],
    };
    if (incomplete) {
        saveSettingsDebounced();
    }
    return extension_settings[extensionName];
}

function assignPromptSettings(target, patch) {
    if (Object.hasOwn(patch, 'guidance_scale')) {
        const value = Number(patch.guidance_scale);
        if (Number.isFinite(value)) target.guidance_scale = value;
    }
    if (Object.hasOwn(patch, 'negative_prompt')) target.negative_prompt = String(patch.negative_prompt ?? '');
    if (Object.hasOwn(patch, 'positive_prompt')) target.positive_prompt = String(patch.positive_prompt ?? '');
}

export function getCfgState() {
    const cfg = ensureCfgState();
    const characterName = getCharaFilename(this_chid);
    const character = cfg.chara.find(item => item.name === characterName);
    return {
        chat: {
            guidance_scale: chat_metadata[metadataKeys.guidance_scale] ?? 1,
            negative_prompt: chat_metadata[metadataKeys.negative_prompt] ?? '',
            positive_prompt: chat_metadata[metadataKeys.positive_prompt] ?? '',
        },
        character: character ? { ...character } : null,
        global: { ...cfg.global },
        prompt_combine: [...(chat_metadata[metadataKeys.prompt_combine] ?? [])],
        prompt_insertion_depth: chat_metadata[metadataKeys.prompt_insertion_depth] ?? 1,
        prompt_separator: chat_metadata[metadataKeys.prompt_separator] ?? '',
    };
}

export function updateCfgState({ chat = null, character = undefined, global = null, prompt_combine = undefined, prompt_insertion_depth = undefined, prompt_separator = undefined } = {}) {
    const cfg = ensureCfgState();
    let metadataChanged = false;
    let settingsChanged = false;

    if (chat) {
        const current = {
            guidance_scale: chat_metadata[metadataKeys.guidance_scale] ?? 1,
            negative_prompt: chat_metadata[metadataKeys.negative_prompt] ?? '',
            positive_prompt: chat_metadata[metadataKeys.positive_prompt] ?? '',
        };
        assignPromptSettings(current, chat);
        chat_metadata[metadataKeys.guidance_scale] = current.guidance_scale;
        chat_metadata[metadataKeys.negative_prompt] = current.negative_prompt;
        chat_metadata[metadataKeys.positive_prompt] = current.positive_prompt;
        metadataChanged = true;
    }

    if (global) {
        assignPromptSettings(cfg.global, global);
        settingsChanged = true;
    }

    if (prompt_combine !== undefined) {
        chat_metadata[metadataKeys.prompt_combine] = Array.isArray(prompt_combine)
            ? [...new Set(prompt_combine.map(Number).filter(value => [cfgType.chat, cfgType.chara, cfgType.global].includes(value)))]
            : [];
        metadataChanged = true;
    }

    if (prompt_insertion_depth !== undefined) {
        const value = Number(prompt_insertion_depth);
        if (Number.isFinite(value)) {
            chat_metadata[metadataKeys.prompt_insertion_depth] = Math.max(0, value);
            metadataChanged = true;
        }
    }

    if (prompt_separator !== undefined) {
        chat_metadata[metadataKeys.prompt_separator] = String(prompt_separator ?? '');
        metadataChanged = true;
    }

    if (character !== undefined) {
        const name = String(character?.name || getCharaFilename(this_chid) || '');
        const index = cfg.chara.findIndex(item => item.name === name);
        if (character === null) {
            if (index >= 0) cfg.chara.splice(index, 1);
            settingsChanged = index >= 0;
        } else if (name) {
            const next = index >= 0
                ? { ...cfg.chara[index] }
                : { name, guidance_scale: 1, negative_prompt: '', positive_prompt: '' };
            assignPromptSettings(next, character);
            const isDefault = next.guidance_scale === 1 && !next.negative_prompt && !next.positive_prompt;
            if (isDefault) {
                if (index >= 0) cfg.chara.splice(index, 1);
            } else if (index >= 0) {
                cfg.chara[index] = next;
            } else {
                cfg.chara.push(next);
            }
            settingsChanged = true;
        }
    }

    if (metadataChanged) saveMetadataDebounced();
    if (settingsChanged) saveSettingsDebounced();
    return getCfgState();
}

function migrateSettings() {
    let performSettingsSave = false;
    let performMetaSave = false;

    if (power_user.guidance_scale) {
        extension_settings.cfg.global.guidance_scale = power_user.guidance_scale;
        delete power_user.guidance_scale;
        performSettingsSave = true;
    }

    if (power_user.negative_prompt) {
        extension_settings.cfg.global.negative_prompt = power_user.negative_prompt;
        delete power_user.negative_prompt;
        performSettingsSave = true;
    }

    if (chat_metadata.cfg_negative_combine) {
        chat_metadata[metadataKeys.prompt_combine] = chat_metadata.cfg_negative_combine;
        chat_metadata.cfg_negative_combine = undefined;
        performMetaSave = true;
    }

    if (chat_metadata.cfg_negative_insertion_depth) {
        chat_metadata[metadataKeys.prompt_insertion_depth] = chat_metadata.cfg_negative_insertion_depth;
        chat_metadata.cfg_negative_insertion_depth = undefined;
        performMetaSave = true;
    }

    if (chat_metadata.cfg_negative_separator) {
        chat_metadata[metadataKeys.prompt_separator] = chat_metadata.cfg_negative_separator;
        chat_metadata.cfg_negative_separator = undefined;
        performMetaSave = true;
    }

    if (performSettingsSave) {
        saveSettingsDebounced();
    }

    if (performMetaSave) {
        saveMetadataDebounced();
    }
}

// This function is called when the extension is loaded
export function initCfg() {
    ensureCfgState();
    migrateSettings();
    eventSource.on(event_types.CHAT_CHANGED, ensureCfgState);
}

export const cfgType = {
    chat: 0,
    chara: 1,
    global: 2,
};

export const metadataKeys = {
    guidance_scale: 'cfg_guidance_scale',
    negative_prompt: 'cfg_negative_prompt',
    positive_prompt: 'cfg_positive_prompt',
    prompt_combine: 'cfg_prompt_combine',
    prompt_insertion_depth: 'cfg_prompt_insertion_depth',
    prompt_separator: 'cfg_prompt_separator',
};

// Gets the CFG guidance scale
// If the guidance scale is 1, ignore the CFG prompt(s) since it won't be used anyways
export function getGuidanceScale() {
    if (!extension_settings.cfg) {
        console.warn('CFG extension is not enabled. Skipping CFG guidance.');
        return;
    }

    const charaCfg = extension_settings.cfg.chara?.find((e) => e.name === getCharaFilename(this_chid));
    const chatGuidanceScale = chat_metadata[metadataKeys.guidance_scale];
    if (chatGuidanceScale && chatGuidanceScale !== 1) {
        return {
            type: cfgType.chat,
            value: chatGuidanceScale,
        };
    }

    if (charaCfg && charaCfg.guidance_scale !== 1) {
        return {
            type: cfgType.chara,
            value: charaCfg.guidance_scale,
        };
    }

    if (extension_settings.cfg.global && extension_settings.cfg.global?.guidance_scale !== 1) {
        return {
            type: cfgType.global,
            value: extension_settings.cfg.global.guidance_scale,
        };
    }
}

/**
 * Gets the CFG prompt separator.
 * @returns {string} The CFG prompt separator
 */
function getCustomSeparator() {
    const defaultSeparator = '\n';

    try {
        if (chat_metadata[metadataKeys.prompt_separator]) {
            return JSON.parse(chat_metadata[metadataKeys.prompt_separator]);
        }

        return defaultSeparator;
    } catch {
        console.warn('Invalid JSON detected for prompt separator. Using default separator.');
        return defaultSeparator;
    }
}

/**
 * Gets the CFG prompt based on the guidance scale.
 * @param {{type: number, value: number}} guidanceScale The CFG guidance scale
 * @param {boolean} isNegative Whether to get the negative prompt
 * @param {boolean} quiet Whether to suppress console output
 * @returns {{value: string, depth: number}} The CFG prompt and insertion depth
 */
export function getCfgPrompt(guidanceScale, isNegative, quiet = false) {
    let splitCfgPrompt = [];

    const cfgPromptCombine = chat_metadata[metadataKeys.prompt_combine] ?? [];
    if (guidanceScale.type === cfgType.chat || cfgPromptCombine.includes(cfgType.chat)) {
        splitCfgPrompt.unshift(
            substituteParams(
                chat_metadata[isNegative ? metadataKeys.negative_prompt : metadataKeys.positive_prompt],
            ),
        );
    }

    const charaCfg = extension_settings.cfg.chara?.find((e) => e.name === getCharaFilename(this_chid));
    if (guidanceScale.type === cfgType.chara || cfgPromptCombine.includes(cfgType.chara)) {
        splitCfgPrompt.unshift(
            substituteParams(
                isNegative ? charaCfg.negative_prompt : charaCfg.positive_prompt,
            ),
        );
    }

    if (guidanceScale.type === cfgType.global || cfgPromptCombine.includes(cfgType.global)) {
        splitCfgPrompt.unshift(
            substituteParams(
                isNegative ? extension_settings.cfg.global.negative_prompt : extension_settings.cfg.global.positive_prompt,
            ),
        );
    }

    const customSeparator = getCustomSeparator();
    const combinedCfgPrompt = splitCfgPrompt.filter((e) => e.length > 0).join(customSeparator);
    const insertionDepth = chat_metadata[metadataKeys.prompt_insertion_depth] ?? 1;
    !quiet && console.log(`Setting CFG with guidance scale: ${guidanceScale.value}, negatives: ${combinedCfgPrompt}`);

    return {
        value: combinedCfgPrompt,
        depth: insertionDepth,
    };
}
