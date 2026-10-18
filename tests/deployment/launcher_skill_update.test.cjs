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
test('legacy receiver enters the same action and the UI routes content update to independent task', () => {
  const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
  assert.match(source, /handle\('nora:run', runAction\)/);
  assert.match(source, /await runAction\(\{ sender: null \}, \{ action: 'update'/);
  assert.match(source, /apps\/tavern-ops\/updater\/task.py/);
});
test('real Python skill refuses an unverified raw terminal record without a query closure', async t => {
  const f = await fixture(t, () => assert.fail('read-only query must not execute'));
  const hermes = path.join(f.home, 'hermes');
  fs.mkdirSync(hermes);
  fs.writeFileSync(path.join(hermes, 'nora-instance.json'), JSON.stringify({ schema: 1,
    noraHome: f.home, hermesHome: hermes, installRoot: path.join(f.home, 'tavern') }));
  const jobId=randomUUID(),operationId=randomUUID();
  const job=path.join(f.home,'installer/update-jobs',jobId),operation=path.join(f.home,'installer/operations',operationId);
  fs.mkdirSync(job,{recursive:true});fs.mkdirSync(operation,{recursive:true});
  fs.writeFileSync(path.join(job,'operation-ref.json'),JSON.stringify({operationId}));
  fs.writeFileSync(path.join(operation,'operation.json'),JSON.stringify({state:'succeeded',result:{version:'2.5.2'}}));
  fs.rmSync(path.join(f.home,'installer/skill-update/endpoint.json'));
  const script = path.join(__dirname, '../skills/system/tavern-updater/scripts/update.py');
  const python = process.env.NORA_TEST_PYTHON || process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  let failure;
  try{await promisify(execFile)(python,['-B',script,'--status'],{env:{...process.env,HERMES_HOME:hermes},timeout:15000});}
  catch(error){failure=error;}
  assert.equal(failure?.code,1);
  const queried=JSON.parse(failure.stdout);
  assert.equal(queried.requestId,undefined,'without a verified reader the wrapper cannot claim which task it inspected');
  assert.equal(queried.status,'inspection-required');
  assert.equal(JSON.parse(fs.readFileSync(path.join(operation,'operation.json'))).state,'succeeded','read-only failure preserves the raw evidence');
  assert.equal(queried.settled,false);assert.equal(queried.operation,undefined);
});
