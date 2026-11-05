const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {createRequire}=require('node:module');
const {parse}=require('../installer/desktop/node_modules/acorn');
const mainFile=path.join(__dirname,'../installer/desktop/main.js');
const source=fs.readFileSync(mainFile,'utf8'),tree=parse(source,{ecmaVersion:'latest'}),nodes=[];
function walk(node){if(!node||typeof node!=='object')return;if(node.type)nodes.push(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
walk(tree);
function definition(name){const node=nodes.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name||node.type==='VariableDeclarator'&&node.id.name===name);assert.ok(node,name);return node.type==='VariableDeclarator'?`const ${source.slice(node.start,node.end)};`:source.slice(node.start,node.end);}
function registration(name){const node=nodes.find(node=>node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value===name);assert.ok(node,name);return source.slice(node.start,node.end);}
const nativeRequire=createRequire(mainFile);
const failure=(message,details)=>Object.assign(new Error(message),details);
test('APP receipt registration uses logical core paths without inspecting damaged core directories',async()=>{
  const calls=[];
  const context=vm.createContext({path,ISOLATED_TEST:false,process:{execPath:'/app/launcher',resourcesPath:'/app/resources',
    env:{NORA_HERMES_HOME:'/owned/custom-hermes',NORA_TAVERN_INSTALL_ROOT:'/owned/custom-tavern'}},
    app:{isPackaged:true,getVersion:()=> '2.2.9'},CHANNEL:'stable',DEFAULT_PORT:8799,
    noraHome:()=>'/owned',hermesHome:()=>assert.fail('APP cannot inspect the core path'),installRoot:()=>assert.fail('APP cannot inspect the core path'),
    readInstallerState:()=>({}),diagnostics:{error:()=>assert.fail('APP registration must succeed independently')},
    require:name=>{assert.equal(name,'./launcher-capability');return {register:async options=>{calls.push(options);return 'registered';}};}});
  vm.runInContext(definition('registerCapabilities'),context);
  assert.equal(await vm.runInContext('registerCapabilities({appOnly:true})',context),'registered');
  assert.equal(calls.length,1);assert.equal(calls[0].includeCore,false);
  assert.equal(calls[0].hermesHome,'/owned/custom-hermes');assert.equal(calls[0].installRoot,'/owned/custom-tavern');
});
test('core capability registration binds the verified installation port instead of the APP cache',async()=>{
  const selected={operationId:randomUUID()},calls=[];
  const context=vm.createContext({path,process:{execPath:'/app/launcher',resourcesPath:'/app/resources'},
    app:{isPackaged:true,getVersion:()=> '2.2.9'},CHANNEL:'stable',
    noraHome:()=>'/owned',hermesHome:()=>'/owned/custom-hermes',installRoot:()=>'/owned/custom-tavern',
    readInstallerState:()=>assert.fail('the APP cache has no authority over the core receipt'),
    operations:()=>({snapshot:async()=>selected}),installationPort:operation=>{assert.equal(operation,selected);return 18799;},
    diagnostics:{error:()=>assert.fail('core registration must succeed')},
    require:()=>({register:async options=>calls.push(options)})});
  vm.runInContext(definition('registerCapabilities'),context);
  await vm.runInContext('registerCapabilities()',context);
  assert.equal(calls.length,1);assert.equal(calls[0].includeCore,true);assert.equal(calls[0].port,18799);
});
function snapshot(directory){
  return fs.readdirSync(directory).sort().map(name=>{const file=path.join(directory,name),stat=fs.lstatSync(file);
    return [name,stat.ino,stat.isDirectory()?snapshot(file):fs.readFileSync(file,'hex')];});
}
function retryFixture(t,{fixed=true,legacy=false,kind='update',app=false}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-desktop-route-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const operationId=randomUUID(),requestId=randomUUID(),job=path.join(home,'installer/update-jobs',requestId);
  fs.mkdirSync(job,{recursive:true});fs.writeFileSync(path.join(job,'operation-ref.json'),JSON.stringify({operationId}));
  fs.writeFileSync(path.join(home,'user-story.json'),'preserved user data');
  const selected={operationId,requestId,kind,snapshotSequence:4,effectState:'changed',allowedActions:['recover','logs'],
    target:{request:{action:kind,port:18799,tag:'v2.5.2',...(app?{launcherOnly:true}:{})},
      ...(fixed?{releasePlan:{client:app?'app':'updater',tag:'v2.5.2'}}:{})}};
  const sequence=legacy?{requests:{core:requestId,launcher:randomUUID()}}:null;
  if(sequence)fs.writeFileSync(path.join(home,'installer/current-update-sequence.json'),JSON.stringify(sequence));
  const calls=[],handlers={},controller={snapshot:async()=>selected,
    resume:async(id,options)=>{calls.push({kind:'resume',id,options});return {...selected,state:'succeeded'};},
    recover:async(id,options)=>{calls.push({kind:'recover',id,options});return {...selected,state:'rolled-back'};},
    recheck:async(id,options)=>{calls.push({kind:'recheck',id,options});return selected;}};
  const context=vm.createContext({fs,path,require:nativeRequire,activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    noraHome:()=>home,installerDirectory:()=>path.join(home,'installer'),launcherError:failure,rememberOperationFailure(){},
    operations:()=>controller,handle:(name,callback)=>{handlers[name]=callback;},statusRequest:null,finishOperationTelemetry(){},registerCapabilities(){},
    requireOperationResult:operation=>operation,ensureAppHelperRuntime:async options=>calls.push({kind:'runtime',options}),
    recoverLauncher:async options=>{calls.push({kind:'app-recover',options});return {state:'rolled-back',operationId:options.expectedOperationId};}});
  for(const name of ['ownsDesktopOperation','projectDesktopOperation','operationRequest'])vm.runInContext(definition(name),context);
  const loop=nodes.find(node=>node.type==='ForOfStatement'&&node.left.declarations?.[0]?.id.name==='mode'&&source.slice(node.start,node.end).includes('nora:operation-'));
  assert.ok(loop);vm.runInContext(source.slice(loop.start,loop.end),context);
  vm.runInContext(registration('nora:operation-recheck'),context);
  return {home,selected,sequence,job,calls,handlers,controller,context,payload:{operationId,snapshotSequence:4,runId:'same-operation'}};
}

for(const fixed of [true,false])for(const mode of ['resume','recover','recheck'])
  test(`GUI ${mode} cannot take over a core update ${fixed?'after':'before'} release selection`,async t=>{
    const f=retryFixture(t,{fixed}),before=snapshot(f.home),record=JSON.stringify(f.selected);
    await assert.rejects(f.handlers['nora:operation-'+mode]({sender:null},f.payload),{code:'CORE_UPDATE_CHAT_REQUIRED'});
    assert.deepEqual(f.calls,[]);assert.deepEqual(snapshot(f.home),before);assert.equal(JSON.stringify(f.selected),record);
  });
for(const evidence of ['proven-history','caller-label','missing-job','malformed-reference','missing-reference',
  'unbound-request','wrong-kind','unrelated-malformed-job','different-sequence-request'])
  test(`historical ${evidence} remains read-only without changing core effects or user data`,async t=>{
    const f=retryFixture(t,{fixed:false,legacy:true});
    if(evidence==='caller-label')f.selected.legacyDesktopRecovery=true;
    if(evidence==='missing-job')fs.rmSync(f.job,{recursive:true});
    if(evidence==='malformed-reference')fs.writeFileSync(path.join(f.job,'operation-ref.json'),'not-json');
    if(['missing-reference','unbound-request','wrong-kind'].includes(evidence)){
      fs.unlinkSync(path.join(f.job,'operation-ref.json'));
      fs.writeFileSync(path.join(f.job,'request.json'),JSON.stringify({requestId:evidence==='unbound-request'?randomUUID():f.selected.requestId,
        request:{kind:evidence==='wrong-kind'?'recover':'update'}}));
    }
    if(evidence==='unrelated-malformed-job'){
      const other=path.join(path.dirname(f.job),randomUUID());fs.mkdirSync(other);fs.writeFileSync(path.join(other,'operation-ref.json'),'not-json');
    }
    if(evidence==='different-sequence-request'){
      f.sequence.requests.core=randomUUID();fs.writeFileSync(path.join(f.home,'installer/current-update-sequence.json'),JSON.stringify(f.sequence));
    }
    const before=snapshot(f.home),record=JSON.stringify(f.selected);
    for(const mode of ['resume','recover','recheck'])
      await assert.rejects(f.handlers['nora:operation-'+mode]({sender:null},f.payload),{code:'CORE_UPDATE_CHAT_REQUIRED'});
    assert.deepEqual(f.calls,[]);assert.deepEqual(snapshot(f.home),before);assert.equal(JSON.stringify(f.selected),record);
  });
for(const kind of ['install','model','pair','start','stop','restart','shutdown'])
  test(`existing desktop ${kind} recovery retains its controller and operation identity`,async t=>{
    const f=retryFixture(t,{kind});const result=await f.handlers['nora:operation-recover']({sender:null},f.payload);
    assert.equal(result.operationId,f.selected.operationId);assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].kind,'recover');assert.equal(f.calls[0].id,f.selected.operationId);
    assert.equal(f.calls[0].options.snapshotSequence,4);assert.equal(f.context.activeRun,false);
  });
test('APP recovery uses only its own helper and original operation',async t=>{
  const f=retryFixture(t,{app:true});await f.handlers['nora:operation-recover']({sender:null},f.payload);
  assert.deepEqual(f.calls.map(call=>call.kind),['app-recover']);assert.equal(f.calls[0].options.expectedOperationId,f.selected.operationId);
});
test('APP resume refreshes its helper before continuing the same operation',async t=>{
  const f=retryFixture(t,{app:true});await f.handlers['nora:operation-resume']({sender:null},f.payload);
  assert.deepEqual(f.calls.map(call=>call.kind),['runtime','resume']);assert.equal(f.calls[0].options.refresh,true);assert.equal(f.calls[1].id,f.selected.operationId);
});
test('GUI retry rejects a changed desktop snapshot before submitting anything',async t=>{
  const f=retryFixture(t,{kind:'model'});
  await assert.rejects(f.handlers['nora:operation-resume']({sender:null},{...f.payload,snapshotSequence:3}),{code:'OPERATION_SNAPSHOT_CHANGED'});assert.deepEqual(f.calls,[]);
});
test('core projection is read-only without rewriting historical effects or permissions',t=>{
  const f=retryFixture(t,{legacy:true}),before=JSON.stringify(f.selected);
  const projected=vm.runInContext('projectDesktopOperation',f.context)(f.selected);
  assert.equal(projected.readOnly,true);assert.deepEqual(Array.from(projected.allowedActions),['logs']);assert.equal(JSON.stringify(f.selected),before);
  assert.deepEqual(f.selected.allowedActions,['recover','logs']);f.selected.target.request.launcherOnly=true;
  assert.equal(vm.runInContext('projectDesktopOperation',f.context)(f.selected),f.selected);
});
test('desktop recheck preserves effect evidence and refreshes APP only for APP-owned tasks',async t=>{
  for(const app of [false,true]){
    const f=retryFixture(t,{kind:app?'update':'install',app}),before=JSON.stringify(f.selected);
    const reply=await f.handlers['nora:operation-recheck']({},f.payload);
    assert.equal(reply.operation,f.selected);assert.equal(JSON.stringify(f.selected),before);
    assert.deepEqual(f.calls.map(call=>call.kind),app?['runtime','recheck']:['recheck']);
    assert.equal(f.calls.at(-1).options.snapshotSequence,4);assert.equal(f.context.activeRun,false);
  }
});

function continuation({initial='pending',checked='succeeded',missing=false,core=false,proofError=false}={}){
  const calls=[],plan={operationId:randomUUID(),target:'v2.6.5',planDigest:'a'.repeat(64)},job='/owned/installer/launcher-update/job';
  const operation={operationId:plan.operationId,requestId:randomUUID(),snapshotSequence:5,state:initial,kind:'update',handoffRef:job,planDigest:plan.planDigest,target:{request:{launcherOnly:!core}}};
  const context=vm.createContext({require:nativeRequire,ensureAppHelperRuntime:async()=>calls.push('runtime'),noraHome:()=>'/owned',
    process:{execPath:'/app/launcher'},app:{getVersion:()=> '2.2.9'},launcherError:failure,
    launcherUpdate:{resume:(actual,options)=>{assert.equal(actual,job);if(options.operation)calls.push('acknowledge');return missing?null:plan;},
      waitHandoff:async options=>{assert.equal(options.operation,operation);calls.push('proof');if(proofError)throw new Error('unconfirmed proof');}},
    launcherRecoveryOptions:()=>({}),operations:()=>({snapshot:async()=>operation,
      recheck:async(id,options)=>{assert.equal(id,plan.operationId);assert.equal(options.snapshotSequence,5);calls.push('recheck');return {...operation,state:checked};},
      resume:async(id,options)=>{assert.equal(id,plan.operationId);assert.equal(options.handoff.job,job);assert.equal(options.handoff.planDigest,plan.planDigest);
        assert.equal(options.runId,operation.requestId);calls.push('resume');return {...operation,state:'succeeded'};}}),
    readInstallerState:()=>({}),writeInstallerState:value=>calls.push(value.resumeTarget?'pending-state':'idle-state'),rememberOperationFailure(){},
    finishOperationTelemetry:value=>calls.push('finish:'+value.state),registerCapabilities:async()=>calls.push('register'),
    requireOperationResult:(value,options)=>{assert.equal(options.recover,value.state==='rolled-back');return value;}});
  for(const name of ['ownsDesktopOperation','continueSelfUpdate'])vm.runInContext(definition(name),context);
  return {calls,operation,original:JSON.stringify(operation),run:()=>vm.runInContext('continueSelfUpdate',context)(job,{})};
}
for(const state of ['succeeded','rolled-back'])test(`startup APP never resumes an already ${state} operation`,async()=>{
  const f=continuation({initial:state}),result=await f.run();assert.equal(result.state,state);
  assert.deepEqual(f.calls,['runtime','acknowledge','finish:'+state,'idle-state','register']);assert.equal(JSON.stringify(f.operation),f.original);
});
for(const checked of ['succeeded','rolled-back','pending'])test(`startup APP consumes terminal proof and rechecks before ${checked} continuation`,async()=>{
  const f=continuation({checked}),result=await f.run();assert.deepEqual(f.calls.slice(0,4),['runtime','acknowledge','proof','recheck']);
  assert.equal(f.calls.includes('resume'),checked==='pending');assert.equal(result.state,checked==='pending'?'succeeded':checked);
  assert.equal(JSON.stringify(f.operation),f.original,'startup bookkeeping never edits the original record');
});
test('unknown APP proof and joint ownership cannot become successful startup continuations',async()=>{
  for(const options of [{proofError:true},{core:true}]){
    const f=continuation(options);await assert.rejects(f.run());assert.equal(f.calls.includes('resume'),false);if(options.core)assert.equal(f.calls.includes('acknowledge'),false);
    assert.equal(f.calls.includes('idle-state'),false);assert.equal(f.calls.includes('register'),false);assert.equal(JSON.stringify(f.operation),f.original);
  }
  const missing=continuation({missing:true});assert.equal(await missing.run(),null);assert.deepEqual(missing.calls,['runtime']);
});
for(const outcome of ['succeeded','rolled-back','unconfirmed','missing-plan'])test(`startup handoff consumes its transient marker once (${outcome})`,async()=>{
  const callback=nodes.find(node=>node.type==='ArrowFunctionExpression'&&source.slice(node.start,node.end).includes('await continueSelfUpdate(SELF_UPDATE_JOB,window.webContents)')
    &&node.body?.type==='BlockStatement'&&node.body.body[0]?.type==='TryStatement');assert.ok(callback);
  const calls=[],context=vm.createContext({SELF_UPDATE_JOB:'/owned/job',activeRun:true,activeOperationContext:{operationId:randomUUID()},window:{webContents:{}},
    continueSelfUpdate:async()=>{calls.push(outcome);if(outcome==='unconfirmed')throw Error('proof unavailable');return outcome==='missing-plan'?null:{};},
    registerCapabilities:async()=>calls.push('refresh-core-receipt'),diagnostics:{error:()=>calls.push('logged')}});
  await vm.runInContext(`(${source.slice(callback.start,callback.end)})`,context)();
  assert.equal(context.SELF_UPDATE_JOB,null);assert.equal(context.activeRun,false);assert.equal(context.activeOperationContext,null);
  assert.equal(calls.filter(call=>call===outcome).length,1);assert.equal(calls.includes('logged'),outcome==='unconfirmed');
});

test('version checks start independently, retain core failure, and expose the APP fixed plan for its button',async()=>{
  const calls=[];let finishCore,finishApp;
  const context=vm.createContext({Promise,releaseCheckRequest:null,CHANNEL:'stable',localReleaseDirectory:null,
    trackLauncher:(_action,_stage,run)=>run(),releaseMetadataCache:()=>({}),updateFetch:()=>{},app:{getVersion:()=> '2.2.8'},installRoot:()=>'/missing/core',
    diagnostics:{clean:value=>value},releases:{UPDATER_CAPABILITIES:{},check:options=>{calls.push(['core',options]);return new Promise(resolve=>{finishCore=resolve;});},
      checkApp:options=>{calls.push(['app',options]);return new Promise(resolve=>{finishApp=resolve;});}}});
  vm.runInContext(definition('checkRelease'),context);const check=vm.runInContext('checkRelease',context),pending=check();
  assert.deepEqual(calls.map(call=>call[0]),['core','app']);assert.equal(calls[0][1].client,'updater');assert.equal(calls[0][1].launcherDiscovery,undefined);assert.equal(check(),pending);
  finishCore({state:'blocked',current:'v2.6.4',latest:null,releaseAvailable:false,compatibilityError:'core bootstrap rejected',releasePlan:{client:'updater'}});
  finishApp({launcherState:'available',launcherUpdateAvailable:true,launcherInstallable:true,releasePlan:{client:'app'},releaseTag:'v2.6.5'});
  const result=await pending;assert.equal(result.coreState,'blocked');assert.equal(result.compatibilityError,'core bootstrap rejected');
  assert.equal(result.launcherState,'available');assert.equal(result.releasePlan.client,'app');assert.equal(result.state,'available');assert.equal(context.releaseCheckRequest,null);
});
for(const broken of ['core','app'])test(`a failed ${broken} reader does not erase the other component's version facts`,async()=>{
  const context=vm.createContext({Promise,releaseCheckRequest:null,CHANNEL:'stable',localReleaseDirectory:null,trackLauncher:(_a,_s,run)=>run(),
    releaseMetadataCache:()=>({}),updateFetch:()=>{},app:{getVersion:()=> '2.2.8'},installRoot:()=>'/core',diagnostics:{clean:value=>value},
    releases:{UPDATER_CAPABILITIES:{},check:async()=>{if(broken==='core')throw Error('core lookup failed');return {state:'current',current:'v2.6.4',latest:'v2.6.4',releaseAvailable:false,releasePlan:{client:'updater'}};},
      checkApp:async()=>{if(broken==='app')throw Error('APP lookup failed');return {launcherState:'available',launcherUpdateAvailable:true,releasePlan:{client:'app'}};}}});
  vm.runInContext(definition('checkRelease'),context);const result=await vm.runInContext('checkRelease()',context);
  assert.equal(result.coreState,broken==='core'?'unavailable':'current');assert.equal(result.launcherState,broken==='app'?'unavailable':'available');assert.equal(result.releasePlan?.client,broken==='app'?undefined:'app');
});
test('a Beta desktop keeps its channel when both version checks are unavailable',async()=>{
  const context=vm.createContext({Promise,releaseCheckRequest:null,CHANNEL:'beta',localReleaseDirectory:null,
    trackLauncher:(_action,_stage,run)=>run(),releaseMetadataCache:()=>({}),updateFetch:()=>{},
    app:{getVersion:()=> '2.2.8'},installRoot:()=>'/core',diagnostics:{clean:value=>value},
    releases:{UPDATER_CAPABILITIES:{},check:async()=>({state:'unavailable',error:'offline'}),
      checkApp:async()=>{throw Error('offline');}}});
  vm.runInContext(definition('checkRelease'),context);
  const result=await vm.runInContext('checkRelease()',context);
  assert.equal(result.coreState,'unavailable');
  assert.equal(result.launcherState,'unavailable');
  assert.equal(result.channel,'beta');
});
for(const broken of ['core-location','core-reader','app-reader'])test(`synchronous ${broken} failure stays inside its own version result`,async()=>{
  const calls=[];
  const context=vm.createContext({Promise,releaseCheckRequest:null,CHANNEL:'stable',localReleaseDirectory:null,trackLauncher:(_a,_s,run)=>run(),
    releaseMetadataCache:()=>({}),updateFetch:()=>{},app:{getVersion:()=> '2.2.8'},
    installRoot:()=>{if(broken==='core-location')throw Error('core location cannot be resolved');return '/core';},diagnostics:{clean:value=>value},
    releases:{UPDATER_CAPABILITIES:{},check:()=>{calls.push('core');if(broken==='core-reader')throw Error('synchronous core lookup failed');
      return {state:'current',current:'v2.6.4',latest:'v2.6.4',releaseAvailable:false};},
      checkApp:()=>{calls.push('app');if(broken==='app-reader')throw Error('synchronous APP lookup failed');
        return {launcherState:'available',launcherUpdateAvailable:true,launcherInstallable:true,launcherLatestConfirmed:true,
          launcherCheckedAt:123,releasePlan:{client:'app'},releaseTag:'v2.6.5'};}}});
  vm.runInContext(definition('checkRelease'),context);const result=await vm.runInContext('checkRelease()',context);
  assert.equal(result.coreState,broken==='app-reader'?'current':'unavailable');
  assert.equal(result.launcherState,broken==='app-reader'?'unavailable':'available');
  assert.deepEqual(calls,broken==='core-location'?['app']:['core','app']);assert.equal(context.releaseCheckRequest,null);
  if(broken==='app-reader')assert.match(result.launcherError,/synchronous APP/);
  else {assert.match(result.error,/core/);assert.equal(result.releasePlan.client,'app');assert.equal(result.launcherLatestConfirmed,true);}
});
for(const handoff of [true,false])test(`main APP adapter delegates once and preserves ${handoff?'handoff':'ordinary'} completion`,async()=>{
  const calls=[],operationContext={},networkPolicy={},directory='/owned/operations/uuid',sender={},result={handoff};
  const context=vm.createContext({AbortController,releaseAbort:null,LOCAL_TEST:null,CHANNEL:'stable',localReleaseDirectory:null,updateFetch:()=>{},
    ensureAppHelperRuntime:async()=>{},launcherRecoveryOptions:()=>({verifiedRuntime:true}),releaseMetadataCache:()=>({}),app:{getVersion:()=> '2.2.8',isPackaged:true},
    launcherUpdate:{start:async options=>{calls.push(options);options.onEvent({event:'progress'});return result;}},spawnMaintenance(){},
    sendBridgeEvent:(actual,id)=>{assert.equal(actual,sender);assert.equal(id,'app-run');},readInstallerState:()=>({}),writeInstallerState:value=>calls.push(value),diagnostics:{finish:state=>calls.push(state)}});
  vm.runInContext(definition('runLauncherUpdate'),context);
  assert.equal(await vm.runInContext('runLauncherUpdate',context)(operationContext,{payload:{tag:'v2.6.5',runId:'app-run'},event:{sender},networkPolicy,operationDirectory:directory}),result);
  assert.equal(calls[0].context,operationContext);assert.equal(calls[0].payloadTag,'v2.6.5');assert.equal(calls[0].networkPolicy,networkPolicy);
  assert.equal(calls[0].operationDirectory,directory);assert.equal(calls[0].verifiedRuntime,true);assert.equal(context.releaseAbort,null);assert.equal(calls.at(-1),handoff?'restarting':'success');assert.equal(calls.length,handoff?2:3);
});

// The independent updater now owns the removed desktop-to-core admission path.
// Exercise its actual wait function, preserving pending and identity safeguards.
const updaterSource=fs.readFileSync(path.join(__dirname,'../installer/desktop/updater-task.js'),'utf8');
const waitNode=parse(updaterSource,{ecmaVersion:'latest'}).body.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='wait');assert.ok(waitNode);
function waitFixture(states){
  const id=randomUUID(),calls=[],events=[];
  const context=vm.createContext({latest:()=>id,terminal:new Set(['succeeded','failed','rolled-back','cancelled','blocked','interrupted']),
    failure:(code,message)=>Object.assign(new Error(message),{code}),query:async(home,requestId)=>{calls.push({home,requestId});return states.shift();},delay:async()=>{}});
  vm.runInContext(updaterSource.slice(waitNode.start,waitNode.end),context);
  return {id,calls,events,run:()=>vm.runInContext('wait',context)('/owned',id,{onEvent:event=>events.push(event),pollMs:0})};
}
test('slow independent admission waits for the same request instead of inventing update failure',async()=>{
  const f=waitFixture([{status:'submitting',busy:null,settled:false},{status:'in-progress',busy:true,settled:false,operation:{snapshotSequence:4}},
    {status:'succeeded',busy:false,settled:true,operation:{snapshotSequence:5,state:'succeeded'}}]);
  const result=await f.run();assert.equal(result.status,'succeeded');assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.requestId===f.id));assert.equal(f.events.at(-1).operation.snapshotSequence,5);
});
test('independent admission failure remains an error and unknown identity never counts as settled',async()=>{
  const failed=waitFixture([{status:'error',requestId:randomUUID(),settled:true,code:'UPDATER_START_FAILED'}]);assert.equal((await failed.run()).code,'UPDATER_START_FAILED');assert.equal(failed.calls.length,1);
  const unknown=waitFixture([{status:'inspection-required',busy:null,settled:false,code:'UPDATER_JOB_INVALID',message:'invalid identity'}]);await assert.rejects(unknown.run(),{code:'UPDATER_JOB_INVALID'});assert.equal(unknown.calls.length,1);
});
