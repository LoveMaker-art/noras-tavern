import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { validateWorldPresetParameters } from '../public/scripts/nora-worlds/world-preset.js';

const source = await fs.readFile(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('openai.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['configureCustomChatCompletion', 'configureProviderChatCompletion', 'getChatCompletionModelLimits'];
const functions = ast.statements.filter(ts.isFunctionDeclaration).filter(node => names.includes(node.name?.text))
    .map(node => node.getText(ast).replace(/^export /, '')).join('\n');
assert.equal(functions.match(/function /g).length, 3);

function nativeContext() {
    const state = vm.createContext({
        model_list: [], main_api: 'openai',
        oai_settings: { chat_completion_source: 'custom', openai_max_context: 65536, openai_max_tokens: 8192,
            temp_openai: 0.3, top_p_openai: 0.85, prompts: [{ identifier: 'keep' }], prompt_order: [], custom_model: 'before' },
        chat_completion_sources: { CUSTOM: 'custom' },
        event_types: { MAIN_API_CHANGED: 'api', CHATCOMPLETION_SOURCE_CHANGED: 'source' },
        eventSource: { emit: async () => {} },
        getChatCompletionModel: () => 'selected',
        cancelStatusCheck() {}, forceCharacterEditorTokenize() {}, updateFeatureSupportFlags() {},
        saveSettingsDebounced() {}, changeMainAPI() {}, startStatusLoading() {}, getStatusOpen: async () => {},
    });
    vm.runInContext(functions, state);
    return state;
}

test('real native connection functions preserve all generation settings when overrides are omitted', async () => {
    for (const source of ['custom', 'claude', 'makersuite']) {
        const context = nativeContext();
        const before = structuredClone(context.oai_settings);
        if (source === 'custom') await context.configureCustomChatCompletion({ url: 'https://test.invalid/v1', model: 'new' });
        else await context.configureProviderChatCompletion({ source, model: 'new' });
        for (const key of ['openai_max_context', 'openai_max_tokens', 'temp_openai', 'top_p_openai', 'prompts', 'prompt_order']) {
            assert.deepEqual(context.oai_settings[key], before[key], `${source}: ${key}`);
        }
        assert.equal(context.oai_settings.chat_completion_source, source);
    }
});

test('explicit legacy configuration still accepts budgets; invalid overrides are rejected', async () => {
    const context = nativeContext();
    await context.configureCustomChatCompletion({ url: 'https://test.invalid/v1', model: 'new', context: 32768, maxTokens: 4096 });
    assert.equal(context.oai_settings.openai_max_context, 32768);
    assert.equal(context.oai_settings.openai_max_tokens, 4096);
    await assert.rejects(context.configureProviderChatCompletion({ source: 'claude', model: 'new', context: -1 }), /positive/);
    assert.equal(context.oai_settings.openai_max_context, 32768);
});

test('capacity checks use only returned metadata for the selected model, never a guessed limit', () => {
    const context = nativeContext();
    context.model_list = [{ id: 'other', context_length: 1000 }, { id: 'selected' }];
    let limits = context.getChatCompletionModelLimits();
    assert.equal(limits.context, null); assert.equal(limits.tokens, null);
    const preset = { temperature: 0, top_p: 1, openai_max_context: 65536, openai_max_tokens: 4096 };
    assert.doesNotThrow(() => validateWorldPresetParameters(preset, limits));
    context.model_list[1] = { id: 'selected', context_length: 32768, top_provider: { max_completion_tokens: 2048 } };
    limits = context.getChatCompletionModelLimits();
    assert.throws(() => validateWorldPresetParameters(preset, limits), /32768/);
    assert.throws(() => validateWorldPresetParameters({ ...preset, openai_max_context: 32768 }, limits), /2048/);
    assert.equal(preset.openai_max_context, 65536, 'No silent clamping');
});

test('text model form has one connection-only scope; separate MVU limits remain', async () => {
    const controller = await fs.readFile(new URL('../../../native-extensions/nora-ui/model-controller.js', import.meta.url), 'utf8');
    const form = controller.slice(controller.indexOf('function openConfigForm'), controller.indexOf('async function save(event)'));
    assert.doesNotMatch(form, /name="(?:context|tokens)"/);
    for (const name of ['name', 'base', 'model', 'key']) assert.ok(form.includes(`name="${name}"`));
    const mvu = controller.slice(controller.indexOf('function openMvuConfigForm'), controller.indexOf('async function saveMvuConfig'));
    assert.match(mvu, /name="context"/); assert.match(mvu, /name="tokens"/);
    const css = await fs.readFile(new URL('../../../native-extensions/nora-ui/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.nora-fixed-editor \.nora-sheet, \.nora-preset-modal \.nora-sheet \{ height: min\(680px, 84vh\)/);
    assert.doesNotMatch(css, /\.nora-preset-modal \.nora-sheet \{[^}]*width:/);
});
