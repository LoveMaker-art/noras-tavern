const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
const route = source.slice(source.indexOf('  function route()'), source.indexOf('  function taskView('));

function recovery(version, updateRecovery, extra = {}) {
  const elements = new Map();
  const element = () => ({ children: [], classList: { remove() {} }, append(...items) { this.children.push(...items); } });
  const calls = [];
  const context = vm.createContext({
    api: {}, snapshot: { installed: true, hermesInstalled: true, systemReady: false, version, updateRecovery,
      running: true, systemProblems: ['技能文件内容与安装记录不一致'], ...extra },
    autoStartAttempted: false, bundledUpgradeAttempted: false, complete: () => false,
    $: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    document: { createElement: element }, clearInline() {}, controls() {},
    say: (...args) => calls.push(['say', ...args]),
    button: (label, click) => ({ label, click }),
    run: (...args) => calls.push(args),
  });
  vm.runInContext(`${route}\nroute();`, context);
  return { elements, calls, reroute: () => vm.runInContext('route();', context) };
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

test('a failed upgrade requires an explicit retry and keeps the new bundled target', () => {
  const h = recovery('2.3.2', null, { bundledUpgradeTarget: 'v2.3.13',
    installer: { phase: 'error', error: 'fixture download failed' } });
  assert.equal(h.calls.some(c => c[0] === 'update'), false);
  const button = h.elements.get('inline').children[0];
  assert.equal(button.label, '继续更新');
  button.click();
  assert.equal(h.calls.at(-1)[1].tag, 'v2.3.13');
});

test('unknown installed version cannot trigger an unpinned repair', () => {
  assert.equal(recovery('').elements.get('inline').children[0].disabled, true);
});

test('interrupted transaction offers neither reinstall nor another update', () => {
  const h = recovery('2.3.7', { status: 'prepared', backup: '/saved/backup' }, { bundledUpgradeTarget: 'v2.3.13' });
  assert.equal(h.elements.get('status').textContent, '需要恢复');
  assert.equal(h.elements.get('inline').children.some(c => c.click), false);
  assert.equal(h.calls.some(c => c[0] === 'update' || c[0] === 'install' || c[0] === 'start'), false);
});
