// Narrow adapter to the upstream stores. Do not mutate ST's serialized copy and
// assume Helper's live reactive store changed with it.
const characterWrites = new Map();

// Shared by Helper's stores and public extension-field API, not just Nora's UI.
export async function persistCharacterExtension(id, field, value, updateLive, deps) {
    const { getCharacter, hydrate, currentId, clone, paths, headers, serialize, fetcher, updateJson } = deps;
    const avatar = getCharacter(id)?.avatar;
    if (!avatar) throw new Error('Character avatar is missing; cannot save extension data.');
    const activeId = currentId();
    const nextValue = value === undefined ? undefined : clone(value);
    const assertTarget = () => {
        if (getCharacter(id)?.avatar !== avatar || String(currentId()) !== String(activeId)) {
            throw new Error('Character changed during save; reopen the script manager.');
        }
    };
    const previous = characterWrites.get(avatar) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
        assertTarget();
        await hydrate(String(id));
        assertTarget();
        const card = getCharacter(id);
        const draft = clone(card);
        if (nextValue === undefined) paths.unset(draft.data.extensions, field);
        else paths.set(draft.data.extensions, field, nextValue);
        if (draft.json_data) {
            const json = JSON.parse(draft.json_data);
            if (nextValue === undefined) paths.unset(json.data.extensions, field);
            else paths.set(json.data.extensions, field, nextValue);
            draft.json_data = JSON.stringify(json);
        }
        const data = draft.data;
        const body = {
            ch_name: draft.name, avatar_url: avatar,
            // ST's full-card formatter otherwise discards foreign fields and resets prompt overrides.
            json_data: draft.json_data || JSON.stringify(draft),
            system_prompt: data.system_prompt, post_history_instructions: data.post_history_instructions,
            depth_prompt_prompt: data.extensions.depth_prompt?.prompt,
            depth_prompt_depth: data.extensions.depth_prompt?.depth,
            depth_prompt_role: data.extensions.depth_prompt?.role,
            character_version: data.character_version, creator: data.creator,
            creator_notes: data.creator_notes, description: data.description,
            first_mes: data.first_mes, alternate_greetings: data.alternate_greetings,
            world: data.extensions.world, extensions: JSON.stringify(data.extensions),
            chat: draft.chat, create_date: draft.create_date, personality: data.personality,
            scenario: data.scenario, mes_example: data.mes_example,
            talkativeness: data.extensions.talkativeness, fav: data.extensions.fav, tags: data.tags,
        };
        const requestHeaders = { ...headers() };
        delete requestHeaders['Content-Type'];
        const response = await fetcher('/api/characters/edit', {
            method: 'POST', headers: requestHeaders, body: serialize(body), cache: 'no-cache',
        });
        if (!response.ok) throw new Error(`Character extension save failed (HTTP ${response.status}).`);
        assertTarget();
        if (updateLive) {
            // Commit only this field; other in-memory fields may have changed while saving.
            if (nextValue === undefined) paths.unset(card.data.extensions, field);
            else paths.set(card.data.extensions, field, clone(nextValue));
            if (card.json_data) {
                const json = JSON.parse(card.json_data);
                if (nextValue === undefined) paths.unset(json.data.extensions, field);
                else paths.set(json.data.extensions, field, clone(nextValue));
                card.json_data = JSON.stringify(json);
                if (String(id) === String(currentId())) updateJson(card.json_data);
            }
        }
    });
    characterWrites.set(avatar, work);
    try { await work; }
    finally { if (characterWrites.get(avatar) === work) characterWrites.delete(avatar); }
}

export function synchronizeHelperRuntimeReadiness(globalStore, { documentRef = globalThis.document } = {}) {
    if (documentRef?.documentElement?.dataset?.noraAppReadyMs) globalStore.app_ready = true;
    return Boolean(globalStore.app_ready);
}

export function createHelperControlAdapter({ globalStore, scopeStore, scopeOwner = () => null, validateSettings, clone, flushScope }) {
    function assign(target, source) {
        for (const [key, value] of Object.entries(source)) {
            if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) assign(target[key], value);
            else target[key] = value;
        }
    }
    return Object.freeze({
        settings: () => clone(globalStore().settings),
        configure(next) {
            // Audio/render consumers may hold refs to nested objects. Preserve those identities.
            assign(globalStore().settings, validateSettings(next));
        },
        scope(type) {
            const store = scopeStore(type);
            if (type !== 'global' && (!store.source || store.source === 'unknown')) throw new Error('Helper scope is not available.');
            return { source: store.source, enabled: store.enabled, ownerId: scopeOwner(type) };
        },
        setScopeEnabled(type, enabled) { scopeStore(type).enabled = Boolean(enabled); },
        async flush(type, expectedSource) {
            // Allow upstream watchers to observe the edit before synchronizing storage.
            await Promise.resolve();
            if (this.scope(type).source !== expectedSource) throw new Error('Helper scope changed during the edit.');
            await flushScope(type);
        },
    });
}
