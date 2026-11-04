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
