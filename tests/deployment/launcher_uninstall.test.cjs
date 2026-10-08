const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { makePlan, cleanup, restoreRetained, worker, RETAINED } = require('../installer/desktop/uninstall');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-uninstall-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'NoraTavern');
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
  const plan = mode => makePlan({ home, hermesHome: path.join(home, 'hermes'), installRoot: path.join(home, 'tavern'), mode });
  return { directory, home, write, data, programs, plan };
}

function assertLockShell(home) {
  assert.deepEqual(fs.readdirSync(home).sort(),['installer','nora-owner.json']);
  assert.deepEqual(fs.readdirSync(path.join(home,'installer')),['operations']);
  assert.deepEqual(fs.readdirSync(path.join(home,'installer/operations')),['.writer.lock']);
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
  const f = fixture(t), plan = f.plan('keep'), outside = path.join(f.directory, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'unrelated');
  fs.rmSync(path.join(f.home, 'cache'), { recursive: true });
  fs.symlinkSync(outside, path.join(f.home, 'cache'), 'junction');
  assert.throws(() => cleanup(plan), /链接/);
  assert.equal(fs.existsSync(path.join(f.home, f.programs[0])), true);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unrelated');
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
  fs.writeFileSync(file, JSON.stringify(f.plan('all')));
  await worker(file, () => {});
  const result = JSON.parse(fs.readFileSync(path.join(f.directory, 'result.json'), 'utf8'));
  assert.equal(result.state, 'complete'); assertLockShell(f.home);
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
  const main = path.resolve(__dirname, '../installer/desktop/main.js');
  const localRequire = createRequire(main);
  const electron = { app: { isPackaged: true, getPath: () => f.directory, exit: code => exits.push(code) },
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: responses.shift() }; } } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === 'node:child_process'
      ? { spawnSync: () => ({ status: 1 }) } : localRequire(name),
    __dirname: path.dirname(main), console, setTimeout, clearTimeout,
    process: { platform: 'win32', argv: [], on() {}, env: { NORA_TAVERN_HOME: f.home }, execPath: path.join(f.directory, 'launcher.exe') },
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context);
  // Wizard-only fixture: maintenance ownership is proved in the native tests.
  context.fixtureOwnedTask=async(_kind,_request,execute)=>{const result=await execute({stage:async()=>{}});assert.equal(result.verification,'confirmed');return result.value;};
  vm.runInContext('runOwnedTask=fixtureOwnedTask;',context);
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

test('failure to stop a service prevents creation of an uninstall plan', async t => {
  const f = wizard(t, [1]);
  vm.runInContext('findPython = () => ({}); runBridge = async () => { throw new Error("service still running"); }', f.context);
  await assert.rejects(f.run(), /service still running/);
  assert.equal(fs.existsSync(f.planFile), false);
  assert.equal(fs.existsSync(path.join(f.home, f.programs[0])), true);
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

test('an orphaned executor ledger blocks uninstall until positive offline proof',async t=>{
  const f=fixture(t),file=path.join(f.directory,'nora-uninstall.json');
  f.write('installer/operations/.guards/orphan.json',JSON.stringify({schema:'nora-operation-guard/1',operationId:'orphan',jobs:[{jobId:'unknown',pid:process.pid}]}));
  fs.writeFileSync(file,JSON.stringify(f.plan('all')));
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
    assert.equal(fs.existsSync(path.join(f.home,'installer/operations',id,'runtime-bootstrap.json')),true);
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
  assert.equal(fs.readFileSync(path.join(previous,'.env'),'utf8'),'fixture');
  assert.equal(fs.existsSync(path.join(f.home,'installer/operations',oldId,'runtime-bootstrap.json')),true);
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
  const file=path.join(f.directory,'nora-uninstall.json');fs.writeFileSync(file,JSON.stringify(f.plan('keep')));
  const previous=process.exitCode;try{await worker(file,()=>{});}finally{process.exitCode=previous;}
  const result=JSON.parse(fs.readFileSync(path.join(f.directory,'result.json'),'utf8'));
  assert.equal(result.code,'UNINSTALL_RECOVERY_REQUIRED');
  assert.equal(result.diagnosticError.cause.code,'UNINSTALL_RUNTIME_UNCONFIRMED');
  assert.match(result.diagnosticError.cause.message,/RUNTIME_JOURNAL_INVALID/);
  assert.match(result.diagnosticError.cause.stack,/runtimeEffects/);
  assert.equal(fs.readFileSync(path.join(f.home,f.programs[0]),'utf8'),'fixture');
});
