const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const releases = require('../installer/desktop/releases');
const update = require('../installer/desktop/launcher-update');
const capability = require('../installer/desktop/launcher-capability');
const { createLocalRelease } = require('../installer/desktop/local-release');

function fixture(t, {platform = 'win32', arch = 'x64'} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-self-update-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const manifest = { schema: 'tavern-release/v2', commit: 'a'.repeat(40),launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2}, versions: { tavern: '2.4.0' }, launcherVersion: '1.1.0',
    bootstrap: { sha256: sha('bootstrap'), managedComponents: 1, minimumLauncherVersion: '1.1.0' } };
  const item = { schema: 'nora-launcher/v1', version: '1.1.0', platform, arch,
    asset: `Nora-Tavern-Launcher-1.1.0-${platform}-${arch}-update.zip`, sha256: sha('archive'), size: 7 };
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, `nora-launcher-${platform}-${arch}.json`), JSON.stringify(item));
  fs.writeFileSync(path.join(root, item.asset), 'archive');
  const installRoot = path.join(root, 'tavern');
  fs.mkdirSync(path.join(installRoot, 'tavern-updates'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.4.0' }));
  return { root, item, installRoot, options: { platform, arch, launcherVersion: '1.0.0',
    fetcher: createLocalRelease(root), cacheRoot: path.join(root, 'cache'), channel: 'stable' } };
}
let actualPython;
const python = () => actualPython ||= execFileSync(process.env.NORA_TEST_PYTHON||process.env.NORA_PYTHON||
  (process.platform==='win32'?'python':'python3'),['-B','-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
let actualPythonRoots;
const pythonRoots = () => {
  actualPythonRoots ||= JSON.parse(execFileSync(python(),['-B','-c',
    'import sys,json;print(json.dumps({"managedPythonRoot":sys.base_prefix,"venvHome":sys.prefix}))'],{encoding:'utf8'}));
  return {managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT||actualPythonRoots.managedPythonRoot,
    venvHome:process.env.NORA_TEST_VENV_HOME||actualPythonRoots.venvHome};
};
function planFor(home, executable, fields = {}) {
  const appRoot=update.applicationRoot(executable);
  return {schema:2,executorProtocol:'nora-operation-executor/1',operationId:crypto.randomUUID(),ownerEpoch:1,
    planDigest:'a'.repeat(64),releasePlan:{schema:'nora-release-plan/1'},token:crypto.randomUUID(),parentPid:process.pid,parentCreationTime:1,
    home,appRoot,executable:path.relative(appRoot,executable),platform:process.platform,arch:process.arch,
    version:'1.1.0',previousVersion:'1.0.0',target:'v2.4.2',rollbackCompatibility:{operationSchema:'nora-operation/1',
      executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2,compatible:true},...fields};
}
function operationFor(plan, job) {
  return {operationId:plan.operationId,ownerEpoch:plan.ownerEpoch,planDigest:plan.planDigest,handoffRef:job};
}
async function handoffFixture(t) {
  const f=fixture(t,{platform:process.platform,arch:process.arch}),home=path.join(f.root,'data');
  const executable=process.platform==='darwin'?path.join(f.root,'application/Contents/MacOS/launcher'):path.join(f.root,'application/launcher.exe');
  const resourcesRoot=process.platform==='darwin'?path.join(f.root,'application/Contents/Resources'):path.join(f.root,'application/resources');
  const write=(file,value='fixture')=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value,{mode:0o600});};
  fs.mkdirSync(home);write(executable,'old');write(path.join(resourcesRoot,'app.asar'));
  write(path.join(resourcesRoot,`app.asar.unpacked/node_modules/fs-native-extensions/prebuilds/${process.platform}-${process.arch}/fs-native-extensions.node`));
  for(const name of capability.RESOURCE_NAMES)write(path.join(resourcesRoot,name));
  await capability.register({noraHome:home,executable,resourcesRoot,isPackaged:true,launcherVersion:'1.0.0',port:8799});
  const prepared=await update.prepare(f.options),operationId=crypto.randomUUID();
  const operationDirectory=path.join(home,'installer','operations',operationId);fs.mkdirSync(operationDirectory,{recursive:true});
  const target={releasePlan:releases.sealPlan(prepared.releasePlan,{...f.options,operationDirectory,assertOwner:()=>{}})};
  const operation={operationId,ownerEpoch:1,target,planDigest:crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex')};
  const helper=path.join(f.root,'prepare-helper.py');
  write(helper,`import sys,json,os
if '--process-identity' in sys.argv: print(json.dumps({'pid':int(sys.argv[-1]),'creationTime':1}))
elif '--prepare' in sys.argv: print(json.dumps({'prepared':True}))
elif '--assess' in sys.argv: print(json.dumps({'job':sys.argv[-1],'canRecover':True,'reason':''}))
`);
  return {...f,home,executable,resourcesRoot,helper,prepared,operation,write,
    handoff:{home,executable,helper,python:python(),previousVersion:'1.0.0',prepared,operation,spawnChild:spawn}};
}
test('one update remains available when only the launcher is outdated; minimum version is satisfied after replacement', async t => {
  const f = fixture(t);
  const checked = await releases.check({ ...f.options, installRoot: f.installRoot });
  assert.equal(checked.available, true);
  assert.equal(checked.state, 'available');
  const prepared = await update.prepare(f.options);
  assert.equal(prepared.tag, 'v2.4.0');
  assert.equal(fs.readFileSync(prepared.launcher.archive, 'utf8'), 'archive');
  assert.equal((await update.prepare({ ...f.options, launcherVersion: '1.1.0' })).launcher, null);
});

test('launcher download announces its stage before requesting headers, publishes bytes and ends in verification', async t => {
  const f = fixture(t), events = [];
  const prepared = await update.prepare({...f.options, onEvent:event=>events.push(event), fetcher:async (url, options)=>{
    if (url.endsWith(f.item.asset)) {
      assert.equal(events.at(-2).stage_id,'download');
      assert.equal(events.at(-1).current,0);
      assert.equal(events.at(-1).total,f.item.size);
    }
    return f.options.fetcher(url,options);
  }});
  const progress = events.filter(event=>event.event==='progress');
  assert.equal(progress.at(-1).current,f.item.size);
  assert.equal(progress.at(-1).ratio,1);
  assert.equal(events.at(-1).stage_id,'verify');
  assert.equal(fs.readFileSync(prepared.launcher.archive,'utf8'),'archive');
  events.length = 0;
  await update.prepare({...f.options,onEvent:event=>events.push(event)});
  assert.equal(events.some(event=>event.stage_id==='download' || event.event==='progress'),false);
});

test('launcher download progress callback failure rejects the real pipeline and removes partial bytes', async t => {
  const f = fixture(t);
  const failure = new Error('fixture progress callback failed');
  await assert.rejects(update.prepare({ ...f.options,
    onEvent(event) { if (event.event === 'progress' && event.current > 0) throw failure; },
    fetcher: async (url, options) => {
      if (!url.endsWith(f.item.asset)) return f.options.fetcher(url, options);
      return new Response(new ReadableStream({ async start(controller) {
        await new Promise(resolve => setTimeout(resolve, 300));
        controller.enqueue(Buffer.from('archive')); controller.close();
      } }));
    },
  }), error => error === failure);
  assert.equal(fs.readdirSync(path.join(f.root, 'cache', 'launcher-' + f.item.sha256.slice(0, 16))).length, 0);
});

test('launcher HTTP failures retain structured release metadata', async t => {
  const f = fixture(t);
  await assert.rejects(update.prepare({ ...f.options, fetcher: (url, options) => url.endsWith(f.item.asset)
    ? Promise.resolve(new Response('denied', { status: 403 })) : f.options.fetcher(url, options) }),
  error => error.status === 403 && error.source === 'release_service' && error.site === 'release.download');
});

test('desktop replacement status routes legacy 2.3.2 to the bundled 2.3.13 release', async t => {
  const f = fixture(t);
  const manifestFile = path.join(f.root, 'release-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.versions.tavern = '2.3.13';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const required = ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz',
    'nora-tavern-nora-mcp.tar.gz', 'nora-tavern-first-install-bootstrap.py', 'first-install-manifest.json',
    'nora-hermes-runtime.json', 'nora-tavern-dependencies.json'];
  fs.writeFileSync(path.join(f.root, 'nora-system.json'), JSON.stringify({ schema: 'nora-system/v1',
    launcherCapabilities:manifest.launcherCapabilities,
    version: '2.3.13', commit: manifest.commit, platform: process.platform, arch: process.arch,
    minimumLauncherVersion: '1.1.0', files: Object.fromEntries(required.map(name => [name,
      { asset: name, sha256: 'a'.repeat(64), size: 1 }])) }));
  const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
  let status;
  const context = vm.createContext({ handle: (_name, fn) => { status = fn; },
    activeProcess:null,releaseAbort:null,cancelled:false,updatingSystem:false,
    quitting: false, uninstalling: false, selectingLocation: false, modelBusy: false,
    statusRequest: null, activeRun: false, activeOperationContext:null, LOCAL_TEST: null, CHANNEL: 'stable', telemetry: null,
    operations:()=>({snapshot:async()=>null}),systemUpdate: { inspect: () => null }, noraHome: () => f.root,
    readLauncherRecovery: async () => null,
    readInstallerState: () => ({ phase: 'ready' }), findPython: () => true,
    runBridge: async () => ({ installed: true, hermesInstalled: true, version: '2.3.2', systemReady: true }),
    releases, payloadDirectory: () => f.root, app: { getVersion: () => '1.1.0' }, locationStatus: () => ({}),
    nodeStatus: warning => { throw new Error(warning || 'unexpected fallback'); },
    statusErrorMessage: error => { throw error; },
  });
  const cancellation=require('../installer/desktop/node_modules/acorn').parse(source,{ecmaVersion:'latest'}).body.find(node=>node.id?.name==='taskCancellation');
  assert.ok(cancellation);vm.runInContext(source.slice(cancellation.start,cancellation.end),context);
  vm.runInContext(source.slice(source.indexOf("  handle('nora:status'"), source.indexOf("  handle('nora:choose-directory'")), context);
  const snapshot = await status();
  assert.equal(snapshot.bundledUpgradeTarget, 'v2.3.13');
  const ui = fs.readFileSync(path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
  let request;
  vm.runInNewContext(ui.slice(ui.indexOf('  function recoveredOperation('), ui.indexOf('  function taskView(')) + '\nroute();', {
    snapshot, statusUnknown: false, bundledUpgradeAttempted: false, run: (action, options) => { request = { action, ...options }; },
    $: () => ({ classList: { remove() {} } }),
  });
  assert.equal(request.action, 'update');
  const urls = [];
  const fetcher = createLocalRelease(f.root);
  const prepared = await update.prepare({ ...f.options, launcherVersion: '1.1.0', tag: request.tag,
    fetcher: (url, options) => { urls.push(url); return fetcher(url, options); } });
  assert.equal(prepared.tag, 'v2.3.13');
  assert.equal(prepared.launcher, null);
  assert.ok(urls.some(url => url.endsWith('/releases/tags/v2.3.13')));
  assert.equal(urls.some(url => url.includes('v2.3.2')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'cache')), false);
});
test('corrupt download and mismatched platform never reach replacement', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, f.item.asset), 'changed');
  await assert.rejects(update.prepare(f.options), /校验失败/);
  fs.writeFileSync(path.join(f.root, 'nora-launcher-win32-x64.json'), JSON.stringify({ ...f.item, arch: 'arm64' }));
  await assert.rejects(update.prepare(f.options), /清单无效/);
});
test('resume readiness remains bound to the same operation and fixed plan on repeated queries', t => {
  const { root } = fixture(t);
  const job = path.join(root, 'installer/launcher-update/job-test');
  fs.mkdirSync(job, { recursive: true });
  const executable = process.platform==='darwin'?path.join(root,'application/Contents/MacOS/launcher'):path.join(root, 'application/launcher.exe');
  const plan=planFor(root,executable,{target:'v2.4.0'});
  fs.writeFileSync(path.join(job, 'plan.json'), JSON.stringify(plan));
  assert.equal(update.resume(job, { home: root, executable, version: '1.1.0' }).operationId, plan.operationId);
  assert.equal(update.resume(job, { home: root, executable, version: '1.1.0' }).planDigest,plan.planDigest);
  const ready=JSON.parse(fs.readFileSync(path.join(job,'ready.json')));
  assert.deepEqual(ready,{schema:'nora-launcher-handoff/1',token:plan.token,version:'1.1.0',operationId:plan.operationId,planDigest:plan.planDigest});
  assert.throws(() => update.resume(job, { home: root, executable, version: '1.0.0' }), {code:'OPERATION_CAPABILITY_REQUIRED'});
  assert.equal(update.resume('/untrusted/job-test', { home: root, executable, version: '1.1.0' }), null);
});

test('Windows portable refuses replacing its temporary extraction directory before writing anything', async () => {
  const previous = process.env.PORTABLE_EXECUTABLE_FILE;
  process.env.PORTABLE_EXECUTABLE_FILE = 'D:\\Nora-portable.exe';
  try {
    await assert.rejects(update.prepareHandoff({}), /便携版/);
  } finally {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = previous;
  }
});

test('handoff helper runs through actual native guard pipes and waits for real child close',
  {timeout:30000,skip:!process.env.NORA_TEST_PYTHON}, async t => {
  const f=await handoffFixture(t),control=path.resolve(__dirname,'../installer/operation_control.py');
  const {acquire,probe}=require('../installer/desktop/operation-lock');
  const lease=await acquire({directory:path.join(f.home,'installer'),operationId:f.operation.operationId,ownerEpoch:f.operation.ownerEpoch});
  const closes=[];
  f.write(f.helper,`import sys,json,os,psutil
from pathlib import Path
assert sys.stdin.read() == '', 'helper stdin must be ended after listeners are registered'
if '--process-identity' in sys.argv:
    pid=int(sys.argv[-1]); print(json.dumps({'pid':pid,'creationTime':psutil.Process(pid).create_time()}))
elif '--prepare' in sys.argv:
    job=Path(sys.argv[-1]); (job/'actual-helper-pipes.json').write_text(json.dumps({'pid':os.getpid(),'stdinEnded':True}))
    print(json.dumps({'prepared':True}))
`);
  try {
    const spawnChild=(command,args,options)=>{
      const child=lease.spawn(command,['-B','-u',control,'--delegate-exec',...args],{...options,kind:'python-maintenance',
        ...pythonRoots()});
      closes.push(new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,jobId:child.jobId}));}));
      return child;
    };
    const job=await update.prepareHandoff({...f.handoff,spawnChild});
    const closed=await Promise.all(closes);assert.equal(closed.length,2);
    assert.ok(closed.every(value=>value.code===0&&value.signal===null));
    const snapshot=await lease.snapshot();assert.equal(snapshot.jobs.length,2);
    for(const child of snapshot.jobs){assert.ok(child.closedAt);assert.equal(child.exitCode,0);
      assert.equal(child.delegation.identityStatus,'reported');assert.ok(child.creationIdentity.creationTime>0);}
    const output=JSON.parse(fs.readFileSync(path.join(job,'actual-helper-pipes.json')));
    assert.equal(output.stdinEnded,true);assert.equal(output.pid,snapshot.jobs[1].pid);
    assert.equal((await probe({directory:path.join(f.home,'installer')})).busy,true);
    await lease.release();assert.equal((await probe({directory:path.join(f.home,'installer')})).busy,false);
  } finally {await lease.release();}
});

test('independent replacement helper uses its job directory and never inherits the occupied application directory', async t => {
  const f=await handoffFixture(t),job=await update.prepareHandoff(f.handoff);
  assert.equal(fs.readFileSync(path.join(job,'operation-budget.json'),'utf8'),
    fs.readFileSync(path.join(f.resourcesRoot,'operation-budget.json'),'utf8'));
  f.write(path.join(job,'replace.py'),`import sys,json,os,time
from pathlib import Path
job=Path(sys.argv[1])
(job/'worker-facts.json').write_text(json.dumps({'cwd':os.getcwd(),'gate':os.environ.get('NORA_OPERATION_ID')}))
(job/'status.json').write_text(json.dumps({'status':'waiting-parent','workerPid':os.getpid()}))
time.sleep(.3)
`);
  await update.launchHandoff({home:f.home,executable:f.executable,job,python:python(),...pythonRoots(),env:{...process.env,NORA_OPERATION_ID:f.operation.operationId}});
  const facts=JSON.parse(fs.readFileSync(path.join(job,'worker-facts.json')));
  assert.equal(facts.cwd,job);assert.equal(facts.gate,null);
  assert.ok(!facts.cwd.startsWith(update.applicationRoot(f.executable)+path.sep));
  await new Promise(resolve=>setTimeout(resolve,350));
});

test('desktop handoff and recovery keep the desktop profile in real independent Python helpers',
  {timeout:30000,skip:!process.env.NORA_TEST_PYTHON}, async t => {
  const runtime=JSON.parse(execFileSync(python(),['-B','-c',
    'import sys,json;print(json.dumps({"base":sys.base_prefix,"prefix":sys.prefix}))'],{encoding:'utf8'}));
  const managedPythonRoot=fs.realpathSync(runtime.base),venvHome=fs.realpathSync(runtime.prefix);
  const managedHome=path.dirname(managedPythonRoot);
  const normalized=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  if(normalized(managedPythonRoot)!==normalized(path.join(managedHome,'python'))
    ||normalized(venvHome)!==normalized(path.join(managedHome,'hermes-agent','venv'))){
    t.skip('This real profile test requires the complete Hermes-shaped Python runtime');return;
  }
  const f=await handoffFixture(t),job=await update.prepareHandoff(f.handoff);
  const profile=path.join(f.root,'desktop-profile'),temp=path.join(f.root,'desktop-temp');
  fs.mkdirSync(profile);fs.mkdirSync(temp);
  const desktopEnv={...process.env,HOME:profile,USERPROFILE:profile,
    APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),
    TMPDIR:temp,TEMP:temp,TMP:temp};
  const maintenanceEnv={...desktopEnv,HOME:path.join(f.home,'hermes'),USERPROFILE:path.join(f.home,'hermes'),
    APPDATA:path.join(f.home,'appdata/roaming'),LOCALAPPDATA:path.join(f.home,'appdata/local'),TMPDIR:path.join(f.home,'cache/tmp')};
  const main=fs.readFileSync(path.resolve(__dirname,'../installer/desktop/main.js'),'utf8');
  f.write(path.join(job,'replace.py'),`import sys,json,os,time,psutil
from pathlib import Path
if '--assess' in sys.argv: print(json.dumps({'canRecover':True}))
else:
    job=Path(sys.argv[sys.argv.index('--recover')+1] if '--recover' in sys.argv else sys.argv[1])
    fields=('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMPDIR','TEMP','TMP')
    (job/'desktop-environment.json').write_text(json.dumps({'environment':{name:os.environ.get(name) for name in fields},'prefix':sys.prefix,'pid':os.getpid(),'creationTime':psutil.Process().create_time()}))
    (job/'status.json').write_text(json.dumps({'status':'restored' if '--recover' in sys.argv else 'waiting-parent','workerPid':os.getpid()}))
    time.sleep(.3)
`);
  for(const method of ['launchHandoff','recover']){
    fs.rmSync(path.join(job,'status.json'),{force:true});
    // Replay the actual desktop's independent process call with a real managed
    // Python. Full packaged APP lifecycle is covered by artifact acceptance.
    const start=main.indexOf(`await launcherUpdate.${method}(`);
    assert.ok(start>=0);const expression=main.slice(start,main.indexOf(');',start)+2);
    await vm.runInNewContext(`(async()=>{${expression}})()`,{path,process:{env:desktopEnv},launcherUpdate:update,
      launcherRecoveryOptions:()=>({home:f.home,executable:f.executable,python:python(),helper:path.join(job,'replace.py')}),
      hermesHome:()=>managedHome,launcherEnv:()=>maintenanceEnv,pending:{job},
      operation:{handoffRef:job,result:{parentCreationTime:1}},diagnostics:{event(){}}});
    const facts=JSON.parse(fs.readFileSync(path.join(job,'desktop-environment.json')));
    for(const name of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMPDIR','TEMP','TMP'])
      assert.equal(facts.environment[name],desktopEnv[name],`${method} changed ${name} to the maintenance profile`);
    assert.ok(facts.pid>0&&facts.creationTime>0);
    assert.equal(normalized(facts.prefix),normalized(venvHome));
    await new Promise(resolve=>setTimeout(resolve,350));
  }
});

test('unfinished launcher recovery blocks a second handoff before any new job is written', async t => {
  const f=await handoffFixture(t),job=path.join(f.home,'installer','launcher-update','job-pending');
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job,'plan.json'),JSON.stringify(planFor(f.home,f.executable)));
  const before=fs.readFileSync(path.join(job,'plan.json'));
  await assert.rejects(update.prepareHandoff(f.handoff),/请先恢复旧启动器/);
  assert.deepEqual(fs.readdirSync(path.dirname(job)), ['job-pending']);
  assert.deepEqual(fs.readFileSync(path.join(job,'plan.json')),before);
  assert.equal(fs.existsSync(path.join(job, 'replace.py')), false);
});

test('native recovery helper errors retain ENOENT cause and local traceback without touching the app', async t => {
  const { root } = fixture(t);
  const home = path.join(root, 'data'), application = path.join(root, 'application');
  const job = path.join(home, 'installer', 'launcher-update', 'job-missing-snapshot');
  const relative = process.platform === 'darwin' ? 'Contents/MacOS/launcher' : 'launcher.exe';
  const executable = path.join(application, relative);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(executable, 'old');
  const helper = path.join(__dirname, '../installer/desktop/replace-launcher.py');
  fs.copyFileSync(helper, path.join(job, 'replace.py'));
  fs.writeFileSync(path.join(job, 'plan.json'), JSON.stringify(planFor(home,executable)));
  await assert.rejects(update.finalize({ home, executable, job, helper,
    python: process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    version: '1.1.0', target: '2.4.2', systemReady: true, updateVerified: true }),
  error => error.code === 'ENOENT' && error.cause?.code === 'ENOENT'
    && error.cause.cause === undefined && /保留日志和备份/.test(error.message));
  assert.match(fs.readFileSync(path.join(job, 'replace.log'), 'utf8'), /Traceback/);
  assert.equal(fs.readFileSync(executable, 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(job, 'recovery.json')), false);
});

test('a terminal assessment is not mistaken for successful rollback', async t => {
  const f=await handoffFixture(t),job=await update.prepareHandoff(f.handoff),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json')));
  const helper=path.join(job,'replace.py');
  f.write(helper,`import sys,json
if '--assess' in sys.argv: print('null')
elif '--process-identity' in sys.argv: print(json.dumps({'pid':int(sys.argv[-1]),'creationTime':1}))
else:
 print(json.dumps({'error':{'name':'ValueError','message':'此更新已提交，无需恢复'}}));sys.exit(1)
`);
  await assert.rejects(update.prepareRecovery({home:f.home,executable:f.executable,job,python:python(),helper,
    operation:operationFor(plan,job),spawnChild:spawn}),error=>error.cause?.message.includes('已提交'));
  assert.equal(fs.readFileSync(f.executable,'utf8'),'old');
  assert.equal(fs.existsSync(path.join(job,'recovery.json')),false);
});

test('native helper UTF-8 error and traceback survive actual byte boundaries', async t => {
  const { root } = fixture(t);
  const home = path.join(root, 'data'), application = path.join(root, 'application');
  const job = path.join(home, 'installer', 'launcher-update', 'job-utf8');
  const relative = process.platform === 'darwin' ? 'Contents/MacOS/launcher' : 'launcher.exe';
  const executable = path.join(application, relative);
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, 'plan.json'), JSON.stringify(planFor(home,executable)));
  const helper = path.join(root, 'byte-helper.py');
  fs.writeFileSync(helper, `import sys,time,json
value=json.dumps({'error':{'name':'PermissionError','message':'旧启动器备份读取失败','code':'EACCES','errno':13}},ensure_ascii=False).encode('utf-8')
for byte in value:
 sys.stdout.buffer.write(bytes([byte]));sys.stdout.buffer.flush();time.sleep(0.002)
for byte in '恢复错误中文'.encode('utf-8'):
 sys.stderr.buffer.write(bytes([byte]));sys.stderr.buffer.flush();time.sleep(0.002)
sys.exit(1)
`);
  await assert.rejects(update.finalize({ home, executable, job, helper,
    python: process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    target: '2.4.2', version: '1.1.0', systemReady: true, updateVerified: true }),
  error => error.code === 'EACCES' && error.cause?.message === '旧启动器备份读取失败');
  assert.equal(fs.readFileSync(path.join(job, 'replace.log'), 'utf8'), '恢复错误中文');
});

test('handoff progress failure creates no job or detached worker', async t => {
  const f=await handoffFixture(t);
  const failure = Object.assign(new Error('fixture progress EPERM'), { code: 'EPERM' });
  await assert.rejects(update.prepareHandoff({...f.handoff,onEvent() { throw failure; }}), error => error === failure);
  assert.equal(fs.existsSync(path.join(f.home, 'installer/launcher-update')), false);
  assert.equal(fs.readFileSync(f.executable, 'utf8'), 'old');
});

test('recover progress failure never prepares or starts a worker after fresh assessment', async t => {
  const f=await handoffFixture(t),job=await update.prepareHandoff(f.handoff),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json')));
  const helper=path.join(job,'replace.py'),marker=path.join(job,'write-helper-started');
  f.write(helper,`import sys,json
from pathlib import Path
if '--assess' in sys.argv: print(json.dumps({'canRecover':True,'reason':''}))
else: Path(${JSON.stringify(marker)}).write_text('started');print(json.dumps({'pid':int(sys.argv[-1]),'creationTime':1}))
`);
  const failure = Object.assign(new Error('fixture progress EPERM'), { code: 'EPERM' });
  await assert.rejects(update.prepareRecovery({home:f.home,executable:f.executable,job,helper,python:python(),
    operation:operationFor(plan,job),spawnChild:spawn,onEvent() { throw failure; }}), error => error === failure);
  assert.equal(fs.existsSync(marker),false);
  assert.equal(fs.readFileSync(f.executable,'utf8'),'old');
});

test('spawn errors and early worker exits settle preparation without a leftover poller', async t => {
  for (const mode of ['missing-python', 'worker-error']) {
    const { root } = fixture(t), home = path.join(root, 'data'), application = path.join(root, 'application');
    const relative = process.platform === 'darwin' ? 'Contents/MacOS/launcher' : 'launcher.exe';
    const executable = path.join(application, relative),job=path.join(home,'installer/launcher-update/job-early-worker');
    fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, 'old');
    fs.mkdirSync(job,{recursive:true});fs.writeFileSync(path.join(job,'plan.json'),JSON.stringify(planFor(home,executable)));
    fs.writeFileSync(path.join(job,'replace.py'), `import json,sys,time,os
from pathlib import Path
job=Path(sys.argv[1])
(job/'status.json').write_text(json.dumps({'status':'error','workerPid':os.getpid(),'error':'fixture child failure','diagnosticError':{'name':'PermissionError','message':'fixture permission','code':'EACCES'}}))
time.sleep(.2)
sys.exit(7)
`);
    const start = Date.now();
    await assert.rejects(update.launchHandoff({ home, executable, job,
      python: mode === 'missing-python' ? path.join(root, 'absent-python') : python(),...pythonRoots(),
    }), error => error.code === (mode === 'missing-python' ? 'ENOENT' : 'EACCES'));
    assert.ok(Date.now() - start < 2000);
    if (mode === 'worker-error') assert.ok(Date.now() - start >= 200);
    assert.equal(fs.readFileSync(executable, 'utf8'), 'old');
  }
});

test('a stale ready state from a different worker never acknowledges a dead handoff process',async t=>{
  const f=await handoffFixture(t),job=await update.prepareHandoff(f.handoff);
  f.write(path.join(job,'replace.py'),`import sys,json,os
from pathlib import Path
(Path(sys.argv[1])/'status.json').write_text(json.dumps({'status':'waiting-parent','workerPid':os.getpid()+1}))
`);
  await assert.rejects(update.launchHandoff({home:f.home,executable:f.executable,job,python:python(),...pythonRoots()}),
    error=>require('../installer/desktop/launcher-errors').describeError(error).error_code==='process_failed'&&error.exitCode===0);
  assert.equal(fs.readFileSync(f.executable,'utf8'),'old');
});
