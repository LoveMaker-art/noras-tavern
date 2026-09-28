const test = require('node:test');
const assert = require('node:assert/strict');
const { createMvuPatch, validateCompiledMvu } = require('../src/mvu/mvu-compiler');
const { applyPatchSet } = require('../src/core/patch-engine');
const { validateStatusbarHtml, createStatusbarPatch } = require('../src/statusbar/statusbar');
const { z } = require('zod');
const YAML = require('yaml');
const base = require('../fixtures/empty-v2.json');
const spec = variables => ({ format: 'nora-mvu-fields/v1', variables });
const field = (field, rest = {}) => ({ group: '玩家', field, type: 'string', default: '', description: '根据本轮明确事件更新。', ...rest });
function compile(variables) {
  const patch = createMvuPatch(base, spec(variables), { protocol: 'nora-mvu/1' });
  const script = patch.operations.find(o => o.name === 'Zod Schema').script.content;
  // Only execute locally generated code, never scripts from imported cards.
  const body = script.replace(/^import[\s\S]*?;\s*/, '').replace('export const Schema =', 'const Schema =').replace(/\$\(\(\) => \{[\s\S]*$/, '');
  const Schema = new Function('z', body + '\nreturn Schema;')(z);
  const init = YAML.parse(patch.operations.find(o => o.comment?.startsWith('[initvar]')).entry.content);
  return { Schema, init, card: applyPatchSet(base, patch).card };
}

test('nonempty container defaults survive generation and actual Zod validation', () => {
  const { Schema, init } = compile([
    field('背包', { type: 'array', items: { type: 'string' }, default: ['地图'] }),
    field('档案', { type: 'record', values: { type: 'string' }, default: { 路人: '友善' } }),
  ]);
  assert.deepEqual(init, { 玩家: { 背包: ['地图'], 档案: { 路人: '友善' } } });
  assert.deepEqual(Schema.parse(init), init);
});
test('object arrays and typed records accept correct values and reject wrong children', () => {
  const { Schema, init } = compile([
    field('人物', { type: 'array', items: { type: 'object', properties: { 姓名: { type: 'string' }, 能量: { type: 'number', min: 0, max: 100 } } }, default: [{ 姓名: '小林', 能量: 80 }] }),
    field('数量', { type: 'record', values: { type: 'number', integer: true }, default: { 地图: 1 } }),
  ]);
  assert.deepEqual(Schema.parse(init), init);
  const wrong = structuredClone(init); wrong.玩家.人物[0].能量 = '80';
  assert.equal(Schema.safeParse(wrong).success, false);
});
test('enum requires an explicit valid default instead of an invalid initialization', () => {
  const { Schema, init } = compile([field('阶段', { type: 'enum', enumValues: ['陌生', '熟悉'], default: '陌生' })]);
  assert.deepEqual(Schema.parse(init), init);
  assert.throws(() => compile([field('阶段', { type: 'enum', enumValues: ['陌生', '熟悉'], default: '' })]), /default/);
});
test('duplicate and parent-child paths fail in either order', () => {
  for (const fields of [[field('档案'), field('档案.姓名')], [field('档案.姓名'), field('档案')], [field('姓名'), field('姓名')]]) {
    assert.throws(() => compile(fields), /conflict/i);
  }
});
test('schema rejects number coercion and enforces declared numeric bounds', () => {
  const { Schema } = compile([field('能量', { type: 'number', default: 50, min: 0, max: 100 })]);
  assert.equal(Schema.safeParse({ 玩家: { 能量: 101 } }).success, false);
  assert.equal(Schema.safeParse({ 玩家: { 能量: '50' } }).success, false);
});
test('wrong defaults, ambiguous paths and unknown configuration fail at authoring', () => {
  for (const item of [field('x', { type: 'unknown' }), field('x', { type: 'number', default: '50' }), field('x', { type: 'array', default: [] }), field('a..b'), field('__proto__.x'), field('x', { recordFields: 'ignored' }), field('x', { type: 'number', min: 10, max: 1, default: 5 })]) {
    assert.throws(() => compile([item]));
  }
});
test('declared display bindings resolve against the same field contract', () => {
  const { card } = compile([field('姓名', { default: '小林' })]);
  assert.equal(validateStatusbarHtml(card, '<html><body><span data-mvu-path=\'["玩家","姓名"]\'></span></body></html>').passed, true);
  assert.equal(validateStatusbarHtml(card, '<html><body><span data-mvu-path=\'["玩家","不存在"]\'></span></body></html>').passed, false);
  const custom = validateStatusbarHtml(card, '<html><body><script>stat_data["不存在"]</script></body></html>');
  assert.equal(custom.passed, true);
  assert.equal(custom.verification.runtime, 'not-verified');
  assert.equal(custom.verification.scriptsExecuted, false);
});

test('generated state, Zod and rules are checked together instead of by field counts', () => {
  const { card } = compile([field('姓名', { default: '小林' })]);
  assert.equal(validateCompiledMvu(card).passed, true);
  for (const mutate of [
    c => { c.data.character_book.entries.find(e => e.comment.startsWith('[initvar]')).content = '{"玩家":{"姓名":123}}'; },
    c => { c.data.extensions.tavern_helper.scripts.find(s => s.name === 'Zod Schema').content += '\n// drift'; },
    c => { c.data.extensions.cfMvuFieldContract.initial.玩家.姓名 = '不同'; },
    c => { c.data.character_book.entries.find(e => e.comment.includes('[nora_mvu/1]')).content = '不同规则'; },
    c => { c.data.character_book.entries.find(e => e.comment.includes('[nora_mvu_fallback/1]')).enabled = false; },
    c => { c.data.extensions.tavern_helper.scripts.find(s => s.name === 'MVU 变量系统').enabled = false; },
  ]) {
    const changed = structuredClone(card); mutate(changed);
    assert.equal(validateCompiledMvu(changed).passed, false);
  }
});

test('renderer reads its message snapshot after commit and displays whole values as text', async () => {
  const { card } = compile([field('姓名', { default: '小林' })]);
  const patch = createStatusbarPatch('<html><body><span data-mvu-path=\'["玩家","姓名"]\'></span></body></html>', { contract: card.data.extensions.cfMvuFieldContract });
  const html = patch.operations.find(o => o.scriptName === '状态栏美化').script.replaceString;
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const callbacks = new Map(); let ready; let state = { 玩家: { 姓名: '完整名字' } };
  const element = { getAttribute: () => '["玩家","姓名"]', textContent: '' };
  const Mvu = { events: { VARIABLE_INITIALIZED: 'init', TRANSACTION_COMMITTED: 'commit' }, getMvuData: options => {
    assert.deepEqual(options, { type: 'message', message_id: 17 }); return { stat_data: state };
  } };
  new Function('Mvu', 'getCurrentMessageId', 'waitGlobalInitialized', 'eventOn', 'document', '$', 'errorCatched', code)(
    Mvu, () => 17, async () => {}, (event, fn) => callbacks.set(event, fn), { querySelectorAll: () => [element] }, fn => { ready = fn(); }, fn => fn,
  );
  await ready;
  assert.equal(element.textContent, '完整名字');
  state = { 玩家: { 姓名: '<b>不执行HTML</b>' } }; callbacks.get('commit')();
  assert.equal(element.textContent, '<b>不执行HTML</b>');
  state = {}; callbacks.get('commit')(); assert.equal(element.textContent, '尚未初始化');
});

test('typed record/array literal subpaths are checked', () => {
  const { card } = compile([field('人物', { type: 'array', items: { type: 'object', properties: { 姓名: { type: 'string' } } }, default: [] })]);
  for (const [path, allowed] of [[['玩家','人物',0,'姓名'],true], [['玩家','人物','0','姓名'],false], [['玩家','人物',0,'不存在'],false]]) {
    assert.equal(validateStatusbarHtml(card, `<html><body><span data-mvu-path='${JSON.stringify(path)}'></span></body></html>`).passed, allowed);
  }
});

test('upstream renderer works without Nora events and reads only its own stored snapshot', async () => {
  const { card } = compile([field('姓名')]);
  const html = createStatusbarPatch('<span data-mvu-path=\'["玩家","姓名"]\'></span>', { contract: card.data.extensions.cfMvuFieldContract }).operations[0].script.replaceString;
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const callbacks = new Map(); let ready, name = '初始名字';
  const element = { getAttribute: () => '["玩家","姓名"]', textContent: '' };
  new Function('Mvu', 'tavern_events', 'getCurrentMessageId', 'waitGlobalInitialized', 'eventOn', 'document', '$', 'errorCatched', code)(
    { events: { VARIABLE_INITIALIZED: 'init', VARIABLE_UPDATE_ENDED: 'ended' }, getMvuData: ({message_id}) => {
      assert.equal(message_id, 17); return {stat_data: {玩家: {姓名: name}}};
    } }, { CHARACTER_MESSAGE_RENDERED: 'rendered' }, () => 17, async () => {},
    (event, fn) => { assert.equal(typeof event, 'string'); callbacks.set(event, fn); },
    { querySelectorAll: () => [element] }, fn => { ready = fn(); }, fn => fn,
  );
  await ready;
  assert.equal(element.textContent, '初始名字');
  assert.equal(callbacks.has('ended'), false, 'pre-persistence candidates are not a display source');
  name = '完整新名字'; callbacks.get('rendered')(18);
  assert.equal(element.textContent, '初始名字');
  callbacks.get('rendered')(17);
  assert.equal(element.textContent, '完整新名字');
});

test('custom interaction code survives compilation with or without declarative bindings', () => {
  const { card } = compile([field('姓名', { default: '小林' })]);
  const custom = '<button id="map">地图</button><script>document.getElementById("map").addEventListener("click", () => { document.getElementById("map").textContent = "车站"; });</script>';
  for (const withBinding of [false, true]) {
    const html = '<html><body>' + custom + (withBinding ? '<span data-mvu-path=\'["玩家","姓名"]\'></span>' : '') + '</body></html>';
    const patch = createStatusbarPatch(html, { contract: card.data.extensions.cfMvuFieldContract });
    const output = patch.operations.find(o => o.scriptName === '状态栏美化').script.replaceString;
    assert.ok(output.includes(html));
    assert.equal(output.includes('async function init()'), withBinding);
    assert.equal(validateStatusbarHtml(card, html).verification.runtime, 'not-verified');
  }
});

test('custom code cannot disable literal binding errors and is never run during validation', () => {
  const { card } = compile([field('姓名')]);
  const script = '<script>throw new Error("must not execute"); const template = `<span data-mvu-path=\'["动态","字段"]\'></span>`;</script>';
  const report = validateStatusbarHtml(card, script);
  assert.equal(report.passed, true);
  assert.deepEqual(report.stats.usedPaths, []);
  assert.throws(() => createStatusbarPatch(script + '<span data-mvu-path=\'["玩家","未定义"]\'></span>', { contract: card.data.extensions.cfMvuFieldContract }), /未声明/);
  assert.equal(validateStatusbarHtml(card, '<script>fetch("https://example.com")</script>').passed, false);
});

test('record keys use the same constraints for defaults, runtime values and display paths', () => {
  const { Schema, card } = compile([field('档案', { type: 'record', values: { type: 'boolean' }, default: { 甲: true } })]);
  for (const key of ['x'.repeat(129), '__proto__', 'constructor', '_只读', '有.点']) {
    const value = Object.fromEntries([[key, true]]);
    assert.throws(() => compile([field('档案', { type: 'record', values: { type: 'boolean' }, default: value })]));
    // Zod skips __proto__ record entries internally. The Nora wire parser
    // rejects that input before Zod; exercise that boundary in runtime tests.
    if (key !== '__proto__') assert.equal(Schema.safeParse({ 玩家: { 档案: value } }).success, false);
    assert.equal(validateStatusbarHtml(card, `<span data-mvu-path='${JSON.stringify(['玩家', '档案', key])}'></span>`).passed, false);
  }
});

test('clamping is explicit, preserves valid initial values and rejects missing required fields', () => {
  const { Schema, init } = compile([field('能量', { type: 'number', default: 50, min: 0, max: 100, clamp: true })]);
  assert.deepEqual(Schema.parse(init), init);
  assert.equal(Schema.parse({ 玩家: { 能量: 150 } }).玩家.能量, 100);
  assert.equal(Schema.safeParse({ 玩家: {} }).success, false);
  assert.throws(() => compile([field('能量', { type: 'number', default: 150, max: 100, clamp: true })]));
});

test('unsupported build options and templates cannot silently select another implementation', () => {
  for (const options of [{ injectMode: 'single' }, { keepFloors: -1 }, { keepFloors: 1.5 }, { keepFloors: 1001 }]) {
    assert.throws(() => createMvuPatch(base, spec([field('姓名')]), options));
  }
  const { card } = compile([field('姓名')]);
  const html = '<span data-mvu-path=\'["玩家","姓名"]\'></span>';
  assert.throws(() => createStatusbarPatch(html, { contract: card.data.extensions.cfMvuFieldContract, mode: 'text' }));
  assert.equal(validateStatusbarHtml(base, html).passed, false);
});
