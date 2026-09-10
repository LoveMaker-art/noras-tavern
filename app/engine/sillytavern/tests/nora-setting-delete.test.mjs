import assert from 'node:assert/strict';
import test from 'node:test';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';
import { createWorldbookController } from '../../../native-extensions/nora-ui/worldbook-controller.js';
import { createStoryContext, editStoryCharacter } from '../public/scripts/nora-worlds/story-context.js';

for (const type of ['character', 'card-profile', 'worldbook', 'scenario']) {
    test(`${type} deletion requires confirmation and guards cancellation, generation, World changes and save failure`, async () => {
        for (const state of ['success', 'cancel', 'generating', 'busy', 'switch', 'start-generation', 'conflict']) {
            let context = editStoryCharacter(createStoryContext(), { id: 'alice', operation: 'create', patch: { name: 'Alice' } });
            context = editStoryCharacter(context, { id: 'bob', operation: 'create', patch: { name: 'Bob' } });
            context.relationships.push({ id: 'edge', participants: ['alice', 'bob'], description: 'friends' });
            let world = { id: 'world:a', revision: 3, storyContext: context };
            const before = structuredClone(world);
            let generating = state === 'generating'; let confirmations = 0; let writes = 0;
            let book = { entries: { 0: { comment: 'Rule', content: 'Rule text' }, 7: { content: 'Sibling' } } };
            const notices = [];
            const update = async (patch, options) => {
                if (state === 'conflict') throw new Error('Revision conflict');
                assert.equal(options.expectedRevision, 3);
                assert.equal(world.id, 'world:a');
                writes++;
                if (patch.character) world.storyContext = editStoryCharacter(world.storyContext, patch.character);
                else world.storyContext.removed_card_fields = patch.removeSetting === 'scenario' ? ['scenario'] : ['description', 'personality', 'scenario'];
            };
            const shared = { activeWorldModel: () => world, isGenerating: () => generating,
                operations: { isBusy: () => state === 'busy', run: async (_key, fn) => fn() },
                dialogs: { confirm: async () => {
                    confirmations++;
                    if (state === 'switch') world = { ...world, id: 'world:b' };
                    if (state === 'start-generation') generating = true;
                    return state !== 'cancel';
                }, toast: value => notices.push(value), normalizeError: error => error.message },
                reloadWorlds: async () => {}, refresh() {}, onChanged() {},
            };
            const character = { data: { extensions: { world: 'book' } } };
            const controller = type === 'character' || type === 'card-profile'
                ? createCharacterController({ ...shared, updateWorld: update })
                : createWorldbookController({ ...shared, readState: () => ({ world: { metadata: { nora_world: { id: world.id } } } }),
                    worldRuntime: { updateActive: update }, currentCharacter: () => character, characterField: () => 'Original background',
                    store: { cachedWorldbook: () => book, cacheWorldbook: (_name, value) => { book = value; } },
                    worldbook: { loadWorldbook: async () => book, saveWorldbookEntry: async (_name, source, id, patch, worldId, options) => {
                        assert.equal(worldId, 'world:a'); assert.equal(patch, null); assert.equal(options.operation, 'delete');
                        if (state === 'conflict') throw new Error('Revision conflict');
                        writes++;
                        const result = structuredClone(source); delete result.entries[id];
                        return { book: result, resource: { binding: { name: 'private-book' } } };
                    } },
                });
            const control = { disabled: false };
            if (type === 'character' || type === 'card-profile') await controller.removeSetting(type === 'character' ? 'world-character:alice' : type, control);
            else await controller.removeEntry(type === 'scenario' ? 'scenario' : 'embedded', '0', control);
            assert.equal(writes, state === 'success' ? 1 : 0, state);
            assert.equal(confirmations, ['generating', 'busy'].includes(state) ? 0 : 1);
            assert.equal(control.disabled, false);
            if (state !== 'success') assert.deepEqual(world.storyContext, before.storyContext);
            if (state === 'success' && type === 'character') {
                assert.deepEqual(world.storyContext.characters.map(c => c.id), ['bob']);
                assert.deepEqual(world.storyContext.relationships, []);
            }
            if (state === 'success' && type === 'worldbook') assert.deepEqual(book.entries, { 7: { content: 'Sibling' } });
            if (state === 'success' && type === 'scenario') assert.equal(controller.scenario(character), '', 'deleted background cannot fall back to card data');
        }
    });
}
