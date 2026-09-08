const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findBundledRuntime, validateRuntimeLinks } = require('../installer/desktop/runtime');

test('Windows runtime extraction uses native tar directly with literal paths', () => {
  const { extractionCommand } = require('../installer/desktop/runtime');
  assert.deepEqual(extractionCommand('D:\\release dir\\runtime.zip', 'C:\\Users\\Test User\\Nora',
    'win32', 'C:\\Windows'), {
    file: 'C:\\Windows\\System32\\tar.exe',
    args: ['-xf', 'D:\\release dir\\runtime.zip', '-C', 'C:\\Users\\Test User\\Nora'],
  });
});

test('relocated Windows Python source never contains unescaped user-directory backslashes', () => {
  const { relocateText } = require('../installer/desktop/runtime');
  const text = relocateText("MAPPING = {'hermes': '@@NORA_HERMES_HOME@@/hermes-agent'}",
    'C:\\Users\\Test User\\Nora', { platform: 'win32', venvPython: 'hermes-agent/venv/Scripts/python.exe' });
  assert.equal(text, "MAPPING = {'hermes': 'C:/Users/Test User/Nora/hermes-agent'}");
});

test('Windows builds use native tar and Node npm CLI without shell path conversion', async () => {
  const { buildCommand } = await import('../scripts/build-commands.mjs');
  const options = { platform: 'win32', executable: 'C:\\Program Files\\nodejs\\node.exe', systemRoot: 'C:\\Windows' };
  assert.deepEqual(buildCommand('tar', ['-a', '-cf', 'D:\\release dir\\runtime.zip'], options), {
    command: 'C:\\Windows\\System32\\tar.exe', args: ['-a', '-cf', 'D:\\release dir\\runtime.zip'],
  });
  assert.deepEqual(buildCommand('npm', ['ci'], options), { command: options.executable,
    args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'ci'] });
  assert.deepEqual(buildCommand('zip', ['-qry', 'launcher.zip', 'launcher'], options), {
    command: 'C:\\Windows\\System32\\tar.exe', args: ['-a', '-cf', 'launcher.zip', 'launcher'],
  });
});

test('desktop bundle carries the profile initializer beside the bridge', () => {
  const pkg = require('../installer/desktop/package.json');
  const entry = pkg.build.extraResources.find(item => item.to === 'nora_profile.py');
  assert.ok(entry);
  assert.ok(fs.existsSync(path.resolve(__dirname, '../installer/desktop', entry.from)));
});

test('full Nora packaging requires every managed initialization artifact', async () => {
  const { assertNoraSystemArtifacts, NORA_SYSTEM_REQUIRED_FILES } = await import('../scripts/release-source.mjs');
  assert.doesNotThrow(() => assertNoraSystemArtifacts(NORA_SYSTEM_REQUIRED_FILES));
  for (const omitted of NORA_SYSTEM_REQUIRED_FILES) {
    assert.throws(() => assertNoraSystemArtifacts(NORA_SYSTEM_REQUIRED_FILES.filter(file => file !== omitted)),
      /Incomplete Nora system artifacts/);
  }
});

test('rejects legacy Hermes-only bundles before extracting or changing user data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-bundle-contract-'));
  try {
    fs.writeFileSync(path.join(root, 'runtime.tar.gz'), 'fixture');
    fs.writeFileSync(path.join(root, 'nora-hermes-runtime.json'), JSON.stringify({
      schema: 1, platform: process.platform, arch: process.arch, archive: 'runtime.tar.gz',
    }));
    assert.throws(() => findBundledRuntime(root), /ClawChat/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects runtime links that still depend on the build machine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-bundle-links-'));
  try {
    fs.symlinkSync(process.execPath, path.join(root, 'python'));
    assert.throws(() => validateRuntimeLinks(root), /安装目录之外/);
    fs.unlinkSync(path.join(root, 'python'));
    fs.writeFileSync(path.join(root, 'internal'), 'fixture');
    fs.symlinkSync('internal', path.join(root, 'python'));
    assert.doesNotThrow(() => validateRuntimeLinks(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
