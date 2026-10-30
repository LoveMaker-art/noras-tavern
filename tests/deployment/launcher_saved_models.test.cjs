const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {parse}=require('../installer/desktop/node_modules/acorn');
const {createOperationController}=require('../installer/desktop/operation-state');
const lock=require('../installer/desktop/operation-lock');
const {launcherError}=require('../installer/desktop/launcher-errors');
const {failureResult,verifyWorkflowResult}=require('../installer/desktop/operation-result');
const {configurationFingerprint}=require('../installer/desktop/model-config');

const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
const ast=parse(source,{ecmaVersion:'latest'});
const code=name=>{const node=ast.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);
  assert.ok(node,`production ${name} exists`);return source.slice(node.start,node.end);};
const A='model-'+ 'a'.repeat(32),B='model-'+ 'b'.repeat(32);
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-saved-model-desktop-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const calls=[],errors=new Map();
 const rows=[{id:A,provider:'deepseek',model:'model-A',available:true},
             {id:B,provider:'opencode-go',model:'model-B',available:true}];
 let selected=A,previous='',gateway=true,activity='idle',failSwitch=false,clock=Date.now();
 let held;
 const current=()=>({ok:true,configured:true,selectedId:selected,previousSelectedId:previous,
   models:rows.map(row=>({...row,selected:row.id===selected}))});
 const recoverers={},recheckers={};let outcome=null;
 const policy=require('../installer/desktop/operation-policy').create({home:root,hermesHome:root,installRoot:root,
   bridge:async()=>({}),runRuntime:async()=>({})});
 const controller=createOperationController({directory:path.join(root,'installer'),lock,recoverers,recheckers,
   observeEffects:record=>policy.observe(record),now:()=>new Date(clock).toISOString(),
   projectResult:result=>result?.value??result});
 const context=vm.createContext({activeRun:false,modelBusy:false,statusRequest:null,activeOperationContext:null,
  telemetry:null,diagnostics:{begin(){},scope:(_id,_data,work)=>work()},operationErrors:errors,
  rememberOperationFailure:(error,record)=>errors.set(record.operationId,error),finishOperationTelemetry(){},
  operations:()=>controller,noraHome:()=>root,configurationFingerprint,uninstall:{own:()=> 'fixture-installation-identity'},
  publicProviders:()=>[{id:'deepseek',label:'DeepSeek'}],launcherError,verifyWorkflowResult,require,
  sendBridgeEvent:(_sender,runId,event)=>calls.push({event,runId}),
  runModelConfigHelper:async payload=>{
    calls.push({helper:payload.action,id:payload.id});
    if(payload.action==='inspect')return current();
    if(payload.action==='inspect-outcome')return outcome?.operationId===payload.operationId?outcome:{ok:true,confirmed:false};
    if(payload.action==='delete'){if(failSwitch)throw Object.assign(new Error('fixture deletion restored'),{modelFailureStage:'restored'});const index=rows.findIndex(row=>row.id===payload.id);rows.splice(index,1);
      outcome={ok:true,confirmed:true,operationId:context.activeOperationContext.operationId,action:'delete',profileId:payload.id,current:current()};return {ok:true,deletedId:payload.id};}
    assert.equal(payload.action,'switch');
    if(held)await held;
    if(failSwitch)throw Object.assign(new Error('Native test rejected'),{modelFailureStage:'candidate',status:401});
    previous=selected;selected=payload.id;
    outcome={ok:true,confirmed:true,operationId:context.activeOperationContext.operationId,action:'switch',profileId:payload.id,current:current()};
    return {ok:true,verified:true,selectedId:selected,previousSelectedId:previous};
  },
  runBridge:async(command,options)=>{
    calls.push({bridge:command,service:options?.service});
    if(command==='status')return {gatewayRunning:gateway,gatewayActivity:activity};
    assert.equal(command,'restart');assert.equal(options.service,'nora');
    gateway=true;return {gatewayRunning:true};
  }});
 vm.runInContext(['requireOperationResult','runOwnedTask','savedModelCatalog','savedModelRequest','switchSavedModel','deleteSavedModel','recoverModelConfiguration'].map(code).join('\n'),context);
 recoverers.model=context.recoverModelConfiguration;
 vm.runInContext(code('recheckSavedModelOperation'),context);recheckers.model=context.recheckSavedModelOperation;
 const event={sender:{}};
 return {root,calls,context,current,
  selected:()=>selected,
  choose:id=>context.switchSavedModel(event,{id,runId:'saved-model-test'}),
  delete:id=>context.deleteSavedModel(event,{id,runId:'saved-model-delete'}),
  setActivity:value=>{activity=value;},setStopped:()=>{gateway=false;},
  advance:milliseconds=>{clock+=milliseconds;},
  failSwitch:value=>{failSwitch=value;},
  hold:()=>{let release;held=new Promise(resolve=>{release=resolve;});return ()=>{held=null;release();};}};
}

test('saved ID switch uses the shared writer without credentials or lifecycle changes',async t=>{
 const f=fixture(t),result=await f.choose(B);
 assert.equal(result.current.selectedId,B);assert.equal(result.previousSelectedId,A);
 assert.equal(result.operation.state,'succeeded');assert.equal(result.activation.state,'default');
 assert.deepEqual(f.calls.filter(call=>call.helper==='switch'),[{helper:'switch',id:B}]);
 assert.equal(f.calls.some(call=>call.bridge),false,'switch must not restart or interrupt the gateway');
 assert.deepEqual(f.calls.filter(call=>call.event).map(call=>call.event.phase),['verifying','applying']);
 const record=JSON.parse(fs.readFileSync(path.join(f.root,'installer/operations',result.operation.operationId,'operation.json')));
 assert.deepEqual(record.target.request,{mode:'configure',profileId:B});
 assert.doesNotMatch(JSON.stringify(record),/api_key|Bearer|fixture-secret/);
 const back=await f.choose(A);assert.equal(back.current.selectedId,A);
});

test('a committed deletion with a failed final query closes on recheck and permits later operations',async t=>{
 const f=fixture(t),helper=f.context.runModelConfigHelper;let deleted=false,queryFails=true;
 f.context.runModelConfigHelper=async payload=>{
   if(payload.action==='inspect'&&deleted&&queryFails)throw new Error('fixture final query failed');
   const value=await helper(payload);if(payload.action==='delete')deleted=true;return value;
 };
 let failure;try{await f.delete(B);}catch(error){failure=error;}
 assert.equal(f.current().models.some(row=>row.id===B),false);
 assert.equal(failure.operation.recoveryOutcome,'recovery-required');queryFails=false;
 const checked=await f.context.operations().recheck(failure.operation.operationId);
 assert.equal(checked.state,'succeeded');assert.equal(checked.verification,'confirmed');
 assert.equal(checked.effectState,'changed');assert.equal(checked.recoveryOutcome,'not-required');
 const next=await f.context.runOwnedTask('start',{},async()=>({verification:'confirmed',value:{ok:true}}));
 assert.equal(next.operation.state,'succeeded');
 assert.equal(f.calls.filter(call=>call.helper==='delete').length,1,'recheck never repeats deletion');
});

test('a lost switch response stays unknown until the exact operation commit can be verified',async t=>{
 const f=fixture(t),helper=f.context.runModelConfigHelper;let interrupted=true;
 f.context.runModelConfigHelper=async payload=>{
   const value=await helper(payload);
   if(payload.action==='switch'&&interrupted){interrupted=false;throw new Error('fixture lost reply after commit');}
   return value;
 };
 let failure;try{await f.choose(B);}catch(error){failure=error;}
 assert.equal(f.selected(),B);assert.equal(failure.operation.effectState,'unknown');
 await assert.rejects(f.context.runOwnedTask('start',{},async()=>({verification:'confirmed'})),error=>error.code==='UPDATE_RECOVERY_REQUIRED');
 const checked=await f.context.operations().recheck(failure.operation.operationId);
 assert.equal(checked.state,'succeeded');assert.equal(checked.recoveryOutcome,'not-required');
 assert.equal((await f.choose(A)).operation.state,'succeeded');
});

test('a partial switch cannot be unlocked by a readable model list or a different commit',async t=>{
 const f=fixture(t),helper=f.context.runModelConfigHelper;
 f.context.runModelConfigHelper=async payload=>{
   if(payload.action==='switch')throw new Error('fixture commit and restoration both unconfirmed');
   if(payload.action==='inspect-outcome')return {ok:true,confirmed:true,operationId:'different-operation',
     action:'switch',profileId:B,current:{...f.current(),selectedId:B}};
   return helper(payload);
 };
 let failure;try{await f.choose(B);}catch(error){failure=error;}
 assert.equal(failure.operation.effectState,'unknown');
 const checked=await f.context.operations().recheck(failure.operation.operationId);
 assert.equal(checked.recoveryOutcome,'recovery-required');
 await assert.rejects(f.context.runOwnedTask('start',{},async()=>({verification:'confirmed'})),error=>error.code==='UPDATE_RECOVERY_REQUIRED');
});

test('current default is a read-only no-op and unknown IDs never reach a writer',async t=>{
 const f=fixture(t);const same=await f.choose(A);assert.equal(same.unchanged,true);
 await assert.rejects(f.choose('model-'+ 'c'.repeat(32)),/配置已变化/);
 assert.equal(f.calls.some(call=>call.helper==='switch'),false);
 assert.equal(f.context.modelBusy,false);
});

test('candidate refusal stays untouched, survives error transport and permits corrected retry',async t=>{
 const f=fixture(t);f.failSwitch(true);
 let failure;try{await f.choose(B);}catch(error){failure=error;}
 assert.ok(failure);assert.equal(failure.modelFailureStage,'candidate');
 assert.equal(failure.operation.effectState,'untouched');assert.equal(f.selected(),A);
 const dto=failureResult(failure,{action:'model',operation:failure.operation});
 assert.equal(dto.error.modelFailureStage,'candidate');assert.equal(dto.error.technical.http_status,401);
 assert.equal(f.context.modelBusy,false);
 await assert.rejects(f.choose(B),error=>error.modelFailureStage==='candidate');
 await assert.rejects(f.choose(B),error=>error.code==='MODEL_RETRY_COOLDOWN');
 f.advance(31_000);
 f.failSwitch(false);
 assert.equal((await f.choose(B)).current.selectedId,B);
});

test('concurrent model submissions cannot overlap and busy state is released',async t=>{
 const f=fixture(t),release=f.hold(),pending=f.choose(B);
 await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.choose(A),error=>error.code==='OPERATION_BUSY');
 release();await pending;assert.equal(f.context.modelBusy,false);
 assert.equal(f.calls.filter(call=>call.helper==='switch').length,1);
});

test('an ordinary restart failure does not invoke model-selection recovery',async t=>{
 const f=fixture(t);await f.choose(B);f.calls.length=0;
 await assert.rejects(f.context.runOwnedTask('restart',{service:'nora'},async()=>{
   throw new Error('ordinary restart refused before changing services');
 }),error=>error.operation.effectState==='untouched'&&error.operation.recoveryOutcome==='not-required');
 assert.equal(f.selected(),B);
 assert.equal(f.calls.some(call=>call.helper==='switch'||call.bridge==='restart'),false);
});


test('deletion removes the native record, verifies absence, and preserves the default without restart',async t=>{
 const f=fixture(t);const result=await f.delete(B);
 assert.equal(result.operation.state,'succeeded');assert.equal(result.current.selectedId,A);
 assert.equal(result.models.some(row=>row.id===B),false);
 assert.deepEqual(f.calls.filter(call=>call.helper==='delete'),[{helper:'delete',id:B}]);
 assert.equal(f.calls.some(call=>call.bridge==='restart'||call.helper==='switch'),false);
 assert.equal(f.context.modelBusy,false);
});

test('default and busy gateway deletion is refused before writing',async t=>{
 const f=fixture(t);await assert.rejects(f.delete(A),/先切换/);
 for(const state of ['busy','unknown']){f.setActivity(state);await assert.rejects(f.delete(B),/运行任务或状态未确认/);}
 assert.equal(f.calls.some(call=>call.helper==='delete'),false);
 assert.equal(f.context.modelBusy,false);
});


test('a confirmed native deletion rollback closes the task and permits later operations',async t=>{
 const f=fixture(t);f.failSwitch(true);
 await assert.rejects(f.delete(B),error=>error.operation.state==='rolled-back'
   &&error.operation.effectState==='restored'&&error.operation.verification==='confirmed'
   &&error.operation.recoveryOutcome==='restored-and-verified');
 assert.equal(f.selected(),A);assert.equal(f.current().models.some(row=>row.id===B),true);
 f.failSwitch(false);assert.equal((await f.delete(B)).operation.state,'succeeded');
 assert.equal(f.context.modelBusy,false);
});
