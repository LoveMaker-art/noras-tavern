const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createLocalRelease } = require('../installer/desktop/local-release');
const releases = require('../installer/desktop/releases');

test('local acceptance uses production check, plan and verified component download', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-local-release-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  const manifest = { schema: 'tavern-release/v2', commit: 'a'.repeat(40),launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2}, versions: { tavern: '2.3.8' },
    bootstrap: { managedComponents: 1, sha256: sha('bootstrap') } };
  const files = { 'release-manifest.json': JSON.stringify(manifest),
    'tavern-updater-bootstrap.py': 'bootstrap', 'nora-tavern-module-updater.tar.gz': 'module' };
  files.SHA256SUMS = Object.entries(files).map(([name, data]) => `${sha(data)}  ${name}`).join('\n');
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(root, name), data);
  const fetcher = createLocalRelease(root);
  const installRoot = path.join(root, 'installed');
  fs.mkdirSync(path.join(installRoot, 'tavern-updates'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.3.6' }));
  assert.equal((await releases.check({ installRoot, launcherVersion: '1.0.1', fetcher })).state, 'available');
  const options = { cacheRoot: path.join(root, 'cache'), launcherVersion: '1.0.1', fetcher,
    plan: async () => ({ version: '2.3.8', archives: [{ name: 'nora-tavern-module-updater.tar.gz', sha256: sha('module') }] }) };
  const prepared = await releases.prepareUpdate(options);
  assert.equal(fs.readFileSync(path.join(prepared, 'nora-tavern-module-updater.tar.gz'), 'utf8'), 'module');
  await assert.rejects(fetcher('https://example.com/anything'), /unexpected URL/);
  fs.writeFileSync(path.join(root, 'nora-tavern-module-updater.tar.gz'), 'corrupt');
  await assert.rejects(releases.prepareUpdate({ ...options, cacheRoot: path.join(root, 'other-cache') }), /校验失败/);
});

test('local acceptance maps only exact configured domestic catalogues and sealed filenames',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-local-domestic-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify({versions:{tavern:'2.4.6'}}));
  fs.writeFileSync(path.join(root,'module.zip'),'sealed bytes');
  const base='https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/';
  const channelBase='https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/';
  const fetcher=createLocalRelease(root,{sources:{schema:1,primary:'jihulab',mirrors:[
    {id:'jihulab',provider:'jihulab',baseUrl:base,channelBaseUrl:channelBase}]}});
  assert.equal((await (await fetcher(channelBase+'channels/stable.json')).json()).tag_name,'v2.4.6');
  assert.equal((await (await fetcher(base+'v2.4.6/release.json')).json()).tag_name,'v2.4.6');
  const response=await fetcher(base+'v2.4.6/module.zip');
  assert.equal(response.url,base+'v2.4.6/module.zip');
  assert.equal(await response.text(),'sealed bytes');
  for(const url of [base+'v2.4.5/module.zip',base+'v2.4.6/module.zip?other=1',
    'https://example.com/v2.4.6/module.zip',base+'v2.4.6/unsealed.zip'])
    await assert.rejects(fetcher(url),/unexpected URL/);
});

test('one local acceptance directory keeps old core discovery flat and adds an APP-only child catalogue without changing bytes',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-local-split-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const core={versions:{tavern:'2.5.3'},commit:'a'.repeat(40)},app={...core,commit:'b'.repeat(40),publication:{schema:'nora-component-publication/1',tag:'v2.5.4'}};
  fs.writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify(core));fs.writeFileSync(path.join(root,'core.tar.gz'),'original core bytes');
  const child=path.join(root,'launcher-stable');fs.mkdirSync(child);fs.writeFileSync(path.join(child,'release-manifest.json'),JSON.stringify(app));fs.writeFileSync(path.join(child,'app.zip'),'actual APP bytes');
  const transport=createLocalRelease(root),api='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases';
  assert.equal((await(await transport(api+'/latest')).json()).tag_name,'v2.5.3');
  const list=await(await transport(api+'?per_page=100&page=1')).json();assert.equal(list[0].tag_name,'v2.5.4');
  assert.equal(await(await transport('https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.5.3/core.tar.gz')).text(),'original core bytes');
  assert.equal(await(await transport('https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.5.4/app.zip')).text(),'actual APP bytes');
  await assert.rejects(transport('https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.5.4/core.tar.gz'),/unexpected URL/);
});
