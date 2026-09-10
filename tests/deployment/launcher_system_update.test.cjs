const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const update = require('../installer/desktop/system-update');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-system-update-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const name of ['hermes', 'tavern']) fs.mkdirSync(path.join(home, name));
  fs.writeFileSync(path.join(home, 'hermes/.env'), 'test-only-key-and-pairing');
  fs.writeFileSync(path.join(home, 'hermes/SOUL.md'), 'custom soul');
  fs.writeFileSync(path.join(home, 'tavern/story.json'), 'saved story');
  fs.writeFileSync(path.join(home, 'tavern/version'), 'beta.1');
  return home;
}
test('successful update retains configuration and story and keeps previous backup', async t => {
  const home = fixture(t); const calls = [];
  const result = await update.perform({ home, target: 'beta.2', stop: async () => calls.push('stop'),
    apply: async () => { calls.push('apply'); fs.writeFileSync(path.join(home, 'tavern/version'), 'beta.2'); },
    verify: async () => { calls.push('verify'); return { ok: true }; } });
  assert.deepEqual(calls, ['stop', 'apply', 'verify']);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(home, 'hermes/.env'), 'utf8'), 'test-only-key-and-pairing');
  assert.equal(fs.readFileSync(path.join(home, 'tavern/story.json'), 'utf8'), 'saved story');
  assert.equal(fs.readFileSync(path.join(home, 'installer/system-update/tavern/version'), 'utf8'), 'beta.1');
  assert.equal(update.pending(home), false);
});
test('failed verification restores programs, data and credentials together', async t => {
  const home = fixture(t);
  await assert.rejects(update.perform({ home, target: 'beta.2', stop: async () => {},
    apply: async () => {
      fs.writeFileSync(path.join(home, 'hermes/.env'), 'damaged');
      fs.writeFileSync(path.join(home, 'tavern/version'), 'beta.2');
      fs.unlinkSync(path.join(home, 'tavern/story.json'));
    }, verify: async () => { throw new Error('unhealthy'); } }), /已恢复原系统/);
  assert.equal(fs.readFileSync(path.join(home, 'hermes/.env'), 'utf8'), 'test-only-key-and-pairing');
  assert.equal(fs.readFileSync(path.join(home, 'tavern/story.json'), 'utf8'), 'saved story');
  assert.equal(fs.readFileSync(path.join(home, 'tavern/version'), 'utf8'), 'beta.1');
  assert.equal(update.pending(home), false);
});
test('process termination during replacement leaves recoverable journal', async t => {
  const home = fixture(t);
  const code = `const update=require(process.argv[1]);update.perform({home:process.argv[2],target:'beta.2',stop:async()=>{},apply:async()=>process.exit(9),verify:async()=>{}})`;
  const result = spawnSync(process.execPath, ['-e', code, require.resolve('../installer/desktop/system-update'), home]);
  assert.equal(result.status, 9);
  assert.equal(update.pending(home), true);
  await update.recover(home, async () => {});
  assert.equal(update.pending(home), false);
  assert.equal(fs.readFileSync(path.join(home, 'tavern/version'), 'utf8'), 'beta.1');
});
test('previous service selection is restored only after rollback restores its files', async t => {
  const home = fixture(t);
  let restored = false;
  await assert.rejects(update.perform({ home, target: 'beta.2', stop: async () => {},
    apply: async () => fs.writeFileSync(path.join(home, 'tavern/version'), 'beta.2'),
    verify: async () => { throw new Error('unhealthy'); },
    restoreRunning: async () => {
      assert.equal(update.pending(home), false);
      assert.equal(fs.readFileSync(path.join(home, 'tavern/version'), 'utf8'), 'beta.1');
      restored = true;
    },
  }), /已恢复原系统/);
  assert.equal(restored, true);
});
test('failed service stop makes no installation changes', async t => {
  const home = fixture(t);
  await assert.rejects(update.perform({ home, target: 'beta.2', stop: async () => { throw new Error('busy'); } }), /busy/);
  assert.equal(fs.existsSync(path.join(home, 'installer/system-update')), false);
  assert.equal(fs.readFileSync(path.join(home, 'tavern/version'), 'utf8'), 'beta.1');
});
test('runtime replacement preserves user state without copying old binaries over new ones', async t => {
  const home = fixture(t), old = path.join(home, 'hermes'), next = path.join(home, 'new-hermes');
  for (const root of [old, next]) {
    for (const name of ['hermes-agent', 'plugins/clawchat', 'clawchat/liveware']) fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, 'hermes-agent/core'), root === old ? 'old' : 'new');
    fs.writeFileSync(path.join(root, 'plugins/clawchat/plugin.py'), root === old ? 'old' : 'new');
    fs.writeFileSync(path.join(root, 'clawchat/liveware/liveware'), root === old ? 'old' : 'new');
  }
  fs.writeFileSync(path.join(old, 'clawchat/nora-profile.json'), 'profile receipt');
  fs.writeFileSync(path.join(old, 'nora-instance.json'), 'instance binding');
  await update.restoreUserHome(old, next);
  assert.equal(fs.readFileSync(path.join(next, '.env'), 'utf8'), 'test-only-key-and-pairing');
  assert.equal(fs.readFileSync(path.join(next, 'SOUL.md'), 'utf8'), 'custom soul');
  assert.equal(fs.readFileSync(path.join(next, 'nora-instance.json'), 'utf8'), 'instance binding');
  assert.equal(fs.readFileSync(path.join(next, 'clawchat/nora-profile.json'), 'utf8'), 'profile receipt');
  for (const file of ['hermes-agent/core', 'plugins/clawchat/plugin.py', 'clawchat/liveware/liveware']) {
    assert.equal(fs.readFileSync(path.join(next, file), 'utf8'), 'new');
  }
});
