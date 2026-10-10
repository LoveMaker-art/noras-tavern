const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const releases = require('../installer/desktop/releases');
const launcher = require('../installer/desktop/launcher-update');
const {sourceCandidates,validateSourceResponse} = require('../installer/desktop/release-sources');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const repository = 'LoveMaker-art/noras-tavern';
const capabilities = {operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t,platform='win32',arch='x64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'nora-shared-assets-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const tag = 'v2.4.6', baseline = 'v2.4.5', commit = 'b'.repeat(40);
  const url = (name,source=tag) => `https://github.com/${repository}/releases/download/${source}/${name}`;
  const zip = `Nora-Tavern-Launcher-2.1.2-${platform}-${arch}-update.zip`;
  const oldFiles = {'hermes.tar.gz':'same environment','deps.tar.gz':'same dependencies',
    'nora-tavern-module-changed.tar.gz':'shared business component',[zip]:'same launcher update'};
  const files = {'nora-tavern-app.tar.gz':'app','nora-tavern-ops.tar.gz':'ops','nora-tavern-nora-mcp.tar.gz':'mcp',
    'nora-tavern-first-install-bootstrap.py':'first bootstrap','first-install-manifest.json':'{}','tavern-updater-bootstrap.py':'bootstrap',
    'nora-hermes-runtime.json':JSON.stringify({schema:1,platform,arch,archive:'hermes.tar.gz',sha256:sha(oldFiles['hermes.tar.gz'])}),
    'nora-tavern-dependencies.json':JSON.stringify({schema:1,platform,arch,archive:'deps.tar.gz',sha256:sha(oldFiles['deps.tar.gz'])})};
  files[zip]=oldFiles[zip];delete oldFiles[zip];
  const manifest = {schema:'tavern-release/v2',candidate:false,commit,versions:{tavern:tag.slice(1)},launcherVersion:'2.1.2',
    launcherCapabilities:capabilities,bootstrap:{managedComponents:1,minimumLauncherVersion:'2.1.2',sha256:sha(files['tavern-updater-bootstrap.py'])},
    archives:{app:{name:'nora-tavern-app.tar.gz',sha256:sha(files['nora-tavern-app.tar.gz']),size:Buffer.byteLength(files['nora-tavern-app.tar.gz'])}},
    modules:{changed:{name:'nora-tavern-module-changed.tar.gz',sha256:sha(oldFiles['nora-tavern-module-changed.tar.gz']),size:Buffer.byteLength(oldFiles['nora-tavern-module-changed.tar.gz'])}}};
  files['release-manifest.json'] = JSON.stringify(manifest);
  files.SHA256SUMS = Object.entries({...files,...oldFiles}).map(([name,bytes]) => `${sha(bytes)}  ${name}`).join('\n')+'\n';
  const system = {schema:'nora-system/v1',candidate:false,channel:'stable',platform,arch,commit,version:tag.slice(1),
    launcherVersion:'2.1.2',minimumLauncherVersion:'2.1.2',launcherCapabilities:capabilities,
    files:Object.fromEntries(Object.entries({...files,'hermes.tar.gz':oldFiles['hermes.tar.gz'],'deps.tar.gz':oldFiles['deps.tar.gz']})
      .map(([name,bytes]) => [name,{asset:name,sha256:sha(bytes),size:Buffer.byteLength(bytes)}]))};
  files[`nora-system-${platform}-${arch}.json`] = JSON.stringify(system);
  const index = {schema:'nora-release-assets/1',repository,tag,commit,minimumLauncherVersion:'2.1.2',
    assets:Object.entries(oldFiles).map(([name,bytes]) => ({name,asset_release_tag:baseline,size:Buffer.byteLength(bytes),sha256:sha(bytes)}))};
  const release = {tag_name:tag,draft:false,prerelease:false,assets:[]};
  function reseal() {
    files['release-assets.json'] = JSON.stringify(index)+'\n';
    release.assets = Object.entries(files).map(([name,bytes]) => ({name,state:'uploaded',size:Buffer.byteLength(bytes),
      digest:`sha256:${sha(bytes)}`,browser_download_url:url(name)}));
  }
  reseal();
  const requests = [];
  const fetcher = async value => {
    const parsed = new URL(value);requests.push(String(value));
    if (parsed.hostname === 'api.github.com') return new Response(JSON.stringify(release));
    const name = parsed.pathname.split('/').pop();
    const source = parsed.pathname.split('/').at(-2);
    const bytes = source === baseline ? oldFiles[name] : source === tag ? files[name] : undefined;
    assert.notEqual(bytes,undefined,`Unplanned download: ${value}`);
    return new Response(bytes);
  };
  return {root,tag,baseline,commit,url,zip,files,oldFiles,manifest,system,index,release,reseal,requests,fetcher,
    options:{cacheRoot:path.join(root,'cache'),launcherVersion:'2.1.2',platform,arch,fetcher}};
}

test('legacy URL validation stays strict; only a verified current release index enables an old tag',async t => {
  const f = fixture(t),name='hermes.tar.gz';
  assert.throws(() => releases.assetUrl({tag_name:f.tag,assets:[{name,browser_download_url:f.url(name,f.baseline)}]},name),/缺少完整组件/);
  const selected = await releases.latest(f.fetcher,undefined,'stable',undefined,{withEvidence:true});
  assert.equal(selected.release.tag_name,f.tag);
  assert.equal(selected.latestConfirmed,true);
  assert.equal(releases.assetUrl(selected.release,name),f.url(name,f.baseline));
  assert.equal(releases.validateAssetReferences(selected.release).commit,f.commit);
  assert.deepEqual(f.requests,[`https://api.github.com/repos/${repository}/releases/latest`,f.url('release-assets.json')]);
  const legacy = {...f.release,assets:f.release.assets.filter(item=>item.name!=='release-assets.json')};
  const current = await releases.latest(async()=>new Response(JSON.stringify(legacy)));
  assert.equal(current.assetIndexText,undefined);
  assert.equal(releases.assetUrl(current,'release-manifest.json'),f.url('release-manifest.json'));
});

test('shared update freezes the new version while fetching the same verified old asset through SourceForge',async t => {
  const f = fixture(t),name='nora-tavern-module-changed.tar.gz',oldURL=f.url(name,f.baseline);
  const notices = [];
  const fetcher = async (url,options) => {
    if (url===oldURL) {f.requests.push(url);return new Response('forbidden',{status:403});}
    return f.fetcher(url,options);
  };
  const root = await releases.prepareUpdate({...f.options,fetcher,onEvent:event=>notices.push(event),
    plan:async directory => {
      assert.equal(fs.readFileSync(path.join(directory,'tavern-updater-bootstrap.py'),'utf8'),f.files['tavern-updater-bootstrap.py']);
      return {version:f.tag,archives:[{name,sha256:sha(f.oldFiles[name])}]};
    }});
  assert.equal(fs.readFileSync(path.join(root,name),'utf8'),f.oldFiles[name]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json'))).commit,f.commit);
  assert.ok(f.requests.includes(oldURL));
  assert.ok(f.requests.includes(`https://downloads.sourceforge.net/project/nora-tavern/${f.baseline}/${name}`));
  assert.ok(!f.requests.some(url=>url.endsWith('/hermes.tar.gz')||url.endsWith('/deps.tar.gz')));
  assert.ok(notices.some(event=>event.event==='log'&&event.line.includes('sourceforge')));
});

for (const [platform,arch] of [['win32','x64'],['darwin','arm64'],['darwin','x64']])
  test(`${platform}-${arch}: cold prepare accepts old environments but keeps the new system identity`,async t => {
    const f = fixture(t,platform,arch);
    const prepared = await releases.prepare(f.options);
    assert.equal(fs.readFileSync(path.join(prepared,'hermes.tar.gz'),'utf8'),f.oldFiles['hermes.tar.gz']);
    const identity = JSON.parse(fs.readFileSync(path.join(prepared,'nora-system.json')));
    assert.equal(identity.version,f.tag.slice(1));assert.equal(identity.commit,f.commit);
    assert.ok(f.requests.includes(f.url('hermes.tar.gz',f.baseline)));
    assert.ok(f.requests.includes(f.url('deps.tar.gz',f.baseline)));
  });

test('compatible bundled environment bytes are reused without a remote environment transfer',async t => {
  const f = fixture(t),bundledRoot=path.join(f.root,'bundled');fs.mkdirSync(bundledRoot);
  for (const name of ['hermes.tar.gz','deps.tar.gz']) fs.writeFileSync(path.join(bundledRoot,name),f.oldFiles[name]);
  await releases.prepare({...f.options,bundledRoot});
  assert.ok(!f.requests.some(url=>url.endsWith('/hermes.tar.gz')||url.endsWith('/deps.tar.gz')));
});

test('the current-tag bridge launcher ZIP must agree with the current release digest and size',async t => {
  const f = fixture(t),release=await releases.latest(f.fetcher);
  const item={schema:'nora-launcher/v1',candidate:false,platform:'win32',arch:'x64',version:'2.1.2',
    asset:f.zip,size:Buffer.byteLength(f.files[f.zip]),sha256:sha(f.files[f.zip])};
  assert.equal(launcher.validateManifest(item,{release,manifest:f.manifest,platform:'win32',arch:'x64'}),item);
  for (const changed of [{size:item.size+1},{sha256:'c'.repeat(64)}])
    assert.throws(()=>launcher.validateManifest({...item,...changed},{release,manifest:f.manifest,platform:'win32',arch:'x64'}),/校验信息/);
});

test('a shared release gates old 2.1.1 clients and rejects a mismatched commit or advertised minimum',async t => {
  const f = fixture(t),release=await releases.latest(f.fetcher);
  assert.throws(()=>releases.validateUpdate(f.manifest,release,'2.1.1'),/升级启动器/);
  assert.throws(()=>releases.validateSystem(f.system,release,'win32','x64','2.1.1'),/升级启动器/);
  for (const manifest of [{...f.manifest,commit:'c'.repeat(40)},
    {...f.manifest,bootstrap:{...f.manifest.bootstrap,minimumLauncherVersion:'2.1.1'}}])
    assert.throws(()=>releases.validateUpdate(manifest,release,'2.1.2'),/门槛/);
  assert.throws(()=>releases.validateUpdate({...f.manifest,modules:{changed:{...f.manifest.modules.changed,sha256:'c'.repeat(64)}}},release,'2.1.2'),/校验信息/);
});

test('tampered bytes, duplicate or colliding references, arbitrary URLs and unsafe source identities fail before payload downloads',async t => {
  const changes = [
    f=>{f.files['release-assets.json']+=' ';},
    f=>{f.index.repository='other/repository';f.reseal();},
    f=>{f.index.minimumLauncherVersion='2.1.1';f.reseal();},
    f=>{f.index.assets[0].asset_release_tag='v2.4.7';f.reseal();},
    f=>{f.index.assets[0].asset_release_tag=f.tag;f.reseal();},
    f=>{f.index.assets[0].asset_release_tag='v2.4.5-beta.1';f.reseal();},
    f=>{f.index.assets[0].sha256='invalid';f.reseal();},
    f=>{f.index.assets[0].size=0;f.reseal();},
    f=>{f.index.assets[0].url='https://evil.example/runtime';f.reseal();},
    f=>{f.index.assets[0].name='release-manifest.json';f.reseal();},
    f=>{f.index.assets[0].name='darwin-arm64-release-manifest.json';f.reseal();},
    f=>{f.index.assets[0].name='darwin-arm64-SHA256SUMS';f.reseal();},
    f=>{f.index.assets[0].name='darwin-arm64-first-install-manifest.json';f.reseal();},
    f=>{f.index.assets[0].name='darwin-arm64-nora-tavern-first-install-bootstrap.py';f.reseal();},
    f=>{f.index.assets[0].name='darwin-arm64-tavern-updater-bootstrap.py';f.reseal();},
    f=>{f.index.assets[0].name=f.zip;f.reseal();},
    f=>{f.index.assets[0].name='first-install-manifest.json';f.reseal();},
    f=>{f.index.assets.push({...f.index.assets[0]});f.reseal();},
    f=>{f.files['hermes.tar.gz']=f.oldFiles['hermes.tar.gz'];f.reseal();}
  ];
  for (const change of changes) {
    const f = fixture(t);change(f);
    await assert.rejects(releases.latest(f.fetcher));
    assert.ok(f.requests.length<=2,'An invalid index must not start payload requests');
  }
});

test('SourceForge uses the referenced object tag and still refuses host or path substitution',async t => {
  const f = fixture(t),release=await releases.latest(f.fetcher),url=releases.assetUrl(release,'hermes.tar.gz');
  const source=sourceCandidates(url).find(item=>item.provider==='sourceforge');
  assert.equal(source.url,`https://downloads.sourceforge.net/project/nora-tavern/${f.baseline}/hermes.tar.gz`);
  for (const substituted of [source.url.replace(f.baseline,f.tag),source.url.replace('hermes.tar.gz','other.tar.gz'),
    source.url.replace('downloads.sourceforge.net','evil.example')])
    assert.throws(()=>validateSourceResponse(source,{url:substituted}),/偏离受信任/);
});

test('sealed plans retain the index original bytes and reject changed references on resumption',async t => {
  const f = fixture(t),plan=await releases.selectPlan(f.options);
  assert.equal(plan.release.assetIndexText,f.files['release-assets.json']);
  const directory=path.join(f.root,'installer','operations','e80f33a6-8b86-4c3a-8f7f-af0edc0304b4');fs.mkdirSync(directory,{recursive:true});
  const sealed=releases.sealPlan(plan,{operationDirectory:directory,assertOwner(){},launcherVersion:'2.1.2'});
  assert.equal(releases.validatePlan(sealed,{...f.options,operationDirectory:directory}).release.assetIndexText,f.files['release-assets.json']);
  const tampered=clone(sealed);tampered.release.assetIndexText=tampered.release.assetIndexText.replace(f.baseline,'v2.4.4');
  assert.throws(()=>releases.validatePlan(tampered,{...f.options,operationDirectory:directory}),/固定发布计划/);
  const changed=clone(sealed);changed.release.assets.find(item=>item.name==='hermes.tar.gz').size++;
  assert.throws(()=>releases.validatePlan(changed,{...f.options,operationDirectory:directory}),/固定发布计划/);
});

test('index network recovery retains its original size and hash and accepts only those exact JSON bytes',async t => {
  const f=fixture(t),{create}=require('../installer/desktop/operation-policy');
  const hermesHome=path.join(f.root,'hermes'),installRoot=path.join(f.root,'tavern');fs.mkdirSync(hermesHome);fs.mkdirSync(installRoot);
  const bytes=f.files['release-assets.json'];let body=bytes;
  const policy=create({home:f.root,hermesHome,installRoot,launcherVersion:'2.1.2',platform:'win32',arch:'x64',channel:'stable',
    bridge:async()=>({}),runRuntime:async()=>{},inspectRuntime:()=>({effectState:'untouched',recoveryOutcome:'not-required'}),inspectLegacy:()=>null,
    networkFetch:async url=>{assert.equal(url,f.url('release-assets.json'));return new Response(body);}});
  const record={operationId:'57c32353-9ed1-46a0-b0ce-f76b9b381c41',kind:'install',target:{request:{tag:f.tag}}};
  const error=Object.assign(new Error('original index unavailable'),{status:503,source:'release_service',site:'release.request',
    conditionResource:{url:f.url('release-assets.json'),sha256:sha(bytes),size:Buffer.byteLength(bytes),routeHash:sha('direct-node')}});
  const condition=policy.identifyFailureCondition(error,record);
  assert.equal(condition.kind,'release-metadata');assert.equal(condition.resource.sha256,sha(bytes));
  assert.equal(condition.resource.size,Buffer.byteLength(bytes));
  record.conditionBaseline=await policy.initialConditions(record);
  assert.ok(record.conditionBaseline);
  body=bytes.replace(f.baseline,'v2.4.4');
  assert.equal((await policy.recheck(record,{conditionTarget:condition})).changed,false);
  body=bytes;
  const verified=await policy.recheck(record,{conditionTarget:condition});
  assert.equal(verified.changed,true);assert.equal(verified.baseline.facts.networkReads.length,1);
  record.conditionBaseline=verified.baseline;
  assert.equal((await policy.recheck(record,{conditionTarget:condition})).changed,false,'The consumed proof cannot grant more retries');
});
