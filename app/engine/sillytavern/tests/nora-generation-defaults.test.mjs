import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { createWorldPreset } from '../public/scripts/nora-worlds/world-preset.js';
import { initializeHeadlessMvuSettings } from '../../../native-extensions/nora-mvu/runtime.js';

test('fresh settings, built-in Default and native fallback agree on 30000 / 4000', async () => {
    const settings = JSON.parse(await fs.readFile(new URL('../default/content/settings.json', import.meta.url)));
    const preset = JSON.parse(await fs.readFile(new URL('../default/content/presets/openai/Default.json', import.meta.url)));
    const source = await fs.readFile(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('openai.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const defaults = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
        .find(node => node.name.getText(ast) === 'default_settings').initializer;
    const scalar = key => Number(defaults.properties.find(node => node.name?.getText(ast) === key).initializer.getText(ast));
    for (const [key, expected] of [['openai_max_context', 30000], ['openai_max_tokens', 4000]]) {
        assert.equal(settings.oai_settings[key], expected);
        assert.equal(preset[key], expected);
        assert.equal(scalar(key), expected);
        assert.equal(createWorldPreset('Default', preset).preset[key], expected);
    }
});

test('new MVU settings use defaults, existing limits remain explicit even without a version marker', () => {
    const fresh = initializeHeadlessMvuSettings({ extensionSettings: {} });
    assert.equal(fresh['额外模型解析配置']['最大上下文token数'], 30000);
    assert.equal(fresh['额外模型解析配置']['最大回复token数'], 4000);
    for (const marker of [undefined, { settingsVersion: 5 }]) {
        const settings = initializeHeadlessMvuSettings({ extensionSettings: {
            nora_mvu: marker,
            mvu_settings: { '额外模型解析配置': { '最大上下文token数': 64000, '最大回复token数': 20000 } },
        } });
        assert.equal(settings['额外模型解析配置']['最大上下文token数'], 64000);
        assert.equal(settings['额外模型解析配置']['最大回复token数'], 20000);
    }
});

test('importing a custom preset never replaces its own budget with new defaults', () => {
    const original = { prompts: [], prompt_order: [{ character_id: 100001, order: [] }], openai_max_context: 65536, openai_max_tokens: 8192 };
    const result = createWorldPreset('Custom', original);
    assert.equal(result.preset.openai_max_context, 65536);
    assert.equal(result.preset.openai_max_tokens, 8192);
});
