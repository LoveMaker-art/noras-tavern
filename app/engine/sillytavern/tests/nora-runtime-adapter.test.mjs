import assert from 'node:assert/strict';
import test from 'node:test';

import { createStRuntimeAdapter } from '../public/scripts/nora-adapters/st-runtime-adapter.js';
import { inspectCharacterRuntime } from '../public/scripts/nora-adapters/st-card-adapter.js';

function createRuntime(sendText) {
    return {
        characterId: 0,
        chatId: 'phase-1-chat',
        chat: [{ is_user: false, is_system: false, mes: 'Opening message' }],
        onlineStatus: 'Valid',
        mainApi: 'openai',
        chatCompletionSettings: {
            chat_completion_source: 'custom',
            custom_url: 'https://api.example.com/v1',
            custom_model: 'test-model',
        },
        customApiKeyConfigured: true,
        hasCustomChatCompletionApiKey() { return this.customApiKeyConfigured; },
        sendText,
        stopGeneration() {},
        regenerate() {},
        commitMessageEdit() {},
        deleteLastMessage() {},
        saveChat() {},
        generateRaw() {},
        configureCustomChatCompletion() {},
        clearCustomChatCompletion() {},
        activateExtensionNames: async () => [],
        getActiveExtensionNames: () => [],
        loadWorldInfo: async () => null,
        getRequestHeaders() { return { 'Content-Type': 'application/json' }; },
        async getCharacters() {},
    };
}

test('clearModelConfiguration delegates complete backend removal to the runtime', async () => {
    const runtime = createRuntime(() => {});
    let cleared = 0;
    runtime.clearCustomChatCompletion = async () => { cleared += 1; };

    await createStRuntimeAdapter(() => runtime).clearModelConfiguration();

    assert.equal(cleared, 1);
});

test('switching models rotates the model-owned credential before applying its endpoint', async () => {
    const runtime = createRuntime(() => {});
    const events = [];
    runtime.configureCustomChatCompletion = async options => events.push(['configure', options]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        events.push([url, body]);
        if (url.endsWith('/read')) {
            return { ok: true, status: 200, json: async () => ({ api_key_custom: [{ id: 'user-secret', active: true }] }) };
        }
        return { ok: true, status: 204, json: async () => ({}) };
    };
    try {
        const result = await createStRuntimeAdapter(() => runtime).configureModel({
            base: 'https://hermes.invalid/v1',
            model: 'deepseek-v4-flash',
            context: 200000,
            tokens: 30000,
            secretId: 'hermes-secret',
        });
        assert.deepEqual(result, { secretId: 'hermes-secret' });
        assert.deepEqual(events.map(event => event[0]), [
            '/api/secrets/read',
            '/api/secrets/rotate',
            'configure',
        ]);
        assert.equal(events[1][1].id, 'hermes-secret');
        assert.equal(events[2][1].apiKey, '');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('saving a user model binds the returned credential id to that model', async () => {
    const runtime = createRuntime(() => {});
    runtime.configureCustomChatCompletion = async () => {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (url.endsWith('/read')) {
            return { ok: true, status: 200, json: async () => ({ api_key_custom: [{ id: 'hermes-secret', active: true }] }) };
        }
        if (url.endsWith('/write')) {
            return { ok: true, status: 200, json: async () => ({ id: 'user-secret' }) };
        }
        throw new Error(`Unexpected request: ${url}`);
    };
    try {
        const result = await createStRuntimeAdapter(() => runtime).configureModel({
            name: '我的模型',
            base: 'https://user.invalid/v1',
            model: 'user-model',
            context: 32000,
            tokens: 4000,
        }, 'user-key');
        assert.deepEqual(result, { secretId: 'user-secret' });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('assertModelConfigured accepts a saved keyless custom endpoint profile', () => {
    const runtime = createRuntime(() => {});
    runtime.customApiKeyConfigured = false;
    runtime.chatCompletionSettings = {
        chat_completion_source: 'custom',
        custom_url: 'http://127.0.0.1:11434/v1',
        custom_model: 'local-model',
    };

    assert.equal(createStRuntimeAdapter(() => runtime).assertModelConfigured(), true);
});

test('inspectCharacterRuntime keeps an ordinary card on the baseline runtime', () => {
    const inspection = inspectCharacterRuntime({
        name: 'Plain Card',
        data: { extensions: {} },
    });

    assert.equal(inspection.mvuDeclared, false);
    assert.deepEqual(inspection.extensions, []);
});

test('the Helper capability activates only JS-Slash-Runner for an EJS helper card', async () => {
    const runtime = createRuntime(() => {});
    const activations = [];
    const active = new Set();
    runtime.getActiveExtensionNames = () => [...active];
    runtime.activateExtensionNames = async (names) => {
        activations.push([...names]);
        names.forEach(name => active.add(name));
        return [...names];
    };
    const card = {
        name: 'EJS Card',
        data: {
            extensions: {
                tavern_helper: { scripts: [{ type: 'script', name: 'render' }] },
            },
        },
    };

    runtime.extensionSettings = { tavern_helper: { script: { enabled: { characters: [card.name] } } } };
    const evidence = await createStRuntimeAdapter(() => runtime).ensureCharacterCapability(card, 'tavern_helper');

    assert.equal(evidence.extension_active, true);
    assert.equal(evidence.script_count, 1);
    assert.deepEqual(activations, [['third-party/JS-Slash-Runner']]);
});

test('the MVU capability activates extensions and awaits the managed runtime readiness', async () => {
    const runtime = createRuntime(() => {});
    const activations = [];
    const active = new Set();
    let finished = false;
    let releaseRuntime;
    let markStarted;
    const runtimeReady = new Promise(resolve => { releaseRuntime = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    runtime.loadWorldInfo = async (name) => {
        assert.equal(name, 'MVU Book');
        return { entries: { 0: { comment: '[mvu_update] variables' } } };
    };
    runtime.activateExtensionNames = async (names) => {
        activations.push([...names]);
        names.forEach(name => active.add(name));
        return [...names];
    };
    runtime.getActiveExtensionNames = () => [...active];
    const previousEnsure = globalThis.__NORA_ENSURE_MVU_READY__;
    globalThis.__NORA_ENSURE_MVU_READY__ = async () => {
        markStarted();
        await runtimeReady;
        return {
            getMvuData() {
                return { schema: { type: 'object' }, stat_data: {} };
            },
        };
    };
    try {
        const adapter = createStRuntimeAdapter(() => runtime);
        const card = {
            name: 'MVU Card',
            data: { extensions: { world: 'MVU Book' } },
        };
        const pending = adapter.ensureCharacterCapability(card, 'mvu').then(evidence => {
            finished = true;
            return evidence;
        });
        await started;

        assert.deepEqual(activations, [[
            'third-party/JS-Slash-Runner',
            'third-party/nora-mvu',
        ]]);
        assert.equal(finished, false, 'extension activation is not proof of MVU readiness');

        releaseRuntime();
        const evidence = await pending;
        assert.equal(evidence.runtime_ready, true);
        assert.equal(evidence.data_initialized, true);
        assert.equal(evidence.runtime_source, 'managed');
    } finally {
        releaseRuntime();
        if (previousEnsure === undefined) delete globalThis.__NORA_ENSURE_MVU_READY__;
        else globalThis.__NORA_ENSURE_MVU_READY__ = previousEnsure;
    }
});

test('inspectCharacterRuntime recognizes canonical embedded MagVarUpdate scripts', () => {
    const inspection = inspectCharacterRuntime({
        name: 'Embedded MVU Card',
        data: {
            extensions: {
                tavern_helper: {
                    scripts: [{
                        type: 'script',
                        name: 'MVU runtime',
                        content: 'import \'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js\'',
                    }],
                },
            },
        },
    });

    assert.equal(inspection.mvuDeclared, true);
    assert.equal(inspection.mvuRuntimeSource, 'embedded');
    assert.deepEqual(inspection.extensions, [
        'third-party/JS-Slash-Runner',
    ]);
});

test('inspectCharacterRuntime recognizes MVU variable cards that declare update format in content', () => {
    const inspection = inspectCharacterRuntime({
        name: 'Content MVU Card',
        data: {
            character_book: {
                entries: [{
                    comment: '变量更新规则',
                    content: '<status_current_variables>{{get_message_variable::stat_data}}</status_current_variables>\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>',
                }],
            },
        },
    });

    assert.equal(inspection.mvuDeclared, true);
    assert.deepEqual(inspection.extensions, [
        'third-party/JS-Slash-Runner',
        'third-party/nora-mvu',
    ]);
});

test('inspectCharacterRuntime does not infer MVU from an unrelated helper script', () => {
    const inspection = inspectCharacterRuntime({
        name: 'Ordinary Helper Card',
        data: {
            extensions: {
                tavern_helper: {
                    scripts: [{ type: 'script', name: 'Renderer', content: 'renderStatusBar();' }],
                },
            },
        },
    });

    assert.equal(inspection.mvuDeclared, false);
    assert.deepEqual(inspection.extensions, ['third-party/JS-Slash-Runner']);
});

test('snapshot projects Nora state without leaking the raw ST context', () => {
    const runtime = createRuntime(() => {});
    runtime.characterId = null;
    runtime.characters = [{ name: 'Should not become active' }];
    runtime.name1 = 'Nora';
    runtime.powerUserSettings = { persona_description: 'Host persona' };
    runtime.chatMetadata = { nora_world: { id: 'world:one' } };

    const snapshot = createStRuntimeAdapter(() => runtime).snapshot();

    assert.equal(snapshot.activeCharacterId, null);
    assert.equal(snapshot.user.name, 'Nora');
    assert.equal(snapshot.world.metadata.nora_world.id, 'world:one');
    assert.equal('sendText' in snapshot, false);
    assert.equal('eventSource' in snapshot, false);
});

test('whenReady resolves to a Nora snapshot instead of the raw ST context', async () => {
    const runtime = createRuntime(() => {});
    runtime.characters = [];
    let waited = false;
    const adapter = createStRuntimeAdapter(() => runtime, {
        whenAppReady: async () => {
            waited = true;
            return runtime;
        },
    });

    const readyState = await adapter.whenReady();

    assert.equal(waited, true);
    assert.equal('sendText' in readyState, false);
    assert.equal(readyState.activeChatId, 'phase-1-chat');
});

test('subscribe projects MVU transaction events without polling the runtime', () => {
    const runtime = createRuntime(() => {});
    const listeners = new Map();
    runtime.eventSource = {
        on(event, handler) { listeners.set(event, handler); },
        off(event, handler) { if (listeners.get(event) === handler) listeners.delete(event); },
    };
    runtime.eventTypes = {};
    const received = [];
    const release = createStRuntimeAdapter(() => runtime).subscribe({
        mvuTransactionChanged: transaction => received.push(transaction),
    });

    listeners.get('nora_mvu_transaction_started')?.({ message_id: 3 });
    listeners.get('nora_mvu_transaction_committed')?.({ message_id: 3, status: 'wrong' });
    listeners.get('nora_mvu_transaction_failed')?.({ message_id: 4, error_code: 'MVU_REQUEST_FAILED' });

    assert.deepEqual(received, [
        { message_id: 3, status: 'syncing' },
        { message_id: 3, status: 'committed' },
        { message_id: 4, error_code: 'MVU_REQUEST_FAILED', status: 'failed' },
    ]);
    release();
    assert.equal(listeners.size, 0);
});

test('enableCharacterCapabilities delegates embedded regex and helper-script authorization', async () => {
    const runtime = createRuntime(() => {});
    const allowedRegex = [];
    let reloaded = 0;
    const character = {
        name: 'Complex Card',
        avatar: 'complex.png',
        data: {
            extensions: {
                regex_scripts: [{ scriptName: 'format' }],
                tavern_helper: { scripts: [{ type: 'script', name: 'MVU' }] },
            },
        },
    };
    runtime.characters = [character];
    runtime.extensionSettings = {};
    const accountStorage = new Map();
    runtime.accountStorage = {
        getItem: (key) => accountStorage.get(key),
        setItem: (key, value) => accountStorage.set(key, value),
    };
    runtime.regex = {
        isCharacterAllowed: () => false,
        allowCharacter: (value) => allowedRegex.push(value.avatar),
    };
    runtime.reloadCurrentChat = async () => { reloaded += 1; };
    runtime.saveSettingsDebounced = () => {};

    const adapter = createStRuntimeAdapter(() => runtime);
    await adapter.enableCharacterCapabilities(character, { reload: true });

    assert.deepEqual(allowedRegex, ['complex.png']);
    assert.deepEqual(runtime.extensionSettings.tavern_helper.script.enabled.characters, ['Complex Card']);
    assert.equal(accountStorage.get('AlertRegex_complex.png'), 'true');
    assert.equal(reloaded, 1);
});

test('Nora runtime exposes capabilities without the obsolete preparation and creation bypasses', () => {
    const runtime = createRuntime(() => {});
    const adapter = createStRuntimeAdapter(() => runtime);
    assert.equal(typeof adapter.ensureCharacterCapability, 'function');
    for (const method of ['prepareCharacterRuntime', 'waitForCharacterRuntime', 'createCharacter', 'importCharacter']) {
        assert.equal(method in adapter, false, `${method} must not bypass World Core`);
    }
    assert.equal(adapter.assertModelConfigured(), true, 'Nora must not require the unused ST import API');
});

test('updateCharacter merges editable profile fields without replacing complex-card data', async () => {
    const runtime = createRuntime(() => {});
    let refreshed = false;
    let request;
    runtime.getCharacters = async () => { refreshed = true; };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, text: async () => '' };
    };

    try {
        const adapter = createStRuntimeAdapter(() => runtime);
        await adapter.updateCharacter({ avatar: 'complex.png', name: '电次', description: '恶魔猎人', personality: '直接' });
        const payload = JSON.parse(request.options.body);

        assert.equal(request.url, '/api/characters/merge-attributes');
        assert.deepEqual(payload, {
            avatar: 'complex.png',
            name: '电次',
            description: '恶魔猎人',
            personality: '直接',
            data: { name: '电次', description: '恶魔猎人', personality: '直接' },
        });
        assert.equal('character_book' in payload.data, false);
        assert.equal('extensions' in payload.data, false);
        assert.equal(refreshed, true);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('updateEmbeddedWorldbook updates only the embedded character book', async () => {
    const runtime = createRuntime(() => {});
    let refreshed = false;
    let request;
    runtime.getCharacters = async () => { refreshed = true; };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, text: async () => '' };
    };

    try {
        const adapter = createStRuntimeAdapter(() => runtime);
        const book = { name: '夜之帝国', entries: [{ comment: '吸血鬼', content: '设定' }] };
        await adapter.updateEmbeddedWorldbook({ avatar: 'complex.png', book });
        const payload = JSON.parse(request.options.body);

        assert.equal(request.url, '/api/characters/merge-attributes');
        assert.deepEqual(payload, { avatar: 'complex.png', data: { character_book: book } });
        assert.equal('name' in payload, false);
        assert.equal('extensions' in payload.data, false);
        assert.equal(refreshed, true);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('deleteCharacterCards removes requested cards with explicit chat policy', async () => {
    const runtime = createRuntime(() => {});
    let refreshed = false;
    const requests = [];
    runtime.getCharacters = async () => { refreshed = true; };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, text: async () => '' };
    };

    try {
        const adapter = createStRuntimeAdapter(() => runtime);
        await adapter.deleteCharacterCards({ avatars: ['card.png', 'card-copy.png'], deleteChats: false });
        assert.deepEqual(requests.map(({ url }) => url), ['/api/characters/delete', '/api/characters/delete']);
        assert.deepEqual(requests.map(({ options }) => JSON.parse(options.body)), [
            { avatar_url: 'card.png', delete_chats: false },
            { avatar_url: 'card-copy.png', delete_chats: false },
        ]);
        assert.equal(refreshed, true);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('isSystemCharacter hides only the ST-owned default assistant card', () => {
    const runtime = createRuntime(() => {});
    const adapter = createStRuntimeAdapter(() => runtime);

    assert.equal(adapter.isSystemCharacter({ avatar: 'default_Seraphina.png' }), true);
    assert.equal(adapter.isSystemCharacter({ avatar: 'Nora_Blank_World--nora-internal.png' }), true);
    assert.equal(adapter.isSystemCharacter({ avatar: 'custom.png', data: { extensions: { nora_internal: { kind: 'blank-world-runtime' } } } }), true);
    assert.equal(adapter.isSystemCharacter({ avatar: 'seraphina-custom.png' }), false);
    assert.equal(adapter.isSystemCharacter(null), false);
});

test('sendText blocks a custom backend before generation when its endpoint profile is incomplete', async () => {
    let dispatched = false;
    const runtime = createRuntime(async () => { dispatched = true; });
    runtime.customApiKeyConfigured = false;
    runtime.chatCompletionSettings = {
        chat_completion_source: 'custom',
        custom_url: '',
        custom_model: 'local-model',
    };

    const adapter = createStRuntimeAdapter(() => runtime);
    await assert.rejects(adapter.sendText('Continue'), /文本模型配置/);
    assert.equal(dispatched, false);
});

test('sendText allows a custom backend to generate when its API key exists', async () => {
    let runtime;
    runtime = createRuntime(async (text) => {
        runtime.chat.push(
            { is_user: true, is_system: false, mes: text },
            { is_user: false, is_system: false, mes: 'Authenticated reply' },
        );
    });
    const adapter = createStRuntimeAdapter(() => runtime);
    await adapter.sendText('Continue');
    assert.equal(runtime.chat.at(-1).mes, 'Authenticated reply');
});

test('sendText resolves only after a non-empty assistant reply is persisted', async () => {
    let runtime;
    runtime = createRuntime(async (text) => {
        runtime.chat.push(
            { is_user: true, is_system: false, mes: text },
            { is_user: false, is_system: false, mes: 'NORA_PHASE1_OK' },
        );
    });

    const adapter = createStRuntimeAdapter(() => runtime);

    await adapter.sendText('Continue');
    assert.equal(runtime.chat.at(-1).mes, 'NORA_PHASE1_OK');
});

test('editMessage delegates to the ST edit lifecycle instead of mutating chat directly', async () => {
    const calls = [];
    const runtime = createRuntime(() => {});
    runtime.chat.push({
        is_user: false,
        is_system: false,
        mes: 'Original reply',
        swipe_id: 0,
        swipes: ['Original reply'],
    });
    runtime.commitMessageEdit = async (id, text) => {
        calls.push({ id, text });
        runtime.chat[id].mes = text;
        runtime.chat[id].swipes[runtime.chat[id].swipe_id] = text;
    };

    const adapter = createStRuntimeAdapter(() => runtime);

    await adapter.editMessage(1, 'Edited reply');

    assert.deepEqual(calls, [{ id: 1, text: 'Edited reply' }]);
    assert.equal(runtime.chat[1].mes, 'Edited reply');
    assert.equal(runtime.chat[1].swipes[0], 'Edited reply');
});

test('windowed message operations hydrate full history and translate visible message ids', async () => {
    const runtime = createRuntime(() => {});
    runtime.chat = [{ is_user: false, is_system: false, mes: 'Visible reply' }];
    runtime.getNoraAbsoluteMessageId = id => 60 + Number(id);
    runtime.ensureNoraFullChatLoaded = async () => {
        runtime.chat.unshift(...Array.from({ length: 60 }, (_, index) => ({
            is_user: index % 2 === 0,
            is_system: false,
            mes: `Historical ${index}`,
        })));
    };
    const calls = [];
    runtime.commitMessageEdit = async (id, text) => calls.push({ id, text });

    const adapter = createStRuntimeAdapter(() => runtime);
    await adapter.editMessage(0, 'Edited visible reply');

    assert.deepEqual(calls, [{ id: 60, text: 'Edited visible reply' }]);
});

test('editAndRegenerate replaces the latest user turn and removes its stale assistant reply', async () => {
    const calls = [];
    const runtime = createRuntime(() => {});
    runtime.chat = [
        { is_user: false, is_system: false, mes: 'Opening message' },
        { is_user: true, is_system: false, mes: 'Old user action' },
        { is_user: false, is_system: false, mes: 'Stale reply' },
    ];
    runtime.deleteLastMessage = async () => {
        calls.push('delete');
        runtime.chat.pop();
    };
    runtime.commitMessageEdit = async (id, text) => {
        calls.push(`edit:${id}:${text}`);
        runtime.chat[id].mes = text;
    };
    runtime.saveChat = async () => calls.push('save');
    runtime.regenerate = async () => {
        calls.push('generate');
        runtime.chat.push({ is_user: false, is_system: false, mes: 'Fresh reply' });
    };

    const adapter = createStRuntimeAdapter(() => runtime);
    await adapter.editAndRegenerate(1, 'New user action');

    assert.deepEqual(calls, ['delete', 'edit:1:New user action', 'save', 'generate']);
    assert.deepEqual(runtime.chat.map(message => message.mes), ['Opening message', 'New user action', 'Fresh reply']);
});

test('suggestReplies uses only the latest five dialogue rounds and never mutates chat', async () => {
    let request;
    const runtime = createRuntime(() => {});
    runtime.chat = Array.from({ length: 14 }, (_, index) => ({
        is_user: index % 2 === 0,
        is_system: false,
        name: index % 2 === 0 ? 'Nora' : 'Character',
        mes: `turn-${index}`,
    }));
    const before = structuredClone(runtime.chat);
    runtime.generateRaw = async options => {
        request = options;
        return '<reply>“这到底是什么情况？”我警惕地看向四周。</reply>\n<reply>我朝对方喊道：“你是谁？”</reply>\n<reply>我握紧短刀，快步走向港口。</reply>';
    };

    const adapter = createStRuntimeAdapter(() => runtime);
    const suggestions = await adapter.suggestReplies();

    assert.deepEqual(suggestions, [
        '“这到底是什么情况？”我警惕地看向四周。',
        '我朝对方喊道：“你是谁？”',
        '我握紧短刀，快步走向港口。',
    ]);
    assert.deepEqual(runtime.chat, before);
    assert.match(JSON.stringify(request.prompt), /turn-4/);
    assert.doesNotMatch(JSON.stringify(request.prompt), /turn-3/);
    assert.match(request.systemPrompt, /三条/);
    assert.match(request.prompt, /<reply>第一条<\/reply>/);
    assert.equal(request.jsonSchema, undefined);
});

test('swipe delegates to the ST message lifecycle and observes the persisted alternative', async () => {
    const runtime = createRuntime(() => {});
    runtime.chat.push({
        is_user: false,
        is_system: false,
        mes: 'First reply',
        swipe_id: 0,
        swipes: ['First reply', 'Second reply'],
    });
    runtime.swipe = {
        right: async (_event, { message }) => {
            message.swipe_id = 1;
            message.mes = message.swipes[1];
        },
    };

    const adapter = createStRuntimeAdapter(() => runtime);

    const changed = await adapter.swipe(1, 'right');

    assert.equal(changed, true);
    assert.equal(runtime.chat[1].swipe_id, 1);
    assert.equal(runtime.chat[1].mes, 'Second reply');
});

test('swipe removes an empty generated alternative and restores the previous reply', async () => {
    const runtime = createRuntime(() => {});
    runtime.chat.push({
        is_user: false,
        is_system: false,
        mes: 'Original reply',
        swipe_id: 0,
        swipes: ['Original reply'],
        swipe_info: [{}],
    });
    runtime.swipe = {
        right: async (_event, { message }) => {
            message.swipes.push('');
            message.swipe_info.push({});
            message.swipe_id = 1;
            message.mes = '';
        },
        delete: async (swipeId, messageId) => {
            const message = runtime.chat[messageId];
            message.swipes.splice(swipeId, 1);
            message.swipe_info.splice(swipeId, 1);
            message.swipe_id = 0;
            message.mes = message.swipes[0];
        },
    };

    const adapter = createStRuntimeAdapter(() => runtime);

    await assert.rejects(adapter.swipe(1, 'right'), /empty swipe/i);
    assert.equal(runtime.chat[1].mes, 'Original reply');
    assert.equal(runtime.chat[1].swipe_id, 0);
    assert.deepEqual(runtime.chat[1].swipes, ['Original reply']);
});

test('sendText rejects an empty assistant reply without asking the UI to resend persisted input', async () => {
    let runtime;
    runtime = createRuntime(async (text) => {
        runtime.chat.push(
            { is_user: true, is_system: false, mes: text },
            { is_user: false, is_system: false, mes: '' },
        );
    });

    const adapter = createStRuntimeAdapter(() => runtime);

    await assert.rejects(
        adapter.sendText('Continue'),
        (error) => {
            assert.match(error.message, /empty response/i);
            assert.equal(error.noraMessagePersisted, true);
            return true;
        },
    );
});
