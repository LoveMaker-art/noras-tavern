const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/verify-launcher-release.cjs');
const capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
const publisher=()=>import(pathToFileURL(path.resolve(__dirname,'../../tooling/release/publish-release.mjs')));

function publication(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sourceforge-publish-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const tag='v2.4.3',channel='stable';
  const objects=[['asset','releases/'+tag+'/asset.zip','sealed asset'],['catalogue','releases/'+tag+'/release.json','{}'],['channel','channels/stable.json','{}']].map(([phase,key,body],index)=>{
    const file=path.join(root,String(index));fs.writeFileSync(file,body);
    return {phase,key,file,size:Buffer.byteLength(body),sha256:crypto.createHash('sha256').update(body).digest('hex')};
  });
  return {output:root,plan:{tag,channel,objects}};
}
test('SourceForge channel is uploaded only after every immutable object was publicly verified',async t=>{
  const distribution=publication(t),events=[];
  const {publishDistribution}=await publisher();
  await publishDistribution(distribution,{upload:async(object,options)=>events.push(['upload',object.phase,options.immutable]),
    verify:async object=>events.push(['verify',object.phase]),fetcher:async()=>new Response(null,{status:404})});
  assert.deepEqual(events,[['upload','asset',true],['verify','asset'],['upload','catalogue',true],['verify','catalogue'],['upload','channel',false],['verify','channel']]);
});
test('missing public bytes, altered sealed bytes and a newer channel all prevent channel promotion',async t=>{
  const {publishDistribution}=await publisher();
  for(const failure of ['verification','altered','newer','phase'])await t.test(failure,async child=>{
    const distribution=publication(child),uploaded=[];
    if(failure==='altered')fs.writeFileSync(distribution.plan.objects[0].file,'changed');
    if(failure==='phase')distribution.plan.objects[0].phase='channel';
    await assert.rejects(publishDistribution(distribution,{upload:async object=>uploaded.push(object.phase),verify:async()=>{if(failure==='verification')throw Error('object missing');},
      fetcher:async()=>Response.json({tag_name:'v2.4.4',draft:false,prerelease:false})}));
    assert.ok(!uploaded.includes('channel'));
    if(['altered','phase'].includes(failure))assert.equal(uploaded.length,0);
  });
});
test('public SourceForge verification checks all bytes and the expected digest',async t=>{
  const {verifyDistributionObject}=await publisher(),object=publication(t).plan.objects[0];
  await verifyDistributionObject(object,{fetcher:async()=>new Response(fs.readFileSync(object.file))});
  await assert.rejects(verifyDistributionObject(object,{fetcher:async()=>new Response('wrong')}),/Incomplete|Different/);
  const wrong=Buffer.alloc(object.size);
  await assert.rejects(verifyDistributionObject(object,{fetcher:async()=>new Response(wrong)}),/Different/);
});
test('stalled public verification stops at the idle deadline instead of hanging a publication',async t=>{
  const {verifyDistributionObject}=await publisher(),object=publication(t).plan.objects[0];
  await assert.rejects(verifyDistributionObject(object,{idleTimeout:20,fetcher:async()=>new Response(new ReadableStream({start(){}}))}),/verification stalled/);
});
test('SourceForge upload pins SSH identity and host trust, preserves immutable objects and cleans staging',async t=>{
  const {sourceforgeUploader}=await publisher(),distribution=publication(t),root=distribution.output;
  const identity=path.join(root,"key with 'quote'"),hosts=path.join(root,'known hosts'),config=path.join(root,'publisher.json');
  fs.writeFileSync(identity,'test fixture',{mode:0o600});fs.writeFileSync(hosts,'test fixture');
  fs.writeFileSync(config,JSON.stringify({project:'nora-tavern',username:'sorrymakerx',identityFile:identity,knownHostsFile:hosts}),{mode:0o600});
  if(process.platform==='win32'){
    assert.throws(()=>sourceforgeUploader(config,root),/private/);return;
  }
  const calls=[],upload=sourceforgeUploader(config,root,{execute:(command,args)=>{
    calls.push({command,args});assert.equal(command,'rsync');
    assert.match(args[args.indexOf('-e')+1],/StrictHostKeyChecking=yes/);
    assert.match(args[args.indexOf('-e')+1],/UserKnownHostsFile=/);
    assert.deepEqual(fs.readFileSync(args.at(-2).replace('/./','/')),fs.readFileSync(distribution.plan.objects[calls.length===1?0:2].file));
  }});
  await upload(distribution.plan.objects[0],{immutable:true});await upload(distribution.plan.objects[2],{immutable:false});
  assert.ok(calls[0].args.includes('--ignore-existing'));assert.ok(!calls[1].args.includes('--ignore-existing'));
  assert.equal(fs.readdirSync(root).filter(name=>name.startsWith('.sourceforge-upload-')).length,0);
  fs.chmodSync(config,0o644);assert.throws(()=>sourceforgeUploader(config,root),/private/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-publish-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commit = 'a'.repeat(40);
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  const release = { version: '2.2.11', versions: { tavern: '2.2.11' }, launcherVersion: '2.1.0',
    bootstrap: { minimumLauncherVersion: '2.1.0' },launcherCapabilities:capabilities, commit, candidate: false, archives: {}, modules: {} };
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const [system, arch] = platform.split('-');
    const files = {};
    const component = (name, value) => {
      const asset = `${platform}-${name}`;
      write(asset, value);
      const bytes = fs.readFileSync(path.join(root, asset));
      files[name] = { asset, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    };
    component('payload.json', {});
    component('release-manifest.json', release);
    for (const name of ['nora-hermes-runtime', 'nora-tavern-dependencies']) {
      const archive = `${name}.tar.gz`;
      component(archive, {});
      component(`${name}.json`, { platform: system, arch, archive, sha256: files[archive].sha256 });
    }
    write(`nora-system-${platform}.json`, {
      version: '2.2.11', commit, candidate: false, channel: 'stable', platform: system, arch,
      launcherVersion: release.launcherVersion, minimumLauncherVersion: release.bootstrap.minimumLauncherVersion,
      launcherCapabilities:capabilities,
      files,
    });
    write(`Nora-Tavern-package-verification-${platform}.json`, {
      version: '2.2.11', commit, nativeIcon: true, instructions: { 'ops/installer/templates/greeting.md': 'verified' },
    });
    write(`Nora-Tavern-Launcher-2.1.0-${system === 'darwin' ? 'mac' : 'win'}-${arch}${system === 'darwin' ? '.dmg' : '-setup.exe'}`, {});
    const asset = `Nora-Tavern-Launcher-2.1.0-${platform}-update.zip`;
    write(asset, {});
    write(`nora-launcher-${platform}.json`, { schema: 'nora-launcher/v1', candidate: false, version: '2.1.0',
      commit, platform: system, arch, asset, size: 2, sha256: crypto.createHash('sha256').update('{}').digest('hex') });
  }
  write('release-manifest.json', release);
  return { root, run: () => spawnSync(process.execPath, [script, root, 'v2.2.11', commit], { encoding: 'utf8' }) };
}
test('complete stable release passes and produces asset checksums', t => {
  const { root, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'LAUNCHER-SHA256SUMS'), 'utf8'), /win-x64-setup.exe/);
});
test('distribution preparation publishes canonical identities only after verified resource closure',async t=>{
  const {root}=fixture(t),output=root+'.distribution';t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const {prepareDistribution}=await publisher();
  const result=await prepareDistribution({root,tag:'v2.2.11',commit:'a'.repeat(40),output,body:'修复安装问题。',publishedAt:'2026-10-08T00:00:00Z'});
  assert.equal(result.plan.publishChannelAfter,'all_objects_verified');
  assert.equal(result.plan.objects.at(-1).phase,'channel');
  assert.equal(result.plan.objects.at(-2).key,'releases/v2.2.11/release.json');
  assert.ok(result.plan.objects.slice(0,-2).every(item=>item.phase==='asset'));
  for(const item of result.plan.objects) {
    const bytes=fs.readFileSync(item.file);
    assert.equal(item.size,bytes.length);assert.equal(item.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  const channel=JSON.parse(fs.readFileSync(path.join(output,'channels/stable.json')));
  assert.deepEqual(channel,result.release);assert.equal(channel.tag_name,'v2.2.11');
  assert.equal(channel.body,'修复安装问题。');assert.equal(channel.published_at,'2026-10-08T00:00:00Z');
  assert.ok(channel.assets.every(item=>item.state==='uploaded'&&/^sha256:[a-f0-9]{64}$/.test(item.digest)));
  assert.ok(channel.assets.every(item=>item.browser_download_url===`https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.2.11/${item.name}`));
  assert.ok(channel.assets.some(item=>item.name==='nora-system-win32-x64.json'));
  assert.equal(fs.existsSync(path.join(root,'channels')),false);
  await assert.rejects(prepareDistribution({root,tag:'v2.2.11',commit:'a'.repeat(40),output}),/already exists/);
});
function sharedPublicationFixture(t) {
  const {root}=fixture(t),commit='a'.repeat(40),repository='LoveMaker-art/noras-tavern';
  const changeManifest=value=>{value.launcherVersion='2.1.2';if(value.bootstrap)value.bootstrap.minimumLauncherVersion='2.1.2';else value.minimumLauncherVersion='2.1.2';return value;};
  for(const name of fs.readdirSync(root))if(name.startsWith('Nora-Tavern-Launcher-2.1.0-'))fs.renameSync(path.join(root,name),path.join(root,name.replace('2.1.0','2.1.2')));
  for(const name of ['release-manifest.json',...['darwin-arm64','darwin-x64','win32-x64'].map(platform=>`${platform}-release-manifest.json`)]) {
    const file=path.join(root,name);fs.writeFileSync(file,JSON.stringify(changeManifest(JSON.parse(fs.readFileSync(file)))));
  }
  for(const platform of ['darwin-arm64','darwin-x64','win32-x64']) {
    const file=path.join(root,`nora-system-${platform}.json`),system=changeManifest(JSON.parse(fs.readFileSync(file))),payload=fs.readFileSync(path.join(root,`${platform}-release-manifest.json`));
    Object.assign(system.files['release-manifest.json'],{size:payload.length,sha256:crypto.createHash('sha256').update(payload).digest('hex')});fs.writeFileSync(file,JSON.stringify(system));
    const lightFile=path.join(root,`nora-launcher-${platform}.json`),light=JSON.parse(fs.readFileSync(lightFile));light.version='2.1.2';light.asset=light.asset.replace('2.1.0','2.1.2');fs.writeFileSync(lightFile,JSON.stringify(light));
  }
  const baseline={schema:'nora-reuse-baseline/1',repository,commit:'b'.repeat(40),release:{tag_name:'v2.2.10',draft:false,prerelease:false,
    assets:fs.readdirSync(root).map(name=>{const bytes=fs.readFileSync(path.join(root,name));return {name,state:'uploaded',size:bytes.length,
      digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex'),browser_download_url:`https://github.com/${repository}/releases/download/v2.2.10/${name}`};})}};
  return {root,commit,repository,baseline};
}
test('shared publication references identical older assets while current metadata stays under the new tag',async t=>{
  const f=sharedPublicationFixture(t),output=f.root+'.shared';t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const {prepareDistribution}=await publisher();
  const result=await prepareDistribution({...f,tag:'v2.2.11',output,assetMode:'shared',reuseFrom:f.baseline});
  const refs=result.plan.objects.filter(item=>item.reference);assert.ok(refs.length>0);
  assert.ok(refs.every(item=>item.key.startsWith('releases/v2.2.10/')&&item.sourceCommit==='b'.repeat(40)));
  assert.ok(!refs.some(item=>/nora-system-.*\.json|nora-launcher-.*\.json|release-manifest\.json|SHA256SUMS$/.test(path.basename(item.key))));
  const indexObject=result.plan.objects.find(item=>item.key==='releases/v2.2.11/release-assets.json'),index=JSON.parse(fs.readFileSync(indexObject.file));
  assert.equal(index.schema,'nora-release-assets/1');assert.equal(index.minimumLauncherVersion,'2.1.2');assert.equal(index.commit,f.commit);
  assert.equal(index.assets.length,refs.length);
  assert.ok(result.release.assets.some(item=>item.name==='release-assets.json'));
  assert.ok(refs.every(item=>!result.release.assets.some(asset=>asset.name===path.basename(item.key))));
  assert.ok(result.release.assets.every(item=>item.browser_download_url.includes('/v2.2.11/')));
  const client=require('../installer/desktop/releases');
  const expanded=await client.latest(async url=>{
    if(new URL(url).hostname==='api.github.com')return Response.json(result.release);
    const key='releases/'+new URL(url).pathname.split('/releases/download/')[1];
    const object=result.plan.objects.find(item=>item.key===key);assert.ok(object,`Unplanned client request ${url}`);return new Response(fs.readFileSync(object.file));
  });
  assert.equal(client.validateAssetReferences(expanded).commit,f.commit);
  for(const object of refs)assert.equal(client.assetUrl(expanded,path.basename(object.key)),`https://github.com/${f.repository}/releases/download/v2.2.10/${path.basename(object.key)}`);
  const stateModule=await import(pathToFileURL(path.resolve(__dirname,'../../tooling/release/publication-state.mjs')));
  const stateDir=f.root+'.state';t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  fs.mkdirSync(stateDir);fs.renameSync(output,path.join(stateDir,'distribution'));
  for(const object of result.plan.objects)if(object.file.startsWith(output))object.file=path.join(stateDir,'distribution',path.relative(output,object.file));
  const sealed=await stateModule.sealPublication(result,{root:f.root,stateDir,repository:f.repository,assetMode:'shared'});
  assert.equal(sealed.plan.assetMode,'shared');assert.equal(sealed.plan.objects.filter(item=>item.reference).length,refs.length);
});
test('old-client release and untrusted reuse baselines cannot activate shared publication',async t=>{
  const {prepareDistribution}=await publisher();
  for(const kind of ['old-client','future','foreign','draft'])await t.test(kind,async child=>{
    const f=kind==='old-client'?fixture(child):sharedPublicationFixture(child),output=f.root+'.shared';child.after(()=>fs.rmSync(output,{recursive:true,force:true}));
    const baseline=f.baseline||{schema:'nora-reuse-baseline/1',repository:'LoveMaker-art/noras-tavern',commit:'b'.repeat(40),release:{tag_name:'v2.2.10',draft:false,prerelease:false,assets:[]}};
    if(kind==='future')baseline.release.tag_name='v2.2.12';if(kind==='foreign')baseline.repository='elsewhere/other';if(kind==='draft')baseline.release.draft=true;
    await assert.rejects(prepareDistribution({root:f.root,tag:'v2.2.11',commit:'a'.repeat(40),output,assetMode:'shared',reuseFrom:baseline}));
    assert.equal(fs.existsSync(path.join(output,'channels/stable.json')),false);
  });
});
test('corrupt or linked release resources cannot generate an advertised channel',async t=>{
  const {prepareDistribution}=await publisher();
  for(const kind of ['corrupt','linked']) await t.test(kind,async child=>{
    const {root}=fixture(child),output=root+'.distribution';child.after(()=>fs.rmSync(output,{recursive:true,force:true}));
    const file=path.join(root,'darwin-arm64-payload.json');
    if(kind==='corrupt')fs.writeFileSync(file,'corrupt');
    else {fs.unlinkSync(file);fs.symlinkSync(path.join(root,'win32-x64-payload.json'),file);}
    await assert.rejects(prepareDistribution({root,tag:'v2.2.11',commit:'a'.repeat(40),output}));
    assert.equal(fs.existsSync(path.join(output,'channels/stable.json')),false);
  });
});
test('publication preserves sealed checksum bytes and uses a separate public asset index',async t=>{
  const {root}=fixture(t),output=root+'.distribution';t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const hash=crypto.createHash('sha256').update('{}').digest('hex');
  const checksum=`${hash}  darwin-arm64-payload.json\n${hash}  unpublished.zip\n`;
  fs.writeFileSync(path.join(root,'SHA256SUMS'),checksum);
  for(const platform of ['darwin-arm64','darwin-x64','win32-x64']) {
    const file=path.join(root,`nora-system-${platform}.json`),system=JSON.parse(fs.readFileSync(file));
    system.files.SHA256SUMS={asset:'SHA256SUMS',size:Buffer.byteLength(checksum),sha256:crypto.createHash('sha256').update(checksum).digest('hex')};
    fs.writeFileSync(file,JSON.stringify(system));
  }
  const {prepareDistribution}=await publisher();
  const result=await prepareDistribution({root,tag:'v2.2.11',commit:'a'.repeat(40),output});
  assert.equal(fs.readFileSync(path.join(root,'SHA256SUMS'),'utf8'),checksum);
  const published=result.plan.objects.find(item=>item.key==='releases/v2.2.11/SHA256SUMS');
  assert.equal(published.sha256,crypto.createHash('sha256').update(checksum).digest('hex'));
  assert.doesNotMatch(fs.readFileSync(path.join(root,'LAUNCHER-SHA256SUMS'),'utf8'),/unpublished.zip/);
});
test('a consistently declared legacy minimum cannot advertise the new execution protocol',t=>{
  const {root,run}=fixture(t);
  const minimum='1.1.0';
  for(const platform of ['darwin-arm64','darwin-x64','win32-x64']) {
    const payloadFile=path.join(root,`${platform}-release-manifest.json`),payload=JSON.parse(fs.readFileSync(payloadFile));
    payload.bootstrap.minimumLauncherVersion=minimum;fs.writeFileSync(payloadFile,JSON.stringify(payload));
    const file=path.join(root,`nora-system-${platform}.json`),system=JSON.parse(fs.readFileSync(file)),bytes=fs.readFileSync(payloadFile);
    system.minimumLauncherVersion=minimum;
    Object.assign(system.files['release-manifest.json'],{size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
    fs.writeFileSync(file,JSON.stringify(system));
  }
  const file=path.join(root,'release-manifest.json'),shared=JSON.parse(fs.readFileSync(file));
  shared.bootstrap.minimumLauncherVersion=minimum;fs.writeFileSync(file,JSON.stringify(shared));
  const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/legacy|protocol|maintenance/i);
});
for(const layer of ['shared','system','payload'])for(const change of ['missing','mismatch'])test(`${layer} ${change} maintenance capability prevents publication`,t=>{
  const {root,run}=fixture(t),name=layer==='shared'?'release-manifest.json':layer==='system'?'nora-system-win32-x64.json':'win32-x64-release-manifest.json';
  const file=path.join(root,name),value=JSON.parse(fs.readFileSync(file));
  if(change==='missing')delete value.launcherCapabilities;
  else value.launcherCapabilities={...capabilities,faultSchema:1};
  fs.writeFileSync(file,JSON.stringify(value));
  if(layer==='payload'){
    const systemFile=path.join(root,'nora-system-win32-x64.json'),system=JSON.parse(fs.readFileSync(systemFile)),bytes=fs.readFileSync(file);
    Object.assign(system.files['release-manifest.json'],{size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
    fs.writeFileSync(systemFile,JSON.stringify(system));
  }
  const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/launcherCapabilities|capabilit/i);
});
test('missing Windows installer prevents publication', t => {
  const { root, run } = fixture(t);
  fs.unlinkSync(path.join(root, 'Nora-Tavern-Launcher-2.1.0-win-x64-setup.exe'));
  assert.notEqual(run().status, 0);
});
test('missing lightweight launcher prevents publication', t => {
  const { root, run } = fixture(t);
  fs.unlinkSync(path.join(root, 'Nora-Tavern-Launcher-2.1.0-win32-x64-update.zip'));
  assert.notEqual(run().status, 0);
});
test('corrupted component prevents publication', t => {
  const { root, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'darwin-arm64-payload.json'), 'corrupt');
  assert.notEqual(run().status, 0);
});
test('mixed commits prevent publication', t => {
  const { root, run } = fixture(t);
  const file = path.join(root, 'nora-system-win32-x64.json');
  const value = JSON.parse(fs.readFileSync(file));
  value.commit = 'b'.repeat(40);
  fs.writeFileSync(file, JSON.stringify(value));
  assert.notEqual(run().status, 0);
});
for (const commit of [undefined, 'b'.repeat(40)]) test(`launcher provenance ${commit || 'missing'} prevents publication`, t => {
  const { root, run } = fixture(t);
  const file = path.join(root, 'nora-launcher-win32-x64.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), commit }));
  assert.notEqual(run().status, 0);
});
test('legacy platform minimum must match the shared update contract', t => {
  const { root, run } = fixture(t);
  const file = path.join(root, 'nora-system-win32-x64.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), minimumLauncherVersion: '0.3.1' }));
  assert.notEqual(run().status, 0);
});
test('missing platform payload manifest prevents publication', t => {
  const { root, run } = fixture(t);
  fs.unlinkSync(path.join(root, 'darwin-arm64-release-manifest.json'));
  assert.notEqual(run().status, 0);
});
test('public checksum list excludes unpublished intermediate archives', t => {
  const { root, run } = fixture(t);
  const hash = crypto.createHash('sha256').update('{}').digest('hex');
  const sealed=`${hash}  darwin-arm64-payload.json\n${hash}  unpublished.zip\n`;
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), sealed);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8'), sealed);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'LAUNCHER-SHA256SUMS'),'utf8'),/unpublished.zip/);
});
