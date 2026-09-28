import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMvuUpdateObserver } from '../public/scripts/nora-compat/mvu-update-observer.js';
import * as protocol from '../public/scripts/nora-compat/mvu-protocol.js';
import { isMvuUpdateInstructionEntry } from '../public/scripts/nora-compat/mvu-compatibility.js';
import { cardForgeRoot, requireCardForge } from './nora-cardforge-fixture.mjs';

// Run against the pinned, patched upstream checkout with its immutable deps.
// Parser, native schema, command executor, Zod adapter and transaction functions
// are real source. Only model transport, storage and browser events are fakes.
const source = process.env.NORA_MVU_SOURCE_DIR;
const helper = fileURLToPath(new URL('../../../native-extensions/nora-mvu/mvu-zod.js', import.meta.url));
function fixture({ inline = false, response = '', zod = false, nora = false, schemaExpected = false, realRequest = false, toolSupport = true, message = 'A quiet walk through the town.', initial = { score: 50 } } = {}) {
    const require = createRequire(path.join(source, 'package.json'));
    const ts = require('typescript');
    const lodash = require('lodash');
    const z = require('zod').z;
    const events = new Map();
    const emitted = [], reports = [], requests = [], writes = [], warnings = [], transportPrompts = [];
    const generate = async config => {
        requests.push(config);
        const data = { prompt: [{ role: 'user', content: 'Analyze this turn.' }] };
        for (const listener of events.get('generate_after') || []) await listener(data, false);
        transportPrompts.push(data.prompt);
        return typeof response === 'function' ? response(requests.length) : response;
    };
    let chatId = 'world-a';
    const snapshot = { stat_data: structuredClone(initial), initialized_lorebooks: {} };
    const chat = [snapshot, {}, { message, name: 'guide', role: 'assistant' }];
    const entries = nora ? [{ comment: '[nora_mvu/1]', enabled: true }] : [];
    const bridge = { protocol, schemaExpected: () => schemaExpected, isUpdateEntry: isMvuUpdateInstructionEntry };
    const settings = { 更新方式: inline ? '随AI输出' : '额外模型解析',
        兼容性: { sendas不视为user消息: true, 更新到聊天变量: false },
        额外模型解析配置: { 应答格式: '工具调用', 启用自动请求: true, 模型来源: '与插头相同', 破限方案: '使用当前预设', 世界书条目白名单正则: '', 世界书条目黑名单正则: '' }, 通知: { 变量更新出错: false } };
    const store = { settings, effective_settings: settings, character_settings: { is_valid: false }, runtimes: { debug: {} }, versions: { tavernhelper: '4.8.13' } };
    let failSave = false, transportError = null;
    const context = vm.createContext({
        _: lodash, z, YAML: require('yaml'), console: { log() {}, info() {}, warn: (...args) => warnings.push(args) },
        Error, Date, structuredClone, setTimeout: (fn, ms) => setTimeout(fn, ms === 15000 ? 50 : ms), clearTimeout,
        atob, btoa, getScriptId: () => 'test', getLastMessageId: () => 2,
        tavern_events: { GENERATE_AFTER_DATA: 'generate_after' },
        eventRemoveListener: (name, fn) => events.set(name, (events.get(name) || []).filter(item => item !== fn)),
        generate, generateRaw: generate,
        parent: { NoraMvu: bridge }, window: { parent: { NoraMvu: bridge } },
        getCurrentCharPrimaryLorebook: () => 'primary', getLorebookEntries: async () => entries,
        SillyTavern: { chat, name2: 'guide', registerMacro() {}, unregisterMacro() {}, getChatCompletionModel: () => 'test-model', getCurrentChatId: () => chatId, async saveChat(options) {
            if (!options) return;
            writes.push(['save', options]);
            if (failSave === 'ack') return;
            if (failSave === 'backend') throw new Error('backend rejected save');
            return { confirmed: true };
        } },
        substitudeMacros: value => value,
        registerVariableSchema() {},
        toastr: { warning() {}, error: (...args) => warnings.push(args) },
        eventOn: (name, fn) => { events.set(name, [...(events.get(name) || []), fn]); },
        eventEmit: async (name, ...args) => {
            emitted.push([name, ...structuredClone(args)]);
            for (const fn of events.get(name) || []) await fn(...args);
        },
        getChatMessages: id => {
            if (!chat[id]) return [];
            const { stat_data, schema, initialized_lorebooks } = chat[id];
            return [{ ...structuredClone(chat[id]), message_id: id,
                data: structuredClone({ stat_data, schema, initialized_lorebooks }) }];
        },
        setChatMessages: async updates => {
            writes.push(['text', structuredClone(updates)]);
            if (failSave === 'text') throw new Error('storage unavailable');
            updates.forEach(({ message_id, ...update }) => Object.assign(chat[message_id], update));
        },
        updateVariablesWith: async (update, options) => {
            writes.push(['variables', options]);
            if (failSave === true) throw new Error('storage unavailable');
            Object.assign(chat[options.message_id], structuredClone(update({})));
        },
    });
    const modules = new Map();
    const mocks = {
        '@/store': { useDataStore: () => store },
        '@/i18n': { tr: key => key === 'runtime.extraModel.updateTagMissing' ? '没有能从回复中找到<UpdateVariable>标签' : key },
        '@/function/is_extra_model_supported': { isExtraModelSupported: async () => true },
        '@/function/is_function_calling_supported': { isFunctionCallingSupported: () => toolSupport, MIN_FUNCTION_CALLING_TAVERN_HELPER_VERSION: '4.8.4' },
        '@/function/update/invoke_extra_model': {
            ExtraModelAttemptTimeoutError: class extends Error {},
            invokeExtraModelAttempt: async options => {
                requests.push(options);
                if (transportError) throw transportError;
                return typeof response === 'function' ? response(requests.length) : response;
            },
        },
    };
    if (realRequest) delete mocks['@/function/update/invoke_extra_model'];
    function load(file) {
        if (modules.has(file)) return modules.get(file).exports;
        const mod = { exports: {} };
        modules.set(file, mod);
        const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        }).outputText;
        function resolve(id) {
            if (mocks[id]) return mocks[id];
            if (id.endsWith('?raw')) return fs.readFileSync(path.join(source, 'src', id.slice(2, -4)), 'utf8');
            if (id.startsWith('@/')) return load(path.join(source, 'src', `${id.slice(2)}.ts`));
            if (id.startsWith('@util/')) return load(path.join(source, 'util', `${id.slice(6)}.ts`));
            if (id.startsWith('.')) return load(path.resolve(path.dirname(file), `${id}.ts`));
            return require(id);
        }
        vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename: file })(resolve, mod, mod.exports);
        return mod.exports;
    }
    const util = load(path.join(source, 'src/util.ts'));
    mocks['@/util'] = { ...util, getLastValidVariable: () => structuredClone(snapshot) };
    const definitions = load(path.join(source, 'src/variable_def.ts'));
    const observer = createMvuUpdateObserver({
        eventSource: { on: context.eventOn, off() {} }, events: definitions.variable_events,
        identity: () => chatId, report: event => reports.push(event),
    });
    const updater = load(path.join(source, 'src/function/update_variables.ts'));
    const runtime = load(path.join(source, 'src/function/update/on_message_received.ts'));
    if (zod) load(helper).registerMvuSchema(typeof zod === 'function' ? zod(z) : z.object({ score: z.number() }));
    return { updater, observer, requests, writes, reports, emitted, chat, warnings, settings, entries, transportPrompts, bridge,
        registerSchema: () => load(helper).registerMvuSchema(z.object({ score: z.number() })),
        readinessListeners: () => (events.get('nora_mvu_schema_ready') || []).length,
        run: options => runtime.onMessageReceived(2, options),
        runInlineDirect: () => updater.handleVariablesInMessage(2),
        prepare: messages => load(path.join(source, 'src/function/update/access.ts')).prepareMvuPrompt({ messages }),
        filter: (lores, extra) => { store.runtimes.is_during_extra_analysis = extra; return load(path.join(source, 'src/function/request/filter_entries.ts')).filterEntries(lores); },
        filterPrompts: messages => load(path.join(source, 'src/function/request/filter_prompts.ts')).filterPrompts({ messages }),
        on: context.eventOn, events: definitions.variable_events,
        switchWorld: () => { chatId = 'world-b'; },
        failSave: value => { failSave = value; },
        transportError: error => { transportError = error; },
        terminal: () => emitted.filter(([name]) => /nora_mvu_transaction_(committed|failed)/.test(name)).at(-1)?.[1],
    };
}

test('pinned MVU execution / persistence / observation result contract', { skip: !source && 'Set NORA_MVU_SOURCE_DIR to a pinned patched checkout' }, async t => {
    for (const nora of [false, true]) {
        for (const extra of [false, true]) {
            await t.test(`external unmarked lore follows protocol policy: nora=${nora} extra=${extra}`, async () => {
                const f = fixture({ nora });
                const lores = {
                    characterLore: [{ world: 'primary', comment: '[mvu_update]rules' }],
                    globalLore: [{ world: 'unmarked', comment: 'global setting' }],
                    chatLore: [{ world: 'marked', comment: '[mvu_plot]narration' }, { world: 'marked', comment: 'shared fact' }],
                    personaLore: [{ world: 'other', comment: 'persona setting' }],
                };
                await f.filter(lores, extra);
                assert.equal(lores.globalLore.length, nora || !extra ? 1 : 0);
                assert.equal(lores.personaLore.length, nora || !extra ? 1 : 0);
                assert.equal(lores.chatLore.some(entry => entry.comment === 'shared fact'), true);
            });
        }
        await t.test(`state fallback injection is Nora-only: nora=${nora}`, async () => {
            const response = nora
                ? '<UpdateVariable><NoraMvu>{"protocol":"nora-mvu/1","operations":[{"op":"set","path":["score"],"value":51}]}</NoraMvu></UpdateVariable>'
                : '<UpdateVariable>_.set("score",51);</UpdateVariable>';
            const f = fixture({ nora, realRequest: true, response });
            f.settings.额外模型解析配置.应答格式 = '聊天消息';
            f.settings.额外模型解析配置.破限方案 = '使用内置破限';
            await f.run();
            assert.ok(f.transportPrompts.length > 0);
            for (const prompts of f.transportPrompts) {
                assert.equal(prompts.some(item => item.content.includes('<status_current_variables>')), nora);
            }
        });
    }
    for (const nora of [false, true]) {
        for (const inline of [false, true]) {
            for (const extra of inline ? [false] : [false, true]) {
                await t.test(`portable format routing: nora=${nora} inline=${inline} extra=${extra}`, async () => {
                    const f = fixture({ nora, inline });
                    const fallback = { comment: '[mvu_update][nora_mvu_fallback/1]原MVU输出格式', content: 'legacy JSONPatch format', enabled: true };
                    const business = { comment: '[mvu_update]规则', content: 'business rules', enabled: true };
                    const plot = { comment: '设定', content: 'A character mentions _.set without becoming format instructions.' };
                    const lores = { characterLore: [fallback, business, plot], globalLore: [], chatLore: [], personaLore: [] };
                    const original = structuredClone(lores);
                    await f.filter(lores, extra);
                    assert.equal(lores.characterLore.includes(fallback), !nora && (inline || extra));
                    assert.equal(lores.characterLore.includes(business), inline || extra);
                    assert.ok(lores.characterLore.includes(plot));
                    assert.deepEqual(fallback, original.characterLore[0], 'entry contents are not rewritten');
                    const messages = [];
                    if (!extra) {
                        await f.prepare(messages);
                        assert.equal(messages.length, nora ? 1 : 0);
                        if (nora && inline) assert.match(messages[0].content, /nora-mvu\/1/);
                    }
                });
            }
        }
    }
    for (const zod of [false, true]) {
        for (const inline of [false, true]) {
            await t.test(`accepted same-value set: zod=${zod} inline=${inline}`, async () => {
                const command = "_.set('score', 50);";
                const f = fixture({ zod, inline, response: command, ...(inline ? { message: command } : {}) });
                await f.run();
                assert.equal(f.requests.length, inline ? 0 : 1, 'same-value assignment must not trigger a repair request');
                assert.equal(f.terminal().outcome, 'unchanged');
                assert.equal(f.terminal().persisted, true);
                assert.equal(f.terminal().diagnostics.command_count, 1);
                assert.equal(f.terminal().diagnostics.accepted_count, 1);
                assert.equal(f.chat[2].stat_data.score, 50);
                assert.equal(f.requests.length, inline ? 0 : 1);
                assert.equal(f.observer.status().updatePhase, 'no-change');
                assert.equal(f.reports.length, 0);
            });
            await t.test(`accepted changed set: zod=${zod} inline=${inline}`, async () => {
                const command = "_.set('score', 55);";
                const f = fixture({ zod, inline, response: command, ...(inline ? { message: command } : {}) });
                await f.run();
                assert.equal(f.terminal().outcome, 'updated');
                assert.equal(f.chat[2].stat_data.score, 55);
                assert.equal(f.observer.status().updateOperational, true);
            });
        }
    }
    for (const response of ['<JSONPatch>[]</JSONPatch>', '<json_patch>[]</json_patch>']) {
        await t.test(`explicit no-op: ${response}`, async () => {
            const f = fixture({ response }); await f.run();
            assert.equal(f.terminal().outcome, 'unchanged');
            assert.equal(f.requests.length, 1);
            assert.ok(!f.chat[2].message.includes('patch>'));
        });
    }
    await t.test('ordinary inline narrative is skipped, not failed or successful', async () => {
        const f = fixture({ inline: true }); await f.run();
        assert.equal(f.terminal().outcome, 'skipped');
        assert.equal(f.observer.status().updateOperational, null);
        assert.equal(f.reports.length, 0);
    });
    for (const response of ['nothing to update', '<JSONPatch>broken</JSONPatch>', '<JSONPatch>[]</JSONPatch><JSONPatch>broken</JSONPatch>', "_.set('missing', 4);"]) {
        await t.test(`invalid extra result must not become no-change: ${response}`, async () => {
            const f = fixture({ response }); await f.run();
            assert.equal(f.terminal().outcome, 'rejected');
            assert.equal(f.requests.length, 2);
            assert.equal(f.observer.status().updatePhase, 'failed');
            assert.equal(f.reports.length, 1);
        });
    }
    await t.test('Zod rejection feeds the second attempt without notifications', async () => {
        const f = fixture({ zod: true, response: n => n === 1 ? "_.set('score', 'wrong');" : "_.set('score', 52);" });
        await f.run();
        assert.equal(f.terminal().outcome, 'updated');
        assert.match(f.requests[1].repair_feedback, /number/i);
        assert.equal(f.chat[2].stat_data.score, 52);
    });
    for (const inline of [false, true]) {
        await t.test(`save rejection cannot report success or retry delta: inline=${inline}`, async () => {
            const command = "_.add('score', 1);";
            const f = fixture({ inline, response: command, ...(inline ? { message: command } : {}) });
            f.failSave(true); await f.run();
            assert.equal(f.terminal().outcome, 'persistence-unknown');
            assert.equal(f.terminal().persisted, false);
            assert.equal(f.requests.length, inline ? 0 : 1);
            assert.equal(f.observer.status().stateChanged, null);
        });
        await t.test(`world changed inside pre-save hook: inline=${inline}`, async () => {
            const command = "_.set('score', 55);";
            const f = fixture({ inline, response: command, ...(inline ? { message: command } : {}) });
            f.on(f.events.BEFORE_MESSAGE_UPDATE, f.switchWorld);
            await f.run();
            assert.equal(f.terminal().outcome, 'stale');
            assert.equal(f.writes.filter(([kind]) => kind === 'variables').length, 0);
            assert.equal(f.reports.length, 0);
        });
    }
    await t.test('cancelled provider request is not a validation failure', async () => {
        const f = fixture(); const error = new Error('cancelled'); error.name = 'AbortError';
        f.transportError(error); await f.run();
        assert.equal(f.terminal().outcome, 'cancelled');
        assert.equal(f.writes.length, 0);
        assert.equal(f.reports.length, 0);
    });
    await t.test('upstream stop-button sentinel is cancellation', async () => {
        const f = fixture(); f.transportError('Clicked stop button'); await f.run();
        assert.equal(f.terminal().outcome, 'cancelled');
        assert.equal(f.writes.length, 0);
        assert.equal(f.reports.length, 0);
    });
    for (const failure of ['ack', 'backend']) {
        await t.test(`queued browser writes are insufficient: ${failure}`, async () => {
            const f = fixture({ response: "_.add('score', 1);" });
            f.failSave(failure); await f.run();
            assert.equal(f.terminal().outcome, 'persistence-unknown');
            assert.equal(f.requests.length, 1);
            assert.equal(f.observer.status().updateOperational, false);
        });
    }
    for (const inline of [false, true]) await t.test(`legacy external consumer persists without inventing acceptance: inline=${inline}`, async () => {
        const command = "_.set('score', 51);";
        const f = fixture({ inline, response: command, ...(inline ? { message: command } : {}) });
        f.on(f.events.COMMAND_PARSED + '_for_zod', (variables, commands) => { variables.stat_data.score = 51; commands.length = 0; });
        await f.run();
        assert.equal(f.terminal().outcome, 'unverified');
        assert.equal(f.terminal().persisted, true);
        assert.equal(f.chat[2].stat_data.score, 51);
        assert.equal(f.terminal().diagnostics.accepted_count, 0);
        assert.equal(f.observer.status().updateOperational, null);
        assert.equal(f.observer.status().updatePhase, 'unverified');
        assert.equal(f.requests.length, inline ? 0 : 1);
        assert.equal(f.reports.at(-1).kind, 'mvu-update-unverified');
    });
    await t.test('direct inline entry also reports its resolved legacy protocol', async () => {
        const f = fixture({ inline: true, message: "_.set('score',51);" });
        f.on(f.events.COMMAND_PARSED + '_for_zod', (variables, commands) => { variables.stat_data.score = 51; commands.length = 0; });
        await f.runInlineDirect();
        assert.equal(f.terminal().protocol, 'legacy');
        assert.equal(f.terminal().persisted, true);
        assert.equal(f.observer.status().updateOperational, null);
        assert.equal(f.chat[2].stat_data.score, 51);
    });
    await t.test('Nora external consumer still requires acceptance evidence', async () => {
        const response = '<UpdateVariable><NoraMvu>{"protocol":"nora-mvu/1","operations":[{"op":"set","path":["score"],"value":51}]}</NoraMvu></UpdateVariable>';
        const f = fixture({ nora: true, response });
        f.on(f.events.COMMAND_PARSED + '_for_zod', (variables, commands) => { variables.stat_data.score = 51; commands.length = 0; });
        await f.run();
        assert.equal(f.terminal().outcome, 'unverified');
        assert.equal(f.terminal().persisted, false);
        assert.notEqual(f.chat[2].stat_data?.score, 51);
        assert.equal(f.requests.length, 1);
    });
    await t.test('state equality is measured after final card hooks', async () => {
        const f = fixture({ response: "_.set('score', 55);" });
        f.on(f.events.VARIABLE_UPDATE_ENDED + '_for_zod', variables => { variables.stat_data.score = 50; });
        await f.run();
        assert.equal(f.terminal().outcome, 'unchanged');
        assert.equal(f.chat[2].stat_data.score, 50);
        assert.equal(f.requests.length, 1);
    });
    for (const inline of [false, true]) {
        await t.test(`legacy partial update commits once without repeating accepted deltas: inline=${inline}`, async () => {
            const command = "_.add('score', 5); _.set('missing', 5);";
            const f = fixture({ inline, response: command, ...(inline ? { message: command } : {}) });
            await f.run();
            assert.equal(f.terminal().outcome, 'partial');
            assert.equal(f.terminal().persisted, true);
            assert.equal(f.chat[2].stat_data.score, 55);
            assert.equal(f.requests.length, inline ? 0 : 1);
            assert.equal(f.observer.status().updatePhase, 'partial');
            assert.equal(f.reports.at(-1).kind, 'mvu-update-partial');
            assert.equal(f.reports.at(-1).acceptedCount, 1);
            assert.equal(f.reports.at(-1).persisted, true);
            assert.equal(f.emitted.filter(([name]) => name === f.events.TRANSACTION_FAILED).length, 0);
        });
        await t.test(`message edited during execution is not overwritten: inline=${inline}`, async () => {
            const command = "_.set('score', 55);";
            const f = fixture({ inline, response: command, ...(inline ? { message: command } : {}) });
            f.on(f.events.VARIABLE_UPDATE_ENDED, () => { f.chat[2].message = 'Edited by user'; });
            await f.run();
            assert.equal(f.terminal().outcome, 'stale');
            assert.equal(f.writes.length, 0);
            assert.equal(f.chat[2].message, 'Edited by user');
        });
    }
    await t.test('native early-return array removal is counted as accepted', async () => {
        const f = fixture({ initial: { score: 50, items: [1, 2, 3] }, response: '<JSONPatch>[{"op":"remove","path":"/items/0"}]</JSONPatch>' });
        await f.run();
        assert.equal(f.terminal().diagnostics.accepted_count, 1);
        assert.deepEqual(f.chat[2].stat_data.items, [2, 3]);
    });
    await t.test('legacy value-with-description stays unchanged without losing its description', async () => {
        const f = fixture({ initial: { score: [50, 'Current score'] }, response: "_.set('score', 50);" });
        await f.run();
        assert.equal(f.terminal().outcome, 'unchanged');
        assert.deepEqual(f.chat[2].stat_data.score, [50, 'Current score']);
        assert.equal(f.requests.length, 1);
    });
    await t.test('native root-level array insert does not mistake root for a missing parent', async () => {
        const f = fixture({ initial: { items: ['first'] }, response: '<JSONPatch>[{"op":"insert","path":"/items/-","value":"second"}]</JSONPatch>' });
        await f.run(); assert.equal(f.terminal().outcome, 'updated');
        assert.deepEqual(f.chat[2].stat_data.items, ['first', 'second']);
    });
    await t.test('Nora lore filter preserves mixed settings and unmarked secondary books', async () => {
        const f = fixture({ nora: true });
        for (const extra of [false, true]) {
            const mixed = { comment: 'Character setting', content: "Kind guide; _.set('score', 1);", world: 'primary' };
            const lores = { characterLore: [mixed, { comment: '[mvu_update]', content: 'rules' }], globalLore: [{ comment: 'Global', content: 'town' }], personaLore: [], chatLore: [] };
            await f.filter(lores, extra);
            assert.ok(lores.characterLore.includes(mixed));
            assert.equal(lores.globalLore.length, 1);
            assert.equal(lores.characterLore.length, extra ? 2 : 1);
        }
    });
    for (const inline of [false, true]) {
        await t.test(`legacy missing record and array insertion survives full update path: inline=${inline}`, async () => {
            const command = '<UpdateVariable>_.insert("records", {"new":{"score":1}}); _.insert("items",0,"entry");</UpdateVariable>';
            const f = fixture({ inline, initial: {}, response: command, ...(inline ? { message: command } : {}),
                zod: z => z.object({ records: z.record(z.string(), z.object({ score: z.number() })).optional(), items: z.array(z.string()).optional() }),
            });
            await f.run();
            assert.equal(f.terminal().outcome, 'updated');
            assert.equal(f.terminal().diagnostics.accepted_count, 2);
            assert.deepEqual(f.chat[2].stat_data, { records: { new: { score: 1 } }, items: ['entry'] });
            assert.equal(f.requests.length, inline ? 0 : 1);
        });
    }
    for (const nora of [false, true]) await t.test(`history cleanup follows protocol: nora=${nora}`, async () => {
        const f = fixture({ nora });
        const content = 'Keep this format:\n<UpdateVariable>_.set(\'score\',51);</UpdateVariable>';
        const messages = [{ role: 'system', content }, { role: 'assistant', content }];
        await f.filterPrompts(messages);
        assert.equal(messages[0].content.includes('<UpdateVariable>'), nora);
        assert.doesNotMatch(messages[1].content, /<UpdateVariable>/);
    });
    await t.test('extra-model parses only its own payload while hooks retain full narrative', async () => {
        const story = "The guide rests. <UpdateVariable>_.add('score',1);</UpdateVariable>";
        const f = fixture({ message: story, response: "_.add('score',1);" });
        let hookText;
        f.on(f.events.COMMAND_PARSED, (_variables, _commands, text) => { hookText = text; });
        await f.run();
        assert.equal(f.chat[2].stat_data.score, 51);
        assert.equal(f.terminal().diagnostics.command_count, 1);
        assert.ok(hookText.startsWith(story));
    });
});

test('failure toasts escape diagnostic markup while background reports retain evidence', { skip: !source }, async () => {
    const f = fixture();
    f.transportError(new Error('Missing <UpdateVariable>; unexpected <b>text</b>'));
    await f.run();
    const toast = f.warnings.find(args => String(args[0]).includes('runtime.extraModel.updateFailed'));
    assert.ok(toast, 'The terminal failure should produce a notice');
    assert.doesNotMatch(toast[0], /<UpdateVariable>|<b>/);
    assert.match(toast[0], /&lt;UpdateVariable&gt;/);
    assert.match(toast[0], /MVU_/);
    assert.match(f.reports.at(-1).summary, /<UpdateVariable>/);
});

test('legacy empty responses retain trace stages and close each request scope', { skip: !source }, async () => {
    const f = fixture({ realRequest: true, response: '' });
    f.settings.额外模型解析配置.应答格式 = '聊天消息';
    const scopes = [], stages = [];
    f.bridge.trace = {
        beginRequest(protocol, id) { const scope = { protocol, id, closed: false }; scopes.push(scope); return () => { scope.closed = true; }; },
        endRequest() {}, record(stage, detail) { stages.push({ stage, detail }); },
    };
    await f.run();
    assert.equal(f.terminal().code, 'MVU_RESPONSE_PARSE_FAILED');
    assert.equal(scopes.length, 2);
    assert.ok(scopes.every(s => s.protocol === 'legacy' && s.id && s.closed));
    assert.notEqual(scopes[0].id, scopes[1].id);
    assert.equal(stages.filter(s => s.stage === 'helper-result' && s.detail.contentLength === 0).length, 2);
    assert.equal(stages.filter(s => s.stage === 'parser-input' && s.detail.contentLength === 0).length, 2);
});

test('a declared schema registering during first preparation is awaited before sending the prompt', { skip: !source }, async () => {
    const f = fixture({ nora: true, schemaExpected: true });
    const messages = [];
    const prepared = f.prepare(messages);
    setTimeout(() => f.registerSchema(), 5);
    await prepared;
    assert.equal(messages.length, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.readinessListeners(), 0);
});

test('schema readiness timeout and World switch both clean listeners and leave the prompt untouched', { skip: !source }, async () => {
    const unavailable = fixture({ nora: true, schemaExpected: true });
    const messages = [];
    await assert.rejects(unavailable.prepare(messages), { code: 'MVU_SCHEMA_UNAVAILABLE' });
    assert.equal(unavailable.readinessListeners(), 0);
    assert.equal(messages.length, 0);
    const switched = fixture({ nora: true, schemaExpected: true });
    const pending = switched.prepare(messages);
    setTimeout(() => { switched.switchWorld(); switched.registerSchema(); }, 5);
    await assert.rejects(pending, { code: 'MVU_STALE_CHAT' });
    assert.equal(switched.readinessListeners(), 0);
    assert.equal(switched.requests.length, 0);
    assert.equal(switched.writes.length, 0);
    assert.equal(messages.length, 0);
});

test('built-in extra-model requests resolve the must task reference for both protocols', { skip: !source }, async t => {
    for (const nora of [false, true]) for (const retry of nora ? [false, true] : [false]) {
        await t.test(`nora=${nora} retry=${retry}`, async () => {
            const accepted = nora
                ? protocol.encodeNoraEnvelope({ protocol: 'nora-mvu/1', operations: [{ op: 'increment', path: ['score'], amount: 2 }] })
                : "<UpdateVariable>_.set('score', 52);</UpdateVariable>";
            const f = fixture({ nora, realRequest: true, response: attempt => retry && attempt === 1 ? 'A quiet walk continues.' : accepted });
            f.settings.额外模型解析配置.应答格式 = '聊天消息';
            f.settings.额外模型解析配置.破限方案 = '使用内置破限';
            await f.run();
            assert.equal(f.terminal().outcome, 'updated', JSON.stringify(f.terminal()));
            assert.equal(f.requests.length, retry ? 2 : 1);
            for (const request of f.requests) {
                assert.match(request.user_input, /<must>/);
                const prompts = Array.from(request.ordered_prompts);
                const userIndex = prompts.indexOf('user_input');
                const task = prompts[userIndex - 1];
                assert.equal(task.role, 'system');
                assert.match(task.content, /(?:^|\n)<must>\n[\s\S]*\n<\/must>(?:\n|$)/, 'the referenced task must exist before user_input');
                assert.match(task.content, /<past_observe>/, 'the task explains the actual story container');
                assert.match(task.content, /剧情发生(?:之)?前/, 'the task explains the snapshot time');
                assert.match(task.content, /停止角色扮演/);
                assert.match(task.content, /不再续写/);
                if (nora) {
                    assert.match(task.content, /Use nora-mvu\/1\./);
                    assert.equal(prompts[0].content, '<additional_information>');
                    assert.equal(prompts.at(-1), 'user_input', 'repair does not restore creative framing');
                } else assert.match(task.content, /紧急变量更新任务/);
            }
            if (retry) assert.match(f.requests[1].ordered_prompts.find(p => typeof p === 'object' && p.content?.includes('<previous_attempt_error>')).content, /previous variable update was rejected/);
            assert.equal(f.chat[2].stat_data.score, 52);
        });
    }
});

test('built-in Nora requests omit upstream creative framing; legacy keeps it', { skip: !source }, async t => {
    for (const nora of [false, true]) for (const gemini of [false, true]) {
        await t.test(`nora=${nora} gemini=${gemini}`, async () => {
            const response = nora
                ? protocol.encodeNoraEnvelope({ protocol: 'nora-mvu/1', operations: [] })
                : '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
            const f = fixture({ nora, realRequest: true, response });
            Object.assign(f.settings.额外模型解析配置, {
                应答格式: '聊天消息', 破限方案: '使用内置破限', 随机头部: true,
                模型来源: '自定义', 模型名称: gemini ? 'gemini-test' : 'other-test', api地址: 'https://example.invalid',
            });
            await f.run();
            assert.equal(f.terminal().outcome, 'unchanged', JSON.stringify(f.terminal()));
            const prompts = Array.from(f.requests[0].ordered_prompts);
            const contents = prompts.filter(p => typeof p === 'object').map(p => p.content);
            for (const side of ['head', 'tail']) {
                const encoded = fs.readFileSync(path.join(source, `src/prompts/${gemini ? 'gemini' : 'claude'}_${side}.txt`), 'utf8');
                const decoded = Buffer.from(encoded, 'base64').toString('utf8');
                assert.equal(contents.includes(decoded), !nora, `upstream ${side}`);
            }
            if (nora) {
                assert.equal(prompts[0].content, '<additional_information>', 'no creative or random prefix');
                assert.equal(prompts.at(-1), 'user_input', 'no competing tail after the task');
                assert.equal(contents.filter(text => text.includes('<must>')).length, 1);
            }
            assert.deepEqual(prompts.filter(p => typeof p === 'string'), [
                'persona_description', 'char_description', 'world_info_before', 'world_info_after', 'chat_history', 'user_input',
            ], 'keep the original evidence sources');
        });
    }
});

test('authored plot routing survives CardForge parsing and actual MVU filtering', { skip: !source }, async () => {
    const { parseCardMarkdown } = requireCardForge('./src/card-md/card-md.js');
    const { card } = parseCardMarkdown(fs.readFileSync(new URL('fixtures/portable-world/card.md', cardForgeRoot), 'utf8'));
    const authored = card.data.character_book.entries;
    const plot = authored.find(e => e.comment === '[mvu_plot]叙事规则');
    assert.ok(plot, 'the authoring example separates prose instructions from mechanics');
    for (const inline of [false, true]) for (const extra of inline ? [false] : [false, true]) {
        const f = fixture({ nora: true, inline });
        const rule = { comment: '[mvu_update]变量更新规则', content: 'Rest restores energy.', enabled: true };
        const lore = { characterLore: [...authored, rule], globalLore: [plot], chatLore: [plot], personaLore: [plot] };
        const original = structuredClone(lore);
        await f.filter(lore, extra);
        assert.equal(lore.characterLore.includes(plot), inline || !extra);
        assert.equal(lore.characterLore.includes(rule), inline || extra);
        for (const scope of ['globalLore', 'chatLore', 'personaLore']) assert.equal(lore[scope].includes(plot), inline || !extra);
        assert.ok(lore.characterLore.some(e => e.comment === '行动规则'), 'shared mechanics are not stripped');
        assert.deepEqual(authored, original.characterLore.slice(0, authored.length), 'source entries remain unchanged');
    }
});

test('Nora protocol routes through the actual MVU executor', { skip: !source }, async t => {
    const envelope = operations => protocol.encodeNoraEnvelope({ protocol: 'nora-mvu/1', operations });
    for (const format of ['工具调用', '格式化输出', '聊天消息']) for (const preset of ['使用当前预设', '独立提示词']) {
        await t.test(`real request assembly: ${format} / ${preset}`, async () => {
            const value = { protocol: 'nora-mvu/1', operations: [{ op: 'increment', path: ['score'], amount: 2 }] };
            const response = format === '工具调用'
                ? { content: '', tool_calls: [{ function: { name: 'nora_mvu_update', arguments: value } }] }
                : format === '聊天消息' ? protocol.encodeNoraEnvelope(value) : JSON.stringify(value);
            const f = fixture({ nora: true, realRequest: true, response });
            f.settings.额外模型解析配置.应答格式 = format;
            f.settings.额外模型解析配置.破限方案 = preset;
            await f.run();
            assert.equal(f.terminal().outcome, 'updated', JSON.stringify(f.terminal()));
            assert.equal(f.requests.length, 1);
            assert.equal(f.chat[2].stat_data.score, 52);
            const config = f.requests[0];
            assert.match(JSON.stringify(config), /nora-mvu\/1/);
            if (preset === '独立提示词') assert.deepEqual(Array.from(config.ordered_prompts).filter(item => typeof item === 'string'), [
                'persona_description', 'char_description', 'world_info_before', 'world_info_after', 'chat_history', 'user_input',
            ]);
            if (format === '工具调用') assert.equal(config.tools[0].function.name, 'nora_mvu_update');
            if (format === '格式化输出') assert.equal(config.json_schema.name, 'nora_mvu_v1');
        });
    }
    for (const inline of [false, true]) for (const zod of [false, z => z.object({ score: z.number(), items: z.array(z.string()), people: z.record(z.string(), z.string()) })]) {
        await t.test(`six operations and literal values: inline=${inline} Zod=${Boolean(zod)}`, async () => {
            const literal = "_.set('score',999); <JSONPatch>[]</JSONPatch> {{user}}";
            const response = envelope([
                { op: 'set', path: ['people', 'a.b/[x]'], value: literal },
                { op: 'increment', path: ['score'], amount: 2 },
                { op: 'append', path: ['items'], value: 'second' },
                { op: 'insert', path: ['items'], index: 0, value: 'first' },
                { op: 'delete', path: ['items', 2] },
                { op: 'move', from: ['people', 'a.b/[x]'], path: ['people', 'renamed'] },
            ]);
            const f = fixture({ nora: true, inline, zod, initial: { score: 50, items: ['old'], people: {} }, response, ...(inline ? { message: 'Walking. ' + response } : {}) });
            await f.run();
            assert.equal(f.terminal().outcome, 'updated', JSON.stringify(f.terminal()));
            assert.equal(f.requests.length, inline ? 0 : 1);
            assert.deepEqual(f.chat[2].stat_data.items, ['first', 'old']);
            assert.deepEqual(f.chat[2].stat_data.people, { renamed: literal });
            assert.equal(f.chat[2].stat_data.score, 52);
            assert.equal(f.terminal().diagnostics.accepted_count, 6);
        });
    }
    for (const inline of [false, true]) {
        await t.test(`Nora invalid batch never commits partial state: inline=${inline}`, async () => {
            const response = envelope([{ op: 'increment', path: ['score'], amount: 5 }, { op: 'increment', path: ['missing'], amount: 1 }]);
            const f = fixture({ nora: true, inline, response, ...(inline ? { message: response } : {}) }); await f.run();
            assert.equal(f.terminal().persisted, false);
            assert.notEqual(f.terminal().outcome, 'partial');
            assert.ok(!f.chat[2].stat_data || f.chat[2].stat_data.score === 50);
            assert.equal(f.requests.length, inline ? 0 : 2);
        });
        await t.test(`Nora old commands are not a fallback: inline=${inline}`, async () => {
            const response = "_.set('score',999);";
            const f = fixture({ nora: true, inline, response, ...(inline ? { message: response } : {}) }); await f.run();
            assert.equal(f.terminal().persisted, false);
            assert.ok(!f.chat[2].stat_data || f.chat[2].stat_data.score === 50);
        });
        await t.test(`declared but unavailable Zod is explicit: inline=${inline}`, async () => {
            const f = fixture({ nora: true, inline, schemaExpected: true }); await f.run();
            assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0);
            assert.equal(f.terminal().code, 'MVU_SCHEMA_UNAVAILABLE');
            assert.equal(f.observer.status().updatePhase, 'failed');
        });
        await t.test(`legacy does not require Nora schema registration: inline=${inline}`, async () => {
            const command = "_.set('score', 51);";
            const f = fixture({ inline, schemaExpected: true, response: command, ...(inline ? { message: command } : {}) });
            await f.run();
            assert.equal(f.terminal().persisted, true);
            assert.equal(f.chat[2].stat_data.score, 51);
            assert.equal(f.readinessListeners(), 0);
        });
    }
    await t.test('structured repair replaces the candidate, not already applied deltas', async () => {
        const f = fixture({ nora: true, response: n => envelope(n === 1 ? [
            { op: 'increment', path: ['score'], amount: 5 }, { op: 'delete', path: ['missing'] },
        ] : [{ op: 'increment', path: ['score'], amount: 5 }]) });
        await f.run(); assert.equal(f.requests.length, 2); assert.equal(f.chat[2].stat_data.score, 55);
    });
    await t.test('same update event is coalesced and later duplicates are ignored', async () => {
        const f = fixture({ response: "_.add('score', 1);" });
        await Promise.all([f.run(), f.run()]); await f.run();
        assert.equal(f.requests.length, 1); assert.equal(f.chat[2].stat_data.score, 51);
    });
    for (const nora of [false, true]) {
        for (const zod of [false, true]) {
            const label = `nora=${nora} zod=${zod}`;
            const message = `Story ${nora ? envelope([{ op: 'increment', path: ['score'], amount: 1 }]) : '<UpdateVariable>_.add(\'score\',1);</UpdateVariable>'}`;
            await t.test(`failed manual retry preserves existing text and successful snapshot: ${label}`, async () => {
                const f = fixture({ nora, zod, message, response: 'invalid' });
                Object.assign(f.chat[2], { stat_data: { score: 51 }, schema: {}, initialized_lorebooks: {} });
                const existing = structuredClone(f.chat[2]);
                await f.run({ force: true });
                assert.deepEqual(f.chat[2], existing);
                assert.equal(f.writes.length, 0, 'a rejected replacement must not overwrite the existing result');
                assert.equal(f.terminal().persisted, false);
            });
            await t.test(`successful manual retry replaces from the previous turn, without accumulating twice: ${label}`, async () => {
                const f = fixture({ nora, zod, message, response: () => {
                    assert.equal(f.chat[2].stat_data.score, 51, 'keep the current result while waiting for its replacement');
                    return nora ? envelope([{ op: 'increment', path: ['score'], amount: 2 }]) : "_.add('score',2);";
                } });
                Object.assign(f.chat[2], { stat_data: { score: 51 }, schema: {}, initialized_lorebooks: {} });
                await f.run({ force: true });
                assert.equal(f.chat[2].stat_data.score, 52, '50 + 2, not 51 + 2');
                assert.equal(f.terminal().persisted, true);
                assert.equal(f.requests.length, 1);
            });
            await t.test(`first failed update with no current snapshot still inherits the previous turn: ${label}`, async () => {
                const f = fixture({ nora, zod, response: 'invalid' });
                await f.run();
                assert.equal(f.chat[2].stat_data.score, 50);
                assert.equal(f.terminal().persisted, false, 'inherited state is not a successful model update');
            });
        }
    }
    await t.test('prompt injection and request-time identity survive until commit', async () => {
        const f = fixture({ nora: true, inline: true });
        const messages = [{ role: 'assistant', content: 'Old story. ' + envelope([]) }];
        await f.prepare(messages);
        assert.equal(messages[0].content.trim(), 'Old story.');
        assert.match(messages[1].content, /nora-mvu\/1/);
        f.entries[0].comment = '[nora_mvu/2]';
        await f.run(); assert.equal(f.terminal().persisted, false); assert.equal(f.writes.length, 0);
    });
    await t.test('unsupported tool mode rejects Nora but reports native inline fallback', async () => {
        const nora = fixture({ nora: true, toolSupport: false }); await nora.run();
        assert.equal(nora.terminal().code, 'MVU_TOOL_UNSUPPORTED'); assert.equal(nora.requests.length, 0);
        const legacy = fixture({ toolSupport: false, message: "_.set('score',51);" }); await legacy.run();
        assert.equal(legacy.requests.length, 0);
        assert.equal(legacy.observer.status().updateMode, 'inline');
        assert.match(legacy.observer.status().fallbackReason, /Extra-model support unavailable/);
    });
});
