const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { makePlan, cleanup, restoreRetained, worker, RETAINED } = require('../installer/desktop/uninstall');

function fixture(t,rootName='NoraTavern') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-uninstall-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, rootName);
  const write = (relative, data = 'fixture') => {
    const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
  };
  const data = ['hermes/.env', 'hermes/SOUL.md', 'hermes/AGENTS.md', 'hermes/memories/MEMORY.md',
    'hermes/cron/jobs.json', 'hermes/clawchat/credentials.json', 'hermes/plugins/custom/data',
    'hermes/sessions/history.db', 'tavern/tavern-state/native/default-user/chats/chat.jsonl',
    'tavern/tavern-state/imports/card.png', 'installer/model.json', 'installer/backups/previous/.env',
    'installer/install.log', 'installer/operations/archived/evidence/metadata.json',
    'tavern/tavern-updates/previous/config.yaml', 'tavern/tavern-updates/history/journal.json'];
  const programs = ['hermes/hermes-agent/venv/python', 'hermes/node/node', 'hermes/python/python',
    'hermes/plugins/clawchat/plugin.py', 'hermes/clawchat/liveware/liveware', 'tavern/apps/tavern-runtime/server.js',
    'cache/tmp/stale', 'launcher/Local State'];
  for (const name of [...data, ...programs]) write(name);
  write('tavern/tavern-state/native-runtime/config.yaml', 'custom: retained');
  const plan = (mode,options={}) => makePlan({ home, hermesHome: path.join(home, 'hermes'), installRoot: path.join(home, 'tavern'), mode,...options });
  return { directory, home, write, data, programs, plan };
}

function assertLockShell(home) {
  assert.deepEqual(fs.readdirSync(home).sort(),['installer','nora-owner.json']);
  assert.deepEqual(fs.readdirSync(path.join(home,'installer')),['operations']);
  assert.deepEqual(fs.readdirSync(path.join(home,'installer/operations')),['.writer.lock']);
}

function preservedHistory(home,file){
  const root=fs.realpathSync(home),relative=path.relative(root,require('../installer/desktop/uninstall').safeRoot(file)).split(path.sep).join('/');
  const saved=require('../installer/desktop/retained-installation').inspect(root);
  const entry=saved.entries.find(item=>relative===item.from||relative.startsWith(item.from+'/'));
  assert.ok(entry,`original evidence ${relative} must be preserved by the KEEP receipt`);
  return path.join(root,entry.to,relative.slice(entry.from.length));
}

async function idlePort(){
  const server=require('node:net').createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test('keep removes programs, retains credentials, chats, config and backups; repeat is safe', t => {
  const f = fixture(t), plan = f.plan('keep');
  const events = []; cleanup(plan, event => events.push(event));
  for (const name of f.data) assert.equal(fs.readFileSync(path.join(f.home, name), 'utf8'), 'fixture', name);
  for (const name of f.programs) assert.equal(fs.existsSync(path.join(f.home, name)), false, name);
  assert.equal(fs.readFileSync(path.join(f.home, 'tavern/tavern-state/nora-retained-config.yaml'), 'utf8'), 'custom: retained');
  assert.ok(events.length > 0); assert.equal(events.at(-1).current, events.at(-1).total);
  cleanup(plan);
  assert.equal(fs.existsSync(path.join(f.home, RETAINED)), true);
});

test('a completed keep uninstall is eligible for reinstall without presenting removed programs as damaged installation', t => {
  const f=fixture(t),root=fs.realpathSync(f.home),hermes=path.join(root,'hermes'),tavern=path.join(root,'tavern');
  const version='2.4.5',commit='a'.repeat(40);
  f.write('hermes/nora-instance.json',JSON.stringify({schema:1,noraHome:root,hermesHome:hermes,installRoot:tavern,port:18879,releaseChannel:'stable'}));
  f.write('hermes/nora-installation.json',JSON.stringify({schema:1,version,commit,setupCompleted:false}));
  f.write('tavern/tavern-updates/installed.json',JSON.stringify({schema:2,version,commit}));
  f.write('tavern/tavern-updates/installed-manifest.json',JSON.stringify({schema:'tavern-release/v2',commit,versions:{tavern:version}}));
  f.write('tavern/tavern-updates/nora-system.json',JSON.stringify({schema:1,version,commit,proof:Object.fromEntries(
    ['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'].map(name=>[name,true]))}));
  const policy=require('../installer/desktop/operation-policy'),roots={noraHome:root,hermesHome:hermes,installRoot:tavern,port:18879};
  assert.equal(policy.hasManagedRecords(roots),true);
  const saved=new Map(f.data.map(relative=>[relative,fs.readFileSync(path.join(root,relative))]));
  cleanup(f.plan('keep'));
  assert.equal(policy.hasManagedRecords(roots),false,'The supported KEEP result must not request damaged-install repair');
  assert.equal(policy.inspectManagedInstallation(roots),null);
  for(const [relative,bytes]of saved)assert.deepEqual(fs.readFileSync(path.join(root,relative)),bytes);
});

test('KEEP resumes an interrupted deletion and interrupted history rename without changing the native lock inode',t=>{
  for(const interruption of ['deletion','history','completion']){
    const f=fixture(t),plan=f.plan('keep'),retained=require('../installer/desktop/retained-installation');
    f.write('tavern/tavern-updates/installed.json','{"schema":2}');
    const metadata=fs.readFileSync(path.join(f.home,'tavern/tavern-updates/installed.json'));
    const rename=fs.renameSync;let reached=false;
    fs.renameSync=function(from,to){
      if(interruption==='history'&&!reached&&path.relative(plan.root,String(to)).split(path.sep)[3]==='history'){
        rename.call(this,from,to);reached=true;throw Error('interrupted after history rename');}
      if(interruption==='completion'&&!reached&&String(to).endsWith('nora-retained.json')&&JSON.parse(fs.readFileSync(from)).state==='complete'){
        reached=true;throw Error('interrupted before completion rename');
      }
      return rename.call(this,from,to);
    };
    try{assert.throws(()=>cleanup(plan,event=>{if(interruption==='deletion'&&event.current===3){reached=true;throw Error('interrupted deletion');}}),/interrupted/);}
    finally{fs.renameSync=rename;}
    assert.equal(reached,true);
    const pending=retained.inspect(f.home,{allowPending:true}),lockFile=path.join(f.home,'installer/operations/.writer.lock'),lock=fs.statSync(lockFile,{bigint:true});
    assert.equal(pending.state,'prepared');assert.throws(()=>retained.inspect(f.home),error=>error.code==='RETAINED_UNINSTALL_INCOMPLETE');
    cleanup(plan);
    const done=retained.inspect(f.home),after=fs.statSync(lockFile,{bigint:true});assert.equal(done.id,pending.id);assert.equal(done.state,'complete');
    assert.equal(after.ino,lock.ino);assert.equal(after.dev,lock.dev);
    for(const name of f.data)assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture');
    assert.deepEqual(fs.readFileSync(path.join(f.home,done.archive,'history/tavern/tavern-updates/installed.json')),metadata);
  }
});

test('retained receipts reject foreign paths, ownership, duplicated targets and a replacement program tree',t=>{
  for(const change of ['path','owner','duplicate','program']){
    const f=fixture(t),plan=f.plan('keep'),retained=require('../installer/desktop/retained-installation');
    f.write('tavern/tavern-updates/installed.json','{"schema":2}');
    assert.throws(()=>cleanup(plan,()=>{throw Error('interrupted');}),/interrupted/);
    const file=path.join(f.home,RETAINED),pending=JSON.parse(fs.readFileSync(file));
    if(change==='path'){pending.entries[0].from='installer/model.json';pending.entries[0].to=pending.archive+'/history/installer/model.json';}
    if(change==='owner')pending.owner='foreign';
    if(change==='duplicate')pending.targets[1]=pending.targets[0];
    if(change==='program'){fs.renameSync(path.join(f.home,'hermes/hermes-agent'),path.join(f.directory,'old-program'));f.write('hermes/hermes-agent/replaced','new tree');}
    fs.writeFileSync(file,JSON.stringify(pending));
    assert.throws(()=>retained.inspect(f.home,{allowPending:true}),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
    assert.throws(()=>cleanup(plan),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
    assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  }
});

test('KEEP consume does not retire its claim for an unfinished install even when the caller supplies readiness labels',t=>{
  const f=fixture(t),retained=require('../installer/desktop/retained-installation'),crypto=require('node:crypto');cleanup(f.plan('keep'));
  const root=fs.realpathSync(f.home),id=crypto.randomUUID(),target={request:{action:'install'},releasePlan:{schema:'nora-bundled-plan/1',mode:'install',tag:'v2.4.6',commit:'a'.repeat(40)}};
  f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,kind:'install',state:'verifying',effectState:'changed',
    planSelected:true,target,planDigest:crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex')}));
  retained.claim(root,id);f.write('hermes/hermes-agent/program','incomplete program');
  const receipt=fs.readFileSync(path.join(root,'nora-retained.json')),result={systemReady:true,version:'2.4.6',commit:'a'.repeat(40),
    noraHome:root,hermesHome:path.join(root,'hermes'),installRoot:path.join(root,'tavern'),port:8799};
  assert.throws(()=>retained.consume(root,id,{result}),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
  assert.deepEqual(fs.readFileSync(path.join(root,'nora-retained.json')),receipt);
});

test('a reinstall claim requires this installation active install operation and can release only after original program removal',t=>{
  const f=fixture(t),retained=require('../installer/desktop/retained-installation');cleanup(f.plan('keep'));
  const id=require('node:crypto').randomUUID();assert.throws(()=>retained.claim(f.home,id),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
  f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,kind:'update',state:'applying'}));
  assert.throws(()=>retained.claim(f.home,id),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
  f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,kind:'install',state:'applying'}));
  retained.claim(f.home,id);assert.equal(retained.inspect(f.home,{operationId:id}).reinstallOperationId,id);
  f.write('hermes/hermes-agent/reinstalled','new');assert.throws(()=>retained.release(f.home,id),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
  fs.rmSync(path.join(f.home,'hermes/hermes-agent'),{recursive:true});retained.release(f.home,id);
  assert.equal(retained.inspect(f.home).reinstallOperationId,undefined);
});

test('legacy KEEP requires actual program absence and refuses incomplete or foreign history before archiving any data',t=>{
  for(const change of ['missing-owner','program','incomplete-runtime','foreign-first','partial-receipts','legacy-update']){
    const f=fixture(t),retained=require('../installer/desktop/retained-installation');cleanup(f.plan('keep'));
    const plan=f.plan('keep');f.write(RETAINED,JSON.stringify({schema:1,hermes:'hermes'}));
    const id=require('node:crypto').randomUUID();
    if(change==='missing-owner')fs.rmSync(path.join(f.home,'nora-owner.json'));
    if(change==='program')f.write('hermes/hermes-agent/remains','incomplete KEEP');
    if(change==='incomplete-runtime'){
      f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,kind:'install',state:'failed',effectState:'changed',recoveryOutcome:'recovery-required'}));
      f.write(`installer/operations/${id}/runtime-bootstrap.json`,JSON.stringify({schema:'nora-runtime-bootstrap/1',operationId:id,status:'applying'}));
    }
    if(change==='foreign-first'){
      f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,kind:'install',state:'succeeded',effectState:'changed',verification:'confirmed'}));
      f.write(`installer/operations/${id}/first-install/transaction.json`,JSON.stringify({schema:1,owner:'nora-first-install',operationId:id,status:'installed',noraHome:f.directory,roots:{hermes:path.join(f.home,'hermes'),tavern:path.join(f.home,'tavern')},targetDigest:'a'.repeat(64),targets:[],unrestored:[]}));
    }
    if(change==='partial-receipts')f.write('tavern/tavern-updates/installed.json','{"schema":2}');
    if(change==='legacy-update')f.write('installer/launcher-update/job-unknown/plan.json','{}');
    const before=fs.readFileSync(path.join(f.home,'hermes/.env')),receipt=fs.readFileSync(path.join(f.home,RETAINED));
    assert.throws(()=>cleanup(plan),/./,change);
    assert.deepEqual(fs.readFileSync(path.join(f.home,'hermes/.env')),before);assert.deepEqual(fs.readFileSync(path.join(f.home,RETAINED)),receipt);
    if(!['missing-owner','program'].includes(change))assert.equal(retained.inspect(f.home).legacy,true,'legacy shape alone grants no history retirement');
  }
});

test('an owned legacy KEEP with coherent receipts upgrades without consuming data or the native lock inode',t=>{
  const f=fixture(t),retained=require('../installer/desktop/retained-installation');cleanup(f.plan('keep'));
  const file=path.join(f.home,RETAINED),lock=fs.statSync(path.join(f.home,'installer/operations/.writer.lock'),{bigint:true});
  f.write(RETAINED,JSON.stringify({schema:1,hermes:'hermes'}));
  const version='2.4.5',commit='a'.repeat(40),proof=Object.fromEntries(['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'].map(key=>[key,true]));
  f.write('tavern/tavern-updates/installed.json',JSON.stringify({schema:2,version,commit}));
  f.write('tavern/tavern-updates/installed-manifest.json',JSON.stringify({schema:'tavern-release/v2',commit,versions:{tavern:version}}));
  f.write('tavern/tavern-updates/nora-system.json',JSON.stringify({schema:1,version,commit,proof}));
  const receipts=['installed.json','installed-manifest.json','nora-system.json'].map(name=>path.join(f.home,'tavern/tavern-updates',name));
  const original=receipts.map(file=>fs.readFileSync(file));cleanup(f.plan('keep'));
  const upgraded=retained.inspect(f.home);assert.equal(upgraded.schema,2);assert.equal(upgraded.state,'complete');
  for(let i=0;i<receipts.length;i++)assert.deepEqual(fs.readFileSync(preservedHistory(f.home,receipts[i])),original[i]);
  for(const name of f.data)assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture');
  assert.equal(fs.statSync(path.join(f.home,'installer/operations/.writer.lock'),{bigint:true}).ino,lock.ino);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home,upgraded.archive,'previous-retained.json'))),{schema:1,hermes:'hermes'});
});

test('account home lookup failure refuses safe-root admission instead of trusting a private environment profile',t=>{
  const f=fixture(t),file=path.resolve(__dirname,'../installer/desktop/uninstall.js'),localRequire=createRequire(file);
  const context=vm.createContext({require:name=>name==='node:os'?{...os,userInfo:()=>{throw Error('OS account lookup failed');}}:localRequire(name),
    __filename:file,__dirname:path.dirname(file),module:{exports:{}},process,console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  assert.throws(()=>context.module.exports.safeRoot(f.home),/OS account lookup failed/);
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
});

test('complete uninstall retains only the stable writer lock and owner, never adjacent Hermes', t => {
  const f = fixture(t), outside = path.join(f.directory, '.hermes');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'unrelated');
  cleanup(f.plan('all'));
  assertLockShell(f.home);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unrelated');
});

test('Windows-length paths over 260 characters are removed', t => {
  const f = fixture(t);
  f.write(`tavern/apps/runtime/node_modules/${'x'.repeat(90)}/${'y'.repeat(90)}/workerHelpers.worker.js`);
  cleanup(f.plan('all')); assertLockShell(f.home);
});

test('redirected deletion root aborts before touching any files', t => {
  for(const mode of ['keep','all']){
    const f = fixture(t), plan = f.plan(mode), outside = path.join(f.directory, 'outside');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'unrelated');
    fs.rmSync(path.join(f.home, 'cache'), { recursive: true });
    fs.symlinkSync(outside, path.join(f.home, 'cache'), 'junction');
    assert.throws(() => cleanup(plan), /链接/);
    assert.equal(fs.existsSync(path.join(f.home, f.programs[0])), true);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unrelated');
  }
});

test('nested symlinks are unlinked without following them', t => {
  const f = fixture(t), outside = path.join(f.directory, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'unrelated');
  fs.symlinkSync(outside, path.join(f.home, 'tavern/apps/external'), 'junction');
  cleanup(f.plan('all'));
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unrelated');
});

test('changed ownership and dangerous roots are rejected', t => {
  const f = fixture(t), plan = f.plan('all');
  fs.writeFileSync(path.join(f.home, 'nora-owner.json'), JSON.stringify({ schema: 1, id: 'different' }));
  assert.throws(() => cleanup(plan), /归属|变化/);
  assert.equal(fs.existsSync(path.join(f.home, 'hermes/.env')), true);
  assert.throws(() => f.plan('unknown'), /方式/);
  assert.throws(() => makePlan({ home: os.homedir(), hermesHome: '.hermes', installRoot: 'tavern', mode: 'all' }), /用户目录/);
  assert.throws(() => makePlan({ home: f.home, hermesHome: f.directory, installRoot: path.join(f.home, 'tavern'), mode: 'all' }), /越过/);
});

test('retained Hermes data overlays the new runtime, not its binaries', t => {
  const f = fixture(t); cleanup(f.plan('keep'));
  const previous = path.join(f.directory, 'previous'), current = path.join(f.home, 'hermes');
  fs.renameSync(current, previous);
  fs.mkdirSync(path.join(previous, 'plugins/clawchat'), { recursive: true });
  fs.writeFileSync(path.join(previous, 'plugins/clawchat/plugin.py'), 'old interrupted cleanup');
  f.write('hermes/hermes-agent/runtime', 'new'); f.write('hermes/.env', 'new-empty');
  f.write('hermes/plugins/clawchat/plugin.py', 'new plugin');
  assert.equal(restoreRetained(f.home, previous, current), true);
  assert.equal(fs.readFileSync(path.join(current, '.env'), 'utf8'), 'fixture');
  assert.equal(fs.readFileSync(path.join(current, 'hermes-agent/runtime'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(current, 'plugins/clawchat/plugin.py'), 'utf8'), 'new plugin');
  assert.equal(fs.readFileSync(path.join(current, 'plugins/custom/data'), 'utf8'), 'fixture');
});

test('standalone helper records actual completion outside the deleted root', async t => {
  const f = fixture(t), file = path.join(f.directory, 'nora-uninstall.json');
  fs.writeFileSync(file, JSON.stringify(f.plan('all',{port:await idlePort()})));
  await worker(file, () => {});
  const result = JSON.parse(fs.readFileSync(path.join(f.directory, 'result.json'), 'utf8'));
  assert.equal(result.state, 'complete');assert.equal(result.serviceVerification.offline,true);
  assert.equal(result.serviceVerification.method,'native-os');assertLockShell(f.home);
});

test('all builds include helper; NSIS upgrade path bypasses both destructive hooks', () => {
  const desktop = path.resolve(__dirname, '../installer/desktop');
  const pkg = require(path.join(desktop, 'package.json'));
  assert.ok(pkg.build.files.includes('uninstall.js')); assert.equal(pkg.build.nsis.include, 'uninstall.nsh');
  const script = fs.readFileSync(path.join(desktop, 'uninstall.nsh'), 'utf8');
  assert.equal(script.match(/\$\{IfNot\} \$\{isUpdated\}/g).length, 2);
  assert.ok(script.includes('Call un.checkAppRunning'));
  assert.ok(script.includes('result.json')); assert.ok(script.includes('ELECTRON_RUN_AS_NODE'));
});

function wizard(t, responses) {
  const f = fixture(t), dialogs = [], exits = [];
  fs.writeFileSync(path.join(f.directory,'launcher.exe'),'confirmation-only fixture executable');
  const main = path.resolve(__dirname, '../installer/desktop/main.js');
  const localRequire = createRequire(main);
  const electron = { app: { isPackaged: true, getPath: () => f.directory, getVersion:()=> '2.1.3', exit: code => exits.push(code) },
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: responses.shift() }; } } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === 'node:child_process'
      ? { spawnSync: () => ({ status: 1 }) } : localRequire(name),
    __dirname: path.dirname(main), console, setTimeout, clearTimeout,
    process: { platform: 'win32', argv: [], on() {}, env: { NORA_TAVERN_HOME: f.home }, pid:process.pid,
      resourcesPath:path.resolve(path.dirname(main),'..'),execPath: path.join(f.directory, 'launcher.exe') },
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context);
  // Wizard-only fixture: maintenance ownership is proved in the native tests.
  context.fixtureOwnedTask=async(_kind,_request,execute)=>{const result=await execute({stage:async()=>{}});assert.equal(result.verification,'confirmed');return result.value;};
  vm.runInContext('actualOwnedTask=runOwnedTask;runOwnedTask=fixtureOwnedTask;',context);
  const planFile = path.join(f.directory, 'nora-uninstall.json');
  context.planFile = planFile;
  return { ...f, context, dialogs, exits, planFile, run: () => vm.runInContext('confirmUninstall(planFile)', context) };
}

test('cancel leaves data and services untouched and creates no deletion plan', async t => {
  const f = wizard(t, [0]);
  assert.equal(await f.run(), false);
  assert.equal(fs.existsSync(f.planFile), false); assert.deepEqual(f.exits, []);
  assert.equal(fs.existsSync(path.join(f.home, 'hermes/.env')), true);
});

test('complete uninstall requires a second destructive confirmation', async t => {
  const f = wizard(t, [2, 0]);
  assert.equal(await f.run(), false); assert.equal(f.dialogs.length, 2);
  assert.equal(f.dialogs[1].defaultId, 0);
  assert.equal(fs.existsSync(f.planFile), false);
});

test('confirmed keep hands off exact installation paths, without deleting data in the UI process', async t => {
  const f = wizard(t, [1]);
  assert.equal(await f.run(), true);
  const plan = JSON.parse(fs.readFileSync(f.planFile));
  assert.equal(plan.mode, 'keep'); assert.equal(plan.root, fs.realpathSync(f.home));
  assert.equal(fs.existsSync(path.join(f.home, 'hermes/.env')), true);
  assert.deepEqual(f.exits, [0]);
});

test('the original KEEP confirmation resumes only its prepared uninstall through a port-bound native proof',async t=>{
  const f=wizard(t,[1]),plan=f.plan('keep',{port:18888});
  assert.throws(()=>cleanup(plan,event=>{if(event.current===3)throw Error('interrupted');}),/interrupted/);
  f.context.findPython=()=>{throw Error('partial Python must never be executed for a prepared KEEP retry');};
  assert.equal(await f.run(),true);
  const retry=JSON.parse(fs.readFileSync(f.planFile));assert.equal(retry.serviceMode,'retained');assert.equal(retry.port,18888);
  assert.equal(retry.serviceCheck.mode,'retained');assert.equal(retry.serviceCheck.port,18888);
  assert.equal(retry.retainedId,require('../installer/desktop/retained-installation').inspect(f.home,{allowPending:true}).id);
  assert.throws(()=>cleanup({...retry,retainedId:require('node:crypto').randomUUID()}),error=>error.code==='UNINSTALL_SERVICES_UNCONFIRMED');
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  assert.throws(()=>makePlan({home:f.home,hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern'),mode:'keep',port:18889,serviceMode:'retained'}),error=>error.code==='UNINSTALL_SERVICES_UNCONFIRMED');
});

test('prepared KEEP still refuses a listening service before cleanup',async t=>{
  const f=fixture(t),net=require('node:net'),server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port,plan=f.plan('keep',{port});assert.throws(()=>cleanup(plan,()=>{throw Error('interrupted');}),/interrupted/);
  const retry=f.plan('keep',{port,serviceMode:'retained'}),file=path.join(f.directory,'nora-uninstall.json');fs.writeFileSync(file,JSON.stringify(retry));
  const before=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=before;}
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json')));
  assert.equal(result.state,'error');assert.equal(result.code,'UNINSTALL_SERVICES_UNCONFIRMED');
  for(const name of f.programs)assert.equal(fs.existsSync(path.join(f.home,name)),true);
  assert.equal(require('../installer/desktop/retained-installation').inspect(f.home,{allowPending:true}).state,'prepared');
});

test('confirmed all requires both confirmations and hands off only the displayed installation',async t=>{
  const f=wizard(t,[2,1]);
  const roots=vm.runInContext('({noraHome:noraHome(),hermesHome:hermesHome(),installRoot:installRoot()})',f.context);
  f.write('hermes/nora-instance.json',JSON.stringify({schema:1,...roots,port:18888}));
  f.write('installer/state.json',JSON.stringify({schema:1,port:17777}));
  assert.equal(await f.run(),true);assert.equal(f.dialogs.length,2);
  const plan=JSON.parse(fs.readFileSync(f.planFile));
  assert.equal(plan.mode,'all');assert.equal(plan.root,fs.realpathSync(f.home));
  assert.equal(plan.port,18888);assert.equal(plan.serviceCheck.port,18888);
  assert.equal(fs.realpathSync(f.dialogs[1].detail),plan.root);assert.equal(f.dialogs[1].defaultId,0);
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  assert.deepEqual(f.exits,[0]);
});

test('all confirmation with unknown instance port hands off to the locked native root proof',async t=>{
  const f=wizard(t,[2,1]);f.write('hermes/nora-instance.json','{malformed');
  assert.equal(await f.run(),true);
  const plan=JSON.parse(fs.readFileSync(f.planFile));assert.equal(plan.port,null);assert.equal(plan.serviceMode,'native-root');
  assert.equal(plan.serviceCheck.mode,'native-root');assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
});

test('only all hands off corrupt historical admission after the real controller refuses before stop',async t=>{
  const f=wizard(t,[2,1]),id='11111111-1111-4111-8111-111111111111';
  f.write(`installer/operations/${id}/operation.json`,'{malformed');
  f.context.python=process.env.NORA_TEST_PYTHON;f.context.stopCalls=0;
  vm.runInContext('findPython=()=>({command:python,args:[]});runOwnedTask=actualOwnedTask;runBridge=async()=>{stopCalls++;throw Error("must not reach stop");};',f.context);
  assert.equal(await f.run(),true);assert.equal(f.context.stopCalls,0);
  const plan=JSON.parse(fs.readFileSync(f.planFile));assert.equal(plan.serviceMode,'native-root');assert.equal(plan.port,null);
  assert.equal(fs.readFileSync(path.join(f.home,`installer/operations/${id}/operation.json`),'utf8'),'{malformed');
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
});

test('failure to stop a service prevents creation of an uninstall plan', async t => {
  for(const choices of [[1],[2,1]]){
    const f = wizard(t, choices);
    vm.runInContext('findPython = () => ({}); runBridge = async () => { throw new Error("service still running"); }', f.context);
    await assert.rejects(f.run(), /service still running/);
    assert.equal(fs.existsSync(f.planFile), false);
    assert.equal(fs.existsSync(path.join(f.home, f.programs[0])), true);
  }
});


test('uninstall cannot delete files while a maintenance guard owns the installation',async t=>{
  const f=fixture(t),plan=f.plan('all');
  const lock=require('../installer/desktop/operation-lock');
  const lease=await lock.acquire({directory:path.join(f.home,'installer'),operationId:'uninstall-busy',ownerEpoch:1});
  try{
    assert.throws(()=>cleanup(plan),error=>error.code==='OPERATION_BUSY');
    assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  }finally{await lease.release();}
});

test('all preserves the native lock identity throughout deletion and reinstallation',async t=>{
  const f=fixture(t),plan=f.plan('all'),native=require('../installer/desktop/os-lock');
  const directory=path.join(f.home,'installer'),file=path.join(directory,'operations/.writer.lock');
  const first=native.acquire({directory});first.release();
  const before=fs.statSync(file,{bigint:true});
  cleanup(plan,()=>{
    assert.throws(()=>native.acquire({directory}),error=>error.code==='OPERATION_BUSY');
  });
  const after=fs.statSync(file,{bigint:true});
  assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);
  assertLockShell(f.home);
  const next=native.acquire({directory});next.release();
});

test('parent wait requires positive creation identity before deleting anything',async t=>{
  const f=fixture(t),file=path.join(f.directory,'nora-uninstall.json'),plan=f.plan('all');
  plan.parentPid=process.pid;delete plan.parentIdentity;
  fs.writeFileSync(file,JSON.stringify(plan));
  const before=process.exitCode;await worker(file,()=>{});process.exitCode=before;
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8')).state,'error');
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
});

function parentIdentityHarness(platform, result) {
  const file=path.resolve(__dirname,'../installer/desktop/uninstall.js');
  const localRequire=createRequire(file),childProcess=require('node:child_process'),calls=[];
  const context=vm.createContext({require:name=>name==='node:child_process'?{...childProcess,
    spawnSync:(...args)=>{calls.push(args);return typeof result==='function'?result():result;}}:localRequire(name),
    __filename:file,__dirname:path.dirname(file),module:{exports:{}},
    process:{...process,platform,stderr:{write(){}}},console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  return {identity:context.processIdentity,worker:context.module.exports.worker,diagnostic:context.localDiagnostic,calls};
}

test('parent identity query fails closed on spawn errors and incomplete OS results',async t=>{
  for(const platform of ['darwin','win32']){
    for(const code of ['ENOENT','EACCES','ETIMEDOUT'])await t.test(`${platform} ${code}`,()=>{
      const cause=Object.assign(new Error('controlled OS process query failure'),{code,syscall:'spawnSync identity-query',errno:-2,
        stdout:'PRIVATE_PROCESS_OUTPUT',env:{PRIVATE_CONFIGURATION:'not a diagnostic field'}});
      const harness=parentIdentityHarness(platform,{error:cause,status:null,signal:null,stdout:null,stderr:null});
      assert.throws(()=>harness.identity(process.pid),error=>{
        assert.equal(error.code,'UNINSTALL_PARENT_UNCONFIRMED');
        assert.equal(error.cause,cause);assert.equal(error.cause.code,code);assert.equal(error.cause.syscall,cause.syscall);
        const diagnostic=harness.diagnostic(error);
        assert.equal(diagnostic.cause.code,code);assert.equal(diagnostic.cause.syscall,cause.syscall);assert.equal(diagnostic.cause.errno,cause.errno);
        assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE_PROCESS_OUTPUT|PRIVATE_CONFIGURATION/);
        return true;
      });
    });
    const absent=platform==='darwin'?{status:1,stdout:''}:{status:0,stdout:'absent'};
    for(const [name,result] of [
      ['missing stdout',{status:0,signal:null,stderr:''}],
      ['null stdout',{status:0,signal:null,stdout:null,stderr:''}],
      ['malformed stdout',{status:0,signal:null,stdout:'not an OS creation time',stderr:''}],
      ['terminated query',{...absent,signal:'SIGTERM',stderr:''}],
      ['unsuccessful query',{...absent,status:2,signal:null,stderr:'controlled query failure'}],
      ['stderr failure on absent query',{...absent,signal:null,stderr:'controlled query failure'}],
    ])await t.test(`${platform} ${name}`,()=>{
      const harness=parentIdentityHarness(platform,result);
      assert.throws(()=>harness.identity(process.pid),error=>{
        assert.equal(error.code,'UNINSTALL_PARENT_UNCONFIRMED');
        const diagnostic=harness.diagnostic(error);
        assert.equal(diagnostic.exitCode,result.status);assert.equal(diagnostic.signal,result.signal);
        return true;
      });
    });
    await t.test(`${platform} synchronous query exception`,()=>{
      const cause=Object.assign(new Error('controlled query spawn exception'),{code:'EACCES',syscall:'spawnSync identity-query'});
      const harness=parentIdentityHarness(platform,()=>{throw cause;});
      assert.throws(()=>harness.identity(process.pid),error=>error.code==='UNINSTALL_PARENT_UNCONFIRMED'&&error.cause===cause);
    });
  }
});

test('parent identity query accepts only positive absence and live creation identity',()=>{
  const absentMac=parentIdentityHarness('darwin',{status:1,signal:null,stdout:'\n',stderr:''});
  const absentWindows=parentIdentityHarness('win32',{status:0,signal:null,stdout:'absent\r\n',stderr:''});
  assert.equal(absentMac.identity(process.pid),null);assert.equal(absentWindows.identity(process.pid),null);
  const date='Mon Oct 12 13:45:00 2026';
  const cases=[['darwin',date,Date.parse(date)/1000,1],['win32','1700000000123',1700000000.123,0.001]];
  for(const [platform,stdout,creationTime,precisionSeconds]of cases){
    const harness=parentIdentityHarness(platform,{status:0,signal:null,stdout:stdout+'\n',stderr:''});
    const value=harness.identity(process.pid);
    assert.equal(value.pid,process.pid);assert.equal(value.creationTime,creationTime);assert.equal(value.precisionSeconds,precisionSeconds);
    assert.equal(harness.calls[0][0],platform==='darwin'?'/bin/ps':'powershell.exe');
  }
  for(const stdout of ['', 'NaN', 'Infinity', '1700000000.123', '0x123', '1e12']){
    const harness=parentIdentityHarness('win32',{status:0,signal:null,stdout,stderr:''});
    assert.throws(()=>harness.identity(process.pid),error=>error.code==='UNINSTALL_PARENT_UNCONFIRMED');
  }
});

test('parent identity query failure preserves every uninstall file and the original local cause',async t=>{
  for(const platform of ['darwin','win32'])await t.test(platform,async()=>{
    const f=fixture(t),plan=f.plan('all'),file=path.join(f.directory,'nora-uninstall.json');
    plan.parentPid=process.pid;fs.writeFileSync(file,JSON.stringify(plan));
    const cause=Object.assign(new Error('controlled unavailable identity query'),{code:'ENOENT',syscall:'spawnSync identity-query'});
    const harness=parentIdentityHarness(platform,{error:cause,status:null,signal:null,stdout:undefined,stderr:undefined});
    await harness.worker(file,()=>{});
    const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
    assert.equal(result.state,'error');assert.equal(result.code,'UNINSTALL_PARENT_UNCONFIRMED');
    assert.equal(result.diagnosticError.cause.code,cause.code);
    assert.equal(result.diagnosticError.cause.syscall,cause.syscall);
    assert.match(result.diagnosticError.cause.message,/controlled unavailable identity query/);
    for(const name of [...f.data,...f.programs])assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture',name);
  });
});

function uninstallDiagnosticHarness({sender,missingPackage=false,cleanupFailure}={}){
  const file=path.resolve(__dirname,'../installer/desktop/uninstall.js'),localRequire=createRequire(file),calls=[];
  const context=vm.createContext({require:name=>{
    if(name==='./lifecycle-diagnostics'){calls.push('load');return {createLifecycleDiagnostics:()=>sender};}
    if(name==='./package.json'&&missingPackage)throw Object.assign(new Error('optional package unavailable'),{code:'MODULE_NOT_FOUND'});
    if(name==='./uninstall-offline-check')return {inspect:async()=>({offline:true})};
    return localRequire(name);
  },__filename:file,__dirname:path.dirname(file),module:{exports:{}},process:{...process,platform:'win32',stderr:{write(){}},stdout:{write(){}}},
    console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  context.inspectExecutorHistory=async()=>{};
  const cleanup=context.cleanupLocked;
  if(cleanupFailure)context.cleanupLocked=(...args)=>{cleanup(...args);throw cleanupFailure;};
  return {worker:context.module.exports.worker,calls};
}
test('post-exit uninstall failure preserves its original result even when diagnostic send and close fail',async t=>{
  const f=fixture(t),plan=f.plan('all'),file=path.join(f.directory,'nora-uninstall.json'),records=[];
  plan.diagnostics={enabled:true,launcherVersion:require('../installer/desktop/package.json').version};
  f.write('installer/telemetry.json',JSON.stringify({schema:1,consentVersion:3,enabled:true,diagnosticConsentId:require('node:crypto').randomUUID()}));
  fs.writeFileSync(file,JSON.stringify(plan));
  const original=Object.assign(new Error('controlled failure after cleanup'),{code:'EACCES',syscall:'rmdir'});
  const harness=uninstallDiagnosticHarness({cleanupFailure:original,sender:{prepare:options=>{
    assert.equal(fs.existsSync(path.join(options.home,'installer','telemetry.json')),true,'snapshot precedes deletion');
    return (kind,error,options)=>{records.push({kind,error,options});return {operationId:require('node:crypto').randomUUID(),
      flush:async()=>{throw new Error('transport unavailable');},close:async()=>{throw new Error('diagnostic close failed');}}};
  },close:async()=>{throw new Error('diagnostic lease release failed');}}});
  await harness.worker(file,()=>{});
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json')));
  assert.equal(result.code,'EACCES');assert.equal(result.diagnosticError.syscall,'rmdir');assert.equal(result.error,original.message);
  assert.equal(records.length,1);assert.equal(records[0].kind,'uninstall');assert.equal(records[0].error,original);assert.equal(records[0].options.consentRemoved,true);
  assert.equal(result.diagnosticDelivery.phase,'unavailable');assertLockShell(f.home);
  const next=require('../installer/desktop/os-lock').acquire({directory:path.join(f.home,'installer')});next.release();
});
test('missing optional diagnostic resources cannot turn a valid ALL uninstall into failure',async t=>{
  const f=fixture(t),plan=f.plan('all'),file=path.join(f.directory,'nora-uninstall.json');
  plan.diagnostics={enabled:true,launcherVersion:require('../installer/desktop/package.json').version};fs.writeFileSync(file,JSON.stringify(plan));
  await uninstallDiagnosticHarness({missingPackage:true}).worker(file,()=>{});
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'))).state,'complete');assertLockShell(f.home);
});
test('a source test plan never starts the production diagnostic sender',async t=>{
  const f=fixture(t),plan=f.plan('all'),file=path.join(f.directory,'nora-uninstall.json');fs.writeFileSync(file,JSON.stringify(plan));
  const harness=uninstallDiagnosticHarness();await harness.worker(file,()=>{});assert.deepEqual(harness.calls,[]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'))).state,'complete');assertLockShell(f.home);
});

test('an orphaned executor ledger blocks uninstall until positive offline proof',async t=>{
  const f=fixture(t),file=path.join(f.directory,'nora-uninstall.json');
  f.write('installer/operations/.guards/orphan.json',JSON.stringify({schema:'nora-operation-guard/1',operationId:'orphan',jobs:[{jobId:'unknown',pid:process.pid}]}));
  fs.writeFileSync(file,JSON.stringify(f.plan('all',{port:await idlePort()})));
  const before=process.exitCode;await worker(file,()=>{});process.exitCode=before;
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
  assert.equal(result.state,'error');assert.equal(result.code,'OPERATION_EXECUTOR_UNCONFIRMED');
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  assert.throws(()=>cleanup(f.plan('all')),error=>error.code==='OPERATION_EXECUTOR_UNCONFIRMED');
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
});

test('keep refuses an unfinished file transaction and preserves its recovery evidence',t=>{
  const f=fixture(t),id='11111111-1111-4111-8111-111111111111';
  f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,state:'failed',effectState:'changed',recoveryOutcome:'recovery-required'}));
  assert.throws(()=>cleanup(f.plan('keep')),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  assert.equal(fs.readFileSync(path.join(f.home,'tavern/tavern-updates/previous/config.yaml'),'utf8'),'fixture');
});

test('actual corrupt system and legacy journals block keep even without an Operation record',t=>{
  for(const journal of ['tavern/tavern-updates/transaction.json','installer/system-update/journal.json']){
    const f=fixture(t);
    f.write(journal,JSON.stringify(journal.includes('system-update')?{schema:1,phase:'applying'}:{schema:1,status:'applying'}));
    assert.throws(()=>cleanup(f.plan('keep')),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
    for(const name of [...f.data,...f.programs])assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture',name);
    assert.equal(fs.existsSync(path.join(f.home,RETAINED)),false);
    assert.equal(fs.existsSync(path.join(f.home,'tavern/tavern-state/nora-retained-config.yaml')),false);
  }
});

test('all clears incomplete recovery history inside the confirmed root while keep preserves it',async t=>{
  const id='11111111-1111-4111-8111-111111111111';
  const histories=[
    [`installer/operations/${id}/operation.json`,{schema:'nora-operation/1',operationId:id,state:'failed',effectState:'changed',recoveryOutcome:'recovery-required'}],
    [`installer/operations/${id}/runtime-bootstrap.json`,{schema:'nora-runtime-bootstrap/1',operationId:id,status:'applying'}],
    [`installer/operations/${id}/first-install/transaction.json`,{schema:1,owner:'nora-first-install',operationId:id,status:'applying'}],
    ['tavern/tavern-updates/transaction.json',{schema:1,status:'applying'}],
    ['installer/system-update/journal.json',{schema:1,phase:'applying'}],
    ['installer/launcher-update/job-interrupted/plan.json',{schema:2,version:'2.1.2'}],
  ];
  for(const [journal,value] of histories)await t.test(journal,()=>{
    const f=fixture(t);f.write(journal,JSON.stringify(value));
    assert.throws(()=>cleanup(f.plan('keep')),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
    for(const name of [...f.data,...f.programs])assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture',name);
    assert.equal(fs.existsSync(path.join(f.home,RETAINED)),false);
    cleanup(f.plan('all'));
    assertLockShell(f.home);
  });
});

test('all ignores forged historical deletion targets and removes only the confirmed installation',t=>{
  const f=fixture(t),outside=path.join(f.directory,'unrelated');fs.mkdirSync(outside);
  const keep=path.join(outside,'keep');fs.writeFileSync(keep,'unrelated');
  f.write('tavern/tavern-updates/transaction.json',JSON.stringify({schema:1,status:'applying',
    recoveryPlan:{targets:[{namespace:'install',relative:keep}],backup:outside}}));
  f.write('installer/launcher-update/job-interrupted/plan.json',JSON.stringify({schema:2,home:outside,appRoot:outside}));
  assert.throws(()=>cleanup(f.plan('keep')),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
  cleanup(f.plan('all'));
  assertLockShell(f.home);assert.equal(fs.readFileSync(keep,'utf8'),'unrelated');
});

test('all with incomplete history still requires the real native writer and offline executor proof',async t=>{
  const f=fixture(t),id='11111111-1111-4111-8111-111111111111';
  f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,state:'failed',effectState:'unknown'}));
  const plan=f.plan('all'),lock=require('../installer/desktop/operation-lock');
  const lease=await lock.acquire({directory:path.join(f.home,'installer'),operationId:'uninstall-busy',ownerEpoch:1});
  try{assert.throws(()=>cleanup(plan),error=>error.code==='OPERATION_BUSY');}
  finally{await lease.release();}
  f.write('installer/operations/.guards/orphan.json',JSON.stringify({schema:'nora-operation-guard/1',operationId:'orphan',
    jobs:[{jobId:'unknown',pid:process.pid}]}));
  assert.throws(()=>cleanup(plan),error=>error.code==='OPERATION_EXECUTOR_UNCONFIRMED');
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
});

test('standalone all worker clears incomplete recovery history after native ownership checks',async t=>{
  const f=fixture(t),file=path.join(f.directory,'nora-uninstall.json');
  f.write('installer/system-update/journal.json',JSON.stringify({schema:1,phase:'applying'}));
  fs.writeFileSync(file,JSON.stringify(f.plan('all',{port:await idlePort()})));
  const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
  assert.equal(result.state,'complete');assert.equal(result.mode,'all');assertLockShell(f.home);
});

test('worker refuses a service that reappears after the UI shutdown and before helper ownership',async t=>{
  const f=fixture(t),net=require('node:net'),server=net.createServer(socket=>socket.end());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const file=path.join(f.directory,'nora-uninstall.json'),port=server.address().port;
  const plan=makePlan({home:f.home,hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern'),mode:'all',port});
  fs.writeFileSync(file,JSON.stringify(plan));
  const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
  assert.equal(result.state,'error');assert.equal(result.code,'UNINSTALL_SERVICES_UNCONFIRMED');
  for(const name of [...f.data,...f.programs])assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture',name);
});

test('worker requires current resource and port bindings before deleting any files',async t=>{
  for(const kind of ['missing binding','different port','changed resource'])await t.test(kind,async()=>{
    const f=fixture(t),plan=f.plan('all',{port:await idlePort()}),file=path.join(f.directory,'nora-uninstall.json');
    let restore=()=>{};
    if(kind==='missing binding')delete plan.serviceCheck;
    else if(kind==='different port')plan.serviceCheck.port++;
    else {
      const resource=plan.serviceCheck.resources['operation-budget.json'].path,before=fs.readFileSync(resource);
      fs.writeFileSync(resource,Buffer.concat([before,Buffer.from('\n')]));restore=()=>fs.writeFileSync(resource,before);
    }
    const previous=process.exitCode;
    try{fs.writeFileSync(file,JSON.stringify(plan));await worker(file,()=>{});}finally{process.exitCode=previous;restore();}
    const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
    assert.equal(result.state,'error');assert.equal(result.code,'UNINSTALL_SERVICES_UNCONFIRMED');
    for(const name of [...f.data,...f.programs])assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture',name);
  });
});

test('without Python a real root-owned process blocks deletion even with no listener or PID hint',{timeout:30000},async t=>{
  const f=fixture(t),{spawn}=require('node:child_process'),{once}=require('node:events');
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:f.home,stdio:'ignore'});
  const closed=once(child,'close');await once(child,'spawn');
  try{for(const options of [{port:await idlePort()},{serviceMode:'native-root',port:null}]){
    const plan=f.plan('all',options),file=path.join(f.directory,'nora-uninstall.json');
    fs.writeFileSync(file,JSON.stringify(plan));
    const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
    const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
    assert.equal(result.state,'error');assert.equal(result.code,'UNINSTALL_SERVICES_UNCONFIRMED');
    assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  }}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;}
});

test('native root proof preserves a Unicode installation while its actual process owns that directory',{timeout:30000},async t=>{
  const f=fixture(t,'诺拉 测试'),{spawn}=require('node:child_process'),{once}=require('node:events');
  // On Mac the absolute script is outside the root so only decoded cwd proves
  // ownership; on Windows its root-bound Unicode argv exercises UTF-8 CIM.
  const script=path.join(process.platform==='darwin'?f.directory:f.home,'fixture-process.cjs');
  fs.writeFileSync(script,'setInterval(()=>{},1000);');
  const child=spawn(process.execPath,[script],{cwd:f.home,stdio:'ignore'});
  const closed=once(child,'close');await once(child,'spawn');
  try{
  const plan=f.plan('all',{serviceMode:'native-root',port:null}),file=path.join(f.directory,'nora-uninstall.json');
  fs.writeFileSync(file,JSON.stringify(plan));
  const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
  assert.equal(result.state,'error');assert.equal(result.code,'UNINSTALL_SERVICES_UNCONFIRMED');
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;}
});

test('native root proof accepts a positively located absolute script from another directory',{timeout:30000},async t=>{
  const f=fixture(t),{spawn}=require('node:child_process'),{once}=require('node:events');
  const outside=path.join(f.directory,'other-instance');fs.mkdirSync(outside);
  const script=path.join(outside,'fixture-process.cjs');fs.writeFileSync(script,'setInterval(()=>{},1000);');
  const child=spawn(process.execPath,[script],{cwd:outside,stdio:'ignore'}),closed=once(child,'close');
  await once(child,'spawn');
  try{
    const plan=f.plan('all',{serviceMode:'native-root',port:null}),file=path.join(f.directory,'nora-uninstall.json');
    fs.writeFileSync(file,JSON.stringify(plan));
    const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
    const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
    assert.equal(result.state,'complete',JSON.stringify(result));assertLockShell(f.home);
    assert.equal(fs.readFileSync(script,'utf8'),'setInterval(()=>{},1000);');process.kill(child.pid,0);
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;}
});

function nativeOfflineHarness(run){
  const file=path.resolve(__dirname,'../installer/desktop/uninstall-offline-check.js'),localRequire=createRequire(file);
  const context=vm.createContext({require:name=>name==='node:child_process'?{spawnSync:run}:localRequire(name),
    __filename:file,__dirname:path.dirname(file),module:{exports:{}},Buffer,TextDecoder,console,
    process:{...process,platform:'darwin',pid:42,getuid:()=>501}});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  return context.module.exports;
}

function macHermesProofFixture(t,change=()=>{},prepare=()=>{}){
  const f=fixture(t),outside=path.join(f.directory,'Other home = safe');fs.mkdirSync(outside);
  const saved=new Map([...f.data,...f.programs].map(name=>[name,fs.readFileSync(path.join(f.home,name))]));
  const record={schema:'nora-uninstall-mac-process/1',pid:43,uid:501,created:[1700000000,123456],
    argv:['/usr/bin/python3','-B','-m','hermes_cli.main','gateway','run'],environment:{HERMES_HOME:outside}};
  prepare(f,outside,record);
  let reads=0;
  const success=stdout=>({status:0,signal:null,stdout,stderr:''});
  const check=nativeOfflineHarness((command,args)=>{
    if(command==='/usr/sbin/lsof')return success(`p43\ncPython\nfcwd\nn${outside}\nftxt\nn/usr/bin/python3\n`);
    if(args.includes('pid=,uid=,comm='))return success('42 501 /App/checker\n43 501 /usr/bin/python3\n');
    if(args.includes('args='))return success('/usr/bin/python3 -m hermes_cli.main gateway run\n');
    if(command==='/usr/bin/osascript'){
      const current=JSON.parse(JSON.stringify(record)),result=change(current,++reads,f,outside);
      if(result)return result;
      return success(JSON.stringify(current));
    }
    throw Error('Unexpected native process query');
  });
  return {...f,outside,record,check,saved,get reads(){return reads;}};
}

test('native root proof permits a positively bound unrelated Hermes home without mutating either instance',{skip:process.platform!=='darwin'},t=>{
  const f=macHermesProofFixture(t);
  assert.doesNotThrow(()=>f.check.nativeOffline({root:fs.realpathSync(f.home)}));
  assert.equal(f.reads,2,'A stable kernel identity must bracket the open-file proof');
  for(const [name,before] of f.saved)assert.deepEqual(fs.readFileSync(path.join(f.home,name)),before);
});

test('Mac Hermes proof refuses owned, missing, unreadable and changing process bindings before deletion',{skip:process.platform!=='darwin'},async t=>{
  for(const kind of ['owned','missing home','relative home','overlapping home','filesystem root','symlink home','interpreter alias','unreadable','changed birth','changed home','wrong pid','wrong uid','inline argv','bound module source','bound Python launcher','bound Python executable','bound Python prefix','malformed proof'])await t.test(kind,t=>{
    const f=macHermesProofFixture(t,(record,read,f)=>{
      if(kind==='owned')record.environment.HERMES_HOME=f.home;
      if(kind==='missing home')delete record.environment.HERMES_HOME;
      if(kind==='relative home')record.environment.HERMES_HOME='relative-home';
      if(kind==='overlapping home')record.environment.HERMES_HOME=f.directory;
      if(kind==='filesystem root')record.environment.HERMES_HOME='/';
      if(kind==='symlink home'){
        const alias=path.join(f.directory,'linked-home');if(!fs.existsSync(alias))fs.symlinkSync(f.home,alias,process.platform==='win32'?'junction':'dir');
        record.environment.HERMES_HOME=alias;
      }
      if(kind==='unreadable')return {status:1,signal:null,stdout:'',stderr:'Process arguments unavailable'};
      if(kind==='changed birth'&&read===2)record.created[1]++;
      if(kind==='changed home'&&read===2)record.environment.HERMES_HOME=f.directory;
      if(kind==='wrong pid')record.pid++;
      if(kind==='wrong uid')record.uid++;
      if(kind==='inline argv')record.argv=['/usr/bin/python3','-c','import hermes_cli.main','gateway','run'];
      if(kind==='bound module source')record.environment.PYTHONPATH=path.join(f.home,'hermes');
      if(kind==='bound Python launcher')record.environment.__PYVENV_LAUNCHER__=path.join(f.home,f.programs[0]);
      if(kind==='bound Python executable')record.environment.PYTHONEXECUTABLE=path.join(f.home,f.programs[0]);
      if(kind==='bound Python prefix')record.environment.PYTHONHOME=f.home;
      if(kind==='malformed proof')record.created=null;
    },(f,outside,record)=>{
      if(kind!=='interpreter alias')return;
      const runtime=path.join(f.home,'runtime/bin'),alias=path.join(outside,'runtime-alias');fs.mkdirSync(runtime,{recursive:true});
      fs.symlinkSync(process.execPath,path.join(runtime,'python'));
      fs.symlinkSync(runtime,alias,process.platform==='win32'?'junction':'dir');record.argv[0]=path.join(alias,'python');
    });
    assert.throws(()=>f.check.nativeOffline({root:fs.realpathSync(f.home)}),error=>error.code==='UNINSTALL_SERVICES_UNCONFIRMED');
    for(const [name,before]of f.saved)assert.deepEqual(fs.readFileSync(path.join(f.home,name)),before);
  });
});

test('Mac native KEEP waits for its own Hermes instance and preserves another running instance and both user data',{skip:process.platform!=='darwin',timeout:30000},async t=>{
  const f=fixture(t),{spawn}=require('node:child_process'),{once}=require('node:events');
  const external=path.join(f.directory,'external-runtime'),otherHome=path.join(f.directory,'Other Hermes = home');
  fs.mkdirSync(path.join(external,'hermes_cli'),{recursive:true});fs.mkdirSync(otherHome);
  fs.writeFileSync(path.join(external,'hermes_cli/__init__.py'),'');
  fs.writeFileSync(path.join(external,'hermes_cli/main.py'),"import time\nprint('fixture-ready',flush=True)\ntime.sleep(60)\n");
  fs.writeFileSync(path.join(otherHome,'user-data.txt'),'other-instance-data');
  const saved=new Map(f.data.map(name=>[name,fs.readFileSync(path.join(f.home,name))]));
  const child=spawn(process.env.NORA_TEST_PYTHON,['-B','-m','hermes_cli.main','gateway','run'],
    {cwd:external,env:{PATH:process.env.PATH,HERMES_HOME:otherHome,PYTHONPATH:external,DECOY:'HERMES_HOME='+f.home},stdio:['ignore','pipe','pipe']});
  const owned=spawn(process.env.NORA_TEST_PYTHON,['-B','-m','hermes_cli.main','gateway','run'],
    {cwd:external,env:{PATH:process.env.PATH,HERMES_HOME:path.join(f.home,'hermes'),PYTHONPATH:external},stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close'),ownedClosed=once(owned,'close');let startupTimer;
  try{
    await Promise.race([Promise.all([once(child.stdout,'data'),once(owned.stdout,'data')]),
      closed.then(()=>{throw Error('Other Hermes fixture exited before readiness');}),
      ownedClosed.then(()=>{throw Error('Owned Hermes fixture exited before readiness');}),
      new Promise((_,reject)=>{startupTimer=setTimeout(()=>reject(Error('Hermes fixtures readiness timeout')),5000);})]);
    clearTimeout(startupTimer);
    const plan=f.plan('keep',{port:await idlePort()}),file=path.join(f.directory,'nora-uninstall.json');fs.writeFileSync(file,JSON.stringify(plan));
    const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
    const blocked=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
    assert.equal(blocked.state,'error');assert.equal(blocked.code,'UNINSTALL_SERVICES_UNCONFIRMED');
    for(const [name,before]of saved)assert.deepEqual(fs.readFileSync(path.join(f.home,name)),before);
    for(const name of f.programs)assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture',name);
    process.kill(child.pid,0);process.kill(owned.pid,0);
    owned.kill('SIGTERM');await ownedClosed;
    try{await worker(file,()=>{});}finally{process.exitCode=previous;}
    const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
    assert.equal(result.state,'complete',JSON.stringify(result));assert.equal(result.serviceVerification.method,'native-os');
    for(const [name,before]of saved)assert.deepEqual(fs.readFileSync(path.join(f.home,name)),before);
    for(const name of f.programs)assert.equal(fs.existsSync(path.join(f.home,name)),false,name);
    assert.equal(fs.readFileSync(path.join(otherHome,'user-data.txt'),'utf8'),'other-instance-data');process.kill(child.pid,0);
    assert.equal(require('../installer/desktop/retained-installation').inspect(f.home).state,'complete');
  }finally{
    clearTimeout(startupTimer);
    for(const process of [child,owned])if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');
    await Promise.all([closed,ownedClosed]);
  }
});

test('native root proof refuses an ambiguous Hermes module process outside the installation',{timeout:30000},async t=>{
  const f=fixture(t),{spawn}=require('node:child_process'),{once}=require('node:events');
  const external=path.join(f.directory,'external-runtime'),module=path.join(external,'hermes_cli');fs.mkdirSync(module,{recursive:true});
  fs.writeFileSync(path.join(module,'__init__.py'),'');
  fs.writeFileSync(path.join(module,'main.py'),"import time\nprint('fixture-ready',flush=True)\ntime.sleep(60)\n");
  assert.ok(process.env.NORA_TEST_PYTHON,'A real Python fixture interpreter is required');
  const child=spawn(process.env.NORA_TEST_PYTHON,['-B','-m','hermes_cli.main','gateway','run'],
    {cwd:external,env:{...process.env,HERMES_HOME:f.home,PYTHONPATH:external},stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close');let startupTimer;
  try{
    await Promise.race([once(child.stdout,'data'),closed.then(()=>{throw new Error('Hermes-shaped fixture exited before readiness');}),
      new Promise((_,reject)=>{startupTimer=setTimeout(()=>reject(new Error('Hermes-shaped fixture did not become ready')),5000);})]);
    clearTimeout(startupTimer);
    const plan=f.plan('all',{serviceMode:'native-root',port:null}),file=path.join(f.directory,'nora-uninstall.json');
    fs.writeFileSync(file,JSON.stringify(plan));
    const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
    const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
    assert.equal(result.state,'error');assert.equal(result.code,'UNINSTALL_SERVICES_UNCONFIRMED');
    assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
  }finally{clearTimeout(startupTimer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;}
});

test('native process parsers require complete snapshots and reject uncertain service ownership',()=>{
  const {windowsProcesses,macFiles}=require('../installer/desktop/uninstall-offline-check');
  const self={pid:42,name:'launcher.exe',executable:'C:\\App\\launcher.exe',commandLine:'"C:\\App\\launcher.exe" helper'};
  const check=processes=>windowsProcesses(JSON.stringify({schema:'nora-uninstall-processes/1',processes}),{root:'C:\\NoraTavern',pid:42});
  assert.throws(()=>windowsProcesses('malformed private-process-argument',{root:'C:\\NoraTavern',pid:42}),error=>
    error.code==='UNINSTALL_SERVICES_UNCONFIRMED'&&!error.cause&&!error.message.includes('private-process-argument'));
  check([{pid:0,name:'System Idle Process',executable:null,commandLine:null},self]);
  for(const processes of [[],[{pid:43,name:'node.exe',executable:'C:\\Node\\node.exe',commandLine:'node server.js'}],
    [self,{pid:43,name:'node.exe',executable:'C:\\Node\\node.exe',commandLine:'node server.js'}],
    [self,{pid:43,name:'node.exe',executable:'C:\\Node\\node.exe',commandLine:'node ".\\server.js"'}],
    [self,{pid:43,name:'node.exe',executable:'C:\\Node\\node.exe',commandLine:'node --eval "setInterval(()=>{},1000)"'}],
    [self,{pid:43,name:'node.exe',executable:'C:\\Node\\node.exe',commandLine:'node relative-worker.mjs'}],
    [self,{pid:43,name:'node.exe',executable:'C:\\Node\\node.exe',commandLine:'node'}],
    [self,{pid:43,name:'python.exe',executable:'C:\\Python\\python.exe',commandLine:'python'}],
    [self,{pid:43,name:'node.exe',executable:'C:\\Node\\node.exe',commandLine:'node --require "C:\\Other\\preload.js"'}],
    [self,{pid:43,name:'python.exe',executable:'C:\\Python\\python.exe',commandLine:'python -m hermes_cli.main gateway run'}],
    [self,{pid:43,name:'node.exe',executable:null,commandLine:null}],
    [self,{pid:43,name:'node.exe',executable:'C:\\NoraTavern\\hermes\\node\\node.exe',commandLine:'node C:\\Other\\server.js'}]])
    assert.throws(()=>check(processes),error=>error.code==='UNINSTALL_SERVICES_UNCONFIRMED');
  check([self,{pid:43,name:'node.exe',executable:'C:\\Other\\node.exe',commandLine:'node "C:\\Other\\server.js"'}]);
  macFiles('p43\ncnode\nfcwd\nn/Other\nftxt\nn/usr/bin/node\n',{root:'/NoraTavern',pid:43});
  for(const text of ['p43\ncnode\nfcwd\nftxt\n','p43\ncnode\nfcwd\nn/Other\n',
    'p43\ncnode\nftxt\nn/usr/bin/node\n','p43\ncnode\nfcwd\nn/NoraTavern/hermes\nftxt\nn/usr/bin/node\n',
    'p43\ncnode\nfcwd\nn/\\x4eoraTavern/hermes\nftxt\nn/usr/bin/node\n',
    'p43\ncnode\nfcwd\nn/Other/\\xff\nftxt\nn/usr/bin/node\n'])
    assert.throws(()=>macFiles(text,{root:'/NoraTavern',pid:43}),error=>error.code==='UNINSTALL_SERVICES_UNCONFIRMED');
});

test('only all can clear an offline root with malformed metadata and an unknown port',async t=>{
  const f=fixture(t);f.write('hermes/nora-instance.json','{malformed');
  f.write('installer/state.json','{malformed');f.write('installer/system-update/journal.json','{malformed');
  assert.throws(()=>f.plan('keep',{serviceMode:'native-root',port:null}),error=>error.code==='UNINSTALL_SERVICES_UNCONFIRMED');
  assert.throws(()=>f.plan('all',{serviceMode:'native-root',port:8799}),error=>error.code==='UNINSTALL_SERVICES_UNCONFIRMED');
  const plan=f.plan('all',{serviceMode:'native-root',port:null}),file=path.join(f.directory,'nora-uninstall.json');
  assert.equal(plan.port,null);assert.equal(plan.serviceCheck.port,null);assert.equal(plan.serviceCheck.mode,'native-root');
  fs.writeFileSync(file,JSON.stringify(plan));
  const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
  assert.equal(result.state,'complete',JSON.stringify(result.diagnosticError||result));assert.equal(result.serviceVerification.mode,'native-root');
  assert.equal(result.serviceVerification.method,'native-os');assertLockShell(f.home);
});

test('worker consumes a real managed Python offline result from the bound current bridge',async t=>{
  const f=fixture(t),{spawnSync}=require('node:child_process'),python=process.env.NORA_TEST_PYTHON;
  assert.ok(python,'The source gate requires its isolated Python test environment');
  const source=path.dirname(path.dirname(python)),venv=path.join(f.home,'hermes/hermes-agent/venv');
  if(fs.existsSync(path.join(source,'pyvenv.cfg')))fs.cpSync(source,venv,{recursive:true,verbatimSymlinks:true});
  else {
    const created=spawnSync(python,['-B','-m','venv','--system-site-packages',venv],{encoding:'utf8',timeout:30000});
    assert.equal(created.status,0,created.stderr);
  }
  const config=path.join(venv,'pyvenv.cfg'),base=/^home\s*=\s*(.+)$/m.exec(fs.readFileSync(config,'utf8'))?.[1].trim();
  assert.ok(base,'the copied venv must retain its actual base interpreter binding');
  const sourcePython=path.join(source,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const sealed=process.env.NORA_TEST_MANAGED_PYTHON_ROOT||(fs.existsSync(sourcePython)&&fs.lstatSync(sourcePython).isSymbolicLink()
    &&!path.isAbsolute(fs.readlinkSync(sourcePython))?(process.platform==='win32'?base:path.dirname(base)):null);
  if(sealed){
    // A sealed runtime's venv uses relative links into its adjacent CPython.
    // Clone that managed base too, and rebase the cfg via the production token
    // interface; copying only venv makes its python link dangling on native CI.
    const managed=path.join(f.home,'hermes/python');fs.rmSync(managed,{recursive:true,force:true});
    fs.cpSync(sealed,managed,{recursive:true,verbatimSymlinks:true,...(process.platform==='win32'?{filter:()=>true}:{})});
    fs.writeFileSync(config,fs.readFileSync(config,'utf8').replace(/^home\s*=\s*.+$/m,
      `home = @@NORA_PYTHON_HOME@@${process.platform==='win32'?'':'/bin'}`));
    const runtime=require('../installer/desktop/runtime'),manifest={platform:process.platform,
      venvPython:'hermes-agent/venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'),relocatableFiles:['hermes-agent/venv/pyvenv.cfg']};
    if(process.platform==='win32')runtime.relocateFiles(path.join(f.home,'hermes'),manifest);
    else runtime.relocateTextFiles(path.join(f.home,'hermes'),manifest);
  }else if(process.platform==='win32'){
    fs.rmSync(path.join(f.home,'hermes/python'),{recursive:true,force:true});fs.symlinkSync(base,path.join(f.home,'hermes/python'),'junction');
  }
  const executable=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  assert.ok(fs.existsSync(executable),'managed Python positive fixture must be runnable rather than fall back to native OS');
  const plan=f.plan('all',{port:await idlePort()}),file=path.join(f.directory,'nora-uninstall.json');
  fs.writeFileSync(file,JSON.stringify(plan));
  const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
  assert.equal(result.state,'complete',JSON.stringify(result));assert.equal(result.serviceVerification.method,'managed-python');
  assertLockShell(f.home);
});

function runtimeJournal(f,id,{status='prepared',previous,next=null,recoveryStartedAt}={}){
  const identity=file=>{const s=fs.statSync(file,{bigint:true});return {device:String(s.dev),inode:String(s.ino)};};
  const home=fs.realpathSync(f.home),base=path.join(home,'installer/operations',id),directory=path.join(base,'runtime');
  const paths={noraHome:home,hermesHome:path.join(home,'hermes'),
    directory,stage:path.join(directory,'hermes-runtime'),backup:path.join(directory,'previous'),
    failed:path.join(directory,'failed'),journalReference:path.join(base,'runtime-bootstrap.json')};
  f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,
    kind:'install',state:'applying',effectState:'changed',recoveryOutcome:'recovery-required'}));
  const value={schema:'nora-runtime-bootstrap/1',operationId:id,ownerEpoch:1,status,paths,
    target:{sha256:'a'.repeat(64),platform:process.platform,arch:process.arch},
    identities:{previous:previous===undefined?identity(path.join(f.home,'hermes')):previous,next},recoveryStartedAt};
  f.write(`installer/operations/${id}/runtime-bootstrap.json`,JSON.stringify(value));
  return {value,identity,paths};
}

test('stale applying labels cannot block actually untouched staged or restored runtime journals',t=>{
  for(const restored of [false,true]){
    const f=fixture(t),id=require('node:crypto').randomUUID();
    runtimeJournal(f,id,{status:restored?'recovering':'prepared',recoveryStartedAt:restored?'2026-10-04T00:00:00Z':undefined});
    const transaction=require('../installer/desktop/runtime-transaction');
    assert.equal(transaction.inspect({noraHome:f.home,hermesHome:path.join(f.home,'hermes'),operationId:id}).effectState,
      restored?'restored':'untouched');
    cleanup(f.plan('keep'));
    assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
    assert.equal(fs.existsSync(path.join(f.home,f.programs[0])),false);
    assert.equal(fs.existsSync(preservedHistory(f.home,path.join(f.home,'installer/operations',id,'runtime-bootstrap.json'))),true);
  }
});

test('a saved success cannot hide an unknown runtime journal or a missing-record first-install journal',t=>{
  for(const kind of ['runtime','first','invalid-operation-directory']){
    const f=fixture(t),id=require('node:crypto').randomUUID();
    if(kind==='runtime'){
      const {value}=runtimeJournal(f,id);value.paths.hermesHome=path.join(f.directory,'foreign');
      f.write(`installer/operations/${id}/runtime-bootstrap.json`,JSON.stringify(value));
      f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,state:'succeeded',effectState:'changed'}));
    }else if(kind==='invalid-operation-directory')f.write('installer/operations/unknown-id/runtime-bootstrap.json','{}');
    else f.write(`installer/operations/${id}/first-install/transaction.json`,JSON.stringify({schema:1,owner:'nora-first-install',operationId:id,
      noraHome:f.home,roots:{hermes:path.join(f.home,'hermes'),tavern:path.join(f.home,'tavern')},status:'restored',targets:[],checkpoints:{}}));
    assert.throws(()=>cleanup(f.plan('keep')),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
    assert.equal(fs.readFileSync(path.join(f.home,f.programs[0]),'utf8'),'fixture');
    assert.equal(fs.existsSync(path.join(f.home,RETAINED)),false);
  }
});

test('a historical committed runtime is allowed only with a sealed successor and actual identity chain',t=>{
  const f=fixture(t),crypto=require('node:crypto'),oldId=crypto.randomUUID(),newId=crypto.randomUUID();
  const old=runtimeJournal(f,oldId,{status:'committed',previous:null});
  old.value.identities.next=old.identity(path.join(f.home,'hermes'));
  const previous=path.join(f.home,'installer/operations',newId,'runtime/previous');
  fs.mkdirSync(path.dirname(previous),{recursive:true});fs.renameSync(path.join(f.home,'hermes'),previous);
  f.write('hermes/hermes-agent/program','new');f.write('hermes/.env','preserved');
  const current=runtimeJournal(f,newId,{status:'committed',previous:old.value.identities.next});
  current.value.identities.next=current.identity(path.join(f.home,'hermes'));
  f.write('hermes/hermes-agent/.hermes-bootstrap-complete',JSON.stringify({schema:1,source:'nora-integrated-runtime',
    operationId:newId,sha256:current.value.target.sha256,platform:process.platform,arch:process.arch}));
  for(const [id,value] of [[oldId,old.value],[newId,current.value]]){
    f.write(`installer/operations/${id}/runtime-bootstrap.json`,JSON.stringify(value));
    f.write(`installer/operations/${id}/operation.json`,JSON.stringify({schema:'nora-operation/1',operationId:id,state:'succeeded',effectState:'changed'}));
  }
  cleanup(f.plan('keep'));
  assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'preserved');
  assert.equal(fs.existsSync(path.join(f.home,'hermes/hermes-agent')),false);
  assert.equal(fs.readFileSync(preservedHistory(f.home,path.join(previous,'.env')),'utf8'),'fixture');
  assert.equal(fs.existsSync(preservedHistory(f.home,path.join(f.home,'installer/operations',oldId,'runtime-bootstrap.json'))),true);
});

async function restoredAbsentRuntimeFixture(t,{replaceAgain=false}={}){
  const f=fixture(t),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
  const {once}=require('node:events'),desktop=path.resolve(__dirname,'../installer/desktop');
  const payload=path.join(f.directory,'runtime-payload'),source=path.join(f.directory,'runtime-source/hermes-runtime');
  fs.rmSync(path.join(f.home,'hermes'),{recursive:true});
  fs.mkdirSync(path.join(source,'hermes-agent/venv'),{recursive:true});fs.mkdirSync(payload);
  fs.writeFileSync(path.join(source,'hermes-agent/venv/python'),'runtime-fixture');
  fs.writeFileSync(path.join(source,'.env'),'retained fixture settings');
  fs.mkdirSync(path.join(source,'logs'));fs.writeFileSync(path.join(source,'logs/failed-install.log'),'retained failure evidence');
  const archive=path.join(payload,'runtime.tar.gz');
  const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'):'/usr/bin/tar';
  const packed=spawnSync(tar,['-czf',archive,'-C',path.dirname(source),'hermes-runtime']);assert.equal(packed.status,0,String(packed.stderr));
  fs.writeFileSync(path.join(payload,'nora-hermes-runtime.json'),JSON.stringify({schema:1,platform:process.platform,arch:process.arch,
    archive:path.basename(archive),format:'tar.gz',sha256:crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    nodeLinks:{},relocatableFiles:[],componentProbe:'nora-clawchat-check.py',
    components:{clawchat:{revision:'a'.repeat(40)},liveware:{sha256:'b'.repeat(64)},files:{}}}));
  // Use the real extraction, native writer, delegated worker, swaps, marker and
  // recovery. Only the full Hermes executable probe is replaced by fixture data.
  const worker=path.join(f.directory,'runtime-worker.js');
  fs.writeFileSync(worker,`const [payloadRoot,noraHome,hermesHome,mode]=process.argv.slice(2),fs=require('node:fs'),path=require('node:path');
    const runtime=require(${JSON.stringify(path.join(desktop,'runtime.js'))}),transaction=require(${JSON.stringify(path.join(desktop,'runtime-transaction.js'))});
    (async()=>{const delegate=await require(${JSON.stringify(path.join(desktop,'operation-delegate.js'))}).connect();
      const options={payloadRoot,noraHome,hermesHome,...delegate.context,delegate,allowCommitted:true,
        tools:{...runtime,async repairRuntimeAsync(){},async validateRuntimeAsync(home){
          if(!fs.existsSync(path.join(home,'hermes-agent/venv/python')))throw new Error('Fixture runtime missing');return 'runtime-fixture';}}};
      try{await transaction[mode](options);}finally{delegate.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`);
  const run=async(id,epoch,mode)=>{
    const lease=await require('../installer/desktop/operation-lock').acquire({directory:path.join(f.home,'installer'),operationId:id,ownerEpoch:epoch});
    try{const child=lease.spawn(process.execPath,[worker,payload,f.home,path.join(f.home,'hermes'),mode],{kind:'runtime-bootstrap'});
      let stderr='';child.stderr.on('data',data=>stderr+=data);const [code]=await once(child,'close');assert.equal(code,0,stderr);
    }finally{await lease.release();}
  };
  const read=id=>JSON.parse(fs.readFileSync(path.join(f.home,'installer/operations',id,'runtime-bootstrap.json'),'utf8'));
  const record=(id,epoch,createdAt,state,effectState,recoveryOutcome)=>{
    const value={schema:'nora-operation/1',operationId:id,kind:'install',state,effectState,recoveryOutcome,verification:'confirmed',
      ownerEpoch:epoch,createdAt,updatedAt:new Date().toISOString()};
    f.write(`installer/operations/${id}/operation.json`,JSON.stringify(value));return value;
  };
  const oldId=crypto.randomUUID(),oldCreatedAt=new Date().toISOString(),epoch=Date.now();
  await run(oldId,epoch,'install');await run(oldId,epoch+1,'recover');
  const old=read(oldId),oldRecord=record(oldId,epoch+1,oldCreatedAt,'rolled-back','restored','restored-and-verified');
  assert.equal(old.identities.previous,null);assert.equal(old.recoveryVerification,'files-restored');
  assert.equal(fs.existsSync(path.join(f.home,'hermes')),false);
  await new Promise(resolve=>setTimeout(resolve,2));
  const successorId=crypto.randomUUID(),successorCreatedAt=new Date().toISOString();
  await run(successorId,epoch+2,'install');
  const successor=read(successorId),successorRecord=record(successorId,epoch+2,successorCreatedAt,'succeeded','changed','not-required');
  let currentId=successorId;
  if(replaceAgain){
    await new Promise(resolve=>setTimeout(resolve,2));currentId=crypto.randomUUID();const createdAt=new Date().toISOString();
    await run(currentId,epoch+3,'install');record(currentId,epoch+3,createdAt,'succeeded','changed','not-required');
  }
  const inspect=id=>require('../installer/desktop/runtime-transaction').inspect({noraHome:f.home,hermesHome:path.join(f.home,'hermes'),operationId:id});
  assert.equal(inspect(oldId).reason,'directory-identity-unconfirmed');assert.equal(inspect(currentId).reason,'committed');
  return {...f,oldId,successorId,currentId,old,successor,oldRecord,successorRecord,inspect};
}

test('uninstall accepts an actual absent-root rollback followed by a committed reinstall without erasing its evidence',{timeout:25000},async t=>{
  for(const replaceAgain of [false,true]){
    const f=await restoredAbsentRuntimeFixture(t,{replaceAgain});
    const oldJournal=fs.readFileSync(f.old.paths.journalReference),failure=fs.readFileSync(path.join(f.old.paths.failed,'logs/failed-install.log'));
    cleanup(f.plan('keep'));
    assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'retained fixture settings');
    assert.equal(fs.existsSync(path.join(f.home,'hermes/hermes-agent')),false);
    assert.deepEqual(fs.readFileSync(preservedHistory(f.home,f.old.paths.journalReference)),oldJournal);
    assert.deepEqual(fs.readFileSync(preservedHistory(f.home,path.join(f.old.paths.failed,'logs/failed-install.log'))),failure);
  }
});

test('an absent-root rollback cannot borrow a successor proof when its physical evidence or ordering is unconfirmed',{timeout:25000},async t=>{
  const f=await restoredAbsentRuntimeFixture(t),markerFile=path.join(f.home,'hermes/hermes-agent/.hermes-bootstrap-complete');
  const marker=fs.readFileSync(markerFile),oldJournal=fs.readFileSync(f.old.paths.journalReference);
  const successorJournal=fs.readFileSync(f.successor.paths.journalReference);
  const oldRecord=fs.readFileSync(path.join(f.home,'installer/operations',f.oldId,'operation.json'));
  const successorRecord=fs.readFileSync(path.join(f.home,'installer/operations',f.successorId,'operation.json'));
  const scenarios=[
    ['pending record',old=>old.record.state='recovering'],
    ['unconfirmed record',old=>old.record.verification='unconfirmed'],
    ['unfinished journal',old=>old.journal.status='recovering'],
    ['missing completion',old=>delete old.journal.recoveryCompletedAt],
    ['missing recovery verification',old=>delete old.journal.recoveryVerification],
    ['missing preserved tree proof',old=>old.journal.newTreePreserved=false],
    ['wrong failed identity',old=>old.journal.identities.next.inode='1'],
    ['missing original absence',old=>delete old.journal.identities.previous],
    ['wrong root',old=>old.journal.paths.noraHome=path.join(f.directory,'foreign')],
    ['wrong path',old=>old.journal.paths.failed=path.join(f.directory,'foreign')],
    ['future owner',old=>{old.record.ownerEpoch=f.successorRecord.ownerEpoch+1;old.journal.ownerEpoch=old.record.ownerEpoch;}],
    ['future completion',old=>old.journal.recoveryCompletedAt='2099-01-01T00:00:00.000Z'],
    ['future record',old=>old.record.updatedAt='2099-01-01T00:00:00.000Z'],
    ['wrong successor marker',()=>fs.writeFileSync(markerFile,JSON.stringify({schema:1,source:'nora-integrated-runtime',operationId:f.oldId}))],
    ['pending successor',(_old,current)=>current.record.state='applying'],
    ['successor originally present',(_old,current)=>current.journal.identities.previous=current.journal.identities.next],
    ['stage dangling link',()=>fs.symlinkSync(path.join(f.directory,'missing-stage'),f.old.paths.stage,'junction')],
    ['backup dangling link',()=>fs.symlinkSync(path.join(f.directory,'missing-backup'),f.old.paths.backup,'junction')],
    ['failed link',()=>{fs.renameSync(f.old.paths.failed,f.old.paths.failed+'-retained');fs.symlinkSync(f.old.paths.failed+'-retained',f.old.paths.failed,'junction');}],
  ];
  for(const [name,mutate] of scenarios){
    const old={journal:JSON.parse(oldJournal),record:JSON.parse(oldRecord)},current={journal:JSON.parse(successorJournal),record:JSON.parse(successorRecord)};
    mutate(old,current);
    fs.writeFileSync(f.old.paths.journalReference,JSON.stringify(old.journal));fs.writeFileSync(f.successor.paths.journalReference,JSON.stringify(current.journal));
    f.write(`installer/operations/${f.oldId}/operation.json`,JSON.stringify(old.record));f.write(`installer/operations/${f.successorId}/operation.json`,JSON.stringify(current.record));
    const protectedFiles=[...f.data.filter(value=>!value.startsWith('hermes/')).map(value=>path.join(f.home,value)),markerFile,
      path.join(f.home,'hermes/.env'),path.join(f.home,'hermes/hermes-agent/venv/python'),f.old.paths.journalReference,
      path.join(f.old.paths.failed,'logs/failed-install.log')];
    const before=protectedFiles.map(file=>fs.readFileSync(file));
    assert.throws(()=>cleanup(f.plan('keep')),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED',name);
    protectedFiles.forEach((file,index)=>assert.deepEqual(fs.readFileSync(file),before[index],name+' '+file));
    assert.equal(fs.existsSync(path.join(f.home,RETAINED)),false,name);
    fs.writeFileSync(markerFile,marker);
    for(const file of [f.old.paths.stage,f.old.paths.backup])try{if(fs.lstatSync(file).isSymbolicLink())fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(fs.lstatSync(f.old.paths.failed).isSymbolicLink()){fs.unlinkSync(f.old.paths.failed);fs.renameSync(f.old.paths.failed+'-retained',f.old.paths.failed);}
  }
});

test('a rollback successor chain requires every later runtime writer to have completed',{timeout:25000},async t=>{
  const f=await restoredAbsentRuntimeFixture(t,{replaceAgain:true});
  for(const id of [f.successorId,f.currentId]){
    const file=path.join(f.home,'installer/operations',id,'operation.json'),before=fs.readFileSync(file),value=JSON.parse(before);
    value.state='applying';fs.writeFileSync(file,JSON.stringify(value));
    assert.throws(()=>cleanup(f.plan('keep')),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
    assert.equal(fs.readFileSync(path.join(f.home,'hermes/hermes-agent/venv/python'),'utf8'),'runtime-fixture');
    assert.equal(fs.readFileSync(path.join(f.old.paths.failed,'logs/failed-install.log'),'utf8'),'retained failure evidence');
    assert.equal(fs.existsSync(path.join(f.home,RETAINED)),false);
    fs.writeFileSync(file,before);
  }
});

async function restoredPartialRuntimeFixture(t,{kind='repair',pythonOnly=false}={}){
  const f=fixture(t),crypto=require('node:crypto'),{spawnSync}=require('node:child_process'),{once}=require('node:events');
  // Match the updater's resolved roots before constructing cross-language
  // records: Windows TEMP may use an 8.3 spelling that Python expands.
  f.directory=fs.realpathSync.native(f.directory);
  f.home=fs.realpathSync.native(f.home);
  f.plan=mode=>makePlan({home:f.home,hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern'),mode});
  const desktop=path.resolve(__dirname,'../installer/desktop'),installer=path.dirname(desktop),python=process.env.NORA_TEST_PYTHON||process.env.NORA_PYTHON;
  assert.ok(python,'A real Python interpreter is required for the canonical system inspection');
  const transaction=require('../installer/desktop/runtime-transaction'),policy=require('../installer/desktop/operation-policy'),releases=require('../installer/desktop/releases');
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),version='2.4.5',commit='a'.repeat(40),capabilities={
    operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
  const manifest={schema:'tavern-release/v2',commit,versions:{tavern:version},launcherCapabilities:capabilities,
    bootstrap:{sha256:hash('bootstrap'),managedComponents:1,minimumLauncherVersion:'2.1.2'}};
  const bodies={'release-manifest.json':JSON.stringify(manifest),'SHA256SUMS':'hashes','nora-tavern-app.tar.gz':'app',
    'nora-tavern-ops.tar.gz':'ops','nora-tavern-nora-mcp.tar.gz':'mcp','nora-tavern-first-install-bootstrap.py':'install',
    'first-install-manifest.json':'{}','nora-hermes-runtime.json':'{}','nora-tavern-dependencies.json':'{}'};
  const system={schema:'nora-system/v1',version,commit,platform:process.platform,arch:process.arch,minimumLauncherVersion:'2.1.2',
    launcherCapabilities:capabilities,files:Object.fromEntries(Object.entries(bodies).map(([name,bytes])=>
      [name,{asset:name,sha256:hash(bytes),size:Buffer.byteLength(bytes)}]))};
  bodies[`nora-system-${process.platform}-${process.arch}.json`]=JSON.stringify(system);
  const release={tag_name:'v'+version,assets:Object.entries(bodies).map(([name,bytes])=>({name,size:Buffer.byteLength(bytes),
    browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v${version}/${name}`}))};
  const instance={schema:1,noraHome:f.home,hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern'),port:8799};
  f.write('hermes/nora-instance.json',JSON.stringify(instance));f.write('hermes/config.yaml','retained configuration\n');
  f.write('hermes/hermes-agent/.hermes-bootstrap-complete',JSON.stringify({schema:1,source:'nora-integrated-runtime',
    sha256:'c'.repeat(64),platform:process.platform,arch:process.arch}));
  f.write('tavern/tavern-updates/installed.json',JSON.stringify({schema:2,version,commit,releaseManifestSha256:hash(bodies['release-manifest.json'])}));
  f.write('tavern/tavern-updates/installed-manifest.json',bodies['release-manifest.json']);
  f.write('tavern/tavern-updates/nora-system.json',JSON.stringify({schema:1,version,commit,
    proof:Object.fromEntries(['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'].map(name=>[name,true]))}));
  const world={schema_version:2,world_id:'world:partial',revision:1,name:'Preserved World',persona:{name:'',description:''},
    lifecycle:{status:'READY',error:null},source:{type:'manual',sha256:'',original_name:'',format:''},
    runtime_card:{resource_id:'resource:partial',engine:'sillytavern',binding:{avatar:'preserved.png'},ownership:'owned'},
    sessions:{default_session_id:'session:partial',items:[{session_id:'session:partial',engine:'sillytavern',
      binding:{chat_id:'preserved-chat'},opening_state:'empty'}]},knowledge:[],capabilities:{declared:[],status:'READY',items:{}},
    created_at:'2026-10-11T00:00:00.000Z',updated_at:'2026-10-11T00:00:00.000Z'};
  f.write('tavern/tavern-state/native/default-user/nora-world-core/worlds/world.json',JSON.stringify(world));
  for(const relative of ['backups/original.json','nora-story-ledger/story.json','nora-world-core/operations/history.json'])
    f.write('tavern/tavern-state/native/default-user/'+relative,'preserved story bytes');
  const readWorlds=spawnSync(process.execPath,[path.resolve(__dirname,'../updater/verify-worlds.mjs'),path.resolve(__dirname,'../../app'),
    path.join(instance.installRoot,'tavern-state/native')],{encoding:'utf8',timeout:20000});
  assert.equal(readWorlds.status,0,readWorlds.stderr);
  const worlds=JSON.parse(readWorlds.stdout);
  assert.deepEqual(worlds,{'default-user':[{worldId:'world:partial',sessions:['session:partial']}]});
  if(pythonOnly){f.write('tavern/apps/tavern-runtime/native-runtime.json','{}');f.write('tavern/apps/tavern-runtime/native_lifecycle.py','pass\n');}
  fs.rmSync(path.join(f.home,'hermes/hermes-agent/venv'),{recursive:true});
  const payload=path.join(f.directory,'partial-payload'),source=path.join(f.directory,'partial-source/hermes-runtime');fs.mkdirSync(payload);
  fs.mkdirSync(path.join(source,'hermes-agent/venv',process.platform==='win32'?'Scripts':'bin'),{recursive:true});
  fs.writeFileSync(path.join(source,'hermes-agent/venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),'fixture new Python');
  fs.mkdirSync(path.join(source,'logs'));fs.writeFileSync(path.join(source,'logs/failed-repair.log'),'preserved failed partial repair');
  const archive=path.join(payload,'runtime.tar.gz'),tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'):'/usr/bin/tar';
  const packed=spawnSync(tar,['-czf',archive,'-C',path.dirname(source),'hermes-runtime']);assert.equal(packed.status,0,String(packed.stderr));
  fs.writeFileSync(path.join(payload,'nora-hermes-runtime.json'),JSON.stringify({schema:1,platform:process.platform,arch:process.arch,
    archive:path.basename(archive),format:'tar.gz',sha256:hash(fs.readFileSync(archive)),nodeLinks:{},relocatableFiles:[],
    componentProbe:'nora-clawchat-check.py',components:{clawchat:{revision:'a'.repeat(40)},liveware:{sha256:'b'.repeat(64)},files:{}}}));
  const snapshot=()=>({...policy.inspectManagedInstallation(instance),schema:'nora-managed-partial-installation/1',programs:Object.fromEntries(
    Object.entries({app:'tavern-runtime',ops:'tavern-ops','nora-mcp':'nora-mcp'}).map(([name,relative])=>{
      const file=path.join(instance.installRoot,'apps',relative);if(!fs.existsSync(file))return [name,null];
      const stat=fs.lstatSync(file,{bigint:true});return [name,{identity:[String(stat.dev),String(stat.ino)],digest:transaction.programDigest(file)}];}))});
  // Use exactly the bounded bridge snapshot shape, rather than an effect label.
  const partial=()=>{const value=snapshot();return Object.fromEntries(['schema','version','commit','bindings','missing','programs'].map(key=>[key,value[key]]));};
  const workerFile=path.join(f.directory,'runtime-worker.js');
  fs.writeFileSync(workerFile,`const fs=require('node:fs'),path=require('node:path'),[payloadRoot,noraHome,hermesHome,mode,snapshotFile]=process.argv.slice(2);
    const runtime=require(${JSON.stringify(path.join(desktop,'runtime.js'))}),transaction=require(${JSON.stringify(path.join(desktop,'runtime-transaction.js'))});
    (async()=>{const delegate=await require(${JSON.stringify(path.join(desktop,'operation-delegate.js'))}).connect(),snapshot=JSON.parse(fs.readFileSync(snapshotFile));
      const offline=async()=>({offline:true,running:false,gatewayRunning:false}),options={payloadRoot,noraHome,hermesHome,...delegate.context,delegate,allowCommitted:true,
        partialRepair:{...snapshot,port:8799},preflightPartial:async()=>({partialRepair:snapshot,...await offline()}),verifyOffline:offline,
        tools:{...runtime,async repairRuntimeAsync(){},async validateRuntimeAsync(home){if(!fs.existsSync(path.join(home,'hermes-agent/venv',
          process.platform==='win32'?'Scripts/python.exe':'bin/python')))throw Error('fixture Python missing');return 'fixture';}}};
      try{await transaction[mode](options);if(mode==='recover')transaction.confirmPartialSystemProof(options,{effectState:'untouched',recoveryOutcome:'not-required'});}
      finally{delegate.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`);
  const run=async(id,epoch,mode)=>{
    const snapshotFile=path.join(f.directory,'snapshot.json');fs.writeFileSync(snapshotFile,JSON.stringify(partial()));
    const lease=await require('../installer/desktop/operation-lock').acquire({directory:path.join(f.home,'installer'),operationId:id,ownerEpoch:epoch});
    try{const child=lease.spawn(process.execPath,[workerFile,payload,f.home,instance.hermesHome,mode,snapshotFile],{kind:'runtime-bootstrap'});
      let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);const [code]=await once(child,'close');assert.equal(code,0,stderr);
    }finally{await lease.release();}
  };
  const oldId=crypto.randomUUID(),epoch=Date.now(),oldCreatedAt=new Date().toISOString();await run(oldId,epoch,'install');await run(oldId,epoch+1,'recover');
  const oldFile=path.join(f.home,'installer/operations',oldId,'runtime-bootstrap.json'),old=JSON.parse(fs.readFileSync(oldFile));
  const oldSelected=await releases.selectPlan({selectedRelease:release,mode:'install',launcherVersion:'2.1.2',
    fetcher:async url=>new Response(bodies[String(url).split('/').at(-1)])});
  const oldPlan=releases.sealPlan(oldSelected,{operationDirectory:path.dirname(oldFile),assertOwner:()=>{},launcherVersion:'2.1.2'});
  const oldTarget={request:{action:kind,port:8799,tag:'v'+version},releasePlan:oldPlan,currentVersion:version};
  const oldRecord={schema:'nora-operation/1',operationId:oldId,ownerEpoch:epoch+1,kind,state:'rolled-back',effectState:'restored',
    recoveryOutcome:'restored-and-verified',verification:'confirmed',createdAt:oldCreatedAt,updatedAt:new Date().toISOString(),
    sequence:8,planSelected:true,target:oldTarget,planDigest:hash(JSON.stringify(oldTarget))};
  f.write(`installer/operations/${oldId}/operation.json`,JSON.stringify(oldRecord));
  assert.equal(transaction.inspect({...instance,operationId:oldId}).restorationVerification,'confirmed');
  const original=partial();await new Promise(resolve=>setTimeout(resolve,2));
  const currentId=crypto.randomUUID(),createdAt=new Date().toISOString();await run(currentId,epoch+2,'install');
  const currentFile=path.join(f.home,'installer/operations',currentId,'runtime-bootstrap.json'),current=JSON.parse(fs.readFileSync(currentFile));
  assert.deepEqual(current.originalPartial,original);assert.deepEqual(current.previousSeal,old.previousSeal);
  const base=path.dirname(currentFile),selected=await releases.selectPlan({selectedRelease:release,mode:'install',launcherVersion:'2.1.2',
    fetcher:async url=>new Response(bodies[String(url).split('/').at(-1)])});
  const releasePlan=releases.sealPlan(selected,{operationDirectory:base,assertOwner:()=>{},launcherVersion:'2.1.2'});
  const target={request:{action:kind,port:8799,tag:'v'+version},releasePlan,currentVersion:version},currentRecord={schema:'nora-operation/1',
    operationId:currentId,ownerEpoch:epoch+2,sequence:8,kind,state:'succeeded',effectState:'changed',verification:'confirmed',recoveryOutcome:'not-required',
    createdAt,updatedAt:new Date().toISOString(),planSelected:true,target,planDigest:hash(JSON.stringify(target)),
    result:{systemReady:true,updateVerified:true,version,commit,...instance}};
  f.write(`installer/operations/${currentId}/operation.json`,JSON.stringify(currentRecord));
  const systemSnapshot=partial(),backup=path.join(instance.installRoot,'tavern-backups/direct-partial-repair');
  const script=String.raw`import importlib.util,json,sys,shutil,types
from pathlib import Path
p=json.load(sys.stdin);spec=importlib.util.spec_from_file_location('recovery',p['recovery']);r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
sys.path.insert(0,str(Path(p['updater']).parent));spec=importlib.util.spec_from_file_location('fixture_update',p['updater']);u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
home,root,backup=map(Path,(p['home'],p['root'],p['backup']))
backup.mkdir(parents=True);(backup/'host/update-receipts').mkdir(parents=True);(backup/'agents-rollback').mkdir()
shutil.copy2(home/'config.yaml',backup/'host/config.yaml')
for name in ('installed.json','installed-manifest.json','nora-system.json'):shutil.copy2(root/'tavern-updates'/name,backup/'host/update-receipts'/name)
for name in ('AGENTS.md','AGENTS.md.bak'):
 if (home/name).exists():shutil.copy2(home/name,backup/'agents-rollback'/name)
r.atomic_json(backup/r.RECEIPT,{'schema':'nora-update-backup/1','owner':'nora-tavern-updater','installRoot':str(root),'backupId':backup.name,'status':'prepared'})
stage=root/'candidate';stage.mkdir();(stage/'native-runtime.json').write_text('{}');(stage/'native_lifecycle.py').write_text('pass\n')
before={'version':p['version'],'running':False,'gatewayRunning':False,'clawchatConnected':False,'systemReady':p['pythonOnly']}
plan={**p['instance'],'before':before}
if not p['pythonOnly']:plan['partialRepair']=p['snapshot']
sys._nora_operation_delegate=types.SimpleNamespace(operation_id=p['operationId'],owner_epoch=p['epoch'],assert_active=lambda:None)
j=r.Journal.create(home,root,backup,[('app',stage,root/'apps/tavern-runtime')],version=p['version'],before=before,state=root/'tavern-state',lifecycle=plan)
j.snapshot_state()
if not p['pythonOnly']:
 j.plan['partialBaseline']={'schema':'nora-managed-partial-repair-baseline/1','partialRepair':p['snapshot'],
  'stateDigest':j.plan['state']['savedDigest'],'storyInventory':u.world_data_inventory(backup/'state',full=True),
  'worlds':p['worlds'],'readerManifestSha256':p['manifestSha'],'readerCommit':p['commit']}
j.plan['worlds']=p['worlds']
j.swap('app');j.plan.update(phase='committed',metadataPhase='applying');j.receipt_status('committed');j.save('committed');r.load(home,root,full=True)
print(json.dumps(r.effects(home,root)))`;
  const applied=spawnSync(python,['-B','-c',script],{input:JSON.stringify({recovery:path.join(installer,'update_recovery.py'),updater:path.resolve(__dirname,'../updater/update.py'),worlds,home:instance.hermesHome,
    root:instance.installRoot,backup,instance,version,commit,operationId:currentId,epoch:epoch+2,snapshot:systemSnapshot,manifestSha:releasePlan.manifestSha256,pythonOnly}),
    encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:20000});assert.equal(applied.status,0,applied.stdout+'\n'+applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status,'committed');
  currentRecord.updatedAt=new Date().toISOString();f.write(`installer/operations/${currentId}/operation.json`,JSON.stringify(currentRecord));
  assert.equal(transaction.inspect({...instance,operationId:oldId}).reason,'directory-identity-unconfirmed');
  assert.equal(transaction.inspect({...instance,operationId:currentId}).reason,'committed');
  const file=path.join(desktop,'uninstall.js'),localRequire=createRequire(file),resources=Object.fromEntries(['update_recovery.py','first_install.py','replace-launcher.py'].map(name=>
    [name,{path:path.join(installer,name)}]));
  const context=vm.createContext({require:name=>name==='./launcher-capability'?{validate:async()=>({...instance,launcherVersion:'2.1.2',
    platform:process.platform,arch:process.arch,channel:'stable',resources})}:name==='./managed-python'?{resolveExecution:()=>({command:python,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})}:localRequire(name),
    __filename:file,__dirname:path.dirname(file),module:{exports:{}},process,console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  return {...f,bodies,release,worlds,instance,context,old,oldRecord,oldFile,current,currentRecord,currentFile,backup,original,systemSnapshot,
    inspect:()=>context.inspectSealedTransactions(f.plan('keep')),
    cleanup:async mode=>{
      // The capability/Python location is the fixture adapter. Execute the
      // real inspector first, then exercise synchronous native-writer deletion.
      await context.inspectExecutorHistory(f.plan(mode));
      await context.inspectSealedTransactions(f.plan(mode));
      context.readOnlyNodeCheck=method=>assert.ok(['inspectExecutorHistory','inspectSealedTransactions'].includes(method));
      context.cleanup(f.plan(mode));
    }};
}

test('an actual confirmed partial rollback can be consumed after its direct healthy managed repair',{timeout:30000},async t=>{
  for(const kind of ['update','repair']){
    const f=await restoredPartialRuntimeFixture(t,{kind}),before=fs.readFileSync(f.oldFile),failed=fs.readFileSync(path.join(f.old.paths.failed,'logs/failed-repair.log'));
    await f.inspect();assert.deepEqual(fs.readFileSync(f.oldFile),before);
    assert.deepEqual(fs.readFileSync(path.join(f.old.paths.failed,'logs/failed-repair.log')),failed);
    await f.cleanup(kind==='repair'?'keep':'all');
    if(kind==='repair'){
      assert.equal(fs.readFileSync(path.join(f.home,'hermes/.env'),'utf8'),'fixture');
      assert.equal(fs.readFileSync(path.join(f.home,'hermes/config.yaml'),'utf8'),'retained configuration\n');
      assert.deepEqual(fs.readFileSync(preservedHistory(f.home,f.oldFile)),before);
      assert.deepEqual(fs.readFileSync(preservedHistory(f.home,path.join(f.old.paths.failed,'logs/failed-repair.log'))),failed);
      assert.equal(fs.existsSync(path.join(f.home,'tavern/apps')),false);
    }else assertLockShell(f.home);
  }
});

test('Python-only original partial rollback accepts its actual normal system successor without a partial baseline',{timeout:30000},async t=>{
  const f=await restoredPartialRuntimeFixture(t,{pythonOnly:true});
  const journal=JSON.parse(fs.readFileSync(path.join(f.home,'tavern/tavern-updates/transaction.json')));
  assert.deepEqual(f.old.originalPartial.missing,{nativeRuntime:false,nativeLifecycle:false,python:true});
  assert.equal(journal.recoveryPlan.before.systemReady,true);
  assert.equal(journal.recoveryPlan.partialBaseline,undefined);
  assert.equal(journal.recoveryPlan.lifecycle.partialRepair,undefined);
  await f.inspect();await f.cleanup('keep');
  assert.equal(fs.readFileSync(path.join(f.home,'tavern/tavern-state/native/default-user/chats/chat.jsonl'),'utf8'),'fixture');
});

test('committed partial successor rejects each altered baseline relation before deletion',{timeout:30000},async t=>{
  const f=await restoredPartialRuntimeFixture(t),file=path.join(f.home,'tavern/tavern-updates/transaction.json'),original=fs.readFileSync(file);
  await f.inspect();
  const mutations=[
    ['missing stateDigest',value=>delete value.stateDigest],
    ['false stateDigest',value=>value.stateDigest='0'.repeat(64)],
    ['missing readerManifestSha256',value=>delete value.readerManifestSha256],
    ['false readerManifestSha256',value=>value.readerManifestSha256='0'.repeat(64)],
    ['false readerCommit',value=>value.readerCommit='f'.repeat(40)],
    ['forged worlds',value=>value.worlds={notTheRecordedWorlds:true}],
    ['missing full inventory entry',value=>delete value.storyInventory[Object.keys(value.storyInventory)[0]]],
    ['changed full inventory hash',value=>value.storyInventory[Object.keys(value.storyInventory)[0]]='0'.repeat(64)],
    ['extra full inventory entry',value=>value.storyInventory['native/default-user/chats/unknown.json']='0'.repeat(64)],
    ['missing inventory',value=>delete value.storyInventory],
    ['incomplete committed parser baseline',value=>value.worlds=null],
    ['unknown baseline field',value=>value.extra=true],
  ];
  for(const [name,mutate] of mutations)await t.test(name,async()=>{
    const value=JSON.parse(original);mutate(value.recoveryPlan.partialBaseline);fs.writeFileSync(file,JSON.stringify(value));
    const before=fs.readFileSync(file),failed=fs.readFileSync(path.join(f.old.paths.failed,'logs/failed-repair.log'));
    try{await assert.rejects(f.inspect(),error=>['UNINSTALL_RECOVERY_REQUIRED','UNINSTALL_PYTHON_INSPECTION_FAILED'].includes(error.code));
      assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(path.join(f.old.paths.failed,'logs/failed-repair.log')),failed);
      assert.equal(fs.existsSync(path.join(f.home,RETAINED)),false);
    }finally{fs.writeFileSync(file,original);}
  });
  await f.inspect();
});

// This aggregate performs 39 serial, real Python/Node history inspections.
// Keep one bounded workload budget and report each rejection independently;
// a subtest timeout would not cancel its still-running Python inspector.
test('partial history rejects changed physical evidence, unfinished owners and missing direct successor proof before deletion',{timeout:120000},async t=>{
  const f=await restoredPartialRuntimeFixture(t),protectedRoot=f.home,crypto=require('node:crypto');
  f.plan('keep');
  const baseline=new Map(),links=[],extra=[];
  const inventory=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);if(entry.isDirectory())inventory(file);else if(entry.isFile())baseline.set(file,fs.readFileSync(file));
  }};inventory(protectedRoot);
  const mutateRecord=(file,change)=>{const value=JSON.parse(fs.readFileSync(file));change(value);fs.writeFileSync(file,JSON.stringify(value));};
  const oldRecord=path.join(f.home,'installer/operations',f.oldRecord.operationId,'operation.json'),currentRecord=path.join(f.home,'installer/operations',f.currentRecord.operationId,'operation.json');
  const journal=path.join(f.home,'tavern/tavern-updates/transaction.json'),previous=f.current.paths.backup;
  const cases=[
    ['old failed inode',()=>mutateRecord(f.oldFile,value=>value.identities.next.inode='1')],
    ['original tree bytes',()=>fs.appendFileSync(path.join(previous,'.env'),'changed')],
    ['original partial binding',()=>mutateRecord(f.oldFile,value=>value.originalPartial.bindings.config='0'.repeat(64))],
    ['original partial missing set',()=>mutateRecord(f.oldFile,value=>value.originalPartial.missing.python=false)],
    ['original program hash',()=>mutateRecord(f.oldFile,value=>value.originalPartial.programs.app.digest='0'.repeat(64))],
    ['re-sealed false original Python absence',()=>{
      const directory=path.join(previous,'hermes-agent/venv');fs.mkdirSync(path.join(directory,process.platform==='win32'?'Scripts':'bin'),{recursive:true});extra.push(directory);
      fs.writeFileSync(path.join(directory,process.platform==='win32'?'Scripts/python.exe':'bin/python'),'unexpected old interpreter');
      const seal=require('../installer/desktop/tree-integrity').treeSeal(previous);
      for(const file of [f.oldFile,f.currentFile])mutateRecord(file,value=>value.previousSeal=seal);
    }],
    ['re-sealed false original native absence',()=>{
      for(const file of [f.oldFile,f.currentFile])mutateRecord(file,value=>value.originalPartial.missing.nativeRuntime=false);
      mutateRecord(journal,value=>{value.recoveryPlan.partialBaseline.partialRepair.missing.nativeRuntime=false;value.recoveryPlan.lifecycle.partialRepair.missing.nativeRuntime=false;});
    }],
    ['unconfirmed rollback',()=>mutateRecord(oldRecord,value=>value.verification='unconfirmed')],
    ['pending rollback',()=>mutateRecord(oldRecord,value=>value.state='recovering')],
    ['wrong runtime kind',()=>mutateRecord(currentRecord,value=>value.kind='model')],
    ['missing preserved failure',()=>mutateRecord(f.oldFile,value=>delete value.newTreePreserved)],
    ['missing system restoration proof',()=>mutateRecord(f.oldFile,value=>delete value.partialSystemProof)],
    ['malformed old system seal',()=>mutateRecord(f.oldFile,value=>value.partialSystemProof.journalSeal={identity:['0','0'],sha256:'0'.repeat(64)})],
    ['failed system restoration proof',()=>mutateRecord(f.oldFile,value=>value.partialSystemProof.effects.recoveryOutcome='recovery-required')],
    ['wrong external state',()=>mutateRecord(f.oldFile,value=>value.partialSystemProof.stateDigest='0'.repeat(64))],
    ['original root mismatch',()=>mutateRecord(f.oldFile,value=>value.paths.noraHome=f.directory)],
    ['old stage dangling junction',()=>{fs.symlinkSync(path.join(f.directory,'absent-stage'),f.old.paths.stage,'junction');links.push(f.old.paths.stage);}],
    ['old backup dangling junction',()=>{fs.symlinkSync(path.join(f.directory,'absent-backup'),f.old.paths.backup,'junction');links.push(f.old.paths.backup);}],
    ['new backup junction',()=>{fs.renameSync(previous,previous+'-preserved');fs.symlinkSync(previous+'-preserved',previous,'junction');links.push(previous);}],
    ['failed tree junction',()=>{fs.renameSync(f.old.paths.failed,f.old.paths.failed+'-preserved');fs.symlinkSync(f.old.paths.failed+'-preserved',f.old.paths.failed,'junction');links.push(f.old.paths.failed);}],
    ['future owner epoch',()=>{mutateRecord(f.oldFile,value=>value.ownerEpoch=f.currentRecord.ownerEpoch+1);mutateRecord(oldRecord,value=>value.ownerEpoch=f.currentRecord.ownerEpoch+1);}],
    ['future completion',()=>mutateRecord(f.oldFile,value=>value.recoveryCompletedAt='2099-01-01T00:00:00.000Z')],
    ['future operation completion',()=>mutateRecord(oldRecord,value=>value.updatedAt='2099-01-01T00:00:00.000Z')],
    ['unfinished direct successor',()=>mutateRecord(currentRecord,value=>value.state='applying')],
    ['wrong current marker',()=>fs.writeFileSync(path.join(f.home,'hermes/hermes-agent/.hermes-bootstrap-complete'),'{}')],
    ['changed system backup',()=>fs.appendFileSync(path.join(f.backup,'host/update-receipts/installed.json'),' ')],
    ['changed original chat',()=>fs.appendFileSync(path.join(f.backup,'state/native/default-user/chats/chat.jsonl'),'changed')],
    ['changed old app',()=>fs.appendFileSync(path.join(f.backup,'trees/app/server.js'),'changed')],
    ['missing old state backup',()=>fs.renameSync(path.join(f.backup,'state'),path.join(f.backup,'state-preserved'))],
    ['no committed system proof',()=>mutateRecord(journal,value=>value.status='prepared')],
    ['no direct system owner',()=>mutateRecord(journal,value=>value.operationId=crypto.randomUUID())],
    ['missing full partial baseline',()=>mutateRecord(journal,value=>delete value.recoveryPlan.partialBaseline)],
    ['missing committed parser result',()=>mutateRecord(journal,value=>delete value.recoveryPlan.worlds)],
    ['incomplete committed parser result',()=>mutateRecord(journal,value=>{value.recoveryPlan.worlds=null;value.recoveryPlan.partialBaseline.worlds=null;})],
    ['unbound current runtime snapshot',()=>mutateRecord(journal,value=>{
      value.recoveryPlan.partialBaseline.partialRepair.bindings.runtimeMarker='0'.repeat(64);
      value.recoveryPlan.lifecycle.partialRepair.bindings.runtimeMarker='0'.repeat(64);
    })],
    ['changed fixed plan',()=>mutateRecord(currentRecord,value=>value.planDigest='0'.repeat(64))],
    ['unsealed original repair plan',()=>mutateRecord(oldRecord,value=>value.planSelected=false)],
    ['changed original repair plan',()=>mutateRecord(oldRecord,value=>value.planDigest='0'.repeat(64))],
    ['missing complete install assets',()=>mutateRecord(currentRecord,value=>{delete value.target.releasePlan.systemManifest;value.planDigest=crypto.createHash('sha256').update(JSON.stringify(value.target)).digest('hex');})],
  ];
  for(const [name,mutate] of cases)await t.test(name,async()=>{
    try{
      mutate();const before=new Map();for(const [file] of baseline)if(fs.existsSync(file))before.set(file,fs.readFileSync(file));
      await assert.rejects(f.cleanup('keep'),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED'||error.code==='UNINSTALL_PYTHON_INSPECTION_FAILED',name);
      for(const [file,bytes] of before)assert.deepEqual(fs.readFileSync(file),bytes,name+' '+file);
      assert.equal(fs.existsSync(path.join(f.home,RETAINED)),false,name);
    }finally{
      for(const file of links.splice(0)){fs.unlinkSync(file);if(fs.existsSync(file+'-preserved'))fs.renameSync(file+'-preserved',file);}
      for(const file of extra.splice(0))fs.rmSync(file,{recursive:true});
      if(fs.existsSync(path.join(f.backup,'state-preserved')))fs.renameSync(path.join(f.backup,'state-preserved'),path.join(f.backup,'state'));
      for(const [file,bytes] of baseline)fs.writeFileSync(file,bytes);
    }
  });
  await f.inspect();
});


async function advancePartialSystemFixture(f,{version='2.4.6',commit='b'.repeat(40),capture=true,restore=false}={}){
 const crypto=require('node:crypto'),{spawnSync}=require('node:child_process'),load=require;
 const id=crypto.randomUUID(),epoch=Math.max(...fs.readdirSync(path.join(f.home,'installer/operations')).filter(name=>/^[a-f0-9-]{36}$/i.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(f.home,'installer/operations',name,'operation.json'))).ownerEpoch))+1,hash=v=>crypto.createHash('sha256').update(v).digest('hex');
 const bodies={...f.bodies};const manifest=JSON.parse(bodies['release-manifest.json']);manifest.commit=commit;manifest.versions.tavern=version;bodies['release-manifest.json']=JSON.stringify(manifest);
 const descriptor=`nora-system-${process.platform}-${process.arch}.json`,system=JSON.parse(bodies[descriptor]);
 system.version=version;system.commit=commit;system.files['release-manifest.json'].sha256=hash(bodies['release-manifest.json']);system.files['release-manifest.json'].size=Buffer.byteLength(bodies['release-manifest.json']);bodies[descriptor]=JSON.stringify(system);
 const release={tag_name:'v'+version,assets:Object.entries(bodies).map(([name,bytes])=>({name,size:Buffer.byteLength(bytes),
  browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v${version}/${name}`}))};
 const operationDirectory=path.join(f.home,'installer/operations',id);fs.mkdirSync(operationDirectory);
 const releases=require('../installer/desktop/releases');
 const selected=await releases.selectPlan({selectedRelease:release,mode:'update',launcherVersion:'2.1.2',fetcher:async url=>new Response(bodies[String(url).split('/').at(-1)])});
 const releasePlan=releases.sealPlan(selected,{operationDirectory,assertOwner:()=>{},launcherVersion:'2.1.2'});
 const previousInstalled=JSON.parse(fs.readFileSync(path.join(f.instance.installRoot,'tavern-updates/installed.json'))),beforeVersion=previousInstalled.version;
 const target={request:{action:'update',port:8799,tag:'v'+version},releasePlan,currentVersion:beforeVersion};
 const record={schema:'nora-operation/1',operationId:id,ownerEpoch:epoch,sequence:8,kind:'update',state:'succeeded',effectState:'changed',verification:'confirmed',
  recoveryOutcome:'not-required',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),planSelected:true,target,planDigest:hash(JSON.stringify(target)),
  result:{systemReady:true,updateVerified:true,version,commit,...f.instance}};
 const backup=path.join(f.instance.installRoot,'tavern-backups/normal-update-'+version);
 const script=String.raw`import importlib.util,json,sys,shutil,types
from pathlib import Path
p=json.load(sys.stdin);spec=importlib.util.spec_from_file_location('r',p['recovery']);r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
sys.path.insert(0,str(Path(p['updater']).parent));spec=importlib.util.spec_from_file_location('u',p['updater']);u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
home,root,backup=map(Path,(p['home'],p['root'],p['backup']));backup.mkdir(parents=True);(backup/'host/update-receipts').mkdir(parents=True);(backup/'agents-rollback').mkdir()
shutil.copy2(home/'config.yaml',backup/'host/config.yaml')
for name in ('installed.json','installed-manifest.json','nora-system.json'):shutil.copy2(root/'tavern-updates'/name,backup/'host/update-receipts'/name)
for name in ('AGENTS.md','AGENTS.md.bak'):
 if (home/name).exists():shutil.copy2(home/name,backup/'agents-rollback'/name)
u.record_backup(root,backup,'prepared')
stage=root/'candidate-c';stage.mkdir();(stage/'native-runtime.json').write_text('{}');(stage/'native_lifecycle.py').write_text('pass\n')
before={'version':p['beforeVersion'],'running':False,'gatewayRunning':False,'clawchatConnected':False,'systemReady':True}
plan={**p['instance'],'before':before}
sys._nora_operation_delegate=types.SimpleNamespace(operation_id=p['operationId'],owner_epoch=p['epoch'],assert_active=lambda:None)
j=r.Journal.create(home,root,backup,[('app',stage,root/'apps/tavern-runtime')],version=p['version'],before=before,state=root/'tavern-state',lifecycle=plan)
j.snapshot_state();j.plan['worlds']=p['worlds'];j.swap('app')
paths=[root/'tavern-updates'/name for name in ('installed.json','installed-manifest.json','nora-system.json')];j.mark_metadata(paths)
r.atomic_json(paths[0],{'schema':2,'version':p['version'],'commit':p['commit'],'releaseManifestSha256':p['manifestSha']})
r.atomic_json(paths[1],p['manifest'])
r.atomic_json(paths[2],{'schema':1,'version':p['version'],'commit':p['commit'],'proof':dict.fromkeys(('hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'),True)})
j.finish_metadata(paths)
if p['restore']:
 j.plan['phase']='applying';j.save('prepared')
 r.recover(home,root,stop=lambda *_:{'offline':True},resume=lambda *_:None,
  verify=lambda *_:{'version':p['beforeVersion'],'running':False,'gatewayRunning':False,'clawchatConnected':False})
else:
 j.plan['phase']='committed';j.save('committed');u.record_backup(root,backup,'committed')
r.load(home,root,full=True)
print(json.dumps(r.effects(home,root)))`;
 const installer=path.resolve(__dirname,'../installer'),updater=path.resolve(__dirname,'../updater/update.py'),python=process.env.NORA_TEST_PYTHON||'/usr/bin/python3';
 const lease=await require('../installer/desktop/operation-lock').acquire({directory:path.join(f.home,'installer'),operationId:id,ownerEpoch:epoch});
 const pending={...record,state:'prepared',verification:'unconfirmed',effectState:'untouched'};
 fs.writeFileSync(path.join(operationDirectory,'operation.json'),JSON.stringify(pending));
 const context={operationId:id,ownerEpoch:epoch,get snapshot(){return pending;},check:()=>lease.assertActive(),
  journal:async reference=>{pending.journalRefs=[...(pending.journalRefs||[]),reference];}};
 try{if(capture)pending.effectClosureRefs=await f.context.prepareHistory(context,f.instance);
  const committed=await lease.commitOperation({record:{...pending,sequence:9},expected:{ownerEpoch:epoch,sequence:8}});
  Object.assign(pending,committed.record);record.effectClosureRefs=pending.effectClosureRefs;record.journalRefs=pending.journalRefs;record.sequence=10;
 }catch(error){await lease.release();throw error;}
 const applied=spawnSync(python,['-B','-c',script],{input:JSON.stringify({recovery:path.join(installer,'update_recovery.py'),updater,home:f.instance.hermesHome,
  root:f.instance.installRoot,backup,instance:f.instance,operationId:id,epoch,version,commit,beforeVersion,restore,manifest,manifestSha:releasePlan.manifestSha256,worlds:f.worlds}),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:20000});
 if(applied.status!==0){await lease.release();throw Error(applied.stdout+'\n'+applied.stderr);}assert.equal(JSON.parse(applied.stdout).status,restore?'restored':'committed');
 if(restore)Object.assign(record,{state:'rolled-back',effectState:'restored',verification:'confirmed',recoveryOutcome:'restored-and-verified',
  result:{updateRecovered:true,recoveryVerification:'confirmed',version:previousInstalled.version,commit:previousInstalled.commit,...f.instance}});
 record.updatedAt=new Date().toISOString();fs.writeFileSync(path.join(operationDirectory,'operation.json'),JSON.stringify(record));
 await lease.release();

 return {id,record,backup,updater,python};
}

function prunePartialFixture(f,next){
 const {spawnSync}=require('node:child_process');
 const script=String.raw`import importlib.util,json,sys
from pathlib import Path
p=json.load(sys.stdin);sys.path.insert(0,str(Path(p['updater']).parent));spec=importlib.util.spec_from_file_location('u',p['updater']);u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
print(json.dumps(u.prune_backup_history(Path(p['root']),Path(p['backup']))))`;
 const result=spawnSync(next.python,['-B','-c',script],{input:JSON.stringify({updater:next.updater,root:f.instance.installRoot,backup:next.backup}),encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

// Four independent fixtures each execute real Journal replacement and prune.
test('partial rollback history remains closed across actual normal Journal replacement and production prune',{timeout:120000},async t=>{
 for(const pythonOnly of [false,true])for(const mode of ['keep','all'])await t.test(`${pythonOnly?'Python only':'native and Python'} ${mode}`,async t=>{
  const f=await restoredPartialRuntimeFixture(t,{pythonOnly});await f.inspect();
  const failed=fs.readFileSync(path.join(f.old.paths.failed,'logs/failed-repair.log')),old=fs.readFileSync(f.oldFile),chat=fs.readFileSync(path.join(f.home,'tavern/tavern-state/native/default-user/chats/chat.jsonl'));
  const next=await advancePartialSystemFixture(f);await f.inspect();
  assert.equal(fs.existsSync(f.backup),true);const pruned=prunePartialFixture(f,next);
  assert.ok(pruned.removed.includes(f.backup));assert.equal(fs.existsSync(f.backup),false);assert.equal(fs.existsSync(next.backup),true);
  await f.inspect();const later=await advancePartialSystemFixture(f,{version:'2.4.7',commit:'c'.repeat(40)});
  const laterPruned=prunePartialFixture(f,later);assert.ok(laterPruned.removed.includes(next.backup));await f.inspect();
  const facts=require('../installer/desktop/runtime-transaction').inspect({...f.instance,operationId:f.oldRecord.operationId});
  assert.equal(facts.reason,'retired-partial-confirmed');assert.equal(facts.canRecover,false);assert.equal(facts.canResume,false);
  assert.deepEqual(fs.readFileSync(f.oldFile),old);assert.deepEqual(fs.readFileSync(path.join(f.old.paths.failed,'logs/failed-repair.log')),failed);
  await f.cleanup(mode);
  if(mode==='keep'){assert.deepEqual(fs.readFileSync(path.join(f.home,'tavern/tavern-state/native/default-user/chats/chat.jsonl')),chat);
   assert.deepEqual(fs.readFileSync(preservedHistory(f.home,f.oldFile)),old);assert.deepEqual(fs.readFileSync(preservedHistory(f.home,path.join(f.old.paths.failed,'logs/failed-repair.log'))),failed);}
  else assertLockShell(f.home);
 });
});

test('historical closure cannot be created from absent original sources and cannot be bypassed by direct Journal creation',{timeout:30000},async t=>{
 const f=await restoredPartialRuntimeFixture(t),system=path.join(f.instance.installRoot,'tavern-updates/transaction.json'),before=fs.readFileSync(system);
 await assert.rejects(advancePartialSystemFixture(f,{capture:false}),/禁止覆盖最后系统来源/);
 assert.deepEqual(fs.readFileSync(system),before);assert.equal(fs.existsSync(f.backup),true);
});

test('closure write failure preserves the last physical source and a completed capture is idempotent under its actual owner',{timeout:30000},async t=>{
 const f=await restoredPartialRuntimeFixture(t),system=path.join(f.instance.installRoot,'tavern-updates/transaction.json'),before=fs.readFileSync(system),old=fs.readFileSync(f.oldFile);
 const originalRename=fs.renameSync;let rejected=false;
 fs.renameSync=function(source,target){if(path.basename(String(target))==='partial-history.json'){rejected=true;throw Object.assign(new Error('fixture disk denied'),{code:'EACCES'});}return originalRename.call(this,source,target);};
 try{await assert.rejects(advancePartialSystemFixture(f),error=>error.code==='EACCES');assert.equal(rejected,true);}
 finally{fs.renameSync=originalRename;}
 assert.deepEqual(fs.readFileSync(system),before);assert.deepEqual(fs.readFileSync(f.oldFile),old);assert.equal(fs.existsSync(f.backup),true);
 const next=await advancePartialSystemFixture(f),history=require('../installer/desktop/operation-history'),ref=next.record.effectClosureRefs[0],proofFile=path.join(f.home,ref.path),raw=fs.readFileSync(proofFile),proof=JSON.parse(raw);
 const lease=await require('../installer/desktop/operation-lock').acquire({directory:path.join(f.home,'installer'),operationId:next.id,ownerEpoch:next.record.ownerEpoch});
 try{const context={operationId:next.id,ownerEpoch:next.record.ownerEpoch,check:()=>lease.assertActive()};
  assert.deepEqual(history.save(f.home,context,proof.source,proof.closed),ref);assert.deepEqual(fs.readFileSync(proofFile),raw);
  const producerFile=path.join(f.home,'installer/operations',next.id,'operation.json'),record=fs.readFileSync(producerFile),changed=JSON.parse(record);changed.ownerEpoch++;
  fs.writeFileSync(producerFile,JSON.stringify(changed));
  try{assert.equal(history.inspect(f.home).closed.size,1,'same operation later epoch still owns its exact reference');
   changed.effectClosureRefs=[];fs.writeFileSync(producerFile,JSON.stringify(changed));assert.throws(()=>history.inspect(f.home),error=>error.code==='OPERATION_HISTORY_UNCONFIRMED');
  }finally{fs.writeFileSync(producerFile,record);}
 }finally{await lease.release();}
 await f.inspect();
});

test('a failed normal update retains the prior partial closure through actual recovery and subsequent prune',{timeout:30000},async t=>{
 const f=await restoredPartialRuntimeFixture(t,{pythonOnly:true}),before=fs.readFileSync(path.join(f.instance.installRoot,'tavern-state/native/default-user/chats/chat.jsonl'));
 const failed=await advancePartialSystemFixture(f,{restore:true});await f.inspect();
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.instance.installRoot,'tavern-updates/transaction.json'))).status,'restored');
 assert.deepEqual(fs.readFileSync(path.join(f.instance.installRoot,'tavern-state/native/default-user/chats/chat.jsonl')),before);
 const retained=prunePartialFixture(f,failed);assert.equal(retained.status,'retained');assert.equal(fs.existsSync(f.backup),true);
 const next=await advancePartialSystemFixture(f,{version:'2.4.7',commit:'c'.repeat(40)});await f.inspect();
 assert.ok(prunePartialFixture(f,next).removed.includes(f.backup));await f.inspect();await f.cleanup('keep');
 assert.deepEqual(fs.readFileSync(path.join(f.instance.installRoot,'tavern-state/native/default-user/chats/chat.jsonl')),before);
});

test('confirmed recovery allows later story edits through closed histories, updates and keep uninstall',{timeout:60000},async t=>{
 for(const followup of ['keep','update'])await t.test(followup,async t=>{
 const f=await restoredPartialRuntimeFixture(t,{pythonOnly:true});
 await advancePartialSystemFixture(f,{restore:true});await f.inspect();
 const state=path.join(f.instance.installRoot,'tavern-state');
 const edited=new Map([
  ['native/default-user/chats/chat.jsonl','new user chat after recovery'],
  ['native/default-user/characters/edited.json','{"name":"edited character"}'],
  ['native/default-user/nora-world-core/worlds/edited/manifest.json','{"title":"edited world"}'],
 ]);
 for(const [relative,data] of edited){const file=path.join(state,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
 await f.inspect();
 if(followup==='update'){await advancePartialSystemFixture(f,{version:'2.4.7',commit:'c'.repeat(40)});await f.inspect();}
 await f.cleanup('keep');
 for(const [relative,data] of edited)assert.equal(fs.readFileSync(path.join(state,relative),'utf8'),data);
 });
});

test('retired partial proof rejects tampering, unknown successors and preserves metadata across Operation archive',{timeout:60000},async t=>{
 const f=await restoredPartialRuntimeFixture(t),next=await advancePartialSystemFixture(f);prunePartialFixture(f,next);await f.inspect();
 const reference=next.record.effectClosureRefs[0],proofFile=path.join(f.home,reference.path),raw=fs.readFileSync(proofFile);
 const systemFile=path.join(f.instance.installRoot,'tavern-updates/transaction.json'),systemRaw=fs.readFileSync(systemFile),currentFile=path.join(f.home,'installer/operations',next.id,'operation.json'),currentRaw=fs.readFileSync(currentFile);
 const oldRecordFile=path.join(f.home,'installer/operations',f.oldRecord.operationId,'operation.json'),oldRecordRaw=fs.readFileSync(oldRecordFile);
 const changed=JSON.parse(raw);changed.source.proof.stateDigest='0'.repeat(64);fs.writeFileSync(proofFile,JSON.stringify(changed));
 await assert.rejects(f.inspect());const retained=prunePartialFixture(f,next);assert.equal(retained.status,'retained');assert.deepEqual(retained.removed,[]);fs.writeFileSync(proofFile,raw);
 for(const field of ['state','verification','effectState']){
  const changed=JSON.parse(currentRaw);changed[field]=field==='state'?'applying':field==='verification'?'unconfirmed':'unknown';fs.writeFileSync(currentFile,JSON.stringify(changed));
  await assert.rejects(f.inspect());fs.writeFileSync(currentFile,currentRaw);
 }
 const journal=JSON.parse(systemRaw);journal.status='prepared';fs.writeFileSync(systemFile,JSON.stringify(journal));await assert.rejects(f.inspect());fs.writeFileSync(systemFile,systemRaw);
 fs.renameSync(proofFile,proofFile+'.preserved');await assert.rejects(f.inspect());fs.renameSync(proofFile+'.preserved',proofFile);
 const saved=JSON.parse(oldRecordRaw),summary={};
 for(const key of ['schema','operationId','kind','ownerEpoch','createdAt','updatedAt','state','effectState','recoveryOutcome','verification','planDigest','planSelected','attempt','totalAttempts','sequence'])if(saved[key]!==undefined)summary[key]=saved[key];
 summary.sequence++;summary.target={};summary.archived=true;summary.archivedAt=new Date().toISOString();summary.updatedAt=summary.archivedAt;
 fs.writeFileSync(oldRecordFile,JSON.stringify(summary));await f.inspect();
 const facts=require('../installer/desktop/runtime-transaction').inspect({...f.instance,operationId:f.oldRecord.operationId});assert.equal(facts.reason,'retired-partial-confirmed');
 assert.deepEqual(fs.readFileSync(proofFile),raw);assert.equal(fs.existsSync(f.backup),false);
});

test('retired closure rechecks actual records and sources rather than accepting resealed DTO fields',{timeout:60000},async t=>{
 const f=await restoredPartialRuntimeFixture(t),next=await advancePartialSystemFixture(f);prunePartialFixture(f,next);await f.inspect();
 const history=require('../installer/desktop/operation-history'),ref=next.record.effectClosureRefs[0],proofFile=path.join(f.home,ref.path);
 const producerFile=path.join(f.home,'installer/operations',next.id,'operation.json'),sourceFile=path.join(f.home,'installer/operations',f.currentRecord.operationId,'operation.json');
 const systemFile=path.join(f.instance.installRoot,'tavern-updates/transaction.json');
 const files=[proofFile,producerFile,sourceFile,systemFile,f.oldFile,f.currentFile],original=new Map(files.map(file=>[file,fs.readFileSync(file)]));
 const restore=()=>{for(const [file,bytes] of original)fs.writeFileSync(file,bytes);};
 const reseal=mutate=>{const value=JSON.parse(original.get(proofFile));mutate(value);const bytes=Buffer.from(JSON.stringify(value)+'\n'),changed={path:ref.path,sha256:history.hash(bytes)};
  fs.writeFileSync(proofFile,bytes);const producer=JSON.parse(original.get(producerFile));producer.effectClosureRefs=[changed];fs.writeFileSync(producerFile,JSON.stringify(producer));
  const system=JSON.parse(original.get(systemFile));system.recoveryPlan.effectClosureRefs=[changed];fs.writeFileSync(systemFile,JSON.stringify(system));};
 const cases=[
  ['source result changed at the same updatedAt',()=>{const value=JSON.parse(original.get(sourceFile));value.result.version='9.9.9';fs.writeFileSync(sourceFile,JSON.stringify(value));}],
  ['producer loses its held reference',()=>{const value=JSON.parse(original.get(producerFile));delete value.effectClosureRefs;fs.writeFileSync(producerFile,JSON.stringify(value));}],
  ['invalid captured date',()=>reseal(value=>value.capturedAt='invalid-date')],
  ['noninteger producer epoch',()=>reseal(value=>value.producer.ownerEpoch=0.5)],
  ['source runtime changes despite matching DTO hash',()=>reseal(value=>{const runtime=JSON.parse(original.get(f.currentFile));runtime.identities.previous.inode='99';const bytes=Buffer.from(JSON.stringify(runtime));fs.writeFileSync(f.currentFile,bytes);value.source.runtimeSha256=history.hash(bytes);})],
  ['proof target digest disagrees with actual source journal',()=>reseal(value=>value.source.proof.targets[0].oldDigest='0'.repeat(64))],
  ['proof target identity disagrees with original program',()=>reseal(value=>value.source.proof.targets[0].oldIdentity=['1','99'])],
  ['proof target count drops a source target',()=>reseal(value=>value.source.proof.targets=[])],
  ['resealed reader commit disagrees with fixed selected plan',()=>reseal(value=>{const journal=JSON.parse(value.source.systemJournal);journal.recoveryPlan.partialBaseline.readerCommit='f'.repeat(40);value.source.systemJournal=JSON.stringify(journal);value.source.systemJournalSha256=history.hash(value.source.systemJournal);value.source.proof.journalSha256=value.source.systemJournalSha256;})],
 ];
 for(const [name,mutate] of cases)await t.test(name,async()=>{try{mutate();await assert.rejects(f.inspect());
   assert.equal(fs.existsSync(path.join(f.old.paths.failed,'logs/failed-repair.log')),true);assert.equal(fs.existsSync(path.join(f.home,RETAINED)),false);
   const status=prunePartialFixture(f,next);assert.equal(status.status,'retained');assert.deepEqual(status.removed,[]);
  }finally{restore();}});
 // Removal of originalPartial is itself a change to the closure source. The
 // actual shared policy must reject it before runtime execution is entered.
 const policy=require('../installer/desktop/operation-policy').create({...f.instance,home:f.home,bridge:async()=>{throw Error('bridge must not run');},runRuntime:async()=>{throw Error('runtime must not run');}});
 for(const remove of [false,true]){try{if(remove)fs.rmSync(f.oldFile);else{const value=JSON.parse(original.get(f.oldFile));delete value.originalPartial;fs.writeFileSync(f.oldFile,JSON.stringify(value));}
  await assert.rejects(policy.prepareEffects({check:()=>{}}),error=>error.code==='OPERATION_HISTORY_UNCONFIRMED');
 }finally{restore();}}
 await f.inspect();
});

test('historical reader rejects a same-inode record grown between lstat and open',t=>{
 const f=fixture(t),id=require('node:crypto').randomUUID(),file=path.join(f.home,'installer/operations',id,'operation.json');f.write(path.relative(f.home,file),JSON.stringify({effectClosureRefs:[]}));
 const originalOpen=fs.openSync;let changed=false;
 fs.openSync=function(target,...args){if(target===file&&!changed){changed=true;fs.writeFileSync(file,JSON.stringify({effectClosureRefs:[],padding:'x'.repeat(300*1024)}));}return originalOpen.call(this,target,...args);};
 try{assert.throws(()=>require('../installer/desktop/operation-history').collect(f.home),error=>error.code==='OPERATION_HISTORY_UNCONFIRMED');assert.equal(changed,true);}
 finally{fs.openSync=originalOpen;}
});

test('historical reader distinguishes one inode unit beyond Number precision',t=>{
 const f=fixture(t),id=require('node:crypto').randomUUID(),file=path.join(f.home,'installer/operations',id,'operation.json');f.write(path.relative(f.home,file),JSON.stringify({effectClosureRefs:[]}));
 const lstat=fs.lstatSync,fstat=fs.fstatSync,large=9007199254740992n;let reads=0;
 fs.lstatSync=function(target,options){const value=lstat.call(this,target,options);if(target===file&&options?.bigint)value.ino=large;return value;};
 fs.fstatSync=function(fd,options){assert.equal(options?.bigint,true);const value=fstat.call(this,fd,options);value.ino=large+(reads++?1n:0n);return value;};
 try{assert.throws(()=>require('../installer/desktop/operation-history').collect(f.home),error=>error.code==='OPERATION_HISTORY_UNCONFIRMED');assert.equal(reads,2);}
 finally{fs.lstatSync=lstat;fs.fstatSync=fstat;}
});

test('journal inspection and cleanup hold the same actual native writer',t=>{
  const f=fixture(t),id=require('node:crypto').randomUUID(),native=require('../installer/desktop/os-lock');
  runtimeJournal(f,id);
  const transaction=require('../installer/desktop/runtime-transaction'),original=transaction.inspect;
  let inspections=0;
  transaction.inspect=options=>{
    inspections++;assert.throws(()=>native.acquire({directory:path.join(f.home,'installer')}),error=>error.code==='OPERATION_BUSY');
    return original(options);
  };
  try{cleanup(f.plan('keep'),()=>assert.throws(()=>native.acquire({directory:path.join(f.home,'installer')}),error=>error.code==='OPERATION_BUSY'));}
  finally{transaction.inspect=original;}
  assert.equal(inspections,1);
  const lease=native.acquire({directory:path.join(f.home,'installer')});lease.release();
});

test('worker preserves the specific inspection cause and project call stack in its local result',async t=>{
  const f=fixture(t),id=require('node:crypto').randomUUID(),{value}=runtimeJournal(f,id);
  value.paths.hermesHome=path.join(f.directory,'foreign');
  f.write(`installer/operations/${id}/runtime-bootstrap.json`,JSON.stringify(value));
  const file=path.join(f.directory,'nora-uninstall.json');fs.writeFileSync(file,JSON.stringify(f.plan('keep',{port:await idlePort()})));
  const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
  assert.equal(result.code,'UNINSTALL_RECOVERY_REQUIRED');
  assert.equal(result.diagnosticError.cause.code,'UNINSTALL_RUNTIME_UNCONFIRMED');
  assert.match(result.diagnosticError.cause.message,/RUNTIME_JOURNAL_INVALID/);
  assert.match(result.diagnosticError.cause.stack,/runtimeEffects/);
  assert.equal(fs.readFileSync(path.join(f.home,f.programs[0]),'utf8'),'fixture');
});

function pythonInspectionHarness({now,onChild,ipc=false,pythonScript,environment=process.env}={}) {
  const file=path.resolve(__dirname,'../installer/desktop/uninstall.js');
  const localRequire=createRequire(file),childProcess=require('node:child_process');let childScript,readingProgress=false;
  const context=vm.createContext({require:name=>name==='node:child_process'?{...childProcess,
    spawn:(command,_args,options)=>{
      const child=childProcess.spawn(pythonScript?process.env.NORA_TEST_PYTHON:command,
        pythonScript?['-B',pythonScript]:['-e',childScript],ipc?{...options,stdio:[...options.stdio,'ipc']}:options);onChild?.(child);
      if(now)child.stderr.on('data',()=>{
        readingProgress=true;queueMicrotask(()=>{readingProgress=false;});
      });
      return child;
    }}:name==='node:perf_hooks'&&now?{...localRequire(name),performance:{now:()=>now(readingProgress)}}:localRequire(name),__filename:file,__dirname:path.dirname(file),module:{exports:{}},
    process,console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  return (script,policy)=>{childScript=script;return context.runPythonInspection({command:process.execPath,env:environment},'{}',policy);};
}
const inspectionFrame=(sequence,bytes,entries)=>JSON.stringify({schema:'nora-uninstall-progress/1',sequence,bytes,entries})+'\n';

async function systemHistoryFixture(t,{sameVersion=false,handoff=false,managedRepair=false}={}) {
  const f=fixture(t),crypto=require('node:crypto'),releases=require('../installer/desktop/releases');
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
  const capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
  const records=[];
  for(const [index,version,before] of [[1,'2.4.3','2.4.2'],[2,sameVersion?'2.4.3':'2.4.4','2.4.3'],[3,'2.4.5',sameVersion?'2.4.3':'2.4.4']]){
    const id=crypto.randomUUID(),manifest={schema:'tavern-release/v2',commit:String(sameVersion&&index===2?1:index).repeat(40),
      launcherCapabilities:capabilities,versions:{tavern:version},bootstrap:{sha256:'a'.repeat(64),managedComponents:1,minimumLauncherVersion:'0.1.0'},
      ...(handoff?{launcherVersion:'2.1.3'}:{})};
    const text=JSON.stringify(manifest),release={tag_name:`v${version}`,assets:[{name:'release-manifest.json',
      browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v${version}/release-manifest.json`}]};
    const launcher={schema:'nora-launcher/v1',platform:process.platform,arch:process.arch,version:'2.1.3',
      asset:'Nora-Tavern-Launcher-2.1.3-update.zip',size:8,sha256:'b'.repeat(64)};
    if(handoff)for(const name of [`nora-launcher-${process.platform}-${process.arch}.json`,launcher.asset])release.assets.push({name,
      browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v${version}/${name}`});
    const base=path.join(f.home,'installer/operations',id);fs.mkdirSync(base,{recursive:true});
    const bodies={'release-manifest.json':text};
    if(managedRepair){
      for(const name of ['SHA256SUMS','nora-tavern-app.tar.gz','nora-tavern-ops.tar.gz','nora-tavern-nora-mcp.tar.gz',
        'nora-tavern-first-install-bootstrap.py','first-install-manifest.json','nora-hermes-runtime.json','nora-tavern-dependencies.json'])bodies[name]='fixture '+name;
      const system={schema:'nora-system/v1',version,commit:manifest.commit,platform:process.platform,arch:process.arch,
        minimumLauncherVersion:'2.1.2',launcherCapabilities:capabilities,files:Object.fromEntries(Object.entries(bodies).map(([name,body])=>
          [name,{asset:name,sha256:hash(body),size:Buffer.byteLength(body)}]))};
      bodies[`nora-system-${process.platform}-${process.arch}.json`]=JSON.stringify(system);
      for(const [name,body] of Object.entries(bodies))if(!release.assets.some(item=>item.name===name))release.assets.push({name,size:Buffer.byteLength(body),
        browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v${version}/${name}`});
    }
    const selected=await releases.selectPlan({selectedRelease:release,launcherVersion:'2.1.2',mode:managedRepair?'install':'update',
      platform:process.platform,arch:process.arch,fetcher:async url=>new Response(url.includes('/nora-launcher-')?JSON.stringify(launcher):bodies[String(url).split('/').at(-1)])});
    const releasePlan=releases.sealPlan(selected,{operationDirectory:base,assertOwner:()=>{},launcherVersion:'2.1.2'});
    const target={request:{action:'update',port:8799,tag:`v${version}`},releasePlan,currentVersion:before};
    const record={schema:'nora-operation/1',operationId:id,ownerEpoch:index,sequence:8,kind:'update',state:'succeeded',
      stageId:'verifying',effectState:'changed',verification:'confirmed',createdAt:`2026-10-11T0${index}:00:00.000Z`,
      updatedAt:`2026-10-11T0${index}:01:00.000Z`,target,planDigest:hash(JSON.stringify(target)),planSelected:true,
      result:{systemReady:true,updateVerified:true,version,commit:manifest.commit,noraHome:f.home,
        hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern')}};
    f.write(`installer/operations/${id}/operation.json`,JSON.stringify(record));records.push({record,manifest,base});
  }
  const current=records[2],previous=records[1],backup=path.join(f.home,'tavern/tavern-backups/current');
  const receipt=item=>({schema:2,version:item.manifest.versions.tavern,commit:item.manifest.commit,
    releaseManifestSha256:item.record.target.releasePlan.manifestSha256});
  f.write('tavern/tavern-updates/installed.json',JSON.stringify(receipt(current)));
  f.write('tavern/tavern-updates/installed-manifest.json',JSON.stringify(current.manifest));
  f.write('tavern/tavern-backups/current/host/update-receipts/installed.json',JSON.stringify(receipt(previous)));
  f.write('tavern/tavern-backups/current/host/update-receipts/installed-manifest.json',JSON.stringify(previous.manifest));
  const journal={schema:1,status:'committed',operationId:current.record.operationId,ownerEpoch:3,version:'2.4.5',backup,
    recoveryPlan:{before:{version:previous.manifest.versions.tavern}}};
  f.write('tavern/tavern-updates/transaction.json',JSON.stringify(journal));
  const digestFile=file=>hash(Buffer.concat([Buffer.from('F\0'),fs.readFileSync(file)]));
  const proof={operationId:journal.operationId,ownerEpoch:journal.ownerEpoch,version:journal.version,beforeVersion:journal.recoveryPlan.before.version,backup,
    receipts:{installed:digestFile(path.join(f.home,'tavern/tavern-updates/installed.json')),
      manifest:digestFile(path.join(f.home,'tavern/tavern-updates/installed-manifest.json')),
      previousInstalled:digestFile(path.join(backup,'host/update-receipts/installed.json')),
      previousManifest:digestFile(path.join(backup,'host/update-receipts/installed-manifest.json'))}};
  const file=path.resolve(__dirname,'../installer/desktop/uninstall.js'),localRequire=createRequire(file);
  const context=vm.createContext({require:name=>name==='./launcher-capability'?{validate:async()=>({noraHome:f.home,
    hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern'),launcherVersion:'2.1.2',platform:process.platform,arch:process.arch,channel:'stable',port:8799,resources:{}})}:
    name==='./managed-python'?{resolveExecution:()=>({})}:localRequire(name),__filename:file,__dirname:path.dirname(file),module:{exports:{}},
    process,console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  let inspections=0,handoffs=null;context.runPythonInspection=async()=>{inspections++;return {schema:'nora-uninstall-facts/1',safe:true,system:proof,handoffs};};
  return {...f,records,journal,proof,context,inspect:()=>context.inspectSealedTransactions(f.plan('keep')),inspections:()=>inspections,
    save:item=>f.write(`installer/operations/${item.record.operationId}/operation.json`,JSON.stringify(item.record)),
    handoffProof:value=>{handoffs=value;}};
}

test('historical verified system updates are accepted only after the current sealed successor proves their content chain',async t=>{
  for(const sameVersion of [false,true]){
    const f=await systemHistoryFixture(t,{sameVersion});
    await f.inspect();assert.equal(f.inspections(),1,'history must reach the full read-only Python check');
    for(const name of [...f.data,...f.programs])assert.equal(fs.readFileSync(path.join(f.home,name),'utf8'),'fixture');
  }
});

test('managed repair install plans retain full validation when consumed as successful system history and handoffs',async t=>{
  for(const handoff of [false,true]){
    const f=await systemHistoryFixture(t,{managedRepair:true,handoff});
    assert.equal(f.records[2].record.target.releasePlan.mode,'install');
    if(handoff){
      const current=f.records[2],job=path.join(f.home,'installer/launcher-update','job-'+current.record.operationId);
      fs.mkdirSync(job,{recursive:true});current.record.handoffRef=job;f.save(current);
      const request=f.context.systemHandoffs(f.home,f.context.transactionCatalog(f.home,f.plan('keep')),f.records.slice(0,2).map(item=>
        ({id:item.record.operationId,record:item.record}))),sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?
          Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
      f.handoffProof({count:request.length,sha256:require('node:crypto').createHash('sha256').update(JSON.stringify(sort(request))).digest('hex')});
    }
    await f.inspect();assert.equal(f.inspections(),1);
  }
});

test('system history rejects unsupported records, content changes and broken successor evidence',async t=>{
  const cases={failed:f=>{f.records[0].record.state='failed';f.save(f.records[0]);},
    unconfirmed:f=>{f.records[0].record.verification='unconfirmed';f.save(f.records[0]);},
    handoff:f=>{f.records[0].record.handoffRef='pending';f.save(f.records[0]);},
    unknownKind:f=>{f.records[0].record.kind='model';f.save(f.records[0]);},
    recovery:f=>{f.records[0].record.recoveryOutcome='recovery-required';f.save(f.records[0]);},
    changedPlan:f=>{f.records[0].record.target.currentVersion='0.0.0';f.save(f.records[0]);},
    changedManifest:f=>fs.appendFileSync(path.join(f.records[0].base,f.records[0].record.target.releasePlan.manifestRef.file),' '),
    laterWriter:f=>{f.records[0].record.ownerEpoch=4;f.save(f.records[0]);},
    unrelatedVersion:f=>{f.records[1].record.target.currentVersion='2.0.0';f.records[1].record.planDigest=require('node:crypto').createHash('sha256').update(JSON.stringify(f.records[1].record.target)).digest('hex');f.save(f.records[1]);},
    wrongReceipt:f=>fs.appendFileSync(path.join(f.home,'tavern/tavern-backups/current/host/update-receipts/installed.json'),' '),
    noCurrentProof:f=>{delete f.proof.receipts;},
    differentOwner:f=>{f.proof.ownerEpoch=99;},
    wrongRoots:f=>{f.records[0].record.result.installRoot=f.directory;f.save(f.records[0]);},
    missingCurrent:f=>fs.unlinkSync(path.join(f.records[2].base,'operation.json')),
    failedCurrent:f=>{f.records[2].record.state='failed';f.save(f.records[2]);},
    wrongCurrentPlan:f=>{f.records[2].record.planDigest='0'.repeat(64);f.save(f.records[2]);},
    changedSystemStatus:f=>{f.journal.status='applying';f.write('tavern/tavern-updates/transaction.json',JSON.stringify(f.journal));},
    missingOldVersion:f=>{delete f.records[0].record.target.currentVersion;f.save(f.records[0]);},
    unknownRequest:f=>{f.records[0].record.target.request.unknown='scope';f.records[0].record.planDigest=require('node:crypto').createHash('sha256').update(JSON.stringify(f.records[0].record.target)).digest('hex');f.save(f.records[0]);}};
  for(const [name,mutate] of Object.entries(cases)){
    const f=await systemHistoryFixture(t);mutate(f);
    await assert.rejects(f.inspect(),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED',name);
    for(const file of [...f.data,...f.programs])assert.equal(fs.readFileSync(path.join(f.home,file),'utf8'),'fixture',name);
  }
});

test('same-version history cannot substitute a different sealed program content',async t=>{
  const f=await systemHistoryFixture(t,{sameVersion:true}),old=f.records[0],releases=require('../installer/desktop/releases');
  const manifest={...old.manifest,commit:'f'.repeat(40)},text=JSON.stringify(manifest),selected=await releases.selectPlan({
    selectedRelease:old.record.target.releasePlan.release,launcherVersion:'2.1.2',platform:process.platform,arch:process.arch,
    fetcher:async()=>new Response(text)});
  old.record.target.releasePlan=releases.sealPlan(selected,{operationDirectory:old.base,assertOwner:()=>{},launcherVersion:'2.1.2'});
  old.record.result.commit=manifest.commit;old.record.planDigest=require('node:crypto').createHash('sha256').update(JSON.stringify(old.record.target)).digest('hex');f.save(old);
  await assert.rejects(f.inspect(),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
  assert.equal(f.inspections(),1,'different fully sealed content must be rejected after the current inspection');
});

test('completed launcher handoffs remain bound to their verified system operations',async t=>{
  const f=await systemHistoryFixture(t,{handoff:true}),hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
  const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
  for(const item of [f.records[0],f.records[2]]){
    const job=path.join(fs.realpathSync(f.home),'installer/launcher-update',`job-${item.record.operationId}`);
    fs.mkdirSync(job,{recursive:true});item.record.handoffRef=job;f.save(item);
  }
  const requests=f.records.filter(item=>item.record.handoffRef).map(item=>({job:item.record.handoffRef,operationId:item.record.operationId,
    ownerEpoch:item.record.ownerEpoch,planDigest:item.record.planDigest,planId:item.record.target.releasePlan.planId,
    manifestSha256:item.record.target.releasePlan.manifestSha256,target:item.record.target.releasePlan.tag,
    releasePlanSha256:hash(JSON.stringify(sort(item.record.target.releasePlan)))})).sort((a,b)=>a.job.localeCompare(b.job));
  f.handoffProof({count:requests.length,sha256:hash(JSON.stringify(sort(requests)))});
  await f.inspect();assert.equal(f.inspections(),1);
  f.handoffProof(null);await assert.rejects(f.inspect(),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
});

test('a current-only completed handoff still requires a valid physical fixed manifest',async t=>{
  const f=await systemHistoryFixture(t,{handoff:true}),current=f.records[2];
  for(const item of f.records.slice(0,2))fs.rmSync(item.base,{recursive:true});
  const job=path.join(fs.realpathSync(f.home),'installer/launcher-update','job-current');fs.mkdirSync(job,{recursive:true});
  current.record.handoffRef=job;f.save(current);
  fs.appendFileSync(path.join(current.base,current.record.target.releasePlan.manifestRef.file),'changed');
  await assert.rejects(f.inspect(),error=>error.code==='UNINSTALL_RECOVERY_REQUIRED');
  assert.equal(f.inspections(),0,'bad current-only plans must fail before the Python boundary');
});

test('actual Python APP inspection proves two committed generations after stage and backup retirement',
  {skip:!process.env.NORA_TEST_PYTHON},async t=>{
  for(const managedRepair of [false,true]){
  const f=await systemHistoryFixture(t,{handoff:true,managedRepair});
  const body=vm.runInContext('PYTHON_TRANSACTION_FACTS',f.context);
  const resources=path.resolve(__dirname,'../installer'),helper=path.join(resources,'desktop/replace-launcher.py');
  const script=String.raw`
import sys,json,importlib.util,hashlib,uuid,os,shutil,io,psutil
from pathlib import Path
payload=json.load(sys.stdin);root=Path(payload['root']).resolve();app=root.parent/'app';app.mkdir()
spec=importlib.util.spec_from_file_location('fixture_replacement',payload['helper']);r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def write(file,value):file.parent.mkdir(parents=True,exist_ok=True);file.write_text(json.dumps(value))
(app/'launcher.exe').write_text('original launcher')
jobs=[];required=[]
for item in payload['records']:
    record=item['record'];fixed=record['target']['releasePlan'];version=fixed['launcherManifest']['version']
    job=root/'installer/launcher-update'/('job-'+str(uuid.uuid4()));job.mkdir(parents=True)
    for name in ('operation_control.py','operation_evidence.py','error_diagnostics.py','operation-budget.json'):
        shutil.copy2(Path(payload['resources'])/name,job/name)
    shutil.copy2(payload['helper'],job/'replace.py')
    plan={'schema':2,'token':str(uuid.uuid4()),'home':str(root),'appRoot':str(app),'executable':'launcher.exe',
        'platform':fixed['platform'],'arch':fixed['arch'],'version':version,'previousVersion':'2.1.2' if not jobs else version,
        'target':fixed['tag'],'operationId':record['operationId'],'ownerEpoch':record['ownerEpoch'],
        'planDigest':record['planDigest'],'releasePlan':fixed,'executorProtocol':'nora-operation-executor/1',
        'rollbackCompatibility':{'operationSchema':'nora-operation/1','executorProtocol':'nora-operation-executor/1','telemetrySchema':3,'faultSchema':2,'compatible':True},
        'parentPid':os.getpid(),'parentCreationTime':psutil.Process().create_time(),'sha256':fixed['launcherManifest']['sha256']}
    write(job/'plan.json',plan);ctx=r.context(job)
    old={'identity':r.file_identity(app),'digest':r.tree_digest(app,plan['platform']),'version':plan['previousVersion']}
    os.replace(app,ctx['backup']);app.mkdir();(app/'launcher.exe').write_text('launcher for '+fixed['tag'])
    incoming={'identity':r.file_identity(app),'digest':r.tree_digest(app,plan['platform'])}
    snapshot={key:plan[key] for key in ('token','home','appRoot','executable','platform','arch','version','target','operationId',
        'ownerEpoch','planDigest','releasePlan','executorProtocol','rollbackCompatibility','parentPid','parentCreationTime')}
    snapshot.update(schema='nora-launcher-recovery/1',phase='committed',homeIdentity=r.file_identity(root),
        helperDigest=r.digest(job/'replace.py'),resourceDigests={name:r.digest(job/name) for name in
            ('operation_control.py','operation_evidence.py','error_diagnostics.py','operation-budget.json')},
        old=old,incoming=incoming,planSeal=hashlib.sha256(canonical(plan)).hexdigest(),workerPid=2147483647,workerCreationTime=1)
    write(job/'recovery.json',snapshot);shutil.rmtree(ctx['backup']);assert not ctx['backup'].exists() and not ctx['stage'].exists()
    jobs.append(str(job));required.append({'job':str(job),'operationId':record['operationId'],'ownerEpoch':record['ownerEpoch'],
        'planDigest':record['planDigest'],'planId':fixed['planId'],'manifestSha256':fixed['manifestSha256'],'target':fixed['tag'],
        'releasePlanSha256':hashlib.sha256(canonical(fixed)).hexdigest()})
assert r.assess(jobs[0]) is not None,'an old job cannot directly assess against its successor APP'
assert r.assess(jobs[-1]) is None
required.sort(key=lambda value:value['job'])
args={'root':str(root),'hermesHome':str(root/'hermes'),'installRoot':str(root/'tavern'),'system':False,'systemHistory':False,'first':[],
    'legacy':None,'appJobs':jobs,'requiredHandoffs':required,'executable':str(app/'launcher.exe'),
    'resources':{'update_recovery.py':{'path':str(Path(payload['resources'])/'update_recovery.py')},
        'first_install.py':{'path':str(Path(payload['resources'])/'first_install.py')},'replace-launcher.py':{'path':payload['helper']}}}
def inspect():
    previous=sys.stdin;sys.stdin=io.StringIO(json.dumps(args))
    try:exec(payload['body'],{'__name__':'uninstall_fixture'})
    finally:sys.stdin=previous
inspect()
old_job=Path(jobs[0]);old_plan=r.read_json(old_job/'plan.json');old_snapshot=r.read_json(old_job/'recovery.json')
def rejected(label,mutate):
    mutate()
    try:inspect()
    except (OSError,ValueError,RuntimeError,KeyError,TypeError):pass
    else:raise AssertionError(label+' was not rejected')
    write(old_job/'plan.json',old_plan);write(old_job/'recovery.json',old_snapshot)
rejected('wrong operation',lambda:required[0].update(operationId=str(uuid.uuid4())))
required[:]=sorted([{'job':str(job),'operationId':r.read_json(Path(job)/'plan.json')['operationId'],
    'ownerEpoch':r.read_json(Path(job)/'plan.json')['ownerEpoch'],'planDigest':r.read_json(Path(job)/'plan.json')['planDigest'],
    'planId':r.read_json(Path(job)/'plan.json')['releasePlan']['planId'],'manifestSha256':r.read_json(Path(job)/'plan.json')['releasePlan']['manifestSha256'],
    'target':r.read_json(Path(job)/'plan.json')['target'],'releasePlanSha256':hashlib.sha256(canonical(r.read_json(Path(job)/'plan.json')['releasePlan'])).hexdigest()} for job in jobs],key=lambda value:value['job'])
rejected('incomplete old commit',lambda:write(old_job/'recovery.json',{**old_snapshot,'phase':'awaiting-system'}))
rejected('broken incoming identity',lambda:write(old_job/'recovery.json',{**old_snapshot,'incoming':{**old_snapshot['incoming'],'identity':[0,123]}}))
def reseal(mutator):
    changed=json.loads(json.dumps(old_plan));mutator(changed);saved=json.loads(json.dumps(old_snapshot))
    for key in ('releasePlan','sha256','previousVersion'):
        if key in saved:saved[key]=changed.get(key)
    saved['releasePlan']=changed['releasePlan'];saved['planSeal']=hashlib.sha256(canonical(changed)).hexdigest()
    write(old_job/'plan.json',changed);write(old_job/'recovery.json',saved)
rejected('re-sealed different fixed plan',lambda:reseal(lambda value:value['releasePlan'].update(commit='f'*40)))
rejected('re-sealed wrong launcher archive',lambda:reseal(lambda value:value.update(sha256='0'*64)))
rejected('changed helper',lambda:(old_job/'replace.py').write_text('changed'))
shutil.copy2(payload['helper'],old_job/'replace.py')
rejected('changed resource',lambda:(old_job/'operation-budget.json').write_text('{}'))
shutil.copy2(Path(payload['resources'])/'operation-budget.json',old_job/'operation-budget.json')
rejected('changed live APP',lambda:(app/'launcher.exe').write_text('changed'))
print('actual launcher successor boundaries passed')
`;
  const result=require('node:child_process').spawnSync(process.env.NORA_TEST_PYTHON,['-B','-c',script],{
    input:JSON.stringify({root:f.home,resources,helper,body,records:[f.records[0],f.records[2]]}),encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/actual launcher successor boundaries passed/);
  const output=result.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  assert.equal(output[0].safe,true);assert.equal(output[0].handoffs.count,2);
  }
});

test('active inspection exceeds the former fixed deadline and requires final safe proof',async()=>{
  const {captureChild,stopChild}=require('./launcher_test_lifecycle.cjs');
  let clock=0,child,held,timer,primary,finishSent=false;const acknowledged=[],polls=[];
  const run=pythonInspectionHarness({ipc:true,onChild:value=>{child=value;held=captureChild(child);},now:progress=>{
    // The real parser reads this clock only after accepting advancing counters.
    // Startup/scheduling time is outside this positive progress-protocol check.
    if(progress)acknowledged.push(clock+=35);
    else if(child){
      polls.push(clock);
      if(clock===245&&!finishSent){finishSent=true;child.send('fixture-final-safe');}
    }
    return clock;
  }}),frame=inspectionFrame.toString();
  // Final facts require a real poll ACK; both this IPC wait and caller cleanup
  // have independent real deadlines while the inspection clock is controlled.
  const script=`const frame=${frame};const deadline=setTimeout(()=>{process.stderr.write('fixture self deadline');process.exit(78);},4000);let n=0;process.on('message',message=>{if(message==='fixture-final-safe'&&n===7){clearTimeout(deadline);process.stdout.write(JSON.stringify({schema:'nora-uninstall-facts/1',safe:true}));process.disconnect();}});const timer=setInterval(()=>{process.stderr.write(frame(++n,n*1048576,n));if(n===7)clearInterval(timer);},35);`;
  try{
    const facts=await Promise.race([run(script,{idleMs:150,maxMs:1000,pollMs:5}),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Object.assign(new Error('Active inspection fixture exceeded its real execution deadline'),{code:'FIXTURE_INSPECTION_TIMEOUT'})),5000);
    })]);
    assert.equal(facts.schema,'nora-uninstall-facts/1');assert.equal(facts.safe,true);
    assert.deepEqual(acknowledged,[35,70,105,140,175,210,245]);assert.ok(clock>150);
    assert.ok(polls.some(value=>value>150),'a real policy poll must inspect progress past the former fixed deadline');
    assert.equal(finishSent,true);assert.equal(polls.at(-1),245);
    assert.deepEqual(held.stderr.trim().split('\n').map(line=>JSON.parse(line)),Array.from({length:7},(_,index)=>({
      schema:'nora-uninstall-progress/1',sequence:index+1,bytes:(index+1)*1048576,entries:index+1})));
    assert.equal(held.didClose,true);assert.deepEqual(held.result,{code:0,signal:null});
  }catch(error){primary=error;throw error;}
  finally{
    clearTimeout(timer);
    try{await stopChild(child,{signal:'SIGKILL',timeoutMs:1000});}
    catch(error){if(primary)primary.cleanupFailure=error;else throw error;}
  }
});

test('stalled inspection terminates its actual child before reporting failure',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-inspection-process-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const marker=path.join(directory,'pid'),run=pythonInspectionHarness();
  const script=`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
  await assert.rejects(run(script,{idleMs:250,maxMs:1000,pollMs:5}),error=>error.code==='UNINSTALL_INSPECTION_STALLED');
  const pid=Number(fs.readFileSync(marker,'utf8'));
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});

test('repeated progress and diagnostic heartbeats cannot keep a stalled inspection alive',async()=>{
  const run=pythonInspectionHarness(),same=inspectionFrame(1,1024,1);
  const script=`setInterval(()=>process.stderr.write(${JSON.stringify(same)}+'heartbeat\\n'),25);`;
  await assert.rejects(run(script,{idleMs:180,maxMs:1000,pollMs:5}),error=>error.code==='UNINSTALL_INSPECTION_STALLED');
});

test('continuous progress remains bounded by the total inspection limit',async()=>{
  const {captureChild,stopChild}=require('./launcher_test_lifecycle.cjs');
  let clock=0,child,held,timer,primary,cleanupFailure;const acknowledged=[];
  const run=pythonInspectionHarness({onChild:value=>{child=value;held=captureChild(child);},now:progress=>{
    // Establish continuous work from accepted progress, independently of VM
    // startup/scheduling. Real idle/duplicate tests exercise the wall clock.
    if(progress)acknowledged.push(clock+=50);
    return clock;
  }}),frame=inspectionFrame.toString();
  const script=`const frame=${frame};let n=0;setTimeout(()=>setInterval(()=>process.stderr.write(frame(++n,n,0)),25),250);`;
  try{
    await assert.rejects(Promise.race([run(script,{idleMs:180,maxMs:250,pollMs:5}),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Object.assign(new Error('Continuous inspection fixture exceeded its real execution deadline'),
        {code:'FIXTURE_INSPECTION_TIMEOUT'})),5000);
    })]),error=>error.code==='UNINSTALL_INSPECTION_LIMIT');
    assert.ok(acknowledged.length>=5,'actual advancing progress must reach the logical total limit');
    assert.ok(clock>=250);assert.equal(held.didClose,true);
    assert.ok(held.stderr.includes('nora-uninstall-progress/1'));
    assert.ok(held.result.signal||held.result.code!==0,'the actual inspector must be stopped before failure returns');
  }catch(error){primary=error;throw error;}
  finally{
    clearTimeout(timer);
    try{await stopChild(child,{signal:'SIGKILL',timeoutMs:1000});}
    catch(error){if(primary)primary.cleanupFailure=error;else cleanupFailure=error;}
  }
  if(cleanupFailure)throw cleanupFailure;
});

test('progress never substitutes for successful exit and the final safe result',async()=>{
  const run=pythonInspectionHarness(),frame=JSON.stringify(inspectionFrame(1,1024,1));
  for(const end of [`process.stdout.write('{"schema":"nora-uninstall-facts/1","safe":false}');`,
    `process.stdout.write('{"schema":"nora-uninstall-facts/1","safe":true}');process.exitCode=1;`,
    `process.stdout.write('not json');`]){
    await assert.rejects(run(`process.stderr.write(${frame});${end}`,{idleMs:500,maxMs:1000,pollMs:5}),
      error=>error.code==='UNINSTALL_PYTHON_INSPECTION_FAILED');
  }
});

test('uninstall inspection keeps the concrete failure without progress chatter',async()=>{
  const run=pythonInspectionHarness();
  const script=`for(let index=1;index<=100;index++)process.stderr.write(JSON.stringify({schema:'nora-uninstall-progress/1',sequence:index,bytes:index*1024,entries:index})+'\\n');
    process.stderr.write('RuntimeError: unconfirmed launcher effects [job=job-test; phase=prepared; effect=untouched]\\n');process.exitCode=1;`;
  await assert.rejects(run(script,{idleMs:1000,maxMs:2000,pollMs:10}),error=>{
    assert.equal(error.code,'UNINSTALL_PYTHON_INSPECTION_FAILED');
    assert.match(error.message,/phase=prepared; effect=untouched/);
    assert.doesNotMatch(error.message,/nora-uninstall-progress/);return true;
  });
});

test('uninstall Python diagnostics stay readable when the parent requests a non-UTF8 encoding',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-inspection-encoding-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const pythonScript=path.join(directory,'inspection.py');
  fs.writeFileSync(pythonScript,'import sys\nsys.stderr.write("保护数据校验未通过\\n")\nsys.exit(1)\n');
  const run=pythonInspectionHarness({pythonScript,environment:{...process.env,PYTHONIOENCODING:'ascii',PYTHONUTF8:'0'}});
  await assert.rejects(run('',{idleMs:5000,maxMs:10000,pollMs:20}),error=>{
    assert.equal(error.code,'UNINSTALL_PYTHON_INSPECTION_FAILED');
    assert.match(error.message,/保护数据校验未通过/);assert.doesNotMatch(error.message,/UnicodeEncodeError|\uFFFD/);return true;
  });
});

test('oversized output or invalid progress fails closed instead of growing buffers',async()=>{
  const {captureChild,stopChild}=require('./launcher_test_lifecycle.cjs');
  for(const script of [`process.stdout.write('x'.repeat(20000));setInterval(()=>{},1000);`,
    `process.stderr.write('{"schema":"nora-uninstall-progress/1","sequence":1,"bytes":-1,"entries":1}\\n');setInterval(()=>{},1000);`]){
    let child,held,timer,primary,cleanupFailure;
    // Exercise the output guard independently of process startup latency. The
    // tests above cover real idle/total deadlines; this child also has a real
    // cleanup deadline, so a missing output guard cannot hang or pass on timeout.
    const run=pythonInspectionHarness({now:()=>0,onChild:value=>{child=value;held=captureChild(child);}});
    try{
      await assert.rejects(Promise.race([run(script,{idleMs:500,maxMs:1000,pollMs:5}),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(new Error('Output inspection fixture exceeded its real deadline'),
          {code:'FIXTURE_INSPECTION_TIMEOUT'})),5000);
      })]),error=>error.code==='UNINSTALL_PYTHON_INSPECTION_FAILED');
      assert.equal(held.didClose,true);
      assert.ok(held.result.signal||held.result.code!==0,'invalid output must terminate the actual inspector');
    }catch(error){primary=error;throw error;}
    finally{
      clearTimeout(timer);
      try{await stopChild(child,{signal:'SIGKILL',timeoutMs:1000});}
      catch(error){if(primary)primary.cleanupFailure=error;else cleanupFailure=error;}
    }
    if(cleanupFailure)throw cleanupFailure;
  }
});
