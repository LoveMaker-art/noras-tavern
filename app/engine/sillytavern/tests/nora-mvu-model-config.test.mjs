import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    isNoraMvuModelProxyUrl,
    NoraMvuModelConfig,
    NoraMvuModelConfigError,
    NORA_MVU_MODEL_FILE,
    NORA_MVU_MODEL_PROXY_URL,
    normalizeMvuModelBaseUrl,
    resolveNoraMvuModelRequest,
} from '../src/nora-mvu-model-config.js';

function createStore(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-mvu-model-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, store: new NoraMvuModelConfig(root) };
}

test('partial configuration retains limits and endpoint, invalid patches never overwrite', t => {
    const { store } = createStore(t);
    assert.throws(() => store.patch({ model: 'missing-endpoint' }));
    store.patch({ base_url: 'https://example.com/v1', model: 'old', context: 90000, max_tokens: 9000 });
    store.patch({ model: 'new' });
    assert.equal(store.read().context, 90000);
    assert.equal(store.read().max_tokens, 9000);
    assert.equal(store.read().base_url, 'https://example.com/v1');
    const before = store.read();
    for (const value of [null, 0, -1, 1.5, '90000', NaN, 1000001]) assert.throws(() => store.patch({ context: value }));
    assert.deepEqual(store.read(), before);
    store.patch({ api_key: 'never-written' });
    assert.deepEqual(store.read(), before);
});

test('MVU model config persists only non-secret endpoint, model and generation limits', (t) => {
    const { root, store } = createStore(t);
    const saved = store.save({
        base_url: 'https://api.example.com/v1/chat/completions?ignored=true',
        model: 'mvu-fast',
        api_key: 'must-not-be-written',
    });

    assert.deepEqual(saved, {
        schema: 'nora-mvu-model/v3',
        base_url: 'https://api.example.com/v1',
        model: 'mvu-fast',
        context: 30000,
        max_tokens: 4000,
    });
    assert.doesNotMatch(fs.readFileSync(path.join(root, NORA_MVU_MODEL_FILE), 'utf8'), /must-not-be-written|api_key/);
    assert.deepEqual(store.read(), saved);
});

test('MVU model config normalizes explicit context and output limits', (t) => {
    const { store } = createStore(t);
    const saved = store.save({
        base_url: 'https://api.example.com/v1',
        model: 'mvu-fast',
        context: 64000,
        max_tokens: 12000,
    });

    assert.equal(saved.context, 64000);
    assert.equal(saved.max_tokens, 12000);
});

test('MVU model config migrates only the old 128k default and preserves an explicit v3 choice', (t) => {
    const { root, store } = createStore(t);
    const file = path.join(root, NORA_MVU_MODEL_FILE);
    fs.writeFileSync(file, JSON.stringify({
        schema: 'nora-mvu-model/v2',
        base_url: 'https://api.example.com/v1',
        model: 'mvu-fast',
        context: 128000,
        max_tokens: 20000,
    }));
    assert.equal(store.read().context, 64000);

    fs.writeFileSync(file, JSON.stringify({
        schema: 'nora-mvu-model/v3',
        base_url: 'https://api.example.com/v1',
        model: 'mvu-fast',
        context: 128000,
        max_tokens: 20000,
    }));
    assert.equal(store.read().context, 128000);
});

test('MVU model config rejects unsupported URL schemes', () => {
    assert.throws(() => normalizeMvuModelBaseUrl('file:///tmp/model'), NoraMvuModelConfigError);
});

test('the internal routing marker cannot be saved as a real model endpoint', (t) => {
    const { root, store } = createStore(t);
    assert.throws(() => store.save({ base_url: NORA_MVU_MODEL_PROXY_URL, model: 'fixture' }), NoraMvuModelConfigError);
    assert.equal(fs.existsSync(path.join(root, NORA_MVU_MODEL_FILE)), false);
});

test('reserved MVU model address resolves the independent backend configuration only', (t) => {
    const { root, store } = createStore(t);
    store.save({ base_url: 'https://api.example.com/v1', model: 'mvu-fast' });

    assert.equal(isNoraMvuModelProxyUrl(NORA_MVU_MODEL_PROXY_URL), true);
    assert.deepEqual(resolveNoraMvuModelRequest({ root }, NORA_MVU_MODEL_PROXY_URL), store.read());
    assert.equal(resolveNoraMvuModelRequest({ root }, 'https://api.example.com/v1'), null);
});
