const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');

const read = file => fs.readFileSync(path.join(__dirname, '../installer', file), 'utf8');
const source = read('launcher-controller.js');
const statements = parse(source, { ecmaVersion: 'latest' }).body[0].expression.callee.body.body;

function definition(name) {
  const statement = statements.find(item => item.id?.name === name || item.expression?.left?.name === name);
  assert.ok(statement, `Controller definition missing: ${name}`);
  return source.slice(statement.start, statement.end);
}

test('DeepSeek selection defaults to V4 Flash without replacing saved models or other provider defaults', () => {
  const form = statements.find(item => item.expression?.left?.name === 'modelForm').expression.right;
  const sync = form.body.body.find(item => item.declarations?.some(declaration => declaration.id.name === 'syncProvider'));
  const saved = form.body.body.find(item => item.declarations?.some(declaration => declaration.id.name === 'savedProvider'));
  assert.ok(sync);
  for (const [provider, snapshot, expected] of [
    ['deepseek', {}, 'deepseek-v4-flash'],
    ['deepseek', { modelProvider: 'deepseek', modelName: '' }, 'deepseek-v4-flash'],
    ['deepseek', { modelProvider: 'openrouter', modelName: 'other-model' }, 'deepseek-v4-flash'],
    ['deepseek', { modelProvider: 'deepseek', modelName: 'deepseek-v4-pro' }, 'deepseek-v4-pro'],
    ['openrouter', {}, ''],
    ['custom', {}, ''],
    ['custom', { modelProvider: 'custom', modelName: 'relay-model', modelBaseUrl: 'https://example.com/v1' }, 'relay-model'],
    ['custom', { modelProvider: 'custom:local', modelName: 'local-model', modelBaseUrl: 'http://127.0.0.1:8080/v1' }, 'local-model'],
  ]) {
    const elements = new Map();
    const $ = id => {
      if (!elements.has(id)) elements.set(id, { value: '', disabled: false, replaceChildren() {} });
      return elements.get(id);
    };
    const context = vm.createContext({ $, snapshot, selected: () => ({ id: provider, custom: provider === 'custom' }) });
    vm.runInContext(`${source.slice(saved.start, saved.end)}\n${source.slice(sync.start, sync.end)}\nsyncProvider();`, context);
    assert.equal($('model').value, expected, JSON.stringify({ provider, snapshot }));
    assert.equal($('model').disabled, false, 'the default remains editable');
    assert.equal($('endpoint').value, snapshot.modelBaseUrl || '');
  }
});

function uiContext(values = {}) {
  const elements = new Map();
  const element = () => ({ hidden: false, append() {}, classList: { remove() {}, toggle() {} } });
  return vm.createContext({
    busy: false, snapshot: {}, view: 'daily',
    $: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    hideMenu() {}, renderServices() {}, renderConversationEntry() {}, controls() {}, showVersionNotice() {},
    firstCompletionPending: false, sawIncompleteSetup: false,
    clearInline() {}, setupStage() {}, stage: 0,
    document: { createElement: element, createTextNode: text => text },
    button: () => ({}), textError: String,
    ...values,
  });
}

test('ready greeting requires Tavern, Nora and ClawChat to be ready together', () => {
  for (const running of [false, true]) for (const gatewayRunning of [false, true]) for (const clawchatConnected of [false, true]) {
    let title;
    const context = uiContext({ snapshot: { running, gatewayRunning, clawchatConnected }, say: value => { title = value; } });
    vm.runInContext(`${definition('allRunning')}\n${definition('dailyHome')}\ndailyHome();`, context);
    const expected = running && gatewayRunning && clawchatConnected ? '欢迎回来，坐一会儿吧。'
      : running ? '酒馆已启动。' : gatewayRunning ? '诺拉已启动。' : '随时可以继续。';
    assert.equal(title, expected, JSON.stringify({ running, gatewayRunning, clawchatConnected }));
    vm.runInContext("dailyHome('酒馆已停止。');", context);
    assert.equal(title, '酒馆已停止。', 'explicit action feedback remains intact');
  }
});

test('completion greeting is shown after setup finishes, not on an already-installed cold start', () => {
  const ready = { setupCompleted: true, systemReady: true, running: true, gatewayRunning: true, clawchatConnected: true };
  const create = () => {
    const context = uiContext({ say: (...args) => { context.message = args; } });
    vm.runInContext(`${definition('complete')}\n${definition('syncState')}\n${definition('allRunning')}\n${definition('dailyHome')}`, context);
    return context;
  };
  const cold = create(); cold.ready = ready;
  vm.runInContext('syncState(ready); dailyHome();', cold);
  assert.equal(cold.firstCompletionPending, false);
  assert.equal(cold.message[0], '欢迎回来，坐一会儿吧。');
  assert.equal(cold.message[1], '');
  const fresh = create(); fresh.ready = ready;
  vm.runInContext('syncState({setupCompleted:false}); syncState(ready); dailyHome();', fresh);
  assert.equal(fresh.firstCompletionPending, true);
  assert.equal(fresh.message[0], '酒馆准备好了。');
  assert.equal(fresh.message[1], '', 'first-use guidance belongs beside the conversation entry');
  vm.runInContext('dailyHome("酒馆已停止。");', fresh);
  assert.equal(fresh.message[0], '酒馆已停止。');
});

test('conversation entry opens the client, handles failure and never starts paused services', async () => {
  for (const mode of ['success', 'first-use', 'unavailable', 'error', 'paused', 'offline', 'unpaired']) {
    let entry, opens = 0;
    const element = () => ({ children: [], disabled: false, setAttribute() {}, append(...items) { this.children.push(...items); } });
    const context = uiContext({
      snapshot: { clawchatPaired: mode !== 'unpaired', gatewayRunning: mode !== 'paused', clawchatConnected: mode !== 'offline' },
      firstCompletionPending: mode === 'first-use',
      document: { createElement: element }, $: () => ({ prepend(value) { entry = value; } }),
      api: { async openClawChatApp() { opens++; if (mode === 'error') throw Error('missing protocol'); return { ok: ['success', 'first-use'].includes(mode) }; } },
    });
    vm.runInContext(`${definition('allRunning')}\n${definition('renderConversationEntry')}\nrenderConversationEntry();`, Object.assign(context, { snapshot: { ...context.snapshot, running: true } }));
    if (mode === 'unpaired') { assert.equal(entry, undefined); continue; }
    const [action, guidance] = entry.children;
    assert.equal(guidance.hidden, mode !== 'first-use');
    assert.match(action.innerHTML, /去 ClawChat 找我/);
    await action.onclick();
    assert.equal(guidance.hidden, mode === 'success');
    assert.equal(action.disabled, false);
    assert.equal(opens, ['paused', 'offline'].includes(mode) ? 0 : 1);
    if (mode === 'first-use') assert.match(guidance.textContent, /联系人中找到诺拉/);
    if (['unavailable', 'error'].includes(mode)) assert.match(guidance.textContent, /请手动打开/);
    if (mode === 'paused') assert.match(guidance.textContent, /先在下方启动诺拉/);
    if (mode === 'offline') assert.match(guidance.textContent, /先检查连接/);
  }
});

test('ClawChat client IPC uses a fixed protocol and keeps downloads on a separate route', async () => {
  const mainSource = read('desktop/main.js');
  const ast = parse(mainSource, { ecmaVersion: 'latest' });
  let callback;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.name === 'handle' && node.arguments[0]?.value === 'nora:open-clawchat-app') callback = node.arguments[1];
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  }
  visit(ast); assert.ok(callback);
  for (const fail of [false, true]) {
    const urls = [];
    const context = vm.createContext({ shell: { async openExternal(url) { urls.push(url); if (fail) throw Error('not installed'); } } });
    const result = await vm.runInContext(`(${mainSource.slice(callback.start, callback.end)})()`, context);
    assert.equal(result.ok, !fail); assert.deepEqual(urls, ['clawchat://']);
  }
  assert.ok(read('desktop/preload.js').includes("ipcRenderer.invoke('nora:open-clawchat-app')"));
  assert.ok(mainSource.includes("shell.openExternal('https://clawling.com/zh/chat/#get')"));
});

test('version details and the daily notice name the channel actually checked', async () => {
  for (const channel of ['stable', 'beta']) for (const state of ['current', 'ahead']) {
    let title;
    const versionInfo = { state, channel, current: '2.0.0', latest: '2.0.0' };
    const context = uiContext({ versionInfo, say: value => { title = value; }, api: { checkUpdate: async () => versionInfo } });
    vm.runInContext(definition('checkUpdates'), context);
    await vm.runInContext('checkUpdates()', context);
    const channelName = channel === 'beta' ? 'Beta 测试版' : '正式版';
    assert.equal(title, state === 'current' ? `当前系统已是最新${channelName}。` : `本机版本高于最新${channelName}。`);
    const appended = [];
    context.view = 'daily';
    context.$ = id => id === 'versionNotice' ? null : { append: value => appended.push(value) };
    context.document.createElement = () => ({ append: value => appended.push(value) });
    vm.runInContext(`${definition('showVersionNotice')}\nshowVersionNotice();`, context);
    assert.deepEqual(appended, [], 'routine version information stays in More');
  }
});

test('an empty model list does not claim the key has connected', async () => {
  const modelSource = read('desktop/model-config.js');
  const node = parse(modelSource, { ecmaVersion: 'latest' }).body.find(item => item.id?.name === 'loadProviderModels');
  const context = vm.createContext({
    requireProvider: () => ({ id: 'test', modelsUrl: 'https://example.invalid/models' }),
    requestHeaders: () => ({}), requestJson: async () => ({ data: [] }), normalizeModels: () => [],
  });
  vm.runInContext(modelSource.slice(node.start, node.end), context);
  await assert.rejects(vm.runInContext("loadProviderModels('test', 'test-key')", context), { message: '未获取到可用模型。' });
});

test('installation messages describe ClawChat access and the full-system update scope', () => {
  const bridge = read('launcher_bridge.py');
  const services = read('launcher_services.py');
  for (const text of ['正在准备 ClawChat 连接组件', 'ClawChat 酒馆入口尚未就绪']) {
    assert.ok(bridge.includes(text), text);
  }
  assert.ok(bridge.includes('hooks/tavern-liveware-register/handler.py'), 'registration uses the shared hook');
  assert.ok(services.includes('ClawChat 连接服务尚未停止'));
  assert.doesNotMatch(bridge + services, /手机(?:连接组件|酒馆入口|连接服务)/);
  assert.ok(definition('taskView').includes("update: '正在更新诺拉与酒馆。'"));
  assert.doesNotMatch(definition('renderServices'), /service-detail|services-footer/, 'service rows do not repeat the conversation and launch entries');
});

test('daily version notices still surface available updates and abnormal states', () => {
  for (const state of ['available', 'blocked', 'unknown', 'unavailable']) {
    const appended = [];
    const context = uiContext({
      versionInfo: { state, available: state === 'available', latest: '2.3.0' },
      $: id => id === 'versionNotice' ? null : { append: value => appended.push(value) },
      checkUpdates() {},
    });
    vm.runInContext(`${definition('showVersionNotice')}\nshowVersionNotice();`, context);
    assert.equal(appended.length, 1, state);
    assert.equal(appended[0].id, 'versionNotice');
  }
});

test('secondary management actions live in More and stop-all retains its service scope', () => {
  const html = read('launcher-conversation-prototype.html');
  const management = html.slice(html.indexOf('<div class="management"'), html.indexOf('<div class="launchbar"'));
  const [visible, more] = management.split('<div class="more"');
  assert.match(visible, /data-action="model"/);
  assert.doesNotMatch(visible, /data-action="(?:claw|update|stop-all)"/);
  for (const action of ['claw', 'update', 'stop-all']) assert.ok(more.includes(`data-action="${action}"`));
  assert.ok(source.includes("if (action === 'stop-all') run('stop', { service: 'all' });"));
});
