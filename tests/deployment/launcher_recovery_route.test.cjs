const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
const route = source.slice(source.indexOf('  function route()'), source.indexOf('  function taskView('));

function recovery(version, updateRecovery) {
  const elements = new Map();
  const element = () => ({ children: [], classList: { remove() {} }, append(...items) { this.children.push(...items); } });
  const calls = [];
  const context = vm.createContext({
    api: {}, snapshot: { installed: true, hermesInstalled: true, systemReady: false, version, updateRecovery,
      running: true, systemProblems: ['技能文件内容与安装记录不一致'] },
    autoStartAttempted: false, complete: () => false,
    $: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    document: { createElement: element }, clearInline() {}, controls() {},
    say: (...args) => calls.push(['say', ...args]),
    button: (label, click) => ({ label, click }),
    run: (...args) => calls.push(args),
  });
  vm.runInContext(`${route}\nroute();`, context);
  return { elements, calls };
}

test('installed integrity failure offers pinned repair, not stop then first install', () => {
  const h = recovery('2.3.7');
  const button = h.elements.get('inline').children[0];
  assert.equal(button.label, '修复当前安装');
  assert.equal(h.elements.get('status').textContent, '需要修复');
  assert.equal(h.calls.some(c => c[0] === 'stop' || c[0] === 'install'), false);
  button.click();
  assert.equal(h.calls.at(-1)[0], 'update');
  assert.equal(h.calls.at(-1)[1].tag, 'v2.3.7');
});

test('unknown installed version cannot trigger an unpinned repair', () => {
  assert.equal(recovery('').elements.get('inline').children[0].disabled, true);
});

test('interrupted transaction offers neither reinstall nor another update', () => {
  const h = recovery('2.3.7', { status: 'prepared', backup: '/saved/backup' });
  assert.equal(h.elements.get('status').textContent, '需要恢复');
  assert.equal(h.elements.get('inline').children.some(c => c.click), false);
  assert.equal(h.calls.some(c => c[0] === 'update' || c[0] === 'install' || c[0] === 'start'), false);
});
