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
const capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};

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
      if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(f.release));
      if (evidence === 'http') return new Response('private manifest reply',{status:403});
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
  const fetcher = async url => {
    requested.push(url);
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(release));
    if (url.endsWith('/nora-system-darwin-arm64.json')) return new Response(JSON.stringify(system));
    const name = url.split('/').pop().replace(/^darwin-arm64-/, '');
    return new Response(data[name] || 'missing', { status: name in data ? 200 : 404 });
  };
  return { root, bundledRoot, system, release, requested, data, options: { bundledRoot, cacheRoot: path.join(root, 'cache'), installRoot: root,
    launcherVersion: '0.1.0', platform: 'darwin', arch: 'arm64', fetcher } };
}

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
    releaseCheckRequest:null,releaseMetadataState:null,
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
  assert.equal(f.requested.filter(url=>url.endsWith('/releases/latest')).length,1);
  const count=f.requested.length;const repeat=await query();
  assert.equal(f.requested.length,count,'a short-interval check must reuse validated metadata');
  assert.equal(repeat.latestConfirmed,false);
  assert.equal(fs.existsSync(path.join(f.root,'cache/releases/metadata.json')),true);
});
test('old published metadata is still visible but its unbound writer cannot be selected or prepared',async t=>{
  const f=fixture(t),legacy=JSON.parse(f.data['release-manifest.json']);delete legacy.launcherCapabilities;
  f.data['release-manifest.json']=JSON.stringify(legacy);
  const checked=await releases.check(f.options);
  assert.equal(checked.latest,'v2.2.8');assert.equal(checked.state,'blocked');
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
    assert.equal(f.requested.some(url=>url.includes('/download/')&&!url.endsWith('nora-system-darwin-arm64.json')),false);
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
  assert.equal(f.requested.filter(url => url.endsWith('/releases/latest')).length,1);
  assert.deepEqual(f.requested.filter(url => url.includes('/download/') && !url.endsWith('nora-system-darwin-arm64.json')).map(url=>url.split('/').at(-1)),
    ['release-manifest.json','darwin-arm64-nora-tavern-app.tar.gz']);
  assert.equal(confirmations,0);
});
test('first install awaits one immutable selected plan before starting payload transfer', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.bundledRoot,'nora-tavern-app.tar.gz'),'old app');
  let selected, calls=0, frozen=false;
  const fetcher=async(url,options)=>{
    if(url.endsWith('/darwin-arm64-nora-tavern-app.tar.gz')) assert.equal(frozen,true,'plan callback finishes before transfer');
    return f.options.fetcher(url,options);
  };
  await releases.prepareInstall({...f.options,fetcher,onPlan:async plan=>{calls++; selected=plan;
    assert.equal(plan.tag,'v2.2.8'); assert.equal(plan.mode,'install'); assert.equal(Object.isFrozen(plan.release),true);
    await Promise.resolve(); frozen=true;
  }});
  assert.equal(calls,1);assert.equal(selected.commit,f.system.commit);
  assert.equal(f.requested.filter(url=>url.endsWith('/releases/latest')).length,1);
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
  assert.ok(f.requested.at(-1).includes('/download/v2.2.8/'));
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
  assert.equal(result.releaseAvailable, true);
  assert.equal(result.installable, false);
  assert.equal(result.latest, 'v2.2.8');
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
  const value = await releases.latest(async url => { fetched.push(url); return new Response(JSON.stringify(rows)); }, undefined, 'beta');
  assert.equal(value.tag_name, 'v2.2.9-beta.10');
  assert.ok(fetched[0].includes('/releases?'));
  assert.equal(releases.accepts(value, 'stable'), false);
  assert.equal(releases.compare('2.2.9-beta.10', '2.2.9-beta.2'), 1);
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
  const fetcher=async(url,options)=>{requested.push(url);if(url.endsWith('/releases/tags/v2.2.8'))return Response.json(f.release);return f.options.fetcher(url,options);};
  await releases.prepareInstall({...f.options,tag:'v2.2.8',fetcher});assert.equal(requested.filter(url=>url.endsWith('/releases/tags/v2.2.8')).length,1);assert.equal(requested.some(url=>url.endsWith('/releases/latest')),false);
});
test('component transfer throttles chunk progress and preserves exact zero and terminal byte facts',async t=>{
  const f=fixture(t), progress=[];t.mock.method(Date,'now',()=>1000);
  fs.writeFileSync(path.join(f.bundledRoot,'nora-tavern-app.tar.gz'),'old bytes');
  const fetcher=async(url,options)=>url.endsWith('/darwin-arm64-nora-tavern-app.tar.gz')
    ?new Response(new ReadableStream({start(controller){for(const byte of [97,112,112])controller.enqueue(Uint8Array.of(byte));controller.close();}}),{headers:{'content-length':'3'}})
    :f.options.fetcher(url,options);
  await releases.prepare({...f.options,fetcher,onEvent:event=>{if(event.event==='progress')progress.push(event);}});
  assert.ok(progress.length<=3,'rapid chunks are throttled');assert.equal(progress[0].current,0);assert.equal(progress.at(-1).current,3);assert.equal(progress.at(-1).total,3);assert.equal(progress.at(-1).ratio,1);
});
