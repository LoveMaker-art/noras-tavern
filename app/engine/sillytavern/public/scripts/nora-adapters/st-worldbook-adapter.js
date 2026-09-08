import { contentRevision } from '../nora-controls/revision.js';
import { worldbookOverrides } from '../nora-worlds/worldbook-bindings.js';

export function createStWorldbookAdapter(runtime) {
    const readRevisions = new WeakMap();
    async function loadWorldbook(name, { fallback = null, fresh = false } = {}) {
        const normalized = String(name || '').trim();
        if (!normalized) return fallback;
        const current = runtime();
        let book = null;
        try {
            if (fresh) {
                const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: current.getRequestHeaders(),
                    body: JSON.stringify({ name: normalized }), cache: 'no-store', signal: AbortSignal.timeout(30000) });
                if (!response.ok) throw new Error(`Worldbook read failed (${response.status}).`);
                book = await response.json();
                current.primeWorldInfoSnapshot?.(normalized, book);
            } else book = await current.loadWorldInfo(normalized);
        } catch (error) {
            if (!fallback) throw error;
            console.warn(`[Nora Runtime] Restoring missing Worldbook: ${normalized}`, error);
        }
        if ((!book || typeof book !== 'object') && fallback) {
            book = typeof current.convertCharacterBook === 'function'
                ? current.convertCharacterBook(fallback)
                : structuredClone(fallback);
            await current.saveWorldInfo(normalized, book, true);
            await current.updateWorldInfoList?.();
        }
        if (book && typeof book === 'object') readRevisions.set(book, await contentRevision(book));
        return book || fallback;
    }

    async function saveWorldbook(name, book, { expectedRevision = readRevisions.get(book) } = {}) {
        await runtime().saveWorldInfo(String(name || '').trim(), book, true, { expectedRevision });
        readRevisions.set(book, await contentRevision(book));
    }

    async function saveWorldbookEntry(name, book, entryId, patch, worldId) {
        const current = runtime();
        if (!worldId || current.chatMetadata?.nora_world?.id !== worldId) throw new Error('World changed; reopen the editor.');
        const response = await fetch(`/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/worldbook-entry`, {
            method: 'POST', headers: current.getRequestHeaders(),
            body: JSON.stringify({ name, entry_id: entryId, patch, expected_revision: readRevisions.get(book) || (!name ? await contentRevision(book) : undefined) }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || result.error?.message || `Worldbook save failed (${response.status}).`);
        readRevisions.set(result.book, await contentRevision(result.book));
        if (current.chatMetadata?.nora_world?.id !== worldId) return result;
        try {
            const nextName = result.resource.binding.name;
            const character = current.characters[current.characterId];
            const data = character?.data || character;
            if (data && (data.extensions?.world === name || (!name && result.resource.binding.embedded))) {
                data.extensions = { ...data.extensions, world: nextName };
            }
            if (result.resource.binding.embedded && data) delete data.character_book;
            if (current.chatMetadata.world_info === name) current.chatMetadata.world_info = nextName;
            current.chatMetadata.nora_world.worldbook_overrides = worldbookOverrides(result.world?.knowledge || [result.resource]);
            current.primeWorldInfoSnapshot(nextName, result.book);
            await current.updateWorldInfoList();
        } catch (error) {
            throw Object.assign(new Error('Worldbook saved; reopen this World to load the changes.'), { saved: true, result, cause: error });
        }
        return result;
    }

    async function saveWorldScenario(scenario) {
        const current = runtime();
        const normalized = String(scenario || '').trim();
        if (normalized) current.chatMetadata.scenario = normalized;
        else delete current.chatMetadata.scenario;
        await current.saveMetadata();
    }

    async function updateEmbeddedWorldbook({ avatar, book }) {
        const current = runtime();
        if (typeof current.getRequestHeaders !== 'function' || typeof current.getCharacters !== 'function') {
            throw new Error('故事运行核心缺少内嵌世界书编辑能力。');
        }
        const normalizedAvatar = String(avatar || '').trim();
        if (!normalizedAvatar) throw new Error('Character avatar is required for editing an embedded Worldbook.');
        if (!book || typeof book !== 'object') throw new Error('Embedded Worldbook data is required.');
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: current.getRequestHeaders(),
            body: JSON.stringify({ avatar: normalizedAvatar, data: { character_book: book } }),
        });
        if (!response.ok) throw new Error((await response.text()) || `Embedded Worldbook update failed (${response.status}).`);
        await current.getCharacters();
    }

    return Object.freeze({
        loadWorldbook,
        saveWorldbook,
        saveWorldbookEntry,
        saveWorldScenario,
        updateEmbeddedWorldbook,
    });
}
