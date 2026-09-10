import { resolveCharacterReferences } from './character-references.js';

// World-owned cast snapshots. Runtime cards and library templates are not cast identities.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value);
const invalid = () => { throw new TypeError('Invalid World story context or entity reference.'); };

export function normalizeCharacterActivation(value = { mode: 'constant' }) {
    if (!object(value) || !['constant', 'triggered'].includes(value.mode)) invalid();
    const allowed = ['enabled', 'mode', 'keys', 'secondaryKeys', 'selectiveLogic', 'scanDepth', 'sticky', 'cooldown', 'delay', 'caseSensitive', 'matchWholeWords'];
    if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
    if ('enabled' in value && typeof value.enabled !== 'boolean') invalid();
    const result = { ...value };
    for (const key of ['keys', 'secondaryKeys']) {
        const values = value[key] ?? [];
        if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) invalid();
        result[key] = [...new Set(values.map(item => item.trim()).filter(Boolean))];
    }
    if (value.mode === 'triggered' && !result.keys.length) throw new TypeError('触发角色至少需要一个关键词。');
    for (const key of ['scanDepth', 'sticky', 'cooldown', 'delay', 'selectiveLogic']) {
        if (value[key] != null && (!Number.isInteger(value[key]) || value[key] < 0)) invalid();
    }
    if (value.selectiveLogic > 3 || value.scanDepth > 1000) invalid();
    for (const key of ['caseSensitive', 'matchWholeWords']) {
        if (value[key] != null && typeof value[key] !== 'boolean') invalid();
    }
    return result;
}

export function createStoryContext(persona = {}) {
    return { schema_version: 1, characters: [], relationships: [],
        player: { profile: { identity: { ...persona } }, persistent_status: {} }, author_note: '', language: 'zh' };
}

export function normalizeStoryContext(value) {
    if (!object(value) || value.schema_version !== 1 || !Array.isArray(value.characters)
        || !Array.isArray(value.relationships) || !object(value.player)) invalid();
    const result = clone(value);
    if ('card_profile_enabled' in result && typeof result.card_profile_enabled !== 'boolean') invalid();
    if ('removed_card_fields' in result && (!Array.isArray(result.removed_card_fields)
        || result.removed_card_fields.some(field => !['description', 'personality', 'scenario'].includes(field)))) invalid();
    const ids = new Set(['__user__']);
    for (const character of result.characters) {
        if (!object(character) || !id(character.id) || ids.has(character.id) || !object(character.profile)
            || !object(character.profile.identity) || typeof character.profile.identity.name !== 'string'
            || !character.profile.identity.name.trim() || !object(character.persistent_status)) invalid();
        ids.add(character.id);
        if (character.activation !== undefined) character.activation = normalizeCharacterActivation(character.activation);
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

export function renderStoryContext(value, { characterIds = null, includePlayer = true } = {}) {
    if (!value) return '';
    const context = normalizeStoryContext(value);
    const disabledIds = new Set(context.characters.filter(character => character.activation?.enabled === false).map(character => character.id));
    const selected = context.characters.filter(character => !disabledIds.has(character.id) && (characterIds
        ? characterIds.includes(character.id) : character.activation?.mode !== 'triggered'));
    const ids = new Set(selected.map(character => character.id));
    if (includePlayer) ids.add('__user__');
    // Relationships are background of the selected entities, not an attendance list.
    // Carry direct relationships only; never expand the other participant's profile.
    const relationships = context.relationships.filter(edge => !edge.participants.some(id => disabledIds.has(id))
        && edge.participants.some(id => ids.has(id)));
    const referencedIds = new Set(relationships.flatMap(edge => edge.participants).filter(id => !ids.has(id)));
    const referencedCharacters = context.characters.filter(character => referencedIds.has(character.id))
        .map(character => ({ id: character.id, name: character.profile.identity.name }));
    function bindCharacter(value, name) {
        if (typeof value === 'string') return value.replace(/\{\{char\}\}/gi, () => name);
        if (Array.isArray(value)) return value.map(item => bindCharacter(item, name));
        if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindCharacter(item, name)]));
        return value;
    }
    const characters = selected.map(character => bindCharacter({ id: character.id, profile: character.profile,
        persistent_status: character.persistent_status, performance: character.performance || {}, entry: character.entry || {} }, character.profile.identity.name));
    return 'World character context. Each id denotes one independent actor. __user__ is the player; do not write their choices. '
        + 'Profiles and relationships describe the saved state. Newer conversation and story ledger take precedence for subsequent events. '
        + 'Profiles and relationship references do not imply scene presence; referenced_characters provides names only. '
        + `Continue in ${context.language}.\n`
        + JSON.stringify(resolveCharacterReferences({ characters, ...(includePlayer ? { player: context.player, author_note: context.author_note } : {}),
            relationships, ...(referencedCharacters.length ? { referenced_characters: referencedCharacters } : {}) }, context.characters));
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
    if (!object(command) || !id(command.id) || !['update', 'create', 'delete'].includes(command.operation ?? 'update')) invalid();
    let character = context.characters.find(item => item.id === command.id);
    if (command.operation === 'delete') {
        if (!character) invalid();
        context.characters = context.characters.filter(item => item.id !== command.id);
        context.relationships = context.relationships.filter(edge => !edge.participants.includes(command.id));
        return normalizeStoryContext(context);
    }
    if (!object(command.patch)
        || Object.keys(command.patch).some(key => !['name', 'description', 'personality', 'profile', 'persistent_status', 'activation'].includes(key))) invalid();
    if (command.operation === 'create') {
        if (character || command.id === '__user__') invalid();
        character = { id: command.id, profile: { identity: { name: '' } }, persistent_status: {} };
        context.characters.push(character);
    }
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
    if ('activation' in patch) character.activation = normalizeCharacterActivation(patch.activation);
    character.name = character.profile.identity.name;
    return normalizeStoryContext(context);
}
