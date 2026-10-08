const test=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../installer/desktop/system-update-executor');
const operationId='df489037-5361-4b6a-b02a-8c6cf6cb256e';
const fixture=()=>({operationId,target:{releasePlan:{releaseManifest:{versions:{tavern:'2.4.0'}}}},
  snapshot:{handoffRef:'/owned/job'},stage:async()=>{}});
test('committed continuation verifies the original operation and finalizes its retained APP backup',async()=>{
  const calls=[];const context=fixture();
  const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async(command,options)=>{
    calls.push([command,options.operationId]);
    return command==='operation-effects'?{effects:{operationId,status:'committed',canResume:true}}:
      {operationVerified:true,updateVerified:true,systemReady:true,version:'2.4.0'};
  },finalizeLauncher:async job=>{calls.push(['finalize',job]);}});
  assert.equal((await executor.resumeCommitted(context,{hasTransaction:true})).version,'2.4.0');
  assert.deepEqual(calls,[['operation-effects',operationId],['resume-committed-update',operationId],['finalize','/owned/job']]);
});
test('a foreign completed transaction is never resumed or finalized',async()=>{
  let finalized=false;
  const executor=create({compare:()=>0,bridge:async()=>({effects:{operationId:'foreign',status:'committed',canResume:true}}),
    finalizeLauncher:async()=>{finalized=true;}});
  assert.equal(await executor.resumeCommitted(fixture(),{hasTransaction:true}),null);assert.equal(finalized,false);
});
test('an unverified continuation keeps the APP backup and never applies files again',async()=>{
  const calls=[];
  const executor=create({compare:()=>0,bridge:async command=>{
    calls.push(command);return command==='operation-effects'?{effects:{operationId,status:'committed',canResume:true}}:
      {operationVerified:true,updateVerified:true,systemReady:false,version:'2.4.0'};
  },finalizeLauncher:async()=>{calls.push('finalize');}});
  await assert.rejects(executor.resumeCommitted(fixture(),{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
  assert.deepEqual(calls,['operation-effects','resume-committed-update']);
});
test('matching version without the operation verification flag cannot retire the backup',async()=>{
  const executor=create({compare:()=>0,bridge:async command=>command==='operation-effects'?
    {effects:{operationId,status:'committed',canResume:true}}:{updateVerified:true,systemReady:true,version:'2.4.0'}});
  await assert.rejects(executor.resumeCommitted(fixture(),{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
});

test('committed first installation verifies the original fixed target without installing or finalizing an APP job',async()=>{
  const calls=[];
  const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async(command,options)=>{
    calls.push([command,options.operationId]);return command==='operation-effects'?
      {effects:{operationId,status:'committed',canResume:true,version:'2.4.0'}}:
      {operationVerified:true,firstInstallVerified:true,systemReady:true,version:'2.4.0'};
  },finalizeLauncher:async()=>{throw new Error('first installation must not retire APP backups');}});
  assert.equal((await executor.resumeInstallation(fixture(),{hasTransaction:true})).version,'2.4.0');
  assert.deepEqual(calls,[['operation-effects',operationId],['resume-committed-install',operationId]]);
});

test('a foreign or mismatched first-install commit never runs acceptance against a different target',async()=>{
  for(const facts of [{operationId:'foreign',status:'committed',canResume:true,version:'2.4.0'},
    {operationId,status:'committed',canResume:true,version:'2.3.0'}]){
    const calls=[];const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async command=>{calls.push(command);return {effects:facts};}});
    if(facts.operationId==='foreign')assert.equal(await executor.resumeInstallation(fixture(),{hasTransaction:true}),null);
    else await assert.rejects(executor.resumeInstallation(fixture(),{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
    assert.deepEqual(calls,['operation-effects']);
  }
});

test('a first-install process success without runtime proof cannot complete the original operation',async()=>{
  const calls=[];
  const executor=create({compare:()=>0,bridge:async command=>{calls.push(command);return command==='operation-effects'?
    {effects:{operationId,status:'committed',canResume:true,version:'2.4.0'}}:
    {operationVerified:true,firstInstallVerified:true,systemReady:false,version:'2.4.0'};}});
  await assert.rejects(executor.resumeInstallation(fixture(),{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
  assert.deepEqual(calls,['operation-effects','resume-committed-install']);
});
