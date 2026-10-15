const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { consumeLines, externalUrl } = require('../installer/desktop/process-output');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createTestOperationLock } = require('./launcher_operation_test_lock.cjs');
const { captureChild, stopChild } = require('./launcher_test_lifecycle.cjs');

// Exercise the actual main-process IPC handler, output consumers and durable
// controller. Only Electron and the native lock/process adapter are replaced;
// the fixture does not claim to test Python services or native OS ownership.
function launcherFixture(t, { output, commitFailure, cacheFailureAt, cacheWriteDenied = false, existingHome, childExitCode = 0 } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-progress-output-')));
  const home = existingHome || path.join(directory, 'home'), handlers = new Map(), intervals = new Set(), children = [];
  const file = path.resolve(__dirname, '../installer/desktop/main.js'), localRequire = createRequire(file);
  const appPaths = { appData: directory };
  const app = { isPackaged: false, getVersion: () => '2.1.3', getPath: name => appPaths[name] || directory,
    setPath: (name, value) => { appPaths[name] = value; }, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), on() {}, once() {}, quit() {}, exit() {} };
  const events = [], frame = { url: pathToFileURL(path.join(path.dirname(file), '..', 'launcher-conversation-prototype.html')).href };
  const sender = { mainFrame: frame, isDestroyed: () => false, send: (channel, value) => events.push({ channel, value }) };
  const electron = { app, BrowserWindow: {}, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {}, shell: {}, session: {}, net: { fetch: async () => { throw new Error('This fixture must remain offline'); } } };
  const baseLock = createTestOperationLock();
  let spawned = 0, commitFailed = false;
  let cacheFailed = false;
  const stateFile = path.join(home, 'installer', 'state.json'), mainFs = Object.create(fs);
  mainFs.renameSync = (from, to) => {
    if (cacheWriteDenied && to === stateFile) throw Object.assign(new Error('The presentation cache is write protected'), { code: 'EPERM', syscall: 'rename' });
    if (!cacheFailed && to === stateFile && cacheFailureAt) {
      const next = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (cacheFailureAt === 'output' && next.progress || cacheFailureAt === 'final' && next.phase === 'ready') {
        cacheFailed = true; fs.rmSync(stateFile, { force: true }); fs.mkdirSync(stateFile);
      }
    }
    return fs.renameSync(from, to);
  };
  const lock = { probe: baseLock.probe, acquire: async options => {
    const lease = await baseLock.acquire(options), commit = lease.commitOperation;
    lease.spawn = (command, args, options) => {
      // The native lock adapter delegates Python maintenance; the output seam
      // here uses a real Node child with the same stdout/stderr/close contract.
      if (options.kind === 'python-maintenance') args = args.slice(4);
      const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      captureChild(child);
      spawned += 1; children.push(child); return child;
    };
    lease.commitOperation = async request => {
      if (!commitFailed && commitFailure?.(request.record)) {
        commitFailed = true;
        const target = path.join(options.directory, 'operations', request.record.operationId, 'operation.json');
        fs.rmSync(target, { force: true }); fs.mkdirSync(target);
      }
      return commit(request);
    };
    return lease;
  } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === 'node:fs' ? mainFs : localRequire(name), __dirname: path.dirname(file),
    console, Buffer, URL, setTimeout, clearTimeout, setImmediate,
    setInterval: (...args) => { const timer = setInterval(...args); intervals.add(timer); return timer; },
    clearInterval: timer => { intervals.delete(timer); clearInterval(timer); },
    process: { ...process, argv: [], on() {}, env: { ...process.env, NORA_TAVERN_HOME: home }, execPath: process.execPath },
    fixtureLock: lock, fixtureSpecs: [], fixtureOutput: output || [
      { event: 'milestone', index: 0, state: 'done', task: 'Nora ready' },
      { event: 'progress', task: 'Verified programs', current: 1, total: 1 },
      { event: 'result', systemReady: true, installed: true, hermesInstalled: true, setupCompleted: true,
        running: true, gatewayRunning: true, version: '2.4.6', commit: 'c'.repeat(40), updateVerified: true, port: 8799,
        noraHome: home, hermesHome: path.join(home, 'hermes'), installRoot: path.join(home, 'tavern') },
    ],
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const outputFile = path.join(directory, 'output.json'), childFile = path.join(directory, 'child.cjs');
  fs.writeFileSync(outputFile, JSON.stringify(context.fixtureOutput));
  fs.writeFileSync(childFile, `const rows=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
    (async()=>{for(const row of rows){process.stdout.write(typeof row==='string'?row+'\\n':JSON.stringify(row)+'\\n');
      await require('node:timers/promises').setTimeout(1);}process.exitCode=${childExitCode};})().catch(error=>{console.error(error);process.exitCode=1;});`);
  context.fixtureChild = childFile; context.fixtureRows = outputFile;
  vm.runInContext(`
    operationController = createOperationController({directory:installerDirectory,lock:fixtureLock,
      executors:operationExecutors,recoverers:operationRecoverers,evidence:operationEvidence,
      projectResult:result=>result?.value ?? result});
    findPython=()=>({command:process.execPath,args:[]});
    const fixtureOriginalBridgeArgs=bridgeArgs;
    bridgeArgs=(command,options)=>{fixtureSpecs.push(fixtureOriginalBridgeArgs(command,options));
      return {command:process.execPath,args:[fixtureChild,fixtureRows]};};
  `, context);
  t.after(async () => {
    for (const timer of intervals) clearInterval(timer);
    // Retain the directory if closure cannot be confirmed; kill is not proof
    // that the child has released its output pipes and writable files.
    const results = await Promise.allSettled(children.map(child => stopChild(child)));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), `Fixture directory retained: ${directory}`);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { home, context, events, get spawned() { return spawned; },
    run: payload => handlers.get('nora:run')({ sender, senderFrame: frame }, { action: 'start', runId: 'progress-result', ...payload }),
    status: () => handlers.get('nora:status')({ sender, senderFrame: frame }),
    specs: context.fixtureSpecs,
    state: () => vm.runInContext('readInstallerState()', context),
    diagnostics: () => fs.readFileSync(path.join(home, 'installer', 'install.log'), 'utf8').trim().split('\n').map(JSON.parse),
  };
}

for (const stage of ['start', 'output', 'final']) test(`a ${stage} presentation cache failure cannot turn a verified child and controller result into UI failure`, async t => {
  const f = launcherFixture(t, { cacheFailureAt: stage });
  if (stage === 'start') fs.mkdirSync(path.join(f.home, 'installer', 'state.json'), { recursive: true });
  const result = await f.run();
  assert.equal(f.spawned, 1, 'a presentation cache failure must not prevent the owned operation');
  assert.equal(result.ok, true, 'the final IPC result must match the verified operation');
  assert.equal(result.value.operation.state, 'succeeded');
  assert.equal(result.value.operation.verification, 'confirmed');
  assert.equal(result.value.running, true); assert.equal(result.value.gatewayRunning, true);
  assert.equal(f.state().phase, 'ready'); assert.equal(f.state().error, '');
  assert.equal(f.state().milestones[0].state, 'done');
  assert.ok(f.events.some(({value}) => value.event === 'progress' && value.current === 1));
  const warning = f.diagnostics().find(row => row.event === 'state.cache-write-failed');
  assert.equal(warning.level, 'warning');
  assert.ok(['EISDIR', 'EPERM', 'EEXIST', 'ENOTEMPTY'].includes(warning.error.cause.code), 'retain the actual OS cache-write cause');
  assert.equal(f.diagnostics().filter(row => row.event === 'state.cache-write-failed').length, 1, 'repeated progress does not flood the log');
  assert.equal(fs.readdirSync(path.join(f.home, 'installer')).some(name => /^state\.json\..*\.tmp$/.test(name)), false);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.home, 'installer', 'operations', result.value.operation.operationId, 'operation.json')));
  assert.equal(persisted.state, 'succeeded'); assert.equal(persisted.verification, 'confirmed');
});

for (const milestones of [null, false, [null, {index:0,state:'unexpected',task:{invalid:true}}]]) test(`malformed cached milestones ${JSON.stringify(milestones)} cannot poison an accepted child result`, async t => {
  const f = launcherFixture(t);
  fs.mkdirSync(path.join(f.home, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'installer', 'state.json'), JSON.stringify({schema:1,phase:'idle',milestones}));
  const result = await f.run(); assert.equal(result.ok,true); assert.equal(result.value.operation.state,'succeeded');
  const state = f.state(); assert.equal(state.milestones.length,5); assert.equal(state.milestones[0].state,'done');
  for (const [index,item] of state.milestones.entries()) {
    assert.equal(item.index,index); assert.equal(typeof item.task,'string');
    assert.ok(['pending','running','done','error'].includes(item.state));
  }
});

test('all consumed presentation cache fields are normalized before they can affect an owned task', async t => {
  const f = launcherFixture(t);
  fs.mkdirSync(path.join(f.home,'installer'),{recursive:true});
  fs.writeFileSync(path.join(f.home,'installer','state.json'),JSON.stringify({schema:1,phase:{invalid:true},task:[],error:{invalid:true},
    startedAt:'invalid',updatedAt:[],setupCompleted:'false',port:'invalid',resumeTarget:{invalid:true},progress:{current:'invalid'},milestones:null}));
  const before=f.state();assert.equal(before.phase,'idle');assert.equal(before.task,'');assert.equal(before.error,'');
  assert.equal(before.startedAt,null);assert.equal(typeof before.updatedAt,'number');assert.equal(before.setupCompleted,false);
  assert.equal(before.port,undefined);assert.equal(before.resumeTarget,null);assert.equal(before.progress,undefined);
  const result=await f.run();assert.equal(result.ok,true);assert.equal(result.value.operation.state,'succeeded');
});

for (const hasInstance of [true, false]) test(`the first status after reopening restores a non-default port from ${hasInstance ? 'the bound instance' : 'the confirmed maintenance result'}`, async t => {
  const f = launcherFixture(t, { cacheWriteDenied: true });
  const final = f.context.fixtureOutput.at(-1); final.port = 18888;
  fs.writeFileSync(f.context.fixtureRows, JSON.stringify(f.context.fixtureOutput));
  fs.mkdirSync(path.join(f.home, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'installer', 'state.json'), JSON.stringify({schema:1,phase:'error',port:8799,error:'Old cache',resumeTarget:'v2.4.6'}));
  if (hasInstance) {
    fs.mkdirSync(path.join(f.home, 'hermes'), { recursive: true });
    fs.writeFileSync(path.join(f.home, 'hermes', 'nora-instance.json'), JSON.stringify({schema:1,...Object.fromEntries(
      ['noraHome','hermesHome','installRoot','port'].map(name=>[name,final[name]])),releaseChannel:'stable'}));
  }
  await verifiedRepair(f);
  const reopened = launcherFixture(t, { existingHome: f.home, cacheWriteDenied: true, output: [{...final}] });
  const response = await reopened.status(); assert.equal(response.ok, true); assert.equal(response.value.statusUnavailable, undefined);
  const first = reopened.specs[0].args; assert.equal(first[first.indexOf('--port') + 1], '18888');
  assert.equal(response.value.installer.port, 18888); assert.equal(response.value.installer.phase, 'ready');
});

for (const defect of ['wrong-root', 'invalid-json', 'conflicting-port']) test(`an authoritative instance ${defect} cannot silently select the cache port`, async t => {
  const f = launcherFixture(t, { cacheWriteDenied: true });
  fs.mkdirSync(path.join(f.home, 'hermes'), { recursive: true });
  const final = f.context.fixtureOutput.at(-1);
  if (defect === 'conflicting-port') await verifiedRepair(f);
  const instance = {schema:1,noraHome:f.home,hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern'),port:18888};
  if (defect === 'wrong-root') instance.installRoot = path.join(os.tmpdir(),'foreign-tavern');
  fs.writeFileSync(path.join(f.home, 'hermes', 'nora-instance.json'), defect === 'invalid-json' ? '{broken' : JSON.stringify(instance));
  const reopened = launcherFixture(t, { existingHome: f.home, output: [{...final}] });
  const response = await reopened.status(); assert.equal(response.ok, true); assert.equal(response.value.statusUnavailable, true);
  assert.equal(Object.hasOwn(response.value,'systemReady'),false);
  assert.equal(reopened.specs.length,0,'identity conflict is rejected before starting a status child with an invented port');
});

async function verifiedRepair(f) {
  return vm.runInContext(`runOwnedTask('repair',{action:'repair'},async context=>{
    await context.plan({request:{action:'repair'},releasePlan:{version:'2.4.6',commit:'c'.repeat(40)}});
    const value=await runProcess(process.execPath,[fixtureChild,fixtureRows],null,context.operationId,{returnResult:true});
    if(!verifyWorkflowResult({action:'repair',targetVersion:'2.4.6',result:value}))throw Error('Fixture backend acceptance is invalid');
    writeInstallerState({...readInstallerState(),phase:'ready',error:'',task:'',resumeTarget:null});
    return {verification:'confirmed',value};
  })`, f.context);
}

async function rollbackFixture(f, { currentVersion = '2.4.5', outcome = 'confirmed', resultChanges = {} } = {}) {
  f.context.fixtureRestored = { ...f.context.fixtureOutput.at(-1), version: '2.4.5', commit: 'b'.repeat(40),
    port: 18888, recoveryVerification: 'confirmed', updateRecovered: true, ...resultChanges };
  f.context.fixtureCurrentVersion = currentVersion; f.context.fixtureRecoveryOutcome = outcome;
  return vm.runInContext(`(async()=>{
    operationPolicy={recover:async()=>{
      if(fixtureRecoveryOutcome==='unknown')throw Object.assign(new Error('Recovery has unknown effects'),{code:'UPDATE_RECOVERY_REQUIRED'});
      return fixtureRecoveryOutcome==='files-only'?{filesRestored:true,verification:'failed',value:{...fixtureRestored,recoveryVerification:'files-only'}}
        :{effectState:'restored',verification:'confirmed',value:fixtureRestored};
    }};
    operationRecoverers.update=(context,options)=>{activeOperationContext=context;return recoverMaintenance(context,options);};
    try{return await operations().start('update',{target:{request:{action:'update'},currentVersion:fixtureCurrentVersion,
      releasePlan:{version:'2.4.6',commit:'c'.repeat(40)}},execute:async context=>{
        activeOperationContext=context;await context.stage('applying');await context.effect(fixtureRecoveryOutcome==='unknown'?'unknown':'changed');
        throw Object.assign(new Error('Original update failed before rollback'),{code:'VERIFICATION_FAILED'});
      }},'rollback-cache');}finally{activeOperationContext=null;}
  })()`, f.context);
}

for (const hasInstance of [true, false]) test(`confirmed rollback reopening clears stale cache hints and restores its port ${hasInstance ? 'with' : 'without'} an instance record`, async t => {
  const f=launcherFixture(t,{cacheWriteDenied:true});
  fs.mkdirSync(path.join(f.home,'installer'),{recursive:true});
  fs.writeFileSync(path.join(f.home,'installer','state.json'),JSON.stringify({schema:1,phase:'error',port:8799,error:'Old update hint',resumeTarget:'v2.4.6'}));
  const operation=await rollbackFixture(f);assert.equal(operation.state,'rolled-back');assert.equal(operation.verification,'confirmed');
  assert.equal(operation.recoveryOutcome,'restored-and-verified');assert.equal(operation.primaryFailure.code,'VERIFICATION_FAILED');
  if(hasInstance){fs.mkdirSync(path.join(f.home,'hermes'),{recursive:true});fs.writeFileSync(path.join(f.home,'hermes','nora-instance.json'),
    JSON.stringify({schema:1,noraHome:f.home,hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern'),port:18888}));}
  const recordFile=path.join(f.home,'installer','operations',operation.operationId,'operation.json');
  const metadataFile=path.join(operation.primaryFailureRef,'metadata.json');
  const recordBytes=fs.readFileSync(recordFile),evidenceBytes=fs.readFileSync(metadataFile);
  const reopened=launcherFixture(t,{existingHome:f.home,cacheWriteDenied:true,output:[{...f.context.fixtureRestored,event:'result'}]});
  const response=await reopened.status();assert.equal(response.ok,true);assert.equal(response.value.statusUnavailable,undefined);
  assert.equal(response.value.operation.state,'rolled-back');assert.equal(response.value.operation.primaryFailure.code,'VERIFICATION_FAILED');
  assert.equal(response.value.installer.phase,'ready');assert.equal(response.value.installer.error,'');assert.equal(response.value.installer.resumeTarget,null);
  assert.equal(response.value.installer.port,18888);
  const args=reopened.specs[0].args;assert.equal(args[args.indexOf('--port')+1],'18888');
  assert.deepEqual(fs.readFileSync(recordFile),recordBytes);assert.deepEqual(fs.readFileSync(metadataFile),evidenceBytes);
});

test('confirmed untouched handoff reopening clears stale hints without losing the failed task',async t=>{
  const f=launcherFixture(t,{cacheWriteDenied:true});
  fs.mkdirSync(path.join(f.home,'installer'),{recursive:true});
  fs.writeFileSync(path.join(f.home,'installer','state.json'),JSON.stringify({schema:1,phase:'error',port:8799,error:'Unfinished handoff',resumeTarget:'v2.4.6'}));
  const operation=await vm.runInContext(`(async()=>{
    operationController=createOperationController({directory:installerDirectory,lock:fixtureLock,evidence:operationEvidence,
      verifyRestoredHandoff:(record,context)=>maintenancePolicy().reconcileHandoff(record,context)});
    const controller=operations();
    operationPolicy={reconcileHandoff:async record=>({status:'cancelled',effectState:'untouched',verification:'confirmed',
      operationId:record.operationId,planDigest:record.planDigest,job:record.handoffRef,
      failure:Object.assign(new Error('Original sharing violation'),{code:'EACCES'}),
      value:{...fixtureOutput.at(-1),notAppliedVerification:'confirmed'}})};
    const pending=await controller.start('update',{target:{currentVersion:'2.4.6'},execute:async context=>{
      await context.handoff('/owned/job');return {handoff:true};}},'untouched-cache');
    return controller.recheck(pending.operationId);
  })()`,f.context);
  assert.equal(operation.state,'failed');assert.equal(operation.currentFailure,null);assert.equal(operation.primaryFailure.code,'EACCES');
  const reopened=launcherFixture(t,{existingHome:f.home,cacheWriteDenied:true,output:[{...f.context.fixtureOutput.at(-1)}]});
  const response=await reopened.status();
  assert.equal(response.value.installer.phase,'ready');assert.equal(response.value.installer.error,'');
  assert.equal(response.value.installer.resumeTarget,null);assert.equal(response.value.operation.state,'failed');
  assert.equal(response.value.operation.primaryFailure.code,'EACCES');
});

for(const [name,options] of [
  ['a partial original system',{resultChanges:{systemReady:false}}],
  ['files restored but services unconfirmed',{outcome:'files-only'}],
  ['unknown restoration effects',{outcome:'unknown'}],
  ['a different known original version',{currentVersion:'2.4.4'}],
])test(`reopening a rollback preserves maintenance guidance for ${name}`,async t=>{
  const f=launcherFixture(t,{cacheWriteDenied:true});fs.mkdirSync(path.join(f.home,'installer'),{recursive:true});
  fs.writeFileSync(path.join(f.home,'installer','state.json'),JSON.stringify({schema:1,phase:'error',error:'Keep recovery guidance',resumeTarget:'v2.4.6'}));
  const operation=await rollbackFixture(f,options);assert.ok(operation.primaryFailure);
  fs.mkdirSync(path.join(f.home,'hermes'),{recursive:true});fs.writeFileSync(path.join(f.home,'hermes','nora-instance.json'),
    JSON.stringify({schema:1,noraHome:f.home,hermesHome:path.join(f.home,'hermes'),installRoot:path.join(f.home,'tavern'),port:18888}));
  const reopened=launcherFixture(t,{existingHome:f.home,output:[{...f.context.fixtureRestored,event:'result'}]});
  const response=await reopened.status();assert.equal(response.ok,true);
  assert.equal(response.value.installer.phase,'error');assert.equal(response.value.installer.error,'Keep recovery guidance');
  assert.equal(response.value.installer.resumeTarget,'v2.4.6');
});

test('reopening with an old error cache projects the confirmed maintenance and live matching system', async t => {
  const f = launcherFixture(t, { cacheWriteDenied: true });
  fs.mkdirSync(path.join(f.home, 'installer'), { recursive: true });
  const stale = { schema: 1, phase: 'error', error: 'An older update failed', resumeTarget: 'v2.4.6' };
  fs.writeFileSync(path.join(f.home, 'installer', 'state.json'), JSON.stringify(stale));
  const accepted = await verifiedRepair(f);
  assert.equal(accepted.operation.state, 'succeeded'); assert.equal(f.state().phase, 'ready');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'installer', 'state.json'))).phase, 'error');
  const reopened = launcherFixture(t, { existingHome: f.home, cacheWriteDenied: true });
  const response = await reopened.status(); assert.equal(response.ok, true);
  assert.equal(response.value.operation.state, 'succeeded');
  assert.equal(response.value.installer.phase, 'ready'); assert.equal(response.value.installer.error, '');
  assert.equal(response.value.installer.resumeTarget, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'installer', 'state.json'))).phase, 'error', 'do not force a write to the protected cache');
});

for (const kind of ['model', 'shutdown']) test(`unrelated successful ${kind} cannot erase an older failed maintenance projection`, async t => {
  const f = launcherFixture(t);
  fs.mkdirSync(path.join(f.home, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'installer', 'state.json'), JSON.stringify({schema:1,phase:'error',error:'Keep the maintenance failure',resumeTarget:'v2.4.6'}));
  await vm.runInContext(`operations().start('repair',{target:{request:{action:'repair'}},execute:async()=>{
    throw Object.assign(new Error('Actual failed maintenance'),{code:'VERIFICATION_FAILED'});
  }},'failed-repair')`, f.context);
  f.context.fixtureKind = kind;
  await vm.runInContext(`runOwnedTask(fixtureKind,{mode:'configure'},async()=>({verification:'confirmed',value:{modelConfigured:true}}))`, f.context);
  const reopened = launcherFixture(t, { existingHome: f.home });
  const response = await reopened.status(); assert.equal(response.ok, true);
  assert.equal(response.value.operation.kind, kind); assert.equal(response.value.operation.state, 'succeeded');
  assert.equal(response.value.installer.phase, 'error');
  assert.equal(response.value.installer.error, 'Keep the maintenance failure');
  assert.equal(response.value.installer.resumeTarget, 'v2.4.6');
});

for (const [name, changes] of [
  ['a partial current installation', { systemReady: false }],
  ['a different installed version', { version: '2.4.5' }],
  ['a different installed commit', { commit: 'd'.repeat(40) }],
  ['a different installation root', { installRoot: path.join(os.tmpdir(), 'another-tavern') }],
  ['a different instance port', { port: 8798 }],
  ['a remaining recovery transaction', { updateRecovery: { status: 'applying', canRecover: true } }],
]) test(`a prior maintenance success cannot hide ${name}`, async t => {
  const f = launcherFixture(t, { cacheWriteDenied: true });
  fs.mkdirSync(path.join(f.home, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'installer', 'state.json'), JSON.stringify({schema:1,phase:'error',error:'Keep the cache guidance',resumeTarget:'v2.4.6'}));
  await verifiedRepair(f);
  const current = f.context.fixtureOutput.at(-1);
  const reopened = launcherFixture(t, { existingHome: f.home, output: [{ ...current, ...changes }] });
  const response = await reopened.status(); assert.equal(response.ok, true);
  assert.equal(response.value.installer.phase, 'error'); assert.equal(response.value.installer.error, 'Keep the cache guidance');
  assert.equal(response.value.installer.resumeTarget, 'v2.4.6');
});

test('a failed status inspection cannot rebuild the stale presentation from historical success', async t => {
  const f = launcherFixture(t, { cacheWriteDenied: true });
  fs.mkdirSync(path.join(f.home, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'installer', 'state.json'), JSON.stringify({schema:1,phase:'error',error:'Keep guidance',resumeTarget:'v2.4.6'}));
  await verifiedRepair(f);
  const reopened = launcherFixture(t, { existingHome: f.home, childExitCode: 7 });
  const response = await reopened.status(); assert.equal(response.ok, true);
  assert.equal(response.value.statusUnavailable, true); assert.equal(Object.hasOwn(response.value, 'installer'), false);
  assert.equal(reopened.state().phase, 'error'); assert.equal(reopened.state().resumeTarget, 'v2.4.6');
});

test('the current presentation catches up on disk after the cache becomes writable again', async t => {
  const f = launcherFixture(t, { cacheFailureAt: 'output' });
  const result = await f.run(); assert.equal(result.ok, true);
  fs.rmdirSync(path.join(f.home, 'installer', 'state.json'));
  vm.runInContext('recordEvent({event:"task",task:"The cache can be saved again"})', f.context);
  const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'installer', 'state.json')));
  assert.equal(saved.phase, 'ready'); assert.equal(saved.error, ''); assert.equal(saved.milestones[0].state, 'done');
  assert.equal(saved.task, 'The cache can be saved again');
  assert.equal(f.diagnostics().filter(row => row.event === 'state.cache-restored').length, 1);
});

test('a cache failure does not turn a failed backend status into success', async t => {
  const f = launcherFixture(t, { output: [{ event: 'progress', current: 1, total: 1 },
    { event: 'result', systemReady: true, running: false, gatewayRunning: true }] });
  fs.mkdirSync(path.join(f.home, 'installer', 'state.json'), { recursive: true });
  const result = await f.run();
  assert.equal(f.spawned, 1); assert.equal(result.ok, false);
  assert.equal(result.error.userCode, 'VERIFICATION_FAILED');
  assert.equal(result.error.operation.state, 'failed'); assert.equal(result.error.operation.verification, 'unconfirmed');
});

test('real malformed output remains blocking despite a later success record', async t => {
  const f = launcherFixture(t, { output: ['x'.repeat(300 * 1024),
    { event: 'result', systemReady: true, running: true, gatewayRunning: true }] });
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.error.userCode, 'PROCESS_OUTPUT_TOO_LARGE');
  assert.equal(result.error.operation.state, 'failed');
});

test('a real authoritative operation commit write failure never returns UI success', async t => {
  const f = launcherFixture(t, { commitFailure: record => record.state === 'succeeded' });
  const result = await f.run();
  assert.equal(f.spawned, 1); assert.equal(result.ok, false);
  assert.equal(result.error.operation.state, 'failed');
  assert.notEqual(result.error.userCode, 'INSTALLER_STATE_WRITE_FAILED');
});

test('runtime output cache failure preserves the actual returned result', async t => {
  const f = launcherFixture(t, { cacheFailureAt: 'output' });
  const result = await vm.runInContext(`runOwnedTask('repair',{},async context=>{
    const value=await runProcess(process.execPath,[fixtureChild,fixtureRows],null,context.operationId,{returnResult:true});
    return {verification:'confirmed',value};
  })`, f.context);
  assert.equal(result.operation.state, 'succeeded'); assert.equal(result.systemReady, true);
  assert.ok(f.diagnostics().some(row => row.event === 'state.cache-write-failed'));
});

test('confirmed recovery remains rolled back when its presentation cache cannot be saved', async t => {
  const f = launcherFixture(t);
  fs.mkdirSync(path.join(f.home, 'installer', 'state.json'), { recursive: true });
  const result = await vm.runInContext(`(async()=>{
    operationPolicy={recover:async()=>({verification:'confirmed',value:{systemReady:true,
      setupCompleted:true,recoveryVerification:'confirmed',updateRecovered:true}})};
    const operation=await operations().start('recover',{target:{request:{}},execute:context=>recoverMaintenance(context)},'cache-recovery');
    return requireOperationResult(operation,{recover:true});
  })()`, f.context);
  assert.equal(result.operation.state, 'rolled-back'); assert.equal(result.operation.verification, 'confirmed');
  assert.equal(f.state().phase, 'ready'); assert.equal(f.state().setupCompleted, true);
});

test('buffers fragmented JSON and UTF-8, including final unterminated line', async () => {
  const stream = new PassThrough();
  const rows = [];
  consumeLines(stream, value => rows.push(JSON.parse(value)));
  const done = new Promise(resolve => stream.on('end', resolve));
  const bytes = Buffer.from('{"task":"诺拉"}\r\n{"event":"result","ok":true}');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end(); await done;
  assert.deepEqual(rows, [{ task: '诺拉' }, { event: 'result', ok: true }]);
});

test('line callback failures are reported while remaining and final lines are consumed', async () => {
  const stream = new PassThrough();
  const rows = [], failures = [];
  const original = Object.assign(new Error('progress state write denied'), { code: 'EPERM' });
  consumeLines(stream, line => {
    rows.push(line);
    if (line !== 'result') throw original;
  }, error => failures.push(error));
  const done = new Promise(resolve => stream.on('end', resolve));
  assert.doesNotThrow(() => stream.write('progress\nresult\nfinal'));
  stream.end(); await done;
  assert.deepEqual(rows, ['progress', 'result', 'final']);
  assert.deepEqual(failures, [original, original]);
});

test('raw log readers retain blank lines and traceback indentation when explicitly requested',async()=>{
  const stream=new PassThrough(),rows=[];
  consumeLines(stream,line=>rows.push(line),undefined,{preserveBlankLines:true});
  const done=new Promise(resolve=>stream.on('end',resolve));
  stream.write('[ERROR] native failure\n\n  at unpack (archive.js:42:3)\n');stream.end();await done;
  assert.equal(rows.join('\n'),'[ERROR] native failure\n\n  at unpack (archive.js:42:3)');
});

test('external navigation allows HTTPS and loopback, rejects executable and credential URLs', () => {
  assert.equal(externalUrl('https://github.com/LoveMaker-art/noras-tavern'), 'https://github.com/LoveMaker-art/noras-tavern');
  assert.equal(externalUrl('http://127.0.0.1:8799'), 'http://127.0.0.1:8799/');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com']) assert.throws(() => externalUrl(url));
});

test('oversized unterminated output is drained with a bounded error and the next record remains readable',async()=>{
  const stream=new PassThrough(),rows=[],errors=[];
  consumeLines(stream,line=>rows.push(JSON.parse(line)),error=>errors.push(error));
  const done=new Promise(resolve=>stream.on('end',resolve));
  for(let i=0;i<20;i++)stream.write('x'.repeat(32768));
  stream.end('\n{"event":"result","ok":true}\n');await done;
  assert.equal(errors.length,1);assert.equal(errors[0].code,'PROCESS_OUTPUT_TOO_LARGE');
  assert.deepEqual(rows,[{event:'result',ok:true}]);
});
