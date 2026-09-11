const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDiagnostics, errorDetails } = require('../installer/desktop/diagnostics');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { parse } = require('../installer/desktop/node_modules/acorn');

test('a fatal startup location error is persisted even before the window exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-startup-diagnostics-'));
  try {
    const main = path.resolve(__dirname, '../installer/desktop/main.js');
    const script = `
      const Module = require('node:module');
      const original = Module._load;
      Module._load = function(name, ...args) {
        if (name === 'electron') return {
          app: { isPackaged: true, getPath: () => process.argv[2], getVersion: () => 'fixture' },
          BrowserWindow: {}, ipcMain: {}, shell: {},
        };
        if (name === './install-location') return { readLocation() {
          throw Object.assign(new Error('installation disk unavailable'), {code: 'ENOENT', syscall: 'stat', path: 'D:\\\\NoraTavern'});
        }};
        return original.call(this, name, ...args);
      };
      require(process.argv[1]);
    `;
    const child = spawnSync(process.execPath, ['-e', script, main, root], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    const records = fs.readFileSync(path.join(root, 'NoraTavern/diagnostics/install.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const failure = records.find(item => item.event === 'main.uncaught');
    assert.equal(failure.error.code, 'ENOENT');
    assert.equal(failure.error.syscall, 'stat');
    assert.match(failure.error.stack, /main.js/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function mainContext(root, overrides = {}) {
  const file = path.resolve(__dirname, '../installer/desktop/main.js');
  const localRequire = createRequire(file);
  const context = vm.createContext({
    require: name => name === 'electron' ? { app: { getPath: () => root, getVersion: () => 'fixture' } }
      : Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    __dirname: path.dirname(file), process: { ...process, argv: [], on() {} },
    setInterval, clearInterval, setTimeout, clearTimeout, console, root,
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  vm.runInContext(`noraHome = () => root; installerRoot = () => root;
    launcherEnv = () => process.env; diagnostics.begin('real-child', {action: 'install'});`, context);
  return context;
}

test('operation handler logs original failure even if persisting the error state fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-handler-diagnostics-'));
  try {
    const original = Object.assign(new Error('release fixture failure'), { code: 'ECONNRESET' });
    const context = mainContext(root, {
      './test-build': { testBuild: () => null },
      './releases': { prepare: async () => { throw original; } },
    });
    context.AbortController = AbortController;
    const source = fs.readFileSync(path.resolve(__dirname, '../installer/desktop/main.js'), 'utf8');
    let callback;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.name === 'handle' && node.arguments[0]?.value === 'nora:run') callback = node.arguments[1];
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(parse(source, { ecmaVersion: 'latest' }));
    vm.runInContext(`const persist = writeInstallerState;
      writeInstallerState = value => { if (value.phase === 'error') throw new Error('state write failed'); return persist(value); };`, context);
    const handler = vm.runInContext(`(${source.slice(callback.start, callback.end)})`, context);
    await assert.rejects(handler({ sender: null }, { action: 'install', runId: 'failed-attempt' }), error => error === original);
    assert.equal(vm.runInContext('activeRun', context), false);
    const records = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some(item => item.event === 'run.failed' && item.error.code === 'ECONNRESET'));
    assert.ok(records.some(item => item.event === 'state.write-failed' && item.error.message === 'state write failed'));
    assert.ok(records.some(item => item.event === 'run.end' && item.outcome === 'error' && item.runId === 'failed-attempt'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real main process records full child stderr, diagnostics, command, and exit without leaking pairing input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-main-diagnostics-'));
  try {
    const context = mainContext(root);
    context.command = [process.execPath, ['-e', `
      console.log(JSON.stringify({event: 'task', task: 'copy-skills'}));
      console.log(JSON.stringify({event: 'diagnostic', error: {code: 'EPERM', syscall: 'symlink', path: 'skills/apple', stack: 'fixture-stack'}}));
      process.stderr.write('START-pair-fixture-' + 'x'.repeat(14000) + '-END'); process.exitCode = 1;
    `]];
    await assert.rejects(vm.runInContext(`diagnostics.addSecret('pair-fixture'); runProcess(...command)`, context));
    const raw = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8');
    assert.ok(!raw.includes('pair-fixture'));
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(item => item.event === 'process.start' && item.command[0] === process.execPath));
    assert.ok(records.some(item => item.event === 'diagnostic' && item.error.syscall === 'symlink'));
    const stderr = records.find(item => item.stream === 'stderr');
    assert.ok(stderr.line.startsWith('START-') && stderr.line.endsWith('-END') && stderr.line.length > 14000);
    assert.equal(stderr.stage, 'copy-skills');
    const exit = records.find(item => item.event === 'process.exit');
    assert.equal(exit.exitCode, 1);
    assert.equal(exit.signal, null);
    assert.equal(exit.timedOut, false);
    assert.ok(exit.durationMs >= 0);
    context.command = [path.join(root, 'missing-executable'), []];
    await assert.rejects(vm.runInContext('runProcess(...command)', context));
    await new Promise(resolve => setImmediate(resolve));
    const updated = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(updated.some(item => item.event === 'process.error' && item.error.code === 'ENOENT' && item.error.syscall.startsWith('spawn')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bridge records errors without a window and does not redact functional result URLs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-bridge-diagnostics-'));
  try {
    const context = mainContext(root);
    context.childScript = `process.stderr.write('traceback-head\\n' + 'x'.repeat(9000) + '\\ntraceback-tail'); process.exitCode = 1;`;
    vm.runInContext('bridgeArgs = () => ({command: process.execPath, args: ["-e", childScript]});', context);
    await assert.rejects(vm.runInContext('runBridge("install")', context));
    const log = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8');
    assert.match(log, /traceback-head/);
    assert.match(log, /traceback-tail/);
    context.childScript = `console.log(JSON.stringify({event: 'result', url: 'https://example.test/?token=functional-result', ok: true}));`;
    const result = await vm.runInContext('runBridge("install")', context);
    assert.equal(result.url, 'https://example.test/?token=functional-result');
    assert.ok(!fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').includes('functional-result'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('secrets are removed before the UI error summary is truncated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-long-secret-'));
  try {
    const context = mainContext(root);
    context.secret = 'private-value-' + 'a'.repeat(5000);
    vm.runInContext('diagnostics.addSecret(secret);', context);
    context.args = ['-e', `process.stderr.write(${JSON.stringify(context.secret)}); process.exitCode = 1;`];
    await assert.rejects(vm.runInContext('runProcess(process.execPath, args)', context), error => {
      assert.ok(!error.message.includes('a'.repeat(20)));
      assert.match(error.message, /REDACTED/);
      return true;
    });
    assert.ok(!fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').includes('a'.repeat(20)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('main records timeout and termination separately from an ordinary nonzero exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-timeout-diagnostics-'));
  try {
    const context = mainContext(root);
    context.setTimeout = (callback, delay) => setTimeout(callback, delay === 1800000 ? 80 : delay);
    await assert.rejects(vm.runInContext('runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"])', context));
    const records = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some(item => item.event === 'process.timeout' && item.timeoutMs === 1800000));
    assert.ok(records.some(item => item.event === 'process.exit' && item.timedOut));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('diagnostics retain full errors, nested causes, and separate attempts without secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-diagnostics-'));
  try {
    const log = path.join(root, 'install.log');
    const diagnostics = createDiagnostics({ primary: () => log, fallback: path.join(root, 'fallback.log') });
    diagnostics.addSecret('pair-code-fixture');
    const error = Object.assign(new Error('copy failed pair-code-fixture'), {
      code: 'EPERM', errno: -4048, syscall: 'symlink', path: 'D:\\诺拉 agent\\hermes\\skills\\apple',
      cause: new Error('original cause'), secondaryErrors: [{ operation: 'rollback', error: new Error('cleanup failed') }],
    });
    diagnostics.begin('attempt-one', { action: 'install', platform: 'win32', version: 'test' });
    diagnostics.event({ event: 'task', task: 'initialize', current: 2, total: 3 });
    diagnostics.event({ event: 'log', stream: 'stderr', line: 'long-output-' + 'x'.repeat(12000) + '-tail' });
    diagnostics.error('install.failed', error);
    diagnostics.finish('error');
    diagnostics.begin('attempt-two', { action: 'pair' });
    diagnostics.event({ event: 'log', line: 'API_KEY="fixture-secret with spaces" Authorization: Bearer token-fixture' });
    diagnostics.event({ event: 'command', command: ['python', '--token', 'secret-arg', 'https://host/path?token=url-secret'] });
    diagnostics.finish('ready');
    const raw = fs.readFileSync(log, 'utf8');
    for (const secret of ['pair-code-fixture', 'fixture-secret', 'token-fixture', 'secret-arg', 'url-secret']) assert.ok(!raw.includes(secret), secret);
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    const failure = records.find(item => item.event === 'install.failed');
    assert.equal(failure.runId, 'attempt-one');
    assert.equal(failure.stage, 'initialize');
    assert.equal(failure.error.syscall, 'symlink');
    assert.equal(failure.error.path, error.path);
    assert.match(failure.error.stack, /launcher_diagnostics.test.cjs/);
    assert.equal(failure.error.cause.message, 'original cause');
    assert.equal(failure.error.secondaryErrors[0].error.message, 'cleanup failed');
    assert.ok(records.some(item => item.line?.endsWith('-tail') && item.line.length > 12000));
    assert.ok(records.some(item => item.runId === 'attempt-two' && item.event === 'run.end' && item.durationMs >= 0));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an inaccessible install directory still writes the failure to the fallback log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-diagnostics-fallback-'));
  try {
    const fallback = path.join(root, 'fallback', 'install.log');
    const diagnostics = createDiagnostics({ primary: () => { throw new Error('location missing'); }, fallback });
    diagnostics.error('startup.failed', new Error('cannot load installation'));
    const record = JSON.parse(fs.readFileSync(fallback, 'utf8'));
    assert.equal(record.error.message, 'cannot load installation');
    assert.equal(record.logWriteError.message, 'location missing');
    assert.equal(diagnostics.lastFile, fallback);
    const cycle = new Error('cycle'); cycle.cause = cycle;
    assert.doesNotThrow(() => JSON.stringify(errorDetails(cycle)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
