import { normalizeStoryContext } from '../../public/scripts/nora-worlds/story-context.js';
import { cloneJson } from './domain.js';

// Copy authored configuration, never a session header or a progressed cast snapshot.
export function restartStoryContext(value) {
    if (!value) return undefined;
    const source = normalizeStoryContext(value);
    return normalizeStoryContext({
        schema_version: 1,
        characters: source.characters.map(character => ({
            id: character.id,
            profile: cloneJson(character.profile),
            persistent_status: {},
            ...Object.fromEntries(['activation', 'performance', 'entry', 'source_avatar', 'tags']
                .filter(key => character[key] !== undefined).map(key => [key, cloneJson(character[key])])),
        })),
        player: { profile: cloneJson(source.player.profile), persistent_status: {} },
        relationships: [],
        author_note: source.author_note,
        language: source.language,
        ...(source.card_profile_enabled === undefined ? {} : { card_profile_enabled: source.card_profile_enabled }),
        ...(source.removed_card_fields === undefined ? {} : { removed_card_fields: source.removed_card_fields }),
    });
}
