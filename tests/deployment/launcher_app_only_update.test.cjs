const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const os=require('node:os');
const {createRequire}=require('node:module');
const {parse}=require('../installer/desktop/node_modules/acorn');
const mainFile=path.join(__dirname,'../installer/desktop/main.js');
const source=fs.readFileSync(mainFile,'utf8'),realRequire=createRequire(mainFile),nodes=[];
function walk(node){if(!node||typeof node!=='object')return;if(node.type)nodes.push(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
walk(parse(source,{ecmaVersion:'latest'}));
function definition(name){const node=nodes.find(node=>node.type==='FunctionDeclaration'&&node.id?.name===name||node.type==='VariableDeclarator'&&node.id?.name===name);assert.ok(node,name);return node.type==='VariableDeclarator'?`const ${source.slice(node.start,node.end)};`:source.slice(node.start,node.end);}
function load(context,...names){for(const name of names)vm.runInContext(definition(name),context);}
const failure=(message,details)=>Object.assign(new Error(message),details);
function appStartFixture(seams){
  const moduleSource=fs.readFileSync(path.join(path.dirname(mainFile),'launcher-update.js'),'utf8');
  const node=parse(moduleSource,{ecmaVersion:'latest'}).body.find(value=>value.type==='FunctionDeclaration'&&value.id.name==='start');
  assert.ok(node);
  return vm.runInNewContext(`(${moduleSource.slice(node.start,node.end)})`,{path,launcherError:failure,
    appOperation:operation=>operation.target.request.launcherOnly===true,...seams});
}
function tree(directory){return fs.readdirSync(directory).sort().map(name=>{const file=path.join(directory,name),stat=fs.lstatSync(file);return [name,stat.ino,stat.isDirectory()?tree(file):fs.readFileSync(file,'hex')];});}
function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-only-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  for(const name of ['hermes/skills/creative/tavern/SKILL.md','hermes/config.yaml','tavern/tavern-state/chats/story.jsonl',
    'tavern/tavern-updates/installed-manifest.json','tavern/tavern-updates/installed.json',
    'installer/current-update-sequence.json','installer/system-update/journal.json']){
    const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'unchanged malformed or user-owned content: '+name);
  }
  return {home,protectedTree:()=>tree(home)};
}
test('desktop APP version check succeeds when even resolving the core directory throws',async()=>{
  const plan={schema:'nora-release-plan/1',client:'app',mode:'update',tag:'v2.6.0'};
  const context=vm.createContext({releaseCheckRequest:null,localReleaseDirectory:null,CHANNEL:'stable',updateFetch:null,
    releaseMetadataCache:()=>({}),app:{getVersion:()=> '2.2.7'},diagnostics:{clean:String},
    installRoot:()=>{throw Object.assign(new Error('core directory unreadable'),{code:'EACCES'});},
    trackLauncher:async(_action,_stage,work)=>work(),releases:{UPDATER_CAPABILITIES:{},
      check:async()=>assert.fail('core query must not start without its location'),
      checkApp:async()=>({releasePlan:plan,releaseTag:plan.tag,launcherVersion:'2.2.7',launcherLatest:'2.2.8',
        launcherUpdateAvailable:true,launcherInstallable:true,launcherState:'available'})}});
  vm.runInContext(definition('checkRelease'),context);
  const checked=await context.checkRelease();
  assert.equal(checked.releasePlan,plan);
  assert.equal(checked.launcherInstallable,true);
  assert.equal(checked.launcherState,'available');
  assert.match(checked.error,/core directory unreadable/);
});

test('fresh APP execution reaches its owned updater without any core, Hermes or history reads',async()=>{
  const helper={command:'/isolated/app-python'},result={verification:'confirmed',
    value:{launcherVersion:'2.2.8',appUpdateComplete:true,coreUpdateComplete:false}};
  const operation={operationId:'00000000-0000-4000-8000-000000000001',kind:'update',
    target:{request:{action:'update',launcherOnly:true}}};
  const calls=[],lease={assertActive(){}};
  const forbidden=()=>assert.fail('APP execution must not inspect core, Hermes or retained history');
  const context=vm.createContext({path,fs,process,AbortController,os,LOCAL_TEST:null,CHANNEL:'stable',
    localReleaseDirectory:null,releaseAbort:null,activeOperationContext:null,cancelled:false,launcherError:failure,
    formatUserError:error=>error.message,require:createRequire(path.join(__dirname,'../installer/desktop/main.js')),
    installerDirectory:()=>'/isolated/installer',noraHome:()=>'/isolated',hermesHome:forbidden,
    installRoot:forbidden,payloadDirectory:forbidden,installationPort:forbidden,runBridge:forbidden,
    systemUpdate:{inspect:forbidden},app:{getVersion:()=> '2.2.8',isPackaged:true},telemetry:null,
    diagnostics:{addSecret(){},begin(){},write(){},finish(){},error(){}},
    readInstallerState:()=>({phase:'ready',milestones:[],setupCompleted:true}),writeInstallerState(){},
    launcherUpdate:{start:async options=>{calls.push(options);assert.equal(options.context.snapshot,operation);
      assert.equal(options.appHelperRuntime,helper);return result;}},
    launcherRecoveryOptions:()=>({home:'/isolated',python:helper.command,appHelperRuntime:helper}),
    ensureAppHelperRuntime:async options=>{assert.equal(options.lease,lease);return helper;},
    releaseMetadataCache:()=>({}),updateFetch:null,sendBridgeEvent(){}});
  for(const name of ['runLauncherUpdate','executeAction'])vm.runInContext(definition(name),context);
  assert.equal(await vm.runInContext('executeAction',context)({...operation,snapshot:operation,lease},{event:{sender:null}}),result);
  assert.equal(calls.length,1);
});

test('historical APP restoration holds the shared writer for preparation and leaves the core record untouched',async()=>{
  const calls=[],job='/owned/installer/launcher-update/job-historic';
  const operation={operationId:'previous',ownerEpoch:5,snapshotSequence:7,planDigest:'a'.repeat(64),
    handoffRef:job,kind:'update',target:{request:{includeLauncher:true}}};
  const lease={assertActive:()=>calls.push('owned'),release:async()=>calls.push('released')};
  const context=vm.createContext({path,activeOperationContext:null,launcherError:failure,
    appHelperRuntimeValue:{command:'/app/python',env:{}},operationLock:{},installerDirectory:()=>'/owned/installer',
    installerRoot:()=>'/app/resources',launcherRecoveryOptions:()=>({}),
    operations:()=>({snapshot:async(id,options)=>{assert.equal(id,operation.operationId);assert.equal(options.inspectEffects,false);return operation;}}),
    acquireInspected:async options=>{assert.equal(options.operationId,operation.operationId);assert.equal(options.ownerEpoch,5);calls.push('acquired');return lease;},
    ensureAppHelperRuntime:async options=>{assert.equal(options.lease,lease);calls.push('private-cache');},
    launcherUpdate:{restore:async options=>{
      assert.equal(options.historicalAppSegment,true);assert.equal(options.job,job);assert.equal(options.operation,operation);
      if(options.context){options.context.check();calls.push('prepared');return {parentCreationTime:123};}
      assert.equal(options.parentCreationTime,123);calls.push('detached');return {appSegmentOnly:true,restarting:true};
    }}});
  load(context,'restoreHistoricalAppSegment');
  const original=JSON.stringify(operation);
  const result=await context.restoreHistoricalAppSegment(operation,job);
  assert.equal(result.appSegmentOnly,true);assert.equal(JSON.stringify(operation),original);
  assert.deepEqual(calls,['acquired','private-cache','owned','prepared','released','detached']);
});

test('handoff reconciliation prepares the private APP helper under the same writer',async()=>{
  const calls=[],operation={kind:'update',handoffRef:'/owned/job',target:{request:{launcherOnly:true}}};
  const active={lease:{assertActive:()=>calls.push('writer')}},result={verification:'confirmed'};
  const context=vm.createContext({operationController:null,operationLock:{},operationExecutors:{},
    operationRecoverers:{},operationRecheckers:{},operationEvidence:{},installerDirectory:()=>'/owned/installer',
    verifyHistoricalInstallRetry:()=>assert.fail('APP handoff cannot inspect a historical first install'),
    activeOperationContext:null,createOperationController:options=>options,
    ensureAppHelperRuntime:async options=>{assert.equal(options.lease,active.lease);options.lease.assertActive();calls.push('private-helper');},
    maintenancePolicy:()=>({reconcileHandoff:async(record,execution)=>{
      assert.equal(record,operation);assert.equal(execution,active);assert.equal(context.activeOperationContext,active);
      calls.push('reconciled');return result;
    }})});
  load(context,'operations');
  assert.equal(await context.operations().verifyRestoredHandoff(operation,active),result);
  assert.deepEqual(calls,['writer','private-helper','reconciled']);
  assert.equal(context.activeOperationContext,null);
});

test('the visible same-operation APP retry launches its prepared replacement helper',async()=>{
  const handler=nodes.find(node=>node.type==='CallExpression'&&node.callee.name==='handle'
    &&node.arguments[0]?.quasis?.[0]?.value?.raw==='nora:operation-');
  assert.ok(handler);
  const calls=[],operationId='11111111-1111-4111-8111-111111111111';
  const selected={operationId,snapshotSequence:2,kind:'update',target:{request:{launcherOnly:true}}};
  const context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    launcherError:failure,operationRequest:()=>({}),desktopSequenceForOperation:()=>null,sharedUpdateJob:()=>null,
    operations:()=>({snapshot:async()=>selected,resume:async()=>({...selected,state:'awaiting-handoff',handoffRef:'/test/job'})}),
    ensureAppHelperRuntime:async()=>{},ownsDesktopOperation:()=>true,
    finishOperationTelemetry(){},registerCapabilities:async()=>{},requireOperationResult:value=>value,
    launcherUpdate:{launchHandoff:async options=>calls.push(['helper',options.job])},launcherRecoveryOptions:()=>({}),
    hermesHome:()=>'/isolated/hermes',path,process,quitReady:false,
    setImmediate:callback=>callback(),app:{quit:()=>calls.push(['quit'])}});
  const dispatcher=nodes.find(node=>node.type==='FunctionDeclaration'&&node.id?.name==='dispatchLauncherHandoff');
  if(dispatcher)vm.runInContext(source.slice(dispatcher.start,dispatcher.end),context);
  const callback=handler.arguments[1];
  const retry=vm.runInContext(`const mode='resume';(${source.slice(callback.start,callback.end)})`,context);
  const result=await retry({sender:null},{operationId,snapshotSequence:2});
  assert.equal(result.state,'awaiting-handoff');
  assert.deepEqual(calls,[['helper','/test/job'],['quit']]);
  assert.equal(context.quitReady,true);
});
for(const [entry,winerror,schema] of [['original task',33,'nora-app-sharing-failure/1'],
  ['latest block',5,'nora-app-move-denied/1'],['fresh request',5,'nora-app-move-denied/1']])
test(`the desktop retry keeps the fixed APP target and closed handoffs via ${entry}`,async t=>{
  const f=fixture(t),{createOperationController}=realRequire('./operation-state');
  const {createTestOperationLock}=require('./launcher_operation_test_lock.cjs');
  const updates=path.join(f.home,'installer','launcher-update');fs.mkdirSync(updates,{recursive:true});
  const oldJob=path.join(updates,'job-original');fs.mkdirSync(oldJob);
  const marker=path.join(oldJob,'original-evidence');fs.writeFileSync(marker,'first fault remains');
  const preparedJobs=[],dispatched=[],sharing={schema,phase:'moving-old',winerror};
  let now=Date.parse('2026-11-04T00:00:00Z'),evidenceTrusted=true;
  const plan={schema:'nora-release-plan/1',client:'app',mode:'update',tag:'v2.6.5',platform:'win32',
    manifestRef:{file:'release-plan/fixed.json'},launcherManifest:{version:'2.2.9'}};
  const helperOutcome=operation=>({status:'cancelled',verification:'confirmed',effectState:'untouched',busy:false,
    workerOffline:evidenceTrusted,operationId:operation.operationId,planDigest:operation.planDigest,job:operation.handoffRef,
    value:{notAppliedVerification:'confirmed',appSharingFailure:sharing},sharingFailure:sharing,
    failure:Object.assign(new Error('original APP share violation'),{code:'EACCES'})});
  const runtime={command:'/fixture/app-python'};
  const start=appStartFixture({releases:()=>({validateAppPlan:fixed=>fixed,selectAppPlan:async()=>plan,sealPlan:()=>plan}),
    require:name=>{assert.equal(name,'./app-helper-runtime');return {isVerified:value=>value===runtime};},
    ownedJob:job=>job,reconcile:async options=>({kind:'terminal',outcome:helperOutcome(options.operation)}),
    prepare:async options=>{assert.deepEqual(options.selectedPlan,plan);return {launcher:plan.launcherManifest};},
    prepareHandoff:async options=>{
      assert.equal(options.operation.handoffRef,null);assert.equal(options.operation.effectState,'untouched');
      const job=fs.mkdtempSync(path.join(updates,'job-retry-'));preparedJobs.push(job);return job;
    }});
  const controller=createOperationController({directory:path.join(f.home,'installer'),lock:createTestOperationLock(),
    now:()=>new Date(now).toISOString(),verifyRestoredHandoff:async operation=>helperOutcome(operation),
    observeAppEffects:async operation=>helperOutcome(operation),
    executors:{update:context=>start({context,home:f.home,launcherVersion:'2.2.8',isPackaged:true,appHelperRuntime:runtime})}});
  const handler=nodes.find(node=>node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.quasis?.[0]?.value?.raw==='nora:operation-');
  const context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    launcherError:failure,operationRequest:payload=>({snapshotSequence:payload.snapshotSequence}),
    operations:()=>controller,ensureAppHelperRuntime:async()=>runtime,ownsDesktopOperation:operation=>operation.target.request.launcherOnly===true,
    finishOperationTelemetry(){},registerCapabilities:async()=>{},requireOperationResult:value=>value,
    launcherUpdate:{launchHandoff:async options=>{assert.ok(preparedJobs.includes(options.job));dispatched.push(options.job);}},
    launcherRecoveryOptions:()=>({}),quitReady:false,setImmediate:callback=>callback(),app:{quit(){}}});
  load(context,'dispatchLauncherHandoff');
  const callback=handler.arguments[1];
  const resume=vm.runInContext(`const mode='resume';(${source.slice(callback.start,callback.end)})`,context);
  const initial=await controller.start('update',{target:{request:{action:'update',launcherOnly:true,tag:plan.tag},releasePlan:plan},
    execute:async context=>{await context.handoff(oldJob);return {handoff:true};}},'first-desktop-attempt');
  const retry=operation=>resume({sender:null},{operationId:operation.operationId,snapshotSequence:operation.snapshotSequence});
  const recheck=operation=>controller.recheck(operation.operationId,{snapshotSequence:operation.snapshotSequence});
  const failed=await recheck(initial);
  assert.equal(failed.state,'failed');assert.equal(failed.primaryFailure.code,'EACCES');
  evidenceTrusted=false;
  await assert.rejects(retry(failed),{code:'UPDATE_RECOVERY_REQUIRED'});
  evidenceTrusted=true;
  const second=await retry(failed);
  assert.equal(second.operationId,failed.operationId);assert.equal(second.state,'awaiting-handoff');assert.equal(second.attempt,2);
  assert.notEqual(second.handoffRef,oldJob);assert.ok(second.journalRefs.includes(oldJob));
  const again=await recheck(second);
  assert.equal(again.appSharingRetryAt,now+30000);assert.equal(again.allowedActions.includes('retry'),false);
  await assert.rejects(retry(again),{code:'OPERATION_ACTION_UNAVAILABLE'});
  now+=1;
  const blocked=await controller.start('update',{target:again.target},'second-desktop-request');
  assert.equal(blocked.state,'blocked');assert.equal(blocked.allowedActions.includes('retry'),false);
  now+=30000;
  let third;
  if(entry==='fresh request'){
    const request=await controller.start('update',{target:{request:again.target.request}},'fresh-request-after-cooldown');
    assert.equal(request.state,'awaiting-handoff');
    assert.notEqual(request.operationId,again.operationId);
    third=await vm.runInContext('dispatchLauncherHandoff',context)(request);
  }else{
    const ready=await controller.recheck(entry==='latest block'?blocked.operationId:again.operationId);
    assert.equal(ready.allowedActions.includes('retry'),true,'the original attempt must be available after cooldown');
    evidenceTrusted=false;
    await assert.rejects(retry(ready),{code:'UPDATE_RECOVERY_REQUIRED'});
    evidenceTrusted=true;
    third=await retry(ready);
    assert.equal(third.operationId,again.operationId);
  }
  assert.equal(third.attempt,3);assert.ok(third.journalRefs.includes(second.handoffRef));
  now+=60000;
  const exhausted=await recheck(third);
  assert.equal((await controller.snapshot()).operationId,third.operationId,'an old admission block must not hide the actual outcome');
  await assert.rejects(retry(exhausted),{code:'OPERATION_ACTION_UNAVAILABLE'});
  await assert.rejects(retry(await controller.snapshot(again.operationId)),{code:'OPERATION_ACTION_UNAVAILABLE'});
  const fourth=await controller.start('update',{target:{request:again.target.request}},'fresh-request-after-exhaustion');
  assert.equal(fourth.state,'blocked');
  assert.equal(fourth.allowedActions.includes('retry'),false);
  assert.deepEqual(dispatched,preparedJobs);assert.equal(dispatched.length,2);
  assert.equal(fs.readFileSync(marker,'utf8'),'first fault remains');
  assert.equal(exhausted.primaryFailure.code,'EACCES');
});
test('APP preparation cancellation keeps a durable binding until the original task is closed',async t=>{
  const f=fixture(t),{createOperationController}=realRequire('./operation-state');
  const {createTestOperationLock}=require('./launcher_operation_test_lock.cjs');
  const signal=new AbortController(),job=path.join(f.home,'installer','launcher-update','job-prepared');
  const plan={client:'app',mode:'update',tag:'v2.6.5'},target={request:{launcherOnly:true},releasePlan:plan};
  const installer=path.join(f.home,'installer'),operationFile=(directory,id)=>path.join(directory,'operations',id,'operation.json');
  let atCancellationCheckpoint;
  const start=appStartFixture({releases:()=>({validateAppPlan:fixed=>fixed}),
    require:name=>{assert.equal(name,'./app-helper-runtime');return {isVerified:()=>true};},
    prepare:async()=>({launcher:{version:'2.2.9'}}),prepareHandoff:async()=>{signal.abort();return job;},
    callHelper:async(options,helper,args,cwd)=>{
      assert.equal(helper,path.join(job,'replace.py'));assert.deepEqual(Array.from(args),['--recover',job]);
      assert.equal(cwd,job);
      // These are the operation bytes a new process sees if it dies just
      // after the helper confirms and checkpoints that the APP was untouched.
      atCancellationCheckpoint=fs.readFileSync(operationFile(installer,options.context.operationId));
      const durable=JSON.parse(atCancellationCheckpoint);
      assert.equal(durable.handoffRef,job);assert.equal(durable.state,'awaiting-handoff');
      assert.equal(durable.effectState,'unknown');assert.ok(!durable.journalRefs?.includes(job));
      return {untouched:true};
    }});
  const controller=createOperationController({directory:installer,lock:createTestOperationLock()});
  const cancelled=await controller.start('update',{target,execute:context=>start({context,home:f.home,launcherVersion:'2.2.8',
    isPackaged:true,appHelperRuntime:{command:'/python'},signal:signal.signal})},'cancel-app-before-dispatch');
  assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.effectState,'untouched');
  assert.equal(cancelled.handoffRef,null);assert.deepEqual(cancelled.journalRefs,[job]);

  const reopenedInstaller=path.join(f.home,'reopened','installer'),file=operationFile(reopenedInstaller,cancelled.operationId);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,atCancellationCheckpoint);
  let outcomeJob=job+'-unrelated';
  const reopened=createOperationController({directory:reopenedInstaller,lock:createTestOperationLock(),
    verifyRestoredHandoff:async record=>({status:'cancelled',verification:'confirmed',effectState:'untouched',
      workerOffline:true,busy:false,operationId:record.operationId,planDigest:record.planDigest,job:outcomeJob,
      value:{notAppliedVerification:'confirmed',launcherVersion:'2.2.8'}})});
  const unverified=await reopened.recheck(cancelled.operationId);
  assert.equal(unverified.state,'awaiting-handoff');assert.equal(unverified.effectState,'unknown');
  outcomeJob=job;
  const startup=vm.createContext({operations:()=>reopened,ensureAppHelperRuntime:async()=>{}});
  load(startup,'reconcileRestoredHandoff');
  const closed=await startup.reconcileRestoredHandoff();
  assert.equal(closed.state,'failed');assert.equal(closed.effectState,'untouched');assert.equal(closed.verification,'confirmed');
  assert.equal(closed.result.notAppliedVerification,'confirmed');assert.equal(closed.operationId,cancelled.operationId);
});
test('a duplicate APP submission never launches another helper while the original writer is busy',async()=>{
  const operation={state:'awaiting-handoff',busy:true,handoffRef:'/test/job'};
  const context=vm.createContext({launcherUpdate:{launchHandoff:()=>assert.fail('a writer already owns this APP handoff')}});
  load(context,'dispatchLauncherHandoff');
  assert.equal(await context.dispatchLauncherHandoff(operation),operation);
});
for(const flags of [{},{includeLauncher:true},{launcherOnly:false},{launcherOnly:true}])
test(`GUI updates force APP ownership before admission (${JSON.stringify(flags)})`,async()=>{
  const calls=[];
  const context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    launcherError:failure,ensureAppHelperRuntime:async()=>calls.push('runtime'),
    operations:()=>({start:async(kind,options)=>{calls.push({kind,request:options.target.request});return {state:'succeeded',verification:'confirmed'};}}),
    executeAction(){},rememberOperationFailure(){},finishOperationTelemetry(){},registerCapabilities:async()=>{},requireOperationResult:value=>value});
  load(context,'runAction');
  await vm.runInContext('runAction',context)({sender:null},{action:'update',runId:'app-only',tag:'v2.6.0',...flags});
  assert.equal(calls[0],'runtime');assert.equal(calls.length,2);
  assert.equal(calls[1].request.launcherOnly,true);assert.equal(calls[1].request.includeLauncher,undefined);assert.equal(calls[1].kind,'update');
});
for(const legacy of [false,true])test(`GUI rejects core repair and recovery even with legacy history (${legacy})`,async()=>{
  let submitted=0;
  const context=vm.createContext({activeRun:false,modelBusy:false,launcherError:failure,
    systemUpdate:{inspect:()=>legacy?{kind:'legacy',canRecover:true}:null},operations:()=>({start:async()=>{submitted++;}})});
  load(context,'runAction');
  for(const action of ['repair','recover'])await assert.rejects(vm.runInContext('runAction',context)({sender:null},{action,runId:'core-entry'}),{code:'CORE_UPDATE_CHAT_REQUIRED'});
  assert.equal(submitted,0);
});

test('the actual GUI adapter delegates to APP start without reading core health, compatibility or service port',async t=>{
  const f=fixture(t),before=f.protectedTree(),calls=[];
  const helper={command:'/isolated/APP-owned-python'},result={verification:'confirmed',value:{launcherVersion:'2.2.8',appUpdateComplete:true,updateComplete:true,coreUpdateComplete:false}};
  const operation={operationId:'00000000-0000-4000-8000-000000000001',kind:'update',target:{request:{action:'update',launcherOnly:true}}};
  let installer={phase:'ready',milestones:[],setupCompleted:true};
  const context=vm.createContext({path,fs,process,AbortController,os,LOCAL_TEST:null,CHANNEL:'stable',localReleaseDirectory:null,
    releaseAbort:null,activeOperationContext:null,cancelled:false,launcherError:failure,formatUserError:error=>error.message,
    require:name=>{assert.equal(name,'./release-network');return realRequire(name);},
    installerDirectory:()=>path.join(f.home,'installer'),noraHome:()=>f.home,
    hermesHome:()=>assert.fail('APP adapter must not inspect Hermes'),installRoot:()=>assert.fail('APP adapter must not inspect core'),
    payloadDirectory:()=>assert.fail('APP adapter must not prepare a core payload'),installationPort:()=>assert.fail('APP adapter must not resolve a service port'),
    app:{getVersion:()=> '2.2.8',isPackaged:true},telemetry:null,
    diagnostics:{addSecret(){},begin(){},write(){},finish(){},error(){}},
    readInstallerState:()=>installer,writeInstallerState:value=>(installer=value),
    runBridge:()=>assert.fail('APP completion must not require core health'),releases:{validatePlan:()=>assert.fail('APP adapter must not validate a core plan')},
    launcherUpdate:{start:async options=>{calls.push(options);assert.equal(options.context.snapshot,operation);
      assert.equal(options.python,helper.command);assert.equal(options.appHelperRuntime,helper);return result;}},
    ensureAppHelperRuntime:async()=>helper,launcherRecoveryOptions:()=>({home:f.home,python:helper.command,appHelperRuntime:helper}),
    releaseMetadataCache:()=>({}),updateFetch:null,sendBridgeEvent(){},spawnMaintenance:()=>assert.fail('the stubbed module starts no child'),
  });
  load(context,'runLauncherUpdate','executeAction');
  const actual=await vm.runInContext('executeAction',context)({...operation,snapshot:operation},{event:{sender:null}});
  assert.equal(actual,result);assert.equal(calls.length,1);assert.equal(installer.resumeTarget,null);
  assert.equal(result.value.systemReady,undefined);assert.equal(result.value.coreUpdateComplete,false);
  assert.deepEqual(f.protectedTree(),before,'all core, user, legacy and combined history bytes/identities remain unchanged');
});

for(const options of [{},{scope:'desktop'},{scope:'desktop',retry:true}])
test(`legacy Nora receiver cannot submit either component (${JSON.stringify(options)})`,async()=>{
  let execute;
  const context=vm.createContext({createSkillUpdateReceiver:options=>{execute=options.execute;return {};},
    noraHome:()=>'/isolated',activeRun:false,modelBusy:false,quitting:false,uninstalling:false,selectingLocation:false,statusRequest:null,MOCK_SCENARIO:null,
    diagnostics:{clean:String},checkRelease:async()=>assert.fail('execution must reject before selecting a target')});
  load(context,'skillUpdates');await assert.rejects(execute('update','test',options),{code:'CORE_UPDATE_CHAT_REQUIRED'});
});
for(const request of [{action:'update'},{action:'update',launcherOnly:false},{action:'repair'}])
test(`the executor rejects a direct core-writing request (${JSON.stringify(request)})`,async()=>{
  const context=vm.createContext({launcherError:failure});load(context,'executeAction');
  await assert.rejects(vm.runInContext('executeAction',context)({target:{request},snapshot:{},operationId:'isolated'}),{code:'CORE_UPDATE_CHAT_REQUIRED'});
});

test('old combined plans remain read-only without reading core or clearing original history',async t=>{
  const f=fixture(t),before=f.protectedTree(),calls=[];
  let plan={plan:{tag:'v2.6.0'}};
  const context=vm.createContext({continueDesktopUpdate:null,desktopUpdateNotice:null,noraHome:()=>f.home,
    desktopSequenceOptions:()=>({}),diagnostics:{clean:String},
    updateSequence:{load:()=>{calls.push('load');if(!plan)throw new Error('unreadable old history');return plan;},
      clear:()=>assert.fail('APP cannot clear combined history')}});
  const node=nodes.find(node=>node.type==='AssignmentExpression'&&node.left?.name==='continueDesktopUpdate');
  assert.ok(node);vm.runInContext(source.slice(node.start,node.end),context);
  const known=await context.continueDesktopUpdate();
  assert.equal(known.readOnly,true);assert.equal(known.releaseTag,'v2.6.0');assert.equal(known.canRetry,false);
  plan=null;
  const unknown=await context.continueDesktopUpdate();
  assert.equal(unknown.readOnly,true);assert.equal(unknown.status,'unknown');
  assert.match(unknown.message,/unreadable old history/);
  assert.deepEqual(calls,['load','load']);assert.deepEqual(f.protectedTree(),before);
});

test('SELF cannot acknowledge or resume an old combined operation',async t=>{
  const f=fixture(t),before=f.protectedTree(),calls=[];
  const context=vm.createContext({require:realRequire,process,noraHome:()=>f.home,app:{getVersion:()=> '2.2.8'},launcherError:failure,
    ensureAppHelperRuntime:async()=>{},launcherUpdate:{resume:(_job,options)=>{calls.push(['plan',Boolean(options.operation)]);return {operationId:'old-combined-operation'};},
      waitHandoff:()=>assert.fail('old combined task cannot enter an APP continuation')},
    operations:()=>({snapshot:async()=>({operationId:'old-combined-operation',kind:'update',target:{request:{action:'update'}},state:'verifying'}),
      recheck:()=>assert.fail('must not recheck a combined total'),resume:()=>assert.fail('must not resume a combined total')})});
  load(context,'ownsDesktopOperation','continueSelfUpdate');
  await assert.rejects(context.continueSelfUpdate('/isolated/job',null),{code:'OPERATION_CAPABILITY_REQUIRED'});
  assert.deepEqual(calls,[['plan',false]],'ownership is checked before the default ACK call');assert.deepEqual(f.protectedTree(),before);
});

for(const fault of ['none','core-query','incompatible-core','app-query'])
test(`APP installability is based on the independent APP query (${fault})`,async()=>{
  const plan={schema:'nora-release-plan/1',client:'app',mode:'update',launcherManifest:{version:'2.2.8'}};
  const core={state:fault==='incompatible-core'?'blocked':'available',current:'2.5.7',latest:'v2.6.0',releaseAvailable:true,
    compatibilityError:fault==='incompatible-core'?'core-only compatibility failure':''};
  const calls=[];
  const context=vm.createContext({releaseCheckRequest:null,localReleaseDirectory:null,CHANNEL:'stable',updateFetch:null,
    releaseMetadataCache:()=>({}),app:{getVersion:()=> '2.2.7'},installRoot:()=>'/unused-core',diagnostics:{clean:String},
    trackLauncher:async(_action,_stage,work)=>work(),releases:{UPDATER_CAPABILITIES:{},
      check:async options=>{calls.push('core');assert.equal(options.client,'updater');if(fault==='core-query')throw new Error('core-only query failed');return core;},
      checkApp:async()=>{calls.push('app');if(fault==='app-query')throw new Error('APP metadata failed');
        return {releasePlan:plan,launcherVersion:'2.2.7',launcherLatest:'2.2.8',launcherUpdateAvailable:true,launcherInstallable:true,launcherState:'available'};}}});
  load(context,'checkRelease');const checked=await context.checkRelease();
  assert.deepEqual(calls,['core','app']);assert.equal(checked.launcherInstallable,fault!=='app-query');
  if(fault==='app-query'){
    assert.match(checked.launcherError,/APP metadata failed/);assert.equal(checked.latest,'v2.6.0');assert.equal(checked.releaseAvailable,true);
    assert.equal(checked.releasePlan,undefined,'a failed APP query cannot expose a core plan as the APP target');
  }else{
    assert.equal(checked.releasePlan,plan);assert.equal(checked.launcherUpdateAvailable,true);
    if(fault==='core-query')assert.match(checked.error,/core-only query failed/);
    if(fault==='incompatible-core')assert.equal(checked.compatibilityError,'core-only compatibility failure');
  }
});

test('ordinary stop still reaches owned service verification during ambiguous historical recovery',async()=>{
  const calls=[],effects=[];
  const context=vm.createContext({path,fs,os,process,CHANNEL:'stable',cancelled:false,activeOperationContext:null,
    require:()=>({createReleaseSourceContext:()=>({}),retryCompletion:()=>null}),launcherError:failure,
    formatUserError:error=>error.message,app:{getVersion:()=> '2.2.8'},telemetry:null,
    installerDirectory:()=>'/isolated/installer',noraHome:()=>'/isolated',hermesHome:()=>'/isolated/hermes',
    installRoot:()=>'/isolated/tavern',payloadDirectory:()=>'/isolated/payload',installationPort:()=>8799,
    readInstallerState:()=>({phase:'ready',milestones:[]}),writeInstallerState:value=>value,
    diagnostics:{addSecret(){},begin(){},write(){},finish(){},error(){}},
    systemUpdate:{inspect:()=>({kind:'legacy',canRecover:false,code:'LEGACY_RECOVERY_DATA_BOUNDARY'})},
    runBridge:async action=>{calls.push(action);return {running:false,tavernProcessRunning:false};},
    verifyWorkflowResult:({action,result})=>action==='stop'&&result.tavernProcessRunning===false});
  vm.runInContext(definition('executeAction'),context);
  const execute=vm.runInContext('executeAction',context);
  const task=action=>({operationId:'owned-stop',target:{request:{action,service:'tavern'}},
    stage:async()=>{},effect:async value=>{effects.push(value);}});
  assert.equal((await execute(task('stop'),{})).verification,'confirmed');
  assert.deepEqual(calls,['stop']);
  assert.deepEqual(effects,[]);
  await assert.rejects(execute(task('start'),{}),{code:'UPDATE_RECOVERY_REQUIRED'});
  assert.deepEqual(calls,['stop']);
});
