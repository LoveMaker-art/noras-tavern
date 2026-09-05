import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createWorldCoreClient,
    executeStActivationSnapshot,
} from '../public/scripts/nora-worlds/world-core-client.js';
import { createWorldCoreRuntime } from '../public/scripts/nora-worlds/world-core-runtime.js';

function response(status, payload) {
    return new Response(payload === null ? null : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function memoryStore() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
    };
}

test('operation deadline aborts a hung HTTP request and retains its recovery identity', async () => {
    let signal;
    const client = createWorldCoreClient(() => ({}), {
        operationTimeoutMs: 15,
        fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); },
    });
    await assert.rejects(client.waitForOperation('operation:hung'), error => error.code === 'NORA_OPERATION_TIMEOUT' && error.operationId === 'operation:hung');
    assert.equal(signal.aborted, true);
});

test('request deadline covers stalled response bodies, not just response headers', async () => {
    let signal;
    const client = createWorldCoreClient(() => ({}), {
        requestTimeoutMs: 15,
        fetchImpl: async (_url, options) => {
            signal = options.signal;
            return { ok: true, json: () => new Promise(() => {}) };
        },
    });
    await assert.rejects(client.list(), error => error.code === 'NORA_REQUEST_TIMEOUT');
    assert.equal(signal.aborted, true);
});

test('reuses one idempotency key across transport retry and polls the submitted operation', async () => {
    const requests = [];
    let importAttempts = 0;
    let polls = 0;
    const client = createWorldCoreClient(() => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'token',
    }), {
        pollIntervalMs: 0,
        fetchImpl: async (url, options = {}) => {
            requests.push({ url, options });
            if (url.endsWith('/imports')) {
                importAttempts += 1;
                if (importAttempts === 1) throw new TypeError('connection reset');
                return response(202, { operation: { operation_id: 'operation:one', status: 'RUNNING' } });
            }
            if (url.includes('/operations/')) {
                polls += 1;
                return response(200, {
                    operation: { operation_id: 'operation:one', status: polls > 1 ? 'COMPLETED' : 'RUNNING' },
                    world: polls > 1 ? { world_id: 'world:one' } : null,
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        },
    });

    const result = await client.importCard(new File(['card'], 'card.json', { type: 'application/json' }), {
        idempotencyKey: 'browser:one',
        persona: { name: 'Nora', description: '' },
    });

    assert.equal(result.world.world_id, 'world:one');
    const importRequests = requests.filter(item => item.url.endsWith('/imports'));
    assert.equal(importRequests.length, 2);
    assert.equal(importRequests[0].options.body.get('idempotency_key'), 'browser:one');
    assert.equal(importRequests[1].options.body.get('idempotency_key'), 'browser:one');
    assert.equal(Object.keys(importRequests[0].options.headers).some(key => key.toLowerCase() === 'content-type'), false);
});

test('creates a blank World through one JSON backend command and polls the same operation', async () => {
    const requests = [];
    const client = createWorldCoreClient(() => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'token',
    }), {
        pollIntervalMs: 0,
        fetchImpl: async (url, options = {}) => {
            requests.push({ url, options });
            if (url.endsWith('/worlds') && options.method === 'POST') {
                return response(202, { operation: { operation_id: 'operation:blank', status: 'RUNNING' } });
            }
            if (url.includes('/operations/')) {
                return response(200, {
                    operation: { operation_id: 'operation:blank', status: 'COMPLETED' },
                    world: { world_id: 'world:blank' },
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        },
    });

    const result = await client.createBlank({
        idempotencyKey: 'browser:blank-one',
        name: '空白世界',
        persona: { name: 'Nora', description: '' },
    });

    assert.equal(result.world.world_id, 'world:blank');
    assert.equal(requests[0].url.endsWith('/worlds'), true);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        idempotency_key: 'browser:blank-one',
        name: '空白世界',
        persona_name: 'Nora',
        persona_description: '',
    });
});

test('backs off World operation polling without exceeding the configured interval', async () => {
    const delays = [];
    let now = 0;
    let polls = 0;
    const client = createWorldCoreClient(() => ({ 'X-CSRF-Token': 'token' }), {
        pollIntervalMs: 10,
        pollMaxIntervalMs: 25,
        operationTimeoutMs: 1000,
        clock: () => now,
        delay: async (duration) => {
            delays.push(duration);
            now += duration;
        },
        fetchImpl: async (url) => {
            assert.match(url, /\/operations\/operation%3Abackoff$/);
            polls += 1;
            return response(200, {
                operation: {
                    operation_id: 'operation:backoff',
                    status: polls === 4 ? 'COMPLETED' : 'RUNNING',
                },
                world: polls === 4 ? { world_id: 'world:backoff' } : null,
            });
        },
    });

    const result = await client.waitForOperation('operation:backoff');

    assert.equal(result.world.world_id, 'world:backoff');
    assert.deepEqual(delays, [10, 20, 25]);
});

test('times out a stalled World operation while preserving its resumable pending state', async () => {
    const pendingStore = memoryStore();
    let now = 0;
    const client = createWorldCoreClient(() => ({ 'X-CSRF-Token': 'token' }), {
        pendingStore,
        pollIntervalMs: 10,
        pollMaxIntervalMs: 20,
        operationTimeoutMs: 10,
        clock: () => now,
        delay: async (duration) => { now += duration; },
        fetchImpl: async (url) => {
            if (url.endsWith('/imports')) {
                return response(202, { operation: { operation_id: 'operation:stalled', status: 'RUNNING' } });
            }
            if (url.endsWith('/operations/operation%3Astalled')) {
                return response(200, { operation: { operation_id: 'operation:stalled', status: 'RUNNING' } });
            }
            throw new Error(`Unexpected request: ${url}`);
        },
    });

    await assert.rejects(
        client.importCard(new File(['card'], 'card.png'), { idempotencyKey: 'browser:stalled' }),
        error => error?.code === 'NORA_OPERATION_TIMEOUT'
            && error?.retryable === true
            && error?.operationId === 'operation:stalled',
    );
    assert.deepEqual(client.pendingCreation(), {
        idempotencyKey: 'browser:stalled',
        operationId: 'operation:stalled',
        startedAt: 0,
        kind: 'import',
    });
});

test('clears pending state when an import reaches a terminal non-retryable failure', async () => {
    const pendingStore = memoryStore();
    const client = createWorldCoreClient(() => ({ 'X-CSRF-Token': 'token' }), {
        pendingStore,
        pollIntervalMs: 0,
        fetchImpl: async (url) => {
            if (url.endsWith('/imports')) {
                return response(202, { operation: { operation_id: 'operation:invalid', status: 'RUNNING' } });
            }
            if (url.endsWith('/operations/operation%3Ainvalid')) {
                return response(200, {
                    operation: {
                        operation_id: 'operation:invalid',
                        status: 'FAILED',
                        error: { code: 'NORA_CARD_INVALID', message: 'Invalid card', retryable: false },
                    },
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        },
    });

    await assert.rejects(
        client.importCard(new File(['card'], 'card.png'), { idempotencyKey: 'browser:invalid' }),
        error => error?.code === 'NORA_CARD_INVALID' && error?.retryable === false,
    );
    assert.equal(client.pendingCreation(), null);
});

test('clears a persisted pending import when recovery finds a terminal failure', async () => {
    const pendingStore = memoryStore();
    pendingStore.setItem('nora.world-core-v2.pending-import', JSON.stringify({
        idempotencyKey: 'browser:old-invalid',
        operationId: 'operation:old-invalid',
        startedAt: 1,
        kind: 'import',
    }));
    const client = createWorldCoreClient(() => ({ 'X-CSRF-Token': 'token' }), {
        pendingStore,
        fetchImpl: async (url) => {
            assert.ok(url.endsWith('/operations/operation%3Aold-invalid'));
            return response(200, {
                operation: {
                    operation_id: 'operation:old-invalid',
                    status: 'FAILED',
                    error: { code: 'NORA_CARD_INVALID', message: 'Invalid card', retryable: false },
                },
            });
        },
    });

    await assert.rejects(
        client.resumePendingCreation(),
        error => error?.code === 'NORA_CARD_INVALID' && error?.retryable === false,
    );
    assert.equal(client.pendingCreation(), null);
});

test('executes and verifies the aggregate ST snapshot without capability waits', async () => {
    const calls = [];
    let state = {
        characters: [{ avatar: 'target.png', name: 'Target' }],
        activeCharacterId: null,
        activeCharacter: null,
        chatId: '',
        persona: { name: '', description: '' },
        metadata: {},
    };
    const runtime = {
        read: () => state,
        async activateSnapshot(characterId, snapshot) {
            const chatId = snapshot.plan.session.binding.chat_id;
            calls.push('activate-snapshot');
            state = {
                ...state,
                activeCharacterId: characterId,
                activeCharacter: state.characters[characterId],
                chatId,
                metadata: { nora_world: { id: 'world:one' }, nora_session: { id: 'session:one' } },
            };
        },
        async savePersona(persona) {
            calls.push('persona');
            state = { ...state, persona };
        },
    };
    const plan = {
        schema: 'nora-world-activation/v1',
        world_id: 'world:one',
        world_revision: 1,
        name: 'Target World',
        persona: { name: 'Nora', description: 'Tester' },
        runtime_card: { resource_id: 'resource:one', engine: 'sillytavern', binding: { avatar: 'target.png' } },
        session: { session_id: 'session:one', engine: 'sillytavern', binding: { avatar: 'target.png', chat_id: 'chat-one' }, opening_state: 'message' },
        knowledge: [],
        capabilities: { declared: ['mvu'], status: 'PENDING' },
    };

    const opened = await executeStActivationSnapshot({ schema: 'nora-world-snapshot/v1', revision: 'one', plan,
        character: { avatar: 'target.png' }, chat: { messages: [] }, worldbooks: [] }, runtime);
    assert.deepEqual(calls, ['activate-snapshot', 'persona']);
    assert.equal(opened.id, 'world:one');
    assert.equal(opened.characterId, 0);
    assert.equal(opened.chatId, 'chat-one');
});

test('hydrates the snapshot card before aggregate activation when the card library was not loaded', async () => {
    const calls = [];
    let state = {
        characters: [],
        activeCharacterId: null,
        activeCharacter: null,
        chatId: '',
        persona: {},
        metadata: {},
    };
    const runtime = {
        read: () => state,
        ensureCharacter(character) {
            calls.push('hydrate-character');
            state.characters.push(structuredClone(character));
            return 0;
        },
        async activateSnapshot(characterId, snapshot) {
            calls.push('activate-snapshot');
            state = {
                ...state,
                activeCharacterId: characterId,
                activeCharacter: state.characters[characterId],
                chatId: snapshot.plan.session.binding.chat_id,
                metadata: { nora_world: { id: snapshot.plan.world_id }, nora_session: { id: snapshot.plan.session.session_id } },
            };
        },
        async savePersona() {},
    };
    const plan = {
        schema: 'nora-world-activation/v1',
        world_id: 'world:lazy-card',
        world_revision: 1,
        name: 'Lazy Card World',
        persona: {},
        runtime_card: { resource_id: 'resource:lazy-card', engine: 'sillytavern', binding: { avatar: 'lazy.png' } },
        session: { session_id: 'session:lazy-card', engine: 'sillytavern', binding: { avatar: 'lazy.png', chat_id: 'chat-lazy' }, opening_state: 'message' },
        knowledge: [],
        capabilities: { declared: [], status: 'READY' },
    };

    const opened = await executeStActivationSnapshot({
        schema: 'nora-world-snapshot/v1',
        revision: 'lazy-card',
        plan,
        character: { avatar: 'lazy.png', name: 'Lazy' },
        chat: { messages: [] },
        worldbooks: [],
    }, runtime);

    assert.deepEqual(calls, ['hydrate-character', 'activate-snapshot']);
    assert.equal(opened.characterId, 0);
    assert.equal(state.activeCharacter.name, 'Lazy');
});

test('fetches one aggregate activation snapshot and revalidates it by ETag', async () => {
    const requests = [];
    const measures = [];
    const snapshot = {
        schema: 'nora-world-snapshot/v1',
        revision: 'revision-one',
        plan: {
            schema: 'nora-world-activation/v1', world_id: 'world:one', world_revision: 1, name: 'One', persona: {},
            runtime_card: { engine: 'sillytavern', binding: { avatar: 'one.png' } },
            session: { session_id: 'session:one', engine: 'sillytavern', binding: { avatar: 'one.png', chat_id: 'chat-one' } },
            knowledge: [], capabilities: { declared: [], status: 'READY' },
        },
        character: { avatar: 'one.png' },
        chat: { header: { chat_metadata: {} }, messages: [] },
        worldbooks: [],
    };
    const client = createWorldCoreClient(() => ({ 'X-CSRF-Token': 'token' }), {
        measure: async (name, operation) => {
            measures.push(name);
            return operation();
        },
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            if (requests.length === 1) return new Response(JSON.stringify({ snapshot }), { status: 200, headers: { etag: '"revision-one"' } });
            return new Response(null, { status: 304 });
        },
    });
    assert.equal((await client.prepareSnapshot('world:one')).revision, 'revision-one');
    assert.equal((await client.prepareSnapshot('world:one')).revision, 'revision-one');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.headers['If-None-Match'], '"revision-one"');
    assert.deepEqual(measures, [
        'world.snapshot.network', 'world.snapshot.body-download', 'world.snapshot.json-parse', 'world.snapshot.validate',
        'world.snapshot.network',
    ]);
});

test('rehydrates a deduplicated embedded Character Book before entering the ST runtime', async () => {
    const embeddedBook = {
        name: 'One Book',
        entries: [{ id: 0, keys: ['one'], content: 'shared content', enabled: true }],
    };
    const plan = {
        schema: 'nora-world-activation/v1', world_id: 'world:one', world_revision: 1, name: 'One', persona: {},
        runtime_card: { engine: 'sillytavern', binding: { avatar: 'one.png' } },
        session: { session_id: 'session:one', engine: 'sillytavern', binding: { avatar: 'one.png', chat_id: 'chat-one' } },
        knowledge: [{ binding: { name: 'One Book' } }], capabilities: { declared: [], status: 'READY' },
    };
    const snapshot = {
        schema: 'nora-world-snapshot/v1', revision: 'revision-one', plan,
        character: { avatar: 'one.png', data: { extensions: { world: 'One Book' } } },
        chat: { header: { chat_metadata: {} }, messages: [] },
        worldbooks: [{ name: 'One Book', data: { entries: {}, originalData: embeddedBook } }],
        embedded_worldbook_binding: { name: 'One Book' },
    };
    let activatedSnapshot;
    let state = {
        characters: [{ avatar: 'one.png' }], activeCharacter: null, chatId: '', metadata: {}, persona: {},
    };
    const runtime = {
        read: () => state,
        async activateSnapshot(characterId, value) {
            activatedSnapshot = value;
            state = {
                ...state,
                activeCharacter: state.characters[characterId],
                chatId: value.plan.session.binding.chat_id,
                metadata: { nora_world: { id: 'world:one' }, nora_session: { id: 'session:one' } },
            };
        },
        async savePersona() {},
    };

    await executeStActivationSnapshot(snapshot, runtime);

    assert.deepEqual(activatedSnapshot.character.data.character_book, embeddedBook);
    assert.equal(activatedSnapshot.embedded_worldbook_binding, undefined);
});

test('coalesces concurrent activation snapshot requests for the same World', async () => {
    let fetchCount = 0;
    let releaseResponse;
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    const snapshot = {
        schema: 'nora-world-snapshot/v1',
        revision: 'revision-one',
        plan: {
            schema: 'nora-world-activation/v1', world_id: 'world:one', world_revision: 1, name: 'One', persona: {},
            runtime_card: { engine: 'sillytavern', binding: { avatar: 'one.png' } },
            session: { session_id: 'session:one', engine: 'sillytavern', binding: { avatar: 'one.png', chat_id: 'chat-one' } },
            knowledge: [], capabilities: { declared: [], status: 'READY' },
        },
        character: { avatar: 'one.png' },
        chat: { header: { chat_metadata: {} }, messages: [] },
        worldbooks: [],
    };
    const client = createWorldCoreClient(() => ({ 'X-CSRF-Token': 'token' }), {
        fetchImpl: async () => {
            fetchCount += 1;
            await responseGate;
            return new Response(JSON.stringify({ snapshot }), { status: 200, headers: { etag: '"revision-one"' } });
        },
    });

    const first = client.prepareSnapshot('world:one');
    const second = client.prepareSnapshot('world:one');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetchCount, 1);

    releaseResponse();
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    assert.equal(firstSnapshot.revision, 'revision-one');
    assert.equal(secondSnapshot.revision, 'revision-one');
    assert.equal(fetchCount, 1);

    await client.prepareSnapshot('world:one');
    assert.equal(fetchCount, 2);
});

test('A to B to A snapshot activation keeps one native transaction owner and verifies each binding', async () => {
    const calls = [];
    let state = {
        characters: [{ avatar: 'a.png' }, { avatar: 'b.png' }], activeCharacter: null, chatId: '', metadata: {}, persona: {},
    };
    const runtime = {
        read: () => state,
        async activateSnapshot(characterId, snapshot) {
            calls.push(`activate:${snapshot.plan.world_id}`);
            state = {
                ...state,
                activeCharacter: state.characters[characterId],
                chatId: snapshot.plan.session.binding.chat_id,
                metadata: { nora_world: { id: snapshot.plan.world_id }, nora_session: { id: snapshot.plan.session.session_id } },
            };
        },
        async savePersona(value) { state = { ...state, persona: value }; },
    };
    const makeSnapshot = key => ({
        schema: 'nora-world-snapshot/v1', revision: `revision-${key}`,
        plan: {
            schema: 'nora-world-activation/v1', world_id: `world:${key}`, name: key, persona: { name: key },
            runtime_card: { engine: 'sillytavern', binding: { avatar: `${key}.png` } },
            session: { session_id: `session:${key}`, engine: 'sillytavern', binding: { avatar: `${key}.png`, chat_id: `chat-${key}` } },
            knowledge: [], capabilities: { declared: [], status: 'READY' },
        },
        character: { avatar: `${key}.png` }, chat: { messages: [] }, worldbooks: [],
    });
    await executeStActivationSnapshot(makeSnapshot('a'), runtime);
    await executeStActivationSnapshot(makeSnapshot('b'), runtime);
    await executeStActivationSnapshot(makeSnapshot('a'), runtime);
    assert.deepEqual(calls, ['activate:world:a', 'activate:world:b', 'activate:world:a']);
    assert.equal(state.activeCharacter.avatar, 'a.png');
    assert.equal(state.chatId, 'chat-a');
    assert.equal(state.metadata.nora_world.id, 'world:a');
});

test('recovers one accepted import after page refresh using the persisted idempotency key', async () => {
    const pendingStore = memoryStore();
    const idempotencyKey = 'browser:refresh-one';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(idempotencyKey));
    const operationId = `operation:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
    const getHeaders = () => ({ 'X-CSRF-Token': 'token' });
    const firstPage = createWorldCoreClient(getHeaders, {
        pendingStore,
        transportRetries: 0,
        fetchImpl: async (url) => {
            if (url.endsWith('/imports')) throw new TypeError('response was lost after the server accepted the request');
            throw new Error(`Unexpected first-page request: ${url}`);
        },
    });
    await assert.rejects(
        firstPage.importCard(new File(['card'], 'card.png'), { idempotencyKey }),
        /response was lost/,
    );

    let recoveryRequests = 0;
    const secondPage = createWorldCoreClient(getHeaders, {
        pendingStore,
        pollIntervalMs: 0,
        fetchImpl: async (url) => {
            assert.ok(url.endsWith(`/operations/${encodeURIComponent(operationId)}`));
            recoveryRequests += 1;
            if (recoveryRequests === 1) {
                return response(404, {
                    error: {
                        code: 'NORA_OPERATION_NOT_FOUND',
                        message: 'Operation registration is not visible yet',
                    },
                });
            }
            return response(200, {
                operation: { operation_id: operationId, status: 'COMPLETED' },
                world: { world_id: 'world:one' },
            });
        },
    });
    const resumed = await secondPage.resumePendingCreation();
    assert.equal(resumed.world.world_id, 'world:one');
    assert.equal(recoveryRequests, 2);
    assert.equal(await secondPage.resumePendingCreation(), null);
});

test('records one capability attempt and its readiness evidence through the v2 client', async () => {
    const requests = [];
    const client = createWorldCoreClient(() => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'token',
    }), {
        fetchImpl: async (url, options = {}) => {
            requests.push({ url, options });
            if (options.method === 'POST') {
                return response(201, {
                    world: { world_id: 'world:one' },
                    attempt: { attempt_id: 'capability-attempt:one', capability: 'mvu' },
                });
            }
            return response(200, {
                world: { world_id: 'world:one', capabilities: { status: 'READY' } },
            });
        },
    });

    const begun = await client.beginCapabilityAttempt('world:one', 'mvu');
    const settled = await client.settleCapabilityAttempt(
        'world:one',
        'mvu',
        begun.attempt.attempt_id,
        { status: 'READY', duration_ms: 12, error: null, evidence: { api_visible: true } },
    );

    assert.equal(settled.world.capabilities.status, 'READY');
    assert.match(requests[0].url, /\/worlds\/world%3Aone\/capabilities\/mvu\/attempts$/);
    assert.equal(requests[1].options.method, 'PUT');
    assert.deepEqual(JSON.parse(requests[1].options.body).evidence, { api_visible: true });
});

test('submits repair and delete as backend World commands without exposing resource bindings', async () => {
    const requests = [];
    const client = createWorldCoreClient(() => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'token',
    }), {
        fetchImpl: async (url, options = {}) => {
            requests.push({ url, options });
            return response(200, {
                operation: { operation_id: `operation:${requests.length}`, status: 'COMPLETED' },
                world: { world_id: 'world:one' },
            });
        },
    });

    await client.repairWorld('world:one', { idempotencyKey: 'repair:one' });
    await client.deleteWorld('world:one', { idempotencyKey: 'delete:one' });

    assert.match(requests[0].url, /\/worlds\/world%3Aone\/repair$/);
    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].options.body), { idempotency_key: 'repair:one' });
    assert.match(requests[1].url, /\/worlds\/world%3Aone$/);
    assert.equal(requests[1].options.method, 'DELETE');
    assert.deepEqual(JSON.parse(requests[1].options.body), { idempotency_key: 'delete:one' });
});

test('uses only the authoritative v2 list and imports one card through one backend command', async () => {
    let characters = [{ avatar: 'old.png', name: 'Old' }];
    let activeCharacterId = null;
    let chatId = '';
    const manifests = [{
        world_id: 'world:one',
        revision: 1,
        name: 'Target World',
        persona: { name: 'Nora', description: '' },
        lifecycle: { status: 'READY', error: null },
        runtime_card: { binding: { avatar: 'target.png' } },
        sessions: {
            default_session_id: 'session:one',
            items: [{ session_id: 'session:one', binding: { avatar: 'target.png', chat_id: 'chat-one' }, opening_state: 'message' }],
        },
        capabilities: { declared: ['mvu'], status: 'PENDING' },
    }];
    const calls = [];
    const client = {
        async resumePendingCreation() {
            return null;
        },
        async list() {
            calls.push('list');
            return manifests;
        },
        async importCard(_file, options) {
            calls.push(`import:${options.idempotencyKey}`);
            return { world: manifests[0], operation: { status: 'COMPLETED' } };
        },
        async createBlank(options) {
            calls.push(`blank:${options.idempotencyKey}`);
            return { world: manifests[0], operation: { status: 'COMPLETED' } };
        },
        async prepareSnapshot() {
            calls.push('snapshot');
            const plan = {
                schema: 'nora-world-activation/v1',
                world_id: 'world:one',
                world_revision: 1,
                name: 'Target World',
                persona: { name: 'Nora', description: '' },
                runtime_card: { resource_id: 'resource:one', engine: 'sillytavern', binding: { avatar: 'target.png' } },
                session: { session_id: 'session:one', engine: 'sillytavern', binding: { avatar: 'target.png', chat_id: 'chat-one' }, opening_state: 'message' },
                knowledge: [],
                capabilities: { declared: ['mvu'], status: 'PENDING' },
            };
            return { schema: 'nora-world-snapshot/v1', revision: 'one', plan, character: { avatar: 'target.png' }, chat: { messages: [] }, worldbooks: [] };
        },
    };
    const runtime = {
        read: () => ({
            characters,
            activeCharacterId,
            activeCharacter: characters[activeCharacterId] || null,
            chatId,
            persona: { name: 'Nora', description: '' },
            metadata: activeCharacterId === null ? {} : {
                nora_world: { id: 'world:one' },
                nora_session: { id: 'session:one' },
            },
        }),
        async expandCharacter() {},
        async activateSnapshot(nextId, snapshot) {
            calls.push('activate');
            activeCharacterId = nextId;
            chatId = snapshot.plan.session.binding.chat_id;
        },
        async savePersona() {},
    };
    const worlds = createWorldCoreRuntime(runtime, {
        client,
        async refreshCharacters() {
            calls.push('characters');
            characters = [...characters, { avatar: 'target.png', name: 'Target' }];
        },
    });

    await worlds.refresh([{ avatar: 'old.png', file_name: 'legacy-chat.jsonl' }]);
    assert.deepEqual(worlds.list().map(world => world.id), ['world:one']);
    const opened = await worlds.importCard(new File(['card'], 'target.png'), {
        idempotencyKey: 'browser:import-one',
        persona: { name: 'Nora', description: '' },
    });
    assert.equal(opened.id, 'world:one');
    assert.deepEqual(calls, ['list', 'import:browser:import-one', 'characters', 'list']);
    assert.equal(calls.some(call => call.includes('mvu')), false);

    const blank = await worlds.createBlank({
        idempotencyKey: 'browser:blank-one',
        name: '空白世界',
        persona: { name: 'Nora', description: '' },
    });
    assert.equal(blank.id, 'world:one');
    assert.equal(calls.includes('blank:browser:blank-one'), true);
});
