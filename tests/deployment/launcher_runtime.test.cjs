const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { findBundledRuntime, installBundledHermes } = require('../installer/desktop/runtime');
const { makePlan, cleanup } = require('../installer/desktop/uninstall');
const componentFixture = {
  componentProbe: 'nora-clawchat-check.py',
  components: { clawchat: { revision: 'a'.repeat(40) }, liveware: { sha256: 'b'.repeat(64) }, files: {} },
};

test('copy failure remains primary when rollback and temp cleanup also fail', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-runtime-errors-'));
  const originalRm = fs.rmSync;
  try {
    const payload = path.join(root, 'payload');
    const source = path.join(root, 'source/hermes-runtime/hermes-agent/skills/apple');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'fixture');
    fs.mkdirSync(payload);
    const archive = path.join(payload, 'runtime.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', path.join(root, 'source'), 'hermes-runtime']).status, 0);
    fs.writeFileSync(path.join(payload, 'nora-hermes-runtime.json'), JSON.stringify({
      ...componentFixture, schema: 1, platform: process.platform, arch: process.arch,
      archive: 'runtime.tar.gz', sha256: sha256(archive), nodeLinks: {},
    }));
    const home = path.join(root, 'home');
    const primary = Object.assign(new Error('original copy failure'), { code: 'EPERM', syscall: 'symlink' });
    t.mock.method(fs, 'cpSync', () => { throw primary; });
    t.mock.method(fs, 'rmSync', () => { throw new Error('cleanup failure'); });
    assert.throws(() => installBundledHermes({ payloadRoot: payload, noraHome: home, hermesHome: path.join(home, 'hermes') }), error => {
      assert.equal(error, primary);
      assert.equal(error.context.operation, 'copy-skill');
      assert.ok(error.context.destination.endsWith(path.join('skills', 'apple')));
      assert.deepEqual(error.secondaryErrors.map(item => item.operation), ['rollback', 'cleanup']);
      return true;
    });
  } finally {
    t.mock.restoreAll();
    originalRm(root, { recursive: true, force: true });
  }
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('installs, relocates, and validates a bundled Hermes runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-runtime-test-'));
  try {
    const payload = path.join(root, 'payload');
    const source = path.join(root, 'source', 'hermes-runtime');
    const bin = path.join(source, 'hermes-agent', 'venv', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(source, 'node', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'node/bin/node'), '#!/bin/sh\necho npm-fixture\n', { mode: 0o755 });
    const probe = path.join(bin, 'hermes');
    fs.writeFileSync(probe, '#!/bin/sh\n# @@NORA_HERMES_HOME@@\necho Hermes-test\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'python'), '#!/bin/sh\necho component-probe-fixture\n', { mode: 0o755 });
    fs.writeFileSync(path.join(source, 'nora-clawchat-check.py'), '# fixture\n');
    fs.writeFileSync(path.join(bin, 'relocate-me'), '@@NORA_HERMES_HOME@@\n');
    fs.mkdirSync(payload, { recursive: true });
    const archive = path.join(payload, 'runtime.tar.gz');
    const packed = spawnSync('tar', ['-czf', archive, '-C', path.dirname(source), 'hermes-runtime']);
    assert.equal(packed.status, 0);
    const manifest = {
      ...componentFixture,
      schema: 1,
      platform: process.platform,
      arch: process.arch,
      format: 'tar.gz',
      archive: path.basename(archive),
      sha256: sha256(archive),
      venvPython: 'hermes-agent/venv/bin/python',
      nodeBin: 'node/bin',
      nodeLinks: {},
      probe: { command: 'hermes-agent/venv/bin/hermes', args: ['--version'] },
      relocatableFiles: ['hermes-agent/venv/bin/hermes', 'hermes-agent/venv/bin/relocate-me'],
    };
    fs.writeFileSync(path.join(payload, 'nora-hermes-runtime.json'), JSON.stringify(manifest));

    const noraHome = path.join(root, 'NoraTavern');
    const hermesHome = path.join(noraHome, 'hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(path.join(hermesHome, 'partial'), 'old');
    const events = [];
    const result = installBundledHermes({ payloadRoot: payload, noraHome, hermesHome, onEvent: (event) => events.push(event) });

    assert.equal(result.version, 'Hermes-test');
    assert.equal(findBundledRuntime(payload).manifest.sha256, manifest.sha256);
    assert.equal(fs.readFileSync(path.join(hermesHome, 'hermes-agent/venv/bin/relocate-me'), 'utf8'), `${hermesHome}\n`);
    assert.ok(fs.existsSync(path.join(hermesHome, 'hermes-agent/.hermes-bootstrap-complete')));
    assert.ok(fs.existsSync(path.join(hermesHome, '.env')));
    assert.ok(fs.readdirSync(path.join(noraHome, 'installer/backups')).some((name) => name.startsWith('hermes-partial-')));
    assert.deepEqual(events.map((event) => event.current), [1, 2, 3]);
    fs.writeFileSync(path.join(hermesHome, '.env'), 'RETAINED_TEST_SETTING=1\n');
    fs.mkdirSync(path.join(hermesHome, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(hermesHome, 'memories/MEMORY.md'), 'retained memory');
    cleanup(makePlan({ home: noraHome, hermesHome, installRoot: path.join(noraHome, 'tavern'), mode: 'keep' }));
    assert.equal(fs.existsSync(probe), true, 'payload fixture is outside managed home');
    const reinstalled = installBundledHermes({ payloadRoot: payload, noraHome, hermesHome });
    assert.equal(reinstalled.version, 'Hermes-test');
    assert.equal(fs.readFileSync(path.join(hermesHome, '.env'), 'utf8'), 'RETAINED_TEST_SETTING=1\n');
    assert.equal(fs.readFileSync(path.join(hermesHome, 'memories/MEMORY.md'), 'utf8'), 'retained memory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a runtime archive whose checksum changed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-runtime-checksum-'));
  try {
    const payload = path.join(root, 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'runtime.tar.gz'), 'broken');
    fs.writeFileSync(path.join(payload, 'nora-hermes-runtime.json'), JSON.stringify({
      ...componentFixture,
      schema: 1,
      platform: process.platform,
      arch: process.arch,
      format: 'tar.gz',
      archive: 'runtime.tar.gz',
      sha256: '0'.repeat(64),
    }));
    assert.throws(() => installBundledHermes({
      payloadRoot: payload,
      noraHome: path.join(root, 'home'),
      hermesHome: path.join(root, 'home/hermes'),
    }), /安装包可能不完整/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed extraction preserves the existing Hermes home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-runtime-preserve-'));
  try {
    const payload = path.join(root, 'payload');
    const home = path.join(root, 'home/hermes');
    fs.mkdirSync(payload, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'keep.txt'), 'existing user data');
    const archive = path.join(payload, 'runtime.tar.gz');
    fs.writeFileSync(archive, 'not an archive');
    fs.writeFileSync(path.join(payload, 'nora-hermes-runtime.json'), JSON.stringify({
      ...componentFixture,
      schema: 1, platform: process.platform, arch: process.arch, format: 'tar.gz',
      archive: 'runtime.tar.gz', sha256: sha256(archive),
    }));
    assert.throws(() => installBundledHermes({ payloadRoot: payload, noraHome: path.join(root, 'home'), hermesHome: home }), /无法释放/);
    assert.equal(fs.readFileSync(path.join(home, 'keep.txt'), 'utf8'), 'existing user data');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
