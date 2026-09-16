const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { z } = require('zod');
const lodash = require('lodash');
const { createMvuPatch } = require('../src/mvu/mvu-compiler');
const root = process.env.NORA_TAVERN_ROOT || path.resolve(__dirname, '../../../../..');

test('generated Zod registers in actual Nora helper and processes valid and invalid updates', async () => {
  const protocol = await import(pathToFileURL(path.join(root, 'app/engine/sillytavern/public/scripts/nora-compat/mvu-protocol.js')));
  // Zod record parsing can discard __proto__; safety belongs to the wire
  // boundary, not a second generated preprocessor that hides field metadata.
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    assert.throws(() => protocol.parseNoraEnvelope({ protocol: 'nora-mvu/1', operations: [
      { op: 'set', path: ['玩家', '档案'], value: Object.fromEntries([[key, true]]) },
    ] }));
  }
  const helper = fs.readFileSync(path.join(root, 'app/native-extensions/nora-mvu/mvu-zod.js'), 'utf8');
  const patch = createMvuPatch({}, { format: 'nora-mvu-fields/v1', variables: [
    { group: '玩家', field: '姓名', type: 'string', default: '123', description: '明确更名后更新。' },
    { group: '玩家', field: '背包', type: 'array', items: { type: 'object', properties: { 名称: { type: 'string' }, 数量: { type: 'number', integer: true, min: 1 } } }, default: [], description: '获取物品时增加。' },
  ] }, { protocol: 'nora-mvu/1' });
  const script = patch.operations.find(o => o.name === 'Zod Schema').script.content;
  const events = new Map();
  const context = vm.createContext({ z, _: lodash, structuredClone, console: { info() {}, error() {}, warn() {} },
    parent: { NoraMvu: { protocol } }, eventOn: (key, fn) => events.set(key, fn), $: fn => typeof fn === 'function' ? fn() : {},
  });
  vm.runInContext(helper.replace('export function registerMvuSchema', 'function registerMvuSchema'), context);
  vm.runInContext(script.replace(/^import[\s\S]*?;\s*/, '').replace('export const Schema', 'const Schema'), context);
  const state = { stat_data: JSON.parse(patch.operations.find(o => o.comment?.startsWith('[initvar]')).entry.content) };
  events.get('mag_variable_initialized')(state, 0);
  assert.equal(state.stat_data.玩家.姓名, '123');
  const query = { schemas: [] }; events.get('nora_mvu_schema_query')(query);
  assert.equal(query.schemas.length, 1);
  assert.ok(query.schemas[0].fields);
  const run = (operation, type, args) => {
    protocol.parseNoraEnvelope({ protocol: 'nora-mvu/1', operations: [operation] });
    const diagnostics = { accepted_count: 0, errors: [] };
    events.get('mag_command_parsed_for_zod')(state, [{ type, args, nora: operation }], '', diagnostics);
    return diagnostics;
  };
  const item = { 名称: '地图', 数量: 1 };
  assert.equal(run({ op: 'append', path: ['玩家','背包'], value: item }, 'insert', ['玩家.背包', JSON.stringify(item)]).accepted_count, 1);
  assert.equal(state.stat_data.玩家.背包[0].名称, '地图');
  assert.equal(run({ op: 'set', path: ['玩家','姓名'], value: 'true' }, 'set', ['玩家.姓名', JSON.stringify('true')]).accepted_count, 1);
  assert.equal(state.stat_data.玩家.姓名, 'true');
  const before = JSON.stringify(state);
  const bad = { 名称: '钥匙', 数量: 'wrong' };
  const result = run({ op: 'append', path: ['玩家','背包'], value: bad }, 'insert', ['玩家.背包', JSON.stringify(bad)]);
  assert.equal(result.accepted_count, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(JSON.stringify(state), before);
});
