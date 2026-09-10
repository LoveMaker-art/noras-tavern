const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readLocation, selectLocation, canChangeLocation } = require('../installer/desktop/install-location');
const { own, makePlan, cleanup } = require('../installer/desktop/uninstall');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-location-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const defaultHome = path.join(base, 'default', 'NoraTavern');
  const parent = path.join(base, 'custom 中文');
  fs.mkdirSync(parent); own(defaultHome);
  const options = { defaultHome, currentHome: defaultHome, scope: 'stable' };
  return { base, defaultHome, parent, options, select: () => selectLocation(parent, options) };
}
test('new root appends a dedicated directory and survives reopening without secrets in locator', t => {
  const f = fixture(t);
  assert.equal(readLocation(f.defaultHome, 'stable'), f.defaultHome);
  const selected = f.select();
  assert.equal(selected, path.join(f.parent, 'NoraTavern'));
  assert.equal(readLocation(f.defaultHome, 'stable'), selected);
  assert.equal(selectLocation(selected, f.options), selected);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.defaultHome, 'installer/location.json')))).sort(), ['owner', 'root', 'schema', 'scope']);
});
test('unrecognized files and redirected installation roots remain untouched', t => {
  const f = fixture(t), root = path.join(f.parent, 'NoraTavern');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'mine.txt'), 'keep');
  assert.throws(f.select, /其他文件/);
  assert.equal(fs.readFileSync(path.join(root, 'mine.txt'), 'utf8'), 'keep');
  fs.rmSync(root, { recursive: true });
  fs.symlinkSync(f.defaultHome, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(f.select, /符号链接/);
});
test('selection cannot nest inside the app or overwrite a file', t => {
  const f = fixture(t);
  assert.throws(() => selectLocation(f.parent, { ...f.options, appPath: f.parent }), /程序和数据/);
  fs.writeFileSync(path.join(f.parent, 'NoraTavern'), 'keep');
  assert.throws(f.select, /文件夹/);
  const nested = path.join(f.defaultHome, 'cache'); fs.mkdirSync(nested);
  assert.throws(() => selectLocation(nested, f.options), /互相包含/);
});
test('partial installs lock the location, including corrupted or started state', t => {
  const f = fixture(t);
  assert.equal(canChangeLocation(f.defaultHome), true);
  fs.mkdirSync(path.join(f.defaultHome, 'installer'));
  fs.writeFileSync(path.join(f.defaultHome, 'installer/state.json'), '{');
  assert.equal(canChangeLocation(f.defaultHome), false);
  fs.writeFileSync(path.join(f.defaultHome, 'installer/state.json'), JSON.stringify({ startedAt: 1 }));
  assert.throws(f.select, /已经开始/);
  fs.rmSync(path.join(f.defaultHome, 'installer/state.json'));
  fs.mkdirSync(path.join(f.defaultHome, 'hermes'));
  assert.equal(canChangeLocation(f.defaultHome), false);
});
test('test channels cannot reuse stable or another test installation', t => {
  const f = fixture(t); f.select();
  assert.throws(() => selectLocation(f.parent, { ...f.options, scope: 'beta' }), /混用/);
  assert.throws(() => readLocation(f.defaultHome, 'beta'), /记录无效/);
});
test('existing owned installation is reused without overwriting data', t => {
  const f = fixture(t), root = f.select();
  fs.mkdirSync(path.join(root, 'hermes'));
  fs.writeFileSync(path.join(root, 'hermes', 'SOUL.md'), 'user data');
  assert.equal(f.select(), root);
  assert.equal(fs.readFileSync(path.join(root, 'hermes', 'SOUL.md'), 'utf8'), 'user data');
  assert.equal(canChangeLocation(root), false);
});
test('missing drive or changed owner fails closed instead of installing at default', t => {
  const f = fixture(t), root = f.select();
  fs.renameSync(f.parent, `${f.parent}-offline`);
  assert.throws(() => readLocation(f.defaultHome, 'stable'), /连接磁盘/);
  fs.renameSync(`${f.parent}-offline`, f.parent);
  fs.writeFileSync(path.join(root, 'nora-owner.json'), JSON.stringify({ schema: 1, id: 'other' }));
  assert.throws(() => readLocation(f.defaultHome, 'stable'), /归属已变化/);
});
test('uninstall uses chosen root and reinstall can reuse its location', t => {
  const f = fixture(t), root = f.select();
  fs.mkdirSync(path.join(root, 'hermes')); fs.mkdirSync(path.join(root, 'tavern'));
  const plan = makePlan({ home: root, hermesHome: path.join(root, 'hermes'), installRoot: path.join(root, 'tavern'), mode: 'all' });
  assert.equal(plan.root, root); cleanup(plan);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(f.defaultHome), true);
  assert.equal(readLocation(f.defaultHome, 'stable'), root);
  assert.equal(canChangeLocation(root), true);
});
