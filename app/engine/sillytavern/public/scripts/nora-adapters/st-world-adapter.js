import { interactionBridge } from '../nora-compat/interaction-bridge.js';
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
        current.setUserName(String(value.name || '').trim(), { toastPersonaNameChange: false });
        await current.updatePersonaDescription(String(value.description || '').trim(), { syncUi: false });
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
        return current.closeCurrentChat();
    }

    return Object.freeze({ read, expandCharacter, ensureEmbeddedWorldbook, refreshWorldbooks, activate, activateSnapshot, saveMetadata, savePersona, deleteChat, closeChat });
}
