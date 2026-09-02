import {
    inspectMvuCompatibility,
    normalizeTavernHelperScripts,
} from '../nora-compat/mvu-compatibility.js';

const HELPER_EXTENSION = 'third-party/JS-Slash-Runner';
const MVU_EXTENSION = 'third-party/nora-mvu';
const REGEX_EXTENSION = 'regex';

function hasInitializedMvuData(runtime) {
    try {
        const value = runtime?.getMvuData?.({ type: 'message', message_id: 'latest' });
        return value !== null
            && typeof value === 'object'
            && !Array.isArray(value)
            && value.stat_data !== null
            && typeof value.stat_data === 'object'
            && !Array.isArray(value.stat_data)
            && value.schema !== undefined;
    } catch {
        return false;
    }
}

function characterWorldbookNames(character) {
    return [...new Set([
        character?.data?.extensions?.world,
        character?.data?.character_book?.name,
    ].map(value => String(value || '').trim()).filter(Boolean))];
}

export function inspectCharacterRuntime(character, books = []) {
    const regexScripts = Array.isArray(character?.data?.extensions?.regex_scripts)
        ? character.data.extensions.regex_scripts
        : [];
    const helperScripts = normalizeTavernHelperScripts(character);
    const availableBooks = [character?.data?.character_book, ...books].filter(Boolean);
    const mvu = inspectMvuCompatibility({ card: character, books: availableBooks, helperScripts });
    const mvuDeclared = mvu.declared;
    const mvuRuntimeSource = mvu.runtimeSource;
    const extensions = [];
    if (helperScripts.length || mvuDeclared) extensions.push(HELPER_EXTENSION);
    if (mvuRuntimeSource === 'managed') extensions.push(MVU_EXTENSION);
    return Object.freeze({
        regexScripts,
        helperScripts,
        mvuDeclared,
        mvuRuntimeSource,
        mvuUpdateProtocol: mvu.updateProtocol,
        mvuSplitModelSupported: mvu.splitModelSupported,
        mvuUpdateEntryIds: mvu.updateEntryIds,
        mvuReasons: mvu.reasons,
        extensions: Object.freeze(extensions),
    });
}

async function waitForExposedMvuRuntime({ timeoutMs = 5000, intervalMs = 25 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const runtime = globalThis.Mvu;
        if (typeof runtime?.getMvuData === 'function') return runtime;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    const error = new Error('Embedded MVU variable runtime did not initialize in time.');
    error.code = 'NORA_MVU_TIMEOUT';
    error.retryable = true;
    throw error;
}

function capabilityError(code, message, { retryable = true, cause } = {}) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    error.retryable = retryable;
    return error;
}

export function createStCardAdapter(runtime, { saveUiSettings } = {}) {
    function isSystemCharacter(character) {
        return character?.avatar === 'default_Seraphina.png'
            || character?.avatar === 'Nora_Blank_World--nora-internal.png'
            || character?.data?.extensions?.nora_internal?.kind === 'blank-world-runtime';
    }

    function helperScriptSettings() {
        const current = runtime();
        current.extensionSettings ??= {};
        current.extensionSettings.tavern_helper ??= {};
        current.extensionSettings.tavern_helper.script ??= {};
        const script = current.extensionSettings.tavern_helper.script;
        script.enabled ??= { global: true, presets: [], characters: [] };
        script.popuped ??= { presets: [], characters: [] };
        script.enabled.characters ??= [];
        script.popuped.characters ??= [];
        return script;
    }

    function characterCapabilities(character) {
        const current = runtime();
        const inspection = inspectCharacterRuntime(character);
        const { regexScripts, helperScripts } = inspection;
        const helper = helperScriptSettings();
        return {
            ...inspection,
            regexScripts,
            helperScripts,
            regexAllowed: regexScripts.length === 0 || Boolean(current.regex?.isCharacterAllowed?.(character)),
            helperAllowed: helperScripts.length === 0 || helper.enabled.characters.includes(character?.name),
            regexPrompted: regexScripts.length > 0 && Boolean(current.accountStorage?.getItem?.(`AlertRegex_${character?.avatar}`)),
            helperPrompted: helperScripts.length > 0 && helper.popuped.characters.includes(character?.name),
        };
    }

    async function inspectPreparedCharacter(character) {
        if (!character) return inspectCharacterRuntime(null);
        const current = runtime();
        const books = [];
        for (const name of characterWorldbookNames(character)) {
            try {
                const book = await current.loadWorldInfo(name);
                if (book) books.push(book);
            } catch (error) {
                console.warn(`[Nora Runtime] Could not inspect Worldbook capabilities: ${name}`, error);
            }
        }
        return inspectCharacterRuntime(character, books);
    }

    async function activateCharacterExtensions(names) {
        const current = runtime();
        const active = new Set(current.getActiveExtensionNames());
        const missing = [...new Set(names)].filter(name => !active.has(name));
        if (missing.length) {
            const activated = new Set(await current.activateExtensionNames(missing));
            const failed = missing.filter(name => !activated.has(name) && !current.getActiveExtensionNames().includes(name));
            if (failed.length) throw new Error(`角色卡运行能力加载失败：${failed.join(', ')}`);
        }
    }

    async function ensureCharacterCapability(character, capability) {
        const normalized = String(capability || '').trim();
        if (!['regex', 'tavern_helper', 'mvu'].includes(normalized)) {
            throw capabilityError('NORA_CAPABILITY_UNSUPPORTED', `Unsupported character capability: ${normalized}`, { retryable: false });
        }
        let inspection;
        try {
            inspection = await inspectPreparedCharacter(character);
            const requiredExtensions = normalized === 'regex'
                ? [REGEX_EXTENSION]
                : [HELPER_EXTENSION, ...(normalized === 'mvu' && inspection.mvuRuntimeSource === 'managed' ? [MVU_EXTENSION] : [])];
            await activateCharacterExtensions(requiredExtensions);
        } catch (error) {
            throw capabilityError(
                `NORA_${normalized.toUpperCase()}_EXTENSION_UNAVAILABLE`,
                `The ${normalized} extension runtime could not be activated.`,
                { cause: error },
            );
        }
        const current = runtime();
        const activeExtensions = new Set(current.getActiveExtensionNames());
        const permissions = characterCapabilities(character);
        if (normalized === 'regex') {
            if (!inspection.regexScripts.length) {
                throw capabilityError('NORA_REGEX_DECLARATION_MISSING', 'The World declares Regex but the Runtime Card has no Regex scripts.', { retryable: false });
            }
            if (!permissions.regexAllowed) {
                throw capabilityError('NORA_REGEX_NOT_AUTHORIZED', 'Regex scripts are not authorized for this Runtime Card.');
            }
            if (!activeExtensions.has('regex')) {
                throw capabilityError('NORA_REGEX_RUNTIME_UNAVAILABLE', 'The Regex extension is not active.');
            }
            return Object.freeze({
                engine: 'sillytavern',
                extension: 'regex',
                extension_active: true,
                script_count: inspection.regexScripts.length,
                character_allowed: true,
            });
        }
        const helperActive = activeExtensions.has(HELPER_EXTENSION);
        if (!helperActive) {
            throw capabilityError('NORA_TAVERN_HELPER_RUNTIME_UNAVAILABLE', 'Tavern Helper / JS Slash Runner is not active.');
        }
        const attachHelperActions = globalThis.__NORA_TAVERN_HELPER_READY__;
        if (typeof attachHelperActions === 'function' && await attachHelperActions() === false) {
            throw capabilityError('NORA_TAVERN_HELPER_ACTION_ADAPTER_UNAVAILABLE', 'Tavern Helper loaded without the Nora action Adapter.');
        }
        if (inspection.helperScripts.length && !permissions.helperAllowed) {
            throw capabilityError('NORA_TAVERN_HELPER_NOT_AUTHORIZED', 'Character scripts are not authorized for this Runtime Card.');
        }
        if (normalized === 'tavern_helper') {
            return Object.freeze({
                engine: 'sillytavern',
                extension: HELPER_EXTENSION,
                extension_active: true,
                script_count: inspection.helperScripts.length,
                character_allowed: true,
            });
        }
        if (!inspection.mvuDeclared) {
            throw capabilityError('NORA_MVU_DECLARATION_MISSING', 'The World declares MVU but no compatible declaration is available.', { retryable: false });
        }
        let mvuRuntime;
        try {
            if (inspection.mvuRuntimeSource === 'embedded') {
                mvuRuntime = await waitForExposedMvuRuntime();
            } else if (typeof globalThis.__NORA_ENSURE_MVU_READY__ === 'function') {
                mvuRuntime = await globalThis.__NORA_ENSURE_MVU_READY__();
            } else if (globalThis.__NORA_MVU_READY_PROMISE__) {
                mvuRuntime = await globalThis.__NORA_MVU_READY_PROMISE__;
            } else {
                throw capabilityError('NORA_MVU_READINESS_UNAVAILABLE', 'MVU did not expose a readiness contract.');
            }
        } catch (error) {
            if (error?.code) throw error;
            const timedOut = /(?:timed?\s*out|did not initialize in time)/i.test(String(error?.message || ''));
            throw capabilityError(
                timedOut ? 'NORA_MVU_TIMEOUT' : 'NORA_MVU_RUNTIME_FAILED',
                timedOut ? 'MVU variable runtime did not initialize in time.' : 'MVU variable runtime failed to initialize.',
                { cause: error },
            );
        }
        const visibleRuntime = typeof mvuRuntime?.getMvuData === 'function' ? mvuRuntime : globalThis.Mvu;
        if (typeof visibleRuntime?.getMvuData !== 'function') {
            throw capabilityError('NORA_MVU_API_UNAVAILABLE', 'MVU loaded without exposing its variable-data interface.');
        }
        let initializationConfirmed = null;
        if (!hasInitializedMvuData(visibleRuntime)
            && typeof visibleRuntime.ensureCurrentChatInitialized === 'function') {
            initializationConfirmed = await visibleRuntime.ensureCurrentChatInitialized();
        }
        const dataInitialized = initializationConfirmed !== false && hasInitializedMvuData(visibleRuntime);
        if (!dataInitialized) {
            throw capabilityError(
                'NORA_MVU_INITVAR_UNAVAILABLE',
                'MVU loaded, but the active chat did not produce an initialized variable snapshot.',
            );
        }
        return Object.freeze({
            engine: 'sillytavern',
            runtime_source: inspection.mvuRuntimeSource,
            helper_active: true,
            api: 'getMvuData',
            api_visible: true,
            runtime_ready: true,
            data_initialized: dataInitialized,
            update_protocol: inspection.mvuUpdateProtocol,
            split_model_supported: inspection.mvuSplitModelSupported,
            update_operational: null,
            update_entry_count: inspection.mvuUpdateEntryIds.length,
            inspection_reasons: [...inspection.mvuReasons],
        });
    }

    function markCharacterCapabilitiesPrompted(character, capabilities = characterCapabilities(character)) {
        const current = runtime();
        if (capabilities.regexScripts.length) current.accountStorage?.setItem?.(`AlertRegex_${character.avatar}`, 'true');
        if (capabilities.helperScripts.length) {
            const helper = helperScriptSettings();
            helper.popuped.characters = [...new Set([...helper.popuped.characters, character.name])];
        }
        saveUiSettings();
    }

    async function enableCharacterCapabilities(character, { reload = false } = {}) {
        const current = runtime();
        const capabilities = characterCapabilities(character);
        markCharacterCapabilitiesPrompted(character, capabilities);
        if (capabilities.regexScripts.length && !capabilities.regexAllowed) current.regex?.allowCharacter?.(character);
        if (capabilities.helperScripts.length && !capabilities.helperAllowed) {
            const helper = helperScriptSettings();
            helper.enabled.characters = [...new Set([...helper.enabled.characters, character.name])];
        }
        saveUiSettings();
        const activeId = Number(current.characterId);
        if (reload && current.characters?.[activeId]?.avatar === character.avatar) {
            await current.reloadCurrentChat?.();
        }
    }

    async function rerenderCharacterChat(avatar) {
        const current = runtime();
        const activeCharacter = current.characters?.[Number(current.characterId)];
        if (!avatar || activeCharacter?.avatar !== avatar || typeof current.reloadCurrentChat !== 'function') return false;
        // Capability completion can arrive after the user starts a generation.
        // Reloading now would clear the live chat; generation owns rendering then.
        if (current.isGenerating?.()) return false;
        await current.reloadCurrentChat();
        return true;
    }

    async function resolveCharacter(characterId) {
        let current = runtime();
        let character = current.characters?.[characterId];
        if (!character) return null;
        if (character.shallow && typeof current.unshallowCharacter === 'function') {
            await current.unshallowCharacter(characterId);
            current = runtime();
            character = current.characters?.[characterId];
        }
        return character || null;
    }

    async function patchCharacter({ avatar, patch }) {
        const current = runtime();
        if (typeof current.getRequestHeaders !== 'function' || typeof current.getCharacters !== 'function') {
            throw new Error('故事运行核心缺少角色编辑能力。');
        }
        const normalizedAvatar = String(avatar || '').trim();
        if (!normalizedAvatar) throw new Error('Character avatar is required for editing.');
        const allowed = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'alternate_greetings'];
        if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw new Error('Character field patch is required.');
        for (const [key, value] of Object.entries(patch)) {
            if (!allowed.includes(key) || (key === 'alternate_greetings' ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : typeof value !== 'string')) throw new Error('Invalid character field.');
        }
        if ('name' in patch && !patch.name.trim()) throw new Error('Character name is required.');
        const normalized = { ...patch, ...('name' in patch ? { name: patch.name.trim() } : {}) };
        const previousName = current.characters?.find(item => item.avatar === normalizedAvatar)?.name;
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: current.getRequestHeaders(),
            body: JSON.stringify({ avatar: normalizedAvatar, ...normalized, data: normalized }),
        });
        if (!response.ok) throw new Error((await response.text()) || `Character update failed (${response.status}).`);
        if (previousName && normalized.name && previousName !== normalized.name) {
            // Helper permissions are keyed by name. Preserve this card's existing consent;
            // keep the old entry because another card can still use the old name.
            const script = current.extensionSettings?.tavern_helper?.script;
            for (const group of [script?.enabled, script?.popuped]) {
                if (group?.characters?.includes(previousName) && !group.characters.includes(normalized.name)) group.characters.push(normalized.name);
            }
            await current.saveSettingsStrict();
        }
        await current.getCharacters();
    }

    async function updateCharacter({ avatar, name, description, personality }) {
        return patchCharacter({ avatar, patch: { name: String(name || '').trim(),
            description: String(description || '').trim(), personality: String(personality || '').trim() } });
    }

    async function deleteCharacterCards({ avatars, deleteChats = true }) {
        const current = runtime();
        if (typeof current.getRequestHeaders !== 'function' || typeof current.getCharacters !== 'function') {
            throw new Error('故事运行核心缺少角色卡删除能力。');
        }
        const normalized = [...new Set((avatars || []).map((avatar) => String(avatar || '').trim()).filter(Boolean))];
        if (!normalized.length) throw new Error('At least one character avatar is required for deletion.');
        for (const avatar of normalized) {
            const response = await fetch('/api/characters/delete', {
                method: 'POST',
                headers: current.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, delete_chats: Boolean(deleteChats) }),
                cache: 'no-cache',
            });
            if (!response.ok) throw new Error((await response.text()) || `Character deletion failed (${response.status}).`);
        }
        await current.getCharacters();
    }

    return Object.freeze({
        isSystemCharacter,
        resolveCharacter,
        characterCapabilities,
        ensureCharacterCapability,
        markCharacterCapabilitiesPrompted,
        enableCharacterCapabilities,
        rerenderCharacterChat,
        refreshCharacters: async () => {
            const current = runtime();
            await current.getCharacters();
            return runtime().characters || [];
        },
        updateCharacter,
        patchCharacter,
        deleteCharacterCards,
        savePersona: async ({ name, description }) => {
            const current = runtime();
            current.setUserName(name, { toastPersonaNameChange: false });
            await current.updatePersonaDescription(description, { syncUi: false });
        },
    });
}
