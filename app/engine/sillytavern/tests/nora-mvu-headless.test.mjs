import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/nora-locale-fixture.mjs';

import {
    MVU_SCRIPT_ID,
    applyMvuSettings,
    createRetryableMvuLoader,
    createHeadlessMvuSettings,
    ensureHeadlessMvuScript,
    ensureHeadlessMvuScriptInSettings,
    hasInitializedMvuData,
    hasMvuDeclaration,
    initializeHeadlessMvuSettings,
    isMvuVariableModelEnabled,
    NORA_MVU_MODEL_PROXY_URL as FRONTEND_MVU_PROXY_URL,
    setMvuVariableModelEnabled,
    waitForMvuRuntime,
} from '../../../native-extensions/nora-mvu/runtime.js';
import { createManagedMvuRuntimeLoader } from '../../../native-extensions/nora-mvu/index.js';

test('MVU managed script is installed before TavernHelper activates', () => {
    const context = { extensionSettings: {} };
    assert.equal(ensureHeadlessMvuScriptInSettings(context), 'installed');
    assert.equal(ensureHeadlessMvuScriptInSettings(context), 'unchanged');
    assert.equal(context.extensionSettings.tavern_helper.script.enabled.global, true);
    assert.equal(context.extensionSettings.tavern_helper.script.scripts[0].id, MVU_SCRIPT_ID);
});
import { createMvuModelAdapter } from '../../../native-extensions/nora-ui/mvu-model-adapter.js';
import {
    createStMvuSettingsAdapter,
    NORA_MVU_MODEL_PROXY_URL as STORY_MVU_PROXY_URL,
} from '../public/scripts/nora-adapters/st-mvu-settings-adapter.js';
import { renderMvuModelSection } from '../../../native-extensions/nora-ui/model-controller.js';
import { NORA_MVU_MODEL_PROXY_URL as BACKEND_MVU_PROXY_URL } from '../src/nora-mvu-model-config.js';
import {
    isNoraMvuUpdateInstructionEntry,
    shouldSuppressNoraMvuUpdateEntryForMainPrompt,
} from '../public/scripts/nora-compat/mvu-world-info-policy.js';

const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

test('MVU capability detection only accepts upstream worldbook markers', () => {
    assert.equal(hasMvuDeclaration([{ comment: '[InitVar] initialized variables' }]), true);
    assert.equal(hasMvuDeclaration([{ comment: '[mvu_update] variable rules' }]), true);
    assert.equal(hasMvuDeclaration([{ comment: 'Plot [MVU_PLOT]' }]), true);
    assert.equal(hasMvuDeclaration([{ comment: 'ordinary character and setting entry', content: '[mvu_update]' }]), false);
    assert.equal(hasMvuDeclaration([]), false);
});

test('MVU runtime data requires both stat_data and schema', () => {
    assert.equal(hasInitializedMvuData({ stat_data: {}, schema: {} }), true);
    assert.equal(hasInitializedMvuData({ stat_data: {} }), false);
    assert.equal(hasInitializedMvuData({ schema: {} }), false);
    assert.equal(hasInitializedMvuData(null), false);
});

test('MVU model adapter degrades to a hidden status when the runtime is unavailable', async () => {
    const adapter = createMvuModelAdapter({ readApi: () => undefined });
    assert.equal(adapter.status().supported, false);
    assert.equal((await adapter.inspect()).supported, false);
});

test('MVU model adapter exposes the current card inspection result', async () => {
    const expected = { supported: true, initialized: false, declarationChecked: true };
    const adapter = createMvuModelAdapter({
        readApi: () => ({
            status: () => ({ supported: false }),
            inspectCurrentCard: async () => expected,
        }),
    });
    const inspected = await adapter.inspect();
    assert.deepEqual({
        supported: inspected.supported,
        initialized: inspected.initialized,
        declarationChecked: inspected.declarationChecked,
    }, expected);
});

test('MVU model adapter projects the active World capability before live variable initialization', async () => {
    const adapter = createMvuModelAdapter({
        readApi: () => ({
            status: () => ({
                phase: 'ready',
                supported: false,
                initialized: false,
                enabled: true,
                variableModel: '与插头相同',
            }),
        }),
    });
    const status = adapter.status({
        declared: ['mvu'],
        status: 'READY',
        items: {
            mvu: {
                status: 'READY',
                evidence: { runtime_ready: true, data_initialized: false },
            },
        },
    });

    assert.equal(status.supported, true);
    assert.equal(status.declared, true);
    assert.equal(status.runtimeReady, true);
    assert.equal(status.initialized, false);
});

test('MVU independent model adapter stores credentials through the backend only', async () => {
    const requests = [];
    const activations = [];
    const adapter = createMvuModelAdapter({
        requestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
        fetcher: async (url, options) => {
            requests.push({ url, options, body: JSON.parse(options.body) });
            return {
                ok: true,
                status: 200,
                json: async () => ({ base_url: 'https://api.example.com/v1', model: 'mvu-fast', has_api_key: true }),
            };
        },
        readApi: () => ({
            useIndependentModel: profile => activations.push(profile),
        }),
    });

    await adapter.configureIndependent({ baseUrl: 'https://api.example.com/v1', model: 'mvu-fast', apiKey: 'secret' });

    assert.equal(requests[0].url, '/api/nora-mvu-model/configure');
    assert.equal(requests[0].body.api_key, 'secret');
    assert.deepEqual(activations, [{ model: 'mvu-fast' }], 'the frontend MVU settings must never receive the key');
});

test('MVU adapter controls automatic requests independently from model source', async () => {
    const calls = [];
    const adapter = createMvuModelAdapter({
        readApi: () => ({
            setEnabled: value => calls.push(['enabled', value]),
            useStoryModel: () => calls.push(['source', 'story']),
        }),
    });

    adapter.setEnabled(false);
    adapter.useStoryModel();
    assert.deepEqual(calls, [['enabled', false], ['source', 'story']]);
});

test('MVU model adapter controls an embedded runtime without the managed NoraMvu bridge', () => {
    let reloads = 0;
    const context = {
        extensionSettings: {
            mvu_settings: createHeadlessMvuSettings({
                '更新方式': '随AI输出',
                '额外模型解析配置': { '启用自动请求': false },
            }),
        },
        saveSettingsDebounced() {},
    };
    const controlApi = createStMvuSettingsAdapter(
        () => context,
        { readMvuRuntime: () => ({
            getMvuData: () => ({ stat_data: {}, schema: {} }),
            reloadSettings: () => { reloads += 1; },
        }) },
    );
    const adapter = createMvuModelAdapter({ readApi: () => undefined, controlApi });
    const settings = adapter.setEnabled(true);
    assert.equal(settings['更新方式'], '额外模型解析');
    assert.equal(settings['额外模型解析配置']['启用自动请求'], true);
    assert.equal(reloads, 1);
});

test('MVU variable model toggle returns variable updates to the story model when disabled', () => {
    const context = {
        extensionSettings: {
            mvu_settings: createHeadlessMvuSettings({
                '更新方式': '额外模型解析',
                '额外模型解析配置': {
                    '启用自动请求': true,
                    '模型来源': '自定义',
                    'api地址': 'https://api.example.com/v1',
                    '模型名称': 'variable-model',
                    '请求次数': 5,
                },
            }),
        },
        saveSettingsDebounced() {},
    };

    const disabled = setMvuVariableModelEnabled(context, false);
    assert.equal(disabled['更新方式'], '随AI输出');
    assert.equal(disabled['额外模型解析配置']['启用自动请求'], false);
    assert.equal(disabled['额外模型解析配置']['模型来源'], '自定义');
    assert.equal(disabled['额外模型解析配置']['模型名称'], 'variable-model');
    assert.equal(disabled['额外模型解析配置']['请求次数'], 5);
    assert.equal(isMvuVariableModelEnabled(disabled), false);

    const enabled = setMvuVariableModelEnabled(context, true);
    assert.equal(enabled['更新方式'], '额外模型解析');
    assert.equal(enabled['额外模型解析配置']['启用自动请求'], true);
    assert.equal(enabled['额外模型解析配置']['模型名称'], 'variable-model');
    assert.equal(isMvuVariableModelEnabled(enabled), true);
});

test('MVU variable model suppresses update instructions only from the story model prompt', () => {
    const updateRule = { comment: '[mvu_update] variable rules', content: 'return <UpdateVariable>...</UpdateVariable>' };
    const variableReference = { comment: '变量列表', content: '<status_current_variables>' };
    const extensionSettings = {
        mvu_settings: createHeadlessMvuSettings({
            '更新方式': '额外模型解析',
            '额外模型解析配置': { '启用自动请求': true },
        }),
    };

    assert.equal(isNoraMvuUpdateInstructionEntry(updateRule), true);
    assert.equal(isNoraMvuUpdateInstructionEntry(variableReference), false);
    assert.equal(shouldSuppressNoraMvuUpdateEntryForMainPrompt(updateRule, { extensionSettings }), true);
    assert.equal(shouldSuppressNoraMvuUpdateEntryForMainPrompt(variableReference, { extensionSettings }), false);
    assert.equal(shouldSuppressNoraMvuUpdateEntryForMainPrompt(updateRule, {
        extensionSettings,
        mvuRuntime: { isDuringExtraAnalysis: () => true },
    }), false);

    const disabledSettings = {
        mvu_settings: createHeadlessMvuSettings({
            '更新方式': '随AI输出',
            '额外模型解析配置': { '启用自动请求': false },
        }),
    };
    assert.equal(shouldSuppressNoraMvuUpdateEntryForMainPrompt(updateRule, { extensionSettings: disabledSettings }), false);
});

test('model UI is hidden for ordinary cards and labels MVU state precisely', () => {
    assert.equal(renderMvuModelSection({ supported: false }, escapeHtml), '');
    assert.match(renderMvuModelSection({ supported: true, runtimeReady: true, initialized: false, variableModel: '与插头相同' }, escapeHtml), /运行时已加载[\s\S]*跟随文本模型[\s\S]*data-mvu-config/);
    assert.match(renderMvuModelSection({ supported: true, initialized: true, variableModel: '自定义', variableModelName: '<fast>' }, escapeHtml), /已启用[\s\S]*&lt;fast&gt;/);
    assert.match(renderMvuModelSection({ supported: true, enabled: false, variableModel: '自定义' }, escapeHtml, { model: 'mvu-fast' }), /已关闭[\s\S]*独立模型[\s\S]*mvu-fast/);
    assert.match(renderMvuModelSection({ supported: true, enabled: true, variableModel: '与插头相同' }, escapeHtml), /data-mvu-enabled[\s\S]*checked/);
});

test('frontend and backend share one reserved MVU model address', () => {
    assert.equal(FRONTEND_MVU_PROXY_URL, BACKEND_MVU_PROXY_URL);
    assert.equal(STORY_MVU_PROXY_URL, BACKEND_MVU_PROXY_URL);
});

test('headless settings changes are reloaded by the live MVU store', () => {
    let reloads = 0;
    globalThis.Mvu = { reloadSettings: () => { reloads += 1; } };
    try {
        const context = { extensionSettings: {}, saveSettingsDebounced() {} };
        const settings = applyMvuSettings(context, { '更新方式': '额外模型解析' });
        assert.equal(settings['更新方式'], '额外模型解析');
        assert.equal(reloads, 1);
    } finally {
        delete globalThis.Mvu;
    }
});

test('headless MVU defaults to an automatic second request without UI notifications', () => {
    const settings = createHeadlessMvuSettings({});

    assert.equal(settings['更新方式'], '额外模型解析');
    assert.equal(settings['额外模型解析配置']['启用自动请求'], true);
    assert.equal(settings['额外模型解析配置']['破限方案'], '使用内置破限');
    assert.equal(settings['额外模型解析配置']['应答格式'], '聊天消息');
    assert.equal(settings['额外模型解析配置']['模型来源'], '与插头相同');
    assert.equal(settings['通知']['额外模型解析中'], false);
    assert.equal(settings['通知']['变量更新出错'], false);
});

test('headless MVU preserves explicit user choices', () => {
    const settings = createHeadlessMvuSettings({
        '更新方式': '随AI输出',
        '额外模型解析配置': {
            '模型来源': '自定义',
            '模型名称': 'variable-model',
            '请求次数': 5,
        },
    });

    assert.equal(settings['更新方式'], '随AI输出');
    assert.equal(settings['额外模型解析配置']['模型来源'], '自定义');
    assert.equal(settings['额外模型解析配置']['模型名称'], 'variable-model');
    assert.equal(settings['额外模型解析配置']['请求次数'], 5);
    assert.equal(settings['额外模型解析配置']['启用自动请求'], true);
});

test('MVU enabled state is controlled only by extra analysis and automatic request settings', () => {
    assert.equal(isMvuVariableModelEnabled(createHeadlessMvuSettings({})), true);
    assert.equal(isMvuVariableModelEnabled(createHeadlessMvuSettings({
        '额外模型解析配置': { '启用自动请求': false },
    })), false);
    assert.equal(isMvuVariableModelEnabled(createHeadlessMvuSettings({ '更新方式': '随AI输出' })), false);
});

test('first headless activation migrates the upstream inline default to the second model once', () => {
    let saves = 0;
    const context = {
        extensionSettings: {
            mvu_settings: { '更新方式': '随AI输出' },
        },
        saveSettingsDebounced: () => { saves += 1; },
    };

    const first = initializeHeadlessMvuSettings(context);
    assert.equal(first['更新方式'], '额外模型解析');
    assert.equal(context.extensionSettings.nora_mvu.settingsVersion, 1);

    context.extensionSettings.mvu_settings['更新方式'] = '随AI输出';
    const second = initializeHeadlessMvuSettings(context);
    assert.equal(second['更新方式'], '随AI输出', 'later user changes must not be overwritten');
    assert.equal(saves, 2);
});

test('headless MVU script registration is idempotent and preserves other scripts', () => {
    let scripts = [{ type: 'script', id: 'user-script', name: 'User script', enabled: true, content: 'user()' }];
    const helper = {
        getScriptTrees: () => structuredClone(scripts),
        replaceScriptTrees: next => { scripts = structuredClone(next); },
    };

    assert.equal(ensureHeadlessMvuScript(helper), 'installed');
    assert.equal(ensureHeadlessMvuScript(helper), 'unchanged');
    assert.equal(scripts.filter(script => script.id === MVU_SCRIPT_ID).length, 1);
    assert.equal(scripts.some(script => script.id === 'user-script'), true);

    const managed = scripts.find(script => script.id === MVU_SCRIPT_ID);
    assert.equal(managed.enabled, true);
    assert.equal(managed.button.enabled, false);
    assert.match(managed.content, /third-party\/nora-mvu\/vendor\/bundle\.js/);
});

test('headless MVU repairs a disabled or stale managed script', () => {
    let scripts = [{
        type: 'script',
        id: MVU_SCRIPT_ID,
        name: 'Old MVU',
        enabled: false,
        content: 'old()',
        button: { enabled: true, buttons: [] },
    }];
    const helper = {
        getScriptTrees: () => structuredClone(scripts),
        replaceScriptTrees: next => { scripts = structuredClone(next); },
    };

    assert.equal(ensureHeadlessMvuScript(helper), 'updated');
    assert.equal(scripts[0].enabled, true);
    assert.equal(scripts[0].button.enabled, false);
    assert.doesNotMatch(scripts[0].content, /old\(\)/);
});

test('headless MVU waits for the real variable runtime before reporting ready', async () => {
    let reads = 0;
    const runtime = await waitForMvuRuntime({
        read: () => ++reads >= 3 ? { getMvuData() {}, retryLastUpdate() {} } : undefined,
        timeoutMs: 100,
        intervalMs: 1,
    });

    assert.equal(typeof runtime.getMvuData, 'function');
    assert.equal(reads, 3);
});

test('dynamic MVU activation registers the Runner script and waits for its public API', async () => {
    const calls = [];
    const runtime = { getMvuData() {}, retryLastUpdate() {} };
    const ensureReady = createManagedMvuRuntimeLoader({
        waitForHelper: async () => {
            calls.push('helper-ready');
            return {};
        },
        ensureScript: () => {
            calls.push('script-registered');
            return 'installed';
        },
        waitForRuntime: async () => {
            calls.push('runtime-api-ready');
            return runtime;
        },
        onRegistration: registration => calls.push(`registration:${registration}`),
        timeoutMs: 20,
    });

    assert.equal(await ensureReady(), runtime);
    assert.deepEqual(calls, [
        'helper-ready',
        'script-registered',
        'registration:installed',
        'runtime-api-ready',
    ]);
});

test('headless MVU reports a missing runtime instead of silently claiming readiness', async () => {
    await assert.rejects(
        waitForMvuRuntime({ read: () => undefined, timeoutMs: 5, intervalMs: 1 }),
        /did not initialize in time/,
    );
});

test('headless MVU readiness retries after a rejected cold-start attempt', async () => {
    let attempts = 0;
    const runtime = { getMvuData() {}, retryLastUpdate() {} };
    const ensureReady = createRetryableMvuLoader(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('MVU variable runtime did not initialize in time.');
        return runtime;
    });

    await assert.rejects(ensureReady(), /did not initialize in time/);
    assert.equal(await ensureReady(), runtime);
    assert.equal(attempts, 2);
});
