const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const test = require('node:test');
const {captureChild, firstJsonLine, stopChild} = require('./launcher_test_lifecycle.cjs');

function fixture(t, source) {
  const child = spawn(process.execPath, ['-e', source]);
  captureChild(child);
  t.after(() => stopChild(child));
  return child;
}

test('invalid fixture JSON rejects the wait without escaping its data callback', async t => {
  const child = fixture(t, "process.stdout.write('malformed-json\\n');");
  await assert.rejects(firstJsonLine(child), {code: 'FIXTURE_JSON_INVALID'});
  assert.equal((await captureChild(child).closed).code, 0);
});

test('a cached child close and output remain observable after the caller resumes', async t => {
  const child = fixture(t, "process.stdout.write(JSON.stringify({ready:true})+'\\n');");
  const state = captureChild(child);
  await state.closed;
  assert.equal(captureChild(child), state);
  assert.deepEqual(await firstJsonLine(child), {ready: true});
  assert.equal((await stopChild(child)).code, 0);
});

test('JSON output after exit is consumed until actual stream close', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  captureChild(child);
  const ready = firstJsonLine(child);
  child.emit('exit', 0, null);
  child.stdout.write('{"ready":'); child.stdout.write('true}\n');
  child.emit('close', 0, null);
  assert.deepEqual(await ready, {ready: true});
});

test('a spawn error rejects readiness while closure and cleanup wait for the delayed close', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.kill = () => assert.fail('An unspawned fixture has no process to signal');
  const state = captureChild(child);
  let closeSettled = false, cleanupSettled = false;
  state.closed.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  const error = Object.assign(new Error('controlled missing executable'), {code: 'ENOENT'});
  child.emit('error', error);
  const cleanup = stopChild(child);
  cleanup.then(() => { cleanupSettled = true; }, () => { cleanupSettled = true; });
  try {
    await assert.rejects(firstJsonLine(child), value => value === error);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closeSettled, false, 'An error event is not a close event');
    assert.equal(cleanupSettled, false, 'Cleanup cannot return before pipes and close callbacks finish');
    child.emit('close', -2, null);
    assert.deepEqual(await state.closed, {code: -2, signal: null});
    assert.deepEqual(await cleanup, {code: -2, signal: null});
    assert.equal(state.error, error);
  } finally {
    if (!state.didClose) child.emit('close', -2, null);
    await Promise.allSettled([state.closed, cleanup]);
  }
});

test('missing output, a spawn refusal and a deadline reject with their actual cause', async t => {
  const empty = fixture(t, "process.stderr.write('fixture exited before readiness');");
  await assert.rejects(firstJsonLine(empty), error => error.code === 'FIXTURE_JSON_MISSING'
    && /fixture exited before readiness/.test(error.message));
  const missing = spawn(process.execPath + '.missing-fixture', []);
  captureChild(missing);
  await assert.rejects(firstJsonLine(missing), {code: 'ENOENT'});
  await stopChild(missing);
  assert.equal(captureChild(missing).didClose, true);
  const idle = fixture(t, 'setInterval(()=>{},1000);');
  await assert.rejects(firstJsonLine(idle, {timeoutMs: 25}), {code: 'FIXTURE_JSON_TIMEOUT'});
  assert.equal(captureChild(idle).updates.listenerCount('change'), 0);
});

test('cleanup escalates a held fixture that ignores termination and waits for close', async t => {
  const child = fixture(t, "process.on('SIGTERM',()=>{});process.stdout.write('{\"ready\":true}\\n');setInterval(()=>{},1000);");
  await firstJsonLine(child);
  const result = await stopChild(child, {graceMs: 25});
  assert.equal(captureChild(child).didClose, true);
  assert.notEqual(result.code, 0);
  if (process.platform !== 'win32') assert.equal(result.signal, 'SIGKILL');
});

test('an intentional crash keeps its requested SIGKILL and confirms actual pipe close', async t => {
  const child=fixture(t,"process.stdout.write('{\"ready\":true}\\n');setInterval(()=>{},1000);");
  await firstJsonLine(child);
  const result=await stopChild(child,{signal:'SIGKILL'});
  assert.equal(result.signal,'SIGKILL');assert.equal(result.code,null);
  assert.equal(captureChild(child).didClose,true);
});
