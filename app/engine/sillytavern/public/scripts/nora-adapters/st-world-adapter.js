import { interactionBridge } from '../nora-compat/interaction-bridge.js';
import { renderStoryContext, normalizeWorldPersona } from '../nora-worlds/story-context.js';
import { setWorldCharacterContext } from '../nora-worlds/character-activation.js';
import { createWorldPreset, normalizeWorldPreset, validateWorldPresetParameters, validateWorldPresetModelLimits, WORLD_PRESET_FIELDS } from '../nora-worlds/world-preset.js';
import { worldPresetProjection } from '../nora-worlds/world-preset-projection.js';
import { worldbookOverrides } from '../nora-worlds/worldbook-bindings.js';
function requireRuntime(getContext) {
    const current = getContext();
    const required = ['selectCharacterById', 'updateChatMetadata', 'saveMetadata'];
    const missing = required.filter((name) => typeof current?.[name] !== 'function');
    if (!Array.isArray(current?.characters) || missing.length) {
        throw new Error(`故事运行核心缺少世界能力：${missing.join(', ') || 'characters'}`);
    }
    return current;
}

function persona(current) {
    return {
        name: String(current.name1 || '').trim(),
        description: String(current.powerUserSettings?.persona_description || '').trim(),
    };
}

function normalizeCharacterId(value) {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

function uniqueNames(values) {
    return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

export function createStWorldAdapter(getContext) {
    let hasStoryContext = false;
    let presetBaseline;
    function captureWorldPreset() {
        const current = requireRuntime(getContext);
        current.getChatCompletionPromptManager();
        const settings = current.chatCompletionSettings;
        const fields = current.chatCompletionPresetFields;
        const preset = { prompts: settings.prompts, prompt_order: settings.prompt_order };
        for (const key of WORLD_PRESET_FIELDS) {
            const setting = fields[key]?.[1];
            if (setting && settings[setting] !== undefined) preset[key] = settings[setting];
        }
        const value = createWorldPreset(settings.preset_settings_openai || 'Default', preset);
        presetBaseline ??= structuredClone(value);
        return value;
    }
    function defaultWorldPreset() {
        return structuredClone(presetBaseline || captureWorldPreset());
    }
    function validateWorldPreset(value) {
        validateWorldPresetParameters(value.preset, requireRuntime(getContext).getChatCompletionModelLimits?.());
    }
    function applyWorldPreset(value) {
        const snapshot = normalizeWorldPreset(value);
        const current = requireRuntime(getContext);
        if (current.isGenerating?.()) throw new Error('请等待当前生成完成。');
        const baseline = defaultWorldPreset();
        const settings = current.chatCompletionSettings;
        const manager = current.getChatCompletionPromptManager();
        const project = () => {
            for (const key of WORLD_PRESET_FIELDS) {
                const setting = current.chatCompletionPresetFields[key]?.[1];
                if (!setting) continue;
                const field = snapshot.preset[key] ?? baseline.preset[key];
                if (field === undefined) delete settings[setting];
                else settings[setting] = field;
            }
            settings.prompts = structuredClone(snapshot.preset.prompts);
            settings.prompt_order = structuredClone(snapshot.preset.prompt_order);
            manager.sanitizeServiceSettings();
        };
        project();
        worldPresetProjection.bind(current.chatMetadata?.nora_world?.id, () => {
            validateWorldPresetModelLimits(snapshot.preset, current.getChatCompletionModelLimits?.());
            project();
        });
        // No preset selection event: world switching must not execute template scripts.
    }
    function applyStoryContext(context, worldId = null) {
        const current = requireRuntime(getContext);
        if (!context && !hasStoryContext) { setWorldCharacterContext(null); return; }
        if (typeof current.setExtensionPrompt !== 'function') throw new Error('World story context is unavailable.');
        current.setExtensionPrompt('nora_world_story_context', renderStoryContext(context), 0, 4, false, 0);
        setWorldCharacterContext(context, worldId ?? current.chatMetadata?.nora_world?.id ?? '');
        hasStoryContext = Boolean(context);
    }
    function read() {
        const current = requireRuntime(getContext);
        const activeCharacterId = normalizeCharacterId(current.characterId);
        return Object.freeze({
            characters: current.characters,
            activeCharacterId,
            activeCharacter: activeCharacterId === null ? null : current.characters[activeCharacterId] || null,
            chatId: String(current.chatId || '').replace(/\.jsonl$/i, ''),
            messages: current.chat || [],
            metadata: current.chatMetadata || {},
            persona: persona(current),
        });
    }

    function ensureCharacter(character) {
        const current = requireRuntime(getContext);
        const avatar = String(character?.avatar || '').trim();
        if (!avatar || !String(character?.name || '').trim()) {
            throw new Error('世界快照缺少有效的运行角色卡。');
        }
        const replacement = structuredClone(character);
        const existingId = current.characters.findIndex(item => item?.avatar === avatar);
        if (existingId >= 0) {
            current.characters[existingId] = replacement;
            return existingId;
        }
        current.characters.push(replacement);
        return current.characters.length - 1;
    }

    async function expandCharacter(characterId) {
        let current = requireRuntime(getContext);
        const character = current.characters[characterId];
        if (!character?.shallow) return read();
        if (typeof current.unshallowCharacter !== 'function') {
            throw new Error('故事运行核心缺少运行卡展开能力。');
        }
        await current.unshallowCharacter(characterId);
        return read();
    }

    async function ensureEmbeddedWorldbook(character) {
        const embeddedBook = character?.data?.character_book;
        if (!embeddedBook) return;
        const current = requireRuntime(getContext);
        const names = uniqueNames([
            character?.data?.extensions?.world,
            embeddedBook.name,
            `${character.name || 'Character'}'s Lorebook`,
        ]);
        const bookName = names[0];
        const required = ['convertCharacterBook', 'saveWorldInfo', 'updateWorldInfoList'];
        const missing = required.filter((name) => typeof current[name] !== 'function');
        if (missing.length) {
            throw new Error(`故事运行核心缺少内嵌世界书能力：${missing.join(', ')}。`);
        }
        await current.updateWorldInfoList();
        const knownBooks = typeof current.getWorldInfoNames === 'function' ? current.getWorldInfoNames() : [];
        const knownBookSet = new Set(knownBooks.map(name => String(name || '').trim()));
        if (names.some(name => knownBookSet.has(name))) return;
        await current.saveWorldInfo(bookName, current.convertCharacterBook(embeddedBook), true);
        await current.updateWorldInfoList();
    }

    async function refreshWorldbooks() {
        await requireRuntime(getContext).updateWorldInfoList();
        return read();
    }

    async function applyWorldbook(name, book, world) {
        const current = requireRuntime(getContext);
        const normalized = String(name || '').trim();
        if (!normalized || !book || typeof book !== 'object') throw new Error('World settings projection is invalid.');
        if (typeof current.primeWorldInfoSnapshot !== 'function' || typeof current.updateWorldInfoList !== 'function') {
            throw new Error('故事运行核心缺少世界书投影能力。');
        }
        const characterId = normalizeCharacterId(current.characterId);
        const character = characterId === null ? null : current.characters[characterId];
        if (!character) throw new Error('当前世界的运行角色卡不可用。');
        const data = character.data && typeof character.data === 'object' ? character.data : character;
        if (world && current.chatMetadata?.nora_world?.id !== world.world_id) throw new Error('World changed; reopen the settings.');
        if (world) {
            const metadata = current.chatMetadata;
            metadata.world_info = normalized;
            metadata.nora_world.worldbook_overrides = worldbookOverrides(world.knowledge);
            metadata.nora_world.library_worldbooks = world.knowledge.filter(resource => resource.binding.name !== normalized)
                .map(resource => ({ name: resource.binding.name, title: resource.binding.display_name || resource.binding.name }));
        }
        data.extensions = { ...(data.extensions || {}), world: normalized };
        current.primeWorldInfoSnapshot(normalized, book);
        await current.updateWorldInfoList();
        return read();
    }

    async function activate(characterId, chatId) {
        interactionBridge.assertSessionIdle();
        await requireRuntime(getContext).selectCharacterById(characterId, {
            switchMenu: false,
            chatId,
            persistChat: false,
        });
        return read();
    }

    async function activateSnapshot(characterId, snapshot) {
        interactionBridge.assertSessionIdle();
        const current = requireRuntime(getContext);
        if (typeof current.activateNoraWorldSnapshot !== 'function') {
            throw new Error('故事运行核心缺少聚合世界快照能力。');
        }
        await current.activateNoraWorldSnapshot(characterId, snapshot);
        applyStoryContext(snapshot.plan?.story_context, snapshot.plan?.world_id);
        if (snapshot.plan?.preset) applyWorldPreset(snapshot.plan.preset);
        return read();
    }

    async function saveMetadata(patch) {
        const current = requireRuntime(getContext);
        current.updateChatMetadata(patch);
        await current.saveMetadata();
        return read();
    }

    async function savePersona(value) {
        if (!value) return read();
        const current = requireRuntime(getContext);
        if (typeof current.setUserName !== 'function' || typeof current.updatePersonaDescription !== 'function') {
            throw new Error('故事运行核心缺少世界身份能力。');
        }
        const identity = normalizeWorldPersona(value);
        current.setUserName(identity.name, { toastPersonaNameChange: false });
        await current.updatePersonaDescription(identity.description, { syncUi: false });
        return read();
    }

    async function deleteChat(characterId, chatId) {
        const current = requireRuntime(getContext);
        if (typeof current.deleteCharacterChatByName !== 'function') {
            throw new Error('故事运行核心缺少世界删除能力。');
        }
        return current.deleteCharacterChatByName(characterId, chatId);
    }

    async function closeChat() {
        const current = requireRuntime(getContext);
        if (typeof current.closeCurrentChat !== 'function') {
            throw new Error('故事运行核心缺少当前世界关闭能力。');
        }
        const result = await current.closeCurrentChat();
        applyStoryContext(null);
        worldPresetProjection.clear();
        return result;
    }

    return Object.freeze({ read, ensureCharacter, expandCharacter, ensureEmbeddedWorldbook, refreshWorldbooks, applyWorldbook, activate, activateSnapshot, applyStoryContext, captureWorldPreset, defaultWorldPreset, validateWorldPreset, applyWorldPreset, saveMetadata, savePersona, deleteChat, closeChat });
}
