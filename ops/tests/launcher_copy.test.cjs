const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { parse } = require('../../app/engine/sillytavern/node_modules/acorn');

const read = file => fs.readFileSync(path.join(__dirname, '../installer', file), 'utf8');
const source = read('launcher-controller.js');
const statements = parse(source, { ecmaVersion: 'latest' }).body[0].expression.callee.body.body;

function definition(name) {
  const statement = statements.find(item => item.id?.name === name || item.expression?.left?.name === name);
  assert.ok(statement, `Controller definition missing: ${name}`);
  return source.slice(statement.start, statement.end);
}

function uiContext(values = {}) {
  const elements = new Map();
  const element = () => ({ hidden: false, append() {}, classList: { remove() {} } });
  return vm.createContext({
    busy: false, snapshot: {}, view: 'daily',
    $: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    hideMenu() {}, renderServices() {}, controls() {}, showVersionNotice() {},
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
    const expected = running && gatewayRunning && clawchatConnected ? '准备好了。酒馆交给你。'
      : running ? '酒馆已启动。' : gatewayRunning ? '诺拉已启动。' : '随时可以继续。';
    assert.equal(title, expected, JSON.stringify({ running, gatewayRunning, clawchatConnected }));
    vm.runInContext("dailyHome('酒馆已停止。');", context);
    assert.equal(title, '酒馆已停止。', 'explicit action feedback remains intact');
  }
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
    if (state === 'current') assert.deepEqual(appended, []);
    else assert.equal(appended[0], `本机版本高于最新${channelName} `);
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
  for (const text of ['正在准备 ClawChat 连接组件', 'ClawChat 连接组件未就绪', '正在注册 ClawChat 酒馆入口', 'ClawChat 酒馆入口尚未就绪']) {
    assert.ok(bridge.includes(text), text);
  }
  assert.ok(services.includes('ClawChat 连接服务尚未停止'));
  assert.doesNotMatch(bridge + services, /手机(?:连接组件|酒馆入口|连接服务)/);
  assert.ok(definition('taskView').includes("update: '正在更新诺拉与酒馆。'"));
  assert.ok(source.includes('本地启动 ｜ 打开 ClawChat 启动'), 'approved service copy is unchanged');
});
