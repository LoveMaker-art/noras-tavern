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
function retryFixture(t,{fixed=true}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-shared-route-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const operationId=randomUUID(),job=path.join(home,'installer/update-jobs',randomUUID());fs.mkdirSync(job,{recursive:true});
  fs.writeFileSync(path.join(job,'operation-ref.json'),JSON.stringify({operationId}));
  const selected={operationId,snapshotSequence:4,target:{request:{action:'update',port:18799,tag:'v2.5.2'},
    ...(fixed?{releasePlan:{client:'updater',tag:'v2.5.2'}}:{})}};
  const calls=[],handlers={};
  const context=vm.createContext({fs,path,activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    installerDirectory:()=>path.join(home,'installer'),launcherError:(message,details)=>Object.assign(new Error(message),details),
    rememberOperationFailure(){},desktopSequenceForOperation:()=>null,operations:()=>({snapshot:async()=>selected,resume:async()=>assert.fail('must not use the GUI executor'),recover:async()=>assert.fail('must not use the GUI recoverer')}),
    runSharedUpdate:async(_event,payload,options)=>{calls.push({payload,options});return {version:'2.5.2'};},
    handle:(name,callback)=>{handlers[name]=callback;},finishOperationTelemetry(){},registerCapabilities(){},requireOperationResult:operation=>operation});
  if(nodes.some(node=>node.type==='FunctionDeclaration'&&node.id.name==='sharedUpdateJob'))vm.runInContext(definition('sharedUpdateJob'),context);
  vm.runInContext(definition('operationRequest'),context);
  const loop=nodes.find(node=>node.type==='ForOfStatement'&&node.left.declarations?.[0]?.id.name==='mode'
    &&source.slice(node.start,node.end).includes('nora:operation-'));
  assert.ok(loop);vm.runInContext(source.slice(loop.start,loop.end),context);
  return {selected,calls,handlers,job};
}
for(const fixed of [true,false])test(`GUI retry preserves the original request ${fixed?'after':'before'} release selection`,async t=>{
  const f=retryFixture(t,{fixed});
  await f.handlers['nora:operation-resume']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'retry-request'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.tag,'v2.5.2');assert.equal(f.calls[0].payload.port,18799);
  assert.equal(f.calls[0].options.recover,false);
});
test('GUI recover uses the same independently admitted operation before release selection',async t=>{
  const f=retryFixture(t,{fixed:false});
  await f.handlers['nora:operation-recover']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'recover-request'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.recover,true);assert.equal(f.calls[0].payload.tag,'v2.5.2');
});
test('GUI retry rejects a changed snapshot before submitting anything',async t=>{
  const f=retryFixture(t,{fixed:false});
  await assert.rejects(f.handlers['nora:operation-resume']({sender:null},{operationId:f.selected.operationId,snapshotSequence:3,runId:'stale-request'}),{code:'OPERATION_SNAPSHOT_CHANGED'});
  assert.equal(f.calls.length,0);
});

for(const launcherOnly of [false,true])test(`GUI ${launcherOnly?'APP-only handoff':'ordinary content'} uses its own existing execution owner`,async()=>{
  const calls=[];const context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,SELF_UPDATE_JOB:null,
    launcherError:(message,details)=>Object.assign(new Error(message),details),
    runSharedUpdate:async(_event,payload)=>{calls.push(['content',payload]);return {version:'2.5.2'};},
    operations:()=>({start:async(kind,options)=>{calls.push(['APP',kind,options.target.request]);return {state:'awaiting-handoff',handoffRef:'/private/APP-job'};}}),
    executeAction(){},rememberOperationFailure(){},launcherRecoveryOptions:()=>({}),hermesHome:()=>'/private/home/hermes',path,
    launcherUpdate:{launchHandoff:async options=>calls.push(['handoff',options.job])},process:{env:{}},app:{quit:()=>calls.push(['quit'])},
    quitReady:false,setImmediate:callback=>callback(),requireOperationResult:operation=>operation,finishOperationTelemetry(){},registerCapabilities(){}});
  vm.runInContext(definition('runAction'),context);
  await vm.runInContext('runAction',context)({sender:null},{action:'update',tag:'v2.5.2',runId:'route-check',...(launcherOnly?{launcherOnly:true}:{})});
  if(launcherOnly){assert.deepEqual(calls.map(call=>call[0]),['APP','handoff','quit']);assert.equal(calls[0][2].launcherOnly,true);}
  else assert.deepEqual(calls.map(call=>call[0]),['content']);
});

test('an unrelated malformed job reference cannot prevent retrying a valid admitted update',async t=>{
  const f=retryFixture(t,{fixed:false});
  const contextJob=f.job;
  const directory=path.join(path.dirname(contextJob),randomUUID());fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'operation-ref.json'),'not-json');
  await f.handlers['nora:operation-resume']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'unrelated-job'});
  assert.equal(f.calls.length,1);
});

test('one desktop request for both components enters the sequence instead of ending after core update',async()=>{
  const calls=[];
  const context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,SELF_UPDATE_JOB:null,
    launcherError:(message,details)=>Object.assign(new Error(message),details),
    runSharedUpdate:async()=>{calls.push('core-only');return {version:'2.5.2'};},
    runDesktopUpdate:async(_event,payload)=>{calls.push('both');assert.equal(payload.tag,'v2.5.3');return {version:'2.5.2',updateComplete:true};}});
  vm.runInContext(definition('runAction'),context);
  const result=await vm.runInContext('runAction',context)({sender:null},{action:'update',tag:'v2.5.3',runId:'one-click',includeLauncher:true});
  assert.deepEqual(calls,['both']);assert.equal(result.updateComplete,true);
});
test('the actual renderer preload carries the two-component request to the main sequence',async()=>{
  const calls=[];
  const context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,SELF_UPDATE_JOB:null,
    launcherError:(message,details)=>Object.assign(new Error(message),details),
    runSharedUpdate:async()=>{calls.push('core-only');return {version:'2.5.2'};},
    runDesktopUpdate:async(_event,payload)=>{calls.push('both');assert.equal(payload.tag,'v2.5.3');return {updateComplete:true};}});
  vm.runInContext(definition('runAction'),context);
  const run=vm.runInContext('runAction',context);let api;
  const preload=fs.readFileSync(path.join(__dirname,'../installer/desktop/preload.js'),'utf8');
  vm.runInNewContext(preload,{require:name=>{
    assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},
      ipcRenderer:{on(){},removeListener(){},invoke:async(channel,payload)=>{
        assert.equal(channel,'nora:run');return run({sender:null},payload);
      }}};
  }});
  const result=await api.update({tag:'v2.5.3',includeLauncher:true});
  assert.deepEqual(calls,['both']);assert.equal(result.updateComplete,true);
});
test('APP-first main route prepares its authenticated core bootstrap with an in-scope network context',async()=>{
  const sequence={order:['launcher','core'],plan:{tag:'v2.5.3'},requests:{}},calls=[],network={source:'test-source-context'};
  const context=vm.createContext({fs:{existsSync:()=>false},path,desktopSequenceOptions:()=>({}),
    noraHome:()=>'/private/test',installRoot:()=>'/private/test/tavern',updateFetch:async()=>{},sendBridgeEvent(){},
    require:name=>{assert.equal(name,'./release-network');return {createReleaseSourceContext:()=>network};},
    updateSequence:{load:()=>sequence,operation:()=>null,prepareBootstrap:async(home,value,options)=>{
      assert.equal(home,'/private/test');assert.equal(value,sequence);assert.equal(options.networkPolicy.sourceContext,network);calls.push('prepared');
    },run:async()=>{calls.push('run');return {restarting:true};}},desktopUpdateNotice:null});
  vm.runInContext(definition('runDesktopUpdate'),context);
  const result=await vm.runInContext('runDesktopUpdate',context)({sender:null},{tag:'v2.5.3',runId:'app-first'});
  assert.deepEqual(calls,['prepared','run']);assert.equal(result.restarting,true);
});
test('a malformed reference for this operation cannot fall back to the GUI updater',async t=>{
  const f=retryFixture(t,{fixed:false});f.selected.requestId=path.basename(f.job);fs.writeFileSync(path.join(f.job,'operation-ref.json'),'not-json');
  await assert.rejects(f.handlers['nora:operation-resume']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'corrupt-own-job'}));
  assert.equal(f.calls.length,0);
});

test('GUI retries an admitted operation whose reference was interrupted before publication',async t=>{
  const f=retryFixture(t,{fixed:false});f.selected.requestId=path.basename(f.job);
  fs.unlinkSync(path.join(f.job,'operation-ref.json'));
  fs.writeFileSync(path.join(f.job,'request.json'),JSON.stringify({requestId:f.selected.requestId,request:{kind:'update'}}));
  await f.handlers['nora:operation-resume']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'missing-ref'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.requestId,f.selected.requestId);assert.equal(f.calls[0].payload.tag,'v2.5.2');
});
for(const change of ['request-id','kind'])test(`a missing reference cannot use an unbound ${change} fallback`,async t=>{
  const f=retryFixture(t,{fixed:false});f.selected.requestId=path.basename(f.job);fs.unlinkSync(path.join(f.job,'operation-ref.json'));
  fs.writeFileSync(path.join(f.job,'request.json'),JSON.stringify({requestId:change==='request-id'?randomUUID():f.selected.requestId,
    request:{kind:change==='kind'?'recover':'update'}}));
  await assert.rejects(f.handlers['nora:operation-resume']({sender:null},{operationId:f.selected.operationId,snapshotSequence:4,runId:'unbound-ref'}));
  assert.equal(f.calls.length,0);
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
