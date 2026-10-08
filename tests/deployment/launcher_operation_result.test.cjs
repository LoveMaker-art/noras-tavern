const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {successResult,failureResult}=require('../installer/desktop/operation-result');
const {verifyWorkflowResult}=require('../installer/desktop/operation-result');
const {programError}=require('../installer/desktop/launcher-errors');

function preload(response){
  let api;
  const ipcRenderer={invoke:async()=>JSON.parse(JSON.stringify(response)),on(){},removeListener(){}};
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/preload.js'),'utf8');
  vm.runInNewContext(source,{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},ipcRenderer};}});
  return api;
}
test('typed failure and operation actions survive Electron JSON transport without raw exception text',async()=>{
  const original=Object.assign(new Error('raw provider reply: secret'),{status:403,source:'release_service',site:'release.request',logOperationId:'22222222-2222-4222-8222-222222222222'});
  const operation={operationId:'op-fixture',snapshotSequence:4,state:'blocked',allowedActions:['recheck','logs']};
  const result=failureResult(original,{action:'update',operation});
  await assert.rejects(preload(result).update(),error=>{
    assert.equal(error.failureCode,'http_forbidden');
    assert.equal(error.logOperationId,original.logOperationId);
    assert.equal(error.operation.operationId,'op-fixture');
    assert.deepEqual(Array.from(error.allowedActions),['recheck','logs']);
    assert.match(error.guidance.title,/更新服务.*403/);
    assert.match(error.guidance.next,/网络或代理/);
    assert.doesNotMatch(error.message,/secret|raw provider/);
    return true;
  });
  assert.equal(original.message,'raw provider reply: secret');
});
test('successful values still reach existing callers as plain status objects',async()=>{
  assert.deepEqual(await preload(successResult({systemReady:true,version:'2.4.2'})).status(),{systemReady:true,version:'2.4.2'});
});

test('typed incompatible-package actions follow the shared business policy only for known safe effects',async()=>{
  const original=Object.assign(new Error('fixed executor mismatch'),{userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
  const operation={operationId:'op-fixture',snapshotSequence:3,state:'failed',effectState:'untouched',
    failureCode:'RELEASE_EXECUTOR_INCOMPATIBLE',allowedActions:['retry','recheck','logs']};
  const result=failureResult(original,{action:'update',operation});
  await assert.rejects(preload(result).update(),error=>{
    assert.equal(error.userCode,'RELEASE_EXECUTOR_INCOMPATIBLE');
    assert.deepEqual(Array.from(error.allowedActions),['logs']);
    assert.deepEqual(Array.from(error.operation.allowedActions),['logs']);return true;
  });
  for(const safety of [{effectState:'unknown',allowedActions:['recover','recheck','logs']},
    {busy:true,allowedActions:['wait','logs']},{archived:true,allowedActions:['logs']}]){
    const unsafe={...operation,...safety};
    assert.deepEqual(failureResult(original,{operation:unsafe}).error.allowedActions,unsafe.allowedActions);
  }
});

test('exit-zero results without service facts or the fixed version cannot complete a workflow',()=>{
  for(const action of ['start','restart','stop'])assert.equal(verifyWorkflowResult({action,result:{ok:true}}),false);
  assert.equal(verifyWorkflowResult({action:'start',service:'tavern',result:{running:true,gatewayRunning:false}}),true);
  assert.equal(verifyWorkflowResult({action:'start',result:{running:true,gatewayRunning:false}}),false);
  assert.equal(verifyWorkflowResult({action:'install',targetVersion:'2.4.3',result:{systemReady:true,version:'2.4.2'}}),false);
  assert.equal(verifyWorkflowResult({action:'pair',result:{clawchatPaired:true}}),false);
  assert.equal(verifyWorkflowResult({action:'update',targetVersion:'2.4.3',before:{running:false,gatewayRunning:false},
    result:{updateVerified:true,systemReady:true,version:'2.4.3',running:true,gatewayRunning:false}}),false);
});

test('bounded Python metadata keeps HTTP status, project frames and recovery errors without arbitrary stack lines',()=>{
  const error=programError({name:'HTTPError',code:403,message:'service rejected',
    stack:'File "replace-launcher.py", line 123, in recover\nraw private traceback line',
    secondaryErrors:[{error:{name:'PermissionError',code:'EACCES',message:'cannot restore'}}]});
  assert.equal(error.status,403);assert.equal(error.code,403);assert.doesNotMatch(error.stack,/raw private/);
  assert.equal(error.secondaryErrors[0].error.code,'EACCES');
});

test('reviewed native program facts survive reconstruction with typed bounds and controlled missing markers',()=>{
  const context={stage:'native_start',loopback:true,pid:987654321,exitCode:3221225477,port:54321};
  const error=programError({name:'NativeLifecycleError',message:'Native process exited',code:'TAVERN_PROCESS_EXITED',stack:'',
    context:{...context,env:'PRIVATE_NATIVE_ENV'},missingReasons:['launch_log_unavailable','launch_log_unavailable','PRIVATE_NATIVE_REASON'],truncated:true,
    cause:{name:'RuntimeError',message:'native cause',stack:'',context:{pid:true,port:70000,exitCode:Infinity,stage:'PRIVATE_NATIVE_STAGE',loopback:false},
      missingReasons:['non_project_frames_omitted']}});
  assert.deepEqual(error.context,context);
  assert.ok(error.missingReasons.includes('launch_log_unavailable'));
  assert.equal(error.missingReasons.filter(reason=>reason==='launch_log_unavailable').length,1);
  assert.equal(error.truncated,true);
  assert.deepEqual(error.cause.context,{loopback:false});
  assert.deepEqual(error.cause.missingReasons,['unknown_evidence_gap','non_project_frames_omitted']);
  assert.doesNotMatch(JSON.stringify(error),/PRIVATE_NATIVE_/);
});

test('reviewed native missing markers share the sixteen-reason bound and reject arbitrary failure labels',()=>{
  const reasons=[...require('../installer/desktop/telemetry-contract.json').faultMissingReasons,
    'launch_log_unavailable','non_project_frames_omitted'];
  const error=programError({name:'RuntimeError',message:'native failure',stack:'',missingReasons:reasons});
  assert.equal(error.missingReasons.length,16);
  assert.equal(error.truncated,true);
  const privateMarker=programError({name:'RuntimeError',message:'native failure',stack:'',
    context:['PRIVATE_NATIVE_CONTEXT'],missingReasons:['save_failed:PRIVATE_NATIVE_SECRET','PRIVATE_NATIVE_REASON',{body:'PRIVATE_NATIVE_BODY'}]});
  assert.equal(privateMarker.context,undefined);
  assert.deepEqual(privateMarker.missingReasons,['unknown_evidence_gap']);
  assert.doesNotMatch(JSON.stringify(privateMarker),/PRIVATE_NATIVE_/);
});
