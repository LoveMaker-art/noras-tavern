/* global globalThis */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStCardAdapter } from '../public/scripts/nora-adapters/st-card-adapter.js';

const HELPER_EXTENSION = 'third-party/JS-Slash-Runner';

function runtimeContext(character, { active = ['regex', HELPER_EXTENSION], regexAllowed = true, helperAllowed = true } = {}) {
    return {
        characters: [character],
        characterId: 0,
        extensionSettings: {
            tavern_helper: {
                script: {
                    enabled: { global: true, presets: [], characters: helperAllowed ? [character.name] : [] },
                    popuped: { presets: [], characters: [] },
                },
            },
        },
        accountStorage: { getItem: () => null, setItem() {} },
        regex: {
            isCharacterAllowed: () => regexAllowed,
            allowCharacter() {},
        },
        getActiveExtensionNames: () => [...active],
        activateExtensionNames: async names => names,
        loadWorldInfo: async () => null,
    };
}

function characterWithCapabilities() {
    return {
        name: '测试角色',
        avatar: '测试角色.png',
        data: {
            character_book: { entries: [{ comment: '[initvar]', content: '{}' }] },
            extensions: {
                regex_scripts: [{ scriptName: '显示规则' }],
                tavern_helper: {
                    scripts: [{
                        type: 'script',
                        name: 'MVU Runtime',
                        enabled: true,
                        content: 'await import(\'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js\')',
                    }],
                },
            },
        },
    };
}

test('proves Regex readiness from extension activation, scripts and character authorization', async () => {
    const character = characterWithCapabilities();
    const context = runtimeContext(character);
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    assert.deepEqual(await adapter.ensureCharacterCapability(character, 'regex'), {
        engine: 'sillytavern',
        extension: 'regex',
        extension_active: true,
        script_count: 1,
        character_allowed: true,
    });
});

test('activates Regex on demand before reporting the capability ready', async () => {
    const character = characterWithCapabilities();
    const active = new Set();
    const activations = [];
    const context = runtimeContext(character, { active: [] });
    context.getActiveExtensionNames = () => [...active];
    context.activateExtensionNames = async (names) => {
        activations.push([...names]);
        names.forEach(name => active.add(name));
        return names;
    };
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    const evidence = await adapter.ensureCharacterCapability(character, 'regex');

    assert.deepEqual(activations, [['regex']]);
    assert.equal(evidence.extension_active, true);
});

test('proves Tavern Helper readiness from Runner activation, scripts and character authorization', async () => {
    const character = characterWithCapabilities();
    const context = runtimeContext(character);
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    assert.deepEqual(await adapter.ensureCharacterCapability(character, 'tavern_helper'), {
        engine: 'sillytavern',
        extension: HELPER_EXTENSION,
        extension_active: true,
        script_count: 1,
        character_allowed: true,
    });
});

test('notifies the Nora action Adapter after Tavern Helper activation', async (t) => {
    const previous = globalThis.__NORA_TAVERN_HELPER_READY__;
    t.after(() => {
        if (previous === undefined) delete globalThis.__NORA_TAVERN_HELPER_READY__;
        else globalThis.__NORA_TAVERN_HELPER_READY__ = previous;
    });
    let notifications = 0;
    globalThis.__NORA_TAVERN_HELPER_READY__ = () => { notifications += 1; return true; };
    const character = characterWithCapabilities();
    const context = runtimeContext(character);
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    await adapter.ensureCharacterCapability(character, 'tavern_helper');

    assert.equal(notifications, 1);
});

test('proves embedded MVU readiness only when its public variable-data interface is visible', async (t) => {
    const previousMvu = globalThis.Mvu;
    t.after(() => {
        if (previousMvu === undefined) delete globalThis.Mvu;
        else globalThis.Mvu = previousMvu;
    });
    globalThis.Mvu = { getMvuData: () => ({ stat_data: {}, schema: {} }) };
    const character = characterWithCapabilities();
    const context = runtimeContext(character);
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    assert.deepEqual(await adapter.ensureCharacterCapability(character, 'mvu'), {
        engine: 'sillytavern',
        runtime_source: 'embedded',
        helper_active: true,
        api: 'getMvuData',
        api_visible: true,
        runtime_ready: true,
        data_initialized: true,
    });
});

test('reports runtime readiness separately when MVU variable data is not initialized yet', async (t) => {
    const previousMvu = globalThis.Mvu;
    t.after(() => {
        if (previousMvu === undefined) delete globalThis.Mvu;
        else globalThis.Mvu = previousMvu;
    });
    globalThis.Mvu = { getMvuData() {} };
    const character = characterWithCapabilities();
    const context = runtimeContext(character);
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    const evidence = await adapter.ensureCharacterCapability(character, 'mvu');
    assert.equal(evidence.runtime_ready, true);
    assert.equal(evidence.data_initialized, false);
});

test('returns a stable error code when a declared capability is not authorized', async () => {
    const character = characterWithCapabilities();
    const context = runtimeContext(character, { regexAllowed: false });
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    await assert.rejects(
        adapter.ensureCharacterCapability(character, 'regex'),
        error => error?.code === 'NORA_REGEX_NOT_AUTHORIZED' && error?.retryable === true,
    );
});

test('activates only the extension dependencies of the capability being checked', async (t) => {
    const previousEnsure = globalThis.__NORA_ENSURE_MVU_READY__;
    t.after(() => {
        if (previousEnsure === undefined) delete globalThis.__NORA_ENSURE_MVU_READY__;
        else globalThis.__NORA_ENSURE_MVU_READY__ = previousEnsure;
    });
    globalThis.__NORA_ENSURE_MVU_READY__ = async () => ({ getMvuData() {} });
    const character = {
        name: '管理型 MVU 角色',
        avatar: 'managed-mvu.png',
        data: {
            character_book: { entries: [{ comment: '[initvar]', content: '{}' }] },
            extensions: { tavern_helper: { scripts: [] } },
        },
    };
    const active = new Set(['regex']);
    const activations = [];
    const context = runtimeContext(character, { active: [] });
    context.getActiveExtensionNames = () => [...active];
    context.activateExtensionNames = async (names) => {
        activations.push([...names]);
        names.forEach(name => active.add(name));
        return names;
    };
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    await adapter.ensureCharacterCapability(character, 'tavern_helper');
    await adapter.ensureCharacterCapability(character, 'mvu');

    assert.deepEqual(activations, [
        [HELPER_EXTENSION],
        ['third-party/nora-mvu'],
    ]);
});

test('rerenders only while the requested Runtime Card is still active', async () => {
    const character = characterWithCapabilities();
    const context = runtimeContext(character);
    let reloads = 0;
    context.reloadCurrentChat = async () => { reloads += 1; };
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    assert.equal(await adapter.rerenderCharacterChat(character.avatar), true);
    assert.equal(await adapter.rerenderCharacterChat('another-world.png'), false);
    assert.equal(reloads, 1);
});

test('saves a card persona without hydrating the hidden ST persona UI', async () => {
    const calls = [];
    const context = runtimeContext(characterWithCapabilities());
    context.setUserName = (name, options) => calls.push(['name', name, options]);
    context.updatePersonaDescription = async (description, options) => calls.push(['description', description, options]);
    const adapter = createStCardAdapter(() => context, { saveUiSettings() {} });

    await adapter.savePersona({ name: 'Nora', description: 'Traveler' });

    assert.deepEqual(calls, [
        ['name', 'Nora', { toastPersonaNameChange: false }],
        ['description', 'Traveler', { syncUi: false }],
    ]);
});
