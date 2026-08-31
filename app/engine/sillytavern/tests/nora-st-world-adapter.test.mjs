import assert from 'node:assert/strict';
import test from 'node:test';

import { createStWorldAdapter } from '../public/scripts/nora-adapters/st-world-adapter.js';

test('saves the World persona without hydrating the hidden ST persona UI', async () => {
    const calls = [];
    const runtime = {
        characters: [],
        characterId: null,
        chatId: '',
        chat: [],
        chatMetadata: {},
        powerUserSettings: { persona_description: '' },
        name1: '',
        selectCharacterById() {},
        updateChatMetadata() {},
        saveMetadata() {},
        setUserName(name, options) { calls.push(['name', name, options]); },
        async updatePersonaDescription(description, options) { calls.push(['description', description, options]); },
    };
    const adapter = createStWorldAdapter(() => runtime);

    await adapter.savePersona({ name: 'Nora', description: 'Traveler' });

    assert.deepEqual(calls, [
        ['name', 'Nora', { toastPersonaNameChange: false }],
        ['description', 'Traveler', { syncUi: false }],
    ]);
});

test('delegates aggregate activation to one native snapshot transaction', async () => {
    const calls = [];
    const runtime = {
        characters: [{ avatar: 'one.png' }], characterId: null, chatId: '', chat: [], chatMetadata: {},
        powerUserSettings: { persona_description: '' }, name1: '',
        selectCharacterById() {}, updateChatMetadata() {}, saveMetadata() {},
        async activateNoraWorldSnapshot(characterId, snapshot) {
            calls.push({ characterId, snapshot });
        },
    };
    const adapter = createStWorldAdapter(() => runtime);
    const snapshot = { schema: 'nora-world-snapshot/v1', revision: 'one' };
    await adapter.activateSnapshot(0, snapshot);
    assert.deepEqual(calls, [{ characterId: 0, snapshot }]);
});
