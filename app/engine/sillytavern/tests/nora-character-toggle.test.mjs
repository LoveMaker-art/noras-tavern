import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createStoryContext, editStoryCharacter, normalizeCharacterActivation, renderStoryContext } from '../public/scripts/nora-worlds/story-context.js';
import { setWorldCharacterContext, getWorldCharacterEntries, isWorldCardProfileEnabled } from '../public/scripts/nora-worlds/character-activation.js';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';

function fixture() {
    let context = createStoryContext();
    for (const [id, activation] of [['alice', { mode: 'constant' }], ['bob', {
        mode: 'triggered', keys: ['shop'], secondaryKeys: ['enter'], sticky: 2, cooldown: 3,
    }]]) context = editStoryCharacter(context, { id, operation: 'create', patch: { name: id, description: `${id}-private-profile`, activation } });
    context.relationships.push({ id: 'friends', participants: ['alice', 'bob'], description: 'private-relation' });
    return context;
}

test('disable suppresses constant, explicit, relationship and triggered injections without deleting data', () => {
    const original = fixture();
    let context = original;
    for (const character of original.characters) {
        context = editStoryCharacter(context, { id: character.id, patch: { activation: { ...character.activation, enabled: false } } });
    }
    assert.doesNotMatch(renderStoryContext(context), /private-profile|private-relation/);
    assert.doesNotMatch(renderStoryContext(context, { characterIds: ['alice', 'bob'], includePlayer: false }), /private-profile|private-relation/);
    setWorldCharacterContext(context, 'world:test');
    try {
        assert.deepEqual(getWorldCharacterEntries(), []);
        for (const character of context.characters) {
            context = editStoryCharacter(context, { id: character.id, patch: { activation: { ...character.activation, enabled: true } } });
        }
        assert.match(renderStoryContext(context), /alice-private-profile/);
        assert.doesNotMatch(renderStoryContext(context), /bob-private-profile/);
        setWorldCharacterContext(context, 'world:test');
        assert.equal(getWorldCharacterEntries()[0].sticky, 2);
        assert.equal(getWorldCharacterEntries()[0].cooldown, 3);
        assert.deepEqual(getWorldCharacterEntries()[0].key, ['shop']);
        assert.match(getWorldCharacterEntries()[0].content, /bob-private-profile/);
        assert.deepEqual(context.relationships, original.relationships);
        assert.deepEqual(context.characters.map(x => x.profile), original.characters.map(x => x.profile));
    } finally { setWorldCharacterContext(null); }
    for (const enabled of [null, 0, 'false', undefined]) {
        assert.throws(() => normalizeCharacterActivation({ mode: 'constant', enabled }));
    }
    assert.equal(normalizeCharacterActivation().mode, 'constant');
    assert.match(renderStoryContext(original), /alice-private-profile/);
});

test('toggle saves revision-guarded World mutation and preserves other characters and trigger rules', async () => {
    let world = { id: 'world:test', revision: 3, storyContext: fixture() };
    const original = structuredClone(world);
    let generating = false; let busy = false; let fail = false; let duringRun = () => {};
    let writes = 0; const notices = [];
    const attrs = new Map();
    const control = { disabled: false, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) };
    const controller = createCharacterController({
        activeWorldModel: () => world, isGenerating: () => generating,
        operations: { isBusy: () => busy, run: async (_key, fn) => { duringRun(); return fn(); } },
        dialogs: { toast: text => notices.push(text), normalizeError: error => error.message },
        reloadWorlds: async () => {}, refresh() {},
        updateWorld: async (command, options) => {
            if (fail) throw new Error('revision conflict');
            assert.equal(options.expectedRevision, world.revision);
            world = { ...world, revision: world.revision + 1, storyContext: editStoryCharacter(world.storyContext, command.character) };
            writes++;
        },
    });
    await controller.toggleInjection('world-character:bob', control);
    assert.equal(writes, 1);
    assert.equal(world.storyContext.characters[1].activation.enabled, false);
    assert.deepEqual(world.storyContext.characters[0], original.storyContext.characters[0]);
    await controller.toggleInjection('world-character:bob', control);
    assert.equal(world.storyContext.characters[1].activation.enabled, true);
    assert.deepEqual(world.storyContext.characters[1].activation.keys, ['shop']);
    assert.equal(world.storyContext.characters[1].activation.sticky, 2);
    const saved = structuredClone(world);
    fail = true;
    await controller.toggleInjection('world-character:bob', control);
    assert.deepEqual(world, saved);
    assert.match(notices.at(-1), /revision conflict/);
    fail = false; generating = true;
    await controller.toggleInjection('world-character:bob', control);
    generating = false; busy = true;
    await controller.toggleInjection('world-character:bob', control);
    busy = false; duringRun = () => { generating = true; };
    await controller.toggleInjection('world-character:bob', control);
    generating = false; duringRun = () => { world = { ...world, id: 'world:other' }; };
    await controller.toggleInjection('world-character:bob', control);
    await controller.toggleInjection(0, control);
    assert.equal(writes, 2, 'busy, generation races, changed World and legacy rows cannot write');
    assert.equal(control.disabled, false);
    assert.equal(attrs.has('aria-busy'), false);
    assert.deepEqual(original.storyContext, fixture(), 'source data stays intact');
});

test('original card toggle reaches the actual prompt field getters without changing card data or greetings', () => {
    const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    assert.match(source, /import \{ isWorldCardProfileEnabled \} from '.\/scripts\/nora-worlds\/character-activation.js'/);
    const start = source.indexOf('export function getCharacterCardFieldsLazy(');
    const code = source.slice(start, source.indexOf('\n}', start) + 2).replace('export ', '');
    const card = { description: 'DESC', personality: 'PERSONALITY', scenario: 'SCENE', first_mes: 'OPENING', mes_example: 'EXAMPLE',
        data: { system_prompt: 'SYSTEM', extensions: { depth_prompt: { prompt: 'DEPTH' } } } };
    const snapshot = structuredClone(card);
    const sandbox = { characters: [card, card], this_chid: 0, chat_metadata: { nora_world: { id: 'world:a' } },
        power_user: { persona_description: 'PLAYER', prefer_character_prompt: true }, baseChatReplace: value => value,
        isWorldCardProfileEnabled, createLazyFields: resolvers => Object.fromEntries(Object.entries(resolvers).map(([key, get]) => [key, get()])),
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const fields = () => sandbox.getCharacterCardFieldsLazy();
    setWorldCharacterContext({ ...fixture(), card_profile_enabled: false }, 'world:a');
    try {
        for (const key of ['description', 'personality', 'scenario']) assert.equal(fields()[key], '');
        assert.equal(fields().firstMessage, 'OPENING');
        assert.equal(fields().mesExamples, 'EXAMPLE');
        assert.equal(fields().system, 'SYSTEM');
        assert.equal(fields().charDepthPrompt, 'DEPTH');
        assert.equal(fields().persona, 'PLAYER');
        assert.equal(sandbox.getCharacterCardFieldsLazy({ chid: 1 }).description, 'DESC');
        sandbox.chat_metadata.nora_world.id = 'world:b';
        assert.equal(fields().description, 'DESC', 'shared card in another World is unaffected');
        sandbox.chat_metadata.nora_world.id = 'world:a';
        setWorldCharacterContext({ ...fixture(), card_profile_enabled: true }, 'world:a');
        assert.equal(fields().description, 'DESC');
        setWorldCharacterContext(fixture(), 'world:a');
        assert.equal(fields().personality, 'PERSONALITY', 'old worlds default to enabled');
        setWorldCharacterContext({ ...fixture(), removed_card_fields: ['scenario'] }, 'world:a');
        assert.equal(fields().scenario, '', 'removed background must not fall back to the original card');
        assert.equal(fields().description, 'DESC');
        setWorldCharacterContext({ ...fixture(), card_profile_enabled: true, removed_card_fields: ['description', 'personality', 'scenario'] }, 'world:a');
        assert.equal(fields().description, '', 'reenabling injection does not resurrect a removed setting');
        assert.equal(fields().firstMessage, 'OPENING');
        setWorldCharacterContext(null);
        assert.equal(fields().scenario, 'SCENE', 'leaving a World resets the projection');
        assert.deepEqual(card, snapshot);
    } finally { setWorldCharacterContext(null); }
});

test('original card UI toggle saves a world-level boolean even when no independent cast exists', async () => {
    let world = { id: 'world:legacy', revision: 7 };
    const writes = [];
    const controller = createCharacterController({ activeWorldModel: () => world,
        operations: { isBusy: () => false, run: async (_key, fn) => fn() },
        dialogs: { toast() {}, normalizeError: error => error.message }, refresh() {}, reloadWorlds: async () => {},
        updateWorld: async (patch, options) => {
            assert.equal(options.expectedRevision, world.revision);
            writes.push(patch);
            world = { ...world, revision: world.revision + 1, storyContext: { ...createStoryContext(), card_profile_enabled: patch.cardProfileEnabled } };
        },
    });
    const control = { disabled: false, setAttribute() {}, removeAttribute() {} };
    await controller.toggleInjection('card-profile', control);
    await controller.toggleInjection('card-profile', control);
    assert.deepEqual(writes, [{ cardProfileEnabled: false }, { cardProfileEnabled: true }]);
});
