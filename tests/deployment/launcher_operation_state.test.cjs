const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperationController } = require('../installer/desktop/operation-state');
const {createTestOperationLock}=require('./launcher_operation_test_lock.cjs');

function fixture(t, execute, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-operation-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lock = createTestOperationLock();
  const options = {directory, lock, executors:{install:execute}, verifyResult:()=>true, ...overrides};
  return {directory, options, controller:createOperationController(options)};
}

test('service retry cooldown expires across reopen without discarding original failures',async t=>{
  for(const kind of ['start','restart','stop','shutdown'])await t.test(kind,async t=>{
    let now=Date.parse('2026-10-27T00:00:00Z'),runs=0,healthy=false;
    const execute=async()=>{runs++;if(!healthy)throw Object.assign(new Error('fixture temporary connection failure'),{code:'CLAWCHAT_CONNECT_TIMEOUT'});return {};};
    const f=fixture(t,execute,{now:()=>new Date(now).toISOString(),executors:{[kind]:execute},
      observeEffects:async()=>({effectState:'untouched',recoveryOutcome:'not-required'})});
    const request={target:{request:{action:kind,service:'nora'}}};
    const first=await f.controller.start(kind,request,'first');
    now+=1000;const second=await f.controller.start(kind,request,'second');
    const bytes=id=>fs.readFileSync(path.join(f.directory,'operations',id,'operation.json'));
    const saved=[bytes(first.operationId),bytes(second.operationId)];
    const blocked=await f.controller.start(kind,request,'cooldown');
    assert.equal(blocked.failureCode,'SERVICE_RETRY_COOLDOWN');assert.equal(runs,2);
    assert.ok(!blocked.allowedActions.includes('retry'));
    const retryAt=blocked.serviceRetryAt;
    for(const index of [1,2,3]){
      now+=1000;const again=await f.controller.start(kind,request,'blocked-'+index);
      assert.equal(again.serviceRetryAt,retryAt);assert.equal(runs,2);
    }
    now+=30001;healthy=true;
    const reopened=createOperationController(f.options);
    const ready=await reopened.snapshot(blocked.operationId);
    assert.ok(ready.allowedActions.includes('retry'));
    assert.equal((await reopened.resume(blocked.operationId)).state,'succeeded');assert.equal(runs,3);
    assert.deepEqual(bytes(first.operationId),saved[0]);assert.deepEqual(bytes(second.operationId),saved[1]);
  });
});

test('service retry never bypasses unknown effects or an unfinished recovery',async t=>{
  let runs=0;
  const execute=async context=>{runs++;await context.effect('unknown');throw new Error('fixture service failure');};
  const f=fixture(t,execute,{executors:{start:execute},
    observeEffects:async()=>({effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false})});
  const request={target:{request:{action:'start',service:'nora'}}};
  const failed=await f.controller.start('start',request,'first');
  assert.ok(!failed.allowedActions.includes('retry'));
  await assert.rejects(f.controller.start('start',request,'second'),{code:'UPDATE_RECOVERY_REQUIRED'});
  assert.equal(runs,1);
});

test('legacy service retry blocks cannot extend the cooldown by repeated blocked clicks',async t=>{
  let now=Date.parse('2026-10-27T00:00:00Z'),runs=0,healthy=false;
  const execute=async()=>{runs++;if(!healthy)throw Object.assign(new Error('fixture timeout'),{code:'CLAWCHAT_CONNECT_TIMEOUT'});return {};};
  const f=fixture(t,execute,{now:()=>new Date(now).toISOString(),executors:{start:execute}});
  const request={target:{request:{action:'start',service:'nora'}}};
  await f.controller.start('start',request,'one');await f.controller.start('start',request,'two');
  const blocked=await f.controller.start('start',request,'three');
  const file=path.join(f.directory,'operations',blocked.operationId,'operation.json');
  const old=JSON.parse(fs.readFileSync(file));old.primaryFailure={code:'RETRY_CONDITIONS_UNCHANGED',site:'launcher.operation'};
  old.currentFailure=null;delete old.serviceRetryAt;old.state='blocked';fs.writeFileSync(file,JSON.stringify(old));
  now+=86400000;healthy=true;
  const reopened=createOperationController(f.options);
  assert.ok((await reopened.snapshot(blocked.operationId)).allowedActions.includes('retry'));
  assert.equal((await reopened.resume(blocked.operationId)).state,'succeeded');assert.equal(runs,3);
});

test('recheck closes a verified restored handoff durably and admits a subsequent operation',async t=>{
  let reads=0;
  const f=fixture(t,async context=>{
    await context.plan(context.target);
    await context.handoff('/owned/job');
    return {handoff:true};
  },{observeEffects:async()=>({effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false}),
    verifyRestoredHandoff:async(record,context)=>{
      context.check();reads++;
      return {operationId:record.operationId,planDigest:record.planDigest,job:record.handoffRef,
        status:'restored',verification:'confirmed',failure:Object.assign(new Error('Incoming launcher exited before ready'),{code:'LAUNCHER_START_FAILED'}),
        value:{version:'2.4.5',recoveryVerification:'confirmed'}};
    }});
  const pending=await f.controller.start('install',{target:{currentVersion:'2.4.5'}},'handoff-restore');
  const file=path.join(f.directory,'operations',pending.operationId,'operation.json');
  const bytes=fs.readFileSync(file);
  assert.equal((await f.controller.snapshot(pending.operationId)).state,'interrupted');
  assert.deepEqual(fs.readFileSync(file),bytes,'status must remain read-only');
  const restored=await f.controller.recheck(pending.operationId,{snapshotSequence:pending.snapshotSequence});
  assert.equal(restored.state,'rolled-back');
  assert.equal(restored.verification,'confirmed');
  assert.equal(restored.currentFailure,null);
  assert.equal(restored.primaryFailure.code,'LAUNCHER_START_FAILED');
  assert.equal(restored.recoveryOutcome,'restored-and-verified');
  const reopened=createOperationController(f.options);
  assert.equal((await reopened.snapshot()).state,'rolled-back');
  await reopened.recheck(pending.operationId);
  assert.equal(reads,1,'a terminal handoff is not rehashed or closed again');
  assert.equal((await reopened.start('start',{execute:async()=>({verification:'confirmed'})},'after-restore')).state,'succeeded');
});

test('recheck ends an untouched cancelled handoff as failed and preserves its original error',async t=>{
  const original=Object.assign(new Error('Directory is being used by another process'),{code:'EACCES'});
  const f=fixture(t,async context=>{await context.handoff('/owned/job');return {handoff:true};},
    {verifyRestoredHandoff:async(record)=>({operationId:record.operationId,planDigest:record.planDigest,job:record.handoffRef,
      status:'cancelled',effectState:'untouched',verification:'confirmed',failure:original,value:{version:'2.5.0',notAppliedVerification:'confirmed'}})});
  const pending=await f.controller.start('install',{},'untouched-handoff');
  const ended=await f.controller.recheck(pending.operationId);
  assert.equal(ended.state,'failed');assert.equal(ended.effectState,'untouched');
  assert.equal(ended.recoveryOutcome,'not-required');assert.equal(ended.verification,'confirmed');
  assert.equal(ended.primaryFailure.code,'EACCES');assert.equal(ended.currentFailure,null);
  assert.equal((await createOperationController(f.options).snapshot()).state,'failed');
  assert.equal((await f.controller.start('stop',{execute:async()=>({verification:'confirmed'})},'after-untouched')).state,'succeeded');
});

test('handoff reconciliation rejects stale snapshots and foreign or unconfirmed outcomes',async t=>{
  let outcome;
  const f=fixture(t,async context=>{await context.handoff('/owned/job');return {handoff:true};},
    {verifyRestoredHandoff:async()=>outcome});
  const pending=await f.controller.start('install',{},'pending-reconcile');
  const file=path.join(f.directory,'operations',pending.operationId,'operation.json'),bytes=fs.readFileSync(file);
  const valid={operationId:pending.operationId,planDigest:pending.planDigest,job:pending.handoffRef,status:'restored',verification:'confirmed'};
  for(const change of [{operationId:'foreign'},{planDigest:'foreign'},{job:'/foreign'},{verification:'unconfirmed'}, {status:'committed'}]){
    outcome={...valid,...change};
    await f.controller.recheck(pending.operationId);
    assert.deepEqual(fs.readFileSync(file),bytes);
  }
  outcome=valid;
  await assert.rejects(f.controller.recheck(pending.operationId,{snapshotSequence:pending.snapshotSequence-1}),{code:'OPERATION_SNAPSHOT_CHANGED'});
  assert.deepEqual(fs.readFileSync(file),bytes);
});

test('KEEP archival invalidates the same controller active history before its next commit and request lookup',async t=>{
  for(const mode of ['capacity','request'])await t.test(mode,async t=>{
    const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-retained-history-cache-')));
    t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
    const directory=path.join(home,'installer'),lock=createTestOperationLock(),retained=require('../installer/desktop/retained-installation');
    const uninstall=require('../installer/desktop/uninstall');uninstall.own(home);
    const native=require('../installer/desktop/os-lock').acquire({directory});native.release();
    const lockFile=path.join(directory,'operations/.writer.lock'),writer=fs.statSync(lockFile,{bigint:true});
    const controller=createOperationController({directory,lock,retention:{fullRecords:2,facts:4,stopReserve:0}});
    const original=await controller.start('stop',{target:{request:{action:'stop'}},execute:async()=>({verification:'confirmed'})},'retired-request');
    const originalFile=path.join(directory,'operations',original.operationId,'operation.json'),originalBytes=fs.readFileSync(originalFile);
    fs.writeFileSync(path.join(home,'nora-retained.json'),JSON.stringify({schema:1,hermes:'hermes'}));
    const install=await controller.start('install',{target:{request:{action:'install'},fixture:'first'},execute:async context=>{
      await context.plan(context.target);retained.legacyHistory(home,context.operationId);
      // The actual owner-bound receipt and rename are exercised; this unit
      // isolates registry lifetime, and makes no native-offline/install claim.
      const plan={root:home,hermes:'hermes',tavern:'tavern',port:18889};
      retained.complete(plan,retained.begin(plan,{excludeOperationId:context.operationId}));
      await context.stage('prepared');return {verification:'confirmed'};
    }},'keep-reinstall-request');
    assert.equal(install.state,'succeeded');
    assert.deepEqual(fs.readdirSync(path.join(directory,'operations')).filter(name=>/^[a-f0-9-]{36}$/i.test(name)),[install.operationId]);
    const receipt=retained.inspect(home),history=path.join(home,receipt.archive,'history/installer/operations',original.operationId,'operation.json');
    assert.deepEqual(fs.readFileSync(history),originalBytes);
    const target=mode==='request'?{request:{action:'stop'}}:{request:{action:'install'},fixture:'next'};
    const next=await controller.start(mode==='request'?'stop':'install',{target,execute:async()=>({verification:'confirmed'})},mode==='request'?'retired-request':'new-request');
    assert.equal(next.state,'succeeded');assert.notEqual(next.operationId,original.operationId);
    assert.equal(fs.statSync(lockFile,{bigint:true}).ino,writer.ino);
  });
});

async function commitAckFixture(t,{success=false,successor=false,differentTarget=false,keepWriter=false}={}){
  const native=require('../installer/desktop/operation-lock');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-commit-ack-'));
  let original,acquisitions=0,failedCommits=0,runs=0,recordAfterRelease;
  t.after(async()=>{if(keepWriter&&original)await original.release();fs.rmSync(directory,{recursive:true,force:true});});
  const lock={probe:native.probe,acquire:async options=>{
    const lease=await native.acquire(options);
    if(++acquisitions!==1)return lease;
    original=lease;
    return {...lease,commitOperation:async request=>{
      // The native writer really commits the record and filesystem generation.
      // Only the acknowledgement is lost; never fabricate a journal or result.
      const committed=await lease.commitOperation(request);
      if(request.record.state==='failed')failedCommits++;
      if(success&&request.record.state==='succeeded'||failedCommits===2)
        throw Object.assign(new Error('The committed record acknowledgement was lost'),{code:'COMMIT_ACK_LOST'});
      return committed;
    },release:async()=>{
      if(keepWriter)throw Object.assign(new Error('The native writer has not confirmed closure'),{code:'LOCK_GUARD_LOST'});
      await lease.release();
      const file=path.join(directory,'operations',options.operationId,'operation.json');
      if(successor||differentTarget){
        const before=JSON.parse(fs.readFileSync(file)),ownerEpoch=before.ownerEpoch+(successor?1:0),
          replacement=await native.acquire({directory,operationId:options.operationId,ownerEpoch});
        const changedTarget=differentTarget?{...before.target,planId:'another-ack-target'}:before.target;
        try{await replacement.commitOperation({record:{...before,ownerEpoch,sequence:before.sequence+1,target:changedTarget,
          planDigest:require('node:crypto').createHash('sha256').update(JSON.stringify(changedTarget)).digest('hex')},
          expected:{ownerEpoch:before.ownerEpoch,sequence:before.sequence}});}finally{await replacement.release();}
      }
      recordAfterRelease=fs.readFileSync(file);
    }};
  }};
  const target={request:{action:'update'},planId:'immutable-ack-target'};
  const controller=createOperationController({directory,lock,executors:{update:async context=>{
    runs++;await context.plan(target);
    if(success)return {verification:'confirmed',value:{updateVerified:true}};
    throw Object.assign(new Error('Original metadata request failed'),{code:'TIMEOUT'});
  }}});
  const result=await controller.start('update',{target},'commit-ack-request');
  const file=path.join(directory,'operations',result.operationId,'operation.json');
  return {directory,result,file,target,original,native,get runs(){return runs;},get recordAfterRelease(){return recordAfterRelease;}};
}

test('a lost failure commit ACK returns the same durable snapshot after the actual native writer closes',async t=>{
  const f=await commitAckFixture(t),saved=JSON.parse(fs.readFileSync(f.file));
  assert.equal(f.result.state,'failed');assert.equal(f.result.verification,'unconfirmed');assert.equal(f.result.effectState,'unknown');
  assert.equal(f.result.snapshotSequence,saved.sequence,'do not return a pre-commit snapshot as the current failure');
  assert.equal(f.result.ownerEpoch,saved.ownerEpoch);assert.deepEqual(f.result.target,f.target);
  assert.equal(f.result.primaryFailure.code,'TIMEOUT');assert.ok(f.result.secondaryFailures.some(item=>item.code==='COMMIT_ACK_LOST'));
  assert.deepEqual(f.result.allowedActions,['recheck','logs']);assert.equal(f.runs,1);
  assert.equal((await f.native.probe({directory:f.directory})).busy,false);
  assert.deepEqual(fs.readFileSync(f.file),f.recordAfterRelease,'snapshot reconciliation must not rewrite the durable record');
});

test('a lost success and failure ACK remains a failed actor outcome even when its durable sequence is reconciled',async t=>{
  const f=await commitAckFixture(t,{success:true}),saved=JSON.parse(fs.readFileSync(f.file));
  assert.equal(f.result.state,'failed');assert.equal(f.result.verification,'unconfirmed');assert.equal(f.result.effectState,'unknown');
  assert.equal(f.result.snapshotSequence,saved.sequence);assert.equal(f.result.primaryFailure.code,'COMMIT_ACK_LOST');
  assert.deepEqual(f.result.allowedActions,['recheck','logs']);assert.equal(f.runs,1);
  assert.deepEqual(fs.readFileSync(f.file),f.recordAfterRelease);
});

test('a lost commit ACK cannot borrow a successor epoch or rewrite its native committed record',async t=>{
  const f=await commitAckFixture(t,{successor:true}),saved=JSON.parse(fs.readFileSync(f.file));
  assert.ok(saved.ownerEpoch>f.result.ownerEpoch);assert.notEqual(f.result.snapshotSequence,saved.sequence);
  assert.equal(f.result.state,'failed');assert.equal(f.result.verification,'unconfirmed');assert.equal(f.result.effectState,'unknown');
  assert.equal(f.result.primaryFailure.code,'TIMEOUT');assert.ok(f.result.secondaryFailures.some(item=>item.code==='COMMIT_ACK_LOST'));
  assert.ok(f.result.evidenceMissingReasons.includes('failure_snapshot_unconfirmed:OWNER_OR_TARGET_CHANGED'));
  assert.deepEqual(fs.readFileSync(f.file),f.recordAfterRelease);
});

test('a lost commit ACK cannot borrow another fixed target even when its epoch is unchanged',async t=>{
  const f=await commitAckFixture(t,{differentTarget:true}),saved=JSON.parse(fs.readFileSync(f.file));
  assert.equal(saved.ownerEpoch,f.result.ownerEpoch);assert.notEqual(saved.planDigest,f.result.planDigest);
  assert.notEqual(f.result.snapshotSequence,saved.sequence);assert.deepEqual(f.result.target,f.target);
  assert.equal(f.result.state,'failed');assert.equal(f.result.effectState,'unknown');assert.equal(f.result.primaryFailure.code,'TIMEOUT');
  assert.ok(f.result.evidenceMissingReasons.includes('failure_snapshot_unconfirmed:OWNER_OR_TARGET_CHANGED'));
  assert.deepEqual(fs.readFileSync(f.file),f.recordAfterRelease);
});

test('an unclosed native writer cannot reconcile a lost ACK into a usable current snapshot',async t=>{
  const f=await commitAckFixture(t,{keepWriter:true}),saved=JSON.parse(fs.readFileSync(f.file));
  assert.equal((await f.native.probe({directory:f.directory})).busy,true);
  assert.notEqual(f.result.snapshotSequence,saved.sequence);assert.equal(f.result.state,'failed');assert.equal(f.result.effectState,'unknown');
  assert.equal(f.result.primaryFailure.code,'TIMEOUT');assert.equal(f.result.verification,'unconfirmed');
  assert.ok(f.result.evidenceMissingReasons.includes('failure_snapshot_unconfirmed:WRITER_OR_EXECUTOR_ACTIVE'));
});

test('a repeated request after reopening returns its stored result without executing again', async t => {
  let runs = 0;
  const f = fixture(t, async context => { runs++; await context.stage('verifying'); return {installed:true}; });
  const first = await f.controller.start('install', {target:{planId:'fixed-plan'}}, 'request-one');
  const again = await createOperationController(f.options).start('install', {target:{planId:'fixed-plan'}}, 'request-one');
  assert.equal(runs, 1);
  assert.equal(first.operationId, again.operationId);
  assert.equal(again.state, 'succeeded');
  assert.equal(again.target.planId, 'fixed-plan');
  assert.deepEqual(again.result, {installed:true});
});

test('prepared closure is persisted by the actual native owner before any runtime write and survives actual archive',async t=>{
 let clock=Date.parse('2026-01-01T00:00:00Z'),writes=0;
 const f=fixture(t,async context=>{await context.plan({planId:'fixed-'+context.operationId});await context.stage('prepared');
  const record=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',context.operationId,'operation.json')));
  assert.equal(record.state,'prepared');assert.equal(record.planSelected,true);assert.deepEqual(record.effectClosureRefs,[{path:`installer/operations/${context.operationId}/partial-history.json`,sha256:'a'.repeat(64)}]);
  context.check();writes++;return {installed:true};},{lock:require('../installer/desktop/operation-lock'),now:()=>new Date(clock).toISOString(),
   retention:{detailDays:30,fullRecords:2,facts:8},prepareEffects:async context=>{
    context.check();const record=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',context.operationId,'operation.json')));
    assert.equal(record.planSelected,true);assert.equal(record.effectState,'untouched');assert.notEqual(record.state,'prepared');
    return [{path:`installer/operations/${context.operationId}/partial-history.json`,sha256:'a'.repeat(64)}];}});
 f.options.evidence=require('../installer/desktop/evidence-store').createEvidenceStore({directory:f.directory});f.controller=createOperationController(f.options);
 const first=await f.controller.start('install',{},'closure-first');
 f.options.evidence.begin({operationId:first.operationId}).finish({delivery:{queued:0,accepted:1,last_ack:clock}});clock+=31*86400000;
 await f.controller.start('install',{},'closure-second');await f.controller.start('install',{},'closure-third');
 const archived=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',first.operationId,'operation.json')));
 assert.equal(writes,3);assert.equal(archived.archived,true);assert.equal(archived.planSelected,true);assert.deepEqual(archived.target,{});
 assert.deepEqual(archived.effectClosureRefs,[{path:`installer/operations/${first.operationId}/partial-history.json`,sha256:'a'.repeat(64)}]);
});

test('closure preparation failure stops before prepared and before runtime mutation under the actual native owner',async t=>{
 let writes=0;
 const f=fixture(t,async context=>{await context.plan({planId:'fixed'});await context.stage('prepared');writes++;return {installed:true};},
  {lock:require('../installer/desktop/operation-lock'),prepareEffects:async context=>{context.check();throw Object.assign(new Error('proof write denied'),{code:'EACCES'});}});
 const result=await f.controller.start('install',{},'closure-denied');assert.equal(writes,0);assert.equal(result.failureCode,'EACCES');assert.equal(result.effectState,'untouched');
 const record=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',result.operationId,'operation.json')));assert.notEqual(record.stageId,'prepared');assert.equal(record.effectClosureRefs,undefined);
});

test('failure evidence is frozen before recovery, and recovery failure does not replace the first cause', async t => {
  const order = [];
  const primary = Object.assign(new Error('program failed'), {code:'TAVERN_PROCESS_EXITED'});
  const evidence = {begin(){return {freeze({error,secondaryErrors}){
    if(error){order.push('freeze');assert.equal(error, primary);}
    else assert.equal(secondaryErrors[0].error.code,'EACCES');return {status:'saved'};
  },finish(){return {status:'saved'};}};}};
  const f = fixture(t, async context => { await context.effect('changed'); throw primary; }, {
    evidence, recoverers:{install:async()=>{order.push('recover');throw Object.assign(new Error('backup inaccessible'),{code:'EACCES'});}},
  });
  const result = await f.controller.start('install', {target:{planId:'fixed-plan'}}, 'request-fail');
  assert.deepEqual(order, ['freeze','recover']);
  assert.equal(result.failureCode, 'TAVERN_PROCESS_EXITED');
  assert.equal(result.recoveryOutcome, 'recovery-required');
  assert.equal(result.secondaryFailures[0].code, 'EACCES');
  assert.deepEqual(result.allowedActions, ['recover','recheck','logs']);
});

test('two unchanged failures survive reopening and stop direct retries; changed conditions allow a new attempt', async t => {
  let runs=0;
  const f = fixture(t, async()=>{runs++;throw Object.assign(new Error('offline'),{code:'ENOTFOUND'});});
  const options={target:{planId:'fixed-plan'},conditionFingerprint:'network-one'};
  await f.controller.start('install', options, 'attempt-one');
  await createOperationController(f.options).start('install', options, 'attempt-two');
  const blocked=await createOperationController(f.options).start('install', options, 'attempt-three');
  assert.equal(runs,2);
  assert.equal(blocked.state,'blocked');
  assert.equal(blocked.failureCode,'RETRY_CONDITIONS_UNCHANGED');
  assert.deepEqual(blocked.allowedActions,['recheck','logs']);
  await createOperationController(f.options).start('install',{...options,conditionFingerprint:'network-two'},'attempt-four');
  assert.equal(runs,3);
});

test('known incompatible untouched failures offer the matching safe action and cannot resume the same executor',async t=>{
  const {failureResult}=require('../installer/desktop/operation-result');
  for(const code of ['RELEASE_EXECUTOR_INCOMPATIBLE','RESOURCE_INCOMPLETE']){
    let runs=0;
    const original=Object.assign(new Error('fixed package cannot execute'),{userCode:code});
    const f=fixture(t,async()=>{runs++;throw original;});
    const operation=await f.controller.start('install',{target:{version:'fixed-package'}},code);
    assert.equal(operation.effectState,'untouched');assert.deepEqual(operation.allowedActions,code==='RELEASE_EXECUTOR_INCOMPATIBLE'?['logs']:['replace-launcher','logs']);
    assert.equal(operation.failureCode,code);
    assert.deepEqual(failureResult(original,{action:'install',operation}).error.allowedActions,operation.allowedActions);
    const reopened=await createOperationController(f.options).snapshot(operation.operationId);
    assert.deepEqual(reopened.allowedActions,operation.allowedActions);
    await assert.rejects(f.controller.resume(operation.operationId),{code:'OPERATION_ACTION_UNAVAILABLE'});
    assert.equal(runs,1);
  }
});

test('busy and uncertain effects keep safety actions ahead of incompatible-package guidance',async t=>{
  const {failureResult}=require('../installer/desktop/operation-result');
  const original=Object.assign(new Error('incompatible after uncertain effect'),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
  const f=fixture(t,async context=>{await context.effect('unknown');throw original;});
  const operation=await f.controller.start('install',{},'uncertain-incompatible');
  assert.deepEqual(operation.allowedActions,['recover','recheck','logs']);
  assert.deepEqual(failureResult(original,{operation}).error.allowedActions,operation.allowedActions);
  f.options.lock.probe=async()=>({busy:true});
  const busy=await f.controller.snapshot(operation.operationId);
  assert.deepEqual(busy.allowedActions,['wait','logs']);
  assert.deepEqual(failureResult(original,{operation:busy}).error.allowedActions,busy.allowedActions);
});

test('model validation failures have a finite cooldown while corrected inputs allow a new actual attempt',async t=>{
  const {configurationFingerprint}=require('../installer/desktop/model-config');
  const salt='fixture-installation-private-salt';let runs=0;
  const execute=async()=>{runs++;throw Object.assign(new Error('credential rejected'),{status:401});};
  const f=fixture(t,async()=>{}, {executors:{model:execute}});
  const input={provider:'custom',model:'model-a',key:'fixture-private-key-a',baseUrl:'https://fixture.invalid/v1',authMode:'key'};
  const attempt=async(payload,id)=>createOperationController(f.options).start('model',
    {target:{request:{mode:'configure',provider:'custom'}},conditionFingerprint:configurationFingerprint(payload,salt)},id);
  await attempt(input,'model-one');await attempt(input,'model-two');
  assert.equal((await attempt(input,'model-third')).state,'blocked');assert.equal(runs,2);
  assert.equal((await attempt({...input,key:'fixture-private-key-b'},'corrected-key')).state,'failed');assert.equal(runs,3);
  assert.equal((await attempt({...input,model:'model-b'},'different-model')).state,'failed');assert.equal(runs,4);
  const records=fs.readdirSync(path.join(f.directory,'operations')).filter(name=>/^[a-f0-9-]{36}$/i.test(name))
    .map(name=>fs.readFileSync(path.join(f.directory,'operations',name,'operation.json'),'utf8')).join('\n');
  for(const secret of [input.key,'fixture-private-key-b',input.baseUrl])assert.equal(records.includes(secret),false);
  assert.equal(configurationFingerprint(input,salt),configurationFingerprint({...input},salt));
  assert.notEqual(configurationFingerprint(input,salt),configurationFingerprint(input,'another-installation-private-salt'));
});

test('model cooldown expires without changing input and blocked clicks cannot extend it across reopening',async t=>{
  let now=Date.now(),runs=0,succeed=false;
  const f=fixture(t,async()=>{}, {now:()=>new Date(now).toISOString(),executors:{model:async()=>{
    runs++;if(!succeed)throw Object.assign(new Error('temporary provider failure'),{status:503});return {};
  }}});
  const options={target:{request:{mode:'configure',provider:'custom'}},conditionFingerprint:'same-private-input'};
  const submit=id=>createOperationController(f.options).start('model',options,id);
  const startedAt=now;
  const first=await submit('first');now+=1000;const second=await submit('second');
  const bytes=id=>fs.readFileSync(path.join(f.directory,'operations',id,'operation.json'));
  const history=[bytes(first.operationId),bytes(second.operationId)];
  for(const [i,elapsed] of [1000,10000,29000].entries()){
    now=startedAt+elapsed;
    const blocked=await submit(`blocked-${i}`);
    assert.equal(blocked.failureCode,'MODEL_RETRY_COOLDOWN');assert.equal(runs,2);
    assert.match(blocked.currentFailure.guidance.next,/30秒/);
    assert.match(blocked.currentFailure.guidance.detail,/没有发送模型请求/);
    assert.ok(blocked.allowedActions.includes('configure-model'));
    assert.ok(!blocked.allowedActions.includes('resume'));
  }
  now=startedAt+30001;succeed=true;
  assert.equal((await submit('after-window')).state,'succeeded');assert.equal(runs,3);
  assert.deepEqual(bytes(first.operationId),history[0]);assert.deepEqual(bytes(second.operationId),history[1]);
});

test('legacy model retry blocks allow a fresh form submission without deleting history',async t=>{
  for(const archived of [false,true])await t.test(archived?'archived historical summary':'full historical record',async t=>{
  let runs=0;
  const f=fixture(t,async()=>{}, {executors:{model:async()=>{runs++;return {};}}});
  const options={target:{request:{mode:'configure',provider:'custom'}},conditionFingerprint:'same-input'};
  const old=await f.controller.start('model',{...options,execute:async()=>{
    throw Object.assign(new Error('old retry block'),{code:'RETRY_CONDITIONS_UNCHANGED'});
  }},'legacy-block');
  const file=path.join(f.directory,'operations',old.operationId,'operation.json');
  const legacy=JSON.parse(fs.readFileSync(file));legacy.attempt=3;
  // Archived summaries retain the retry identity but omit transient target fields.
  if(archived){legacy.archived=true;legacy.target={};}
  fs.writeFileSync(file,JSON.stringify(legacy));const before=fs.readFileSync(file);
  const reopened=createOperationController(f.options);
  const inspected=await reopened.snapshot(old.operationId);
  if(!archived)assert.ok(inspected.allowedActions.includes('configure-model'));
  assert.equal((await reopened.start('model',options,'fresh-form')).state,'succeeded');assert.equal(runs,1);
  assert.deepEqual(fs.readFileSync(file),before);
  });
});

test('model retry exemption does not reopen saved configuration or bypass unknown maintenance effects',async t=>{
  let writes=0;
  const f=fixture(t,async()=>{}, {executors:{model:async context=>{
    writes++;await context.stage('applying');
    throw Object.assign(new Error('configuration already saved'),{code:'MODEL_CONFIG_PARTIAL'});
  }}});
  const options={target:{request:{mode:'configure',provider:'custom'}},conditionFingerprint:'fixed-input'};
  const first=await f.controller.start('model',options,'saved-one');
  assert.ok(!first.allowedActions.includes('configure-model'));
  await f.controller.start('model',options,'saved-two');
  assert.equal((await f.controller.start('model',options,'saved-three')).failureCode,'RETRY_CONDITIONS_UNCHANGED');
  assert.equal(writes,2);
  const uncertain=fixture(t,async context=>{await context.effect('unknown');throw new Error('pending recovery');});
  await uncertain.controller.start('install',{},'pending-install');
  await assert.rejects(uncertain.controller.start('model',{...options,execute:async()=>{writes++;return {}; }},'denied-model'),
    {code:'UPDATE_RECOVERY_REQUIRED'});
  assert.equal(writes,2);
});

test('first condition facts commit before execution and fresh requests keep the failed final-plan baseline',async t=>{
  const proof=value=>({schema:'nora-operation-conditions/1',fingerprint:String(value).repeat(64),facts:{directories:[]}});
  let captures=0,writes=0,authorization=proof(4);
  const f=fixture(t,async context=>{
    const initial=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',context.operationId,'operation.json'),'utf8'));
    assert.equal(initial.conditionBaseline.schema,'nora-operation-conditions/1');
    await context.plan({...context.target,planId:'actual-fixed-content'});
    writes++;throw Object.assign(new Error('owned write denied'),{code:'EACCES',path:'/fixture-private-target'});
  },{captureConditions:async(_record,{lease})=>{lease.assertActive();return proof(++captures);},
    identifyFailureCondition:()=>({kind:'directory-write',directory:'installRoot',raw:'/never-save-raw'}),
    recheckers:{install:async()=>({changed:true,fingerprint:authorization.fingerprint,effectState:'untouched',baseline:authorization})}});
  const target={request:{action:'install'}};
  const first=await f.controller.start('install',{target},'initial-conditions');
  const second=await createOperationController(f.options).start('install',{target},'new-condition-observation');
  const blocked=await createOperationController(f.options).start('install',{target},'third-observation');
  assert.equal(writes,2);assert.equal(blocked.state,'blocked');assert.equal(second.attempt,2);
  assert.deepEqual(blocked.primaryFailure.conditionTarget,{kind:'directory-write',directory:'installRoot'});
  const stored=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',second.operationId,'operation.json'),'utf8'));
  assert.deepEqual(stored.conditionBaseline,proof(1));assert.equal(stored.conditionFingerprint,proof(1).fingerprint);
  assert.deepEqual(stored.primaryFailure.conditionTarget,{kind:'directory-write',directory:'installRoot'});
  assert.equal(JSON.stringify(stored).includes('never-save-raw'),false);
  const checked=await f.controller.recheck(blocked.operationId,{snapshotSequence:blocked.snapshotSequence});
  const authorized=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',blocked.operationId,'operation.json'),'utf8'));
  assert.deepEqual(authorized.conditionBaseline,authorization);assert.equal(checked.attempt,0);
  assert.ok(checked.allowedActions.includes('retry'));
  await f.controller.resume(blocked.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(captures,3);assert.equal(writes,3);
  assert.equal(first.attempt,1);
});

test('an absent legacy condition baseline cannot be replaced by a fresh request observation',async t=>{
  let runs=0;
  const f=fixture(t,async()=>{runs++;throw Object.assign(new Error('original denial'),{code:'EACCES'});});
  const target={version:'legacy-fixed'};
  await f.controller.start('install',{target},'legacy-one');
  await f.controller.start('install',{target},'legacy-two');
  const fresh=createOperationController({...f.options,captureConditions:async()=>({schema:'nora-operation-conditions/1',
    fingerprint:'c'.repeat(64),facts:{directories:[]}})});
  const blocked=await fresh.start('install',{target},'fresh-observation');
  assert.equal(blocked.state,'blocked');assert.equal(runs,2);
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',blocked.operationId,'operation.json'),'utf8'));
  assert.equal(saved.conditionBaseline,undefined);assert.equal(saved.conditionFingerprint,'');
});

test('null condition capture preserves explicit model fingerprints and annotation errors cannot replace the cause',async t=>{
  let runs=0;
  const f=fixture(t,async()=>{}, {captureConditions:async()=>null,identifyFailureCondition:()=>{throw new Error('projection unavailable');},
    executors:{model:async()=>{runs++;throw Object.assign(new Error('actual program cause'),{code:'EACCES'});}}});
  const target={request:{mode:'configure'}};
  await f.controller.start('model',{target,conditionFingerprint:'first-model-input'},'model-condition-one');
  await f.controller.start('model',{target,conditionFingerprint:'second-model-input'},'model-condition-two');
  assert.equal(runs,2);
  assert.equal((await f.controller.snapshot()).primaryFailure.code,'EACCES');
});

test('a successful fixed plan preserves consumed recheck proof when a new request selects that same plan',async t=>{
  const initial={schema:'nora-operation-conditions/1',fingerprint:'a'.repeat(64),facts:{directories:[],networkReads:[]}};
  const consumed={schema:'nora-operation-conditions/1',fingerprint:'b'.repeat(64),facts:{directories:[],networkReads:[{readable:true,identity:'c'.repeat(64),routeHash:'d'.repeat(64)}]}};
  const target={request:{action:'install'}},selected={...target,releasePlan:{schema:'nora-release-plan/1',tag:'v2.4.2',commit:'fixed-content'}};
  let runs=0,finalCapture=0;
  const f=fixture(t,async context=>{
    runs++;await context.plan(selected);
    if(runs===1)throw Object.assign(new Error('original metadata unavailable'),{code:'ETIMEDOUT'});
    if(runs===3){
      const stored=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',context.operationId,'operation.json'),'utf8'));
      assert.deepEqual(stored.conditionBaseline,consumed);
    }
    return {installed:true};
  },{captureConditions:async(_record,context)=>{
    context.lease.assertActive();
    if(context.previous?.conditionBaseline?.facts.networkReads.length){finalCapture++;return consumed;}
    return initial;
  },recheckers:{install:async()=>({changed:true,fingerprint:consumed.fingerprint,baseline:consumed,effectState:'untouched'})}});
  const failed=await f.controller.start('install',{target},'proof-original');
  const checked=await f.controller.recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal((await f.controller.resume(failed.operationId,{snapshotSequence:checked.snapshotSequence})).state,'succeeded');
  const next=await createOperationController(f.options).start('install',{target},'proof-next-request');
  assert.equal(next.state,'succeeded');assert.equal(runs,3);assert.equal(finalCapture,1);
});

test('a reopened admitted operation retains its own verified conditions when the actual executor repeats the same fixed plan',async t=>{
  const initial={schema:'nora-operation-conditions/1',fingerprint:'a'.repeat(64),facts:{directories:[],networkReads:[]}};
  const consumed={schema:'nora-operation-conditions/1',fingerprint:'b'.repeat(64),facts:{directories:[],networkReads:[{identity:'c'.repeat(64),routeHash:'d'.repeat(64),readable:true}]}};
  const target={request:{action:'install'},releasePlan:{schema:'nora-release-plan/1',mode:'install',tag:'v2.4.5',platform:'win32',arch:'x64',commit:'a'.repeat(40)}};
  let runs=0;
  const f=fixture(t,async context=>{
    await context.plan(context.target);runs++;
    throw Object.assign(new Error('original asset unavailable'),{code:'ETIMEDOUT'});
  },{captureConditions:async()=>initial,recheckers:{install:async record=>record.conditionFingerprint===consumed.fingerprint?
    {changed:false}:{changed:true,fingerprint:consumed.fingerprint,baseline:consumed,effectState:'untouched'}}});
  await f.controller.start('install',{target},'fixed-original-one');
  await f.controller.start('install',{target},'fixed-original-two');
  const blocked=await f.controller.start('install',{target},'fixed-admission');
  assert.equal(blocked.state,'blocked');assert.equal(runs,2);
  const checked=await createOperationController(f.options).recheck(blocked.operationId,{snapshotSequence:blocked.snapshotSequence});
  assert.equal(checked.attempt,0);
  const third=await createOperationController(f.options).resume(blocked.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(third.failureCode,'ETIMEDOUT');assert.equal(third.attempt,1);assert.equal(runs,3);
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',third.operationId,'operation.json'),'utf8'));
  assert.deepEqual(saved.conditionBaseline,consumed);assert.equal(saved.verifiedConditions.fingerprint,consumed.fingerprint);
  const fourth=await createOperationController(f.options).resume(third.operationId,{snapshotSequence:third.snapshotSequence});
  assert.equal(fourth.attempt,2);assert.equal(runs,4);
  const fifth=await createOperationController(f.options).start('install',{target},'same-consumed-proof');
  assert.equal(fifth.state,'blocked');assert.equal(runs,4);
  const again=await createOperationController(f.options).recheck(fifth.operationId,{snapshotSequence:fifth.snapshotSequence});
  assert.deepEqual(again.allowedActions,['recheck','logs']);assert.equal(runs,4);
});

test('an admitted proof cannot replace a different fixed target history when the executor selects that target',async t=>{
  const initial={schema:'nora-operation-conditions/1',fingerprint:'a'.repeat(64),facts:{directories:[],networkReads:[]}};
  const consumed={...initial,fingerprint:'b'.repeat(64)};
  const target=commit=>({request:{action:'install'},releasePlan:{schema:'nora-release-plan/1',mode:'install',tag:'v2.4.5',commit}});
  let selected,runs=0;
  const f=fixture(t,async context=>{await context.plan(selected||context.target);runs++;throw Object.assign(new Error('offline'),{code:'ETIMEDOUT'});},
    {captureConditions:async()=>initial,recheckers:{install:async()=>({changed:true,fingerprint:consumed.fingerprint,baseline:consumed,effectState:'untouched'})}});
  for(const [index,commit] of ['a','a','b','b'].entries())await f.controller.start('install',{target:target(commit)},'prior-target-'+index);
  const blocked=await f.controller.start('install',{target:target('a')},'proof-for-original');
  const checked=await f.controller.recheck(blocked.operationId,{snapshotSequence:blocked.snapshotSequence});
  selected=target('b');
  const denied=await createOperationController(f.options).resume(blocked.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(denied.failureCode,'RETRY_CONDITIONS_UNCHANGED');assert.equal(runs,4);
});

test('an accepted legacy record with absent condition fields cannot impersonate a verified fixed-plan proof',async t=>{
  const initial={schema:'nora-operation-conditions/1',fingerprint:'a'.repeat(64),facts:{directories:[],networkReads:[]}};
  const target={request:{action:'install'},releasePlan:{schema:'nora-release-plan/1',mode:'install',tag:'v2.4.5',commit:'fixed-content'}};
  let runs=0;
  const f=fixture(t,async context=>{await context.plan(context.target);runs++;throw Object.assign(new Error('offline'),{code:'ETIMEDOUT'});},
    {captureConditions:async()=>initial});
  await f.controller.start('install',{target},'legacy-prior-one');
  await f.controller.start('install',{target},'legacy-prior-two');
  const blocked=await f.controller.start('install',{target},'legacy-absent-proof');
  const file=path.join(f.directory,'operations',blocked.operationId,'operation.json'),record=JSON.parse(fs.readFileSync(file,'utf8'));
  Object.assign(record,{state:'failed',attempt:0,primaryFailure:{code:'ETIMEDOUT'},currentFailure:{code:'ETIMEDOUT'}});
  delete record.conditionFingerprint;delete record.conditionBaseline;delete record.verifiedConditions;
  fs.writeFileSync(file,JSON.stringify(record));
  const denied=await createOperationController(f.options).resume(blocked.operationId,{snapshotSequence:record.sequence});
  assert.equal(denied.failureCode,'RETRY_CONDITIONS_UNCHANGED');assert.equal(runs,2);
});

test('release recheck identities retain only a fixed public resource and a bounded route fingerprint',async t=>{
  const resource={url:'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.0/system.zip',
    tag:'v2.4.0',asset:'system.zip',size:8192,sha256:'a'.repeat(64),routeHash:'b'.repeat(64)};
  let target={kind:'release-read',resource:{...resource,headers:{authorization:'NEVER_SAVE'}},retryAt:12,rawProxy:'NEVER_SAVE'};
  const f=fixture(t,async()=>{throw Object.assign(new Error('original resource unavailable'),{code:'ETIMEDOUT'});},
    {identifyFailureCondition:()=>target});
  const first=await f.controller.start('install',{},'original-resource');
  assert.deepEqual(first.primaryFailure.conditionTarget,{kind:'release-read',resource,retryAt:12});
  assert.equal(JSON.stringify(first).includes('NEVER_SAVE'),false);
  for(const [index,invalid] of [
    {...resource,url:resource.url+'?token=NEVER_SAVE'},
    {...resource,url:resource.url.replace('github.com','fixture.invalid')},
    {...resource,url:resource.url.replace('noras-tavern','untrusted-repo')},
    {...resource,sha256:''},
  ].entries()){
    target={kind:'release-read',resource:invalid,retryAt:null};
    const result=await f.controller.start('install',{target:{version:String(index)}},'invalid-resource-'+index);
    assert.equal(result.primaryFailure.conditionTarget,undefined);
  }
});

test('metadata retry conditions retain only the official release query and bounded route facts',async t=>{
  const base='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases';
  let target;
  const f=fixture(t,async()=>{throw Object.assign(new Error('original metadata unavailable'),{code:'ETIMEDOUT'});},
    {identifyFailureCondition:()=>target});
  const assets='https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/';
  const allowed=[base+'/latest',base+'/tags/v2.4.2',base+'/tags/v2.5.0-beta.1',base+'?per_page=100&page=5',base+'?per_page=10&page=50',
    assets+'release-manifest.json',assets+'nora-system-win32-x64.json',assets+'nora-launcher-darwin-arm64.json'];
  for(const [index,url] of allowed.entries()){
    const resource={url,routeHash:'c'.repeat(64),...(/\/nora-(?:system|launcher)-/.test(url)?{expectedVersion:'2.0.2'}:{})};
    target={kind:'release-metadata',resource:{...resource,headers:{authorization:'NEVER_SAVE'}},retryAt:null,rawProxy:'NEVER_SAVE'};
    const result=await f.controller.start('install',{target:{version:'metadata-'+index}},'metadata-'+index);
    assert.deepEqual(result.primaryFailure.conditionTarget,{kind:'release-metadata',resource,retryAt:null});
    assert.equal(JSON.stringify(result).includes('NEVER_SAVE'),false);
  }
  const rejected=[base+'/latest?token=NEVER_SAVE',base+'/latest#NEVER_SAVE',base.replace('noras-tavern','other')+'/latest',
    base.replace('api.github.com','fixture.invalid')+'/latest',base+'/tags/not-a-version',base+'?per_page=100&page=6',base+'?per_page=10&page=51',base+'/latest?per_page=100',
    base.replace('https://','https://NEVER_SAVE@')+'/latest',assets+'nora-system-linux-x64.json',assets+'config.json',
    assets+'release-manifest.json?token=NEVER_SAVE',assets.replace('/v2.4.2/','/invalid-tag/')+'release-manifest.json'];
  for(const [index,url] of rejected.entries()){
    target={kind:'release-metadata',resource:{url,routeHash:'c'.repeat(64)},retryAt:null};
    const result=await f.controller.start('install',{target:{version:'bad-metadata-'+index}},'bad-metadata-'+index);
    assert.equal(result.primaryFailure.conditionTarget,undefined);
  }
  for(const [index,expectedVersion] of [undefined,'invalid-version'].entries()){
    target={kind:'release-metadata',resource:{url:assets+'nora-system-win32-x64.json',routeHash:'c'.repeat(64),expectedVersion},retryAt:null};
    const result=await f.controller.start('install',{target:{version:'bad-expected-'+index}},'bad-expected-'+index);
    assert.equal(result.primaryFailure.conditionTarget,undefined);
  }
});

test('fixed system read identities persist without a launcher minimum and reject mixed or misplaced versions',async t=>{
  const asset='https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.5/nora-system-win32-x64.json';
  const resource={url:asset,routeHash:'c'.repeat(64),expectedSystemVersion:'v2.4.5'};
  let condition={kind:'release-metadata',resource,retryAt:null};
  const f=fixture(t,async()=>{throw Object.assign(new Error('system descriptor unavailable'),{code:'ETIMEDOUT'});},
    {identifyFailureCondition:()=>condition});
  const first=await f.controller.start('install',{target:{version:'valid-system'}},'system-proof');
  assert.deepEqual(first.primaryFailure.conditionTarget,condition);
  assert.deepEqual((await createOperationController(f.options).snapshot(first.operationId)).primaryFailure.conditionTarget,condition);
  for(const [index,invalid] of [
    {...resource,expectedSystemVersion:'v2.4.4'}, {...resource,expectedSystemVersion:'invalid'},
    {...resource,expectedVersion:'2.1.1'}, {...resource,url:asset.replace('nora-system','nora-launcher')},
    {...resource,url:asset.replace('nora-system-win32-x64.json','release-manifest.json')},
    {...resource,url:'https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest'},
  ].entries()){
    condition={kind:'release-metadata',resource:invalid,retryAt:null};
    const result=await f.controller.start('install',{target:{version:'invalid-system-'+index}},'invalid-system-'+index);
    assert.equal(result.primaryFailure.conditionTarget,undefined);
  }
});

test('expired confirmed history releases detailed evidence while retaining request idempotency and fixed retry facts',async t=>{
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');
  let clock=Date.parse('2026-01-01T00:00:00Z'),runs=0;
  const f=fixture(t,async()=>{runs++;return {installed:true};},{now:()=>new Date(clock).toISOString(),retention:{detailDays:30,fullRecords:2,facts:8}});
  f.options.evidence=createEvidenceStore({directory:f.directory});f.controller=createOperationController(f.options);
  const first=await f.controller.start('install',{target:{planId:'original-fixed'}},'original-request');
  f.options.evidence.begin({operationId:first.operationId}).finish({delivery:{queued:0,accepted:3,last_ack:clock}});
  const backup=path.join(f.directory,'operations',first.operationId,'backup','user-data');fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,'preserve backup');
  clock+=31*86400000;
  await f.controller.start('install',{target:{planId:'second-fixed'}},'second-request');
  await f.controller.start('install',{target:{planId:'third-fixed'}},'third-request');
  const archived=await createOperationController(f.options).start('install',{target:{planId:'original-fixed'}},'original-request');
  assert.equal(archived.operationId,first.operationId);assert.equal(runs,3);assert.equal(archived.archived,true);
  assert.deepEqual(archived.allowedActions,['logs']);assert.equal(archived.state,'succeeded');assert.deepEqual(archived.result,{installed:true});
  assert.equal(fs.existsSync(path.join(f.directory,'operations',first.operationId,'evidence','metadata.json')),false);
  assert.equal(fs.readFileSync(backup,'utf8'),'preserve backup');
  await assert.rejects(f.controller.resume(first.operationId,{snapshotSequence:archived.snapshotSequence}),{code:'OPERATION_ACTION_UNAVAILABLE'});
});

test('archived failures still enforce the same-target two-attempt limit after reopening',async t=>{
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');let clock=Date.parse('2026-01-01T00:00:00Z'),runs=0;
  const f=fixture(t,async context=>{runs++;if(context.target.planId==='failed-fixed')throw Object.assign(new Error('offline'),{code:'ENOTFOUND'});return {};},
    {now:()=>new Date(clock).toISOString(),retention:{detailDays:30,fullRecords:2,facts:8}});
  f.options.evidence=createEvidenceStore({directory:f.directory});f.controller=createOperationController(f.options);
  const target={planId:'failed-fixed'},one=await f.controller.start('install',{target},'failure-one');clock++;
  const two=await f.controller.start('install',{target},'failure-two');
  for(const record of [one,two])f.options.evidence.begin({operationId:record.operationId}).finish({delivery:{queued:0,accepted:3,last_ack:clock}});
  clock+=31*86400000;await f.controller.start('install',{target:{planId:'other-fixed'}},'anchor');
  const blocked=await createOperationController(f.options).start('install',{target},'failure-three');
  assert.equal(runs,3);assert.equal(blocked.failureCode,'RETRY_CONDITIONS_UNCHANGED');
  assert.equal((await f.controller.snapshot(two.operationId)).archived,true);
  assert.equal((await f.controller.snapshot(two.operationId)).attempt,2);
});

test('same-day confirmed operations compact oldest safe detail at the count budget without blocking ordinary use',async t=>{
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');let runs=0;
  const f=fixture(t,async()=>{runs++;return {};},{now:()=> '2026-01-01T00:00:00Z',retention:{detailDays:30,fullRecords:2,facts:8}});
  f.options.evidence=createEvidenceStore({directory:f.directory});f.controller=createOperationController(f.options);
  const first=await f.controller.start('install',{target:{planId:'first'}},'first');
  f.options.evidence.updateDelivery(first.operationId,{queued:0,accepted:3,last_ack:1});
  const second=await f.controller.start('install',{target:{planId:'second'}},'second');
  f.options.evidence.updateDelivery(second.operationId,{queued:0,accepted:3,last_ack:2});
  const third=await f.controller.start('install',{target:{planId:'third'}},'third');
  assert.equal(third.state,'succeeded');assert.equal(runs,3);assert.equal((await f.controller.snapshot(first.operationId)).archived,true);
  assert.equal((await f.controller.snapshot(second.operationId)).archived,false);
});

test('pending ACK protects old evidence and backups; full history blocks new work while a reserved stop remains available',async t=>{
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');let clock=Date.parse('2026-01-01T00:00:00Z'),runs=0,stops=0;
  const f=fixture(t,async()=>{runs++;return {};},{now:()=>new Date(clock).toISOString(),retention:{detailDays:30,fullRecords:2,facts:8}});
  f.options.evidence=createEvidenceStore({directory:f.directory});f.options.executors.stop=async()=>{stops++;return {stopped:true};};f.controller=createOperationController(f.options);
  const first=await f.controller.start('install',{target:{planId:'first'}},'pending-first');
  const state=f.options.evidence.begin({operationId:first.operationId});state.freeze({error:new Error('retain reviewed details'),delivery:{queued:1,accepted:0,last_ack:null}});
  const before=fs.readFileSync(path.join(state.directory,'metadata.json'));
  clock+=31*86400000;await f.controller.start('install',{target:{planId:'second'}},'second');
  await assert.rejects(f.controller.start('install',{target:{planId:'third'}},'third'),{code:'OPERATION_HISTORY_CAPACITY'});
  assert.equal(runs,2);assert.equal((await f.controller.snapshot(first.operationId)).archived,false);
  assert.deepEqual(fs.readFileSync(path.join(state.directory,'metadata.json')),before);
  assert.equal((await f.controller.start('stop',{target:{request:{service:'all'}}},'safe-stop')).state,'succeeded');assert.equal(stops,1);
});

test('history capacity preserves original continuation and cross-controller commits invalidate cached admission facts',async t=>{
  let runs=0;const f=fixture(t,async context=>{runs++;if(context.target.planId==='first'&&runs===1)throw new Error('first failure');return {};},
    {retention:{fullRecords:2,facts:2,stopReserve:0}});
  const first=await f.controller.start('install',{target:{planId:'first'}},'first');
  await createOperationController(f.options).start('install',{target:{planId:'second'}},'second');
  await assert.rejects(f.controller.start('install',{target:{planId:'third'}},'third'),{code:'OPERATION_HISTORY_CAPACITY'});
  const resumed=await f.controller.resume(first.operationId,{snapshotSequence:first.snapshotSequence});
  assert.equal(resumed.operationId,first.operationId);assert.equal(resumed.state,'succeeded');assert.equal(runs,3);
  assert.equal((await f.controller.start('install',{target:{planId:'second'}},'second')).state,'succeeded');assert.equal(runs,3);
});

test('snapshot is read-only and nonterminal history alone does not imply active effects', async t => {
  const f=fixture(t,async()=>({installed:true}));
  const finished=await f.controller.start('install',{target:{planId:'fixed'}},'one');
  const file=path.join(f.directory,'operations',finished.operationId,'operation.json');
  const record=JSON.parse(fs.readFileSync(file));record.state='applying';record.effectState='untouched';fs.writeFileSync(file,JSON.stringify(record));
  const before=fs.readFileSync(file);
  const snapshot=await createOperationController(f.options).snapshot(finished.operationId);
  assert.equal(snapshot.state,'interrupted');
  assert.equal(snapshot.effectState,'untouched');
  assert.deepEqual(snapshot.allowedActions,['resume','recheck','logs']);
  assert.deepEqual(fs.readFileSync(file),before);
});

test('late events from a former epoch cannot advance the current operation', async t => {
  let oldContext;
  const f=fixture(t,async context=>{oldContext=context;return {};});
  const result=await f.controller.start('install',{},'one');
  await assert.rejects(oldContext.stage('applying'),{code:'OPERATION_STALE_EVENT'});
  assert.equal((await f.controller.snapshot(result.operationId)).state,'succeeded');
});
test('a selected release is immutable and survives a duplicate original request',async t=>{
  const selected={planId:'release-one',tag:'v2.4.2'};
  const f=fixture(t,async context=>{
    await context.plan(selected);
    await assert.rejects(context.plan({...selected,tag:'v2.4.3'}),{code:'OPERATION_PLAN_CHANGED'});
    return {installed:true};
  });
  const first=await f.controller.start('install',{target:{requested:'latest'}},'select-one');
  const reopened=await createOperationController(f.options).start('install',{target:{requested:'latest'}},'select-one');
  assert.deepEqual(reopened.target,selected);
  assert.equal(reopened.planDigest,first.planDigest);
});
test('a recheck grants another attempt only after the backend verifies changed conditions',async t=>{
  let available=false,runs=0;
  const f=fixture(t,async()=>{runs++;if(!available)throw Object.assign(new Error('offline'),{code:'ENOTFOUND'});return {installed:true};},
    {recheckers:{install:async()=>({changed:available,fingerprint:available?'network-verified':'network-original',effectState:'untouched'})}});
  await f.controller.start('install',{},'first');
  const second=await f.controller.start('install',{},'second');
  const unchanged=await f.controller.recheck(second.operationId);
  assert.deepEqual(unchanged.allowedActions,['recheck','logs']);
  available=true;
  const checked=await createOperationController(f.options).recheck(second.operationId);
  assert.ok(checked.allowedActions.includes('retry'));
  const succeeded=await f.controller.resume(second.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(succeeded.state,'succeeded');
  assert.equal(succeeded.failureCode,'');
  assert.equal(runs,3);
  assert.equal(succeeded.totalAttempts,2);
});
test('a returned object without workflow verification cannot be marked successful',async t=>{
  const f=fixture(t,async()=>({installed:true}),{verifyResult:result=>result?.verification==='confirmed'});
  const result=await f.controller.start('install',{},'unverified');
  assert.equal(result.state,'failed');
  assert.equal(result.failureCode,'VERIFICATION_FAILED');
  assert.equal(result.verification,'unconfirmed');
});
test('a failed guard release preserves the primary cause and requires inspection',async t=>{
  const primary=Object.assign(new Error('startup failed'),{code:'TAVERN_PROCESS_EXITED'});
  const base=createTestOperationLock();let acquisitions=0;
  const lock={probe:base.probe,acquire:async options=>{const lease=await base.acquire(options);if(++acquisitions!==1)return lease;
    return {...lease,release:async()=>{await lease.release();throw Object.assign(new Error('guard lost'),{code:'LOCK_GUARD_LOST'});}};}};
  const f=fixture(t,async()=>{throw primary;},{lock});
  const result=await f.controller.start('install',{},'lost');
  assert.equal(result.primaryFailure.code,'TAVERN_PROCESS_EXITED');
  assert.equal(result.secondaryFailures[0].code,'LOCK_GUARD_LOST');
  assert.equal(result.effectState,'unknown');
  assert.deepEqual(result.allowedActions,['recover','recheck','logs']);
});

test('a failed native release cannot overwrite a successor epoch or its saved evidence', {timeout:15000}, async t=>{
  const native=require('../installer/desktop/operation-lock');
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-release-successor-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const evidence=createEvidenceStore({directory});
  let acquisitions=0,takeover,committedRecord,committedEvidence;
  const rival=createOperationController({directory,lock:native,evidence,
    recoverers:{update:async()=>({verification:'confirmed',effectState:'restored'})}});
  const lock={probe:native.probe,acquire:async options=>{
    const lease=await native.acquire(options);
    if(++acquisitions!==1)return lease;
    return {...lease,release:async()=>{
      // Trigger a real nonzero guard exit after its native lock is released.
      fs.rmSync(path.join(directory,'operations','.guards'),{recursive:true,force:true});
      try{await lease.release();}
      catch(error){
        // Deliver the old window's release error after another window recovers.
        takeover=await rival.recover(options.operationId);
        const root=path.join(directory,'operations',options.operationId);
        committedRecord=fs.readFileSync(path.join(root,'operation.json'));
        committedEvidence=fs.readFileSync(path.join(root,'evidence','metadata.json'));
        throw error;
      }
    }};
  }};
  const old=createOperationController({directory,lock,evidence,executors:{update:async context=>{
    await context.effect('changed');throw Object.assign(new Error('apply failed'),{code:'APPLY_FAILED'});
  }}});
  const result=await old.start('update',{},'release-successor');
  const root=path.join(directory,'operations',result.operationId);
  assert.equal(takeover.state,'rolled-back');assert.equal(takeover.effectState,'restored');
  assert.ok(takeover.ownerEpoch>result.ownerEpoch);
  assert.ok(fs.readFileSync(path.join(root,'operation.json')).equals(committedRecord),'successor record must remain byte-identical');
  assert.ok(fs.readFileSync(path.join(root,'evidence','metadata.json')).equals(committedEvidence),'successor evidence must remain byte-identical');
  assert.equal(result.state,'failed');assert.equal(result.currentFailure.code,'LOCK_GUARD_EXITED');
  assert.deepEqual(result.allowedActions,['recheck','logs']);
  assert.ok(result.evidenceMissingReasons.includes('release_failure_unpersisted:OWNER_CHANGED'));
});

test('release failure leaves files unchanged while the original native guard still owns the writer', {timeout:15000}, async t=>{
  const native=require('../installer/desktop/operation-lock');
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-release-still-held-'));
  let original,acquisitions=0,beforeRecord,beforeEvidence;
  t.after(async()=>{if(original)await original.release();fs.rmSync(directory,{recursive:true,force:true});});
  const evidence=createEvidenceStore({directory});
  const lock={probe:native.probe,acquire:async options=>{
    const lease=await native.acquire(options);acquisitions++;
    original=lease;
    return {...lease,release:async()=>{
      const root=path.join(directory,'operations',options.operationId);
      beforeRecord=fs.readFileSync(path.join(root,'operation.json'));
      beforeEvidence=fs.readFileSync(path.join(root,'evidence','metadata.json'));
      throw Object.assign(new Error('release acknowledgement lost'),{code:'LOCK_GUARD_LOST'});
    }};
  }};
  const controller=createOperationController({directory,lock,evidence,verifyResult:()=>true,executors:{install:async()=>({})}});
  const result=await controller.start('install',{},'release-still-held');
  const root=path.join(directory,'operations',result.operationId);
  assert.equal((await native.probe({directory})).busy,true);assert.equal(acquisitions,1);
  assert.ok(fs.readFileSync(path.join(root,'operation.json')).equals(beforeRecord),'held writer record must remain byte-identical');
  assert.ok(fs.readFileSync(path.join(root,'evidence','metadata.json')).equals(beforeEvidence),'held writer evidence must remain byte-identical');
  assert.equal(result.state,'failed');assert.equal(result.currentFailure.code,'LOCK_GUARD_LOST');
  assert.deepEqual(result.allowedActions,['recheck','logs']);
  assert.ok(result.evidenceMissingReasons.includes('release_failure_unpersisted:WRITER_UNAVAILABLE'));
});

test('release failure is durably recorded only under a new native lease with the unchanged epoch', {timeout:15000}, async t=>{
  const native=require('../installer/desktop/operation-lock');
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-release-same-epoch-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const evidence=createEvidenceStore({directory});
  let acquisitions=0,oldEpoch;
  const lock={probe:native.probe,acquire:async options=>{
    const lease=await native.acquire(options);acquisitions++;
    if(acquisitions!==1){assert.equal((await native.probe({directory})).busy,true);return lease;}
    oldEpoch=options.ownerEpoch;
    return {...lease,release:async()=>{
      fs.rmSync(path.join(directory,'operations','.guards'),{recursive:true,force:true});
      await lease.release();
    }};
  }};
  const controller=createOperationController({directory,lock,evidence,verifyResult:()=>true,executors:{install:async()=>({})}});
  const result=await controller.start('install',{},'release-same-epoch');
  const root=path.join(directory,'operations',result.operationId);
  const record=JSON.parse(fs.readFileSync(path.join(root,'operation.json')));
  assert.equal(acquisitions,2);assert.equal(record.ownerEpoch,oldEpoch);
  assert.equal(record.state,'failed');assert.equal(record.effectState,'unknown');
  assert.equal(record.currentFailure.code,'LOCK_GUARD_EXITED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'evidence','metadata.json'))).primary.code,'LOCK_GUARD_EXITED');
  assert.equal((await native.probe({directory})).busy,false);assert.equal(result.state,'failed');
});

test('a lost guard cannot let the ordinary executor catch overwrite a recovered successor', {timeout:15000}, async t=>{
  const native=require('../installer/desktop/operation-lock');
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-executor-successor-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const evidence=createEvidenceStore({directory});let takeover,successorRecord,successorEvidence;
  const rival=createOperationController({directory,lock:native,evidence,
    observeEffects:async()=>({effectState:'changed',recoveryOutcome:'recovery-required',canRecover:true}),
    recoverers:{update:async()=>({verification:'confirmed',effectState:'restored'})}});
  const old=createOperationController({directory,lock:native,evidence,executors:{update:async context=>{
    await context.effect('changed');const guard=await context.lease.snapshot();
    process.kill(guard.guardPid,'SIGKILL');try{await context.lease.release();}catch{}
    assert.throws(()=>context.check(),{code:'LOCK_GUARD_LOST'});
    takeover=await rival.recover(context.operationId);
    const root=path.join(directory,'operations',context.operationId);
    successorRecord=fs.readFileSync(path.join(root,'operation.json'));successorEvidence=fs.readFileSync(path.join(root,'evidence','metadata.json'));
    assert.throws(()=>context.check(),{code:'OPERATION_STALE_EVENT'});
    throw Object.assign(new Error('executor reported guard loss'),{code:'LOCK_GUARD_LOST'});
  }}});
  const result=await old.start('update',{},'executor-successor'),root=path.join(directory,'operations',result.operationId);
  assert.equal(takeover.state,'rolled-back');assert.ok(takeover.ownerEpoch>result.ownerEpoch);
  assert.ok(fs.readFileSync(path.join(root,'operation.json')).equals(successorRecord));
  assert.ok(fs.readFileSync(path.join(root,'evidence','metadata.json')).equals(successorEvidence));
  assert.equal(result.state,'failed');assert.deepEqual(result.allowedActions,['recheck','logs']);
});

async function closeCommitFaultFixture({directory,marker,prior,native,acquiredLease,guardPid,running,settlementMs=5000}){
    let closed=false;
    try{
      // A timeout can leave the fixture guard paused inside the rename hook.
      // Unblock that hook before asking its existing lease to close.
      fs.writeFileSync(marker+'.resume','resume');
      if(acquiredLease){
        try{await acquiredLease.cancel({signal:'SIGKILL'});}catch(error){if(error.code!=='LOCK_GUARD_EXITED')throw error;}
        try{await acquiredLease.release();}catch(error){if(error.code!=='LOCK_GUARD_EXITED')throw error;}
      }
      if(running){
        let settlementTimer;
        try{
          await Promise.race([running.catch(()=>{}),new Promise((_,reject)=>{
            settlementTimer=setTimeout(()=>reject(Object.assign(new Error(`Fixture operation did not settle within ${settlementMs} ms; its root was preserved`),
              {code:'FIXTURE_OPERATION_SETTLEMENT_TIMEOUT'})),settlementMs);
          })]);
        }finally{clearTimeout(settlementTimer);}
      }
      const deadline=Date.now()+5000;
      while(guardPid){
        try{process.kill(guardPid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}
        if(Date.now()>deadline)throw new Error('Fixture guard did not close; its root was preserved');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal((await native.probe({directory})).busy,false,'Fixture guards must close before removing their root');
      closed=true;
    }finally{
      for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;
      if(closed)fs.rmSync(directory,{recursive:true,force:true});
    }
}

test('CAS fault cleanup bounds an unsettled operation, restores its environment and preserves its root',{timeout:2000},async t=>{
  const native=require('../installer/desktop/operation-lock');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-commit-unsettled-')),marker=path.join(directory,'commit-marker');
  const prior={NODE_OPTIONS:process.env.NODE_OPTIONS,NORA_TEST_COMMIT_FAULT_MARKER:process.env.NORA_TEST_COMMIT_FAULT_MARKER,NORA_TEST_COMMIT_FAULT_PHASE:process.env.NORA_TEST_COMMIT_FAULT_PHASE};
  t.after(()=>{for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;
    fs.rmSync(directory,{recursive:true,force:true});});
  const sentinel=path.join(directory,'preserved');fs.writeFileSync(sentinel,'original fixture bytes');
  process.env.NODE_OPTIONS='--trace-warnings';process.env.NORA_TEST_COMMIT_FAULT_MARKER=marker;process.env.NORA_TEST_COMMIT_FAULT_PHASE='before';
  let deadline;
  try{
    await assert.rejects(Promise.race([
      closeCommitFaultFixture({directory,marker,prior,native,running:new Promise(()=>{}),settlementMs:50}),
      new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Object.assign(new Error('Fixture cleanup did not enforce its settlement budget'),
        {code:'FIXTURE_TEST_SETTLEMENT_DEADLINE'})),500);})]),{code:'FIXTURE_OPERATION_SETTLEMENT_TIMEOUT'});
  }finally{clearTimeout(deadline);}
  for(const [key,value]of Object.entries(prior))assert.equal(process.env[key],value,'Cleanup must restore '+key);
  assert.equal(fs.readFileSync(marker+'.resume','utf8'),'resume');
  assert.equal(fs.readFileSync(sentinel,'utf8'),'original fixture bytes','Unsettled fixture roots must remain available for inspection');
});

for(const phase of ['before','after'])test(`native CAS commit survives guard death ${phase} record rename without a stale overwrite`, {timeout:20000}, async t=>{
  const native=require('../installer/desktop/operation-lock');
  const {createEvidenceStore}=require('../installer/desktop/evidence-store');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),`nora-commit-${phase}-`)),marker=path.join(directory,'commit-marker'),preload=path.join(directory,'fault-preload.cjs');
  const prior={NODE_OPTIONS:process.env.NODE_OPTIONS,NORA_TEST_COMMIT_FAULT_MARKER:process.env.NORA_TEST_COMMIT_FAULT_MARKER,NORA_TEST_COMMIT_FAULT_PHASE:process.env.NORA_TEST_COMMIT_FAULT_PHASE};
  let acquiredLease,guardPid,running;
  t.after(()=>closeCommitFaultFixture({directory,marker,prior,native,acquiredLease,guardPid,running}));
  // This preloader instruments only a fixture guard's synchronous record rename.
  // It creates a real lock-held window on either side of the actual syscall.
  fs.writeFileSync(preload,`const fs=require('node:fs'),path=require('node:path');
const rename=fs.renameSync,marker=process.env.NORA_TEST_COMMIT_FAULT_MARKER,phase=process.env.NORA_TEST_COMMIT_FAULT_PHASE;let stopped=false;
fs.renameSync=(source,target)=>{let record;
 if(!stopped&&marker&&path.basename(target)==='operation.json'){try{record=JSON.parse(fs.readFileSync(source,'utf8'));}catch{}}
 if(record?.requestId==='commit-fault'&&record.state==='applying'&&record.stageId==='applying'){
  stopped=true;if(phase==='after')rename(source,target);fs.writeFileSync(marker,'ready');
  while(!fs.existsSync(marker+'.resume'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  if(phase==='before')rename(source,target);return;
 }return rename(source,target);
};`);
  process.env.NODE_OPTIONS=`${prior.NODE_OPTIONS||''} --require=${JSON.stringify(preload)}`;
  process.env.NORA_TEST_COMMIT_FAULT_MARKER=marker;process.env.NORA_TEST_COMMIT_FAULT_PHASE=phase;
  const evidence=createEvidenceStore({directory});let takeover,successorRecord,successorEvidence;
  const rival=createOperationController({directory,lock:native,evidence,
    observeEffects:async()=>({effectState:'changed',recoveryOutcome:'recovery-required',canRecover:true}),
    recoverers:{update:async()=>({verification:'confirmed',effectState:'restored'})}});
  const old=createOperationController({directory,lock:native,evidence,executors:{update:async context=>{
    acquiredLease=context.lease;
    await context.effect('changed');const guard=await context.lease.snapshot();
    guardPid=guard.guardPid;
    const applying=context.stage('applying');applying.catch(()=>{});
    const deadline=Date.now()+5000;while(!fs.existsSync(marker)){if(Date.now()>deadline)throw new Error('Guard did not reach the rename window');await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal((await native.probe({directory})).busy,true);
    process.kill(guard.guardPid,'SIGKILL');let commitError;
    try{await applying;}catch(error){commitError=error;}assert.equal(commitError.code,'LOCK_GUARD_EXITED');
    takeover=await rival.recover(context.operationId);
    const root=path.join(directory,'operations',context.operationId);
    successorRecord=fs.readFileSync(path.join(root,'operation.json'));successorEvidence=fs.readFileSync(path.join(root,'evidence','metadata.json'));
    throw commitError;
  }}});
  const result=await(running=old.start('update',{},'commit-fault')),root=path.join(directory,'operations',result.operationId);
  assert.equal(takeover.state,'rolled-back');assert.ok(takeover.ownerEpoch>result.ownerEpoch);
  assert.ok(fs.readFileSync(path.join(root,'operation.json')).equals(successorRecord));
  assert.ok(fs.readFileSync(path.join(root,'evidence','metadata.json')).equals(successorEvidence));
  assert.equal(result.state,'failed');assert.equal((await native.probe({directory})).busy,false);
});

test('failure reporting cannot mask the first cause or bypass recovery',async t=>{
  let recovered=false;
  const f=fixture(t,async context=>{await context.effect('changed');throw Object.assign(new Error('program failure'),{code:'TAVERN_PROCESS_EXITED'});},
    {recoverers:{install:async()=>{recovered=true;return {verification:'confirmed'};}}});
  const result=await f.controller.start('install',{onFailure:async()=>{throw Object.assign(new Error('no disk'),{code:'ENOSPC'});}},'report-failure');
  assert.equal(recovered,true);
  assert.equal(result.primaryFailure.code,'TAVERN_PROCESS_EXITED');
  assert.equal(result.secondaryFailures[0].code,'ENOSPC');
  assert.equal(result.recoveryOutcome,'restored-and-verified');
});

test('a recovery object without file and service proof cannot be marked restored',async t=>{
  const f=fixture(t,async context=>{await context.effect('changed');throw new Error('failed');},
    {verifyResult:result=>result?.verification==='confirmed',recoverers:{install:async()=>({restored:true})}});
  const result=await f.controller.start('install',{},'recover-unverified');
  assert.equal(result.recoveryOutcome,'recovery-required');
  assert.equal(result.secondaryFailures[0].code,'VERIFICATION_FAILED');
});

test('explicit recovery closes an old failed record after actual effects were already restored',async t=>{
  let restored=false,recoveries=0,applies=0;
  const facts=()=>restored?{effectState:'restored',recoveryOutcome:'restored-and-verified',canRecover:false}
    :{effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false};
  const f=fixture(t,async context=>{
    applies++;await context.effect('unknown');
    throw Object.assign(new Error('Original verifier unavailable'),{code:'VERIFICATION_FAILED'});
  },{observeEffects:async()=>facts(),verifyResult:result=>result?.verification==='confirmed',
    recoverers:{install:async context=>{
      context.check();recoveries++;
      if(!restored)throw new Error('World reader unavailable during initial recovery');
      // The explicit recovery still owns the writer and independently verifies
      // real state; observing restored facts alone never commits a terminal.
      assert.equal(context.snapshot.state,'recovering');
      return {effectState:'restored',verification:'confirmed',value:{recoveryVerification:'confirmed',version:'2.4.2'}};
    }}});
  const failed=await f.controller.start('install',{},'restore-closed-later');
  assert.equal(failed.state,'failed');assert.equal(failed.effectState,'unknown');
  assert.equal(failed.recoveryOutcome,'recovery-required');
  const file=path.join(f.directory,'operations',failed.operationId,'operation.json'),bytes=fs.readFileSync(file);
  restored=true;
  const reader=createOperationController(f.options),before=await reader.snapshot(failed.operationId);
  assert.equal(before.state,'interrupted');assert.equal(before.effectState,'restored');
  assert.ok(before.allowedActions.includes('recover'));
  assert.deepEqual(fs.readFileSync(file),bytes,'status cannot close the old task by itself');
  const closed=await reader.recover(failed.operationId,{snapshotSequence:before.snapshotSequence});
  assert.equal(closed.operationId,failed.operationId);assert.equal(closed.state,'rolled-back');
  assert.equal(closed.verification,'confirmed');assert.equal(closed.recoveryOutcome,'restored-and-verified');
  assert.equal(closed.primaryFailure.code,'VERIFICATION_FAILED');assert.equal(applies,1);assert.equal(recoveries,2);
  assert.equal((await createOperationController(f.options).snapshot()).state,'rolled-back');
  assert.equal((await reader.start('start',{execute:async()=>({verification:'confirmed'})},'after-restored-closure')).state,'succeeded');
});

test('verified file-only recovery offers starting the restored program, rather than repeating the update',async t=>{
  const f=fixture(t,async context=>{await context.effect('changed');throw new Error('failed');},
    {recoverers:{install:async()=>({filesRestored:true,verification:'failed'})}});
  const result=await f.controller.start('install',{},'recover-files-only');
  assert.equal(result.recoveryOutcome,'files-restored-start-failed');
  assert.equal(result.verification,'failed');
  assert.deepEqual(result.allowedActions,['start-restored','recheck','logs']);
});

test('automatic file-only rollback persists its original service plan for explicit recovery of the same core and target',async t=>{
  let applies=0,recoveries=0;
  const target={releasePlan:{planId:'fixed-release-core',tag:'v2.4.3'},request:{port:8799}};
  const servicePlan={running:true,gatewayRunning:false},restoredValue={recoveryServiceState:servicePlan,restoreVersion:'2.4.2',core:'original-core'};
  const f=fixture(t,async context=>{applies++;await context.effect('changed');throw Object.assign(new Error('apply denied'),{code:'EPERM'});},
    {projectResult:result=>result.value,recoverers:{install:async context=>{
      recoveries++;assert.deepEqual(context.target,target);
      if(recoveries===1)return {filesRestored:true,verification:'failed',value:restoredValue};
      assert.deepEqual(context.snapshot.result,restoredValue);
      return {verification:'confirmed',effectState:'restored',value:{...restoredValue,recoveryVerification:'confirmed'}};
    }}});
  const failed=await f.controller.start('install',{target},'same-core-rollback');
  assert.equal(failed.recoveryOutcome,'files-restored-start-failed');assert.deepEqual(failed.result,restoredValue);
  const recovered=await createOperationController(f.options).recover(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(recovered.operationId,failed.operationId);assert.deepEqual(recovered.target,target);
  assert.deepEqual(recovered.result.recoveryServiceState,servicePlan);assert.equal(recovered.result.core,'original-core');
  assert.equal(recovered.primaryFailure.code,'EPERM');assert.equal(recovered.currentFailure,null);
  assert.equal(recovered.recoveryOutcome,'restored-and-verified');assert.equal(applies,1);assert.equal(recoveries,2);
});

for(const failure of ['read','ack'])test(`a continuation admission ${failure} failure closes its actual native guard before returning`,{timeout:15000},async t=>{
  const native=require('../installer/desktop/operation-lock');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),`nora-continuation-${failure}-`));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let applies=0,admitted;
  const first=createOperationController({directory,lock:native,executors:{install:async()=>{applies++;throw Object.assign(new Error('original failed'),{code:'EPERM'});}}});
  const failed=await first.start('install',{},`initial-${failure}`);
  const lock={probe:native.probe,acquire:async options=>{
    const lease=await native.acquire(options);admitted=lease;
    if(failure==='read'){fs.writeFileSync(path.join(directory,'operations',options.operationId,'operation.json'),'{invalid');return lease;}
    return {...lease,commitOperation:async value=>{await lease.commitOperation(value);throw Object.assign(new Error('fixture ACK failure'),{code:'COMMIT_ACK_FAILED'});}};
  }};
  const reopened=createOperationController({directory,lock,executors:{install:async()=>{applies++;return {verification:'confirmed'};}}});
  await assert.rejects(reopened.resume(failed.operationId,{snapshotSequence:failed.snapshotSequence}),failure==='read'?SyntaxError:{code:'COMMIT_ACK_FAILED'});
  assert.equal((await native.probe({directory})).busy,false);assert.equal(applies,1);
  assert.throws(()=>admitted.assertActive(),{code:'LOCK_GUARD_LOST'});
});

test('a fresh explicit recovery can restore only files without claiming success or repeating recovery on failure',async t=>{
  let autoRecoveries=0;
  const f=fixture(t,async()=>{}, {executors:{recover:async()=>({filesRestored:true,verification:'failed',
    value:{legacyFilesRestored:true,restoreVersion:'2.4.2'}})},projectResult:result=>result.value,
    recoverers:{recover:async()=>{autoRecoveries++;throw new Error('must not repeat');}}});
  const partial=await f.controller.start('recover',{},'explicit-recovery');
  assert.equal(partial.state,'rolled-back');assert.equal(partial.verification,'failed');
  assert.equal(partial.recoveryOutcome,'files-restored-start-failed');
  assert.equal(partial.result.legacyFilesRestored,true);assert.equal(autoRecoveries,0);
  f.options.recoverers.recover=async()=>{throw new Error('restored service failed');};
  const failed=await createOperationController(f.options).recover(partial.operationId,{snapshotSequence:partial.snapshotSequence});
  assert.equal(failed.state,'failed');assert.equal(autoRecoveries,0);
  assert.equal(failed.recoveryOutcome,'files-restored-start-failed');
  const second=await createOperationController(f.options).recover(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.deepEqual(second.allowedActions,['recheck','logs']);
});

test('restarting restored files is bounded and a recheck cannot silently permit another update',async t=>{
  let starts=0,changed=false;
  const f=fixture(t,async context=>{await context.effect('changed');throw new Error('update failed');},
    {recoverers:{install:async()=>{starts++;return {filesRestored:true,verification:'failed'};}},
      recheckers:{install:async()=>({changed,fingerprint:'healthy-new-condition',effectState:'restored'})}});
  const failed=await f.controller.start('install',{},'file-recovery');
  const first=await f.controller.recover(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  const second=await f.controller.recover(first.operationId,{snapshotSequence:first.snapshotSequence});
  assert.equal(starts,3); // automatic file restoration, then two service attempts
  assert.deepEqual(second.allowedActions,['recheck','logs']);
  await assert.rejects(f.controller.recover(second.operationId,{snapshotSequence:second.snapshotSequence}),{code:'OPERATION_ACTION_UNAVAILABLE'});
  changed=true;const checked=await f.controller.recheck(second.operationId,{snapshotSequence:second.snapshotSequence});
  assert.equal(checked.recoveryOutcome,'files-restored-start-failed');
  assert.ok(checked.allowedActions.includes('start-restored'));assert.equal(checked.allowedActions.includes('retry'),false);
});

test('a new update cannot bypass a pending restored runtime or a file-only recovery',async t=>{
  for(const recoveryOutcome of ['recovery-required','files-restored-start-failed']){
    let runs=0;
    const f=fixture(t,async context=>{runs++;await context.effect('changed');throw new Error('first install failed');},
      {recoverers:{install:async()=>({filesRestored:true,verification:'failed'})},
        observeEffects:async()=>({effectState:'restored',recoveryOutcome,canRecover:true})});
    await f.controller.start('install',{},'pending-restoration');
    await assert.rejects(createOperationController(f.options).start('install',{target:{different:true}},'new-target'),
      {code:'UPDATE_RECOVERY_REQUIRED'});
    assert.equal(runs,1);
  }
});

test('a new writer resumes a durable handoff only with matching trusted proof and the original plan',async t=>{
  let runs=0;
  const f=fixture(t,async context=>{
    runs++;
    if(runs===1){await context.plan({release:'fixed'});await context.handoff('/trusted/job');return {handoff:true};}
    assert.deepEqual(context.target,{release:'fixed'});return {verification:'confirmed'};
  },{verifyHandoff:async(record,proof)=>record.planDigest===proof.planDigest&&record.handoffRef===proof.job});
  const handed=await f.controller.start('install',{},'handoff');
  assert.equal(handed.state,'awaiting-handoff');
  await assert.rejects(f.controller.resume(handed.operationId,{handoff:{job:'/other',planDigest:handed.planDigest}}),{code:'OPERATION_ACTION_UNAVAILABLE'});
  const resumed=await createOperationController(f.options).resume(handed.operationId,{snapshotSequence:handed.snapshotSequence,
    handoff:{job:handed.handoffRef,planDigest:handed.planDigest}});
  assert.equal(resumed.operationId,handed.operationId);
  assert.equal(resumed.state,'succeeded');
  assert.equal(resumed.planDigest,handed.planDigest);
});

test('new metadata lookup times and GitHub counters cannot bypass the same-content retry limit',async t=>{
  let writes=0;
  const f=fixture(t,async(context,options)=>{
    const number=options.number;
    await context.plan({request:{action:'update'},releasePlan:{schema:'nora-release-plan/1',mode:'update',tag:'v2.4.2',
      channel:'stable',platform:'darwin',arch:'arm64',commit:'fixed',releaseManifest:{versions:{tavern:'2.4.2'},files:{sha:'fixed'}},
      checkedAt:`time-${number}`,planId:`plan-${number}`,release:{download_count:number}}});
    writes++;throw new Error('same code failed');
  });
  await f.controller.start('install',{number:1},'content-first');
  await f.controller.start('install',{number:2},'content-second');
  const blocked=await f.controller.start('install',{number:3},'content-third');
  assert.equal(writes,2);
  assert.equal(blocked.state,'blocked');
});

test('an owned safe stop remains available while unresolved file effects block another installation',async t=>{
  let stopped=0;
  const f=fixture(t,async context=>{await context.effect('changed');throw new Error('interrupted update');},
    {observeEffects:async()=>({effectState:'unknown',canRecover:false}),
      executors:{install:async context=>{await context.effect('changed');throw new Error('failed');},
        shutdown:async()=>{stopped++;return {verification:'confirmed'};}}});
  const original=await f.controller.start('install',{},'unsafe-tree');
  await assert.rejects(f.controller.start('install',{},'another-install'),{code:'UPDATE_RECOVERY_REQUIRED'});
  const result=await f.controller.start('shutdown',{},'safe-stop');
  assert.equal(result.state,'succeeded');assert.equal(stopped,1);
  assert.equal((await f.controller.snapshot()).operationId,original.operationId);
});

test('unsupported operation file size and symlink records block admission and preserve both files',async t=>{
  const f=fixture(t,async()=>({verification:'confirmed'}));
  const first=await f.controller.start('install',{},'record-integrity');
  const file=path.join(f.directory,'operations',first.operationId,'operation.json');
  const original=fs.readFileSync(file);
  fs.writeFileSync(file,Buffer.alloc(256*1024+1));
  await assert.rejects(f.controller.snapshot(first.operationId),{code:'OPERATION_RECORD_INVALID'});
  assert.equal(fs.statSync(file).size,256*1024+1);
  fs.rmSync(file);const outside=path.join(f.directory,'preserved.json');fs.writeFileSync(outside,original);
  fs.symlinkSync(outside,file);
  await assert.rejects(f.controller.start('install',{},'follow-symlink'),{code:'OPERATION_RECORD_INVALID'});
  assert.deepEqual(fs.readFileSync(outside),original);assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
});
