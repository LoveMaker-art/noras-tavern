import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createStoryContext, editStoryCharacter, normalizeStoryContext, renderStoryContext } from '../public/scripts/nora-worlds/story-context.js';
import { getWorldCharacterEntries, setWorldCharacterContext } from '../public/scripts/nora-worlds/character-activation.js';

function add(context, id, name, activation) {
    return editStoryCharacter(context, { operation: 'create', id, patch: {
        name, description: '{{char}} repairs machines for {{user}}.', personality: 'cautious', activation,
    } });
}

test('multiple profiles: create/edit/delete preserve other profiles and do not mutate input', () => {
    const initial = createStoryContext({ name: 'Player', description: 'commander' });
    let context = add(initial, 'actor:a', 'Alice', { mode: 'constant' });
    context = add(context, 'actor:b', 'Bob', { mode: 'triggered', keys: ['shop'] });
    const saved = structuredClone(context);
    context = editStoryCharacter(context, { id: 'actor:a', patch: { personality: 'cheerful' } });
    assert.equal(initial.characters.length, 0);
    assert.equal(saved.characters[0].profile.personality.summary, 'cautious');
    assert.deepEqual(context.characters[1], saved.characters[1]);
    context.relationships.push({ id: 'edge:ab', participants: ['actor:a', 'actor:b'], description: 'friends' });
    context = editStoryCharacter(context, { id: 'actor:a', operation: 'delete' });
    assert.deepEqual(context.characters.map(x => x.id), ['actor:b']);
    assert.equal(context.relationships.length, 0);
    assert.equal(context.player.profile.identity.name, 'Player');
});

test('triggered profiles never leak into constant context; own char macro binds per actor', () => {
    let context = add(createStoryContext(), 'actor:a', 'Alice', { mode: 'constant' });
    context = add(context, 'actor:b', 'Bob', { mode: 'triggered', keys: ['shop'], sticky: 2 });
    context.relationships.push({ id: 'edge:ab', participants: ['actor:a', 'actor:b'], description: 'secret-friendship' });
    const prompt = renderStoryContext(context);
    assert.match(prompt, /Alice repairs machines for \{\{user\}\}/);
    assert.match(prompt, /secret-friendship/);
    assert.doesNotMatch(prompt, /Bob repairs machines/);
    setWorldCharacterContext(context, 'world:one');
    const entries = getWorldCharacterEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].uid, 'actor:b');
    assert.equal(entries[0].world, 'nora-characters:world:one');
    assert.equal(entries[0].sticky, 2);
    assert.match(entries[0].content, /Bob repairs machines/);
    assert.match(entries[0].content, /secret-friendship/);
    assert.doesNotMatch(entries[0].content, /Alice repairs machines/);
    assert.equal(entries[0].preventRecursion, true);
    assert.equal(entries[0].useProbability, false);
    // A consumer must not mutate the live projection through returned scan entries.
    entries[0].key.push('mutated');
    assert.deepEqual(getWorldCharacterEntries()[0].key, ['shop']);
    setWorldCharacterContext(null);
    assert.deepEqual(getWorldCharacterEntries(), []);
});

test('relationships follow the selected actor, not the other actor activation or presence', () => {
    let context = add(createStoryContext({ name: 'Player' }), 'actor:a', 'Alice', { mode: 'constant' });
    context = add(context, 'actor:b', 'Bob', { mode: 'triggered', keys: ['shop'] });
    context = add(context, 'actor:c', 'Carol', { mode: 'triggered', keys: ['gate'] });
    context = add(context, 'actor:d', 'Dan', { mode: 'triggered', keys: ['harbor'] });
    context.relationships = [
        { id: 'edge:ab', participants: ['actor:a', 'actor:b'], description: 'friends' },
        { id: 'edge:bc', participants: ['actor:b', 'actor:c'], description: 'owes money' },
        { id: 'edge:cd', participants: ['actor:c', 'actor:d'], description: 'siblings' },
        { id: 'edge:uc', participants: ['__user__', 'actor:c'], description: 'neighbors' },
    ];
    const saved = structuredClone(context);
    const payload = prompt => JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    const constant = payload(renderStoryContext(context));
    assert.deepEqual(constant.characters.map(x => x.id), ['actor:a']);
    assert.deepEqual(constant.relationships.map(x => x.id), ['edge:ab', 'edge:uc']);
    assert.deepEqual(constant.referenced_characters, [{ id: 'actor:b', name: 'Bob' }, { id: 'actor:c', name: 'Carol' }]);
    setWorldCharacterContext(context, 'world:relations');
    try {
        const entries = getWorldCharacterEntries();
        const bob = payload(entries.find(x => x.uid === 'actor:b').content);
        assert.deepEqual(bob.characters.map(x => x.id), ['actor:b']);
        assert.deepEqual(bob.relationships.map(x => x.id), ['edge:ab', 'edge:bc']);
        assert.deepEqual(bob.referenced_characters, [{ id: 'actor:a', name: 'Alice' }, { id: 'actor:c', name: 'Carol' }]);
        assert.ok(!('player' in bob));
        const both = payload(renderStoryContext(context, { characterIds: ['actor:b', 'actor:c'], includePlayer: false }));
        assert.equal(both.relationships.filter(x => x.id === 'edge:bc').length, 1);
        assert.deepEqual(payload(renderStoryContext(context, { characterIds: [], includePlayer: false })).relationships, []);
        assert.deepEqual(context, saved, 'projection must not change profiles, activation or state');
    } finally { setWorldCharacterContext(null); }
});

test('old contexts remain constant; invalid modes, empty trigger keys and duplicate IDs are rejected', () => {
    const context = add(createStoryContext(), 'actor:a', 'Alice', { mode: 'constant' });
    delete context.characters[0].activation;
    assert.match(renderStoryContext(context), /Alice/);
    assert.deepEqual(normalizeStoryContext(context), context);
    assert.throws(() => add(context, 'actor:b', 'Bob', { mode: 'triggered', keys: [] }));
    assert.throws(() => add(context, 'actor:a', 'Duplicate', { mode: 'constant' }));
    assert.throws(() => add(context, '__user__', 'Impersonate', { mode: 'constant' }));
    assert.throws(() => add(context, 'actor:b', 'Bob', { mode: 'unknown' }));
    assert.throws(() => add(context, 'actor:b', 'Bob', { mode: 'triggered', keys: ['x'], scanDepth: -1 }));
});

test('projected characters use the actual ST scanner for match, non-match, secondary keys and budget', async () => {
    const source = fs.readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
    function declaration(marker) {
        const start = source.indexOf(marker);
        assert.ok(start >= 0);
        return source.slice(start, source.indexOf('\n}', start) + 2).replace(/^export /, '');
    }
    let context = add(createStoryContext(), 'actor:b', 'Bob', {
        mode: 'triggered', keys: ['shop'], secondaryKeys: ['enter'], selectiveLogic: 0, scanDepth: 1,
    });
    context = add(context, 'actor:c', 'Carol', { mode: 'triggered', keys: ['Carol'] });
    context.relationships.push({ id: 'edge:bc', participants: ['actor:b', 'actor:c'], description: 'owes money' });
    setWorldCharacterContext(context, 'world:scan');
    const sandbox = {
        console: { debug() {}, log() {}, warn() {}, error() {} },
        scan_state: { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 },
        world_info_logic: { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 },
        world_info_position: { before: 0, after: 1 }, MAX_SCAN_DEPTH: 1000, DEFAULT_DEPTH: 4,
        world_info_depth: 2, world_info_case_sensitive: false, world_info_match_whole_words: false,
        world_info_budget: 25, world_info_budget_cap: 0, world_info_max_recursion_steps: 0,
        world_info_recursive: true, world_info_min_activations: 0, world_info_min_activations_depth_max: 0,
        world_info_overflow_alert: false, extension_settings: {}, chat_metadata: {}, shouldWIAddPrompt: false,
        defaultGlobalScanData: {}, getContext: () => ({ extensionPrompts: {} }),
        getSortedEntries: async () => getWorldCharacterEntries().map(entry => ({ decorators: [], hash: 123, ...entry })),
        parseRegexFromString: () => null, substituteParams: value => value,
        getTokenCountAsync: async value => Math.ceil(value.length / 4),
        shouldSuppressNoraMvuUpdateEntryForMainPrompt: () => false,
        filterByInclusionGroups() {}, eventSource: { emit: async () => {} }, event_types: {},
        sortFn: (a, b) => b.order - a.order, getRegexedString: value => value, regex_placement: { WORLD_INFO: 0 },
        saveMetadata() {}, getCurrentChatId: () => 'scan-test',
    };
    vm.createContext(sandbox);
    vm.runInContext([
        declaration('class WorldInfoBuffer'), declaration('class WorldInfoTimedEffects'),
        declaration('export async function checkWorldInfo'),
        'globalThis.scan = checkWorldInfo;',
    ].join('\n'), sandbox);
    const scan = (messages, budget = 32000) => sandbox.scan(messages, budget, true, {});
    assert.equal((await scan(['hello'])).allActivatedEntries.size, 0);
    assert.equal((await scan(['shop'])).allActivatedEntries.size, 0);
    assert.equal((await scan(['hello', 'enter shop'])).allActivatedEntries.size, 0);
    const matched = await scan(['enter shop']);
    assert.equal(matched.allActivatedEntries.size, 1);
    assert.match(matched.worldInfoBefore, /Bob repairs machines/);
    assert.match(matched.worldInfoBefore, /owes money/);
    assert.match(matched.worldInfoBefore, /Carol/);
    assert.doesNotMatch(matched.worldInfoBefore, /Carol repairs machines/);
    const both = await scan(['enter shop Carol']);
    assert.equal(both.allActivatedEntries.size, 2);
    assert.match(both.worldInfoBefore, /Carol repairs machines/);
    assert.equal((await scan(['enter shop'], 4)).allActivatedEntries.size, 0);
    assert.equal((await scan(['enter shop'])).allActivatedEntries.size, 1);
    setWorldCharacterContext(null);
    assert.equal((await scan(['enter shop'])).allActivatedEntries.size, 0);
});
