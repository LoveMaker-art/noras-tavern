// World-owned cast snapshots. Runtime cards and library templates are not cast identities.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value);
const invalid = () => { throw new TypeError('Invalid World story context or entity reference.'); };

export function normalizeStoryContext(value) {
    if (!object(value) || value.schema_version !== 1 || !Array.isArray(value.characters)
        || !Array.isArray(value.relationships) || !object(value.player)) invalid();
    const result = clone(value);
    const ids = new Set(['__user__']);
    for (const character of result.characters) {
        if (!object(character) || !id(character.id) || ids.has(character.id) || !object(character.profile)
            || !object(character.profile.identity) || typeof character.profile.identity.name !== 'string'
            || !character.profile.identity.name.trim() || !object(character.persistent_status)) invalid();
        ids.add(character.id);
    }
    if (!object(result.player.profile) || !object(result.player.persistent_status)) invalid();
    const relationships = new Set();
    for (const edge of result.relationships) {
        if (!object(edge) || !id(edge.id) || relationships.has(edge.id)
            || !Array.isArray(edge.participants) || edge.participants.length !== 2
            || edge.participants[0] === edge.participants[1] || !edge.participants.every(key => ids.has(key))
            || typeof edge.description !== 'string') invalid();
        relationships.add(edge.id);
    }
    if (typeof result.author_note !== 'string' || !['zh', 'zh-Hant', 'en'].includes(result.language)) invalid();
    return result;
}

export function storyEntityBindings(context, playerName = '') {
    const characters = context ? normalizeStoryContext(context).characters : [];
    return Object.fromEntries([
        ['__user__', { name: playerName, role: 'player-controlled persona only' }],
        ...characters.map(character => [character.id, { name: character.profile.identity.name, role: 'participating character' }]),
    ]);
}

export function renderStoryContext(value) {
    if (!value) return '';
    const context = normalizeStoryContext(value);
    const characters = context.characters.map(character => ({ id: character.id, profile: character.profile,
        persistent_status: character.persistent_status, performance: character.performance || {}, entry: character.entry || {} }));
    return 'World character context. Each id denotes one independent actor. __user__ is the player; do not write their choices. '
        + 'Profiles and relationships describe the saved state. Newer conversation and story ledger take precedence for subsequent events. '
        + `Continue in ${context.language}.\n`
        + JSON.stringify({ characters, player: context.player, relationships: context.relationships, author_note: context.author_note });
}

function text(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join('; ');
    if (object(value)) return Object.entries(value).filter(([, item]) => text(item)).map(([key, item]) => `${key}: ${text(item)}`).join('\n');
    return '';
}

export function storyCharacterView(character, context = null) {
    const profile = character.profile;
    const relationships = context?.relationships.filter(edge => edge.participants.includes(character.id))
        .map(edge => edge.description) || [];
    return { name: profile.identity.name, avatar: character.source_avatar || '', tags: character.tags || [],
        data: { name: profile.identity.name, description: text({ ...profile, personality: undefined, persistent_status: character.persistent_status, relationships }),
            personality: text(profile.personality), scenario: character.entry?.initial_scenario || '',
            first_mes: character.entry?.first_message || '', mes_example: character.entry?.example_dialogue || '' } };
}

export function editStoryCharacter(value, command) {
    const context = normalizeStoryContext(value);
    if (!object(command) || !id(command.id) || !object(command.patch)
        || Object.keys(command.patch).some(key => !['name', 'description', 'personality', 'profile', 'persistent_status'].includes(key))) invalid();
    const character = context.characters.find(item => item.id === command.id);
    if (!character) invalid();
    const patch = command.patch;
    for (const key of ['name', 'description', 'personality']) if (key in patch && typeof patch[key] !== 'string') invalid();
    if ('profile' in patch) {
        if (!object(patch.profile) || !object(patch.profile.identity)) invalid();
        character.profile = clone(patch.profile);
    }
    if ('persistent_status' in patch) {
        if (!object(patch.persistent_status)) invalid();
        character.persistent_status = clone(patch.persistent_status);
    }
    if ('name' in patch) character.profile.identity.name = patch.name;
    if ('description' in patch) character.profile.identity.description = patch.description;
    if ('personality' in patch) character.profile.personality = { ...character.profile.personality, summary: patch.personality };
    character.name = character.profile.identity.name;
    return normalizeStoryContext(context);
}
