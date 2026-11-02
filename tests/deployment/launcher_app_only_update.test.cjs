const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const os=require('node:os');
const {createRequire}=require('node:module');
const {parse}=require('../installer/desktop/node_modules/acorn');
const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
const nodes=[];
function walk(node){if(!node||typeof node!=='object')return;if(node.type)nodes.push(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
walk(parse(source,{ecmaVersion:'latest'}));
function definition(name){const node=nodes.find(node=>node.type==='FunctionDeclaration'&&node.id?.name===name||node.type==='VariableDeclarator'&&node.id?.name===name);assert.ok(node,name);return node.type==='VariableDeclarator'?`const ${source.slice(node.start,node.end)};`:source.slice(node.start,node.end);}
const failure=(message,details)=>Object.assign(new Error(message),details);
function continuation(){const node=nodes.find(node=>node.type==='AssignmentExpression'&&node.left?.name==='continueDesktopUpdate');assert.ok(node);return source.slice(node.start,node.end);}
for(const flags of [{},{includeLauncher:true},{launcherOnly:false},{launcherOnly:true}])
test(`GUI updates always submit only the APP (${JSON.stringify(flags)})`,async()=>{
  const calls=[];
  const context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    launcherError:failure,runSharedUpdate:async()=>assert.fail('GUI must not submit core'),runDesktopUpdate:async()=>assert.fail('GUI must not create a combined task'),
    operations:()=>({start:async(kind,options)=>{calls.push({kind,request:options.target.request});return {state:'succeeded',verification:'confirmed'};}}),
    executeAction(){},rememberOperationFailure(){},finishOperationTelemetry(){},registerCapabilities:async()=>{},requireOperationResult:value=>value});
  vm.runInContext(definition('runAction'),context);
  await vm.runInContext('runAction',context)({sender:null},{action:'update',runId:'app-only',tag:'v2.6.0',...flags});
  assert.equal(calls.length,1);assert.equal(calls[0].request.launcherOnly,true);
  assert.equal(calls[0].request.includeLauncher,undefined);assert.equal(calls[0].kind,'update');
});
for(const legacy of [false,true])test(`a fresh GUI recovery ${legacy?'keeps a real old snapshot route':'cannot take over an independent core task'}`,async()=>{
  let submitted=0;
  const context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    launcherError:failure,noraHome:()=>'/isolated',systemUpdate:{inspect:()=>legacy?{kind:'legacy',canRecover:true}:null},
    operations:()=>({start:async()=>{submitted++;return {state:'succeeded',verification:'confirmed'};}}),
    executeAction(){},rememberOperationFailure(){},finishOperationTelemetry(){},registerCapabilities:async()=>{},requireOperationResult:value=>value});
  vm.runInContext(definition('runAction'),context);
  const run=()=>vm.runInContext('runAction',context)({sender:null},{action:'recover',runId:'recovery-entry'});
  if(legacy)await run();else await assert.rejects(run(),{code:'CORE_UPDATE_CHAT_REQUIRED'});
  assert.equal(submitted,legacy?1:0);
});
test('APP completion preserves modified skills and unhealthy core without claiming core health',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-only-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'tavern'),directory=path.join(root,'tavern-updates');fs.mkdirSync(directory,{recursive:true});
  const realRequire=createRequire(path.join(__dirname,'../installer/desktop/main.js'));
  const releases=realRequire('./releases'),updateSequence=realRequire('./update-sequence');
  const manifest={schema:'tavern-release/v2',versions:{tavern:'2.5.7'},commit:'a'.repeat(40),launcherVersion:'2.2.7'};
  fs.writeFileSync(path.join(directory,'installed-manifest.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory,'installed.json'),JSON.stringify({schema:2,version:'2.5.7',commit:manifest.commit}));
  const protectedFiles=['hermes/skills/creative/tavern/SKILL.md','tavern/tavern-state/chats/story.jsonl','hermes/config.yaml'];
  for(const name of protectedFiles){const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'user changed '+name);}
  const inventory=()=>protectedFiles.map(name=>fs.readFileSync(path.join(home,name),'utf8'));
  const before=inventory(),calls=[];
  const plan={schema:'nora-release-plan/1',mode:'update',tag:'v2.6.0',launcherManifest:{version:'2.2.8'},
    releaseManifest:{versions:{tavern:'2.6.0'},launcherVersion:'2.2.8',updateCompatibility:{schema:'nora-core-launcher-compatibility/1',
      coreVersion:'2.6.0',launcherVersions:['2.2.8'],previousCoreVersions:['2.5.7'],capabilities:releases.LAUNCHER_CAPABILITIES}}};
  let state={phase:'ready',milestones:[],setupCompleted:true};
  const context=vm.createContext({path,fs,process,AbortController,LOCAL_TEST:null,CHANNEL:'stable',localReleaseDirectory:null,
    cancelled:false,releaseAbort:null,activeOperationContext:null,launcherError:failure,
    noraHome:()=>home,hermesHome:()=>path.join(home,'hermes'),installRoot:()=>root,installerDirectory:()=>path.join(home,'installer'),
    payloadDirectory:()=>'/isolated/payload',installationPort:()=>8799,formatUserError:error=>error.message,
    app:{getVersion:()=> '2.2.8',isPackaged:true},os,telemetry:null,
    releases:{...releases,validatePlan:value=>value},updateSequence,
    require:name=>name==='./retained-installation'?{retryCompletion:()=>null}:
      name==='./operation-policy'?assert.fail('APP update must not inspect or repair core programs'):realRequire(name),
    diagnostics:{addSecret(){},begin(){},write(){},finish(){},clean:String,error(){}},
    systemUpdate:{inspect:()=>null},readInstallerState:()=>state,writeInstallerState:value=>(state=value),
    runBridge:async command=>{calls.push(command);assert.equal(command,'status');return {version:'2.5.7',commit:manifest.commit,
      systemReady:false,running:false,gatewayRunning:false,clawchatConnected:false,warning:'injected model/service failure'};},
    launcherUpdate:{prepare:async()=>({tag:plan.tag,manifest:plan.releaseManifest,launcher:null}),
      finalize:async options=>{calls.push('finalize');assert.equal(options.appOnly,true);assert.equal(options.systemReady,undefined);assert.equal(options.updateVerified,undefined);}},
    launcherRecoveryOptions:()=>({}),releaseMetadataCache:()=>({}),updateFetch:null,sendBridgeEvent(){}});
  for(const name of ['appCoreIdentity','runLauncherUpdate','executeAction'])vm.runInContext(definition(name),context);
  const {createOperationController}=realRequire('./operation-state');
  const controllerOptions={directory:path.join(home,'installer'),lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),
    executors:{update:vm.runInContext('executeAction',context)},projectResult:result=>result.value??result,verifyHandoff:async()=>true};
  const controller=createOperationController(controllerOptions);
  const pending=await controller.start('update',{target:{request:{action:'update',launcherOnly:true},releasePlan:plan,currentVersion:'2.5.7'},
    execute:async context=>{await context.handoff('/isolated/job');return {handoff:true};}},'app-test');
  const result=await controller.resume(pending.operationId,{handoff:{job:pending.handoffRef,planDigest:pending.planDigest}});
  assert.equal(result.state,'succeeded');assert.equal(result.verification,'confirmed');assert.equal(result.result.appUpdateComplete,true);
  assert.equal(result.result.version,'2.5.7');assert.equal(result.result.systemReady,false);assert.equal(result.result.coreUpdateComplete,false);
  assert.equal(result.effectState,'changed','the canonical task must report the confirmed APP replacement');
  assert.equal((await createOperationController(controllerOptions).snapshot(pending.operationId)).effectState,'changed');
  assert.deepEqual(calls,['finalize','status']);assert.deepEqual(inventory(),before);assert.equal(state.resumeTarget,null);
});
for(const options of [{},{scope:'desktop'},{scope:'desktop',retry:true}])
test(`legacy Nora receiver cannot submit either component (${JSON.stringify(options)})`,async()=>{
  let execute;
  const context=vm.createContext({createSkillUpdateReceiver:options=>{execute=options.execute;return {};},
    noraHome:()=>'/isolated',activeRun:false,modelBusy:false,quitting:false,uninstalling:false,selectingLocation:false,statusRequest:null,MOCK_SCENARIO:null,
    diagnostics:{clean:String},systemUpdate:{pending:()=>false},checkRelease:async()=>assert.fail('execution must reject before selecting a target'),
    runAction:async()=>assert.fail('the desktop receiver must not own a new update')});
  vm.runInContext(definition('skillUpdates'),context);
  await assert.rejects(execute('update','test',options),{code:'CORE_UPDATE_CHAT_REQUIRED'});
});
for(const request of [{action:'update'},{action:'update',launcherOnly:false},{action:'repair'}])
test(`the executor rejects a direct core-writing request (${JSON.stringify(request)})`,async()=>{
  const context=vm.createContext({launcherError:failure});
  vm.runInContext(definition('executeAction'),context);
  await assert.rejects(vm.runInContext('executeAction',context)({target:{request},snapshot:{},operationId:'isolated'}),
    {code:'CORE_UPDATE_CHAT_REQUIRED'});
});

for(const state of ['not-started','partial','all-succeeded','awaiting-handoff','writer-running','unconfirmed','incompatible'])
test(`old desktop plan is observed without executing another component (${state})`,async()=>{
  const calls=[],pending={id:'history',order:['launcher','core'],requests:{launcher:'app-request',core:'core-request'},plan:{tag:'v2.6.0'}};
  const appRecord={operationId:'app-op',state:'succeeded',verification:'confirmed',effectState:'changed',busy:false};
  const coreRecord={operationId:'core-op',state:'succeeded',verification:'confirmed',effectState:'changed',busy:false};
  if(state==='awaiting-handoff')Object.assign(appRecord,{state:'awaiting-handoff',effectState:'untouched'});
  if(state==='unconfirmed')Object.assign(appRecord,{state:'interrupted',effectState:'unknown',verification:'unconfirmed'});
  const context=vm.createContext({activeRun:false,desktopUpdateNotice:null,fs:{existsSync:()=>false},path,
    installerDirectory:()=>'/isolated/installer',noraHome:()=>'/isolated',desktopSequenceOptions:()=>({}),
    app:{getVersion:()=> '2.2.8'},
    updateSequence:{load:()=>pending,operation:(_home,id)=>state==='not-started'?null:id==='app-request'?appRecord:
      ['all-succeeded','writer-running'].includes(state)?coreRecord:null,clear:()=>calls.push('clear')},
    operations:()=>({snapshot:async()=>appRecord,start:async()=>assert.fail('must not start another update'),resume:async()=>assert.fail('must not resume another update')}),
    appCoreIdentity:()=>{calls.push('compatibility');if(state==='incompatible')throw Error('incompatible actual pair');return {};},
    require:name=>name==='./updater-task'?{query:async()=>({operation:coreRecord,settled:state!=='writer-running'})}:
      {desktopSequenceRequest:()=>null},finishHandoff:()=>assert.fail('no skill request'),
    runSharedUpdate:()=>assert.fail('must not apply core'),runDesktopUpdate:()=>assert.fail('must not execute a dual plan')});
  vm.runInContext(continuation(),context);
  await context.continueDesktopUpdate();
  const safe=['not-started','partial','all-succeeded'].includes(state);
  assert.equal(calls.includes('clear'),safe);
  if(safe)assert.equal(context.desktopUpdateNotice,null);else assert.equal(context.desktopUpdateNotice.settled,false);
  assert.equal(context.activeRun,false);
  assert.equal(appRecord.state,state==='awaiting-handoff'?'awaiting-handoff':state==='unconfirmed'?'interrupted':'succeeded');
});
for(const stage of ['plan','core-query'])test(`unreadable old ${stage} remains visible and never clears the pointer`,async()=>{
  const expected=Error('injected historical '+stage),calls=[];
  const context=vm.createContext({activeRun:false,desktopUpdateNotice:null,path,fs:{existsSync:()=>true},
    noraHome:()=>'/isolated',installerDirectory:()=>'/isolated/installer',desktopSequenceOptions:()=>({}),
    updateSequence:{load:()=>{if(stage==='plan')throw expected;return {order:['core'],requests:{core:'old'}};},operation:()=>null,
      clear:()=>calls.push('cleared')},require:()=>({query:async()=>{throw expected;}})});
  vm.runInContext(continuation(),context);
  await assert.rejects(context.continueDesktopUpdate(),error=>error===expected);
  assert.equal(context.desktopUpdateNotice.status,'blocked');assert.equal(context.desktopUpdateNotice.settled,false);
  assert.match(context.desktopUpdateNotice.message,/injected historical/);assert.equal(context.activeRun,false);assert.equal(calls.length,0);
});

for(const fault of ['none','core-query','incompatible','app-query'])test(`APP installability is based on its own plan and current core identity (${fault})`,async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-check-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const directory=path.join(home,'tavern-updates');fs.mkdirSync(directory);
  const realRequire=createRequire(path.join(__dirname,'../installer/desktop/main.js'));
  const releases=realRequire('./releases'),updateSequence=realRequire('./update-sequence');
  const current={schema:'tavern-release/v2',versions:{tavern:'2.5.7'},commit:'a'.repeat(40)};
  fs.writeFileSync(path.join(directory,'installed-manifest.json'),JSON.stringify(current));
  fs.writeFileSync(path.join(directory,'installed.json'),JSON.stringify({version:'2.5.7',commit:current.commit}));
  const manifest={versions:{tavern:'2.6.0'},launcherVersion:'2.2.8',updateCompatibility:{schema:'nora-core-launcher-compatibility/1',
    coreVersion:'2.6.0',launcherVersions:['2.2.8'],previousCoreVersions:fault==='incompatible'?[]:['2.5.7'],capabilities:releases.LAUNCHER_CAPABILITIES}};
  const plan={releaseManifest:manifest,launcherManifest:{version:'2.2.8'},release:{tag_name:'v2.6.0'}};
  const result={releaseTag:'v2.6.0',releasePlan:plan,launcherUpdateAvailable:true,...(fault==='core-query'?{error:'core-only failure'}:{})};
  const context=vm.createContext({path,fs,require:realRequire,releaseCheckRequest:null,releaseMetadataState:null,localReleaseDirectory:null,
    releases:{...releases,check:async()=>result,selectPlan:async()=>{if(fault==='app-query')throw Error('APP metadata failed');return plan;}},
    updateSequence,launcherError:failure,noraHome:()=>home,installRoot:()=>home,app:{getVersion:()=> '2.2.7'},CHANNEL:'stable',updateFetch:null,
    trackLauncher:async(_action,_stage,work)=>work()});
  for(const name of ['releaseMetadataCache','appCoreIdentity','checkRelease'])vm.runInContext(definition(name),context);
  const checked=await vm.runInContext('checkRelease',context)();
  assert.equal(checked.launcherInstallable,['none','core-query'].includes(fault));
  if(fault==='core-query')assert.equal(checked.error,'core-only failure');
  if(fault==='incompatible')assert.match(checked.launcherCompatibilityError,/先更新核心/);
  if(fault==='app-query')assert.match(checked.launcherCompatibilityError,/APP metadata/);
});
