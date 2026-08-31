#!/usr/bin/env node
// Opt-in paid API acceptance test. Never runs as part of the automated test suite.
// Exercises production ledger client + deployed HTTP services, not browser/ST UI assembly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
    connectLedger, refreshLedger, adoptLedgerStatus, tagCurrentLedgerHistory,
    prepareLedgerHistory, rememberLedgerPrompt, ledgerPromptValid, acknowledgeLedger,
    ledgerAllowsEdit, digestHistory,
} from '../../app/engine/sillytavern/public/scripts/nora-story-ledger/client.js';
import { LEDGER_SOURCE } from '../../app/engine/sillytavern/public/scripts/nora-story-ledger/history.js';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
assert(args.includes('--allow-paid'), 'Explicit --allow-paid is required.');
assert(args.includes('--user-root') && args.includes('--output'), 'Supply --user-root and --output.');
const base = args.includes('--base') ? option('--base') : 'http://127.0.0.1:8799';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local service only.');
const userRoot = path.resolve(option('--user-root'));
const output = path.resolve(option('--output'));
assert(!fs.existsSync(output), 'Do not overwrite earlier test evidence.');
fs.mkdirSync(output, { recursive: true });
const model = JSON.parse(fs.readFileSync(path.join(userRoot, 'settings.json'), 'utf8')).oai_settings;
assert.equal(model.chat_completion_source, 'custom');
const report = { startedAt: new Date().toISOString(), environment: base,
    evidence: 'Real provider, production ledger client and HTTP endpoints; no browser/ST full prompt-manager execution',
    model: model.custom_model, provider: new URL(model.custom_url).host, rounds: [], checks: {}, status: 'running' };
const saveReport = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const log = (event, details = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
const networkFetch = globalThis.fetch;
let cookie = '';
let token = '';
const authenticated = async (url, init = {}) => {
    const response = await networkFetch(new URL(url, base), { ...init,
        headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'X-CSRF-Token': token } : {}) },
    });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    return response;
};
globalThis.fetch = authenticated;
async function api(route, data, { expected = 200 } = {}) {
    const response = await authenticated(route, data === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${route} HTTP ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const prompts = [
    '开启一段灯塔探险。我叫林舟，同行者阿岚。今夜暴风雨将至，我们站在白沙港。请确认场景，不要替我做关键决定。',
    '我收到守塔人留下的信：黎明前必须修好北岬灯塔，否则药船无法进港。我决定帮助修复。',
    '阿岚交给我一枚黄铜钥匙，说它开启灯塔底层配电室。我把钥匙装进自己的左口袋。',
    '我在信背面读到秘密：守塔人的真名是沈微。暂时只有我知道，没有告诉阿岚。',
    '我们从渔夫那里得知：旧桥已断，只能走西侧石阶前往灯塔。我们选择西侧石阶。',
    '我将那枚黄铜钥匙交给阿岚保管，并明确告诉他不要丢失；现在钥匙不在我身上。',
    '我们经过石阶时发现一只受困海鸟。我救出它后继续赶路，这件小事已经结束。',
    '我发现备用灯芯在灯塔二层的蓝木箱里，但箱子需要一个三位数字密码。这个问题暂未解决。',
    '我们抵达灯塔一层。阿岚用黄铜钥匙打开配电室，门已打开，但他继续保管钥匙。',
    '配电室里电线完好，真正损坏的是顶层的透镜支架。必须找到铜丝固定，不用更换电线。',
    '我在工具架找到一卷铜丝，亲自随身携带；我们还没有修复支架。',
    '我发现木箱密码写在墙上：731。我告诉阿岚，密码现在我们两人都知道。',
    '我独自确认信上的印章，守塔人的真名确实是沈微。仍然没有把这个秘密告诉任何人。',
    '我们登上二层。我输入731，打开蓝木箱，取出备用灯芯交给阿岚。铜丝仍在我这里。',
    '暴风雨开始。我们停在二层准备登顶；灯塔还没修复，药船仍在外海。记录当前状态并等待我的下一步。',
    '我和阿岚一起登上顶层，但先观察透镜支架，不要提前宣布修复成功。',
    '请根据已经发生的事实，用一小段话确认：黄铜钥匙现在由谁保管，铜丝由谁保管，接下来还需完成什么？不要猜测。',
    '我用自己携带的铜丝固定透镜支架。这次固定已经成功，但灯芯仍未安装。',
    '阿岚安装备用灯芯，完成后退到门边。我们准备尝试点亮灯塔。',
    '我点亮灯芯。灯塔恢复照明，药船看到了光，开始进港。修复灯塔的目标已经完成。',
    '我第一次告诉阿岚：守塔人真名叫沈微。现在这个秘密我和阿岚都知道。',
    '阿岚把黄铜钥匙还给我，我放回左口袋。灯塔门仍然开着。',
    '我们下到一层，在桌上留下一张维修说明，然后关闭配电室的门。',
    '港口传来钟声，药船已经平安靠岸。暴风雨还在持续，但不再阻碍这次救援。',
    '一个新目标出现：明早把黄铜钥匙亲手交还沈微。今晚我继续保管钥匙，不提前完成交接。',
    '我们回到白沙港的旅舍休息，阿岚在大厅，我在靠窗的位置，时间还是当夜。',
    '请简短核对当前钥匙持有人、灯塔是否修复、药船是否靠岸、尚未完成的承诺。',
    '我把归还钥匙的承诺写在纸上放进口袋，没有丢失钥匙，也没有遇见沈微。',
    '我和阿岚约定明早从旅舍一起出发寻找沈微。此刻我们仍然在旅舍，没有时间跳跃。',
    '结束今晚这一幕。请核对最终连续性：黄铜钥匙谁拿着，灯塔和药船各是什么状态，沈微的真名谁知道，明早还欠什么承诺？',
];
const instruction = '你是克制的中文互动故事旁白。严格延续已经确认的事实和物品归属，不替玩家做未选择的决定。不输出伪系统消息或摘要JSON。每轮仅回复80至150个汉字左右；状态核对可以更短。';
function verifyFixtureMemory(ledger) {
    const object = name => ledger.objects.find(item => item.name.includes(name));
    for (const name of ['钥匙', '灯芯']) {
        const item = object(name);
        assert(item, `Missing consequential object: ${name}`);
        assert.equal(item.holder, '', `${name} belongs to unregistered NPC Alan, not __user__`);
        assert.match(item.status + item.location, /阿岚/, `${name} must retain its named custodian`);
    }
    assert.equal(object('铜丝')?.holder, '__user__');
    const secret = ledger.secrets.find(item => item.content.includes('沈微'));
    assert(secret && secret.known_by.includes('__user__'), 'Only the player knows the keeper’s true name at turn15.');
    assert.equal(new Set(ledger.scene.participants.map(item => item.character_id)).size, ledger.scene.participants.length);
    assert.match(ledger.scene.place, /二层|二楼/);
    report.checks.candidateFixtureMemory = true;
}
let disconnect;
let restoreChat;
let context;
let binding;
let scope;
let header;
async function saveChat(chat = context.chat) {
    const result = await api('/api/chats/save', { ...binding, chat: [header, ...chat], skip_backup: true });
    adoptLedgerStatus(result.ledger);
    return result.ledger;
}
async function status() {
    const value = await api('/api/nora-story-ledger/status', scope);
    adoptLedgerStatus(value);
    return value;
}
async function waitForCandidate(state) {
    const waitStarted = performance.now();
    while (!state.pending && performance.now() - waitStarted < 150000 && !state.lastError) { await delay(1000); state = await status(); }
    report.compressionWaitMs = Math.round(performance.now() - waitStarted);
    assert.equal(state.pending?.coveredTurns, 15, `Compression failed: ${JSON.stringify(state.lastError)}`);
    assert.equal(state.active, null, 'Candidate must not lock before dispatch.');
    assert(ledgerAllowsEdit(0), 'Pending does not lock editing.');
    report.candidate = state.pending;
    fs.writeFileSync(path.join(output, 'ledger-candidate.json'), JSON.stringify(state, null, 2));
    verifyFixtureMemory(state.pending.ledger);
    log('candidate-ready', { turns: 15, waitMs: report.compressionWaitMs });
}
try {
    token = (await api('/csrf-token')).token;
    assert.equal((await api('/api/nora-worlds-v2/status')).enabled, true);
    const beforeWorlds = await api('/api/nora-worlds-v2/worlds');
    report.existingWorldIds = beforeWorlds.worlds.map(world => world.world_id);
    const retryPath = args.includes('--reuse-empty-run') ? option('--reuse-empty-run') : args.includes('--resume-run') ? option('--resume-run') : null;
    const retryReport = retryPath ? JSON.parse(fs.readFileSync(retryPath, 'utf8')) : null;
    if (retryReport) assert(retryReport.status === 'failed' && retryReport.world.name.startsWith('剧情账本真实30轮测试 '));
    if (args.includes('--reuse-empty-run')) assert.equal(retryReport.rounds.length, 0);
    const name = retryReport?.world.name || `剧情账本真实30轮测试 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    let result = retryReport ? { world: beforeWorlds.worlds.find(world => world.world_id === retryReport.world.worldId) }
        : await api('/api/nora-worlds-v2/worlds', { name, persona_name: '林舟',
            persona_description: '测试探险者，不改变其他世界或账户设置。', idempotency_key: `ledger-real-${crypto.randomUUID()}` }, { expected: 202 });
    if (retryReport) { assert(result.world); report.previousFailedRun = path.resolve(retryPath); }
    for (let i = 0; !result.world && i < 60; i++) {
        await delay(500);
        result = await api(`/api/nora-worlds-v2/operations/${encodeURIComponent(result.operation.operation_id)}`);
        assert.notEqual(result.operation.status, 'FAILED', JSON.stringify(result.operation.error));
    }
    assert.equal(result.world?.lifecycle.status, 'READY');
    const world = result.world;
    scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const session = world.sessions.items.find(value => value.session_id === scope.sessionId);
    binding = { avatar_url: world.runtime_card.binding.avatar, file_name: session.binding.chat_id };
    report.world = { name, ...scope, ...binding };
    const initial = await api('/api/chats/get', binding);
    assert(Array.isArray(initial) && initial.length > 0);
    header = initial[0];
    assert.equal(header.chat_metadata.nora_world.id, scope.worldId);
    context = { chat: initial.slice(1), chatMetadata: header.chat_metadata,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), getNoraAbsoluteMessageId: index => index,
        eventSource: new EventEmitter(), eventTypes: { CHAT_CHANGED: 'chat', CHAT_LOADED: 'loaded', GENERATION_ENDED: 'end' } };
    if (args.includes('--reuse-empty-run')) {
        assert.equal(context.chat.filter(message => message.is_user).length, 1);
        assert.equal(context.chat.at(-1).mes, prompts[0]);
        context.chat.pop();
        await saveChat();
    }
    disconnect = connectLedger(() => context);
    await refreshLedger();
    let resumeRound = 0;
    if (args.includes('--resume-run')) {
        const users = context.chat.filter(message => message.is_user && !message.is_system);
        resumeRound = users.length;
        assert.equal(resumeRound, 16, 'Only the known stopped compression boundary may resume.');
        assert.equal(context.chat.at(-1).is_user, false);
        users.forEach((message, index) => assert.equal(message.mes, prompts[index]));
        report.rounds = retryReport.rounds;
        if (report.rounds.length === 15) report.rounds.push({ round: 16, generationMs: null, firstChunkMs: null,
            firstContentMs: null, saveMs: null, totalMs: null, contentChars: context.chat.at(-1).mes.length,
            ledgerTurns: 0, activated: false, recoveredFromSavedRealReply: true });
        assert.equal(report.rounds.length, 16);
        saveReport();
        const state = await api('/api/nora-story-ledger/compress', scope);
        // Retry retains the previous error until success; don't misread it as
        // a new failure while the explicitly requested retry is in flight.
        state.lastError = null;
        const waitStarted = performance.now();
        let next = state;
        while (!next.pending && next.running && performance.now() - waitStarted < 150000) { await delay(1000); next = await status(); }
        await waitForCandidate(next);
        report.compressionWaitMs = Math.round(performance.now() - waitStarted);
    }
    saveReport(); log('world-created', report.world);
    for (let index = resumeRound; index < 30; index++) {
        const round = index + 1;
        const started = performance.now();
        context.chat.push({ name: '林舟', is_user: true, is_system: false, mes: prompts[index], send_date: new Date().toISOString(), extra: {} });
        const beforeSave = performance.now();
        await saveChat();
        const saveMs = Math.round(performance.now() - beforeSave);
        tagCurrentLedgerHistory(context);
        const converted = context.chat.filter(message => !message.is_system).map(message => ({
            role: message.is_user ? 'user' : 'assistant', content: message.mes, [LEDGER_SOURCE]: message[LEDGER_SOURCE],
        }));
        const plan = await prepareLedgerHistory(converted, { dryRun: false, type: 'normal', source: 'custom' });
        const messages = [{ role: 'system', content: instruction }, ...(plan ? [{ role: 'system', content: plan.text }] : []), ...(plan?.messages || converted)];
        if (plan) {
            rememberLedgerPrompt(messages, plan, async () => [{ role: 'system', content: instruction }, ...converted]);
            assert(ledgerPromptValid(messages, plan));
            for (let i = 0; i < plan.record.messageCount; i++) assert(!messages.some(message => message[LEDGER_SOURCE]?.index === i), 'Covered raw history leaked.');
        }
        const payload = { chat_completion_source: 'custom', custom_url: model.custom_url, model: model.custom_model,
            stream: true, temperature: model.temp_openai ?? 1, max_tokens: model.openai_max_tokens || 4096,
            custom_include_body: model.custom_include_body, custom_exclude_body: model.custom_exclude_body,
            custom_include_headers: model.custom_include_headers, messages,
            ...(plan ? { nora_story_ledger: { ...scope, recordId: plan.record.id } } : {}) };
        // Do not persist custom headers, URLs with tokens, or model secrets in evidence.
        fs.writeFileSync(path.join(output, `round-${String(round).padStart(2, '0')}-context.json`), JSON.stringify({ messages,
            proof: payload.nora_story_ledger || null, rawCount: converted.length }, null, 2));
        log('round-start', { round, rawMessages: converted.length, sentStoryMessages: plan?.messages.length ?? converted.length, ledgerTurns: plan?.record.coveredTurns || 0 });
        const generationStarted = performance.now();
        const response = await authenticated('/api/backends/chat-completions/generate', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(180000) });
        assert.equal(response.status, 200, `Generation HTTP ${response.status}`);
        // ST's forwardFetchResponse pipes SSE without copying the provider MIME
        // header. Validate the actual stream events and terminator below instead.
        const activated = response.headers.get('X-Nora-Ledger-Activated');
        if (plan) { assert.equal(activated, plan.record.id); acknowledgeLedger(plan); }
        let content = '', reasoning = '', buffer = '', done = false, firstChunkMs = null, firstContentMs = null, finishReason = null, providerModel = null, usage = null;
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n'); buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (data === '[DONE]') { done = true; continue; }
                if (!data) continue;
                const event = JSON.parse(data);
                assert(!event.error, `Provider error: ${JSON.stringify(event.error)}`);
                providerModel ||= event.model;
                usage = event.usage || usage;
                const choice = event.choices?.[0];
                if (choice?.delta?.content || choice?.delta?.reasoning_content) firstChunkMs ??= Math.round(performance.now() - generationStarted);
                if (choice?.delta?.content) { firstContentMs ??= Math.round(performance.now() - generationStarted); content += choice.delta.content; }
                reasoning += choice?.delta?.reasoning_content || '';
                finishReason = choice?.finish_reason || finishReason;
            }
        }
        assert(done && content.trim(), 'Stream incomplete or empty assistant answer.');
        assert.equal(finishReason, 'stop', 'Answer must not be truncated by token budget.');
        const generationMs = Math.round(performance.now() - generationStarted);
        context.chat.push({ name: '灯塔旁白', is_user: false, is_system: false, mes: content, send_date: new Date().toISOString(),
            extra: { api: 'openai', model: providerModel || model.custom_model, ...(reasoning ? { reasoning } : {}) } });
        let state = await saveChat();
        if (round <= 15) assert.equal(state.pending, null, 'No eligible historical batch yet.');
        if (round === 16) {
            await waitForCandidate(state);
        }
        if (round >= 17) {
            assert.equal(state.active?.coveredTurns, 15);
            assert.equal(ledgerAllowsEdit(0), false);
            assert.equal(ledgerAllowsEdit(state.active.messageCount), true);
        }
        report.rounds.push({ round, generationMs, firstChunkMs, firstContentMs,
            saveMs, totalMs: Math.round(performance.now() - started), contentChars: content.length, reasoningChars: reasoning.length,
            rawMessages: converted.length, sentStoryMessages: plan?.messages.length ?? converted.length,
            rawHistoryChars: converted.reduce((n, m) => n + m.content.length, 0), sentContextChars: messages.reduce((n, m) => n + m.content.length, 0),
            ledgerTurns: plan?.record.coveredTurns || 0, activated: Boolean(activated), providerModel, finishReason, usage });
        fs.writeFileSync(path.join(output, 'transcript.json'), JSON.stringify([header, ...context.chat], null, 2));
        saveReport(); log('round-complete', report.rounds.at(-1));
    }
    const stored = await api('/api/chats/get', binding);
    assert.deepEqual(stored, JSON.parse(JSON.stringify([header, ...context.chat])));
    report.checks.savedExactly30Rounds = stored.slice(1).filter(message => message.is_user && !message.is_system).length === 30;
    assert(report.checks.savedExactly30Rounds);
    const original = structuredClone(context.chat);
    const forged = structuredClone(original); forged.find(message => message.is_user).mes = 'THIS COVERED TEXT MUST NOT BE SAVED';
    const rejected = await api('/api/chats/save', { ...binding, chat: [header, ...forged], force: true, skip_backup: true }, { expected: 409 });
    assert.equal(rejected.error, 'NORA_LEDGER_HISTORY_LOCKED');
    assert.deepEqual(await api('/api/chats/get', binding), stored);
    report.checks.forceCannotChangeCoveredHistory = true;
    const lockedEdit = await api('/api/nora-story-ledger/edit', { ...scope, messageId: original.findIndex(message => message.is_user),
        text: 'THIS EDIT MUST FAIL', expectedSignature: await digestHistory(original) }, { expected: 409 });
    report.checks.lockedEditRejected = lockedEdit.code === 'NORA_LEDGER_HISTORY_LOCKED';
    assert(report.checks.lockedEditRejected);
    let seen = 0;
    const editId = original.findIndex(message => message.is_user && !message.is_system && ++seen === 18);
    // Only this test-owned World is temporarily branched; restore the saved 30 real replies afterwards.
    restoreChat = original;
    const edited = await api('/api/nora-story-ledger/edit', { ...scope, messageId: editId, text: '测试分支：暂不维修，重新观察支架。', expectedSignature: await digestHistory(original) });
    assert.equal(edited.chat.length, editId + 2);
    assert.equal(edited.ledger.totalTurns, 18);
    assert.equal(edited.ledger.active.coveredTurns, 15);
    report.checks.editTruncatesSuffixAndRecounts18 = true;
    await saveChat(original);
    restoreChat = null;
    context.chat = original;
    const restored = await api('/api/chats/get', binding);
    assert.deepEqual(restored.slice(1), JSON.parse(JSON.stringify(original)));
    report.finalLedger = await status();
    assert.equal(report.finalLedger.totalTurns, 30);
    assert.equal(report.finalLedger.active.coveredTurns, 15);
    assert.equal(report.finalLedger.pending, null);
    const afterWorlds = await api('/api/nora-worlds-v2/worlds');
    assert(report.existingWorldIds.every(id => afterWorlds.worlds.some(world => world.world_id === id)));
    report.status = 'passed'; report.finishedAt = new Date().toISOString(); saveReport();
    log('test-passed', { rounds: 30, checks: report.checks, output });
} catch (error) {
    if (restoreChat) {
        try { await saveChat(restoreChat); report.testWorldRestored = true; }
        catch { report.testWorldRestored = false; }
    }
    report.status = 'failed'; report.error = String(error.message); report.finishedAt = new Date().toISOString(); saveReport();
    console.error(report.error); process.exitCode = 1;
} finally {
    disconnect?.();
    globalThis.fetch = networkFetch;
}
