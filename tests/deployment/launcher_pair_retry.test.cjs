const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createOperationController}=require('../installer/desktop/operation-state');
const {createTestOperationLock}=require('./launcher_operation_test_lock.cjs');

function fixture(t,{native=false}={}){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-pair-retry-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let clock=Date.parse('2026-10-16T08:00:00Z'),calls=0;
  const options={directory,lock:native?require('../installer/desktop/operation-lock'):createTestOperationLock(),now:()=>new Date(clock).toISOString(),
    verifyResult:result=>result.clawchatPaired===true&&result.clawchatProfileReady===true,
    executors:{pair:async context=>{
      await context.plan({request:{action:'pair'}});calls++;
      if(calls<=2)throw Object.assign(new Error('ClawChat 激活失败'),{code:'CLAWCHAT_ACTIVATION_FAILED'});
      return {clawchatPaired:true,clawchatProfileReady:true};
    }}};
  return {directory,options,controller:createOperationController(options),advance:ms=>{clock+=ms;},calls:()=>calls};
}

test('pair failures offer fresh input and become retryable after a finite cooldown across restart',async t=>{
  const f=fixture(t),target={request:{action:'pair'}};
  const first=await f.controller.start('pair',{target},'pair-first');
  const second=await f.controller.start('pair',{target},'pair-second');
  assert.equal(first.state,'failed');assert.equal(second.state,'failed');
  assert.ok(second.allowedActions.includes('pair-clawchat'),'the failure must offer a fresh pairing form');
  assert.equal(second.pairRetryAt,Date.parse('2026-10-16T08:00:30Z'));
  const reopened=createOperationController(f.options);
  const blocked=await reopened.start('pair',{target},'pair-during-cooldown');
  assert.equal(blocked.failureCode,'PAIR_RETRY_COOLDOWN');assert.equal(f.calls(),2);
  assert.equal(blocked.pairRetryAt,second.pairRetryAt,'clicking again must not prolong the cooldown');
  f.advance(30001);
  const third=await createOperationController(f.options).start('pair',{target},'pair-fresh-input');
  assert.equal(third.state,'succeeded');assert.equal(f.calls(),3);
  assert.equal(third.pairRetryAt,null);
});

test('legacy pair retry blocks do not permanently prevent a new explicit submission',async t=>{
  const f=fixture(t),target={request:{action:'pair'}};
  await f.controller.start('pair',{target},'legacy-one');
  const second=await f.controller.start('pair',{target},'legacy-two');
  const file=path.join(f.directory,'operations',second.operationId,'operation.json');
  const record=JSON.parse(fs.readFileSync(file));delete record.pairRetryAt;
  record.state='blocked';record.primaryFailure={code:'RETRY_CONDITIONS_UNCHANGED'};
  fs.writeFileSync(file,JSON.stringify(record));
  const reopened=createOperationController({...f.options,lock:createTestOperationLock()});
  const before=fs.readFileSync(file);
  assert.ok((await reopened.snapshot(second.operationId)).allowedActions.includes('pair-clawchat'));
  f.advance(30001);
  assert.equal((await reopened.start('pair',{target},'legacy-new-input')).state,'succeeded');
  assert.deepEqual(fs.readFileSync(file),before,'a fresh submission must not erase the old evidence');
});

test('install retries keep their unchanged-condition guard',async t=>{
  const f=fixture(t);let writes=0;
  const options={...f.options,executors:{install:async()=>{writes++;throw new Error('apply failed');}}};
  const controller=createOperationController(options);
  await controller.start('install',{},'install-one');await controller.start('install',{},'install-two');
  const third=await controller.start('install',{},'install-three');
  assert.equal(third.failureCode,'RETRY_CONDITIONS_UNCHANGED');assert.equal(writes,2);
});

test('native writer closes after pair failures and admits fresh input after restart',async t=>{
  const f=fixture(t,{native:true}),target={request:{action:'pair'}};
  await f.controller.start('pair',{target},'native-pair-one');
  const failed=await f.controller.start('pair',{target},'native-pair-two');
  assert.equal(failed.state,'failed');
  assert.equal((await f.options.lock.probe({directory:f.directory})).busy,false);
  f.advance(30001);
  const result=await createOperationController(f.options).start('pair',{target},'native-pair-new');
  assert.equal(result.state,'succeeded');assert.equal(f.calls(),3);
  assert.equal((await f.options.lock.probe({directory:f.directory})).busy,false);
});
