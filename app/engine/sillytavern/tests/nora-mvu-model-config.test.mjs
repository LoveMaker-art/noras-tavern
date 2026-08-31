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

test('MVU model config persists only a normalized endpoint and model name', (t) => {
    const { root, store } = createStore(t);
    const saved = store.save({
        base_url: 'https://api.example.com/v1/chat/completions?ignored=true',
        model: 'mvu-fast',
        api_key: 'must-not-be-written',
    });

    assert.deepEqual(saved, {
        schema: 'nora-mvu-model/v1',
        base_url: 'https://api.example.com/v1',
        model: 'mvu-fast',
    });
    assert.doesNotMatch(fs.readFileSync(path.join(root, NORA_MVU_MODEL_FILE), 'utf8'), /must-not-be-written|api_key/);
    assert.deepEqual(store.read(), saved);
});

test('MVU model config rejects unsupported URL schemes', () => {
    assert.throws(() => normalizeMvuModelBaseUrl('file:///tmp/model'), NoraMvuModelConfigError);
});

test('reserved MVU model address resolves the independent backend configuration only', (t) => {
    const { root, store } = createStore(t);
    store.save({ base_url: 'https://api.example.com/v1', model: 'mvu-fast' });

    assert.equal(isNoraMvuModelProxyUrl(NORA_MVU_MODEL_PROXY_URL), true);
    assert.deepEqual(resolveNoraMvuModelRequest({ root }, NORA_MVU_MODEL_PROXY_URL), store.read());
    assert.equal(resolveNoraMvuModelRequest({ root }, 'https://api.example.com/v1'), null);
});
