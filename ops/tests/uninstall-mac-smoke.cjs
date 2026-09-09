// Uses a disposable copy of Electron, never an installed Nora application.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { makePlan } = require('../installer/desktop/uninstall');

if (process.platform !== 'darwin') throw new Error('This smoke test requires macOS.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-uninstall-mac-'));
try {
  const appPath = path.join(fs.realpathSync(root), 'Fixture.app');
  const source = path.resolve(__dirname, '../installer/desktop/node_modules/electron/dist/Electron.app');
  fs.cpSync(source, appPath, { recursive: true, verbatimSymlinks: true });
  const home = path.join(root, 'NoraTavern');
  const executable = path.join(appPath, 'Contents/MacOS/Electron');
  const plan = makePlan({ home, hermesHome: path.join(home, 'hermes'), installRoot: path.join(home, 'tavern'), mode: 'all', executable, appPath });
  fs.mkdirSync(path.join(home, 'hermes')); fs.writeFileSync(path.join(home, 'hermes/.env'), 'TEST_FIXTURE=1');
  const file = path.join(root, 'nora-uninstall.json'); fs.writeFileSync(file, JSON.stringify(plan));
  const modulePath = path.resolve(__dirname, '../installer/desktop/uninstall.js');
  const result = spawnSync(executable, ['-e', `require(${JSON.stringify(modulePath)}).worker(${JSON.stringify(file)}, () => {})`],
    { cwd: os.tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'result.json'))).state, 'complete');
  assert.equal(fs.existsSync(appPath), false); assert.equal(fs.existsSync(home), false);
  assert.equal(fs.existsSync(source), true);
  console.log('PASS: copied Mac helper removed its own fixture app and data; original Electron untouched.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
