const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { testBuild, prepareTestPayload } = require('../installer/desktop/test-build');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};

test('production metadata cannot enable candidate installs', async () => {
  assert.equal(testBuild({}), null);
  assert.throws(() => testBuild({ noraLocalTest: { schema: 1, buildId: '../escape' } }));
  await assert.rejects(prepareTestPayload('/unused', null, '0.2.0'), /明确标识/);
});

test('local candidate is hash pinned; changed content fails closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-test-build-'));
  try {
    const names = ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz',
      'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz', 'nora-hermes-runtime.json',
      'nora-tavern-dependencies.json', 'nora-tavern-first-install-bootstrap.py'];
    const files = {};
    for (const name of names) {
      const bytes=name==='release-manifest.json'?JSON.stringify({launcherCapabilities:capabilities}):'fixture';
      fs.writeFileSync(path.join(root, name), bytes);
      files[name] = { size:Buffer.byteLength(bytes), sha256: digest(bytes) };
    }
    const manifest = JSON.stringify({ schema: 'nora-system/v1', candidate: true, platform: process.platform,
      arch: process.arch,launcherCapabilities:capabilities, minimumLauncherVersion: '0.2.0', files });
    fs.writeFileSync(path.join(root, 'nora-system.json'), manifest);
    const build = testBuild({ noraLocalTest: { schema: 1, buildId: 'test-1', systemManifestSha256: digest(manifest) } });
    assert.equal(await prepareTestPayload(root, build, '0.2.0'), root);
    fs.writeFileSync(path.join(root, names[0]), 'changed');
    await assert.rejects(prepareTestPayload(root, build, '0.2.0'), /文件校验失败/);
    fs.appendFileSync(path.join(root, 'nora-system.json'), ' ');
    await assert.rejects(prepareTestPayload(root, build, '0.2.0'), /清单校验失败/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a hash pinned candidate with an old or mismatched writer is rejected without executing it',async t=>{
  for(const layer of ['system','payload'])for(const value of [undefined,{...capabilities,executorProtocol:'old'}]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-candidate-protocol-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const payload=JSON.stringify({launcherCapabilities:layer==='payload'?value:capabilities}),files={};
    for(const name of ['release-manifest.json','SHA256SUMS','nora-tavern-app.tar.gz','nora-tavern-ops.tar.gz','nora-tavern-nora-mcp.tar.gz',
      'nora-hermes-runtime.json','nora-tavern-dependencies.json','nora-tavern-first-install-bootstrap.py']){
      const bytes=name==='release-manifest.json'?payload:'fixture';fs.writeFileSync(path.join(root,name),bytes);files[name]={size:Buffer.byteLength(bytes),sha256:digest(bytes)};
    }
    const manifest=JSON.stringify({schema:'nora-system/v1',candidate:true,platform:process.platform,arch:process.arch,minimumLauncherVersion:'0.2.0',
      launcherCapabilities:layer==='system'?value:capabilities,files});fs.writeFileSync(path.join(root,'nora-system.json'),manifest);
    const build=testBuild({noraLocalTest:{schema:1,buildId:'protocol',systemManifestSha256:digest(manifest)}});
    await assert.rejects(prepareTestPayload(root,build,'0.2.0'),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
  }
});
