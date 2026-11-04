const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const releases=require('../installer/desktop/releases');
const launcher=require('../installer/desktop/launcher-update');
const {sourceCandidates}=require('../installer/desktop/release-sources');

const repository='LoveMaker-art/noras-tavern';
const tag='v2.6.5',appVersion='2.2.9',coreVersion='2.6.4';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const archiveName='Nora-Tavern-Launcher-win32-x64-update.zip';
const descriptorName='nora-launcher-win32-x64.json';
const assetUrl=name=>`https://github.com/${repository}/releases/download/${tag}/${name}`;
const policy={maxAttempts:1,totalBudgetMs:3000,attemptTimeoutMs:1000,backoffMs:[0],downloadBodyMaxAttempts:1};

function fixture({manifest:changeManifest,descriptor:changeDescriptor,archive=Buffer.from('APP archive fixture'),archiveAsset=archiveName,index=false}={}){
  const manifest={schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:coreVersion},
    publication:{schema:'nora-component-publication/1',tag},launcherVersion:appVersion,
    launcherCapabilities:{...releases.LAUNCHER_CAPABILITIES}};
  const descriptor={schema:'nora-launcher/v1',version:appVersion,platform:'win32',arch:'x64',
    asset:archiveAsset,sha256:sha(archive),size:archive.length};
  changeManifest?.(manifest);changeDescriptor?.(descriptor);
  const files=new Map([['release-manifest.json',Buffer.from(JSON.stringify(manifest))],
    [descriptorName,Buffer.from(JSON.stringify(descriptor))],[archiveAsset,archive]]);
  if(index)files.set('release-assets.json',Buffer.from(JSON.stringify({schema:'nora-release-assets/1',
    repository,tag,commit:manifest.commit,minimumLauncherVersion:'2.2.0',assets:[]})));
  const release={tag_name:tag,draft:false,prerelease:false,assets:[...files].map(([name,bytes])=>({
    name,state:'uploaded',size:bytes.length,digest:`sha256:${sha(bytes)}`,browser_download_url:assetUrl(name)}))};
  const requests=[],routes=new Map();
  const add=(canonical,resource)=>{
    // Only the build-owned, repository/tag-bound physical routes are admitted.
    for(const candidate of sourceCandidates(canonical,{channel:'stable'})){
      assert.ok(!routes.has(candidate.url),`Conflicting fixture route: ${candidate.url}`);
      routes.set(candidate.url,{...resource,canonical});
    }
  };
  add(`https://api.github.com/repos/${repository}/releases?per_page=100&page=1`,{kind:'catalogue'});
  add(`https://api.github.com/repos/${repository}/releases/tags/${tag}`,{kind:'release'});
  for(const [name,bytes] of files)add(assetUrl(name),{kind:'asset',name,bytes});
  const catalogue=[{...release,tag_name:'v99.0.0',draft:true},{...release,tag_name:'v3.0.0-beta.1',prerelease:true},
    release,{...release,tag_name:'v2.6.4'}];
  const fetcher=async url=>{
    const resource=routes.get(String(url));
    assert.ok(resource,`Offline fixture rejected an unsealed resource: ${url}`);
    requests.push({url:String(url),canonical:resource.canonical,kind:resource.kind,name:resource.name});
    const body=resource.kind==='asset'?resource.bytes:JSON.stringify(resource.kind==='catalogue'?catalogue:release);
    const response=new Response(body,{headers:{'Content-Type':resource.name===archiveAsset?'application/zip':'application/json'}});
    Object.defineProperty(response,'url',{value:String(url)});return response;
  };
  const releaseEvidence={release,checkedAt:'2026-11-03T00:00:00.000Z',source:'network',latestConfirmed:true};
  return {manifest,descriptor,files,release,requests,fetcher,releaseEvidence,
    options:{fetcher,releaseEvidence,launcherVersion:'2.2.8',platform:'win32',arch:'x64',channel:'stable',networkPolicy:{...policy}}};
}
function temporary(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-plan-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function operationDirectory(t){
  const directory=path.join(temporary(t),'operations',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});return directory;
}
async function withoutWrites(action){
  const originals=[];
  // Query code must not create receipts, operation directories, caches or files.
  // All fixture setup/cleanup and the explicitly writable seal step are outside.
  const methods=['appendFile','appendFileSync','chmod','chmodSync','chown','chownSync','copyFile','copyFileSync',
    'cp','cpSync','createWriteStream','link','linkSync','mkdir','mkdirSync','mkdtemp','mkdtempSync',
    'rename','renameSync','rm','rmSync','rmdir','rmdirSync','symlink','symlinkSync','truncate','truncateSync',
    'unlink','unlinkSync','write','writeSync','writeFile','writeFileSync'];
  const forbid=(object,name)=>{
    if(typeof object[name]!=='function')return;
    originals.push([object,name,object[name]]);object[name]=()=>{throw new Error(`Query attempted fs.${name}`);};
  };
  for(const name of methods)forbid(fs,name);
  for(const name of ['appendFile','chmod','chown','copyFile','cp','link','mkdir','mkdtemp','rename','rm','rmdir',
    'symlink','truncate','unlink','writeFile'])forbid(fs.promises,name);
  for(const [object,name]of [[fs,'open'],[fs,'openSync'],[fs.promises,'open']]){
    const original=object[name];originals.push([object,name,original]);
    object[name]=function(file,flags,...args){
      const writable=typeof flags==='number'
        ?Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))
        :/[wa+]/.test(flags||'r');
      if(writable)throw new Error(`Query attempted writable fs.${name}`);
      return original.call(this,file,flags,...args);
    };
  }
  try{return await action();}finally{for(const [object,name,original]of originals.reverse())object[name]=original;}
}
function metadataOnly(f){
  assert.ok(f.requests.length>0);
  assert.ok(f.requests.every(item=>item.kind!=='asset'||['release-manifest.json',descriptorName,'release-assets.json'].includes(item.name)),
    'APP selection/check must request neither the APP zip nor any core payload');
}

for(const [name,change]of [
  ['missing',()=>{}],
  ['corrupt',manifest=>{manifest.bootstrap={managedComponents:99,sha256:'broken',minimumLauncherVersion:'999.0.0'};
    manifest.updaterCapabilities={executorProtocol:'incompatible-core-protocol'};}],
])test(`APP selection, sealing and rereading accept ${name} core bootstrap without core assets`,async t=>{
  const f=fixture({manifest:change});
  const selected=await withoutWrites(()=>releases.selectAppPlan(f.options));
  assert.equal(selected.schema,'nora-release-plan/1');assert.equal(selected.client,'app');assert.equal(selected.mode,'update');
  assert.equal(selected.version,appVersion);assert.equal(selected.releaseManifest.versions.tavern,coreVersion);
  assert.equal(selected.systemManifest,null);assert.equal(selected.launcherManifest.sha256,f.descriptor.sha256);
  assert.ok(Object.isFrozen(selected)&&Object.isFrozen(selected.releaseManifest));metadataOnly(f);
  const directory=operationDirectory(t);let ownershipChecks=0;
  const contract=releases.sealPlan(selected,{...f.options,operationDirectory:directory,assertOwner:()=>{ownershipChecks++;}});
  assert.ok(ownershipChecks>=2);assert.equal(contract.version,appVersion);assert.notEqual(contract.version,coreVersion);
  assert.equal(contract.planId,selected.planId);assert.equal(contract.releaseManifest,undefined);
  assert.equal(contract.manifestRef.sha256,sha(f.files.get('release-manifest.json')));
  assert.deepEqual(fs.readFileSync(path.join(directory,contract.manifestRef.file)),f.files.get('release-manifest.json'));
  const read=releases.validateAppPlan(contract,{...f.options,operationDirectory:directory});
  assert.equal(read.planId,selected.planId);assert.deepEqual(read.releaseManifest,selected.releaseManifest);
  assert.equal(releases.validatePlan(contract,{...f.options,operationDirectory:directory}).client,'app');
  metadataOnly(f);
});

test('default APP catalogue discovery selects the latest stable publication and performs a zero-write query with no local core',async t=>{
  const f=fixture(),root=temporary(t),installRoot=path.join(root,'missing-core');
  fs.writeFileSync(path.join(root,'preserved-user-data'),'unchanged');
  const {releaseEvidence,...options}=f.options;
  const result=await withoutWrites(()=>releases.checkApp({...options,installRoot,home:root,cacheRoot:path.join(root,'cache')}));
  assert.equal(result.launcherState,'available');assert.equal(result.launcherLatest,appVersion);
  assert.equal(result.launcherUpdateAvailable,true);assert.equal(result.launcherInstallable,true);
  assert.equal(result.releaseTag,tag);assert.equal(result.releasePlan.client,'app');
  assert.equal(result.launcherLatestConfirmed,true);assert.ok(result.launcherCheckedAt);
  assert.equal(f.requests.filter(item=>item.kind==='catalogue').length,1);metadataOnly(f);
  assert.equal(fs.existsSync(installRoot),false);assert.deepEqual(fs.readdirSync(root),['preserved-user-data']);
  assert.equal(fs.readFileSync(path.join(root,'preserved-user-data'),'utf8'),'unchanged');
});

for(const name of ['release-manifest.json',descriptorName])
  test(`APP confirmation uses the timestamp and freshness of the selected ${name}`,async()=>{
    const f=fixture();let clock=Date.parse('2026-11-03T00:00:00Z');
    const metadataCache=releases.createMetadataCache({now:()=>clock,ttlMs:30000});
    await releases.requestJson(assetUrl(name),f.fetcher,null,{metadataCache,networkPolicy:{...policy},channel:'stable'});
    clock+=1000;
    const releaseEvidence={...f.releaseEvidence,checkedAt:new Date(clock).toISOString()};
    const result=await releases.checkApp({...f.options,releaseEvidence,metadataCache});
    assert.equal(result.launcherLatest,appVersion);assert.equal(result.launcherInstallable,true);
    assert.equal(result.launcherLatestConfirmed,false);
    assert.equal(result.launcherCheckedAt,'2026-11-03T00:00:00.000Z');
    assert.equal(result.releasePlan.metadataSource,'cache');
    assert.equal(f.requests.filter(request=>request.name===name).length,1,'this selected asset was read from cache');
  });

for(const [local,state]of [[appVersion,'current'],['2.3.0','ahead']])
  test(`APP check with local ${local} reports ${state} without a descriptor/archive request`,async()=>{
    const f=fixture(),result=await withoutWrites(()=>releases.checkApp({...f.options,launcherVersion:local}));
    assert.equal(result.launcherState,state);assert.equal(result.launcherInstallable,false);
    assert.equal(result.launcherUpdateAvailable,false);assert.equal(result.releasePlan.launcherManifest,null);
    assert.deepEqual(f.requests.map(item=>item.name),['release-manifest.json']);
  });

for(const [name,options,pattern]of [
  ['wrong descriptor platform',{descriptor:item=>{item.platform='darwin';}},/清单无效/],
  ['wrong descriptor architecture',{descriptor:item=>{item.arch='arm64';}},/清单无效/],
  ['wrong descriptor APP version',{descriptor:item=>{item.version='2.2.10';}},/清单无效/],
  ['malformed archive digest',{descriptor:item=>{item.sha256='not-a-sha256';}},/清单无效/],
  ['candidate release manifest',{manifest:item=>{item.candidate=true;}},/发布身份/],
  ['candidate APP descriptor',{descriptor:item=>{item.candidate=true;}},/清单无效/],
  ['incompatible operation protocol',{manifest:item=>{item.launcherCapabilities.operationSchema='nora-operation/99';}},/维护协议不兼容/],
  ['incompatible executor protocol',{manifest:item=>{item.launcherCapabilities.executorProtocol='nora-operation-executor/99';}},/维护协议不兼容/],
  ['incompatible telemetry protocol',{manifest:item=>{item.launcherCapabilities.telemetrySchema=99;}},/维护协议不兼容/],
  ['incompatible fault protocol',{manifest:item=>{item.launcherCapabilities.faultSchema=99;}},/维护协议不兼容/],
])test(`APP selection rejects ${name}`,async()=>{
  const f=fixture(options);await assert.rejects(releases.selectAppPlan(f.options),pattern);metadataOnly(f);
});

test('APP asset publication digest must match its APP descriptor when an asset index is present',async()=>{
  const f=fixture({index:true,descriptor:item=>{item.sha256='b'.repeat(64);}});
  const {releaseEvidence,...options}=f.options;
  await assert.rejects(releases.selectAppPlan(options),/校验信息不一致/);metadataOnly(f);
});

test('APP selection rejects changed publication manifest or archive identity without a shared asset index',async()=>{
  for(const name of ['release-manifest.json',archiveName]){
    const f=fixture();
    f.release.assets.find(item=>item.name===name).digest='sha256:'+'b'.repeat(64);
    await assert.rejects(releases.selectAppPlan(f.options),/发布资产.*校验信息不一致/);
    metadataOnly(f);
  }
});

test('APP selection rejects same-length platform descriptor bytes changed from the official catalogue',async()=>{
  const f=fixture({descriptor:item=>{item.note='old';}});
  const bytes=f.files.get(descriptorName);
  bytes.write('new',bytes.indexOf('old'));
  await assert.rejects(releases.selectAppPlan(f.options),/发布资产.*校验信息不一致/);
  metadataOnly(f);
});

test('APP selection rejects a catalogue-owned archive for the wrong platform, architecture or version',async()=>{
  for(const archiveAsset of [
    `Nora-Tavern-Launcher-${appVersion}-darwin-arm64-update.zip`,
    `Nora-Tavern-Launcher-${appVersion}-win32-arm64-update.zip`,
    'Nora-Tavern-Launcher-2.2.8-win32-x64-update.zip',
  ]){
    const f=fixture({archiveAsset});
    await assert.rejects(releases.selectAppPlan(f.options),/压缩包.*平台|压缩包.*版本/);
    metadataOnly(f);
  }
});

test('APP selection accepts official versioned assets and preserves legacy same-platform identities',async()=>{
  for(const archiveAsset of [archiveName,`Nora-Tavern-Launcher-${appVersion}-win32-x64-update.zip`]){
    const f=fixture({archiveAsset});
    if(archiveAsset===archiveName)delete f.release.assets.find(item=>item.name===descriptorName).digest;
    const plan=await releases.selectAppPlan(f.options);
    assert.equal(plan.launcherManifest.asset,archiveAsset);
    metadataOnly(f);
  }
});

test('APP archive bytes with a validly shaped but wrong digest are rejected before becoming an executable cache asset',async t=>{
  const archive=Buffer.from('APP archive fixture');
  const f=fixture({archive}),cacheRoot=temporary(t);
  const selected=await releases.selectAppPlan(f.options);metadataOnly(f);
  archive[0]^=0xff; // The selected catalogue stays valid while transfer bytes change.
  await assert.rejects(launcher.prepare({...f.options,selectedPlan:selected,cacheRoot}),/校验|完整|不一致/);
  assert.ok(f.requests.some(item=>item.name===archiveName),'exercise actual offline archive transfer');
  assert.ok(f.requests.every(item=>item.kind!=='asset'||['release-manifest.json',descriptorName,archiveName].includes(item.name)));
  assert.equal(fs.existsSync(path.join(cacheRoot,'launcher-'+f.descriptor.sha256.slice(0,16),archiveName)),false);
});

test('fixed APP plan rejects wrong identity/digest and incompatible caller context',async()=>{
  const f=fixture(),selected=await releases.selectAppPlan(f.options);
  for(const [label,change]of [
    ['plan digest',item=>{item.planId='0'.repeat(64);}],
    ['release tag',item=>{item.tag='v2.6.6';}],
    ['commit',item=>{item.commit='b'.repeat(40);}],
    ['APP target version',item=>{item.version=coreVersion;}],
    ['descriptor digest',item=>{item.launcherManifest.sha256='b'.repeat(64);}],
    ['raw launcher descriptor',item=>{item.launcherManifestText+=' ';}],
    ['raw manifest',item=>{item.releaseManifestText+=' ';}],
  ]){const changed=clone(selected);change(changed);assert.throws(()=>releases.validateAppPlan(changed,f.options),undefined,label);}
  for(const context of [{platform:'darwin'},{arch:'arm64'},{channel:'beta'},{tag:'v2.6.6'},{mode:'install'}])
    assert.throws(()=>releases.validateAppPlan(selected,{...f.options,...context}),/固定计划无效/);
});

test('sealed APP plans reject a wrong manifest reference, operation directory and same-length raw-byte tampering',async t=>{
  const f=fixture(),selected=await releases.selectAppPlan(f.options),directory=operationDirectory(t);
  const contract=releases.sealPlan(selected,{...f.options,operationDirectory:directory,assertOwner:()=>{}});
  assert.equal(contract.launcherManifestText,f.files.get(descriptorName).toString());
  for(const [label,change]of [
    ['manifest hash',item=>{item.manifestRef.sha256='b'.repeat(64);}],
    ['manifest relative path',item=>{item.manifestRef.file='../release-manifest.json';}],
    ['operation identity',item=>{item.manifestRef.operationId=crypto.randomUUID();}],
    ['APP contract version',item=>{item.version=coreVersion;}],
  ]){const changed=clone(contract);change(changed);assert.throws(()=>releases.validateAppPlan(changed,{...f.options,operationDirectory:directory}),undefined,label);}
  assert.throws(()=>releases.validateAppPlan(contract,{...f.options,operationDirectory:operationDirectory(t)}));
  const artifact=path.join(directory,contract.manifestRef.file),raw=fs.readFileSync(artifact,'utf8');
  const changed=raw.replace('"commit":"a','"commit":"b');assert.notEqual(changed,raw);assert.equal(changed.length,raw.length);
  fs.writeFileSync(artifact,changed);
  assert.throws(()=>releases.validateAppPlan(contract,{...f.options,operationDirectory:directory}),/清单校验失败/);
});

test('the independent core updater cannot validate, seal or execute an APP-owned fixed plan',async t=>{
  const f=fixture(),selected=await releases.selectAppPlan(f.options),directory=operationDirectory(t),cacheRoot=temporary(t);
  const options={...f.options,client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES,
    selectedPlan:selected,operationDirectory:directory,cacheRoot};
  const before=f.requests.length;
  assert.throws(()=>releases.validateAppPlan(selected,options),/不能用于核心维护/);
  assert.throws(()=>releases.validatePlan(selected,options),/不能用于核心维护/);
  assert.throws(()=>releases.sealPlan(selected,{...options,assertOwner:()=>{}}),/不能用于核心维护/);
  await assert.rejects(releases.prepareUpdate(options),/不能用于核心维护/);
  await assert.rejects(releases.prepareUpdate({...options,client:undefined}),/不能用于核心维护/);
  assert.equal(f.requests.length,before);assert.deepEqual(fs.readdirSync(directory),[]);assert.deepEqual(fs.readdirSync(cacheRoot),[]);
});
