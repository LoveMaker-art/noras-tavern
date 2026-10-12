// Uses a disposable copy of Electron, never an installed Nora application.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { makePlan } = require('../installer/desktop/uninstall');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function runHelper(executable, modulePath, file, { timeout = 120000 } = {}) {
  // An explicit absolute entry also lets the offline checker identify this
  // fixture's parent process without making an inline-execution exception.
  const entry = path.join(path.dirname(file), 'fixture-helper.cjs');
  fs.writeFileSync(entry, `require(${JSON.stringify(modulePath)}).worker(${JSON.stringify(file)}, () => {});\n`, { flag: 'wx' });
  const child = spawn(executable, [entry], {
    cwd: os.tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '', failure, timedOut = false, closed = false;
  child.stdout.resume();
  child.stderr.on('data', bytes => { if (stderr.length < 65536) stderr += bytes.toString('utf8'); });
  child.once('error', error => { failure = error; });
  const completion = new Promise(resolve => child.once('close', (status, signal) => {
    closed = true; resolve({ status, signal });
  }));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  try {
    const result = await completion;
    if (failure) throw failure;
    assert.equal(timedOut, false, 'The copied fixture helper timed out and was closed');
    assert.equal(result.signal, null, stderr);
    assert.equal(result.status, 0, stderr);
  } finally {
    clearTimeout(timer);
    if (!closed) { child.kill('SIGKILL'); await completion; }
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This smoke test requires macOS.');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-uninstall-mac-')));
  try {
    const appPath = path.join(fs.realpathSync(root), 'Fixture.app');
    const source = path.resolve(__dirname, '../installer/desktop/node_modules/electron/dist/Electron.app');
    fs.cpSync(source, appPath, { recursive: true, verbatimSymlinks: true });
    const home = path.join(root, 'NoraTavern');
    const executable = path.join(appPath, 'Contents/MacOS/Electron');
    const plan = makePlan({ home, hermesHome: path.join(home, 'hermes'), installRoot: path.join(home, 'tavern'), mode: 'all', executable, appPath, port: await freePort() });
    fs.mkdirSync(path.join(home, 'hermes')); fs.writeFileSync(path.join(home, 'hermes/.env'), 'TEST_FIXTURE=1');
    const file = path.join(root, 'nora-uninstall.json'); fs.writeFileSync(file, JSON.stringify(plan));
    const modulePath = path.resolve(__dirname, '../installer/desktop/uninstall.js');
    await runHelper(executable, modulePath, file);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'result.json'))).state, 'complete');
    assert.equal(fs.existsSync(appPath), false);
    assert.deepEqual(fs.readdirSync(home).sort(), ['installer', 'nora-owner.json']);
    assert.deepEqual(fs.readdirSync(path.join(home, 'installer')), ['operations']);
    assert.deepEqual(fs.readdirSync(path.join(home, 'installer/operations')), ['.writer.lock']);
    assert.equal(fs.existsSync(source), true);
    console.log('PASS: copied Mac helper removed its own fixture app and data; original Electron untouched.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

module.exports = { runHelper };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
