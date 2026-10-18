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
const {sourceCandidates}=require(path.join(modules,'release-sources'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const githubOnly={schema:1,primary:'github',mirrors:[]};

// Build the fixture's physical routes from the same trusted source candidates
// as the consumer. Never resolve arbitrary hosts/projects/tags by basename.
function fixtureResource(url,release,sourceOptions={}) {
  const routes=new Map(),api='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/';
  const add=(canonical,resource)=>{
    for(const candidate of sourceCandidates(canonical,sourceOptions)) {
      const previous=routes.get(candidate.url);
      assert.ok(!previous||previous.canonical===canonical,`Conflicting fixture route: ${candidate.url}`);
      routes.set(candidate.url,{...resource,canonical});
    }
  };
  add(api+'latest',{kind:'release',name:'latest'});
  add(api+'tags/'+encodeURIComponent(release.tag_name),{kind:'release',name:'tags/'+release.tag_name});
  for(const asset of release.assets) {
    const canonical=`https://github.com/LoveMaker-art/noras-tavern/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`;
    if(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(asset.name)&&asset.browser_download_url===canonical)
      add(canonical,{kind:'asset',name:asset.name});
  }
  const resource=routes.get(String(url));
  assert.ok(resource,`Fixture rejected an unsealed resource: ${url}`);
  return resource;
}
function fixtureResponse(body,url,headers={}) {
  const response=new Response(body,{headers});Object.defineProperty(response,'url',{value:String(url)});return response;
}

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
  return {...fixture,requests,options:{fetcher,selectedRelease:fixture.release,launcherVersion:'2.1.1',tag:'v2.4.4',
    networkPolicy:{sources:githubOnly}}};
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
  const fetcher=async url=>fixtureResource(url,fixture.release,{sources:githubOnly}).kind==='release'
    ? fixtureResponse(JSON.stringify(fixture.release),url,{'Content-Type':'application/json'}) : fixture.options.fetcher(url);
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
  let forbidMetadata=false;const requests=[];
  const resourceName=(url,sourceOptions)=>fixtureResource(url,release,sourceOptions).name;
  const fetcher=async url=>{
    requests.push(String(url));
    const resource=fixtureResource(url,release);
    if(resource.kind==='release') {
      if(forbidMetadata) throw new Error('latest changed after the user selected a release');
      return fixtureResponse(JSON.stringify(release),url,{'Content-Type':'application/json'});
    }
    const name=resource.name;assert.ok(Object.hasOwn(bytes,name),`Fixture bytes missing for sealed asset: ${name}`);
    if(forbidMetadata && name==='nora-launcher-win32-x64.json')
      throw new Error('selected launcher metadata must not be queried again');
    return fixtureResponse(bytes[name],url,{ETag:'"fixture-v1"','Content-Length':String(Buffer.byteLength(bytes[name]))});
  };
  return {root,manifest,item,release,bytes,fetcher,requests,resourceName,forbidMetadata(){forbidMetadata=true;},
    options:{cacheRoot:path.join(root,'cache'),installRoot:root,launcherVersion:'2.0.0',platform:'win32',arch:'x64',fetcher}};
}

test('component publication separates immutable batch tag from unchanged core and keeps legacy tag binding',async t=>{
  const f=releaseFixture(t);
  fs.writeFileSync(path.join(f.root,'tavern-updates/installed.json'),JSON.stringify({version:'2.4.2'}));
  f.release.tag_name='v2.4.3';
  for(const asset of f.release.assets) asset.browser_download_url=asset.browser_download_url.replace('/v2.4.2/','/v2.4.3/');
  f.manifest.publication={schema:'nora-component-publication/1',tag:'v2.4.3'};
  f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
  const selected=await releases.selectPlan({...f.options,tag:'v2.4.3'});
  assert.equal(selected.tag,'v2.4.3');assert.equal(selected.releaseManifest.versions.tavern,'2.4.2');
  const checked=await releases.check(f.options);
  assert.equal(checked.latest,'v2.4.2');assert.equal(checked.releaseTag,'v2.4.3');
  assert.equal(checked.releaseAvailable,false);assert.equal(checked.launcherUpdateAvailable,true);
  for(const publication of [undefined,{schema:'unknown',tag:'v2.4.3'},
    {schema:'nora-component-publication/1',tag:'v2.4.4'},
    {schema:'nora-component-publication/1',tag:'v2.4.3',untrusted:true}]) {
    const manifest={...f.manifest,publication};
    if(publication===undefined)delete manifest.publication;
    assert.throws(()=>releases.validateUpdate(manifest,f.release,'2.0.2'),/目标发布|批次/);
  }
});

test('current default JihuLab fixed tag selection records source evidence and reuses cached exact metadata',async t=>{
  const f=releaseFixture(t),configuration=require(path.join(modules,'release-sources.json'));
  assert.equal(configuration.primary,'jihulab');
  const metadataCache=releases.createMetadataCache({ttlMs:60000});
  const selected=await releases.selectPlan({...f.options,tag:f.release.tag_name,metadataCache});
  assert.equal(selected.tag,'v2.4.2');assert.equal(selected.commit,f.manifest.commit);
  assert.equal(selected.releaseManifestText,f.bytes['release-manifest.json']);
  assert.equal(selected.metadataSource,'network');assert.equal(selected.latestConfirmed,true);
  const domestic=configuration.mirrors.find(source=>source.id==='jihulab');
  const expected=['release.json','release-manifest.json','nora-launcher-win32-x64.json']
    .map(name=>new URL(`${f.release.tag_name}/${name}`,domestic.baseUrl).href);
  assert.deepEqual(f.requests,expected);
  assert.ok(f.requests.every(url=>new URL(url).origin==='https://jihulab.com'));
  f.forbidMetadata();
  const cached=await releases.selectPlan({...f.options,tag:f.release.tag_name,metadataCache});
  assert.equal(cached.tag,selected.tag);assert.equal(cached.commit,selected.commit);
  assert.equal(cached.releaseManifestText,selected.releaseManifestText);
  assert.equal(cached.metadataSource,'cache');assert.equal(cached.latestConfirmed,false);
  assert.equal(cached.checkedAt,selected.checkedAt);assert.deepEqual(f.requests,expected);
});

test('default-source fixture rejects foreign host, project, tag and query routes even with a known basename',async t=>{
  const f=releaseFixture(t),canonical=f.release.assets.find(asset=>asset.name==='release-manifest.json').browser_download_url;
  const physical=sourceCandidates(canonical).find(source=>source.id==='jihulab').url;
  const latest=sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest')
    .find(source=>source.id==='jihulab').url;
  const foreignProject=new URL(physical);foreignProject.pathname=foreignProject.pathname.replace(/\/projects\/[1-9][0-9]*\//,'/projects/1/');
  assert.notEqual(foreignProject.href,physical);
  for(const url of [physical.replace('https://jihulab.com/','https://untrusted.example/'),foreignProject.href,
    physical.replace('/v2.4.2/','/v2.4.3/'),physical+'?unsealed=1',physical+'#fragment',
    latest.replace('/LoveMaker-art/nora-tavern/','/another-owner/nora-tavern/'),
    canonical.replace('/LoveMaker-art/noras-tavern/','/another-owner/noras-tavern/'),
    'https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/v2.4.3'])
    await assert.rejects(f.fetcher(url),/Fixture rejected an unsealed resource/,url);
  assert.equal(fs.existsSync(f.options.cacheRoot),false);
});

test('current default JihuLab fixed tag selection rejects a different manifest version before asset preparation',async t=>{
  const f=releaseFixture(t);
  f.bytes['release-manifest.json']=JSON.stringify({...f.manifest,versions:{tavern:'2.4.3'}});
  await assert.rejects(releases.selectPlan({...f.options,tag:f.release.tag_name}),
    error=>error.userCode==='RELEASE_COMPATIBILITY'&&error.site==='release.verify');
  assert.ok(f.requests.every(url=>new URL(url).origin==='https://jihulab.com'));
  assert.equal(fs.existsSync(f.options.cacheRoot),false);
});

test('a selected release survives latest changing and prepares the exact launcher without re-selecting metadata',async t=>{
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

test('independent updater selects, seals and downloads components without an APP version or handoff',async t=>{
  const f=releaseFixture(t),updaterCapabilities={...f.manifest.launcherCapabilities};
  f.manifest.launcherVersion='99.0.0';f.manifest.bootstrap.minimumLauncherVersion='99.0.0';
  f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
  f.bytes.SHA256SUMS=Object.entries(f.bytes).filter(([name])=>name!=='SHA256SUMS').map(([name,bytes])=>`${sha(bytes)}  ${name}`).join('\n');
  const options={...f.options,platform:'linux',arch:'x64',launcherVersion:undefined,client:'updater',updaterCapabilities};
  const selected=await releases.selectPlan(options);
  assert.equal(selected.client,'updater');assert.equal(selected.launcherManifest,null);
  assert.equal(selected.platform,'linux');
  assert.ok(!f.requests.some(url=>url.includes('nora-launcher-')||url.includes('nora-system-')));
  const checked=await releases.check(options);
  assert.equal(checked.updateSupported,true);assert.equal(checked.available,true);assert.equal(checked.launcherUpdateAvailable,false);
  const operationDirectory=path.join(f.root,'operations',crypto.randomUUID());fs.mkdirSync(operationDirectory,{recursive:true});
  const sealed=releases.sealPlan(selected,{...options,operationDirectory,assertOwner:()=>{}});
  assert.equal(releases.validatePlan(sealed,{...options,operationDirectory}).client,'updater');
  assert.throws(()=>releases.validatePlan(sealed,{...f.options,operationDirectory}),/客户端|client|固定发布计划/);
  const prepared=await releases.prepareUpdate({...options,selectedPlan:sealed,operationDirectory,
    plan:async()=>({version:'2.4.2',archives:[{name:'app.tar.gz',sha256:sha('app')}]})});
  assert.equal(fs.readFileSync(path.join(prepared,'app.tar.gz'),'utf8'),'app');
});

test('independent updater full system preparation checks actual executor capabilities and skips only APP requirements',async t=>{
  const f=fullInstallFixture(t),updaterCapabilities={...f.manifest.launcherCapabilities};
  f.manifest.launcherVersion='99.0.0';f.manifest.bootstrap.minimumLauncherVersion='99.0.0';
  f.manifest.updaterCapabilities=updaterCapabilities;
  f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
  f.system.minimumLauncherVersion='99.0.0';f.system.updaterCapabilities=updaterCapabilities;
  f.system.files['release-manifest.json']={asset:'release-manifest.json',sha256:sha(f.bytes['release-manifest.json']),size:Buffer.byteLength(f.bytes['release-manifest.json'])};
  refreshFullFixture(f);
  const options={...f.options,launcherVersion:undefined,client:'updater',updaterCapabilities,mode:'install'};
  const selected=await releases.selectPlan(options);
  assert.equal(selected.launcherManifest,null);
  const prepared=await releases.prepareInstall({...options,selectedPlan:selected});
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared,'release-manifest.json'),'utf8')).commit,f.manifest.commit);
  assert.ok(!f.requests.some(url=>url.includes('nora-launcher-')));
  for(const actual of [undefined,{...updaterCapabilities,executorProtocol:'nora-operation-executor/2'}])
    await assert.rejects(releases.selectPlan({...options,updaterCapabilities:actual}),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
  const incompatible={...f.manifest,updaterCapabilities:{...updaterCapabilities,executorProtocol:'nora-operation-executor/2'}};
  assert.throws(()=>releases.validateUpdate(incompatible,f.release,undefined,options),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
  assert.throws(()=>releases.validateUpdate({...f.manifest,updaterCapabilities:null},f.release,undefined,options),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
  assert.throws(()=>releases.validateUpdate(f.manifest,f.release,'2.0.0'),/升级启动器/);
});

test('independent updater accepts historical shared-asset contracts without weakening platform manifest identity',async()=>{
  const f=publishedSharedFixture(),updaterCapabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
  const options={...f.options,launcherVersion:undefined,client:'updater',updaterCapabilities,platform:'darwin',arch:'arm64'};
  const selected=await releases.selectPlan({...options,mode:'install'});
  assert.equal(selected.releaseManifestText,f.files['darwin-arm64-release-manifest.json']);
  assert.equal(selected.client,'updater');assert.equal(selected.launcherManifest,null);
  const references=releases.validateAssetReferences(selected.release);
  assert.ok(references.assets.length>0);
  assert.throws(()=>releases.validatePlan(selected,{...options,arch:'x64'}),/固定发布计划/);
  const components=await releases.selectPlan({...options,platform:'linux',arch:'x64',mode:'update'});
  assert.equal(components.releaseManifestText,f.files['release-manifest.json']);
  assert.equal(components.systemManifest,null);assert.equal(components.launcherManifest,null);
});

test('candidate updater plans require explicit matching local files and retain candidate identity through download',async t=>{
  const f=releaseFixture(t);f.manifest.candidate=true;
  f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
  f.bytes.SHA256SUMS=Object.entries(f.bytes).filter(([name])=>name!=='SHA256SUMS').map(([name,bytes])=>`${sha(bytes)}  ${name}`).join('\n');
  const local=path.join(f.root,'candidate-release');fs.mkdirSync(local);
  for(const [name,bytes] of Object.entries(f.bytes))fs.writeFileSync(path.join(local,name),bytes);
  const options={...f.options,launcherVersion:undefined,platform:'linux',client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES};
  await assert.rejects(releases.selectPlan({...options,allowCandidate:true}));
  await assert.rejects(releases.selectPlan({...options,explicitLocalRelease:local}));
  await assert.rejects(releases.selectPlan({...options,client:undefined,allowCandidate:true,explicitLocalRelease:local}));
  const accepted={...options,allowCandidate:true,explicitLocalRelease:local};
  const selected=await releases.selectPlan(accepted);
  assert.equal(selected.releaseManifest.candidate,true);
  assert.deepEqual(selected.candidateAcceptance,{schema:'nora-local-candidate/1',releaseDirectory:local});
  const operationDirectory=path.join(f.root,'operations',crypto.randomUUID());fs.mkdirSync(operationDirectory,{recursive:true});
  const sealed=releases.sealPlan(selected,{...accepted,operationDirectory,assertOwner:()=>{}});
  assert.throws(()=>releases.validatePlan(sealed,{...options,operationDirectory}),/候选计划/);
  const prepared=await releases.prepareUpdate({...accepted,operationDirectory,selectedPlan:sealed,
    plan:async()=>({version:'2.4.2',archives:[{name:'app.tar.gz',sha256:sha('app')}]})});
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared,'release-manifest.json'),'utf8')).candidate,true);
  fs.writeFileSync(path.join(local,'release-manifest.json'),JSON.stringify({...f.manifest,commit:'b'.repeat(40)}));
  await assert.rejects(releases.selectPlan(accepted),/本地验收文件/);
});

function platformInstallFixture(t) {
  const f=fullInstallFixture(t),name='win32-x64-release-manifest.json';
  f.bytes[name]=JSON.stringify({...f.manifest,platformPayload:'win32-x64'})+'\n';
  f.system.files['release-manifest.json']={asset:name,sha256:sha(f.bytes[name]),size:Buffer.byteLength(f.bytes[name])};
  refreshFullFixture(f);return f;
}

test('platform installation uses sealed bytes and only refreshes the exact fixed manifest as source evidence',async t=>{
  const f=platformInstallFixture(t),selectedPlan=await releases.selectPlan({...f.options,mode:'install'});
  const forbidden=new Set(['release-manifest.json','nora-system-win32-x64.json','nora-launcher-win32-x64.json']),manifestReads=[];
  const directory=await releases.prepareInstall({...f.options,bundledRoot:path.join(f.root,'no-bundle'),selectedPlan,
    fetcher:async url=>{assert.ok(!url.includes('api.github.com')&&!forbidden.has(url.split('/').at(-1)));if(url.endsWith('/win32-x64-release-manifest.json'))manifestReads.push(url);return f.fetcher(url);}});
  assert.equal(fs.readFileSync(path.join(directory,'release-manifest.json'),'utf8'),selectedPlan.releaseManifestText);
  assert.notEqual(selectedPlan.releaseManifestText,f.bytes['release-manifest.json']);
  assert.equal(manifestReads.length,1,'a new execution refreshes source evidence once, without replacing its sealed payload');
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
    assert.deepEqual(requests.map(url=>f.resourceName(url)),['latest','nora-system-win32-x64.json']);
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
    assert.deepEqual(requests.map(url=>f.resourceName(url)),['latest','nora-system-win32-x64.json','win32-x64-release-manifest.json']);
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
      const resource=fixtureResource(url,f.release,{sources});
      return fixtureResponse(resource.kind==='release'?JSON.stringify(f.release):f.bytes[resource.name],url);
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
  assert.equal(requests.filter(url=>url.startsWith('https://primary.example/')).length,1,'the fixed-manifest probe encounters the unavailable source only once');
  assert.ok(requests.slice(1).every(url=>url.startsWith('https://github.com/')),'the remaining assets reuse this execution’s fully received fixed-manifest source');
});

test('release and manifest selection share one total metadata budget',async t=>{
  const f=releaseFixture(t);let clock=1000;
  await assert.rejects(releases.selectPlan({...f.options,networkPolicy:{sources:githubOnly,now:()=>clock,totalBudgetMs:100,backoffMs:[0,0]},
    fetcher:async(url,options)=>{clock+=60;return f.fetcher(url,options);}}),error=>error.code==='TIMEOUT');
});

test('first installation shares the release lookup budget with manifest selection before choosing a plan',async t=>{
  const f=fullInstallFixture(t),requests=[];let clock=1000,selected=0;
  await assert.rejects(releases.prepareInstall({...f.options,networkPolicy:{sources:githubOnly,now:()=>clock,totalBudgetMs:100,backoffMs:[0,0]},
    onPlan:async()=>{selected++;},fetcher:async(url,options)=>{
      requests.push(url);clock+=60;return f.fetcher(url,options);
    }}),error=>error.code==='TIMEOUT');
  assert.equal(selected,0,'budget exhaustion cannot freeze an incomplete plan');
  assert.equal(requests.length,2,'the latest lookup must not grant manifest selection another full budget');
  assert.ok(requests[0].endsWith('/releases/latest'));assert.ok(requests[1].endsWith('/nora-system-win32-x64.json'));
  assert.equal(fs.existsSync(f.options.cacheRoot),false,'no asset transfer starts without a complete fixed plan');
});

for(const flow of ['install','components','launcher'])test(`${flow} keeps the operation source hint while metadata deadlines do not bound full downloads`,async t=>{
  const f=fullInstallFixture(t),network=require(path.join(modules,'release-network'));
  const sourceContext=network.createReleaseSourceContext(),requests=[];
  const sources={schema:1,primary:'github',mirrors:[{id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]};
  let clock=1000,assetRead=false;
  const policy={sourceContext,sources,now:()=>clock,backoffMs:[0,0]};
  const metadataNames=new Set(['nora-system-win32-x64.json','release-manifest.json','nora-launcher-win32-x64.json']);
  const fetcher=async(url,options)=>{
    requests.push(url);
    if(url.includes('api.github.com/')){clock+=10000;return f.fetcher(url,options);}
    const name=f.resourceName(url,{sources});
    if(metadataNames.has(name)){
      clock+=10000;
      if(url.startsWith('https://github.com/'))return new Response('not reachable',{status:503});
    }else{
      assetRead=true;
      assert.ok(url.startsWith('https://downloads.sourceforge.net/'),'a full network metadata success must influence the same operation');
    }
    return new Response(f.bytes[name],{headers:{ETag:'"fixture-v1"','Content-Length':String(Buffer.byteLength(f.bytes[name]))}});
  };
  const options={...f.options,fetcher,networkPolicy:policy,
    onEvent:event=>{if(event.stage_id==='download')clock=Math.max(clock,200001);}};
  if(flow==='install'){
    const root=await releases.prepareInstall({...options,bundledRoot:path.join(f.root,'absent-bundle')});
    assert.equal(fs.readFileSync(path.join(root,'runtime.tar.gz'),'utf8'),'runtime');
  }else if(flow==='components'){
    const root=await releases.prepareUpdate({...options,launcherVersion:'2.0.2',
      plan:async()=>({version:'2.4.2',archives:[{name:'app.tar.gz',sha256:sha('app')}]})});
    assert.equal(fs.readFileSync(path.join(root,'app.tar.gz'),'utf8'),'app');
  }else{
    const prepared=await launcher.prepare(options);
    assert.equal(fs.readFileSync(prepared.launcher.archive,'utf8'),'archive');
  }
  assert.ok(assetRead);assert.ok(clock>101000,'the transfer is exercised after the original shared 100-second metadata deadline');
  assert.equal(policy.deadlineAt,undefined,'selection must not mutate the base operation policy');
  assert.equal(policy.sourceContext,sourceContext);
  assert.equal(sourceContext.preferredSource(f.release.assets.find(asset=>asset.name===f.item.asset).browser_download_url),'sourceforge');
  assert.equal(requests.filter(url=>url.startsWith('https://github.com/')).length,1,'later metadata and full assets share the already successful existing source');
});

test('main creates one fresh source context per execution and passes it to every selection and preparation path',()=>{
  const vm=require('node:vm'),{parse}=require(path.join(source,'node_modules/acorn'));
  const text=fs.readFileSync(path.join(source,'main.js'),'utf8'),tree=parse(text,{ecmaVersion:'latest'}),nodes=[];
  const walk=node=>{if(!node||typeof node!=='object')return;if(node.type)nodes.push(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);};walk(tree);
  const execute=nodes.find(node=>node.type==='VariableDeclarator'&&node.id.name==='executeAction').init;
  const inner=[];const collect=node=>{if(!node||typeof node!=='object')return;if(node.type)inner.push(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object')collect(value);};collect(execute);
  const declaration=inner.filter(node=>node.type==='VariableDeclarator'&&node.id.name==='networkPolicy');assert.equal(declaration.length,1);
  const network=require(path.join(modules,'release-network'));
  const initializer='('+text.slice(declaration[0].init.start,declaration[0].init.end)+')';
  const first=vm.runInNewContext(initializer,{require:name=>{assert.equal(name,'./release-network');return network;}});
  const second=vm.runInNewContext(initializer,{require:()=>network});
  assert.notEqual(first.sourceContext,second.sourceContext,'resumed/handoff executions do not inherit a previous source preference');
  const expected=new Map([['releases.selectPlan',1],['launcherUpdate.prepare',1],['releases.prepareInstall',2],['releases.prepareUpdate',1]]);
  for(const [callee,count]of expected){
    const calls=inner.filter(node=>node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&`${node.callee.object.name}.${node.callee.property.name}`===callee);
    assert.equal(calls.length,count,callee);
    for(const call of calls){const property=call.arguments[0].properties.find(p=>p.key?.name==='networkPolicy');assert.equal(property?.value?.name,'networkPolicy',`${callee} must receive the one execution-owned policy`);}
  }
  assert.equal(inner.filter(node=>node.type==='AssignmentExpression'&&node.left.object?.name==='networkPolicy').length,0,'main does not install a selector deadline on the execution policy');
});

for(const flow of ['install','components','launcher'])test(`${flow} resumed sealed plan establishes fresh exact source evidence without looking up latest`,async t=>{
  const f=fullInstallFixture(t),network=require(path.join(modules,'release-network'));
  const metadataCache=releases.createMetadataCache({ttlMs:60000});
  const selected=await releases.selectPlan({...f.options,metadataCache,mode:flow==='install'?'install':'update'});
  const operationDirectory=path.join(f.root,'operations',crypto.randomUUID());fs.mkdirSync(operationDirectory,{recursive:true});
  const saved=releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{}}),requests=[];
  const options={...f.options,metadataCache,operationDirectory,selectedPlan:JSON.parse(JSON.stringify(saved)),
    networkPolicy:{sourceContext:network.createReleaseSourceContext(),sources:{schema:1,primary:'github',mirrors:[{id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]}},
    fetcher:async(url,request)=>{
      requests.push(url);assert.ok(!url.includes('api.github.com'),'the sealed target must survive latest changing');
      const name=f.resourceName(url,{sources:options.networkPolicy.sources});assert.notEqual(name,'nora-launcher-win32-x64.json');
      assert.equal(new Headers(request.headers).get('if-none-match'),null,'fixed source proof is fresh full bytes, not a TTL/304 shortcut');
      if(url.startsWith('https://github.com/')){assert.equal(name,'release-manifest.json');return new Response('unavailable',{status:503});}
      return new Response(f.bytes[name],{headers:{'Content-Length':String(Buffer.byteLength(f.bytes[name]))}});
    }};
  let result;
  if(flow==='install')result=await releases.prepareInstall({...options,bundledRoot:path.join(f.root,'no-bundle')});
  else if(flow==='components')result=await releases.prepareUpdate({...options,launcherVersion:'2.0.2',plan:async()=>({version:'2.4.2',archives:[{name:'app.tar.gz',sha256:sha('app')}]})});
  else result=await launcher.prepare(options);
  assert.deepEqual(requests.slice(0,2),['https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/release-manifest.json','https://downloads.sourceforge.net/project/nora-tavern/v2.4.2/release-manifest.json']);
  assert.ok(requests.slice(2).every(url=>url.startsWith('https://downloads.sourceforge.net/')));
  assert.equal(requests.filter(url=>url.endsWith('/release-manifest.json')).length,2,'the source probe is attempted once for this execution');
  if(flow!=='components'){
    const cached={...options,networkPolicy:{...options.networkPolicy,sourceContext:network.createReleaseSourceContext()},fetcher:async()=>{throw Error('complete verified cache must remain usable offline');}};
    if(flow==='install')assert.equal(await releases.prepareInstall(cached),result);
    else assert.equal((await launcher.prepare(cached)).launcher.archive,result.launcher.archive);
  }
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
    f.manifest.fixtureRevision=attempt;f.bytes['release-manifest.json']=JSON.stringify(f.manifest);
    const selected=await releases.selectPlan(f.options);
    if(attempt<4)last=releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{}});
    else assert.throws(()=>releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{}}),/安全上限/);
  }
  assert.notEqual(saved.manifestRef.file,last.manifestRef.file);assert.equal(sha(fs.readFileSync(originalFile)),originalSha);
  assert.deepEqual(releases.sealPlan(last,{...f.options,operationDirectory,assertOwner:()=>{}}),last);
  assert.equal(fs.readdirSync(path.dirname(originalFile)).length,4);
});

test('GUI discovers an APP-only update independently of its content updater plan',async t=>{
  const f=releaseFixture(t);fs.writeFileSync(path.join(f.root,'tavern-updates/installed.json'),JSON.stringify({version:'2.4.2'}));
  const checked=await releases.check({...f.options,client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES,launcherDiscovery:true});
  assert.equal(checked.state,'available');assert.equal(checked.available,true);assert.equal(checked.releaseAvailable,false);
  assert.equal(checked.launcherUpdateAvailable,true);assert.equal(checked.launcherLatest,'2.0.2');
  assert.equal(checked.releasePlan.client,'updater');assert.equal(checked.releasePlan.launcherManifest,null);
});
test('a failed APP-only metadata query cannot block a valid content update',async t=>{
  const f=releaseFixture(t);
  const checked=await releases.check({...f.options,client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES,launcherDiscovery:true,
    fetcher:async(url,options)=>{if(String(url).includes('nora-launcher-'))return new Response('missing',{status:404});return f.fetcher(url,options);},
    networkPolicy:{sources:githubOnly,backoffMs:[0]}});
  assert.equal(checked.state,'available');assert.equal(checked.available,true);assert.equal(checked.updateSupported,true);
  assert.equal(checked.launcherUpdateAvailable,false);assert.ok(checked.launcherError);
  assert.equal(checked.error,undefined);assert.equal(checked.compatibilityError,'');
});

test('an unavailable APP check does not claim all components are current',async t=>{
  const f=releaseFixture(t);fs.writeFileSync(path.join(f.root,'tavern-updates/installed.json'),JSON.stringify({version:'2.4.2'}));
  const checked=await releases.check({...f.options,client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES,launcherDiscovery:true,
    fetcher:async(url,options)=>String(url).includes('nora-launcher-')?new Response('missing',{status:404}):f.fetcher(url,options),
    networkPolicy:{sources:githubOnly,backoffMs:[0]}});
  assert.equal(checked.state,'unavailable');assert.equal(checked.available,false);assert.equal(checked.updateSupported,true);assert.ok(checked.launcherError);
});

test('a failed content capability check preserves its actual failure during optional APP discovery',async t=>{
  const f=releaseFixture(t);
  const checked=await releases.check({...f.options,client:'updater',updaterCapabilities:{},launcherDiscovery:true});
  assert.equal(checked.state,'blocked');assert.equal(checked.available,false);assert.equal(checked.updateSupported,false);
  assert.ok(checked.compatibilityError.includes('维护协议不兼容'));assert.equal(checked.diagnosticError.cause.userCode,'RELEASE_EXECUTOR_INCOMPATIBLE');
});
