const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {parse}=require('../installer/desktop/node_modules/acorn');
const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
const tree=parse(source,{ecmaVersion:'latest'}),nodes=[];
function walk(node){if(!node||typeof node!=='object')return;if(node.type)nodes.push(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
walk(tree);
function definition(name){const node=nodes.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name||node.type==='VariableDeclarator'&&node.id.name===name);assert.ok(node,name);return node.type==='VariableDeclarator'?`const ${source.slice(node.start,node.end)};`:source.slice(node.start,node.end);}
function handoffCallback(){const node=nodes.find(node=>node.type==='ArrowFunctionExpression'
  &&node.body?.body?.[0]?.declarations?.[0]?.id?.name==='plan'
  &&source.slice(node.start,node.end).includes('plan = launcherUpdate.resume('));assert.ok(node);return source.slice(node.start,node.end);}
function retryFixture(t,{fixed=true,legacy=false}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-shared-route-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const operationId=randomUUID(),job=path.join(home,'installer/update-jobs',randomUUID());fs.mkdirSync(job,{recursive:true});
  fs.writeFileSync(path.join(job,'operation-ref.json'),JSON.stringify({operationId}));
  const selected={operationId,requestId:randomUUID(),kind:'update',snapshotSequence:4,target:{request:{action:'update',port:18799,tag:'v2.5.2'},
    ...(fixed?{releasePlan:{client:'updater',tag:'v2.5.2'}}:{})}};
  const sequence=legacy?{requests:{core:selected.requestId,launcher:randomUUID()}}:null;
  const calls=[],handlers={};
  const context=vm.createContext({fs,path,activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    noraHome:()=>home,desktopSequenceOptions:()=>({}),updateSequence:{load:()=>sequence,operation:()=>selected},
    installerDirectory:()=>path.join(home,'installer'),launcherError:(message,details)=>Object.assign(new Error(message),details),
    rememberOperationFailure(){},operations:()=>({snapshot:async()=>selected,resume:async()=>assert.fail('must not use the GUI executor'),recover:async()=>assert.fail('must not use the GUI recoverer')}),
    runSharedUpdate:async(_event,payload,options)=>{calls.push({payload,options});return {version:'2.5.2'};},
    handle:(name,callback)=>{handlers[name]=callback;},finishOperationTelemetry(){},registerCapabilities(){},requireOperationResult:operation=>operation});
  if(nodes.some(node=>node.type==='FunctionDeclaration'&&node.id.name==='sharedUpdateJob'))vm.runInContext(definition('sharedUpdateJob'),context);
  vm.runInContext(definition('desktopSequenceForOperation'),context);
  vm.runInContext(definition('operationRequest'),context);
  const loop=nodes.find(node=>node.type==='ForOfStatement'&&node.left.declarations?.[0]?.id.name==='mode'
    &&source.slice(node.start,node.end).includes('nora:operation-'));
  assert.ok(loop);vm.runInContext(source.slice(loop.start,loop.end),context);
  return {selected,calls,handlers,job,sequence,context};
}
for(const fixed of [true,false])test(`GUI cannot retry a core update ${fixed?'after':'before'} release selection`,async t=>{
  const f=retryFixture(t,{fixed});
  await assert.rejects(f.handlers['nora:operation-resume']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'retry-request'}),
    {code:'CORE_UPDATE_CHAT_REQUIRED'});
  assert.equal(f.calls.length,0);
});
for(const hasJob of [true,false])test(`GUI cannot recover a new independent core task or trust a caller-provided historical label (${hasJob?'with':'without'} worker job)`,async t=>{
  const f=retryFixture(t,{fixed:false});f.selected.legacyDesktopRecovery=true;
  if(!hasJob)fs.rmSync(f.job,{recursive:true});
  await assert.rejects(f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'independent-recovery'}),
    {code:'CORE_UPDATE_CHAT_REQUIRED'});
  assert.equal(f.calls.length,0);
});
for(const kind of ['install','model','app'])test(`existing ${kind} recovery retains its original controller`,async t=>{
  const f=retryFixture(t);fs.rmSync(f.job,{recursive:true});
  f.selected.kind=kind==='app'?'update':kind;if(kind==='app')f.selected.target.request.launcherOnly=true;
  let recovered=0;f.context.operations=()=>({snapshot:async()=>f.selected,recover:async id=>{
    assert.equal(id,f.selected.operationId);recovered++;return {state:'rolled-back'};}});
  await f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'same-controller'});
  assert.equal(recovered,1);assert.equal(f.calls.length,0);
});
test('GUI recovery keeps the proven historical desktop operation and original target',async t=>{
  const f=retryFixture(t,{fixed:false,legacy:true});
  await f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'recover-request'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.recover,true);assert.equal(f.calls[0].payload.tag,'v2.5.2');
});
test('GUI retry rejects a changed snapshot before submitting anything',async t=>{
  const f=retryFixture(t,{fixed:false});
  await assert.rejects(f.handlers['nora:operation-resume']({sender:null},{operationId:f.selected.operationId,snapshotSequence:3,runId:'stale-request'}),{code:'OPERATION_SNAPSHOT_CHANGED'});
  assert.equal(f.calls.length,0);
});
test('unrelated malformed job evidence does not block an owned core recovery',async t=>{
  const f=retryFixture(t,{fixed:false,legacy:true});
  const directory=path.join(path.dirname(f.job),randomUUID());fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'operation-ref.json'),'not-json');
  await f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'owned-recovery'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.recover,true);
});
test('a malformed reference for the original operation cannot fall back to a new GUI update',async t=>{
  const f=retryFixture(t,{fixed:false});f.selected.requestId=path.basename(f.job);fs.writeFileSync(path.join(f.job,'operation-ref.json'),'not-json');
  await assert.rejects(f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'corrupt-own-job'}));
  assert.equal(f.calls.length,0);
});
test('an interrupted job reference remains usable only for recovery of its admitted operation',async t=>{
  const f=retryFixture(t,{fixed:false,legacy:true});f.selected.requestId=path.basename(f.job);f.sequence.requests.core=f.selected.requestId;
  fs.unlinkSync(path.join(f.job,'operation-ref.json'));
  fs.writeFileSync(path.join(f.job,'request.json'),JSON.stringify({requestId:f.selected.requestId,request:{kind:'update'}}));
  await f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'missing-ref'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.recover,true);assert.equal(f.calls[0].payload.requestId,f.selected.requestId);
});
for(const change of ['request-id','kind'])test(`missing references cannot recover an unbound ${change}`,async t=>{
  const f=retryFixture(t,{fixed:false,legacy:true});f.selected.requestId=path.basename(f.job);f.sequence.requests.core=f.selected.requestId;fs.unlinkSync(path.join(f.job,'operation-ref.json'));
  fs.writeFileSync(path.join(f.job,'request.json'),JSON.stringify({requestId:change==='request-id'?randomUUID():f.selected.requestId,
    request:{kind:change==='kind'?'recover':'update'}}));
  await assert.rejects(f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'unbound-ref'}));
  assert.equal(f.calls.length,0);
});
for(const change of ['other-core-request','canonical-operation','missing-canonical'])test(`a ${change} cannot authorize historical desktop recovery`,async t=>{
  const f=retryFixture(t,{legacy:true});
  if(change==='other-core-request')f.sequence.requests.core=randomUUID();
  else f.context.updateSequence.operation=()=>change==='missing-canonical'?null:{...f.selected,operationId:randomUUID()};
  await assert.rejects(f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'unproven-history'}),
    {code:'CORE_UPDATE_CHAT_REQUIRED'});
  assert.equal(f.calls.length,0);
});
test('public recovery ownership is derived from validated sequence and canonical operation, without changing recorded effects',t=>{
  const f=retryFixture(t,{legacy:true});vm.runInContext(definition('projectDesktopOperation'),f.context);
  const project=vm.runInContext('projectDesktopOperation',f.context);
  f.selected.effectState='changed';f.selected.allowedActions=['recover','logs'];
  assert.equal(project(f.selected).legacyDesktopRecovery,true);
  assert.equal(f.selected.legacyDesktopRecovery,undefined);
  f.context.updateSequence.operation=()=>null;
  const readonly=project(f.selected);
  assert.equal(readonly.legacyDesktopRecovery,false);assert.equal(readonly.effectState,'changed');
  assert.deepEqual(readonly.allowedActions,['recover','logs'],'projection does not discard pending effect evidence');
});
test('rechecking retains proven historical recovery permission and drops it if its original association disappears',async t=>{
  const f=retryFixture(t,{legacy:true});vm.runInContext(definition('projectDesktopOperation'),f.context);
  f.context.statusRequest=null;f.context.operations=()=>({recheck:async()=>f.selected});
  const registration=nodes.find(node=>node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value==='nora:operation-recheck');
  assert.ok(registration);vm.runInContext(source.slice(registration.start,registration.end),f.context);
  const payload={operationId:f.selected.operationId,snapshotSequence:4,runId:'recheck-history'};
  assert.equal((await f.handlers['nora:operation-recheck']({},payload)).operation.legacyDesktopRecovery,true);
  f.context.updateSequence.operation=()=>null;
  assert.equal((await f.handlers['nora:operation-recheck']({},payload)).operation.legacyDesktopRecovery,false);
  assert.equal(f.selected.legacyDesktopRecovery,undefined,'the permission is not persisted in the canonical record');
});
for(const outcome of ['succeeded','rolled-back','unconfirmed','missing-plan'])test(`startup handoff consumes its marker once (${outcome})`,async()=>{
  const calls=[],job='/owned/installer/launcher-update/job',operation={state:outcome,operationId:randomUUID()};
  const plan={operationId:operation.operationId,target:'v2.5.4',planDigest:'a'.repeat(64),skillId:'skill'};
  const context=vm.createContext({SELF_UPDATE_JOB:job,activeRun:true,activeOperationContext:{operationId:operation.operationId},
    noraHome:()=>'/owned',process:{execPath:'/test/app'},app:{getVersion:()=> '2.2.4'},window:{webContents:{}},
    launcherRecoveryOptions:()=>({}),launcherUpdate:{resume:actual=>{assert.equal(actual,job);return outcome==='missing-plan'?null:plan;},
      waitHandoff:async options=>{assert.equal(options.job,job);calls.push('wait');}},
    readInstallerState:()=>({}),writeInstallerState(){},
    operations:()=>({snapshot:async()=>({snapshotSequence:5,requestId:'original-request'}),resume:async(_id,options)=>{
      assert.equal(options.handoff.job,job);calls.push('resume');return operation;}}),
    rememberOperationFailure(){},finishOperationTelemetry(){},registerCapabilities:async()=>calls.push('register'),
    requireOperationResult:actual=>{if(actual.state!=='succeeded')throw Object.assign(new Error('preserve original recovery'),{operation:actual});return {};},
    finishHandoff:(_home,_skill,result)=>calls.push(result?'success':'failure'),
    continueDesktopUpdate:async()=>calls.push('continue'),diagnostics:{clean:value=>value,error:()=>calls.push('logged')}});
  await vm.runInContext(`(${handoffCallback()})`,context)();
  assert.equal(context.SELF_UPDATE_JOB,null);assert.equal(context.activeRun,false);assert.equal(context.activeOperationContext,null);
  assert.equal(calls.filter(call=>call==='resume').length,outcome==='missing-plan'?0:1);
  assert.equal(calls.includes('continue'),outcome==='succeeded','a failed or unknown recovery is never continued as successful');
  assert.equal(operation.state,outcome,'the marker is transient, not an operation or recovery record');
});
function submissionFixture(t,reply){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-submit-protocol-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const entry=path.join(home,'tavern/apps/tavern-ops/updater/task.py');fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'fixture transport endpoint');
  const helper=path.join(home,'submit-reply.cjs');fs.writeFileSync(helper,"process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]))+'\\n');");
  const calls=[],events=[];let finishWait;
  const waitResult=new Promise(resolve=>{finishWait=resolve;});
  const context=vm.createContext({fs,path,findPython:()=>({command:'python-protocol-adapter'}),installRoot:()=>path.join(home,'tavern'),hermesHome:()=>path.join(home,'hermes'),
    noraHome:()=>home,installationPort:()=>18799,localReleaseDirectory:null,launcherEnv:()=>process.env,
    launcherError:(message,details)=>Object.assign(new Error(message),details),
    // The explicit process adapter emits actual child stdout/close events. It
    // tests the submission protocol; native execution is covered separately.
    spawn:(_command,_args,options)=>require('node:child_process').spawn(process.execPath,[helper,JSON.stringify(reply)],options),
    consumeLines:require('../installer/desktop/process-output').consumeLines,
    require:name=>{assert.equal(name,'./updater-task');return {wait:async(root,id)=>{calls.push({root,id});return waitResult;}};},
    sendBridgeEvent:(_sender,_id,event)=>events.push(event),readInstallerState:()=>({setupCompleted:true}),writeInstallerState(){},
    requireOperationResult:operation=>operation.result});
  vm.runInContext(definition('runSharedUpdate'),context);
  return {context,calls,events,finishWait,run:()=>vm.runInContext('runSharedUpdate',context)({sender:null},{action:'update',runId:'pending-submit'})};
}
test('slow admission waits for the same request instead of reporting a false update failure',async t=>{
  const requestId=randomUUID(),f=submissionFixture(t,{event:'result',status:'submitting',requestId,busy:false,settled:false});
  let finished=false;const pending=f.run().then(value=>{finished=true;return value;});
  let pollTimer;const waiting=new Promise(resolve=>{const poll=()=>f.calls.length?resolve():pollTimer=setTimeout(poll,5);poll();});
  try{await Promise.race([waiting,pending]);}finally{clearTimeout(pollTimer);}
  assert.equal(finished,false);assert.equal(f.calls[0].id,requestId);assert.equal(f.events.some(event=>event.stage_id==='update_admission'),true);
  f.finishWait({settled:true,operation:{state:'succeeded',result:{version:'2.5.2',systemReady:true}}});
  assert.equal((await pending).version,'2.5.2');
});
for(const reply of [{event:'result',status:'error',requestId:randomUUID(),settled:true,code:'UPDATER_START_FAILED'},
  {event:'result',status:'submitting',requestId:'invalid',settled:false}])test(`admission ${reply.status==='error'?'failure':'invalid identity'} never enters wait`,async t=>{
  const f=submissionFixture(t,reply);await assert.rejects(f.run());assert.equal(f.calls.length,0);
});
