const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const releases = process.env.NORA_RELEASES_SOURCE ? (() => {
  const Module=require('node:module'), file=require.resolve('../installer/desktop/releases');
  const candidate=new Module(file,module);candidate.filename=file;candidate.paths=Module._nodeModulePaths(path.dirname(file));
  candidate._compile(fs.readFileSync(process.env.NORA_RELEASES_SOURCE,'utf8'),file);return candidate.exports;
})() : require('../installer/desktop/releases');
const {createTelemetry} = require('../installer/desktop/telemetry');
const {sourceCandidates} = require('../installer/desktop/release-sources');
const sourceConfiguration = require('../installer/desktop/release-sources.json');
const githubOnly = {schema:1,primary:'github',mirrors:[]};
const latestUrl = 'https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest';
function fixtureResponse(body,url,options) {
  const response = new Response(body,options);
  Object.defineProperty(response,'url',{value:String(url)});
  return response;
}
const capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};

test('first install system metadata failure binds the fixed system version before launcher discovery',async t=>{
  const f=fixture(t);
  await assert.rejects(releases.selectPlan({...f.options,mode:'install',selectedRelease:f.release,
    fetcher:async()=>new Response('unavailable',{status:503}),networkPolicy:{maxAttempts:1,totalBudgetMs:1000}}),error=>{
    assert.equal(error.conditionResource.expectedSystemVersion,f.release.tag_name);
    assert.equal(error.conditionResource.expectedVersion,undefined);
    assert.equal(error.conditionResource.url,releases.assetUrl(f.release,'nora-system-darwin-arm64.json'));
    return true;
  });
});

test('standalone update check retains HTTP evidence and reports failure without changing its result contract', async t => {
  const f = fixture(t), sent = [];
  const client = createTelemetry({file:path.join(f.root,'telemetry.json'),launcherVersion:'1.1.2',automatic:false,
    fetcher:async (_url,opts) => { const data=JSON.parse(opts.body);sent.push(...data.events);return Response.json({accepted_event_ids:data.events.map(e=>e.event_id),rejected_event_ids:[]}); }});
  t.after(()=>client.close());client.setEnabled(true);
  const result = await client.track('check_update','release_check',()=>releases.check({...f.options,fetcher:async()=>new Response('PRIVATE RESPONSE',{status:403})}));
  assert.equal(result.state,'unavailable');
  await client.flush();
  const failure=sent.find(e=>e.event==='operation_finished');
  assert.equal(failure.status,'failed');assert.equal(failure.http_status,403);
  assert.equal(failure.error_code,'http_forbidden');assert.equal(failure.error_source,'release_service');
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE RESPONSE|github\.com/);
});

test('manifest request failures remain technical errors while version guards carry a business code', async t => {
  const f = fixture(t);
  for (const evidence of ['http','timeout']) {
    const result = await releases.check({...f.options,fetcher:async url=>{
      if (f.resource(url).kind === 'catalogue') return fixtureResponse(JSON.stringify(f.release),url);
      if (evidence === 'http') return fixtureResponse('private manifest reply',url,{status:403});
      throw Object.assign(new Error('private timeout fixture'),{code:'TIMEOUT'});
    }});
    assert.equal(result.state,'unavailable');
    assert.ok(result.error);
    assert.equal(result.compatibilityError,'');
    assert.equal(result.diagnosticError.userCode,undefined);
    if (evidence === 'http') assert.equal(result.diagnosticError.status,403);
    else assert.equal(result.diagnosticError.code,'TIMEOUT');
  }
  const manifest = JSON.parse(f.data['release-manifest.json']);
  manifest.bootstrap.minimumLauncherVersion = '1.2.0';
  f.data['release-manifest.json'] = JSON.stringify(manifest);
  const blocked = await releases.check(f.options);
  assert.equal(blocked.diagnosticError.userCode,'RELEASE_COMPATIBILITY');
  assert.match(blocked.diagnosticError.cause.message,/1\.2\.0/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundledRoot = path.join(root, 'payload'); fs.mkdirSync(bundledRoot);
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const commit = 'a'.repeat(40);
  const data = {
    'release-manifest.json': JSON.stringify({ schema: 'tavern-release/v2', commit, launcherCapabilities:capabilities,versions: { tavern: '2.2.8' },
      bootstrap: { sha256: sha('updater'), managedComponents: 1, minimumLauncherVersion: '0.1.0' } }),
    'SHA256SUMS': 'checksums', 'nora-tavern-app.tar.gz': 'app', 'nora-tavern-ops.tar.gz': 'ops',
    'nora-tavern-nora-mcp.tar.gz': 'mcp', 'nora-tavern-first-install-bootstrap.py': 'bootstrap', 'first-install-manifest.json': '{}',
    'hermes.tar.gz': 'hermes', 'dependencies.tar.gz': 'deps',
    'nora-hermes-runtime.json': JSON.stringify({ platform: 'darwin', arch: 'arm64', archive: 'hermes.tar.gz', sha256: sha('hermes') }),
    'nora-tavern-dependencies.json': JSON.stringify({ platform: 'darwin', arch: 'arm64', archive: 'dependencies.tar.gz', sha256: sha('deps') }),
  };
  const system = { schema: 'nora-system/v1', version: '2.2.8', commit,launcherCapabilities:capabilities, platform: 'darwin', arch: 'arm64',
    launcherVersion: '0.1.0', minimumLauncherVersion: '0.1.0', files: {} };
  for (const [name, bytes] of Object.entries(data)) {
    fs.writeFileSync(path.join(bundledRoot, name), bytes);
    system.files[name] = { asset: `darwin-arm64-${name}`, sha256: sha(bytes), size: Buffer.byteLength(bytes) };
  }
  const names = ['release-manifest.json', 'nora-system-darwin-arm64.json', ...Object.values(system.files).map(i => i.asset)];
  const release = { tag_name: 'v2.2.8', assets: names.map(name => ({ name, browser_download_url: `https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.2.8/${name}` })) };
  const requested = [];
  const resource = address => {
    const routes = new Map();
    const admit = (canonical,identity) => {
      for (const source of sourceCandidates(canonical)) {
        assert.ok(!routes.has(source.url),'Fixture resources must not share a physical URL');
        routes.set(source.url,{...identity,canonical});
      }
    };
    admit(latestUrl,{kind:'catalogue'});
    admit('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=1',{kind:'launcher-list'});
    admit(`https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/${encodeURIComponent(release.tag_name)}`,{kind:'tag'});
    for (const asset of release.assets) {
      assert.match(asset.name,/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      const canonical = `https://github.com/LoveMaker-art/noras-tavern/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`;
      assert.equal(asset.browser_download_url,canonical,'Fixture assets belong to the selected repository and tag');
      admit(canonical,{kind:'asset',asset:asset.name});
    }
    const result = routes.get(String(address));
    assert.ok(result,'Unexpected untrusted fixture resource: '+String(address));
    return result;
  };
  const fetcher = async url => {
    requested.push(url);
    const identity = resource(url);
    if(identity.kind==='launcher-list')return fixtureResponse(JSON.stringify([release]),url);
    if (['catalogue','tag'].includes(identity.kind)) return fixtureResponse(JSON.stringify(release),url);
    if (identity.asset === 'nora-system-darwin-arm64.json') return fixtureResponse(JSON.stringify(system),url);
    const name = Object.entries(system.files).find(([,item])=>item.asset===identity.asset)?.[0] || identity.asset;
    assert.ok(Object.hasOwn(data,name),'Fixture asset must have exact owned bytes: '+identity.asset);
    return fixtureResponse(data[name],url);
  };
  return { root, bundledRoot, system, release, requested, data, resource, options: { bundledRoot, cacheRoot: path.join(root, 'cache'), installRoot: root,
    launcherVersion: '0.1.0', platform: 'darwin', arch: 'arm64', fetcher } };
}

test('default Jihu first install and explicit tag use exact channel and fixed publication metadata without GitHub fallback',async t=>{
  const f=fixture(t),primary=sourceConfiguration.mirrors.find(item=>item.id===sourceConfiguration.primary);
  assert.equal(primary.provider,'jihulab');
  const target=await releases.prepare(f.options);
  assert.deepEqual(f.requested,[new URL('channels/stable.json',primary.channelBaseUrl).href,
    new URL('v2.2.8/nora-system-darwin-arm64.json',primary.baseUrl).href]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target,'nora-system.json'))).commit,f.system.commit);
  assert.equal(fs.readFileSync(path.join(target,'nora-tavern-app.tar.gz'),'utf8'),'app');
  f.requested.length=0;
  const selected=await releases.latest(f.options.fetcher,undefined,'stable','v2.2.8');
  assert.equal(selected.tag_name,'v2.2.8');
  assert.deepEqual(f.requested,[new URL('v2.2.8/release.json',primary.baseUrl).href]);
});

test('release fixture rejects unconfigured hosts, projects, tags and query or fragment variants despite matching asset basenames',async t=>{
  const f=fixture(t),url=sourceCandidates(releases.assetUrl(f.release,'nora-system-darwin-arm64.json'))[0].url;
  const project=/\/projects\/([0-9]+)\//.exec(new URL(url).pathname);assert.ok(project);
  for(const address of [url.replace('jihulab.com','untrusted.example'),
    url.replace(`/projects/${project[1]}/`,`/projects/${project[1]==='1'?'2':'1'}/`),
    url.replace('/generic/nora-tavern/','/generic/other/'),url.replace('/v2.2.8/','/v2.2.9/'),
    url+'?external=1',url+'#external',url.replace('/nora-system-darwin-arm64.json','/unknown.json'),
    releases.assetUrl(f.release,'nora-system-darwin-arm64.json').replace('LoveMaker-art','untrusted-owner')])
    await assert.rejects(f.options.fetcher(address),/Unexpected untrusted fixture resource/);
});

test('actual check-update entry shares in-flight work and uses its persisted metadata cache',async t=>{
  const f=fixture(t),vm=require('node:vm');
  const mainFile=path.join(__dirname,'../installer/desktop/main.js');
  const source=fs.readFileSync(mainFile,'utf8');
  const ast=require('../installer/desktop/node_modules/acorn').parse(source,{ecmaVersion:'latest'});
  let callback;const definitions=new Map();
  function visit(node){if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration')definitions.set(node.id.name,node);
    if(node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value==='nora:check-update')callback=node.arguments[1];
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}}
  visit(ast);assert.ok(callback);
  let tracked=0;
  const context=vm.createContext({activeRun:false,modelBusy:false,path,fs,Date,Promise,
    releaseCheckRequest:null,releaseMetadataState:null,localReleaseDirectory:null,
    noraHome:()=>f.root,installRoot:()=>f.root,CHANNEL:'stable',app:{getVersion:()=>f.options.launcherVersion},
    releases,formatUserError:error=>error.message,
    require:name=>require(path.join(path.dirname(mainFile),name)),
    updateFetch:async(url,options)=>{await new Promise(resolve=>setTimeout(resolve,10));return f.options.fetcher(url,options);},
    trackLauncher:async(_action,_stage,work)=>{tracked++;return work();}});
  for(const name of ['releaseMetadataCache','checkRelease']){
    const node=definitions.get(name);if(node)vm.runInContext(source.slice(node.start,node.end),context);
  }
  const query=vm.runInContext(`(${source.slice(callback.start,callback.end)})`,context);
  const [one,two]=await Promise.all([query(),query()]);
  assert.equal(tracked,1,'background and manual checks must share the same operation log');
  assert.equal(one.latest,two.latest);
  assert.equal(f.requested.filter(url=>f.resource(url).canonical===latestUrl).length,1);
  const count=f.requested.length;const repeat=await query();
  assert.equal(f.requested.length,count,'a short-interval check must reuse validated metadata');
  assert.equal(repeat.latestConfirmed,false);
  assert.equal(fs.existsSync(path.join(f.root,'cache/releases/metadata.json')),true);
});
test('old published metadata is still visible but its unbound writer cannot be selected or prepared',async t=>{
  const f=fixture(t),legacy=JSON.parse(f.data['release-manifest.json']);delete legacy.launcherCapabilities;
  f.data['release-manifest.json']=JSON.stringify(legacy);
  const checked=await releases.check(f.options);
  assert.equal(checked.latest,null);assert.equal(checked.releaseTag,'v2.2.8');assert.equal(checked.state,'blocked');
  assert.equal(checked.diagnosticError.userCode,'RELEASE_EXECUTOR_INCOMPATIBLE');
  assert.equal(checked.diagnosticError.code,'VERIFICATION_FAILED');
  assert.ok(checked.diagnosticError.message.length>0);
  assert.match(require('../installer/desktop/error-presentation').formatUserError(checked.diagnosticError),/等待兼容版本/);
  assert.doesNotMatch(require('../installer/desktop/error-presentation').formatUserError(checked.diagnosticError),/下载新版完整/);
  await assert.rejects(releases.selectPlan(f.options),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
  assert.equal(fs.existsSync(f.options.cacheRoot),false);
});
test('full and offline preparation reject missing or changed executor capability before payload transfer',async t=>{
  for(const mode of ['missing','changed']){
    const f=fixture(t);
    if(mode==='missing')delete f.system.launcherCapabilities;
    else f.system.launcherCapabilities={...capabilities,executorProtocol:'nora-operation-executor/2'};
    fs.writeFileSync(path.join(f.bundledRoot,'nora-system.json'),JSON.stringify(f.system));
    await assert.rejects(releases.prepare(f.options),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
    await assert.rejects(releases.prepareBundled(f.options),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
    assert.equal(f.requested.some(url=>f.resource(url).kind==='asset'&&f.resource(url).asset!=='nora-system-darwin-arm64.json'),false);
    assert.equal(fs.existsSync(f.options.cacheRoot),false);
  }
});
test('latest is resolved once, matching packaged bytes are reused, not downloaded', async t => {
  const f = fixture(t); const target = await releases.prepare(f.options);
  assert.equal(f.requested.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'nora-system.json'))).version, '2.2.8');
});
test('first install pins latest once and downloads only the component that differs from its old installer', async t => {
  const f = fixture(t);
  const oldSystem={...f.system,version:'2.2.4',commit:'b'.repeat(40),files:{...f.system.files}};
  const oldManifest={...JSON.parse(f.data['release-manifest.json']),commit:oldSystem.commit,versions:{tavern:oldSystem.version}};
  for(const [name,bytes] of Object.entries({'nora-tavern-app.tar.gz':'older app','release-manifest.json':JSON.stringify(oldManifest)})) {
    fs.writeFileSync(path.join(f.bundledRoot,name),bytes);
    oldSystem.files[name]={...oldSystem.files[name],size:Buffer.byteLength(bytes),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  }
  fs.writeFileSync(path.join(f.bundledRoot,'nora-system.json'),JSON.stringify(oldSystem));
  await releases.prepareBundled(f.options); // The older installer is a valid complete package.
  let confirmations = 0;
  const target = await releases.prepareInstall({...f.options, confirmBundled: () => { confirmations++; return true; }});
  assert.equal(JSON.parse(fs.readFileSync(path.join(target,'nora-system.json'))).version,'2.2.8');
  assert.equal(fs.readFileSync(path.join(target,'nora-tavern-app.tar.gz'),'utf8'),'app');
  assert.equal(f.requested.filter(url => f.resource(url).canonical===latestUrl).length,1);
  assert.deepEqual(f.requested.map(url=>f.resource(url)).filter(item=>item.kind==='asset'&&item.asset!=='nora-system-darwin-arm64.json').map(item=>item.asset),
    ['darwin-arm64-release-manifest.json','darwin-arm64-nora-tavern-app.tar.gz']);
  assert.equal(confirmations,0);
});
test('first install awaits one immutable selected plan before starting payload transfer', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.bundledRoot,'nora-tavern-app.tar.gz'),'old app');
  let selected, calls=0, frozen=false;
  const fetcher=async(url,options)=>{
    if(f.resource(url).asset==='darwin-arm64-nora-tavern-app.tar.gz') assert.equal(frozen,true,'plan callback finishes before transfer');
    return f.options.fetcher(url,options);
  };
  await releases.prepareInstall({...f.options,fetcher,onPlan:async plan=>{calls++; selected=plan;
    assert.equal(plan.tag,'v2.2.8'); assert.equal(plan.mode,'install'); assert.equal(Object.isFrozen(plan.release),true);
    await Promise.resolve(); frozen=true;
  }});
  assert.equal(calls,1);assert.equal(selected.commit,f.system.commit);
  assert.equal(f.requested.filter(url=>f.resource(url).canonical===latestUrl).length,1);
});
test('offline consent freezes verified local target without calling it latest, decline never selects', async t => {
  const f=fixture(t);fs.writeFileSync(path.join(f.bundledRoot,'nora-system.json'),JSON.stringify(f.system));
  let selected,confirmed=false;
  const options={...f.options,networkPolicy:{attempts:1},fetcher:async()=>{throw new Error('offline');},
    confirmBundled:()=>{confirmed=true;return true;},onPlan:async plan=>{assert.equal(confirmed,true);selected=plan;}};
  await releases.prepareInstall(options);
  assert.equal(selected.metadataSource,'bundled');assert.equal(selected.latestConfirmed,false);
  assert.equal(selected.tag,'v2.2.8');assert.equal(selected.commit,f.system.commit);
  assert.equal(selected.manifestSha256,await releases.hash(path.join(f.bundledRoot,'release-manifest.json')));
  assert.equal(Object.isFrozen(selected),true);selected=undefined;
  await assert.rejects(releases.prepareInstall({...options,confirmBundled:()=>false}),/offline/);
  assert.equal(selected,undefined);
});
test('offline first install uses verified bundled bytes only after explicit confirmation', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundledRoot,'nora-system.json'),JSON.stringify(f.system));
  let confirmations = 0;
  const events = [];
  const root = await releases.prepareInstall({...f.options, fetcher: async () => { throw new Error('offline'); },
    confirmBundled: ({version,error}) => { confirmations++; assert.equal(version,'2.2.8'); assert.match(error.message,/offline/); return true; },
    onEvent: event => events.push(event)});
  assert.equal(root,f.bundledRoot);
  assert.equal(confirmations,1);
  assert.ok(events.some(event => /包内.*2\.2\.8/.test(event.task)));
  assert.equal(fs.existsSync(f.options.cacheRoot),false);
});
test('declining offline installation or cancelling never selects the old package', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundledRoot,'nora-system.json'),JSON.stringify(f.system));
  await assert.rejects(releases.prepareInstall({...f.options,fetcher:async()=>{throw new Error('offline');},confirmBundled:()=>false}),/offline/);
  let asked = false;
  await assert.rejects(releases.prepareInstall({...f.options,signal:AbortSignal.abort(),confirmBundled:()=>{asked=true;return true;}}),{name:'AbortError'});
  assert.equal(asked,false);
  assert.equal(fs.existsSync(f.options.cacheRoot),false);
});
test('incompatible or corrupt online releases never offer an older bundled fallback', async t => {
  for (const failure of ['incompatible','missing-platform','corrupt-download','invalid-response']) {
    const f=fixture(t);let asked=false;
    if(failure==='incompatible')f.system.minimumLauncherVersion='99.0.0';
    if(failure==='missing-platform')f.release.assets=[];
    if(failure==='corrupt-download'){
      fs.unlinkSync(path.join(f.bundledRoot,'nora-tavern-app.tar.gz'));
      f.data['nora-tavern-app.tar.gz']='corrupt';
    }
    const fetcher=failure==='invalid-response'?async()=>new Response('not json'):f.options.fetcher;
    await assert.rejects(releases.prepareInstall({...f.options,fetcher,confirmBundled:()=>{asked=true;return true;}}));
    assert.equal(asked,false,failure);
  }
});
test('a lookup deadline can offer offline installation while explicit cancellation cannot', async t => {
  const f=fixture(t);
  fs.writeFileSync(path.join(f.bundledRoot,'nora-system.json'),JSON.stringify(f.system));
  let asked=0;
  const confirmBundled=()=>{asked++;return true;};
  assert.equal(await releases.prepareInstall({...f.options,confirmBundled,fetcher:async()=>{throw new DOMException('lookup deadline','AbortError');}}),f.bundledRoot);
  assert.equal(asked,1);
  const controller=new AbortController();
  await assert.rejects(releases.prepareInstall({...f.options,confirmBundled,signal:controller.signal,
    fetcher:async()=>{controller.abort();throw controller.signal.reason;}}),{name:'AbortError'});
  assert.equal(asked,1);
});
test('bundled upgrade selects only a newer valid platform release and never downgrades', t => {
  const f = fixture(t);
  const file = path.join(f.bundledRoot, 'nora-system.json');
  fs.writeFileSync(file, JSON.stringify(f.system));
  assert.equal(releases.bundledUpgradeTarget({ ...f.options, currentVersion: '2.2.4' }), 'v2.2.8');
  for (const currentVersion of ['2.2.8', '2.3.2', '', null]) {
    assert.equal(releases.bundledUpgradeTarget({ ...f.options, currentVersion }), null);
  }
  for (const changes of [{ candidate: true }, { platform: 'win32' }, { channel: 'beta' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.system, ...changes }));
    assert.equal(releases.bundledUpgradeTarget({ ...f.options, currentVersion: '2.2.4' }), null);
  }
  fs.unlinkSync(file);
  assert.equal(releases.bundledUpgradeTarget({ ...f.options, currentVersion: '2.2.4' }), null);
});
test('historical receipt and legacy runtime versions select the new package on all platform descriptors', async t => {
  const f = fixture(t);
  const versions = ['2.2.4', '2.2.8', '2.2.11', '2.3.0', '2.3.1', '2.3.2', '2.3.3', '2.3.4', '2.3.5', '2.3.6', '2.3.7'];
  const record = path.join(f.root, 'tavern-updates', 'installed.json');
  const runtimeVersion = path.join(f.root, 'apps/tavern-runtime/.tavern-release-version');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.mkdirSync(path.dirname(runtimeVersion), { recursive: true });
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    fs.writeFileSync(path.join(f.bundledRoot, 'nora-system.json'), JSON.stringify({ ...f.system,
      version: '2.3.13', platform, arch }));
    for (const current of versions) {
      for (const schema of [1, 2, null]) {
        if (schema === null) fs.rmSync(record, { force: true });
        else fs.writeFileSync(record, JSON.stringify({ schema, version: current }));
        fs.writeFileSync(runtimeVersion, current);
        const checked = await releases.check(f.options);
        assert.equal(checked.current, current);
        assert.equal(checked.versionSource, schema === null ? 'legacy-runtime' : 'receipt');
        assert.equal(releases.bundledUpgradeTarget({ ...f.options, platform, arch,
          currentVersion: checked.current }), 'v2.3.13', `${platform}/${arch}/${current}/${schema}`);
      }
    }
  }
});
test('first install validates bundled release without requesting GitHub or creating download cache', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundledRoot, 'nora-system.json'), JSON.stringify(f.system));
  const root = await releases.prepareBundled({ ...f.options, fetcher: () => { throw new Error('offline'); } });
  assert.equal(root, f.bundledRoot);
  assert.deepEqual(f.requested, []);
  assert.equal(fs.existsSync(f.options.cacheRoot), false);
});
test('bundled install fails closed on missing or corrupt files without network fallback', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundledRoot, 'nora-system.json'), JSON.stringify(f.system));
  const file = path.join(f.bundledRoot, 'nora-tavern-app.tar.gz');
  fs.writeFileSync(file, 'bad');
  await assert.rejects(releases.prepareBundled(f.options), /组件校验失败/);
  fs.unlinkSync(file);
  await assert.rejects(releases.prepareBundled(f.options), /缺少组件/);
  assert.deepEqual(f.requested, []);
});
test('bundled install rejects wrong platform, candidate and incompatible launcher', async t => {
  const f = fixture(t);
  const file = path.join(f.bundledRoot, 'nora-system.json');
  for (const changes of [{ platform: 'win32' }, { candidate: true }, { minimumLauncherVersion: '99.0.0' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.system, ...changes }));
    await assert.rejects(releases.prepareBundled(f.options));
  }
  assert.deepEqual(f.requested, []);
});
test('bundled install honors cancellation and rejects inconsistent inner manifests', async t => {
  const f = fixture(t);
  const file = path.join(f.bundledRoot, 'nora-system.json');
  fs.writeFileSync(file, JSON.stringify(f.system));
  await assert.rejects(releases.prepareBundled({ ...f.options, signal: AbortSignal.abort() }), { name: 'AbortError' });
  f.system.commit = 'b'.repeat(40);
  fs.writeFileSync(file, JSON.stringify(f.system));
  await assert.rejects(releases.prepareBundled(f.options), /内部版本/);
});
test('older packaged component is replaced from the pinned release, never latest/download', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.bundledRoot, 'nora-tavern-app.tar.gz'), 'old');
  const target = await releases.prepare(f.options);
  assert.equal(fs.readFileSync(path.join(target, 'nora-tavern-app.tar.gz'), 'utf8'), 'app');
  assert.equal(f.resource(f.requested.at(-1)).canonical,releases.assetUrl(f.release,'darwin-arm64-nora-tavern-app.tar.gz'));
  assert.equal(f.requested.at(-1),sourceCandidates(releases.assetUrl(f.release,'darwin-arm64-nora-tavern-app.tar.gz'))[0].url);
});
test('missing platform package stops before creating install cache', async t => {
  const f = fixture(t); f.release.assets = [];
  await assert.rejects(releases.prepare(f.options), /缺少完整组件/);
  assert.equal(fs.existsSync(f.options.cacheRoot), false);
});
test('a newer release without an updater manifest is blocked', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'tavern-updates'));
  fs.writeFileSync(path.join(f.root, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.2.4' }));
  f.release.assets = [];
  const result = await releases.check(f.options);
  assert.equal(result.state, 'blocked');
  assert.equal(result.available, false);
  assert.equal(result.releaseAvailable, false);
  assert.equal(result.installable, false);
  assert.equal(result.latest,null);assert.equal(result.releaseTag,'v2.2.8');
  assert.match(result.compatibilityError, /release-manifest.json/);
});
test('an incompatible component updater is blocked', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'tavern-updates'));
  fs.writeFileSync(path.join(f.root, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.2.8' }));
  const manifest = JSON.parse(f.data['release-manifest.json']);
  manifest.bootstrap.minimumLauncherVersion = '99.0.0';
  f.data['release-manifest.json'] = JSON.stringify(manifest);
  const result = await releases.check(f.options);
  assert.equal(result.state, 'blocked');
  assert.equal(result.available, false);
  assert.match(result.compatibilityError, /升级启动器/);
});
test('corrupt downloads are rejected and incomplete file is removed', async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.bundledRoot, 'nora-tavern-app.tar.gz'));
  f.data['nora-tavern-app.tar.gz'] = 'bad';
  await assert.rejects(releases.prepare(f.options), /校验失败/);
  const directory = path.join(f.options.cacheRoot, fs.readdirSync(f.options.cacheRoot)[0]);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.partial')), false);
});
test('missing installed version is unknown, not an available update or latest', async t => {
  const f = fixture(t); const result = await releases.check(f.options);
  assert.equal(result.state, 'unknown'); assert.equal(result.available, false);
  assert.equal(result.latest, 'v2.2.8');
});
test('legacy installation version is read from its actual release file without mutating it', async t => {
  const f = fixture(t); const directory = path.join(f.root, 'apps/tavern-runtime');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.tavern-release-version'), '2.2.4\n');
  const result = await releases.check(f.options);
  assert.equal(result.current, '2.2.4'); assert.equal(result.state, 'available');
  assert.equal(result.versionSource, 'legacy-runtime');
  assert.equal(fs.existsSync(path.join(f.root, 'tavern-updates/installed.json')), false);
});
test('network failure and ahead build are distinct states', async t => {
  const f = fixture(t);
  const file = path.join(f.root, 'tavern-updates/installed.json'); fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ version: '2.2.9' }));
  assert.equal((await releases.check(f.options)).state, 'ahead');
  const failed = await releases.check({ ...f.options, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(failed.state, 'unavailable'); assert.equal(failed.current, '2.2.9');
});
test('unsupported launcher and candidate release are rejected', async t => {
  const f = fixture(t); f.system.minimumLauncherVersion = '0.2.0';
  await assert.rejects(releases.prepare(f.options), /升级启动器/);
  f.system.minimumLauncherVersion = '0.1.0'; f.system.candidate = true;
  await assert.rejects(releases.prepare(f.options), /清单/);
});
test('platform manifest produced by packager is consumed without modifying the payload', async t => {
  const f = fixture(t);
  const { writeSystemRelease } = await import('../scripts/system-release.mjs');
  const { LAUNCHER_CAPABILITIES } = await import('../scripts/release-source.mjs');
  assert.deepEqual(LAUNCHER_CAPABILITIES,capabilities);
  const output = writeSystemRelease({ release: f.root, payload: f.bundledRoot, launcherVersion: '2.0.3',minimumLauncherVersion:'2.0.3',
    identity: { commit: f.system.commit,launcherCapabilities:LAUNCHER_CAPABILITIES, versions: { tavern: '2.2.8' }, hermesRuntime: { platform: 'darwin', arch: 'arm64' } } });
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'nora-system-darwin-arm64.json')));
  assert.deepEqual(manifest.launcherCapabilities,capabilities);
  releases.validateSystem(manifest, f.release, 'darwin', 'arm64', '2.0.3');
  assert.throws(() => releases.validateSystem(manifest, f.release, 'darwin', 'arm64', '2.0.2'), /升级启动器/);
  for (const [name, item] of Object.entries(manifest.files)) {
    assert.equal(await releases.hash(path.join(output, item.asset)), item.sha256);
    assert.equal(await releases.hash(path.join(f.bundledRoot, name)), item.sha256);
  }
});

test('beta discovery selects semantic latest beta, excluding stable, drafts and other channels', async () => {
  const rows = [
    { tag_name: 'v9.0.0', prerelease: false },
    { tag_name: 'v2.2.9-beta.20', prerelease: true, draft: true },
    { tag_name: 'v2.2.9-rc.1', prerelease: true },
    { tag_name: 'v2.2.9-beta.2', prerelease: true },
    { tag_name: 'v2.2.9-beta.10', prerelease: true },
  ];
  const fetched = [];
  const value = await releases.latest(async url => { fetched.push(url); return fixtureResponse(JSON.stringify(rows),url); }, undefined, 'beta',undefined,
    {networkPolicy:{sources:githubOnly}});
  assert.equal(value.tag_name, 'v2.2.9-beta.10');
  assert.ok(fetched[0].includes('/releases?'));
  assert.equal(releases.accepts(value, 'stable'), false);
  assert.equal(releases.compare('2.2.9-beta.10', '2.2.9-beta.2'), 1);
});
test('default Jihu beta discovery reads only its exact complete channel catalogue',async()=>{
  const primary=sourceConfiguration.mirrors.find(item=>item.id===sourceConfiguration.primary),requested=[];
  assert.equal(primary.provider,'jihulab');
  const expected=new URL('channels/beta.json',primary.channelBaseUrl).href;
  const rows=[{tag_name:'v2.2.9-beta.2',prerelease:true},{tag_name:'v2.2.9-beta.10',prerelease:true},
    {tag_name:'v9.0.0',prerelease:false},{tag_name:'v2.2.9-beta.20',prerelease:true,draft:true}];
  const value=await releases.latest(async url=>{requested.push(url);assert.equal(url,expected);
    return fixtureResponse(JSON.stringify(rows),url);},undefined,'beta');
  assert.equal(value.tag_name,'v2.2.9-beta.10');assert.deepEqual(requested,[expected]);
});
test('beta download keeps release verification and rejects stable or candidate substitution', async t => {
  const f = fixture(t);
  const beta = { ...f.release, tag_name: 'v2.2.9-beta.1', prerelease: true };
  await assert.rejects(releases.latest(async () => new Response(JSON.stringify(beta)), undefined, 'stable', beta.tag_name), /正式/);
  assert.throws(() => releases.validateSystem(f.system, f.release, 'darwin', 'arm64', '0.3.0', 'beta'), /清单/);
  assert.equal(releases.compare('bad', beta.tag_name), null);
});

test('component download callback failure rejects its pipeline with the original error and removes partial bytes', {timeout:2000}, async t => {
  const f=fixture(t), original=Object.assign(new Error('fixture installer-state write failed'),{code:'EPERM'});let now=1000;
  t.mock.method(Date,'now',()=>{now+=300;return now;});
  fs.writeFileSync(path.join(f.bundledRoot,'nora-tavern-app.tar.gz'),'old packaged bytes');
  await assert.rejects(releases.prepare({...f.options,onEvent:event=>{if(event.event==='progress' && event.current>0)throw original;}}),error=>error===original);
  const cache=fs.readdirSync(f.options.cacheRoot,{recursive:true});assert.ok(cache.every(name=>!name.endsWith('.partial')));
  assert.equal(fs.readFileSync(path.join(f.bundledRoot,'nora-tavern-app.tar.gz'),'utf8'),'old packaged bytes');
});
test('updater download callback failure rejects its pipeline with the original error and removes partial bytes', {timeout:2000}, async t => {
  const f=fixture(t), original=Object.assign(new Error('fixture installer-state write failed'),{code:'EPERM'});let now=1000;
  t.mock.method(Date,'now',()=>{now+=300;return now;});
  f.release.assets.push({name:'SHA256SUMS',browser_download_url:'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.2.8/SHA256SUMS'});
  await assert.rejects(releases.prepareUpdate({...f.options,plan:async()=>{throw Error('must not plan after callback failure');},onEvent:event=>{if(event.event==='progress' && event.current>0)throw original;}}),error=>error===original);
  const cache=fs.readdirSync(f.options.cacheRoot,{recursive:true});assert.ok(cache.every(name=>!name.endsWith('.partial')));
});
test('partial cleanup failure does not replace the first download callback failure',async t=>{
  for(const kind of ['component','updater'])await t.test(kind,async child=>{
    const f=fixture(child), original=Object.assign(new Error('fixture first state error'),{code:'EPERM'}), cleanup=Object.assign(new Error('fixture cleanup error'),{code:'EACCES'});
    const remove=fs.rmSync;child.mock.method(fs,'rmSync',(file,...args)=>{if(String(file).endsWith('.partial')&&fs.existsSync(file))throw cleanup;return remove(file,...args);});
    let clock=1000;child.mock.method(Date,'now',()=>{clock+=300;return clock;});
    const onEvent=event=>{if(event.event==='progress'&&event.current>0)throw original;};
    let pending;
    if(kind==='component'){fs.writeFileSync(path.join(f.bundledRoot,'nora-tavern-app.tar.gz'),'old bytes');pending=releases.prepare({...f.options,onEvent});}
    else {f.release.assets.push({name:'SHA256SUMS',browser_download_url:'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.2.8/SHA256SUMS'});pending=releases.prepareUpdate({...f.options,onEvent,plan:async()=>({})});}
    await assert.rejects(pending,error=>error===original);assert.equal(original.secondaryErrors?.[0],cleanup);
  });
});
test('an explicitly rechecked first-install target is pinned instead of resolving latest again',async t=>{
  const f=fixture(t), requested=[];
  const fetcher=async(url,options)=>{requested.push(url);return f.options.fetcher(url,options);};
  await releases.prepareInstall({...f.options,tag:'v2.2.8',fetcher});
  assert.equal(requested.filter(url=>f.resource(url).kind==='tag').length,1);
  assert.equal(requested.some(url=>f.resource(url).canonical===latestUrl),false);
});
test('component transfer throttles chunk progress and preserves exact zero and terminal byte facts',async t=>{
  const f=fixture(t), progress=[];t.mock.method(Date,'now',()=>1000);
  fs.writeFileSync(path.join(f.bundledRoot,'nora-tavern-app.tar.gz'),'old bytes');
  const fetcher=async(url,options)=>f.resource(url).asset==='darwin-arm64-nora-tavern-app.tar.gz'
    ?fixtureResponse(new ReadableStream({start(controller){for(const byte of [97,112,112])controller.enqueue(Uint8Array.of(byte));controller.close();}}),url,{headers:{'content-length':'3'}})
    :f.options.fetcher(url,options);
  await releases.prepare({...f.options,fetcher,onEvent:event=>{if(event.event==='progress')progress.push(event);}});
  assert.ok(progress.length<=3,'rapid chunks are throttled');assert.equal(progress[0].current,0);assert.equal(progress.at(-1).current,3);assert.equal(progress.at(-1).total,3);assert.equal(progress.at(-1).ratio,1);
});


function appOnlyFixture(t){
  const f=fixture(t),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
  const original=f.data['release-manifest.json'],tag='v2.2.9',commit='b'.repeat(40);
  const ref={schema:'nora-core-reference/1',tag:'v2.2.8',commit:'a'.repeat(40),manifests:{
    'darwin-arm64':{asset:'darwin-arm64-release-manifest.json',sha256:sha(original),size:Buffer.byteLength(original)}}};
  const product={...JSON.parse(original),commit,publication:{schema:'nora-component-publication/1',tag},
    launcherVersion:'0.1.1',coreRelease:ref};
  Object.assign(f.system,{commit,publication:product.publication,coreRelease:ref});
  const archive='Nora-Tavern-Launcher-0.1.1-darwin-arm64-update.zip';
  const physical={'release-manifest.json':JSON.stringify(product),[archive]:'APP archive',
    'nora-launcher-darwin-arm64.json':JSON.stringify({schema:'nora-launcher/v1',platform:'darwin',arch:'arm64',
      version:'0.1.1',commit,asset:archive,size:11,sha256:sha('APP archive')})};
  for(const [name,item] of Object.entries(f.system.files))physical[item.asset]=f.data[name];
  const refresh=()=>{
    physical['nora-system-darwin-arm64.json']=JSON.stringify(f.system);
    f.release.tag_name=tag;
    f.release.assets=Object.entries(physical).map(([name,bytes])=>({name,state:'uploaded',size:Buffer.byteLength(bytes),
      digest:'sha256:'+sha(bytes),browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${tag}/${name}`}));
  };
  refresh();
  const fetcher=async url=>{
    f.requested.push(String(url));
    const resource=f.resource(url);
    return fixtureResponse(JSON.stringify(resource.kind==='asset'?undefined:resource.kind==='launcher-list'?[f.release]:f.release)||physical[resource.asset],url);
  };
  const receipt=path.join(f.root,'tavern-updates/installed.json');fs.mkdirSync(path.dirname(receipt));
  fs.writeFileSync(receipt,JSON.stringify({version:'2.2.8',commit:'a'.repeat(40)}));
  return {...f,physical,refresh,original,product,options:{...f.options,fetcher}};
}

test('confirmed APP-only handoff reconciles its installer cache against the unchanged core, including a sealed plan',async t=>{
  const f=appOnlyFixture(t),vm=require('node:vm'),{parse}=require('../installer/desktop/node_modules/acorn');
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8'),tree=parse(source,{ecmaVersion:'latest'});
  const operationId=crypto.randomUUID(),operationDirectory=path.join(f.root,'installer/operations',operationId);
  fs.mkdirSync(operationDirectory,{recursive:true});
  const selected=await releases.selectPlan(f.options),sealed=releases.sealPlan(selected,{...f.options,operationDirectory,assertOwner:()=>{}});
  let state={phase:'error',error:'old start failure',task:'old task',resumeTarget:selected.tag,setupCompleted:false};
  const result={version:selected.releaseManifest.versions.tavern,commit:'a'.repeat(40),systemReady:true,updateVerified:true,port:8799,
    noraHome:f.root,hermesHome:path.join(f.root,'hermes'),installRoot:path.join(f.root,'tavern'),setupCompleted:false};
  assert.equal(releases.coreIdentity(releases.validatePlan(sealed,{...f.options,operationDirectory,launcherVersion:selected.launcherManifest.version})).commit,result.commit);
  const context=vm.createContext({path,releases,process:{platform:selected.platform,arch:selected.arch},CHANNEL:'stable',
    app:{getVersion:()=>selected.launcherManifest.version},installerDirectory:()=>path.join(f.root,'installer'),
    noraHome:()=>result.noraHome,hermesHome:()=>result.hermesHome,installRoot:()=>result.installRoot,
    activeRun:false,modelBusy:false,readInstallerState:()=>state,writeInstallerState:value=>(state=value)});
  const load=name=>{const node=tree.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);assert.ok(node);return vm.runInContext('('+source.slice(node.start,node.end)+')',context);};
  context.confirmedMaintenanceIdentity=load('confirmedMaintenanceIdentity');
  const reconcile=load('reconcileInstallerState');
  const operation={operationId,kind:'update',state:'succeeded',verification:'confirmed',effectState:'untouched',
    recoveryOutcome:'not-required',currentFailure:null,target:{releasePlan:sealed},result};
  assert.equal(context.confirmedMaintenanceIdentity(operation)?.commit,result.commit,'product commit is not the installed core commit');
  assert.equal(reconcile(operation,result).resumeTarget,null);assert.equal(state.error,'');assert.equal(state.phase,'ready');
  for(const commit of [selected.commit,'c'.repeat(40)])assert.equal(context.confirmedMaintenanceIdentity({...operation,result:{...result,commit}}),null);
  fs.appendFileSync(path.join(operationDirectory,sealed.manifestRef.file),' ');
  assert.equal(context.confirmedMaintenanceIdentity(operation),null,'tampered core reference must not clear a failed installer state');
});

test('APP-only publication discovers the new APP while independent core check stays current',async t=>{
  const f=appOnlyFixture(t),receipt=fs.readFileSync(path.join(f.root,'tavern-updates/installed.json'));
  const options={...f.options,client:'updater',updaterCapabilities:capabilities};
  const core=await releases.check(options);
  assert.equal(core.state,'current');assert.equal(core.releaseAvailable,false);assert.equal(core.available,false);
  assert.equal(core.latest,'v2.2.8');assert.equal(core.releaseTag,'v2.2.9');
  assert.equal(f.requested.some(url=>url.includes('nora-launcher-')),false);
  const gui=await releases.check({...options,launcherDiscovery:true});
  assert.equal(gui.state,'available');assert.equal(gui.releaseAvailable,false);assert.equal(gui.launcherUpdateAvailable,true);
  assert.deepEqual(releases.coreIdentity(gui.releasePlan),{version:'2.2.8',commit:'a'.repeat(40),
    manifestSha256:crypto.createHash('sha256').update(f.original).digest('hex')});
  assert.deepEqual(fs.readFileSync(path.join(f.root,'tavern-updates/installed.json')),receipt);
  assert.equal(f.requested.some(url=>url.endsWith('-update.zip')||url.endsWith('.tar.gz')),false);
});

test('APP-only publication resolves original core bytes for installation and older core updates',async t=>{
  const f=appOnlyFixture(t),options={...f.options,client:'updater',updaterCapabilities:capabilities};
  const update=await releases.selectPlan(options);
  assert.equal(update.commit,'b'.repeat(40));
  const install=await releases.selectPlan({...options,mode:'install'});
  assert.equal(install.commit,'a'.repeat(40));assert.equal(install.releaseManifestText,f.original);
  const payload=await releases.prepareUpdate({...options,selectedPlan:update,plan:()=>assert.fail('must not plan product runner as core')});
  assert.equal(fs.readFileSync(path.join(payload,'release-manifest.json'),'utf8'),f.original);
  assert.equal(fs.readFileSync(path.join(payload,'nora-tavern-app.tar.gz'),'utf8'),'app');
});

test('APP-only core proof rejects changed manifest bytes, source commit and recursive references',async t=>{
  const f=appOnlyFixture(t),options={...f.options,client:'updater',updaterCapabilities:capabilities,mode:'install'};
  f.physical['darwin-arm64-release-manifest.json']+=' ';
  f.refresh();await assert.rejects(releases.selectPlan(options),/校验|证明/);
  f.physical['darwin-arm64-release-manifest.json']=f.original;
  const bad={...JSON.parse(f.original),commit:'c'.repeat(40)};
  f.physical['darwin-arm64-release-manifest.json']=JSON.stringify(bad);
  const bytes=f.physical['darwin-arm64-release-manifest.json'];
  Object.assign(f.system.files['release-manifest.json'],{sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:Buffer.byteLength(bytes)});
  Object.assign(f.system.coreRelease.manifests['darwin-arm64'],f.system.files['release-manifest.json']);
  f.refresh();await assert.rejects(releases.selectPlan(options),/不变核心/);
  assert.throws(()=>releases.coreReference({...f.product,coreRelease:{...f.product.coreRelease,tag:'v2.2.9'}},'darwin','arm64'),/来源证明/);
});

function splitDiscoveryFixture(t) {
  const f=appOnlyFixture(t),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
  const anchorFiles={'release-manifest.json':f.original,'darwin-arm64-release-manifest.json':f.original};
  const anchor={tag_name:'v2.2.8',draft:false,prerelease:false,assets:Object.entries(anchorFiles).map(([name,body])=>({
    name,state:'uploaded',size:Buffer.byteLength(body),digest:'sha256:'+sha(body),
    browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.2.8/${name}`}))};
  const requests=[];let listStatus=200,githubOnly=false;
  const fetcher=async address=>{
    const url=String(address);requests.push(url);const u=new URL(url);
    if(githubOnly&&u.hostname==='jihulab.com')return fixtureResponse('offline',url,{status:503});
    if(url.endsWith('/latest')||url.endsWith('/channels/stable.json'))return fixtureResponse(JSON.stringify(anchor),url);
    if(url.includes('?per_page=100&page=1')||url.endsWith('/channels/launcher-stable.json'))
      return fixtureResponse(listStatus===200?JSON.stringify([f.release]):'temporarily offline',url,{status:listStatus});
    const name=decodeURIComponent(u.pathname.split('/').pop());
    if(u.pathname.includes('/v2.2.8/'))return fixtureResponse(anchorFiles[name],url);
    if(u.pathname.includes('/v2.2.9/'))return fixtureResponse(f.physical[name],url);
    throw new Error('Unexpected discovery test URL '+url);
  };
  return {...f,anchor,anchorFiles,requests,fetcher,options:{...f.options,fetcher,
    client:'updater',updaterCapabilities:capabilities,networkPolicy:{maxAttempts:1,totalBudgetMs:3000,attemptTimeoutMs:1000}},
    listFailure(){listStatus=503;},githubFallback(){githubOnly=true;}};
}
test('split stable discovery lets the desktop find APP-only while updater and Linux retain the compatible core anchor',async t=>{
  const f=splitDiscoveryFixture(t);
  const core=await releases.check(f.options);assert.equal(core.releaseTag,'v2.2.8');assert.equal(core.state,'current');
  assert.equal(f.requests.some(url=>url.includes('launcher-stable')||url.includes('?per_page=')),false);
  const gui=await releases.check({...f.options,launcherDiscovery:true});
  assert.equal(gui.releaseTag,'v2.2.9');assert.equal(gui.latest,'v2.2.8');assert.equal(gui.launcherUpdateAvailable,true);
  const linux=await releases.check({...f.options,platform:'linux',arch:'x64'});
  assert.equal(linux.releaseTag,'v2.2.8');assert.equal(linux.state,'current');
});
test('split stable discovery has a bounded GitHub list fallback when the domestic source is unavailable',async t=>{
  const f=splitDiscoveryFixture(t);f.githubFallback();
  const gui=await releases.check({...f.options,launcherDiscovery:true});
  assert.equal(gui.releaseTag,'v2.2.9');assert.equal(gui.launcherUpdateAvailable,true);
  assert.ok(f.requests.includes('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=1'));
  assert.equal(f.requests.some(url=>url.includes('page=2')),false);
});
test('unreadable APP discovery does not claim current or block a verified core update',async t=>{
  const f=splitDiscoveryFixture(t);f.listFailure();
  let result=await releases.check({...f.options,launcherDiscovery:true});
  assert.equal(result.state,'unavailable');assert.match(result.launcherError,/启动器/);assert.equal(result.updateSupported,true);
  fs.writeFileSync(path.join(f.root,'tavern-updates/installed.json'),JSON.stringify({version:'2.2.7'}));
  result=await releases.check({...f.options,launcherDiscovery:true});
  assert.equal(result.state,'available');assert.equal(result.releaseAvailable,true);assert.equal(result.releaseTag,'v2.2.8');
  assert.match(result.launcherError,/启动器/);
});

test('slow or failed optional APP discovery preserves the already verified core plan and user data',async t=>{
  for(const kind of ['fast failure','spent budget','headers timeout','body timeout'])await t.test(kind,async t=>{
    const f=splitDiscoveryFixture(t);let now=1000000;
    fs.mkdirSync(path.join(f.root,'tavern-updates'),{recursive:true});
    fs.writeFileSync(path.join(f.root,'tavern-updates/installed.json'),JSON.stringify({version:'2.2.7'}));
    const protectedFiles=['chat.jsonl','character.json','world.json','config.yaml'];
    for(const name of protectedFiles)fs.writeFileSync(path.join(f.root,name),'protected '+name);
    const before=protectedFiles.map(name=>fs.readFileSync(path.join(f.root,name)));
    const events=[];
    const fetcher=async(address,options)=>{
      const url=String(address);events.push(url);
      if(url.includes('?per_page=')||url.endsWith('/channels/launcher-stable.json')){
        if(kind==='spent budget')now+=101;
        if(kind==='headers timeout')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
        if(kind==='body timeout')return fixtureResponse(new ReadableStream({start(){}}),url);
        throw Object.assign(Error('APP catalogue unavailable'),{code:'TIMEOUT'});
      }
      return f.fetcher(address,options);
    };
    const result=await releases.check({...f.options,fetcher,launcherDiscovery:true,
      networkPolicy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:100,attemptTimeoutMs:20,now:()=>now}});
    assert.equal(result.state,'available',JSON.stringify(result));assert.equal(result.installable,true);
    assert.equal(result.releaseAvailable,true);assert.equal(result.releasePlan.tag,'v2.2.8');
    assert.ok(result.launcherError);assert.equal(result.launcherUpdateAvailable,false);
    assert.ok(events.findIndex(url=>url.endsWith('/release-manifest.json'))<events.findIndex(url=>url.includes('?per_page=')),
      'Core manifest must be verified before optional APP traffic');
    for(const [i,name]of protectedFiles.entries())assert.deepEqual(fs.readFileSync(path.join(f.root,name)),before[i]);
  });
});

test('split discovery reuses each verified manifest once without a persistent metadata cache',async t=>{
  const f=splitDiscoveryFixture(t),result=await releases.check({...f.options,launcherDiscovery:true});
  assert.equal(result.releaseTag,'v2.2.9');assert.equal(result.launcherUpdateAvailable,true);
  for(const tag of ['v2.2.8','v2.2.9'])assert.equal(f.requests.filter(url=>url.endsWith(`/${tag}/release-manifest.json`)).length,1,tag);
});

test('reused APP discovery bytes must match their advertised digest before replacing the core plan',async t=>{
  const f=splitDiscoveryFixture(t);
  fs.writeFileSync(path.join(f.root,'tavern-updates/installed.json'),JSON.stringify({version:'2.2.7'}));
  const result=await releases.check({...f.options,launcherDiscovery:true,fetcher:async address=>{
    const url=String(address);
    return url.endsWith('/v2.2.9/release-manifest.json')?fixtureResponse(f.physical['release-manifest.json']+' ',url):f.fetcher(address);
  }});
  assert.equal(result.state,'available');assert.equal(result.releaseTag,'v2.2.8');
  assert.equal(result.launcherUpdateAvailable,false);assert.match(result.launcherError,/校验|清单/);
});

test('explicit cancellation and invalid core capabilities are not swallowed as optional APP failure',async t=>{
  const f=splitDiscoveryFixture(t),controller=new AbortController();let appReads=0;
  const fetcher=async(address,options)=>{
    if(String(address).includes('?per_page=')||String(address).endsWith('/channels/launcher-stable.json')){
      appReads++;controller.abort();options.signal.throwIfAborted();
    }
    return f.fetcher(address,options);
  };
  const cancelled=await releases.check({...f.options,fetcher,signal:controller.signal,launcherDiscovery:true});
  assert.equal(cancelled.state,'unavailable');assert.equal(cancelled.available,false);assert.ok(appReads);
  appReads=0;
  const blocked=await releases.check({...f.options,fetcher,updaterCapabilities:{},launcherDiscovery:true});
  assert.equal(blocked.state,'blocked');assert.equal(blocked.updateSupported,false);assert.equal(appReads,0);
});
test('APP-only discovery cannot shadow a newer or different core anchor, nor forge its original platform manifest proof',async t=>{
  const f=splitDiscoveryFixture(t);
  for(const patch of [{commit:'c'.repeat(40)},{tag:'v2.2.7'}]) {
    Object.assign(f.product.coreRelease,patch);f.physical['release-manifest.json']=JSON.stringify(f.product);f.refresh();
    const result=await releases.check({...f.options,launcherDiscovery:true});
    assert.equal(result.releaseTag,'v2.2.8');assert.equal(result.launcherUpdateAvailable,false);
  }
  Object.assign(f.product.coreRelease,{tag:'v2.2.8',commit:'a'.repeat(40)});
  f.product.coreRelease.manifests['darwin-arm64'].sha256='f'.repeat(64);f.physical['release-manifest.json']=JSON.stringify(f.product);f.refresh();
  const result=await releases.check({...f.options,launcherDiscovery:true});
  assert.equal(result.releaseTag,'v2.2.8');assert.equal(result.launcherUpdateAvailable,false);assert.ok(result.launcherError);
});

test('a truncated GitHub APP list stays bounded and never proves that the APP is current',async t=>{
  const f=splitDiscoveryFixture(t),pages=[];
  const fetcher=async address=>{
    const url=String(address);
    if(url.includes('/channels/launcher-stable.json'))return fixtureResponse('unavailable',url,{status:503});
    if(url.includes('?per_page=100&page=')){
      const page=Number(new URL(url).searchParams.get('page'));pages.push(page);
      return fixtureResponse(JSON.stringify(Array.from({length:100},(_,i)=>({draft:true,tag_name:`v99.0.${i}`}))),url);
    }
    return f.fetcher(address);
  };
  const result=await releases.check({...f.options,fetcher,launcherDiscovery:true});
  assert.equal(result.state,'unavailable');assert.ok(result.launcherError);assert.equal(result.updateSupported,true);
  assert.deepEqual(pages,[1,2,3,4,5]);assert.equal(result.releaseTag,'v2.2.8');
});
