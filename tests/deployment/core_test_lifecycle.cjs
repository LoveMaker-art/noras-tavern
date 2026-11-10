// Test-only lifecycle tracking. Register immediately after creating a fixture
// child; process exit alone does not mean its output pipes have closed.
const {EventEmitter} = require('node:events');
const {StringDecoder} = require('node:string_decoder');

const children = new WeakMap();

function captureChild(child) {
  if (children.has(child)) return children.get(child);
  const updates = new EventEmitter();
  const decoder = new StringDecoder('utf8');
  const state = {child, didClose: false, error: null, stdout: '', stderr: '', updates};
  const stdout = value => {
    if (!state.stdout.includes('\n') && state.stdout.length < 65536) {
      state.stdout = (state.stdout + decoder.write(value)).slice(0, 65536);
    }
    updates.emit('change');
  };
  const stderr = value => {
    state.stderr = (state.stderr + String(value)).slice(-32768);
  };
  let finish;
  state.closed = new Promise(resolve => { finish = resolve; });
  const error = value => {
    state.error = value;
    updates.emit('change');
  };
  const close = (code, signal) => {
    state.stdout += decoder.end();
    state.didClose = true;
    state.result = {code, signal};
    child.stdout?.removeListener('data', stdout);
    child.stderr?.removeListener('data', stderr);
    child.removeListener('error', error);
    finish(state.result);
    updates.emit('change');
  };
  child.stdout?.on('data', stdout);
  child.stderr?.on('data', stderr);
  child.on('error', error);
  child.once('close', close);
  children.set(child, state);
  return state;
}

function firstJsonLine(child, {timeoutMs = 8000} = {}) {
  const state = captureChild(child);
  return new Promise((resolve, reject) => {
    let timer;
    const settle = (error, value) => {
      clearTimeout(timer);
      state.updates.removeListener('change', check);
      if (error) reject(error); else resolve(value);
    };
    const check = () => {
      const end = state.stdout.indexOf('\n');
      if (end >= 0) {
        try { settle(null, JSON.parse(state.stdout.slice(0, end))); }
        catch (cause) { settle(Object.assign(new Error('Fixture child emitted an invalid JSON line', {cause}), {code: 'FIXTURE_JSON_INVALID'})); }
      } else if (state.error) settle(state.error);
      else if (state.didClose) settle(Object.assign(new Error(
        `Fixture child closed without a JSON line (${state.result.code}, ${state.result.signal}): ${state.stderr}`),
      {code: 'FIXTURE_JSON_MISSING'}));
    };
    state.updates.on('change', check);
    timer = setTimeout(() => settle(Object.assign(new Error(
      `Fixture child did not emit a JSON line within ${timeoutMs} ms: ${state.stderr}`),
    {code: 'FIXTURE_JSON_TIMEOUT'})), timeoutMs);
    check();
  });
}

// Only for real fixture ChildProcesses held by the caller. Guard-owned jobs
// must be cancelled through their existing lease instead of this function.
async function stopChild(child, {graceMs = 1000, timeoutMs = 5000, signal = 'SIGTERM'} = {}) {
  if (!child) return;
  const state = captureChild(child);
  if (state.didClose) return state.result;
  let force, deadline;
  try {
    if (Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      if (signal !== 'SIGKILL') force = setTimeout(() => child.kill('SIGKILL'), graceMs);
    }
    return await Promise.race([state.closed, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Object.assign(new Error(
        `Fixture child did not close within ${timeoutMs} ms`), {code: 'FIXTURE_CLOSE_TIMEOUT'})), timeoutMs);
    })]);
  } finally { clearTimeout(force); clearTimeout(deadline); }
}

module.exports = {captureChild, firstJsonLine, stopChild};
