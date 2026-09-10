const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { makePlan, cleanup, restoreRetained, worker, RETAINED } = require('../installer/desktop/uninstall');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-uninstall-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'NoraTavern');
  const write = (relative, data = 'fixture') => {
    const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
  };
  const data = ['hermes/.env', 'hermes/SOUL.md', 'hermes/AGENTS.md', 'hermes/memories/MEMORY.md',
    'hermes/cron/jobs.json', 'hermes/clawchat/credentials.json', 'hermes/plugins/custom/data',
    'hermes/sessions/history.db', 'tavern/tavern-state/native/default-user/chats/chat.jsonl',
    'tavern/tavern-state/imports/card.png', 'installer/model.json', 'installer/backups/previous/.env'];
  const programs = ['hermes/hermes-agent/venv/python', 'hermes/node/node', 'hermes/python/python',
    'hermes/plugins/clawchat/plugin.py', 'hermes/clawchat/liveware/liveware', 'tavern/apps/tavern-runtime/server.js',
    'cache/tmp/stale', 'launcher/Local State'];
  for (const name of [...data, ...programs]) write(name);
  write('tavern/tavern-state/native-runtime/config.yaml', 'custom: retained');
  const plan = mode => makePlan({ home, hermesHome: path.join(home, 'hermes'), installRoot: path.join(home, 'tavern'), mode });
  return { directory, home, write, data, programs, plan };
}

test('keep removes programs, retains credentials, chats, config and backups; repeat is safe', t => {
  const f = fixture(t), plan = f.plan('keep');
  const events = []; cleanup(plan, event => events.push(event));
  for (const name of f.data) assert.equal(fs.readFileSync(path.join(f.home, name), 'utf8'), 'fixture', name);
  for (const name of f.programs) assert.equal(fs.existsSync(path.join(f.home, name)), false, name);
  assert.equal(fs.readFileSync(path.join(f.home, 'tavern/tavern-state/nora-retained-config.yaml'), 'utf8'), 'custom: retained');
  assert.ok(events.length > 0); assert.equal(events.at(-1).current, events.at(-1).total);
  cleanup(plan);
  assert.equal(fs.existsSync(path.join(f.home, RETAINED)), true);
});

test('complete uninstall deletes isolation directory, never adjacent Hermes', t => {
  const f = fixture(t), outside = path.join(f.directory, '.hermes');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'unrelated');
  cleanup(f.plan('all'));
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unrelated');
});

test('Windows-length paths over 260 characters are removed', t => {
  const f = fixture(t);
  f.write(`tavern/apps/runtime/node_modules/${'x'.repeat(90)}/${'y'.repeat(90)}/workerHelpers.worker.js`);
  cleanup(f.plan('all')); assert.equal(fs.existsSync(f.home), false);
});

test('redirected deletion root aborts before touching any files', t => {
  const f = fixture(t), plan = f.plan('keep'), outside = path.join(f.directory, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'unrelated');
  fs.rmSync(path.join(f.home, 'cache'), { recursive: true });
  fs.symlinkSync(outside, path.join(f.home, 'cache'), 'junction');
  assert.throws(() => cleanup(plan), /链接/);
  assert.equal(fs.existsSync(path.join(f.home, f.programs[0])), true);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unrelated');
});

test('nested symlinks are unlinked without following them', t => {
  const f = fixture(t), outside = path.join(f.directory, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'unrelated');
  fs.symlinkSync(outside, path.join(f.home, 'tavern/apps/external'), 'junction');
  cleanup(f.plan('all'));
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unrelated');
});

test('changed ownership and dangerous roots are rejected', t => {
  const f = fixture(t), plan = f.plan('all');
  fs.writeFileSync(path.join(f.home, 'nora-owner.json'), JSON.stringify({ schema: 1, id: 'different' }));
  assert.throws(() => cleanup(plan), /归属|变化/);
  assert.equal(fs.existsSync(path.join(f.home, 'hermes/.env')), true);
  assert.throws(() => f.plan('unknown'), /方式/);
  assert.throws(() => makePlan({ home: os.homedir(), hermesHome: '.hermes', installRoot: 'tavern', mode: 'all' }), /用户目录/);
  assert.throws(() => makePlan({ home: f.home, hermesHome: f.directory, installRoot: path.join(f.home, 'tavern'), mode: 'all' }), /越过/);
});

test('retained Hermes data overlays the new runtime, not its binaries', t => {
  const f = fixture(t); cleanup(f.plan('keep'));
  const previous = path.join(f.directory, 'previous'), current = path.join(f.home, 'hermes');
  fs.renameSync(current, previous);
  fs.mkdirSync(path.join(previous, 'plugins/clawchat'), { recursive: true });
  fs.writeFileSync(path.join(previous, 'plugins/clawchat/plugin.py'), 'old interrupted cleanup');
  f.write('hermes/hermes-agent/runtime', 'new'); f.write('hermes/.env', 'new-empty');
  f.write('hermes/plugins/clawchat/plugin.py', 'new plugin');
  assert.equal(restoreRetained(f.home, previous, current), true);
  assert.equal(fs.readFileSync(path.join(current, '.env'), 'utf8'), 'fixture');
  assert.equal(fs.readFileSync(path.join(current, 'hermes-agent/runtime'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(current, 'plugins/clawchat/plugin.py'), 'utf8'), 'new plugin');
  assert.equal(fs.readFileSync(path.join(current, 'plugins/custom/data'), 'utf8'), 'fixture');
});

test('standalone helper records actual completion outside the deleted root', async t => {
  const f = fixture(t), file = path.join(f.directory, 'nora-uninstall.json');
  fs.writeFileSync(file, JSON.stringify(f.plan('all')));
  await worker(file, () => {});
  const result = JSON.parse(fs.readFileSync(path.join(f.directory, 'result.json'), 'utf8'));
  assert.equal(result.state, 'complete'); assert.equal(fs.existsSync(f.home), false);
});

test('all builds include helper; NSIS upgrade path bypasses both destructive hooks', () => {
  const desktop = path.resolve(__dirname, '../installer/desktop');
  const pkg = require(path.join(desktop, 'package.json'));
  assert.ok(pkg.build.files.includes('uninstall.js')); assert.equal(pkg.build.nsis.include, 'uninstall.nsh');
  const script = fs.readFileSync(path.join(desktop, 'uninstall.nsh'), 'utf8');
  assert.equal(script.match(/\$\{IfNot\} \$\{isUpdated\}/g).length, 2);
  assert.ok(script.includes('Call un.checkAppRunning'));
  assert.ok(script.includes('result.json')); assert.ok(script.includes('ELECTRON_RUN_AS_NODE'));
});

function wizard(t, responses) {
  const f = fixture(t), dialogs = [], exits = [];
  const main = path.resolve(__dirname, '../installer/desktop/main.js');
  const localRequire = createRequire(main);
  const electron = { app: { isPackaged: true, exit: code => exits.push(code) },
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: responses.shift() }; } } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === 'node:child_process'
      ? { spawnSync: () => ({ status: 1 }) } : localRequire(name),
    __dirname: path.dirname(main), console, setTimeout, clearTimeout,
    process: { platform: 'win32', argv: [], env: { NORA_TAVERN_HOME: f.home }, execPath: path.join(f.directory, 'launcher.exe') },
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context);
  const planFile = path.join(f.directory, 'nora-uninstall.json');
  context.planFile = planFile;
  return { ...f, context, dialogs, exits, planFile, run: () => vm.runInContext('confirmUninstall(planFile)', context) };
}

test('cancel leaves data and services untouched and creates no deletion plan', async t => {
  const f = wizard(t, [0]);
  assert.equal(await f.run(), false);
  assert.equal(fs.existsSync(f.planFile), false); assert.deepEqual(f.exits, []);
  assert.equal(fs.existsSync(path.join(f.home, 'hermes/.env')), true);
});

test('complete uninstall requires a second destructive confirmation', async t => {
  const f = wizard(t, [2, 0]);
  assert.equal(await f.run(), false); assert.equal(f.dialogs.length, 2);
  assert.equal(f.dialogs[1].defaultId, 0);
  assert.equal(fs.existsSync(f.planFile), false);
});

test('confirmed keep hands off exact installation paths, without deleting data in the UI process', async t => {
  const f = wizard(t, [1]);
  assert.equal(await f.run(), true);
  const plan = JSON.parse(fs.readFileSync(f.planFile));
  assert.equal(plan.mode, 'keep'); assert.equal(plan.root, fs.realpathSync(f.home));
  assert.equal(fs.existsSync(path.join(f.home, 'hermes/.env')), true);
  assert.deepEqual(f.exits, [0]);
});

test('failure to stop a service prevents creation of an uninstall plan', async t => {
  const f = wizard(t, [1]);
  vm.runInContext('findPython = () => ({}); runBridge = async () => { throw new Error("service still running"); }', f.context);
  await assert.rejects(f.run(), /service still running/);
  assert.equal(fs.existsSync(f.planFile), false);
  assert.equal(fs.existsSync(path.join(f.home, f.programs[0])), true);
});
