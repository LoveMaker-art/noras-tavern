import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiStore } from '../../../native-extensions/nora-ui/ui-store.js';

test('projects runtime and World state through one snapshot', () => {
    const runtimeState = {
        activeCharacterId: 1,
        characters: [{ name: 'First' }, { name: 'Active' }],
        user: { name: 'Nora', description: 'Traveler' },
    };
    const settings = { activeModel: 'deepseek' };
    const state = { snapshot: () => runtimeState };
    const settingsDomain = { uiSettings: () => settings };
    const worlds = {
        list: () => [{ id: 'world-1', persona: { name: 'Player', description: 'Hero' }, active: true }],
    };
    const store = createUiStore(state, settingsDomain, worlds);

    const snapshot = store.read();

    assert.equal(snapshot.settings, settings);
    assert.equal(snapshot.activeWorld.id, 'world-1');
    assert.equal(snapshot.currentCharacter.name, 'Active');
    assert.deepEqual(snapshot.persona, { name: 'Player', description: 'Hero' });
});

test('uses runtime persona when no World is active and owns the Worldbook cache', () => {
    const state = { snapshot: () => ({ activeCharacterId: 0, characters: [], user: { name: 'Nora', description: 'Traveler' } }) };
    const settingsDomain = { uiSettings: () => ({}) };
    const store = createUiStore(state, settingsDomain, { list: () => [] });
    const book = { entries: { 0: { content: 'Lore' } } };

    assert.deepEqual(store.read().persona, { name: 'Nora', description: 'Traveler' });
    assert.equal(store.cacheWorldbook('  lore  ', book), book);
    assert.equal(store.cachedWorldbook('lore'), book);
    store.clearWorldbook('lore');
    assert.equal(store.cachedWorldbook('lore'), undefined);
});

test('store never passes recent chats into a World list', () => {
    let receivedArguments = -1;
    const state = { snapshot: () => ({ activeCharacterId: null, characters: [], user: { name: '', description: '' } }) };
    const settingsDomain = { uiSettings: () => ({}) };
    const worlds = {
        mode: 'v2',
        list(...args) {
            receivedArguments = args.length;
            return [{ id: 'world:v2', active: false }];
        },
        status: () => ({ operation: { status: 'IDLE' }, worlds: 1 }),
    };
    const store = createUiStore(state, settingsDomain, worlds);

    const snapshot = store.read();
    assert.equal(receivedArguments, 0);
    assert.deepEqual(snapshot.worldModels.map(world => world.id), ['world:v2']);
    assert.equal(snapshot.worldStatus.worlds, 1);
});
