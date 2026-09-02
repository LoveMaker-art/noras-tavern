import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/nora-locale-fixture.mjs';
import lodash from 'lodash';
import { z } from 'zod';

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
import { createManagedMvuRuntimeLoader } from '../../../native-extensions/nora-mvu/runtime.js';
import { createMvuUpdateObserver } from '../../../native-extensions/nora-mvu/update-observer.js';
import { registerMvuSchema } from '../../../native-extensions/nora-mvu/mvu-zod.js';

test('managed MVU script is installed in persisted Helper settings', () => {
    const context = { extensionSettings: { tavern_helper: { script: { scripts: [
        { id: 'user-script', content: 'user()' },
    ] } } } };
    assert.equal(ensureHeadlessMvuScriptInSettings(context), 'installed');
    assert.equal(ensureHeadlessMvuScriptInSettings(context), 'unchanged');
    assert.equal(context.extensionSettings.tavern_helper.script.enabled.global, true);
    assert.equal(context.extensionSettings.tavern_helper.script.scripts.at(-1).id, MVU_SCRIPT_ID);
    assert.match(context.extensionSettings.tavern_helper.script.scripts.at(-1).content, /third-party\/nora-mvu\/vendor\/bundle\.js/);
});

test('local MVU schema runtime initializes and validates card variables without network imports', (t) => {
    const original = new Map([
        ['z', globalThis.z],
        ['_', globalThis._],
        ['eventOn', globalThis.eventOn],
        ['registerVariableSchema', globalThis.registerVariableSchema],
    ]);
    const listeners = new Map();
    let registered;
    globalThis.z = z;
    globalThis._ = lodash;
    globalThis.eventOn = (event, handler) => listeners.set(event, handler);
    globalThis.registerVariableSchema = (schema, options) => { registered = { schema, options }; };
    t.after(() => {
        for (const [name, value] of original) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });

    registerMvuSchema(() => z.object({ score: z.number().default(0) }));
    assert.deepEqual(registered.options, { type: 'message' });
    assert.deepEqual([...listeners.keys()].sort(), [
        'mag_command_parsed_ended_for_zod',
        'mag_command_parsed_for_zod',
        'mag_variable_initialized',
        'mag_variable_update_ended_for_zod',
    ]);

    const variables = { stat_data: { score: 1, cardOwnedField: true } };
    listeners.get('mag_variable_initialized')(variables, 0);
    assert.deepEqual(variables.stat_data, { score: 1, cardOwnedField: true });

    const commands = [{ type: 'set', args: ['score', '2'], full_match: 'set score' }];
    listeners.get('mag_command_parsed_for_zod')(variables, commands);
    assert.equal(variables.stat_data.score, 2);
    assert.deepEqual(commands, []);
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

test('MVU update observation distinguishes initialization, no-command runs and parsed updates', () => {
    const listeners = new Map();
    const eventSource = {
        on: (event, handler) => listeners.set(event, handler),
        off: (event) => listeners.delete(event),
    };
    const events = {
        VARIABLE_UPDATE_STARTED: 'started',
        COMMAND_PARSED: 'commands',
        VARIABLE_UPDATE_ENDED: 'ended',
    };
    let chatId = 'world-a';
    let clock = 10;
    const reports = [];
    const observer = createMvuUpdateObserver({ eventSource, events, identity: () => chatId, now: () => ++clock, report: event => reports.push(event) });

    assert.equal(observer.status().updateOperational, null);
    listeners.get('started')({ stat_data: { score: 0 } });
    listeners.get('commands')({}, []);
    listeners.get('ended')({ stat_data: { score: 0 } }, { stat_data: { score: 0 } });
    assert.deepEqual(observer.status(), {
        updateOperational: false,
        updatePhase: 'no-command',
        lastUpdateAt: 12,
        lastUpdateCode: 'MVU_NO_UPDATE_COMMAND',
        lastUpdateStage: 'parsing',
        lastUpdateError: 'NO_UPDATE_COMMAND',
        lastUpdateCommandCount: 0,
        lastUpdateValidationErrors: [],
        stateChanged: false,
        transactionDurationMs: null,
        transactionAttempt: null,
        hasPreviousSnapshot: false,
    });

    listeners.get('started')({ stat_data: { score: 0 } });
    listeners.get('commands')({}, [{ type: 'set' }]);
    listeners.get('ended')({ stat_data: { score: 1 } }, { stat_data: { score: 0 } });
    assert.equal(observer.status().updateOperational, true);
    assert.equal(observer.status().stateChanged, true);
    assert.equal(observer.status().lastUpdateCommandCount, 1);

    listeners.get('started')({ stat_data: { score: 1 } });
    listeners.get('commands')({}, [{ type: 'set' }]);
    listeners.get('ended')({ stat_data: { score: 1 } }, { stat_data: { score: 1 } });
    assert.deepEqual(observer.status(), {
        updateOperational: false,
        updatePhase: 'no-change',
        lastUpdateAt: 16,
        lastUpdateCode: 'MVU_NO_STATE_CHANGE',
        lastUpdateStage: 'validation',
        lastUpdateError: 'NO_STATE_CHANGE',
        lastUpdateCommandCount: 1,
        lastUpdateValidationErrors: [],
        stateChanged: false,
        transactionDurationMs: null,
        transactionAttempt: null,
        hasPreviousSnapshot: false,
    });

    chatId = 'world-b';
    assert.equal(observer.status().updateOperational, null, 'telemetry from another World must not leak');
    assert.deepEqual(reports.map(item => item.code), ['MVU_NO_UPDATE_COMMAND', 'MVU_NO_STATE_CHANGE']);
    observer.dispose();
    assert.equal(listeners.size, 0);
});

test('MVU transaction observation preserves prior readiness and reports bounded completion', () => {
    const listeners = new Map();
    const eventSource = {
        on: (event, handler) => listeners.set(event, handler),
        off: event => listeners.delete(event),
    };
    const observer = createMvuUpdateObserver({
        eventSource,
        events: {
            VARIABLE_UPDATE_STARTED: 'variable-started',
            COMMAND_PARSED: 'commands',
            VARIABLE_UPDATE_ENDED: 'variable-ended',
            TRANSACTION_STARTED: 'transaction-started',
            TRANSACTION_COMMITTED: 'transaction-committed',
            TRANSACTION_FAILED: 'transaction-failed',
        },
        identity: () => 'world-a',
        now: () => 100,
    });

    listeners.get('transaction-started')({ had_snapshot: true });
    assert.equal(observer.status().updatePhase, 'updating');
    assert.equal(observer.status().hasPreviousSnapshot, true);

    listeners.get('variable-started')();
    listeners.get('commands')({}, [{ type: 'set' }]);
    listeners.get('variable-ended')({ stat_data: { score: 2 } }, { stat_data: { score: 1 } });
    assert.equal(observer.status().updatePhase, 'updating', 'candidate evaluation must not publish completion');

    listeners.get('transaction-committed')({
        attempt: 2,
        duration_ms: 42000,
        diagnostics: { command_count: 1 },
    });
    assert.equal(observer.status().updatePhase, 'completed');
    assert.equal(observer.status().transactionAttempt, 2);
    assert.equal(observer.status().transactionDurationMs, 42000);
    observer.dispose();
});

test('MVU transaction observation records an explicit empty JSONPatch as successful without a state change', () => {
    const listeners = new Map();
    const eventSource = {
        on: (event, handler) => listeners.set(event, handler),
        off: event => listeners.delete(event),
    };
    const observer = createMvuUpdateObserver({
        eventSource,
        events: {
            VARIABLE_UPDATE_STARTED: 'variable-started',
            COMMAND_PARSED: 'commands',
            VARIABLE_UPDATE_ENDED: 'variable-ended',
            TRANSACTION_STARTED: 'transaction-started',
            TRANSACTION_COMMITTED: 'transaction-committed',
            TRANSACTION_FAILED: 'transaction-failed',
        },
        identity: () => 'world-a',
        now: () => 120,
    });

    listeners.get('transaction-started')({ had_snapshot: true });
    listeners.get('transaction-committed')({
        attempt: 1,
        duration_ms: 2100,
        diagnostics: { command_count: 0, modified: false, errors: [] },
    });

    assert.equal(observer.status().updateOperational, true);
    assert.equal(observer.status().updatePhase, 'completed');
    assert.equal(observer.status().stateChanged, false);
    assert.equal(observer.status().lastUpdateCommandCount, 0);
    observer.dispose();
});

test('MVU transaction failure preserves structured root-cause evidence and reports it once', () => {
    const listeners = new Map();
    const reports = [];
    const eventSource = {
        on: (event, handler) => listeners.set(event, handler),
        off: event => listeners.delete(event),
    };
    const observer = createMvuUpdateObserver({
        eventSource,
        events: {
            VARIABLE_UPDATE_STARTED: 'variable-started',
            COMMAND_PARSED: 'commands',
            VARIABLE_UPDATE_ENDED: 'variable-ended',
            TRANSACTION_STARTED: 'transaction-started',
            TRANSACTION_COMMITTED: 'transaction-committed',
            TRANSACTION_FAILED: 'transaction-failed',
        },
        identity: () => 'session:test',
        now: () => 1788318000000,
        report: event => reports.push(event),
    });

    listeners.get('transaction-started')({ had_snapshot: true });
    listeners.get('transaction-failed')({
        error_code: 'MVU_COMMAND_VALIDATION_FAILED',
        stage: 'validation',
        error: 'Two commands violated the card schema.',
        attempt: 2,
        duration_ms: 8331,
        diagnostics: {
            command_count: 2,
            errors: [
                { command: '_.set', content: 'path gender expected enum' },
                { command: '_.insert', content: 'target was not an array' },
            ],
        },
    });

    assert.deepEqual(observer.status(), {
        updateOperational: false,
        updatePhase: 'failed',
        lastUpdateAt: 1788318000000,
        lastUpdateCode: 'MVU_COMMAND_VALIDATION_FAILED',
        lastUpdateStage: 'validation',
        lastUpdateError: 'Two commands violated the card schema.',
        lastUpdateCommandCount: 2,
        lastUpdateValidationErrors: [
            { commandType: '_.set', reason: 'path gender expected enum' },
            { commandType: '_.insert', reason: 'target was not an array' },
        ],
        stateChanged: false,
        transactionDurationMs: 8331,
        transactionAttempt: 2,
        hasPreviousSnapshot: true,
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].identity, 'session:test');
    assert.equal(reports[0].code, 'MVU_COMMAND_VALIDATION_FAILED');
    observer.dispose();
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

test('MVU model inspection merges the live card protocol with persisted World readiness', async () => {
    const adapter = createMvuModelAdapter({
        readApi: () => ({
            status: () => ({ supported: true, initialized: true }),
            inspectCurrentCard: async () => ({
                supported: true,
                initialized: true,
                updateProtocol: 'legacy-adaptable',
                splitModelSupported: false,
            }),
        }),
    });
    const inspected = await adapter.inspect({
        declared: ['mvu'],
        items: { mvu: { status: 'READY', evidence: { runtime_ready: true } } },
    });

    assert.equal(inspected.updateProtocol, 'legacy-adaptable');
    assert.equal(inspected.splitModelSupported, false);
    assert.equal(inspected.runtimeReady, true);
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
                json: async () => ({ base_url: 'https://api.example.com/v1', model: 'mvu-fast', context: 128000, max_tokens: 20000, has_api_key: true }),
            };
        },
        readApi: () => ({
            useIndependentModel: profile => activations.push(profile),
        }),
    });

    await adapter.configureIndependent({ baseUrl: 'https://api.example.com/v1', model: 'mvu-fast', apiKey: 'secret' });

    assert.equal(requests[0].url, '/api/nora-mvu-model/configure');
    assert.equal(requests[0].body.api_key, 'secret');
    assert.deepEqual(activations, [{ model: 'mvu-fast', contextLimit: 128000, maxTokens: 20000 }], 'the frontend MVU settings must receive limits but never the key');
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
    assert.equal(shouldSuppressNoraMvuUpdateEntryForMainPrompt(updateRule, {
        extensionSettings,
        lorebookEntries: [updateRule],
    }), true);
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

test('legacy MVU update rules stay in the story prompt when upstream split mode is unsupported', () => {
    const init = { uid: 0, comment: '[InitVar]', content: '角色:\n  好感度: 0', disable: true };
    const updateRule = {
        uid: 1,
        comment: '变量规则',
        content: '<status_current_variables>\nReturn <UpdateVariable> commands.',
        disable: false,
    };
    const extensionSettings = {
        mvu_settings: createHeadlessMvuSettings({
            '更新方式': '额外模型解析',
            '额外模型解析配置': { '启用自动请求': true },
        }),
    };

    assert.equal(shouldSuppressNoraMvuUpdateEntryForMainPrompt(updateRule, {
        extensionSettings,
        lorebookEntries: [init, updateRule],
    }), false);
});

test('MVU prompt routing follows the primary lorebook exactly like the pinned upstream runtime', () => {
    const legacyRule = {
        uid: 1,
        world: 'Primary legacy book',
        comment: '变量规则',
        content: '<status_current_variables>\nReturn <UpdateVariable> commands.',
    };
    const unrelatedSplitRule = {
        uid: 2,
        world: 'Global helper book',
        comment: '[mvu_update] helper',
        content: '<UpdateVariable>',
    };
    const extensionSettings = { mvu_settings: createHeadlessMvuSettings({}) };

    assert.equal(shouldSuppressNoraMvuUpdateEntryForMainPrompt(legacyRule, {
        extensionSettings,
        lorebookEntries: [legacyRule, unrelatedSplitRule],
        primaryLorebookName: 'Primary legacy book',
    }), false);
    assert.equal(shouldSuppressNoraMvuUpdateEntryForMainPrompt(unrelatedSplitRule, {
        extensionSettings,
        lorebookEntries: [legacyRule, unrelatedSplitRule],
        primaryLorebookName: 'Global helper book',
    }), true);
});

test('model UI is hidden for ordinary cards and labels MVU state precisely', () => {
    assert.equal(renderMvuModelSection({ supported: false }, escapeHtml), '');
    assert.match(renderMvuModelSection({ supported: true, runtimeReady: true, initialized: false, variableModel: '与插头相同' }, escapeHtml), /运行时已加载[\s\S]*跟随文本模型[\s\S]*data-mvu-config/);
    assert.match(renderMvuModelSection({ supported: true, initialized: true, variableModel: '自定义', variableModelName: '<fast>' }, escapeHtml), /已初始化[\s\S]*&lt;fast&gt;/);
    assert.match(renderMvuModelSection({ supported: true, initialized: true, updateOperational: true, variableModel: '与插头相同' }, escapeHtml), /更新正常/);
    assert.match(renderMvuModelSection({ supported: true, initialized: true, updateOperational: false, variableModel: '与插头相同' }, escapeHtml), /更新未生效/);
    assert.match(renderMvuModelSection({ supported: true, initialized: true, updateProtocol: 'legacy-adaptable', variableModel: '与插头相同' }, escapeHtml), /兼容模式/);
    assert.match(renderMvuModelSection({ supported: true, initialized: true, updateProtocol: 'initialization-only', variableModel: '与插头相同' }, escapeHtml), /仅初始化/);
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

test('headless MVU defaults to the bounded Nora update transaction without UI notifications', () => {
    const settings = createHeadlessMvuSettings({});

    assert.equal(settings['更新方式'], '额外模型解析');
    assert.equal(settings['额外模型解析配置']['启用自动请求'], true);
    assert.equal(settings['额外模型解析配置']['破限方案'], '使用内置破限');
    assert.equal(settings['额外模型解析配置']['应答格式'], '聊天消息');
    assert.equal(settings['额外模型解析配置']['模型来源'], '与插头相同');
    assert.equal(settings['额外模型解析配置']['请求次数'], 1);
    assert.equal(settings['额外模型解析配置']['最大回复token数'], 20000);
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

test('headless settings migration enables the bounded variable-model transaction once', () => {
    let saves = 0;
    const context = {
        extensionSettings: {
            mvu_settings: { '更新方式': '随AI输出' },
        },
        saveSettingsDebounced: () => { saves += 1; },
    };

    const first = initializeHeadlessMvuSettings(context);
    assert.equal(first['更新方式'], '额外模型解析');
    assert.equal(first['额外模型解析配置']['最大上下文token数'], 128000);
    assert.equal(first['额外模型解析配置']['最大回复token数'], 20000);
    assert.equal(context.extensionSettings.nora_mvu.settingsVersion, 4);

    context.extensionSettings.mvu_settings['更新方式'] = '随AI输出';
    const second = initializeHeadlessMvuSettings(context);
    assert.equal(second['更新方式'], '随AI输出', 'later user changes must not be overwritten');
    assert.equal(saves, 2);
});

test('headless settings migration raises only the legacy 4096 MVU token limit', () => {
    const legacy = {
        extensionSettings: {
            nora_mvu: { settingsVersion: 2 },
            mvu_settings: {
                '更新方式': '随AI输出',
                '额外模型解析配置': { '最大回复token数': 4096 },
            },
        },
        saveSettingsDebounced() {},
    };
    const migrated = initializeHeadlessMvuSettings(legacy);
    assert.equal(migrated['额外模型解析配置']['最大上下文token数'], 128000);
    assert.equal(migrated['额外模型解析配置']['最大回复token数'], 20000);
    assert.equal(migrated['更新方式'], '随AI输出', 'a token-limit migration must preserve user workflow choices');

    const customized = {
        extensionSettings: {
            nora_mvu: { settingsVersion: 2 },
            mvu_settings: { '额外模型解析配置': { '最大回复token数': 12000 } },
        },
        saveSettingsDebounced() {},
    };
    assert.equal(initializeHeadlessMvuSettings(customized)['额外模型解析配置']['最大回复token数'], 12000);
});

test('managed MVU script registration is idempotent and repairs stale copies', async () => {
    let scripts = [
        { type: 'script', id: 'user-script', name: 'User script', enabled: true, content: 'user()' },
        { type: 'script', id: MVU_SCRIPT_ID, name: 'Old MVU', enabled: false, content: 'old()' },
    ];
    const helper = {
        getScriptTrees: () => structuredClone(scripts),
        replaceScriptTrees: next => { scripts = structuredClone(next); },
    };

    assert.equal(await ensureHeadlessMvuScript(helper), 'updated');
    assert.equal(await ensureHeadlessMvuScript(helper), 'unchanged');
    assert.deepEqual(scripts.map(script => script.id), ['user-script', MVU_SCRIPT_ID]);
    assert.equal(scripts[1].enabled, true);
    assert.equal(scripts[1].button.enabled, false);
    assert.match(scripts[1].content, /third-party\/nora-mvu\/vendor\/bundle\.js/);
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

test('dynamic MVU activation registers the managed Helper script and waits for its public API', async () => {
    const calls = [];
    const runtime = { getMvuData() {}, retryLastUpdate() {} };
    const ensureReady = createManagedMvuRuntimeLoader({
        waitForHelper: async () => {
            calls.push('helper-ready');
            return {};
        },
        ensureScript: async () => {
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

test('headless MVU ignores a stale loader error from a script replaced during upgrade', async () => {
    let reads = 0;
    const runtime = await waitForMvuRuntime({
        read: () => ++reads >= 3 ? { getMvuData() {} } : undefined,
        readImportError: () => ({ loaderVersion: 1, message: 'stale relative URL failure' }),
        timeoutMs: 100,
        intervalMs: 1,
    });

    assert.equal(typeof runtime.getMvuData, 'function');
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
