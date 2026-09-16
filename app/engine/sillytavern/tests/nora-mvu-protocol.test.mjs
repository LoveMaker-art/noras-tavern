import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import * as wire from '../public/scripts/nora-compat/mvu-protocol.js';
import { adaptCardForMvuRuntime } from '../public/scripts/nora-compat/mvu-compatibility.js';

const require = createRequire(import.meta.url);
const { createMvuPatch } = require('../../../../nora/skills/creative/nora-cardforge/src/mvu/mvu-compiler.js');
const { applyPatchSet } = require('../../../../nora/skills/creative/nora-cardforge/src/core/patch-engine.js');
const { createEmptyCard } = require('../../../../nora/skills/creative/nora-cardforge/src/core/card-model.js');
const envelope = operations => ({ protocol: wire.NORA_MVU_PROTOCOL, operations });

test('extra-model task explains the observed story and pre-turn state instead of asking for roleplay', () => {
    const extra = wire.noraMvuInstruction();
    assert.match(extra, /<past_observe>/, 'identify the existing story container');
    assert.match(extra, /<status_current_variables>/, 'identify the existing state container');
    assert.match(extra, /剧情发生之前/, 'the supplied state precedes the turn being analyzed');
    assert.match(extra, /停止角色扮演/);
    assert.match(extra, /不再续写/);
    assert.match(extra, /最新一轮已经发生的剧情/);
    assert.match(extra, /只输出当前返回模式要求的变量更新结果/);
    assert.match(extra, /Use nora-mvu\/1\./);
});

test('extra-model task wraps the protocol and field rules, without changing inline instructions', () => {
    const fields = { type: 'object', properties: { score: { type: 'number', minimum: 0 } } };
    const extra = wire.noraMvuInstruction({ fields });
    assert.match(extra, /^<must>\n变量更新任务：[\s\S]*\n<\/must>$/);
    assert.equal((extra.match(/<must>/g) || []).length, 1);
    assert.ok(extra.includes(`Field types (unrepresentable script checks remain runtime-only): ${JSON.stringify(fields)}\n</must>`));
    const inline = wire.noraMvuInstruction({ inline: true, fields });
    assert.doesNotMatch(inline, /<\/?must>/);
    assert.equal(inline, 'Write the story, then append exactly one update block.\n'
        + extra.slice(extra.indexOf('Use nora-mvu/1.'), -'\n</must>'.length));
    assert.doesNotMatch(inline, /停止角色扮演|past_observe|剧情发生之前/);
});

test('only an active comment declaration selects Nora; ambiguity is an error', () => {
    assert.equal(wire.resolveMvuProtocol([{ comment: 'Nora', content: '[nora_mvu/1]' }]), 'legacy');
    assert.equal(wire.resolveMvuProtocol([{ comment: '[nora_mvu/1]', disable: true }]), 'legacy');
    assert.equal(wire.resolveMvuProtocol([{ comment: '[nora_mvu/1]', enabled: false }]), 'legacy');
    assert.equal(wire.resolveMvuProtocol([{ comment: '[nora_mvu/1]' }, { comment: '[nora_mvu/1]' }]), 'nora-mvu/1');
    assert.throws(() => wire.resolveMvuProtocol([{ comment: '[nora_mvu/2]' }]), { code: 'MVU_PROTOCOL_UNSUPPORTED' });
    assert.throws(() => wire.resolveMvuProtocol([{ comment: '[nora_mvu/1][nora_mvu/2]' }]), { code: 'MVU_PROTOCOL_CONFLICT' });
});

test('wire validation rejects malformed, unsafe and ambiguous output', () => {
    for (const value of [
        '```json\n{}\n```', { protocol: 'nora-mvu/1', operations: [], explanation: 'extra' },
        envelope([{ op: 'unknown', path: ['a'] }]), envelope([{ op: 'set', path: 'a', value: 2 }]),
        envelope([{ op: 'set', path: ['__proto__'], value: 2 }]), envelope([{ op: 'delete', path: ['_derived'] }]),
        envelope([{ op: 'increment', path: ['a'], amount: '2' }]), envelope([{ op: 'increment', path: ['a'], amount: Infinity }]),
        envelope([{ op: 'insert', path: ['a'], index: -1, value: 2 }]),
        envelope([{ op: 'move', from: ['a'], path: ['a', 'b'] }]),
    ]) assert.throws(() => wire.parseNoraEnvelope(value), { code: 'MVU_PROTOCOL_INVALID' });
    const encoded = wire.encodeNoraEnvelope(envelope([]));
    assert.throws(() => wire.readNoraMessage(encoded + encoded));
    assert.deepEqual(wire.readNoraMessage(encoded), envelope([]));
    assert.throws(() => wire.readNoraResponse({ tool_calls: [] }, '工具调用'));
});

test('compiler and runtime share the declaration; old cards keep their format', () => {
    const vars = { format: 'nora-mvu-fields/v1', variables: [{ group: 'player', field: 'energy', type: 'number', default: 100, description: 'Decrease after an explicit energy cost.' }] };
    const original = createEmptyCard(); original.data.name = 'Test';
    const build = options => applyPatchSet(original, createMvuPatch(original, vars, options)).card;
    const legacy = build({});
    assert.equal(wire.resolveMvuProtocol(legacy.data.character_book.entries), 'legacy');
    assert.ok(legacy.data.character_book.entries.some(entry => entry.content.includes('JSONPatch')));
    const card = build({ protocol: 'nora-mvu/1' });
    assert.equal(wire.resolveMvuProtocol(card.data.character_book.entries), 'nora-mvu/1');
    const fallback = card.data.character_book.entries.filter(wire.isMvuLegacyFallbackEntry);
    assert.equal(fallback.length, 1);
    assert.match(fallback[0].content, /JSONPatch/);
    assert.equal(wire.resolveMvuProtocol(fallback), 'legacy', 'fallback alone does not activate enhancements');
    assert.ok(card.data.extensions.tavern_helper.scripts.some(script => /MagVarUpdate@7fe9ae7/.test(script.content)));
    assert.ok(card.data.extensions.tavern_helper.scripts.some(script => /tavern_resource@b0ee9f4/.test(script.content)));
    const adapted = adaptCardForMvuRuntime(card);
    assert.equal(wire.resolveMvuProtocol(adapted.card.data.character_book.entries), 'nora-mvu/1');
    assert.ok(adapted.card.data.extensions.tavern_helper.scripts.some(script => /mvu-zod\.js\?v=4.1.11-nora4/.test(script.content)));
    assert.equal(adapted.card.data.extensions.tavern_helper.scripts.find(script => /MagVarUpdate@/.test(script.content)).enabled, false);
    assert.deepEqual(adapted.card.data.character_book, card.data.character_book, 'runtime import projection preserves baseline lore');
    assert.equal(original.data.character_book.entries.length, 0);
});

test('old local schema import is refreshed without changing lore or other scripts', () => {
    const card = createEmptyCard();
    card.data.extensions.tavern_helper.scripts = [{ type: 'script', enabled: true, content: "import '/scripts/extensions/third-party/nora-mvu/mvu-zod.js?v=4.1.11-nora1';" }];
    const result = adaptCardForMvuRuntime(card);
    assert.equal(result.changed, true);
    assert.match(result.card.data.extensions.tavern_helper.scripts[0].content, /nora4/);
    assert.deepEqual(result.card.data.character_book, card.data.character_book);
});
