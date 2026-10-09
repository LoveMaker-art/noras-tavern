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

test('telemetry loads from the declared desktop package without borrowing source files',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-packaged-telemetry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const desktop=path.resolve(__dirname,'../installer/desktop'),pkg=require(path.join(desktop,'package.json'));
  for(const name of pkg.build.files){
    const source=path.join(desktop,name);
    if(fs.existsSync(source)&&fs.statSync(source).isFile())fs.copyFileSync(source,path.join(root,name));
  }
  const {createTelemetry}=require(path.join(root,'telemetry.js'));
  const client=createTelemetry({file:path.join(root,'outbox.json'),launcherVersion:'2.0.2',automatic:false});
  t.after(()=>client.close());
  assert.match(client.begin('install'),/^[a-f0-9-]{36}$/);
});
test('release transport and trusted roots load from the declared package without source-tree dependencies',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-packaged-sources-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const desktop=path.resolve(__dirname,'../installer/desktop'),pkg=require(path.join(desktop,'package.json'));
  for(const name of pkg.build.files){
    const source=path.join(desktop,name);
    if(fs.existsSync(source)&&fs.statSync(source).isFile())fs.copyFileSync(source,path.join(root,name));
  }
  assert.equal(typeof require(path.join(root,'release-network')).downloadAsset,'function');
  const {sourceCandidates}=require(path.join(root,'release-sources'));
  const candidates=sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest');
  assert.equal(candidates[0].id,'github');
  assert.equal(candidates.at(-1).id,'sourceforge');
  assert.ok(!candidates.some(item=>/example/.test(item.url)));
});

test('both package configurations and the sealed system carry the shared evidence budget',async()=>{
  const pkg=require('../installer/desktop/package.json');
  const {OPERATION_BUDGET,DEFAULT_LIMITS}=require('../installer/desktop/evidence-store');
  const {RESOURCE_NAMES}=require('../installer/desktop/launcher-capability');
  const {NORA_SYSTEM_REQUIRED_FILES}=await import('../scripts/release-source.mjs');
  for(const platform of ['mac','win']){
    const resources=pkg.build[platform].extraResources||pkg.build.extraResources;
    const entry=resources.find(resource=>resource.to==='operation-budget.json');
    assert.ok(entry,platform+' package resource is required');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.resolve(__dirname,'../installer/desktop',entry.from),'utf8')),OPERATION_BUDGET);
    const replacement=resources.find(resource=>resource.to==='replace-launcher.py');
    assert.ok(replacement);assert.ok(fs.existsSync(path.resolve(__dirname,'../installer/desktop',replacement.from)));
  }
  assert.ok(RESOURCE_NAMES.includes('operation-budget.json'));
  assert.ok(RESOURCE_NAMES.includes('replace-launcher.py'));
  assert.ok(NORA_SYSTEM_REQUIRED_FILES.includes('ops/installer/operation-budget.json'));
  assert.equal(DEFAULT_LIMITS.historyCapacity,4096+4);
  assert.equal(DEFAULT_LIMITS.ackCapacity,4096);
  assert.equal(DEFAULT_LIMITS.globalBytes-DEFAULT_LIMITS.historyCapacity*DEFAULT_LIMITS.ackCapacity,50315264);
});

test('recovery and diagnostics ship independently of the installed runtime and with the incremental updater runner', async () => {
  const pkg = require('../installer/desktop/package.json');
  for (const name of ['update_recovery.py', 'error_diagnostics.py']) {
    const entry = pkg.build.extraResources.find(item => item.to === name);
    assert.ok(entry, 'the desktop must recover and diagnose even when the installed ops directory is absent');
    assert.ok(fs.existsSync(path.resolve(__dirname, '../installer/desktop', entry.from)));
  }
  const { groupRuntimeModules } = await import('../scripts/release-source.mjs');
  const modules = groupRuntimeModules(['ops/updater/update.py', 'ops/installer/update_recovery.py', 'ops/installer/error_diagnostics.py']);
  assert.deepEqual(modules.get('updater'), ['ops/installer/error_diagnostics.py', 'ops/installer/update_recovery.py', 'ops/updater/update.py']);
  assert.equal(modules.size, 1, 'extract_runner downloads one verified updater module');
});

test('Mac and Windows packages use the high-resolution Nora icon', () => {
  const pkg = require('../installer/desktop/package.json');
  for (const platform of ['mac', 'win']) {
    const icon = pkg.build[platform].icon || pkg.build.icon;
    assert.equal(icon, '../assets/nora-launcher-portrait.png');
    const bytes = fs.readFileSync(path.resolve(__dirname, '../installer/desktop', icon));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    assert.ok(bytes.readUInt32BE(16) >= 512, 'packaging needs a full-resolution icon, not the small favicon');
  }
  const main = fs.readFileSync(path.resolve(__dirname, '../installer/desktop/main.js'), 'utf8');
  assert.ok(main.includes("icon: path.join(installerRoot(), 'assets', 'tavern-icon-dbf4ecbd54ec.png')"));
});

test('full Nora packaging requires every managed initialization artifact', async () => {
  const { assertNoraSystemArtifacts, NORA_SYSTEM_REQUIRED_FILES } = await import('../scripts/release-source.mjs');
  assert.doesNotThrow(() => assertNoraSystemArtifacts(NORA_SYSTEM_REQUIRED_FILES));
  for (const omitted of NORA_SYSTEM_REQUIRED_FILES) {
    assert.throws(() => assertNoraSystemArtifacts(NORA_SYSTEM_REQUIRED_FILES.filter(file => file !== omitted)),
      /Incomplete Nora system artifacts/);
  }
});

test('unpublished candidate launchers install their sealed payload instead of an older online beta', async () => {
  const { writeSystemRelease, configureCandidateLauncher } = await import('../scripts/system-release.mjs');
  const { testBuild, prepareTestPayload } = require('../installer/desktop/test-build');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-candidate-contract-'));
  try {
    const payload = path.join(root, 'payload');
    const packageFile = path.join(root, 'package.json');
    fs.mkdirSync(payload);
    for (const name of ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz',
      'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz', 'nora-hermes-runtime.json',
      'nora-tavern-dependencies.json', 'nora-tavern-first-install-bootstrap.py']) {
      fs.writeFileSync(path.join(payload, name), 'fixture');
    }
    const identity = { launcherCapabilities: {operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2}, candidate: true, commit: 'a'.repeat(40), versions: { tavern: '2.2.10-beta.5' },
      hermesRuntime: { platform: process.platform, arch: process.arch } };
    const pkg = { ...require('../installer/desktop/package.json'), noraReleaseChannel: 'beta',
      noraTestInstallationId: 'candidate-38e8e898aecc' };
    fs.writeFileSync(packageFile, JSON.stringify(pkg));
    fs.writeFileSync(path.join(payload, 'release-manifest.json'), JSON.stringify(identity));
    writeSystemRelease({ release: root, payload, identity, launcherVersion: pkg.version, minimumLauncherVersion: pkg.version });
    configureCandidateLauncher({ packageFile, payload, identity });
    const result = JSON.parse(fs.readFileSync(packageFile));
    assert.equal(result.noraReleaseChannel, undefined, 'beta channel must not override isolated test home');
    assert.equal(result.build.appId, 'art.lovemaker.nora-tavern-launcher.local-test');
    assert.equal(result.build.icon, pkg.build.icon);
    assert.equal(result.noraLocalTest.buildId, 'candidate-38e8e898aecc', 'Beta.6 must reuse the Beta.5 installation directory');
    assert.equal(result.noraLocalTest.telemetryEnabled, undefined, 'ordinary candidates do not upload');
    assert.equal(await prepareTestPayload(payload, testBuild(result), result.version), payload);
    const nextIdentity = { ...identity, commit: 'b'.repeat(40) };
    writeSystemRelease({ release: root, payload, identity: nextIdentity, launcherVersion: pkg.version, minimumLauncherVersion: pkg.version });
    configureCandidateLauncher({ packageFile, payload, identity: nextIdentity });
    assert.equal(JSON.parse(fs.readFileSync(packageFile)).noraLocalTest.buildId, result.noraLocalTest.buildId);
    fs.writeFileSync(packageFile, JSON.stringify({ ...pkg, noraTestInstallationId: '../outside' }));
    assert.throws(() => configureCandidateLauncher({ packageFile, payload, identity: nextIdentity }), /installation identity/);
    fs.writeFileSync(packageFile, JSON.stringify(pkg));
    configureCandidateLauncher({ packageFile, payload, identity: { ...identity, candidate: false } });
    assert.deepEqual(JSON.parse(fs.readFileSync(packageFile)), pkg, 'published packages keep online updates');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a reporting candidate keeps payload verification and selects a separate installation home', async () => {
  const { writeSystemRelease, configureCandidateLauncher } = await import('../scripts/system-release.mjs');
  const { testBuild, prepareTestPayload } = require('../installer/desktop/test-build');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-reporting-candidate-'));
  try {
    const payload = path.join(root, 'payload'), packageFile = path.join(root, 'package.json');
    fs.mkdirSync(payload);
    for (const name of ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz',
      'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz', 'nora-hermes-runtime.json',
      'nora-tavern-dependencies.json', 'nora-tavern-first-install-bootstrap.py']) {
      fs.writeFileSync(path.join(payload, name), 'fixture');
    }
    const identity = { launcherCapabilities: {operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2}, candidate: true, commit: 'a'.repeat(40), versions: { tavern: '2.3.17' },
      hermesRuntime: { platform: process.platform, arch: process.arch } };
    const pkg = require('../installer/desktop/package.json');
    fs.writeFileSync(packageFile, JSON.stringify(pkg));
    fs.writeFileSync(path.join(payload, 'release-manifest.json'), JSON.stringify(identity));
    writeSystemRelease({ release: root, payload, identity, launcherVersion: pkg.version, minimumLauncherVersion: pkg.version });
    configureCandidateLauncher({ packageFile, payload, identity, telemetryEnabled: true });
    const metadata = JSON.parse(fs.readFileSync(packageFile));
    assert.equal(metadata.noraLocalTest.telemetryEnabled, true);
    assert.equal(metadata.noraLocalTest.buildId, `candidate-${'a'.repeat(12)}-telemetry`);
    assert.equal(await prepareTestPayload(payload, testBuild(metadata), pkg.version), payload);
    assert.throws(() => testBuild({ ...metadata, noraLocalTest: { ...metadata.noraLocalTest, telemetryEnabled: 'true' } }), /标识无效/);
    fs.writeFileSync(path.join(payload, 'nora-tavern-app.tar.gz'), 'corrupt');
    await assert.rejects(prepareTestPayload(payload, testBuild(metadata), pkg.version), /校验失败/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
