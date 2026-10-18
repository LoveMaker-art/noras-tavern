const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {create}=require('../installer/desktop/updater-policy');
const {createOperationController}=require('../installer/desktop/operation-state');
const {createTestOperationLock}=require('./launcher_operation_test_lock.cjs');

function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-standalone-policy-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  let effects={effectState:'untouched',recoveryOutcome:'not-required',reason:'no_journal'},recovered=0;
  const current={standalone:true,systemReady:true,version:'2.4.2',commit:'a'.repeat(40),running:true,
    gatewayManaged:false,gatewayRunning:null,noraHome:home,hermesHome:home,installRoot:home};
  const bridge=async(command,options)=>{
    if(command==='operation-effects')return {effects};
    if(command==='status')return {...current};
    if(command==='recover-update'){
      recovered++;effects={effectState:'restored',recoveryOutcome:'restored-and-verified',canRecover:false,
        operationId:options.operationId,status:'restored'};
      return {...current,updateRecovered:true,recoveryVerification:'confirmed'};
    }
    throw Error('Unexpected standalone command '+command);
  };
  const policy=create({home,hermesHome:home,installRoot:home,bridge});
  return {home,policy,current,setEffects:value=>{effects=value;},recovered:()=>recovered};
}

test('standalone policy accepts only the same operation committed proof and preserves unknown effects',async t=>{
  const f=fixture(t),operationId='a52065fa-dd93-4b01-8b11-cfe5c72c1400',record={operationId,kind:'update'};
  f.setEffects({effectState:'changed',recoveryOutcome:'not-required',canResume:true,status:'committed',operationId});
  assert.equal((await f.policy.observe(record)).canResume,true);
  f.setEffects({effectState:'changed',recoveryOutcome:'not-required',canResume:true,status:'committed',operationId:'other'});
  assert.equal((await f.policy.observe(record)).effectState,'unknown');
  f.setEffects({effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false});
  assert.equal((await f.policy.observe(record)).canRecover,false);
});

test('standalone controller closes failure recovery and admits the next operation using shared state',async t=>{
  const f=fixture(t),directory=path.join(f.home,'installer');
  const controller=createOperationController({directory,lock:createTestOperationLock(),
    observeEffects:f.policy.observe,recoverers:{update:f.policy.recover},
    prepareEffects:f.policy.prepareEffects,captureConditions:f.policy.initialConditions,
    identifyFailureCondition:f.policy.identifyFailureCondition,recheckers:{update:f.policy.recheck}});
  const first=await controller.start('update',{target:{request:{action:'update'}},execute:async context=>{
    f.setEffects({effectState:'changed',recoveryOutcome:'recovery-required',canRecover:true,
      operationId:context.operationId,status:'prepared'});
    await context.effect('changed');throw Error('synthetic replacement failed');
  }},'standalone-first');
  assert.equal(first.state,'rolled-back');assert.equal(first.verification,'confirmed');
  assert.equal(first.recoveryOutcome,'restored-and-verified');assert.equal((await controller.snapshot(first.operationId)).busy,false);assert.equal(f.recovered(),1);
  f.setEffects({effectState:'untouched',recoveryOutcome:'not-required',reason:'prior_transaction_verified'});
  const second=await controller.start('update',{target:{request:{action:'update'}},execute:async()=>({verification:'confirmed'})},'standalone-second');
  assert.equal(second.state,'succeeded');assert.equal((await controller.snapshot(second.operationId)).busy,false);
  assert.notEqual(second.operationId,first.operationId);
});

test('standalone policy does not accept restored file labels without actual runtime acceptance',async t=>{
  const f=fixture(t);f.current.systemReady=false;
  f.setEffects({effectState:'restored',recoveryOutcome:'restored-and-verified',canRecover:false});
  await assert.rejects(f.policy.recover({operationId:'a52065fa-dd93-4b01-8b11-cfe5c72c1400',
    snapshot:{kind:'update'},check(){},stage:async()=>{}}),/实际检查/);
});
