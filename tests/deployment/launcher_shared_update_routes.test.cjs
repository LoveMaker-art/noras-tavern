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
for(const [core,launcher] of [[true,true],[true,false],[false,true],[false,false]])
test(`Nora receiver selects exactly the applicable desktop components (core=${core}, APP=${launcher})`,async()=>{
  let execute;const calls=[];
  const context=vm.createContext({createSkillUpdateReceiver:options=>{execute=options.execute;return {};},
    assertDesktopCheck:require('../installer/desktop/skill-update').assertDesktopCheck,
    noraHome:()=>'/private/home',activeRun:false,modelBusy:false,quitting:false,uninstalling:false,selectingLocation:false,statusRequest:null,MOCK_SCENARIO:null,
    CHANNEL:'stable',localReleaseDirectory:null,
    systemUpdate:{pending:()=>false},diagnostics:{clean:String},app:{getVersion:()=> '2.2.6'},
    checkRelease:async()=>({releaseTag:'v2.5.6',state:core||launcher?'available':'current',releaseAvailable:core,launcherUpdateAvailable:launcher}),
    runBridge:async()=>({version:'2.5.6',systemReady:true}),
    runAction:async(_event,payload)=>{calls.push(payload);return {version:'2.5.6',systemReady:true,operation:{operationId:randomUUID()}};}});
  vm.runInContext(definition('skillUpdates'),context);
  const id=randomUUID(),result=await execute('update',id,{scope:'desktop'});
  assert.equal(result.updateComplete,true);assert.equal(result.launcherVersion,'2.2.6');
  if(!core&&!launcher){assert.equal(calls.length,0);assert.equal(result.unchanged,true);}
  else {assert.equal(calls.length,1);assert.equal(calls[0].includeLauncher===true,core&&launcher);
    assert.equal(calls[0].launcherOnly===true,!core&&launcher);assert.equal(calls[0].skillRequestId,id);}
});

async function optionalAppFixture(t,{fault='failure',compatible=true,channel='stable',candidate=false}={}){
  const crypto=require('node:crypto'),releases=require('../installer/desktop/releases');
  const skill=require('../installer/desktop/skill-update'),capability=require('../installer/desktop/launcher-capability');
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-optional-app-')));
  let receiver;t.after(()=>{receiver?.close();fs.rmSync(home,{recursive:true,force:true});});
  const root=path.join(home,'tavern'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
  const put=(name,value)=>{const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
  const protectedFiles=['tavern/tavern-state/chats/story.jsonl','tavern/tavern-state/characters/card.json',
    'tavern/tavern-state/worlds/world.json','hermes/config.yaml','hermes/.env','hermes/memories/USER.md','hermes/memories/MEMORY.md'];
  protectedFiles.forEach(name=>put(name,'isolated original '+name));
  const inventory=()=>Object.fromEntries(protectedFiles.map(name=>[name,sha(fs.readFileSync(path.join(home,name)))]));
  const before=inventory(),installed='tavern/tavern-updates/installed.json';put(installed,JSON.stringify({version:'2.5.6'}));
  const targetVersion=channel==='beta'?'2.5.7-beta.1':'2.5.7',tag='v'+targetVersion,launcherVersion=channel==='beta'?'2.2.7':'2.2.6';
  const appMetadata=`nora-launcher-${process.platform}-${process.arch}.json`;
  const manifest={schema:'tavern-release/v2',versions:{tavern:targetVersion},commit:'a'.repeat(40),launcherVersion,...(candidate?{candidate:true}:{}),
    launcherCapabilities:releases.LAUNCHER_CAPABILITIES,
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.2.6',sha256:sha('bootstrap')},
    updateCompatibility:{schema:'nora-core-launcher-compatibility/1',coreVersion:targetVersion,
      launcherVersions:compatible?['2.2.6',...(launcherVersion==='2.2.7'?['2.2.7']:[])]:['2.2.7'],capabilities:releases.LAUNCHER_CAPABILITIES}};
  const bytes=JSON.stringify(manifest),release={tag_name:tag,draft:false,prerelease:channel==='beta',assets:[{
    name:'release-manifest.json',state:'uploaded',size:Buffer.byteLength(bytes),digest:'sha256:'+sha(bytes),
    browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${tag}/release-manifest.json`},
    ...(channel==='beta'?[{name:appMetadata,state:'uploaded',size:10,digest:'sha256:'+sha('unreadable'),
      browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${tag}/${appMetadata}`}]:[])]};
  const localReleaseDirectory=candidate?path.join(home,'local-release'):null;
  if(candidate)put('local-release/release-manifest.json',bytes);
  const checkOptions={installRoot:root,launcherVersion:'2.2.6',channel,client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES,launcherDiscovery:true,
    ...(candidate?{allowCandidate:true,explicitLocalRelease:localReleaseDirectory}:{}),
    networkPolicy:{sources:{schema:1,primary:'github',mirrors:[]},maxAttempts:1,totalBudgetMs:1000,attemptTimeoutMs:20},
    fetcher:async(address,options)=>{
      const url=String(address);let body;
      if(url.endsWith('/latest')||channel==='beta'&&url.includes('?per_page='))body=JSON.stringify(channel==='beta'?[release]:release);
      else if(url.endsWith('/release-manifest.json'))body=bytes;
      else if(url.includes('?per_page=')||url.endsWith('/'+appMetadata)){
        if(fault==='headers timeout')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
        if(fault==='body timeout')return new Response(new ReadableStream({start(){}}));
        throw new Error('injected APP catalogue failure');
      }else assert.fail('Unexpected metadata request '+url);
      const response=new Response(body);Object.defineProperty(response,'url',{value:url});return response;
    }};
  const checked=await releases.check(checkOptions);assert.equal(checked.state,'available');assert.ok(checked.launcherError);
  const appRoot=path.join(home,'app'),executable=process.platform==='darwin'?path.join(appRoot,'Contents/MacOS/Nora'):path.join(appRoot,'Nora.exe');
  const resources=process.platform==='darwin'?path.join(appRoot,'Contents/Resources'):path.join(appRoot,'resources');
  for(const file of [executable,path.join(resources,'app.asar'),path.join(resources,
    `app.asar.unpacked/node_modules/fs-native-extensions/prebuilds/${process.platform}-${process.arch}/fs-native-extensions.node`),
    ...capability.RESOURCE_NAMES.map(name=>path.join(resources,name))])put(path.relative(home,file),'isolated APP identity');
  await capability.register({noraHome:home,executable,resourcesRoot:resources,isPackaged:true,launcherVersion:'2.2.6',port:8799,channel});
  const calls=[];let coreFailure=false,pending=false;
  const context=vm.createContext({fs,path,require,process,createSkillUpdateReceiver:options=>(receiver=skill.createSkillUpdateReceiver(options)),
    assertDesktopCheck:skill.assertDesktopCheck,noraHome:()=>home,activeRun:false,modelBusy:false,quitting:false,uninstalling:false,
    selectingLocation:false,statusRequest:null,MOCK_SCENARIO:null,cancelled:false,activeOperationContext:null,CHANNEL:channel,localReleaseDirectory,
    systemUpdate:{pending:()=>pending},diagnostics:{clean:String},app:{getVersion:()=> '2.2.6'},
    checkRelease:async()=>checked,runBridge:async()=>assert.fail('available core is not an unchanged installation'),
    runDesktopUpdate:async()=>assert.fail('unknown APP must not enter a two-component sequence'),
    runSharedUpdate:async(_event,payload)=>{
      calls.push(payload);assert.equal(payload.tag,checked.releasePlan.tag);
      assert.equal(payload.targetCommit,manifest.commit);assert.equal(payload.targetManifestSha256,sha(bytes));
      if(coreFailure===true)throw new Error('injected core execution failure');
      put(installed,JSON.stringify({version:targetVersion}));const operationId=randomUUID();
      const result={version:coreFailure==='wrong-version'?'2.5.6':targetVersion,systemReady:coreFailure!=='unhealthy',running:true,gatewayRunning:true};
      put(`installer/operations/${operationId}/operation.json`,JSON.stringify({operationId,requestId:payload.operationRequestId,
        kind:'update',state:'succeeded',verification:'confirmed',result}));
      return {...result,operation:{operationId}};
    }});
  vm.runInContext(definition('runAction'),context);vm.runInContext(definition('skillUpdates'),context);await receiver.tick();
  return {home,checked,calls,before,inventory,receiver,
    failCore:()=>{coreFailure=true;},unconfirmedCore:kind=>{coreFailure=kind;},pendingRecovery:()=>{pending=true;},
    read:()=>JSON.parse(fs.readFileSync(path.join(home,'installer/skill-update/request.json'))),
    check:metadata=>skill.desktopRequest({noraHome:home,action:'check'},{checkRelease:()=>metadata||releases.check(checkOptions),launch:()=>assert.fail('check cannot launch APP')}),
    update:()=>skill.desktopRequest({noraHome:home,action:'update',confirm:true}),status:()=>skill.desktopStatus(home)};
}
for(const fault of ['failure','headers timeout','body timeout'])
test(`Nora keeps a verified compatible core update and reports APP discovery separately (${fault})`,async t=>{
  const f=await optionalAppFixture(t,{fault}),endpoint=fs.readFileSync(path.join(f.home,'installer/skill-update/endpoint.json'));
  const checked=await f.check();assert.equal(checked.result.releaseAvailable,true);assert.equal(checked.result.launcherUpdateAvailable,false);
  assert.ok(checked.result.launcherError);assert.equal(checked.result.updateComplete,undefined);
  assert.deepEqual(fs.readFileSync(path.join(f.home,'installer/skill-update/endpoint.json')),endpoint);
  assert.equal(fs.existsSync(path.join(f.home,'installer/skill-update/request.json')),false);
  const request=await f.update();await f.receiver.tick();const status=await f.status();
  assert.equal(status.status,'partial');assert.equal(status.settled,true);assert.equal(status.busy,false);
  assert.equal(status.result.version,'2.5.7');assert.equal(status.result.launcherVersion,'2.2.6');
  assert.equal(status.result.coreUpdateComplete,true);assert.equal(status.result.updateComplete,false);assert.ok(status.result.launcherError);
  assert.equal(status.requestId,request.requestId);assert.equal(status.result.operationIds.length,1);assert.equal(f.calls.length,1);
  const record=fs.readFileSync(path.join(f.home,'installer/skill-update/request.json'));
  await assert.rejects(f.check(),{code:'DESKTOP_UPDATE_CHECK_FAILED'});await f.receiver.tick();
  assert.equal((await f.status()).status,'partial');assert.equal(f.calls.length,1);
  assert.deepEqual(fs.readFileSync(path.join(f.home,'installer/skill-update/request.json')),record);
  const reopened=require('../installer/desktop/skill-update').createSkillUpdateReceiver({home:()=>f.home,busy:()=>false,
    execute:()=>assert.fail('reopening must not replay a settled partial result')});
  try{await reopened.tick();assert.equal((await f.status()).status,'partial');}finally{reopened.close();}
  assert.deepEqual(f.inventory(),f.before);
  const operation=path.join(f.home,'installer/operations',status.result.operationIds[0],'operation.json');
  const changed=JSON.parse(fs.readFileSync(operation));changed.state='failed';fs.writeFileSync(operation,JSON.stringify(changed));
  await assert.rejects(f.status(),/not confirmed/);
});
test('a verified Beta core fallback retains its actual channel through desktop query and execution',async t=>{
  const f=await optionalAppFixture(t,{channel:'beta'});
  const checked=await f.check();assert.equal(checked.result.latest,'v2.5.7-beta.1');assert.ok(checked.result.launcherError);
  await f.update();await f.receiver.tick();const status=await f.status();
  assert.equal(status.status,'partial');assert.equal(status.result.version,'2.5.7-beta.1');
  assert.equal(status.result.updateComplete,false);assert.equal(f.calls.length,1);assert.deepEqual(f.inventory(),f.before);
});
test('fallback plan validation retains caller channel and explicit local candidate authority',async t=>{
  const skill=require('../installer/desktop/skill-update');
  const beta=await optionalAppFixture(t,{channel:'beta'});
  assert.throws(()=>skill.assertDesktopCheck(beta.checked,'2.2.6',{channel:'stable'}),/固定发布计划/);
  const local=await optionalAppFixture(t,{candidate:true});
  await assert.rejects(local.check(),/候选计划/,'a plan cannot grant its own local-candidate authority');
  await local.update();await local.receiver.tick();assert.equal((await local.status()).status,'partial');
  assert.equal(local.calls.length,1);assert.deepEqual(local.inventory(),local.before);
});
test('APP discovery failure cannot bypass incompatible target or pending recovery',async t=>{
  for(const kind of ['incompatible','recovery'])await t.test(kind,async t=>{
    const f=await optionalAppFixture(t,{compatible:kind!=='incompatible'});if(kind==='recovery')f.pendingRecovery();
    if(kind==='incompatible')await assert.rejects(f.check());
    await f.update();await f.receiver.tick();assert.equal(f.read().status,'error');assert.equal(f.calls.length,0);assert.deepEqual(f.inventory(),f.before);
  });
});
test('optional APP failure never turns missing or changed core evidence into update authority',async t=>{
  for(const kind of ['core lookup','incompatible','missing plan','changed plan'])await t.test(kind,async t=>{
    const f=await optionalAppFixture(t);
    if(kind==='core lookup')f.checked.error='core metadata failed';
    if(kind==='incompatible')f.checked.compatibilityError='incompatible maintenance protocol';
    if(kind==='missing plan')delete f.checked.releasePlan;
    if(kind==='changed plan')f.checked.releasePlan={...f.checked.releasePlan,commit:'c'.repeat(40)};
    await assert.rejects(f.check(f.checked));await f.update();await f.receiver.tick();
    assert.equal(f.read().status,'error');assert.equal(f.calls.length,0);assert.deepEqual(f.inventory(),f.before);
  });
});
test('core execution failure remains a failure alongside the APP query failure',async t=>{
  const f=await optionalAppFixture(t);f.failCore();await f.update();await f.receiver.tick();
  const status=await f.status();assert.equal(status.status,'error');assert.match(status.error,/core execution failure/);
  assert.ok(status.result.launcherError);assert.equal(status.result.updateComplete,false);assert.equal(status.result.coreUpdateComplete,false);
  assert.equal(f.calls.length,1);assert.deepEqual(f.inventory(),f.before);
});
test('an unconfirmed actual core version or health cannot become partial success',async t=>{
  for(const kind of ['wrong-version','unhealthy'])await t.test(kind,async t=>{
    const f=await optionalAppFixture(t);f.unconfirmedCore(kind);await f.update();await f.receiver.tick();
    const status=await f.status();assert.equal(status.status,'error');assert.equal(status.code,'DESKTOP_UPDATE_INCOMPLETE');
    assert.equal(status.result.updateComplete,false);assert.equal(status.result.coreUpdateComplete,false);assert.ok(status.result.launcherError);
    assert.equal(f.calls.length,1);assert.deepEqual(f.inventory(),f.before);
  });
});
for(const marker of [null,'/owned/installer/launcher-update/completed-job'])
  for(const includeLauncher of [false,true])test(`new update uses its normal owner after startup (${marker?'self-update reopen':'normal'}, ${includeLauncher?'both':'core'})`,async()=>{
    const calls=[],context=vm.createContext({activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,SELF_UPDATE_JOB:marker,
      launcherError:(message,details)=>Object.assign(new Error(message),details),
      runSharedUpdate:async()=>{calls.push('core');return {version:'2.5.4'};},
      runDesktopUpdate:async()=>{calls.push('both');return {version:'2.5.4',updateComplete:true};},
      operations:()=>assert.fail('a startup argument must not divert a new request into the legacy executor')});
    vm.runInContext(definition('runAction'),context);
    await vm.runInContext('runAction',context)({sender:null},{action:'update',tag:'v2.5.4',runId:'after-reopen',includeLauncher});
    assert.deepEqual(calls,[includeLauncher?'both':'core']);
    context.activeRun=true;
    await assert.rejects(vm.runInContext('runAction',context)({sender:null},{action:'update',runId:'still-busy',includeLauncher}),/正在处理任务/);
    assert.equal(calls.length,1,'an unfinished handoff still prevents concurrent execution');
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
for(const reopened of [false,true])for(const failCore of [false,true])
test(`actual main dispatch and automatic continuation complete one fixed sequence (${reopened?'previous self-update reopen':'normal startup'}, ${failCore?'restored failure then retry':'success'})`,async t=>{
  // Real main/preload dispatch, release selection, compatibility admission,
  // sequence persistence and continuation. Component actors are controlled
  // boundaries; native replacement/transaction tests prove their own recovery.
  const crypto=require('node:crypto'),releases=require('../installer/desktop/releases'),sequence=require('../installer/desktop/update-sequence');
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-dual-route-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'tavern'),manifestFile=path.join(root,'tavern-updates/installed-manifest.json'),program=path.join(root,'apps/tavern-runtime/program');
  const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
  const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),capabilities=releases.LAUNCHER_CAPABILITIES;
  const before={schema:'tavern-release/v2',versions:{tavern:'2.5.3'},commit:'b'.repeat(40)},beforeBytes=JSON.stringify(before,null,2)+'\n';
  write(manifestFile,beforeBytes);write(program,'original core');write(path.join(root,'apps/tavern-ops/updater/task.py'),'existing updater');
  const data=['tavern/tavern-state/native/default-user/chats/story.jsonl','tavern/tavern-state/native/default-user/characters/card.json',
    'tavern/tavern-state/native/worlds/world.json','hermes/config.yaml','hermes/.env','installer/model.json'];
  data.forEach((name,index)=>write(path.join(home,name),'isolated user content '+index));
  const inventory=()=>Object.fromEntries(data.map(name=>[name,sha(fs.readFileSync(path.join(home,name)))])),protectedBefore=inventory();
  const target={schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.5.4'},launcherVersion:'2.2.4',launcherCapabilities:capabilities,
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.2.4',sha256:sha('bootstrap')},
    updateCompatibility:{schema:'nora-core-launcher-compatibility/1',coreVersion:'2.5.4',launcherVersions:['2.2.4'],previousCoreVersions:['2.5.3'],capabilities}};
  const local=path.join(home,'release');fs.mkdirSync(local);const archive='Nora-Tavern-Launcher-2.2.4-'+process.platform+'-'+process.arch+'-update.zip';
  const files={'release-manifest.json':JSON.stringify(target),'tavern-updater-bootstrap.py':'bootstrap',[archive]:'controlled APP actor input',
    ['nora-launcher-'+process.platform+'-'+process.arch+'.json']:JSON.stringify({schema:'nora-launcher/v1',candidate:false,commit:target.commit,
      platform:process.platform,arch:process.arch,version:'2.2.4',asset:archive,sha256:sha('controlled APP actor input'),size:Buffer.byteLength('controlled APP actor input')})};
  files.SHA256SUMS=Object.entries(files).map(([name,bytes])=>sha(bytes)+'  '+name).join('\n');
  for(const [name,bytes]of Object.entries(files))write(path.join(local,name),bytes);
  const fetcher=require('../installer/desktop/local-release').createLocalRelease(local);
  const fixed=await releases.selectPlan({fetcher,tag:'v2.5.4',launcherVersion:'2.2.3'});
  let launcherVersion='2.2.3',state={version:before.versions.tavern,commit:before.commit,systemReady:true},inject=failCore,appOperation;
  const calls=[],records=new Map(),job=path.join(home,'installer/launcher-update/job'),event={sender:{}};
  const record=(requestId,state,effectState)=>{const previous=[...records.values()].find(value=>value.requestId===requestId);
    const value={operationId:previous?.operationId||randomUUID(),requestId,kind:'update',state,effectState,busy:false,
    verification:'confirmed',snapshotSequence:1,recoveryOutcome:state==='rolled-back'?'restored-and-verified':'not-required',
    target:{releasePlan:{tag:fixed.tag,commit:fixed.commit,manifestSha256:sha(fixed.releaseManifestText)}}};
    write(path.join(home,'installer/operations',value.operationId,'operation.json'),JSON.stringify(value));records.set(value.operationId,value);return value;};
  const context=vm.createContext({path,fs,process,activeRun:false,modelBusy:false,cancelled:false,activeOperationContext:null,
    SELF_UPDATE_JOB:reopened?'/previous/completed-job':null,CHANNEL:'stable',desktopUpdateNotice:null,continueDesktopUpdate:null,
    noraHome:()=>home,hermesHome:()=>path.join(home,'hermes'),installRoot:()=>root,installerDirectory:()=>path.join(home,'installer'),
    app:{getVersion:()=>launcherVersion,quit:()=>calls.push('restart')},setImmediate:callback=>callback(),quitReady:false,
    window:{webContents:{}},updateFetch:fetcher,releaseMetadataCache:()=>undefined,releases,updateSequence:sequence,
    desktopSequenceOptions:()=>({capabilities,validatePlan:plan=>releases.validatePlan(plan,{launcherVersion})}),
    require:name=>name==='node:crypto'?crypto:name==='./skill-update'?require('../installer/desktop/skill-update'):name==='./launcher-capability'?{validate:async()=>{}}:name==='./updater-task'?{
      query:async(_home,request)=>({operation:sequence.operation(home,request),settled:true})}:assert.fail('Unexpected dependency '+name),
    launcherError:(message,details)=>Object.assign(new Error(message),details),registerCapabilities:async()=>{},finishOperationTelemetry(){},
    rememberOperationFailure(){},readInstallerState:()=>({}),writeInstallerState(){},finishHandoff(){},
    diagnostics:{clean:value=>value,error:(_event,error)=>calls.push(error.code||'resume-error')},
    launcherRecoveryOptions:()=>({}),launcherUpdate:{launchHandoff:async()=>{},waitHandoff:async()=>{},resume:current=>{
      assert.equal(current,job);return {operationId:appOperation.operationId,planDigest:'c'.repeat(64),target:fixed.tag};}},
    runBridge:async(command,expected)=>command==='status'?state:{...state,updateVerified:expected.version===state.version
      &&expected.commit===state.commit&&expected.manifestSha256===sha(fs.readFileSync(manifestFile))},
    executeAction(){},operations:()=>({start:async(_kind,_options,request)=>{
      calls.push('APP');appOperation=record(request,'awaiting-handoff','changed');appOperation.handoffRef=job;return appOperation;},
      snapshot:async id=>records.get(id),resume:async id=>{assert.equal(id,appOperation.operationId);launcherVersion='2.2.4';
        appOperation.state='succeeded';write(path.join(home,'installer/operations',id,'operation.json'),JSON.stringify(appOperation));return appOperation;}}),
    runSharedUpdate:async(_event,payload)=>{calls.push('core');write(program,'new core');
      if(inject){inject=false;write(program,'original core');write(manifestFile,beforeBytes);record(payload.operationRequestId,'rolled-back','restored');
        throw new Error('controlled core failure after restoration');}
      state={...state,version:target.versions.tavern,commit:target.commit};write(manifestFile,JSON.stringify(target,null,2)+'\n');
      record(payload.operationRequestId,'succeeded','changed');return state;}});
  for(const name of ['requireOperationResult','runDesktopUpdate','runAction'])vm.runInContext(definition(name),context);
  const continuation=nodes.find(node=>node.type==='AssignmentExpression'&&node.left.name==='continueDesktopUpdate');assert.ok(continuation);
  vm.runInContext(source.slice(continuation.start,continuation.end),context);
  const result=await vm.runInContext('runAction',context)(event,{action:'update',tag:'v2.5.4',runId:'single-click',includeLauncher:true});
  assert.equal(result.restarting,true);assert.deepEqual(calls,['APP','restart']);
  context.SELF_UPDATE_JOB=job;context.activeRun=true;
  await vm.runInContext(`(${handoffCallback()})`,context)();
  assert.equal(context.SELF_UPDATE_JOB,null);assert.equal(context.activeRun,false);assert.deepEqual(inventory(),protectedBefore);
  if(failCore){
    assert.equal(context.desktopUpdateNotice.status,'partial');assert.equal(state.version,'2.5.3');assert.equal(fs.readFileSync(program,'utf8'),'original core');
    assert.ok(sequence.load(home,context.desktopSequenceOptions()));
    const retry=await vm.runInContext('runDesktopUpdate',context)(event,{}, {retry:true});assert.equal(retry.updateComplete,true);
  }
  assert.equal(state.version,'2.5.4');assert.equal(launcherVersion,'2.2.4');assert.deepEqual(inventory(),protectedBefore);
  assert.equal(calls.filter(call=>call==='APP').length,1,'compatible APP success is not repeated on retry');
  assert.equal(calls.filter(call=>call==='core').length,failCore?2:1);
  assert.equal(sequence.load(home,context.desktopSequenceOptions()),null,'only a fully verified sequence releases its pointer');
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
    require:name=>{if(name==='./skill-update')return require('../installer/desktop/skill-update');assert.equal(name,'./release-network');return {createReleaseSourceContext:()=>network};},
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
