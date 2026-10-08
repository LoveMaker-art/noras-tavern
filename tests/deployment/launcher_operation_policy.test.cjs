const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {create}=require('../installer/desktop/operation-policy');
const id='22aa0935-996f-4f0d-bfbb-567502e850c5';
function setup(t,overrides={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-policy-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const events=[];const record={operationId:id,kind:'install',target:{request:{port:18999}}};
  const context={operationId:id,ownerEpoch:7,get snapshot(){return record;},get target(){return record.target;},check(){},stage:async()=>{},
    plan:async target=>{record.target=target;},journal:async reference=>{record.journalRefs=[reference];}};
  let runtime={effectState:'untouched',reason:'no_journal'};
  const options={home,hermesHome:path.join(home,'hermes'),installRoot:path.join(home,'tavern'),
    bridge:async(command)=>{events.push(command);return {effects:{effectState:'untouched'}};},
    inspectRuntime:()=>runtime,runRuntime:async()=>{events.push('recover-runtime');runtime={effectState:'restored'};},...overrides};
  const journal=path.join(home,'installer/operations',id,'first-install/transaction.json');
  return {home,events,record,context,options,policy:create(options),journal,setRuntime:next=>{runtime=next;}};
}
test('a failure before any journal exists stays untouched without executing recovery',async t=>{
  const f=setup(t);
  assert.equal((await f.policy.observe(f.record)).effectState,'untouched');
  assert.equal((await f.policy.recover(f.context)).effectState,'untouched');
  assert.deepEqual(f.events,[]);
});
test('whole-install recovery waits for the system writer before restoring the runtime',async t=>{
  const order=[];let runtime={effectState:'changed',reason:'committed'};
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    order.push(command);
    if(command==='operation-effects')return {effects:{effectState:'changed',canRecover:true}};
    if(command==='recover-install')return {firstInstallRecovered:true,recoveryVerification:'confirmed'};
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
  },runRuntime:async()=>{order.push('runtime-closed');runtime={effectState:'restored'};}});
  fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'confirmed');
  assert.deepEqual(order,['operation-effects','recover-install','recovery-stop','runtime-closed']);
});
test('whole-install recovery reports the final absent runtime rather than the intermediate installed core',async t=>{
  let runtime={effectState:'changed',reason:'committed'};
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    if(command==='operation-effects')return {effects:{effectState:'changed',canRecover:true}};
    if(command==='recover-install')return {firstInstallRecovered:true,recoveryVerification:'confirmed',
      hermesInstalled:true,noraInstalled:true,installed:true,systemReady:true,setupCompleted:true,
      running:false,gatewayRunning:false,clawchatConnected:false};
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
    throw new Error(`The absent Python runtime cannot execute ${command}`);
  },runRuntime:async()=>{runtime={effectState:'restored',reason:'previous-absent'};}});
  fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'confirmed');
  assert.equal(result.value.firstInstallRecovered,true);
  for(const key of ['installed','hermesInstalled','noraInstalled','systemReady','setupCompleted','running','gatewayRunning','clawchatConnected'])
    assert.equal(result.value[key],false,key);
});
test('whole recovery rechecks the restored core and restores only the original recorded service',async t=>{
  let runtime={effectState:'changed'},running=false;
  const calls=[];
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async(command,options)=>{
    calls.push([command,options]);
    if(command==='operation-effects')return {effects:{effectState:'changed',canRecover:true}};
    const state={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
      version:'2.4.2',running,gatewayRunning:false,clawchatConnected:false};
    if(command==='recover-install')return {...state,running:true,firstInstallRecovered:true,recoveryVerification:'confirmed'};
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
    if(command==='status')return state;
    if(command==='verify-current-update')return {...state,updateVerified:true};
    if(command==='start'){assert.equal(options.service,'tavern');running=true;return {...state,running};}
    throw new Error(`Unexpected command ${command}`);
  },runRuntime:async()=>{runtime={effectState:'restored'};}});
  fs.mkdirSync(f.options.hermesHome);fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'confirmed');assert.equal(result.value.running,true);
  assert.equal(result.value.gatewayRunning,false);
  assert.deepEqual(calls.map(([command])=>command),['operation-effects','recover-install','recovery-stop','status','verify-current-update','start','status']);
  assert.equal(calls.find(([command])=>command==='verify-current-update')[1].version,'2.4.2');
});
test('failed final service restoration keeps a bounded recovery choice and never exchanges files again',async t=>{
  let runtime={effectState:'changed'},filesRestored=false,running=false,allowStart=false,runtimeRestores=0,systemRestores=0;
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    if(command==='operation-effects')return {effects:{effectState:filesRestored?'restored':'changed',canRecover:!filesRestored}};
    const state={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
      version:'2.4.2',running,gatewayRunning:false,clawchatConnected:false};
    if(command==='recover-install'){systemRestores++;filesRestored=true;
      return {...state,running:true,firstInstallRecovered:true,recoveryVerification:'confirmed'};}
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
    if(command==='status')return state;
    if(command==='verify-current-update')return {...state,updateVerified:true};
    if(command==='start'){if(!allowStart)throw Object.assign(new Error('old service failed to start'),{code:'PROCESS_START_FAILED'});
      running=true;return {...state,running};}
    throw new Error(`Unexpected command ${command}`);
  },runRuntime:async()=>{runtimeRestores++;runtime={effectState:'restored'};}});
  fs.mkdirSync(f.options.hermesHome);fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const first=await f.policy.recover(f.context);
  assert.equal(first.verification,'failed');assert.equal(first.filesRestored,true);assert.equal(first.value.running,false);
  assert.equal(first.secondaryErrors[0].error.code,'PROCESS_START_FAILED');
  f.record.result=first.value;f.record.recoveryOutcome='files-restored-start-failed';allowStart=true;
  const next=await f.policy.recover(f.context);
  assert.equal(next.verification,'confirmed');assert.equal(next.value.running,true);
  assert.equal(runtimeRestores,1);assert.equal(systemRestores,1);
});
test('an incomplete final status is never replaced with the earlier healthy status',async t=>{
  let runtime={effectState:'changed'};
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    if(command==='operation-effects')return {effects:{effectState:'changed',canRecover:true}};
    if(command==='recover-install')return {firstInstallRecovered:true,recoveryVerification:'confirmed',
      version:'2.4.2',running:true,gatewayRunning:false,clawchatConnected:false,hermesInstalled:true};
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
    if(command==='status')return {running:false};
    throw new Error(`Unconfirmed status must not execute ${command}`);
  },runRuntime:async()=>{runtime={effectState:'restored'};}});
  fs.mkdirSync(f.options.hermesHome);fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'failed');assert.equal(result.filesRestored,true);
  assert.equal(result.value.hermesInstalled,undefined);assert.equal(result.value.running,undefined);
  assert.equal(result.value.recoveryServiceState.running,true);
});
test('an exit result without actual stop proof never allows runtime rollback',async t=>{
  let restored=false;
  const f=setup(t,{inspectRuntime:()=>({effectState:'changed'}),bridge:async()=>({running:false}),runRuntime:async()=>{restored=true;}});
  await assert.rejects(f.policy.recover(f.context),{code:'VERIFICATION_FAILED'});
  assert.equal(restored,false);
});
test('unknown configuration effects block mutation and cannot reset retries',async t=>{
  let writes=0;
  const f=setup(t,{bridge:async()=>({effects:{effectState:'unknown',canRecover:false}}),
    runRuntime:async()=>{writes++;},checkConditions:async()=>({eligible:true,facts:{network:true}})});
  fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  assert.equal((await f.policy.observe(f.record)).canRecover,false);
  await assert.rejects(f.policy.recover(f.context),{code:'UPDATE_RECOVERY_REQUIRED'});
  assert.equal((await f.policy.recheck(f.record)).changed,false);
  assert.equal(writes,0);
});
test('a first healthy measurement without a failure-bound baseline cannot grant attempts',async t=>{
  const f=setup(t,{checkConditions:async()=>({eligible:true,facts:{release:true,directory:[1,2]}})});
  const first=await f.policy.recheck(f.record);assert.equal(first.changed,false);
  assert.equal(first.baseline,undefined);
  assert.equal((await f.policy.recheck(f.record)).changed,false);
});

test('historical recovery is an explicit sealed choice and requires positive stop proof before a file writer',async t=>{
  const legacy={kind:'legacy',canRecover:true,journalDigest:'a'.repeat(64),journalReference:'/fixture/journal',
    restoreVersion:'2.4.2',dataPolicy:'restore-backup-preserve-current'};
  const order=[];
  const f=setup(t,{inspectLegacy:()=>legacy,bridge:async command=>{
    order.push(command);return {offline:true,running:false,gatewayRunning:false};
  },runLegacy:async(context,request)=>{
    order.push('restore-files');assert.equal(request.journalDigest,legacy.journalDigest);
    assert.deepEqual(request.offlineProof,{operationId:id,ownerEpoch:7,offline:true,running:false,gatewayRunning:false});
    return {legacyFilesRestored:true,effectState:'restored',recoveryVerification:'files-only',restoreVersion:'2.4.2'};
  }});
  await assert.rejects(f.policy.recover(f.context,{error:new Error('update failed')}),{code:'UPDATE_RECOVERY_REQUIRED'});
  assert.deepEqual(order,[]);
  const result=await f.policy.recover(f.context);
  assert.deepEqual(order,['recovery-stop','restore-files']);
  assert.equal(result.verification,'failed');assert.equal(result.filesRestored,true);
  assert.equal(result.value.originalServiceState,'unrecorded');assert.equal(f.record.target.legacyRecovery.journalDigest,legacy.journalDigest);
});

test('a changed legacy journal or unconfirmed service stop cannot move either tree',async t=>{
  let restored=false;
  const legacy={canRecover:true,journalDigest:'a'.repeat(64),journalReference:'/fixture/journal'};
  const f=setup(t,{inspectLegacy:()=>legacy,bridge:async()=>({running:false}),runLegacy:async()=>{restored=true;}});
  f.record.target.legacyRecovery={journalDigest:'b'.repeat(64)};
  await assert.rejects(f.policy.recover(f.context),{code:'CONDITIONS_CHANGED'});
  delete f.record.target.legacyRecovery;
  await assert.rejects(f.policy.recover(f.context),{code:'VERIFICATION_FAILED'});
  assert.equal(restored,false);
});

test('a restored historical version starts only after actual fixed-version acceptance and never restores files twice',async t=>{
  const calls=[];
  const f=setup(t,{inspectLegacy:()=>null,bridge:async(command,options)=>{
    calls.push([command,options]);return command==='start'?{running:true,systemReady:true,version:'2.4.2'}:
      {updateVerified:true,systemReady:true,version:'2.4.2'};
  },runLegacy:async()=>{throw new Error('must not restore twice');}});
  f.record.kind='recover';f.record.result={legacyFilesRestored:true,restoreVersion:'2.4.2',port:18999};
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'confirmed');assert.equal(result.value.legacyServicesVerified,true);
  assert.deepEqual(calls.map(call=>call[0]),['verify-current-update','start']);
  assert.equal(calls[0][1].version,'2.4.2');assert.equal(calls[1][1].service,'tavern');
});

test('an APP handoff without a trusted inspector is unknown and blocks system recovery',async t=>{
  const f=setup(t);f.record.kind='update';f.record.handoffRef='/unconfirmed/app-job';
  assert.equal((await f.policy.observe(f.record)).effectState,'unknown');
  await assert.rejects(f.policy.recover(f.context),{code:'LAUNCHER_RECOVERY_REQUIRED'});
  assert.deepEqual(f.events,[]);
});

test('a restored runtime with failed probe remains pending until the real recovery executor verifies it',async t=>{
  let runtime={effectState:'restored',recoveryOutcome:'recovery-required',canRecover:true,reason:'runtime-verification-required'};
  const calls=[];
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    calls.push(command);return {offline:true,running:false,gatewayRunning:false};
  },runRuntime:async()=>{calls.push('runtime-probe');runtime={effectState:'restored',recoveryOutcome:'restored'};},
    checkConditions:async()=>{throw new Error('network checks cannot clear pending runtime acceptance');}});
  const facts=await f.policy.observe(f.record);
  assert.equal(facts.recoveryOutcome,'recovery-required');assert.equal(facts.canRecover,true);
  assert.equal((await f.policy.recheck(f.record)).changed,false);
  const recovered=await f.policy.recover(f.context);
  assert.equal(recovered.verification,'confirmed');assert.deepEqual(calls,['recovery-stop','runtime-probe']);
});

test('a recovery process exit without confirmation of the restored runtime cannot complete recovery',async t=>{
  const runtime={effectState:'restored',recoveryOutcome:'recovery-required',canRecover:true};
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async()=>({offline:true,running:false,gatewayRunning:false}),runRuntime:async()=>{}});
  await assert.rejects(f.policy.recover(f.context),{code:'UPDATE_RECOVERY_REQUIRED'});
});
