const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
const guidanceSource = source.slice(source.indexOf('  const textError'), source.indexOf('  function complete()'));
const route = source.slice(source.indexOf('  function recoveredOperation('), source.indexOf('  function taskView('));

function element(tag = 'div') {
  const node = { tagName: tag.toUpperCase(), children: [], dataset: {}, className: '', open: false,
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = [...items]; },
    setAttribute(name, value) { this[name] = String(value); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return descendants(this).filter(child => selector.startsWith('.')
      ? child.classList.contains(selector.slice(1)) : selector.startsWith('#')
        ? child.id === selector.slice(1) : child.tagName === selector.toUpperCase()); },
  };
  node.classList = {
    add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove(...names) { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    contains(name) { return node.className.split(/\s+/).includes(name); },
    toggle(name, force) { const add = force ?? !this.contains(name); this[add ? 'add' : 'remove'](name); return add; },
  };
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() { return text + node.children.map(child => typeof child === 'string' ? child : child.textContent || '').join(''); },
    set(value) { text = String(value); node.children = []; },
  });
  return node;
}

function descendants(node) {
  return node.children.flatMap(child => typeof child === 'object' ? [child, ...descendants(child)] : []);
}
function buttons(h) { return descendants(h.elements.get('inline')).filter(node => node.tagName === 'BUTTON'); }
function tagged(h, tag, cls) {
  return descendants(h.elements.get('inline')).filter(node => node.tagName === tag.toUpperCase() && (!cls || node.classList.contains(cls)));
}
function button(label, click, primary = true) {
  const node = element('button'); node.label = label; node.textContent = label; node.click = click; node.onclick = click;
  node.className = `button ${primary ? 'primary' : ''}`; return node;
}

function recovery(version, updateRecovery, extra = {}, apiExtra = {}) {
  const elements = new Map();
  const calls = [];
  const context = vm.createContext({
    api: { recover() {}, openLogs() {}, ...apiExtra }, openLogs: () => calls.push(['logs']), snapshot: { installed: true, hermesInstalled: true, systemReady: false, version, updateRecovery,
      running: true, systemProblems: ['技能文件内容与安装记录不一致'], ...extra },
    autoStartAttempted: false, bundledUpgradeAttempted: false, complete: () => false, statusUnknown: false, launcherRecoveryConfirmed:false,
    versionInfo:null,lastFailure:null,lastStatusError:'',busy:false,
    $: id => {
      const nested = [...elements.values()].flatMap(descendants).find(node => node.id === id);
      if (nested) return nested;
      if (!elements.has(id)) elements.set(id, element()); return elements.get(id);
    },
    document: { createElement: element }, clearInline() { context.$('inline').replaceChildren(); }, controls() {},
    say: (...args) => calls.push(['say', ...args]), button,
    run: (...args) => calls.push(args),
    fail: (error,action) => { context.view='error';calls.push(['failure',error,action]);context.clearInline();context.$('inline').append(button('查看日志',()=>calls.push(['logs']),false)); },
  });
  vm.runInContext(`${guidanceSource}\n${route}\nroute();`, context);
  return { elements, calls, context, reroute: () => vm.runInContext('route();', context) };
}

test('legacy integrity failure resolves a compatible release instead of pinning the old version', () => {
  const h = recovery('2.3.2');
  const button = h.elements.get('inline').children[0];
  assert.equal(button.label, '修复当前安装');
  assert.equal(h.elements.get('status').textContent, '需要修复');
  assert.equal(h.calls.some(c => c[0] === 'stop' || c[0] === 'install'), false);
  button.click();
  assert.equal(h.calls.at(-1)[0], 'update');
  assert.equal(h.calls.at(-1)[1]?.tag, undefined);
});

test('historical restoration discloses the selected data checkpoint before moving files',()=>{
  const h=recovery('2.4.2',{kind:'legacy',canRecover:true,restoreVersion:'2.4.1',backup:'/retained/backup',journalReference:'/retained/journal'});
  const copy=h.calls.filter(call=>call[0]==='say').at(-1);
  assert.match(copy[2],/2.4.1/);assert.match(copy[2],/数据和配置/);assert.match(copy[2],/较新数据/);assert.match(copy[2],/需手动启动/);
  assert.deepEqual(buttons(h).map(node=>node.label),['恢复旧版本','查看日志']);
});

test('file-only historical recovery keeps an explicit start action and truthful guidance',()=>{
  const h=recovery('2.4.1',null,{operation:{operationId:'fixture',state:'rolled-back',kind:'recover',verification:'failed',
    recoveryOutcome:'files-restored-start-failed',result:{legacyFilesRestored:true},allowedActions:['start-restored','recheck','logs']}});
  const failure=h.calls.find(call=>call[0]==='failure');
  assert.equal(failure[1].guidance.title,'旧版本文件已恢复。');assert.match(failure[1].guidance.detail,/保持停止/);
  assert.match(failure[1].guidance.next,/启动旧版本/);
});

test('replacement installer upgrades an existing system to its bundled version only once', () => {
  for (const systemReady of [true, false]) {
    const h = recovery('2.3.2', null, { systemReady, bundledUpgradeTarget: 'v2.3.13' });
    assert.equal(h.calls[0][0], 'update');
    assert.equal(h.calls[0][1].tag, 'v2.3.13');
    h.reroute();
    assert.equal(h.calls.filter(c => c[0] === 'update').length, 1);
    assert.equal(h.calls.some(c => c[0] === 'install'), false);
  }
});

test('a legacy failed upgrade has no direct replay and preserves its bundled target for diagnosis', () => {
  const h = recovery('2.3.2', null, { bundledUpgradeTarget:'v2.3.13', installer:{phase:'error',error:'fixture download failed'} });
  assert.equal(h.calls.some(call=>call[0]==='update'),false);
  assert.equal(h.context.view,'error');assert.equal(h.context.snapshot.bundledUpgradeTarget,'v2.3.13');
  assert.equal(buttons(h).some(node=>node.label==='继续更新'),false);assert.ok(buttons(h).some(node=>node.label==='查看日志'));
});

test('unknown installed version cannot trigger an unpinned repair', () => {
  assert.equal(recovery('').elements.get('inline').children[0].disabled, true);
});

test('interrupted transaction offers neither reinstall nor another update', () => {
  const h = recovery('2.3.7', { status: 'prepared', backup: '/saved/backup' }, { bundledUpgradeTarget: 'v2.3.13' });
  assert.equal(h.elements.get('status').textContent, '需要恢复');
  assert.deepEqual(buttons(h).map(c => c.label), ['查看日志']);
  assert.equal(h.calls.some(c => c[0] === 'update' || c[0] === 'install' || c[0] === 'start'), false);
});

test('validated interrupted update offers explicit recovery and preserves the log action', () => {
  const h = recovery('2.3.17', { status: 'prepared', backup: '/saved/backup', canRecover: true });
  const actions = buttons(h);
  assert.deepEqual(actions.map(c => c.label), ['恢复旧版本', '查看日志']);
  assert.equal(h.calls.some(c => ['update', 'install', 'start', 'recover'].includes(c[0])), false);
  actions[0].click();
  actions[1].click();
  assert.equal(h.calls.at(-1)[0], 'logs');
  assert.equal(h.calls.at(-2)[0], 'recover');
});

test('incomplete recovery records explain the block without offering an unsafe rollback', () => {
  const reason = '旧更新记录缺少恢复计划，无法安全恢复。';
  const h = recovery('2.3.17', { status: 'prepared', canRecover: false, reason });
  assert.equal(h.calls.find(call => call[0] === 'say')[1], '暂时不能恢复旧版本。');
  assert.equal(h.calls.find(c => c[0] === 'say')[2].includes(reason), false);
  assert.equal(tagged(h, 'details', 'recovery-details')[0].textContent.includes(reason), true);
  assert.equal(buttons(h).some(c => c.label === '恢复旧版本'), false);
});


test('recovery page separates its primary action from logs and keeps diagnostic details collapsed', () => {
  const backup = '/saved/backup';
  const error = '程序错误详情；recovery=incomplete';
  const reason = '本次失败原因信息';
  const record = { status: 'recovery-failed', backup, canRecover: true, reason };
  const h = recovery('2.3.17', record, { installer: { phase: 'error', error } });
  const speech = h.calls.find(call => call[0] === 'say');
  assert.equal(speech[1], '更新中断了。');
  for (const text of [backup, error, reason]) assert.equal(speech[2].includes(text), false);
  const group = descendants(h.elements.get('inline')).find(node => node.classList.contains('recovery-actions'));
  assert.ok(group, 'recovery actions have one layout container');
  const actions = descendants(group).filter(node => node.tagName === 'BUTTON');
  assert.deepEqual(actions.map(node => node.label), ['恢复旧版本', '查看日志']);
  assert.equal(actions[0].classList.contains('primary'), true);
  assert.equal(actions[1].classList.contains('quiet'), true);
  assert.equal(actions[1].classList.contains('primary'), false);
  const details = tagged(h, 'details', 'recovery-details');
  assert.equal(details.length, 1);
  assert.equal(details[0].open, false);
  assert.equal(descendants(details[0]).some(node => node.tagName === 'SUMMARY'), true);
  for (const text of [backup, error, reason]) assert.equal(details[0].textContent.includes(text), true);
  assert.equal(h.context.snapshot.updateRecovery, record, 'rendering does not replace the recovery record');
});

test('a missing recovery API never offers an unusable recovery action', () => {
  for (const recover of [undefined, null, 'unavailable']) {
    const h = recovery('2.3.17', { status: 'prepared', canRecover: true }, {}, { recover });
    assert.deepEqual(buttons(h).map(node => node.label), ['查看日志']);
    assert.equal(h.calls.find(call => call[0] === 'say')[1], '暂时不能恢复旧版本。');
    assert.equal(h.calls.some(call => call[0] === 'recover'), false);
  }
});

const runSource = source.slice(source.indexOf('  async function run(action'), source.indexOf('  install = () =>'));
const statusSource = source.slice(source.indexOf('  async function readStatus()'), source.indexOf('  function hideMenu()'));
async function failedRun(action, { freshRecovery = null, staleRecovery = null, statusError = null, message = '下载失败（HTTP 403）。' } = {}) {
  const h = recovery('2.3.17', null);
  h.calls.length = 0; h.elements.get('inline').replaceChildren();
  const c = h.context;
  Object.assign(c, {
    snapshot: { installed: true, hermesInstalled: true, systemReady: true, setupCompleted: true, version: '2.3.17', updateRecovery: null },
    busy: false, taskTimer: null, statusUnknown: false, launcherRecoveryConfirmed:false, firstCompletionPending: false,
    complete: () => true, clearInterval() {}, onEvent() {},
    taskView: value => { h.calls.push(['task', value]); c.clearInline(); },
    syncState: value => { c.snapshot = { ...c.snapshot, ...value }; },
    fail: (error, value, retry) => { c.view = 'error'; c.clearInline(); h.calls.push(['fail', value, error, retry]); },
    poll() {}, allRunning: () => true, textError: error => error.message,
  });
  c.api = {
    recover() {}, openLogs() {},
    status: async () => { h.calls.push(['status']);
      if(action==='recover' && !h.calls.some(call=>call[0]==='request')) return {updateRecovery:{canRecover:true,backup:'/saved/backup'}};
      if (statusError) throw statusError;
      return { installed: true, hermesInstalled: true, systemReady: true, updateRecovery: freshRecovery }; },
    [action]: async () => { h.calls.push(['request', action]); if(staleRecovery)c.snapshot.updateRecovery=staleRecovery;throw new Error(message); },
  };
  vm.runInContext(`${route}\nconst actualRoute = route; route = () => { observedCalls.push(['route']); return actualRoute(); };\n${statusSource}\n${runSource}`, Object.assign(c, { observedCalls: h.calls }));
  await vm.runInContext(`run(${JSON.stringify(action)});`, c);
  return h;
}

for (const action of ['update', 'repair', 'recover']) {
  test(`${action} failure with freshly confirmed recovery goes directly to recovery without replaying the update`, async () => {
    const h = await failedRun(action, { freshRecovery: { status: 'recovery-failed', canRecover: true, backup: '/saved/backup' } });
    assert.equal(h.calls.filter(call => call[0] === 'request').length, 1);
    assert.equal(h.calls.some(call => call[0] === 'fail'), false);
    assert.equal(h.context.view, 'recovery');
    assert.deepEqual(buttons(h).map(node => node.label), ['恢复旧版本', '查看日志']);
    assert.equal(h.context.busy, false);
    assert.equal(tagged(h, 'details', 'recovery-details')[0].textContent.includes('下载失败（HTTP 403）。'), true);
    assert.equal(h.calls.find(call => call[0] === 'say')[2].includes('HTTP 403'), false);
  });
  test(`${action} request failure without a recovery record retains the original error flow`, async () => {
    const h = await failedRun(action);
    const failure = h.calls.find(call => call[0] === 'fail');
    assert.ok(failure);
    assert.equal(failure[1], action);
    assert.equal(failure[2].message, '下载失败（HTTP 403）。');
    assert.equal(h.calls.some(call => call[0] === 'route'), false);
    assert.equal(h.context.snapshot.updateRecovery, null);
    assert.equal(h.calls.filter(call => call[0] === 'request').length, 1);
  });
  test(`${action} failure cannot offer recovery from a stale record when querying current status fails`, async () => {
    const staleRecovery = { status: 'prepared', canRecover: true, backup: '/saved/backup' };
    const h = await failedRun(action, { staleRecovery, statusError: new Error('状态查询失败') });
    assert.equal(h.context.statusUnknown, true);
    assert.notEqual(h.context.view, 'recovery');
    assert.equal(buttons(h).some(node => node.label === '恢复旧版本'), false);
    assert.equal(h.calls.filter(call => call[0] === 'request').length, 1);
  });
}


const controlsSource = source.slice(source.indexOf('  function controls()'), source.indexOf('  function displaySteps()'));
test('recovery keeps normal launch controls hidden and disables its action while busy or state is unknown', () => {
  const h = recovery('2.3.17', { status: 'prepared', canRecover: true });
  const c = h.context;
  const recover = buttons(h).find(node => node.label === '恢复旧版本');
  assert.equal(recover.id, 'recoverUpdate');
  const launchText = element('span');
  c.$('launch').querySelector = selector => selector === 'span' ? launchText : null;
  Object.assign(c, { complete: () => true, launchHint: element(), activeAction: '', activeService: 'all', serviceRunning: () => true });
  c.document.querySelectorAll = () => [];
  vm.runInContext(controlsSource, c);
  for (const [busy, remoteBusy, unknown, disabled] of [[false, false, false, false], [true, false, false, true],
    [false, true, false, true], [false, false, true, true], [false, false, false, false]]) {
    c.busy = busy; c.snapshot.busy = remoteBusy; c.statusUnknown = unknown;
    vm.runInContext('controls();', c);
    assert.equal(c.$('launchbar').hidden, true);
    assert.equal(c.$('management').hidden, true);
    assert.equal(c.$('status').hidden, false);
    assert.equal(recover.disabled, disabled);
  }
});

test('routing away from recovery clears its layout class even if current status is unknown', () => {
  const h = recovery('2.3.17', { status: 'prepared', canRecover: true });
  assert.equal(h.context.$('main').classList.contains('update-recovery'), true);
  h.context.statusUnknown = true;
  h.context.fail = () => {};
  h.reroute();
  assert.equal(h.context.$('main').classList.contains('update-recovery'), false);
});

test('a normal task removes the recovery layout before displaying its own controls', () => {
  const h = recovery('2.3.17', { status: 'prepared', canRecover: true });
  Object.assign(h.context, { busy: true, displaySteps() {} });
  const setupSource = source.slice(source.indexOf('  function setupStage('), source.indexOf('  function renderServices()'));
  vm.runInContext(`${setupSource}\nsetupStage(0);`, h.context);
  assert.equal(h.context.$('main').classList.contains('update-recovery'), false);
});


const pollSource = source.slice(source.indexOf('  async function poll()'), source.indexOf("  addEventListener('beforeunload'"));
function pollingRecovery({ canRecover = true, reason = '', backup = '/saved/backup', error = '先前失败' } = {}) {
  const h = recovery('2.3.17', { canRecover, reason, backup }, { installer: { phase: 'error', error } });
  const c = h.context;
  let response = null, queryError = null;
  Object.assign(c, { alive: true, busy: false, refreshing: false, pollTimer: null,
    setTimeout: () => 0, clearTimeout() {}, checkVersionsInBackground() {},
    syncState: value => { c.snapshot = { ...c.snapshot, ...value }; },
    complete: () => false,
    fail: (error, action) => { c.view = 'error'; c.clearInline(); h.calls.push(['fail', action, error]); },
    dailyHome: () => { c.view = 'daily'; c.clearInline(); h.calls.push(['daily']); },
  });
  c.api.status = async () => { h.calls.push(['status']); if (queryError) throw queryError;
    return response || { ...c.snapshot }; };
  vm.runInContext(`${statusSource}\n${pollSource}`, c);
  return { ...h, poll: value => { response = value; return vm.runInContext('poll();', c); },
    rejectStatus: error => { queryError = error; return vm.runInContext('poll();', c); } };
}

test('polling updates recovery availability and explanation from freshly confirmed state', async () => {
  const h = pollingRecovery();
  assert.equal(buttons(h).some(node => node.label === '恢复旧版本'), true);
  await h.poll({ updateRecovery: { canRecover: false, reason: '备份已无法核实', backup: '/saved/backup' } });
  assert.equal(buttons(h).some(node => node.label === '恢复旧版本'), false);
  assert.equal(h.calls.filter(call => call[0] === 'say').at(-1)[1], '暂时不能恢复旧版本。');
  assert.equal(tagged(h, 'details', 'recovery-details')[0].textContent.includes('备份已无法核实'), true);
  await h.poll({ updateRecovery: { canRecover: true, reason: '', backup: '/saved/backup' } });
  assert.equal(buttons(h).some(node => node.label === '恢复旧版本'), true);
  assert.equal(h.calls.some(call => ['update','install','recover'].includes(call[0])), false);
});

test('polling preserves an expanded recovery detail and existing handlers when visible data is unchanged', async () => {
  const h = pollingRecovery();
  const details = tagged(h, 'details', 'recovery-details')[0]; details.open = true;
  const action = buttons(h)[0], titleCount = h.calls.filter(call => call[0] === 'say').length;
  await h.poll({ updateRecovery: { canRecover: true, backup: '/saved/backup', reason: '', version: 'ignored-technical-version' } });
  assert.equal(tagged(h, 'details', 'recovery-details')[0], details);
  assert.equal(details.open, true);
  assert.equal(buttons(h)[0], action);
  assert.equal(h.calls.filter(call => call[0] === 'say').length, titleCount);
});

test('polling refreshes changed error and backup details while retaining the user expanded disclosure', async () => {
  const h = pollingRecovery(); tagged(h, 'details', 'recovery-details')[0].open = true;
  await h.poll({ updateRecovery: { canRecover: true, backup: '/saved/backup2', reason: '新的核验说明' },
    installer: { phase: 'error', error: '新失败信息' } });
  const details = tagged(h, 'details', 'recovery-details')[0];
  assert.equal(details.open, true);
  for (const text of ['/saved/backup2','新的核验说明','新失败信息']) assert.equal(details.textContent.includes(text), true);
  assert.equal(details.textContent.includes('先前失败'), false);
  assert.equal(h.calls.filter(call => call[0] === 'say').at(-1)[2].includes('新失败信息'), false);
});

test('polling routes to the normal page when the recovery record is no longer present', async () => {
  const h = pollingRecovery(); h.context.complete = () => true;
  h.context.autoStartAttempted = true;
  await h.poll({ updateRecovery: null, systemReady: true });
  assert.equal(h.context.view, 'daily');
  assert.equal(buttons(h).some(node => node.label === '恢复旧版本'), false);
  assert.equal(h.context.$('main').classList.contains('update-recovery'), false);
});

test('polling cannot keep stale recovery controls after failing to query current status', async () => {
  const h = pollingRecovery();
  await h.rejectStatus(new Error('状态查询失败'));
  assert.equal(h.context.statusUnknown, true);
  assert.equal(h.context.view, 'error');
  assert.equal(buttons(h).some(node => node.label === '恢复旧版本'), false);
  assert.equal(h.calls.some(call => ['update','install','recover'].includes(call[0])), false);
});

test('polling leaves an active recovery task untouched while the operation is busy', async () => {
  const h = pollingRecovery(); h.context.busy = true; h.context.view = 'task';
  const before = h.calls.length, action = buttons(h)[0];
  await h.poll({ updateRecovery: null });
  assert.equal(h.calls.length, before);
  assert.equal(h.context.view, 'task');
  assert.equal(buttons(h)[0], action);
});

test('a poll already awaiting status cannot redraw a recovery task started in the meantime', async () => {
  const h = pollingRecovery();
  let resolveStatus;
  h.context.api.status = () => new Promise(resolve => { resolveStatus = resolve; });
  const pending = h.poll(null);
  h.context.busy = true; h.context.view = 'task';
  const task = element('section'); task.textContent = '恢复任务进度';
  h.context.$('inline').replaceChildren(task);
  const speeches = h.calls.filter(call => call[0] === 'say').length;
  resolveStatus({ installed: true, hermesInstalled: true, systemReady: false, updateRecovery: null });
  await pending;
  assert.equal(h.context.view, 'task');
  assert.equal(h.context.$('inline').children[0], task);
  assert.equal(h.calls.filter(call => call[0] === 'say').length, speeches);
  assert.equal(h.calls.some(call => ['update','install','recover'].includes(call[0])), false);
});
