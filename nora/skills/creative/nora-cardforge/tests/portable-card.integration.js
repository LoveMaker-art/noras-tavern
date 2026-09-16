const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { initProject, buildProject } = require('../src/project/project-engine');
const { readCard } = require('../src/core/card-io');

const source = process.env.NORA_MVU_SOURCE_DIR;
const upstreamHelper = process.env.NORA_UPSTREAM_ZOD_PATH;
const root = path.resolve(__dirname, '../../../../..');
const upstreamCommit = '7fe9ae7cfe01f13d606f7a2e533a458431fe318c';
const helperSha = '78c40f52d81022d9d769a923a49e673b8babb562656051a7d0410b6b19f45184';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));

// The same generated PNG enters both executions. Upstream modules are read
// using git show at the exact commit, not from the patched working tree.
// Model output and host event/storage services are controlled substitutes;
// this is not a browser, provider or HTTP-persistence acceptance test.
function runtime(card, nora, protocol, restoredState = null) {
  const req = createRequire(path.join(source, 'package.json'));
  const ts = req('typescript'), lodash = req('lodash'), zod = req('zod');
  const events = new Map(), writes = [], emitted = [];
  const entries = card.data.character_book.entries;
  let previous = { stat_data: restoredState || JSON.parse(entries.find(e => e.comment.startsWith('[initvar]')).content), initialized_lorebooks: {} };
  const chat = [previous, { role: 'assistant', name: '林舟', message: '' }];
  const settings = { 更新方式: '随AI输出', 通知: {变量更新出错: true}, 兼容性: {更新到聊天变量: false, sendas不视为user消息: true} };
  const store = { effective_settings: settings, settings, runtimes: { debug: {} } };
  const bridge = { protocol, schemaExpected: () => true };
  const on = (name, fn) => events.set(name, [...(events.get(name) || []), fn]);
  const emit = async (name, ...args) => {
    emitted.push(name);
    for (const fn of events.get(name) || []) await fn(...args);
  };
  const context = vm.createContext({
    _: lodash, z: zod, YAML: req('yaml'), structuredClone, Error, Date, setTimeout, clearTimeout,
    console: { info() {}, log() {}, warn() {}, error() {} },
    toastr: { warning() {}, error() {} },
    $: fn => typeof fn === 'function' ? fn() : { prop: () => true },
    parent: nora ? { NoraMvu: bridge } : {}, window: { parent: nora ? {NoraMvu: bridge} : {} },
    registerVariableSchema() {}, eventOn: on, eventEmit: emit,
    eventRemoveListener: (name, fn) => events.set(name, (events.get(name) || []).filter(listener => listener !== fn)),
    getScriptId: () => 'portable', getLastMessageId: () => 1,
    getCurrentCharPrimaryLorebook: () => 'primary', getLorebookEntries: async () => entries,
    substitudeMacros: value => value,
    SillyTavern: { chat, name2: '林舟', getCurrentChatId: () => 'portable-chat', saveChat: async () => {
      writes.push('save-confirmed'); return { confirmed: true };
    } },
    getChatMessages: id => [{...structuredClone(chat[id]), message_id: id}],
    setChatMessages: async (updates, options) => {
      for (const {message_id, ...data} of updates) Object.assign(chat[message_id], data);
      if (options?.refresh === 'affected') { writes.push('render-after-write'); await emit('character-rendered', 1); }
    },
    updateVariablesWith: async (update, options) => {
      chat[options.message_id] = {...chat[options.message_id], ...plain(update({}))};
      writes.push('snapshot');
    },
  });
  const modules = new Map();
  const mocks = {'@/store': {useDataStore: () => store}, '@/i18n': {tr: key => key}};
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const mod = {exports: {}}; modules.set(file, mod);
    const relative = path.relative(source, file).split(path.sep).join('/');
    const text = nora ? fs.readFileSync(file, 'utf8') : execFileSync('git', ['-C', source, 'show', `${upstreamCommit}:${relative}`], {encoding: 'utf8'});
    const compiled = ts.transpileModule(text, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true}}).outputText;
    const resolve = id => {
      if (mocks[id]) return mocks[id];
      if (id.startsWith('@/')) return load(path.join(source, 'src', id.slice(2) + '.ts'));
      if (id.startsWith('@util/')) return load(path.join(source, 'util', id.slice(6) + '.ts'));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'));
      return req(id);
    };
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, {filename: file})(resolve, mod, mod.exports);
    return mod.exports;
  }
  const util = load(path.join(source, 'src/util.ts'));
  mocks['@/util'] = {...util, getLastValidVariable: () => structuredClone(previous)};
  const updater = load(path.join(source, 'src/function/update_variables.ts'));
  if (nora) {
    vm.runInContext(fs.readFileSync(path.join(root, 'app/native-extensions/nora-mvu/mvu-zod.js'), 'utf8').replace('export function registerMvuSchema', 'function registerMvuSchema'), context);
  } else {
    const text = fs.readFileSync(upstreamHelper, 'utf8');
    assert.equal(sha(text), helperSha, 'test the pinned helper, not an unknown download');
    context.__toDotPath = req('zod/v4/core').toDotPath;
    context.__klona = req('klona').klona;
    // Substitute only module transport, as in the upstream helper tests.
    const executable = text.replace(/\bimport\s*['"][^'"]+['"]\s*;?/g, '')
      .replace(/import\{toDotPath as (\w+)\}from'[^']+';/, 'const $1=__toDotPath;')
      .replace(/import\{klona as (\w+)\}from'[^']+';/, 'const $1=__klona;')
      .replace(/export\{(\w+) as registerMvuSchema\};/, 'globalThis.registerMvuSchema=$1;');
    vm.runInContext(executable, context);
  }
  const script = card.data.extensions.tavern_helper.scripts.find(s => s.name === 'Zod Schema').content;
  vm.runInContext(script.replace(/^import[^\n]+\n/, '').replace('export const Schema', 'const Schema'), context);
  return {
    writes, emitted,
    initialize: async () => { await emit('mag_variable_initialized', previous, 0); return plain(previous.stat_data); },
    run: async text => {
      chat[1] = {role: 'assistant', name: '林舟', message: text};
      await updater.handleVariablesInMessage(1);
      if (chat[1].stat_data) previous = structuredClone(chat[1]);
      return plain(previous.stat_data);
    },
  };
}

test('one PNG: upstream MVU+Zod baseline and Nora enhanced execution', {skip: !(source && upstreamHelper) && 'Set NORA_MVU_SOURCE_DIR and NORA_UPSTREAM_ZOD_PATH'}, async t => {
  const dir = process.env.NORA_PORTABLE_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'nora-portable-card-'));
  if (!process.env.NORA_PORTABLE_ARTIFACT_DIR) t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const project = path.join(dir, 'project');
  initProject(project, {name: '林间驿站·双环境验证', slug: 'portable-world'});
  const configPath = path.join(project, 'card.project.json');
  const config = JSON.parse(fs.readFileSync(configPath));
  config.world.characters = [{id:'guide', name:'林舟', description:'二十八岁的驿站向导，协助旅行者整理物资、登记同行者和规划路线。', personality:'耐心简洁，区分事实与计划，不凭空增加消耗。', activation:{mode:'constant'}}];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const fixture = path.join(__dirname, '../fixtures/portable-world');
  fs.copyFileSync(path.join(fixture, 'card.md'), path.join(project, 'card.md'));
  for (const name of ['mvu.json','statusbar.html']) fs.copyFileSync(path.join(fixture, name), path.join(project, 'features', name));
  fs.writeFileSync(path.join(project, 'assets/cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const built = buildProject(project);
  assert.equal(built.manifest.quality.passed, true);
  const png = path.join(project, built.manifest.artifacts.v3Png);
  const bytes = fs.readFileSync(png), card = readCard(png).card;
  const protocol = await import(pathToFileURL(path.join(root, 'app/engine/sillytavern/public/scripts/nora-compat/mvu-protocol.js')));
  const {adaptCardForMvuRuntime} = await import(pathToFileURL(path.join(root, 'app/engine/sillytavern/public/scripts/nora-compat/mvu-compatibility.js')));
  const adapted = adaptCardForMvuRuntime(card);
  assert.equal(adapted.plan.protocol, 'nora-mvu/1');
  assert.equal(adapted.card.data.extensions.tavern_helper.scripts.find(s => s.name === 'MVU 变量系统').enabled, false);
  assert.match(adapted.card.data.extensions.tavern_helper.scripts.find(s => s.name === 'Zod Schema').content, /\/scripts\/extensions\/third-party\/nora-mvu/);
  assert.equal(card.data.extensions.tavern_helper.scripts.find(s => s.name === 'MVU 变量系统').enabled, true);
  assert.equal(sha(fs.readFileSync(png)), sha(bytes), 'Nora runtime projection does not rewrite the delivered artifact');
  const rounds = [
    ['前往车站', [{op:'delta',path:'/玩家/能量',value:-10},{op:'replace',path:'/玩家/位置',value:'车站'}], [{op:'increment',path:['玩家','能量'],amount:-10},{op:'set',path:['玩家','位置'],value:'车站'}]],
    ['领取地图', [{op:'insert',path:'/玩家/背包/-',value:{名称:'地图',数量:1}}], [{op:'append',path:['玩家','背包'],value:{名称:'地图',数量:1}}]],
    ['登记向导', [{op:'insert',path:'/世界/人物档案/guide',value:{姓名:'林舟',关系:'陌生'}}], [{op:'set',path:['世界','人物档案','guide'],value:{姓名:'林舟',关系:'陌生'}}]],
    ['消耗地图', [{op:'remove',path:'/玩家/背包/0'}], [{op:'delete',path:['玩家','背包',0]}]],
    ['更新完整姓名', [{op:'replace',path:'/玩家/姓名',value:'旅行者小林'}], [{op:'set',path:['玩家','姓名'],value:'旅行者小林'}]],
  ];
  const results = [];
  for (const nora of [false, true]) {
    await t.test(nora ? 'Nora projected card' : 'untouched upstream card', async () => {
      const f = runtime(nora ? adapted.card : card, nora, protocol);
      const initial = await f.initialize();
      assert.equal(initial.玩家.能量, 100);
      const states = [];
      for (const [story, legacy, enhanced] of rounds) {
        const block = nora ? protocol.encodeNoraEnvelope({protocol:'nora-mvu/1',operations:enhanced}) : `<UpdateVariable><JSONPatch>${JSON.stringify(legacy)}</JSONPatch></UpdateVariable>`;
        states.push(await f.run(story + '\n' + block));
      }
      const final = states.at(-1);
      assert.equal(final.玩家.能量, 90);
      assert.equal(final.玩家.位置, '车站');
      assert.equal(final.玩家.姓名, '旅行者小林');
      assert.deepEqual(final.玩家.背包, []);
      assert.deepEqual(final.世界.人物档案, {guide:{姓名:'林舟',关系:'陌生'}});
      const invalid = nora ? protocol.encodeNoraEnvelope({protocol:'nora-mvu/1',operations:[{op:'set',path:['玩家','能量'],value:'错类型'}]}) : '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/玩家/能量","value":"错类型"}]</JSONPatch></UpdateVariable>';
      assert.deepEqual(await f.run(invalid), final, 'invalid types do not corrupt state');
      // Re-create the script/host context from serialized state; no shared VM state.
      const statePath = path.join(dir, nora ? 'nora-state.json' : 'upstream-state.json');
      fs.writeFileSync(statePath, JSON.stringify(final));
      const reloaded = runtime(nora ? adapted.card : card, nora, protocol, JSON.parse(fs.readFileSync(statePath, 'utf8')));
      assert.deepEqual(await reloaded.initialize(), final);
      const noop = nora ? protocol.encodeNoraEnvelope({protocol:'nora-mvu/1',operations:[]}) : '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
      assert.deepEqual(await reloaded.run(noop), final);
      if (nora) assert.ok(f.writes.includes('save-confirmed'));
      else assert.ok(f.writes.indexOf('render-after-write') > f.writes.indexOf('snapshot'));
      results.push(states);
    });
  }
  assert.deepEqual(results[0], results[1], 'same valid actions yield the same snapshots in both engines');
  t.diagnostic(`PNG: ${png}; sha256=${sha(bytes)}; controlled outputs, no provider/browser test`);
});

test('portable navigation button sends one action, blocks historical clicks and reports failure', () => {
  const html = fs.readFileSync(path.join(__dirname, '../fixtures/portable-world/statusbar.html'), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let click, latest = 17, resolve, reject;
  const calls = [], button = {addEventListener: (_event, fn) => {click = fn;}}, result = {};
  new Function('$','document','getCurrentMessageId','getLastMessageId','triggerSlash',code)(
    fn => fn(), {getElementById: id => id === 'travel' ? button : result}, () => 17, () => latest,
    command => {calls.push(command); return new Promise((yes,no) => {resolve=yes;reject=no;});},
  );
  latest = 18; click(); assert.equal(calls.length, 0);
  latest = 17;
  const first = click(); click(); assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/send .*\| \/trigger$/);
  resolve();
  return first.then(async () => {
    assert.equal(button.disabled, false);
    assert.match(result.textContent, /位置以变量面板为准/);
    const second = click(); reject(new Error('host unavailable')); await second;
    assert.match(result.textContent, /行动未完成/);
    assert.equal(button.disabled, false);
  });
});
