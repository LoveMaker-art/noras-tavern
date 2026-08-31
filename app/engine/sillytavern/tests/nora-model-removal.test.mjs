import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { planModelRemoval } from '../../../native-extensions/nora-ui/model-controller.js';

const modelControllerSource = fs.readFileSync(new URL('../../../native-extensions/nora-ui/model-controller.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../../../native-extensions/nora-ui/style.css', import.meta.url), 'utf8');

const profiles = [
    { id: 'first', name: 'First' },
    { id: 'second', name: 'Second' },
];

test('removing an inactive model preserves the active model and backend', () => {
    assert.deepEqual(planModelRemoval(profiles, 'first', 'second'), {
        remaining: [profiles[0]],
        nextActive: 'first',
        fallback: null,
        clearBackend: false,
    });
});

test('removing the active model selects a remaining fallback', () => {
    assert.deepEqual(planModelRemoval(profiles, 'first', 'first'), {
        remaining: [profiles[1]],
        nextActive: 'second',
        fallback: profiles[1],
        clearBackend: false,
    });
});

test('removing the final active model clears the backend configuration', () => {
    assert.deepEqual(planModelRemoval([profiles[0]], 'first', 'first'), {
        remaining: [],
        nextActive: '',
        fallback: null,
        clearBackend: true,
    });
});

test('removing the final active user model falls back to the Hermes system model when available', () => {
    assert.deepEqual(planModelRemoval([profiles[0]], 'first', 'first', true), {
        remaining: [],
        nextActive: '',
        fallback: { id: 'hermes', source: 'hermes' },
        clearBackend: false,
    });
});

test('all saved models expose a confirmed delete action', () => {
    assert.doesNotMatch(modelControllerSource, /disabled title="当前使用中的模型不能直接删除"/);
    assert.match(modelControllerSource, /dialogs\.confirm\(\{[^}]*title:\s*tr\(["']删除模型配置["']\)/s);
    assert.match(modelControllerSource, /profileActions\.remove\(id\)/);
    assert.match(modelControllerSource, /settingsDomain\.saveUiSettings\(\{ immediate: true \}\)/);
    assert.doesNotMatch(modelControllerSource, /runtime\./);
    assert.doesNotMatch(style, /\.nora-model-delete:disabled\s*\{[^}]*visibility:\s*hidden/);
});
