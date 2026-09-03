import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createManagedMvuRuntimeLoader,
    MVU_BUNDLE_URL,
    resolveMvuZodUrl,
} from '../../../native-extensions/nora-mvu/runtime.js';
import { createStCardAdapter, inspectCharacterRuntime } from '../public/scripts/nora-adapters/st-card-adapter.js';

function characterWithScripts(scripts, characterBook = null) {
    return {
        name: '测试角色',
        avatar: '测试角色.png',
        data: {
            character_book: characterBook,
            extensions: {
                tavern_helper: { scripts },
            },
        },
    };
}

test('managed MVU uses the local extension asset from inside the Helper iframe', () => {
    assert.match(
        MVU_BUNDLE_URL,
        /^\/scripts\/extensions\/third-party\/nora-mvu\/vendor\/bundle\.js\?v=[a-f0-9]{12}-nora[1-9]\d*$/,
    );
});

test('managed MVU resolves its pinned Zod runtime from local extension assets', () => {
    assert.equal(
        resolveMvuZodUrl('https://example.test/extension-assets/release-a/scripts/extensions/third-party/nora-mvu/runtime.js'),
        'https://example.test/extension-assets/release-a/scripts/extensions/third-party/nora-mvu/vendor/zod.iife.js?v=4.1.11',
    );
});

test('managed MVU waits for Helper, registers its iframe script, then waits for the public API', async () => {
    const events = [];
    const expected = { getMvuData() {} };
    const load = createManagedMvuRuntimeLoader({
        waitForHelper: async () => {
            events.push('helper-ready');
            return {};
        },
        ensureScript: async () => {
            events.push('script-registered');
            return 'unchanged';
        },
        waitForRuntime: async () => {
            events.push('runtime-ready');
            return expected;
        },
    });

    assert.equal(await load(), expected);
    assert.deepEqual(events, [
        'helper-ready',
        'script-registered',
        'runtime-ready',
    ]);
});

test('an embedded MVU Runtime is the sole owner for its card', () => {
    const inspection = inspectCharacterRuntime(characterWithScripts([{
        type: 'script',
        enabled: true,
        content: "await import('https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js')",
    }]));

    assert.equal(inspection.mvuRuntimeSource, 'embedded');
    assert.deepEqual(inspection.extensions, ['third-party/JS-Slash-Runner']);
});

test('MVU declarations without an embedded Runtime select the managed owner', () => {
    const inspection = inspectCharacterRuntime(characterWithScripts([], {
        entries: [{ comment: '[initvar]', content: '{}' }],
    }));

    assert.equal(inspection.mvuRuntimeSource, 'managed');
    assert.deepEqual(inspection.extensions, [
        'third-party/JS-Slash-Runner',
        'third-party/nora-mvu',
    ]);
});

test('an embedded MVU Runtime never calls the managed Runtime ensure path', async () => {
    const previousMvu = globalThis.Mvu;
    const previousEnsure = globalThis.__NORA_ENSURE_MVU_READY__;
    let managedCalls = 0;
    try {
        globalThis.Mvu = { getMvuData: () => ({ stat_data: {}, schema: {} }) };
        globalThis.__NORA_ENSURE_MVU_READY__ = async () => { managedCalls += 1; };
        const character = characterWithScripts([{
            type: 'script',
            enabled: true,
            content: "await import('https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js')",
        }]);
        const context = {
            getActiveExtensionNames: () => ['third-party/JS-Slash-Runner'],
            extensionSettings: { tavern_helper: { script: { enabled: { characters: [character.name] } } } },
        };
        const adapter = createStCardAdapter(() => context, { saveUiSettings: () => {} });

        const evidence = await adapter.ensureCharacterCapability(character, 'mvu');

        assert.equal(evidence.runtime_source, 'embedded');
        assert.equal(evidence.runtime_ready, true);
        assert.equal(managedCalls, 0);
    } finally {
        if (previousMvu === undefined) delete globalThis.Mvu;
        else globalThis.Mvu = previousMvu;
        if (previousEnsure === undefined) delete globalThis.__NORA_ENSURE_MVU_READY__;
        else globalThis.__NORA_ENSURE_MVU_READY__ = previousEnsure;
    }
});
