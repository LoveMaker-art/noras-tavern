import { normalizeStoryContext, renderStoryContext } from './story-context.js';
import { resolveCharacterReference, resolveCharacterReferences } from './character-references.js';

// Live projection only. The World manifest owns the data; no separate lorebook is saved.
// The product bundle and ST import-map extensions share one page projection.
const state = globalThis[Symbol.for('tavern.character-activation')] ??= { active: null, worldId: '' };

export function setWorldCharacterContext(value, id = '') {
    state.active = value ? normalizeStoryContext(value) : null;
    state.worldId = id;
}

export function resolveWorldCharacterReference(id) {
    return resolveCharacterReference(id, state.active?.characters);
}

export function validateWorldCharacterReferences(value) {
    resolveCharacterReferences(value, state.active?.characters, { strict: true });
}

export function getWorldCharacterEntries() {
    const { active, worldId } = state;
    if (!active) return [];
    return active.characters.filter(character => character.activation?.mode === 'triggered').map(character => {
        const activation = character.activation;
        return {
            world: `nora-characters:${worldId}`, uid: character.id,
            comment: character.profile.identity.name,
            content: renderStoryContext(active, { characterIds: [character.id], includePlayer: false }),
            constant: false, key: [...activation.keys], keysecondary: [...activation.secondaryKeys],
            selective: true, selectiveLogic: activation.selectiveLogic ?? 0,
            scanDepth: activation.scanDepth ?? null,
            sticky: activation.sticky ?? null, cooldown: activation.cooldown ?? null, delay: activation.delay ?? null,
            caseSensitive: activation.caseSensitive ?? null, matchWholeWords: activation.matchWholeWords ?? null,
            // Character context must not activate itself or other characters through recursion.
            excludeRecursion: true, preventRecursion: true,
            useProbability: false, probability: 100, order: 100, position: 0,
        };
    });
}
