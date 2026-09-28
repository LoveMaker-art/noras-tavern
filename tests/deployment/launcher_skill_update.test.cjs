const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createSkillUpdateReceiver, finishHandoff } = require('../installer/desktop/skill-update');

async function fixture(t, execute, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill update '));
  const receiver = createSkillUpdateReceiver({ home: () => home, busy: () => false, execute, ...extra });
  t.after(() => { receiver.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await receiver.tick();
  const directory = path.join(home, 'installer/skill-update');
  const file = path.join(directory, 'request.json');
  const endpoint = JSON.parse(fs.readFileSync(path.join(directory, 'endpoint.json')));
  function submit(changes = {}) {
    const request = { schema: 1, id: randomUUID(), action: 'update', confirm: true,
      createdAt: Date.now(), session: endpoint.session, status: 'queued', ...changes };
    fs.writeFileSync(file, JSON.stringify(request));
    return request;
  }
  return { home, receiver, submit, status: () => JSON.parse(fs.readFileSync(file)) };
}
test('skill request hands off exactly once, with a persistent successful result', async t => {
  let calls = 0, finish;
  const f = await fixture(t, async action => {
    calls++; assert.equal(action, 'update');
    await new Promise(resolve => { finish = resolve; });
    return { version: '2.4.0', systemReady: true };
  });
  const request = f.submit();
  const task = f.receiver.tick();
  assert.equal(f.status().status, 'running');
  await f.receiver.tick();
  assert.equal(calls, 1);
  finish(); await task;
  assert.equal(f.status().id, request.id);
  assert.equal(f.status().result.systemReady, true);
  await f.receiver.tick();
  assert.equal(calls, 1);
});
test('busy launcher waits; expired or unconfirmed requests never execute', async t => {
  let busy = true;
  const f = await fixture(t, () => assert.fail('must not execute'), { busy: () => busy });
  f.submit({ createdAt: Date.now() - 70000 });
  await f.receiver.tick();
  assert.equal(f.status().status, 'queued');
  busy = false; await f.receiver.tick();
  assert.equal(f.status().status, 'error');
  f.submit({ confirm: false }); await f.receiver.tick();
  assert.equal(f.status().status, 'error');
});
test('restarting launcher never replays an accepted task', async t => {
  const f = await fixture(t, () => assert.fail('must not execute'));
  f.submit({ status: 'running', session: 'old-session' });
  await f.receiver.tick();
  assert.equal(f.status().status, 'interrupted');
});
test('application restart is not success until the unified update finishes', async t => {
  const f = await fixture(t, async () => ({ restarting: true }));
  const request = f.submit();
  await f.receiver.tick();
  assert.equal(f.status().status, 'restarting');
  finishHandoff(f.home, 'different-id', { version: '2.4.0' });
  assert.equal(f.status().status, 'restarting');
  finishHandoff(f.home, request.id, { version: '2.4.0', systemReady: true });
  assert.equal(f.status().status, 'success');
  await f.receiver.tick();
  assert.equal(f.status().result.version, '2.4.0');
});
test('failures remain failures and diagnostic secrets are cleaned', async t => {
  const f = await fixture(t, async () => { throw new Error('token secret'); }, { clean: value => value.replace('secret', '[redacted]') });
  f.submit(); await f.receiver.tick();
  assert.equal(f.status().status, 'error');
  assert.equal(f.status().error, 'token [redacted]');
});
test('both UI and skill execute the same launcher action', () => {
  const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
  assert.match(source, /handle\('nora:run', runAction\)/);
  assert.match(source, /await runAction\(\{ sender: null \}, \{ action: 'update'/);
});
test('real Python skill exchanges a request and result with the JS receiver', async t => {
  const f = await fixture(t, async () => ({ version: '2.4.0', systemReady: true }));
  const hermes = path.join(f.home, 'hermes');
  fs.mkdirSync(hermes);
  fs.writeFileSync(path.join(hermes, 'nora-instance.json'), JSON.stringify({ schema: 1,
    noraHome: f.home, hermesHome: hermes, installRoot: path.join(f.home, 'tavern') }));
  const script = path.join(__dirname, '../skills/system/tavern-updater/scripts/update.py');
  const command = 'import importlib.util,json,sys; from pathlib import Path; s=importlib.util.spec_from_file_location("skill",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.managed_request(Path(sys.argv[2]),sys.argv[3])))';
  const python = process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const errors = [];
  const timer = setInterval(() => f.receiver.tick().catch(error => errors.push(error)), 30);
  try {
    const { stdout } = await promisify(execFile)(python, ['-B', '-c', command, script, hermes, 'update'], { timeout: 15000 });
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'success');
    assert.equal(result.result.systemReady, true);
    const queried = await promisify(execFile)(python, ['-B', '-c', command, script, hermes, 'status'], { timeout: 15000 });
    assert.equal(JSON.parse(queried.stdout).id, result.id);
    assert.deepEqual(errors, []);
  } finally { clearInterval(timer); }
});
