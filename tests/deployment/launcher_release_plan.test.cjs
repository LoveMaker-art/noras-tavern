const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync}=require('node:child_process');
const source = fs.existsSync(path.resolve(__dirname, '../../launcher/desktop/release-network.js'))
  ? path.resolve(__dirname, '../../launcher/desktop') : path.resolve(__dirname,'../installer/desktop');
const modules = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-network-modules-'));
for (const name of ['launcher-update.js','release-network.js','release-sources.js','release-sources.json','launcher-errors.js','telemetry-contract.json'])
  fs.copyFileSync(path.join(source,name),path.join(modules,name));
fs.copyFileSync(fs.existsSync(path.join(source,'releases.js')) ? path.join(source,'releases.js')
  : path.resolve(__dirname,'../../deployment/update/releases.js'),path.join(modules,'releases.js'));
fs.cpSync(path.join(source,'node_modules/semver'),path.join(modules,'node_modules/semver'),{recursive:true});
after(()=>fs.rmSync(modules,{recursive:true,force:true}));
const releases = require(path.join(modules,'releases'));
const launcher = require(path.join(modules,'launcher-update'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function publishedFixture() {
  const directory=path.join(__dirname,'fixtures/published-v2.4.4');
  const fixture=JSON.parse(require('node:zlib').brotliDecompressSync(fs.readFileSync(path.join(directory,'metadata.json.br'))));
  const provenance=JSON.parse(fs.readFileSync(path.join(directory,'provenance.json'),'utf8'));
  assert.equal(provenance.consumer.path,'deployment/update/releases.js');
  assert.equal(provenance.sourceCommit,'2b2e34c10348527fc8b30d2e73bd496106a7415c');
  for(const item of provenance.files) {
    const asset=fixture.release.assets.find(asset=>asset.name===item.name),text=fixture.files[item.name];
    assert.equal(sha(text),item.sha256);assert.equal(Buffer.byteLength(text),item.size);
    assert.equal(asset.digest,`sha256:${item.sha256}`);assert.equal(asset.size,item.size);
    assert.equal(asset.browser_download_url,item.url);
  }
  const requests=[];
  const fetcher=async url=>{
    requests.push(url);
    const asset=fixture.release.assets.find(asset=>asset.browser_download_url===url);
    assert.ok(asset&&fixture.files[asset.name],`Only captured public metadata may be read: ${url}`);
    return new Response(fixture.files[asset.name],{headers:{'Content-Type':'application/json'}});
  };
  return {...fixture,requests,options:{fetcher,selectedRelease:fixture.release,launcherVersion:'2.1.1',tag:'v2.4.4'}};
}

for(const [platform,arch] of [['win32','x64'],['darwin','x64'],['darwin','arm64']]) {
  test(`published v2.4.4 ${platform}-${arch} installation seals the exact platform manifest, and update keeps the root`,async t=>{
    const fixture=publishedFixture(),options={...fixture.options,platform,arch};
    const installed=await releases.selectPlan({...options,mode:'install'});
    const descriptor=installed.systemManifest.files['release-manifest.json'];
    assert.equal(installed.releaseManifestText,fixture.files[descriptor.asset]);
    assert.equal(sha(installed.releaseManifestText),descriptor.sha256);
    assert.equal(Buffer.byteLength(installed.releaseManifestText),descriptor.size);
    assert.notEqual(installed.releaseManifestText,fixture.files['release-manifest.json']);
    assert.deepEqual(fixture.requests.map(url=>url.split('/').at(-1)),[`nora-system-${platform}-${arch}.json`,descriptor.asset]);
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-published-plan-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const operationDirectory=path.join(root,'operations',crypto.randomUUID());fs.mkdirSync(operationDirectory,{recursive:true});
    const saved=releases.sealPlan(installed,{...options,operationDirectory,assertOwner:()=>{}});
    assert.equal(fs.readFileSync(path.join(operationDirectory,saved.manifestRef.file),'utf8'),fixture.files[descriptor.asset]);
    assert.equal(releases.validatePlan(saved,{...options,operationDirectory}).planId,installed.planId);
    fixture.requests.length=0;
    const updated=await releases.selectPlan({...options,mode:'update'});
    assert.equal(updated.releaseManifestText,fixture.files['release-manifest.json']);
    assert.equal(updated.systemManifest,null);
    assert.deepEqual(fixture.requests.map(url=>url.split('/').at(-1)),['release-manifest.json']);
  });
}

function publishedSharedFixture() {
  const fixture=publishedFixture(),minimum='2.1.2',references=[];
  for(const name of ['release-manifest.json',...['darwin-arm64','darwin-x64','win32-x64'].map(target=>`${target}-release-manifest.json`)]) {
    const manifest=JSON.parse(fixture.files[name]);
    manifest.launcherVersion=minimum;manifest.bootstrap.minimumLauncherVersion=minimum;
    // Preserve every original platform archive/module hash: this is a routing
    // regression, not a conversion of platform payloads into root payloads.
    fixture.files[name]=JSON.stringify(manifest);
  }
  for(const target of ['darwin-arm64','darwin-x64','win32-x64']) {
    const name=`nora-system-${target}.json`,system=JSON.parse(fixture.files[name]);
    system.minimumLauncherVersion=minimum;system.launcherVersion=minimum;
    const descriptor=system.files['release-manifest.json'];
    descriptor.sha256=sha(fixture.files[descriptor.asset]);descriptor.size=Buffer.byteLength(fixture.files[descriptor.asset]);
    const [,environment]=Object.entries(system.files).find(([name])=>/^nora-hermes-runtime-.+\.(?:tar\.gz|zip)$/.test(name));
    references.push({name:environment.asset,asset_release_tag:'v2.4.3',size:environment.size,sha256:environment.sha256});
    fixture.files[name]=JSON.stringify(system);
  }
  fixture.files['release-assets.json']=JSON.stringify({schema:'nora-release-assets/1',repository:'LoveMaker-art/noras-tavern',
    tag:'v2.4.4',commit:JSON.parse(fixture.files['release-manifest.json']).commit,minimumLauncherVersion:minimum,assets:references});
  fixture.release.assets=fixture.release.assets.filter(asset=>!references.some(item=>item.name===asset.name));
  for(const [name,text] of Object.entries(fixture.files)) {
    const asset={name,state:'uploaded',size:Buffer.byteLength(text),digest:`sha256:${sha(text)}`,
      browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.4/${name}`};
    const index=fixture.release.assets.findIndex(item=>item.name===name);
    if(index===-1)fixture.release.assets.push(asset);else fixture.release.assets[index]=asset;
  }
  const fetcher=async url=>url.startsWith('https://api.github.com/') ? Response.json(fixture.release) : fixture.options.fetcher(url);
  return {...fixture,options:{...fixture.options,selectedRelease:undefined,fetcher,launcherVersion:minimum}};
}

for(const [platform,arch] of [['win32','x64'],['darwin','x64'],['darwin','arm64']])
  test(`public-derived shared ${platform}-${arch} installation validates the physical system mapping and retains all platform archive hashes`,async()=>{
    const fixture=publishedSharedFixture(),options={...fixture.options,platform,arch},selected=await releases.selectPlan({...options,mode:'install'});
    const manifestName=`${platform}-${arch}-release-manifest.json`;
    assert.equal(selected.releaseManifestText,fixture.files[manifestName]);
    const prepared=await launcher.prepare({...options,selectedPlan:selected});
    assert.equal(prepared.releasePlan.planId,selected.planId);assert.equal(prepared.launcher,null);
    const updated=await releases.selectPlan({...options,mode:'update'});
    assert.equal(updated.releaseManifestText,fixture.files['release-manifest.json']);
  });

test('shared install mapping and root update retain strict checks for the bytes each flow consumes',async()=>{
  const fixture=publishedSharedFixture(),platform='darwin',arch='x64',options={...fixture.options,platform,arch};
  const installed=await releases.selectPlan({...options,mode:'install'}),updated=await releases.selectPlan({...options,mode:'update'});
  const payload=JSON.parse(installed.releaseManifestText);
  payload.archives.app.sha256=updated.releaseManifest.archives.app.sha256;
  assert.throws(()=>releases.validateUpdate(payload,installed.release,'2.1.2',{systemManifest:installed.systemManifest,platform,arch}),/安装档案/);
  const changed=JSON.parse(JSON.stringify(updated.releaseManifest));changed.modules.updater.sha256='0'.repeat(64);
  assert.throws(()=>releases.validateUpdate(changed,updated.release,'2.1.2'),/校验信息/);
  const mismatched=JSON.parse(JSON.stringify(installed.systemManifest));mismatched.commit='a'.repeat(40);
  assert.throws(()=>releases.validateUpdate(installed.releaseManifest,installed.release,'2.1.2',{systemManifest:mismatched,platform,arch}),/提交|同一次发布/);
});

function releaseFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-fixed-release-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'tavern-updates'));
  fs.writeFileSync(path.join(root,'tavern-updates/installed.json'),JSON.stringify({version:'2.4.1'}));
  const manifest={schema:'tavern-release/v2',commit:'a'.repeat(40),launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},versions:{tavern:'2.4.2'},launcherVersion:'2.0.2',
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.0.0',sha256:sha('bootstrap')}};
  const item={schema:'nora-launcher/v1',platform:'win32',arch:'x64',version:'2.0.2',
    asset:'Nora-Tavern-Launcher-2.0.2-win32-x64-update.zip',size:7,sha256:sha('archive')};
  const bytes={'release-manifest.json':JSON.stringify(manifest),'nora-launcher-win32-x64.json':JSON.stringify(item),
    [item.asset]:'archive','tavern-updater-bootstrap.py':'bootstrap','app.tar.gz':'app'};
  bytes.SHA256SUMS=Object.entries(bytes).map(([name,value])=>`${sha(value)}  ${name}`).join('\n');
  const release={tag_name:'v2.4.2',assets:Object.keys(bytes).map(name=>({name,
    browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/${name}`,size:Buffer.byteLength(bytes[name])}))};
  let forbidMetadata=false;
  const fetcher=async url=>{
    if(url.includes('/api.github.com/')||url.includes('api.github.com/')) {
      if(forbidMetadata) throw new Error('latest changed after the user selected a release');
      return Response.json(release);
    }
    const name=url.split('/').at(-1);
    if(forbidMetadata && ['release-manifest.json','nora-launcher-win32-x64.json'].includes(name))
      throw new Error('selected metadata must not be queried again');
    return new Response(bytes[name],{headers:{ETag:'"fixture-v1"','Content-Length':String(Buffer.byteLength(bytes[name]))}});
  };
  return {root,manifest,item,release,bytes,fetcher,forbidMetadata(){forbidMetadata=true;},
    options:{cacheRoot:path.join(root,'cache'),installRoot:root,launcherVersion:'2.0.0',platform:'win32',arch:'x64',fetcher}};
}

test('a selected release survives latest changing and prepares the exact launcher without re-querying metadata',async t=>{
  const f=releaseFixture(t);
  const checked=await releases.check(f.options);
  assert.equal(checked.state,'available');
  assert.ok(checked.releasePlan,'the check must return a reusable fixed plan');
  const selectedPlan=JSON.parse(JSON.stringify(checked.releasePlan));
  f.forbidMetadata();
  const prepared=await launcher.prepare({...f.options,selectedPlan});
  assert.equal(prepared.tag,'v2.4.2');
  assert.equal(fs.readFileSync(prepared.launcher.archive,'utf8'),'archive');
  assert.equal(prepared.releasePlan.planId,selectedPlan.planId);
});

test('component preparation consumes the selected manifest bytes and rejects a changed plan before downloading',async t=>{
  const f=releaseFixture(t), selectedPlan=await releases.selectPlan(f.options);
  f.forbidMetadata();
  const root=await releases.prepareUpdate({...f.options,launcherVersion:'2.0.2',selectedPlan,
    plan:async directory=>({version:'2.4.2',archives:[{name:'app.tar.gz',sha256:sha('app')}]} )});
  assert.equal(fs.readFileSync(path.join(root,'app.tar.gz'),'utf8'),'app');
  const changed=JSON.parse(JSON.stringify(selectedPlan));changed.releaseManifest.commit='b'.repeat(40);
  await assert.rejects(launcher.prepare({...f.options,selectedPlan:changed}),/固定发布(计划|清单)/);
});

function fullInstallFixture(t) {
  const f=releaseFixture(t);
  Object.assign(f.bytes,{'nora-tavern-app.tar.gz':'app','nora-tavern-ops.tar.gz':'ops','nora-tavern-nora-mcp.tar.gz':'mcp',
    'nora-tavern-first-install-bootstrap.py':'install','first-install-manifest.json':'{}','runtime.tar.gz':'runtime','deps.tar.gz':'deps',
    'nora-hermes-runtime.json':JSON.stringify({platform:'win32',arch:'x64',archive:'runtime.tar.gz',sha256:sha('runtime')}),
    'nora-tavern-dependencies.json':JSON.stringify({platform:'win32',arch:'x64',archive:'deps.tar.gz',sha256:sha('deps')})});
  const system={schema:'nora-system/v1',version:'2.4.2',commit:'a'.repeat(40),launcherCapabilities:f.manifest.launcherCapabilities,platform:'win32',arch:'x64',minimumLauncherVersion:'2.0.0',files:{}};
  for(const [name,value] of Object.entries(f.bytes)) if(!['nora-launcher-win32-x64.json',f.item.asset,'app.tar.gz','tavern-updater-bootstrap.py'].includes(name))
    system.files[name]={asset:name,sha256:sha(value),size:Buffer.byteLength(value)};
  f.bytes['nora-system-win32-x64.json']=JSON.stringify(system);
  f.release.assets=Object.keys(f.bytes).map(name=>({name,browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/${name}`,size:Buffer.byteLength(f.bytes[name])}));
  return {...f,system};
}

function refreshFullFixture(f) {
  f.bytes['nora-system-win32-x64.json']=JSON.stringify(f.system);
  f.release.assets=Object.entries(f.bytes).map(([name,bytes])=>({name,state:'uploaded',size:Buffer.byteLength(bytes),
    digest:`sha256:${sha(bytes)}`,browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/${name}`}));
}

function platformInstallFixture(t) {
  const f=fullInstallFixture(t),name='win32-x64-release-manifest.json';
  f.bytes[name]=JSON.stringify({...f.manifest,platformPayload:'win32-x64'})+'\n';
  f.system.files['release-manifest.json']={asset:name,sha256:sha(f.bytes[name]),size:Buffer.byteLength(f.bytes[name])};
  refreshFullFixture(f);return f;
}

test('platform installation consumes its sealed manifest without fetching metadata again',async t=>{
  const f=platformInstallFixture(t),selectedPlan=await releases.selectPlan({...f.options,mode:'install'});
  const forbidden=new Set(['release-manifest.json','win32-x64-release-manifest.json','nora-system-win32-x64.json','nora-launcher-win32-x64.json']);
  const directory=await releases.prepareInstall({...f.options,bundledRoot:path.join(f.root,'no-bundle'),selectedPlan,
    fetcher:async url=>{assert.ok(!url.includes('api.github.com')&&!forbidden.has(url.split('/').at(-1)));return f.fetcher(url);}});
  assert.equal(fs.readFileSync(path.join(directory,'release-manifest.json'),'utf8'),selectedPlan.releaseManifestText);
  assert.notEqual(selectedPlan.releaseManifestText,f.bytes['release-manifest.json']);
});

test('system identity and control-asset routing reject substitution before reading the install payload',async t=>{
  const cases=[
    ['foreign platform',f=>{f.system.platform='darwin';}],
    ['wrong channel',f=>{f.system.channel='beta';}],
    ['another platform manifest',f=>{f.system.files['release-manifest.json'].asset='darwin-x64-release-manifest.json';f.bytes['darwin-x64-release-manifest.json']=f.bytes['win32-x64-release-manifest.json'];}],
    ['arbitrary filename',f=>{f.system.files['release-manifest.json'].asset='other.json';f.bytes['other.json']=f.bytes['win32-x64-release-manifest.json'];}],
    ['foreign repository',(_f,asset)=>{asset.browser_download_url=asset.browser_download_url.replace('LoveMaker-art/noras-tavern','other/repository');}],
    ['historical tag',(_f,asset)=>{asset.browser_download_url=asset.browser_download_url.replace('v2.4.2','v2.4.1');}],
    ['duplicate control asset',(f,asset)=>{f.release.assets.push({...asset});}],
    ['reference annotation',(_f,asset)=>{asset.asset_release_tag='v2.4.1';}],
  ];
  for(const [name,change] of cases) await t.test(name,async t=>{
    const f=platformInstallFixture(t),requests=[];
    if(['foreign repository','historical tag','duplicate control asset','reference annotation'].includes(name))
      change(f,f.release.assets.find(asset=>asset.name==='win32-x64-release-manifest.json'));
    else {change(f);refreshFullFixture(f);}
    await assert.rejects(releases.selectPlan({...f.options,mode:'install',fetcher:async url=>{requests.push(url);return f.fetcher(url);}}));
    assert.deepEqual(requests.map(url=>url.split('/').at(-1)),['latest','nora-system-win32-x64.json']);
    assert.equal(fs.existsSync(f.options.cacheRoot),false);
  });
});

test('install manifest hash and size are checked before inspecting or downloading the launcher',async t=>{
  for(const kind of ['hash','size']) await t.test(kind,async t=>{
    const f=platformInstallFixture(t),requests=[];
    if(kind==='hash')f.bytes['win32-x64-release-manifest.json']+=' ';
    else f.system.files['release-manifest.json'].size++;
    refreshFullFixture(f);
    await assert.rejects(releases.selectPlan({...f.options,mode:'install',fetcher:async url=>{requests.push(url);return f.fetcher(url);}}),/固定发布清单校验/);
    assert.deepEqual(requests.map(url=>url.split('/').at(-1)),['latest','nora-system-win32-x64.json','win32-x64-release-manifest.json']);
  });
});

test('an installation can seal a compatible launcher handoff before applying the system minimum',async t=>{
  const f=fullInstallFixture(t);
  delete f.bytes[f.item.asset];f.item.asset='Nora-Tavern-Launcher-2.1.2-win32-x64-update.zip';f.item.version='2.1.2';
  f.bytes[f.item.asset]='archive';f.bytes['nora-launcher-win32-x64.json']=JSON.stringify(f.item);
  f.manifest.launcherVersion='2.1.2';f.manifest.bootstrap.minimumLauncherVersion='2.1.2';
  f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
  f.system.minimumLauncherVersion='2.1.2';
  f.system.files['release-manifest.json']={asset:'release-manifest.json',size:Buffer.byteLength(f.bytes['release-manifest.json']),sha256:sha(f.bytes['release-manifest.json'])};
  refreshFullFixture(f);
  const selected=await releases.selectPlan({...f.options,launcherVersion:'2.1.1',mode:'install'});
  assert.equal(selected.launcherManifest.version,'2.1.2');assert.equal(selected.systemManifest.minimumLauncherVersion,'2.1.2');
  assert.equal(selected.systemManifest.files['release-manifest.json'].sha256,sha(selected.releaseManifestText));
});

test('shared assets keep the platform install manifest current while resolving older environment bytes',async t=>{
  const f=platformInstallFixture(t),old='v2.4.1',minimum='2.1.2';
  f.manifest.bootstrap.minimumLauncherVersion=minimum;
  f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
  f.bytes['win32-x64-release-manifest.json']=JSON.stringify({...f.manifest,platformPayload:'win32-x64'})+'\n';
  f.system.minimumLauncherVersion=minimum;
  f.system.files['release-manifest.json']={asset:'win32-x64-release-manifest.json',sha256:sha(f.bytes['win32-x64-release-manifest.json']),size:Buffer.byteLength(f.bytes['win32-x64-release-manifest.json'])};
  f.bytes['release-assets.json']=JSON.stringify({schema:'nora-release-assets/1',repository:'LoveMaker-art/noras-tavern',tag:f.release.tag_name,
    commit:f.manifest.commit,minimumLauncherVersion:minimum,assets:[{name:'runtime.tar.gz',asset_release_tag:old,size:7,sha256:sha('runtime')}]});
  refreshFullFixture(f);f.release.assets=f.release.assets.filter(asset=>asset.name!=='runtime.tar.gz');
  const selected=await releases.selectPlan({...f.options,launcherVersion:minimum,mode:'install'});
  assert.equal(selected.releaseManifestText,f.bytes['win32-x64-release-manifest.json']);
  assert.equal(releases.assetUrl(selected.release,'runtime.tar.gz'),'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.1/runtime.tar.gz');
  await assert.rejects(releases.selectPlan({...f.options,launcherVersion:'2.1.1',mode:'install'}),/升级启动器/);
  const updated=await releases.selectPlan({...f.options,launcherVersion:minimum,mode:'update'});
  assert.equal(updated.releaseManifestText,f.bytes['release-manifest.json']);
});

test('full installation reuses its selected system plan even while release queries are unavailable',async t=>{
  const f=fullInstallFixture(t);
  const selectedPlan=await releases.selectPlan({...f.options,mode:'install'});
  f.forbidMetadata();
  const directory=await releases.prepareInstall({...f.options,bundledRoot:path.join(f.root,'absent-bundle'),selectedPlan});
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'nora-system.json'))).version,'2.4.2');
  assert.equal(fs.readFileSync(path.join(directory,'runtime.tar.gz'),'utf8'),'runtime');
});

for(const flow of ['install','components','launcher'])test(`${flow} preparation switches source using one frozen target and leaves the installed tree intact`,async t=>{
  const f=fullInstallFixture(t),sources={schema:1,mirrors:[{id:'primary',baseUrl:'https://primary.example/'}]},requests=[];
  let selected=false;
  const fetcher=async(url,options)=>{
    requests.push(url);
    if(url.startsWith('https://primary.example/')) {
      if(selected)return new Response('unavailable',{status:503});
      if(url.endsWith('/channels/stable.json'))return Response.json(f.release);
      return new Response(f.bytes[url.split('/').at(-1)]);
    }
    return f.fetcher(url,options);
  };
  const options={...f.options,fetcher,networkPolicy:{sources}};
  const plan=await releases.selectPlan({...options,mode:flow==='install'?'install':'update'});
  assert.ok(requests.every(url=>url.startsWith('https://primary.example/')));
  selected=true;f.forbidMetadata();requests.length=0;
  fs.mkdirSync(path.join(f.root,'apps/current'),{recursive:true});fs.writeFileSync(path.join(f.root,'apps/current/marker'),'old installation');
  if(flow==='install') {
    const directory=await releases.prepareInstall({...options,bundledRoot:path.join(f.root,'no-bundle'),selectedPlan:plan});
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'nora-system.json'))).version,'2.4.2');
    assert.equal(fs.readFileSync(path.join(directory,'runtime.tar.gz'),'utf8'),'runtime');
  } else if(flow==='launcher') {
    const result=await launcher.prepare({...options,selectedPlan:plan});
    assert.equal(result.tag,'v2.4.2');assert.equal(result.releasePlan.planId,plan.planId);
    assert.equal(fs.readFileSync(result.launcher.archive,'utf8'),'archive');
  } else {
    const directory=await releases.prepareUpdate({...options,launcherVersion:'2.0.2',selectedPlan:plan,
      plan:async()=>({version:'2.4.2',archives:[{name:'app.tar.gz',sha256:sha('app')}]})});
    assert.equal(fs.readFileSync(path.join(directory,'app.tar.gz'),'utf8'),'app');
  }
  assert.equal(fs.readFileSync(path.join(f.root,'apps/current/marker'),'utf8'),'old installation');
  assert.ok(requests.every(url=>url.includes('/releases/v2.4.2/')||url.includes('/releases/download/v2.4.2/')));
  assert.equal(requests.filter(url=>url.startsWith('https://primary.example/')).length,requests.filter(url=>url.startsWith('https://github.com/')).length);
});

test('release and manifest selection share one total metadata budget',async t=>{
  const f=releaseFixture(t);let clock=1000;
  await assert.rejects(releases.selectPlan({...f.options,networkPolicy:{now:()=>clock,totalBudgetMs:100,backoffMs:[0,0]},
    fetcher:async(url,options)=>{clock+=60;return f.fetcher(url,options);}}),error=>error.code==='TIMEOUT');
});

test('first installation shares the release lookup budget with manifest selection before choosing a plan',async t=>{
  const f=fullInstallFixture(t),requests=[];let clock=1000,selected=0;
  await assert.rejects(releases.prepareInstall({...f.options,networkPolicy:{now:()=>clock,totalBudgetMs:100,backoffMs:[0,0]},
    onPlan:async()=>{selected++;},fetcher:async(url,options)=>{
      requests.push(url);clock+=60;return f.fetcher(url,options);
    }}),error=>error.code==='TIMEOUT');
  assert.equal(selected,0,'budget exhaustion cannot freeze an incomplete plan');
  assert.equal(requests.length,2,'the latest lookup must not grant manifest selection another full budget');
  assert.ok(requests[0].endsWith('/releases/latest'));assert.ok(requests[1].endsWith('/nora-system-win32-x64.json'));
  assert.equal(fs.existsSync(f.options.cacheRoot),false,'no asset transfer starts without a complete fixed plan');
});

test('cached version checks keep the prior check time and do not claim a fresh latest lookup',async t=>{
  const f=releaseFixture(t);let clock=1000;
  const metadataCache=releases.createMetadataCache({ttlMs:100,now:()=>clock});
  const first=await releases.check({...f.options,metadataCache});
  clock=1050;f.forbidMetadata();
  const cached=await releases.check({...f.options,metadataCache});
  assert.equal(cached.state,'available');assert.equal(cached.latest,'v2.4.2');
  assert.equal(cached.latestConfirmed,false);assert.equal(cached.metadataSource,'cache');
  assert.equal(cached.checkedAt,first.checkedAt);assert.equal(cached.releasePlan.latestConfirmed,false);
});

test('a full production-sized manifest is sealed once and survives a process restart as a small fixed plan',async t=>{
  const f=releaseFixture(t);
  f.manifest.files=Object.fromEntries(Array.from({length:6000},(_,index)=>[`apps/runtime/file-${index}.js`,{sha256:'a'.repeat(64),size:1234}]));
  f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
  f.bytes.SHA256SUMS=Object.entries(f.bytes).filter(([name])=>name!=='SHA256SUMS').map(([name,value])=>`${sha(value)}  ${name}`).join('\n');
  f.release.assets=f.release.assets.map(item=>({...item,size:Buffer.byteLength(f.bytes[item.name]),irrelevantMetadata:'x'.repeat(5000)}));
  f.release.body='irrelevant description'.repeat(20000);
  const selected=await releases.selectPlan(f.options);
  assert.ok(Buffer.byteLength(selected.releaseManifestText)>560000);
  const operationDirectory=path.join(f.root,'installer/operations',crypto.randomUUID());fs.mkdirSync(operationDirectory,{recursive:true});
  let ownerChecks=0;
  const saved=releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{ownerChecks++;}});
  assert.ok(ownerChecks>0);assert.equal(saved.planId,selected.planId);
  assert.ok(Buffer.byteLength(JSON.stringify(saved))<16*1024);
  assert.equal(saved.releaseManifest,undefined);assert.equal(saved.releaseManifestText,undefined);
  assert.equal(saved.version,'2.4.2');assert.equal(saved.manifestSha256,sha(selected.releaseManifestText));
  assert.equal(saved.manifestRef.operationId,path.basename(operationDirectory));
  const artifact=path.join(operationDirectory,saved.manifestRef.file);
  assert.equal(fs.readFileSync(artifact,'utf8'),selected.releaseManifestText);
  f.forbidMetadata();
  const persisted=path.join(f.root,'fixed-plan.json');fs.writeFileSync(persisted,JSON.stringify(saved));
  const child=spawnSync(process.execPath,['-e',`globalThis.fetch=()=>{throw new Error('No release lookup after restart');};
    const releases=require(${JSON.stringify(path.join(modules,'releases.js'))});
    const saved=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(persisted)},'utf8'));
    const plan=releases.validatePlan(saved,${JSON.stringify({launcherVersion:f.options.launcherVersion,platform:'win32',arch:'x64',operationDirectory})});
    console.log(JSON.stringify({planId:plan.planId,version:plan.releaseManifest.versions.tavern}));`],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{planId:selected.planId,version:'2.4.2'});
  const restored=releases.validatePlan(JSON.parse(JSON.stringify(saved)),{...f.options,operationDirectory});
  assert.equal(restored.planId,selected.planId);assert.deepEqual(restored.releaseManifest,selected.releaseManifest);
  const prepared=await launcher.prepare({...f.options,operationDirectory,selectedPlan:saved});
  assert.equal(prepared.releasePlan.planId,selected.planId);assert.equal(fs.readFileSync(prepared.launcher.archive,'utf8'),'archive');
  assert.deepEqual(releases.sealPlan(restored,{...f.options,operationDirectory,assertOwner:()=>{}}),saved);
  assert.deepEqual(fs.readdirSync(path.dirname(artifact)),[path.basename(artifact)]);
});

test('fixed plan references cannot authorize missing, changed, symbolic or foreign-operation manifests',async t=>{
  const f=releaseFixture(t),selected=await releases.selectPlan(f.options);
  const operationDirectory=path.join(f.root,'installer/operations',crypto.randomUUID());fs.mkdirSync(operationDirectory,{recursive:true});
  assert.throws(()=>releases.sealPlan(selected,{operationDirectory}),/owner/i);
  const saved=releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{}}),artifact=path.join(operationDirectory,saved.manifestRef.file);
  assert.throws(()=>releases.validatePlan(saved,f.options),/操作|operation/);
  const foreign=path.join(f.root,'installer/operations',crypto.randomUUID());fs.mkdirSync(path.join(foreign,'release-plan'),{recursive:true});
  fs.copyFileSync(artifact,path.join(foreign,saved.manifestRef.file));
  assert.throws(()=>releases.validatePlan(saved,{...f.options,operationDirectory:foreign}),/操作|operation/);
  fs.writeFileSync(artifact,selected.releaseManifestText+' ');
  assert.throws(()=>releases.validatePlan(saved,{...f.options,operationDirectory}),/清单|manifest/);
  assert.throws(()=>releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{}}),/清单|manifest/);
  fs.unlinkSync(artifact);assert.throws(()=>releases.validatePlan(saved,{...f.options,operationDirectory}));
  if(process.platform==='win32'){
    const outside=path.join(f.root,'outside-manifest');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,path.basename(artifact)),selected.releaseManifestText);
    fs.rmdirSync(path.dirname(artifact));fs.symlinkSync(outside,path.dirname(artifact),'junction');
  }else{const original=path.join(f.root,'original.json');fs.writeFileSync(original,selected.releaseManifestText);fs.symlinkSync(original,artifact);}
  assert.throws(()=>releases.validatePlan(saved,{...f.options,operationDirectory}),/清单|manifest/);
});

test('an uncommitted immutable seal cannot pin the next selection, and repeated interrupted selection has a bounded artifact budget',async t=>{
  const f=releaseFixture(t),operationDirectory=path.join(f.root,'installer/operations',crypto.randomUUID());fs.mkdirSync(operationDirectory,{recursive:true});
  const original=await releases.selectPlan(f.options),saved=releases.sealPlan(original,{...f.options,operationDirectory,assertOwner:()=>{}});
  const originalFile=path.join(operationDirectory,saved.manifestRef.file),originalSha=sha(fs.readFileSync(originalFile));
  // No Operation.plan CAS has committed. A new owner may still select safely.
  let last;
  for(let attempt=1;attempt<=4;attempt++){
    f.manifest.publication=attempt;f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
    const selected=await releases.selectPlan(f.options);
    if(attempt<4)last=releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{}});
    else assert.throws(()=>releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{}}),/安全上限/);
  }
  assert.notEqual(saved.manifestRef.file,last.manifestRef.file);assert.equal(sha(fs.readFileSync(originalFile)),originalSha);
  assert.deepEqual(releases.sealPlan(last,{...f.options,operationDirectory,assertOwner:()=>{}}),last);
  assert.equal(fs.readdirSync(path.dirname(originalFile)).length,4);
});
