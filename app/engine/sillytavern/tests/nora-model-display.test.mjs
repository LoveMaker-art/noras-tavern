import './helpers/nora-locale-fixture.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { projectTextModelChoices, projectTextModelDisplay } from '../../../native-extensions/nora-ui/model-display.js';

test('Hermes remains a selectable non-deletable option after custom models are added', () => {
    assert.deepEqual(projectTextModelChoices({
        activeModel: 'custom',
        modelProfiles: [{ id: 'custom', name: '我的模型', model: 'custom-model' }],
        hermesModel: { provider: 'clawling', model: 'deepseek-v4-flash' },
    }), [
        {
            id: 'hermes',
            name: 'clawling',
            model: 'deepseek-v4-flash',
            source: 'hermes',
            active: false,
            deletable: false,
        },
        {
            id: 'custom',
            name: '我的模型',
            model: 'custom-model',
            source: 'profile',
            active: true,
            deletable: true,
        },
    ]);
});

test('Hermes-managed model displays its provider and model without exposing transport details', () => {
    assert.deepEqual(projectTextModelDisplay({
        nativeModel: { custom_url: 'https://example.invalid/v1', custom_model: 'deepseek-v4-flash' },
        uiSettings: {
            activeModel: '',
            modelProfiles: [],
            hermesModel: { provider: 'clawling', model: 'deepseek-v4-flash' },
        },
    }), {
        configured: true,
        source: 'hermes',
        label: 'clawling · deepseek-v4-flash',
        model: 'deepseek-v4-flash',
    });
});

test('an unowned native model id is not presented as a configured Nora model', () => {
    assert.deepEqual(projectTextModelDisplay({
        nativeModel: { custom_url: 'https://example.invalid/v1', custom_model: 'deepseek-v4-flash' },
        uiSettings: { activeModel: '', modelProfiles: [] },
    }), {
        configured: false,
        source: 'none',
        label: '尚未配置模型',
        model: '',
    });
});

test('an explicitly selected Nora profile takes precedence over the Hermes default', () => {
    assert.deepEqual(projectTextModelDisplay({
        nativeModel: { custom_url: 'https://example.invalid/v1', custom_model: 'custom-model' },
        uiSettings: {
            activeModel: 'custom',
            modelProfiles: [{ id: 'custom', name: '我的模型', model: 'custom-model' }],
            hermesModel: { provider: 'clawling', model: 'deepseek-v4-flash' },
        },
    }), {
        configured: true,
        source: 'profile',
        label: '我的模型 · custom-model',
        model: 'custom-model',
    });
});

test('Hermes bootstrap projects provider and model metadata without projecting credentials', () => {
    const modulePath = fileURLToPath(new URL('../../../native_model_config.py', import.meta.url));
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("native_model_config", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.update_settings({"extension_settings": {"nora_ui": {"activeModel": ""}}}, {
    "provider": "clawling",
    "model": "deepseek-v4-flash",
    "base_url": "https://example.invalid/v1",
    "api_key": "must-not-leak",
    "context": 200000,
    "max_tokens": 30000,
})
print(json.dumps(result["extension_settings"]["nora_ui"], sort_keys=True))
`;
    const result = spawnSync('python3', ['-c', script, modulePath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        activeModel: '',
        hermesModel: {
            base: 'https://example.invalid/v1',
            context: 200000,
            model: 'deepseek-v4-flash',
            provider: 'clawling',
            secretId: '',
            tokens: 30000,
        },
    });
    assert.doesNotMatch(result.stdout, /must-not-leak/);
});

test('Hermes metadata refresh preserves an explicitly active user model', () => {
    const modulePath = fileURLToPath(new URL('../../../native_model_config.py', import.meta.url));
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("native_model_config", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
settings = {
    "main_api": "openai",
    "oai_settings": {"custom_url": "https://user.invalid/v1", "custom_model": "user-model"},
    "extension_settings": {"nora_ui": {"activeModel": "custom", "modelProfiles": [{"id": "custom"}]}}
}
result = module.update_settings(settings, {
    "provider": "clawling", "model": "deepseek-v4-flash", "base_url": "https://hermes.invalid/v1",
    "api_key": "must-not-leak", "context": 200000, "max_tokens": 30000,
}, secret_id="hermes-secret", activate=False, active_secret_id="user-secret")
print(json.dumps(result, sort_keys=True))
`;
    const result = spawnSync('python3', ['-c', script, modulePath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(result.stdout);
    assert.equal(settings.extension_settings.nora_ui.activeModel, 'custom');
    assert.equal(settings.oai_settings.custom_model, 'user-model');
    assert.equal(settings.extension_settings.nora_ui.hermesModel.secretId, 'hermes-secret');
    assert.equal(settings.extension_settings.nora_ui.modelProfiles[0].secretId, 'user-secret');
    assert.doesNotMatch(result.stdout, /must-not-leak/);
});
