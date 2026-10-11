const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {create}=require('../installer/desktop/operation-policy');
const {createOperationController}=require('../installer/desktop/operation-state');
const {createTestOperationLock}=require('./launcher_operation_test_lock.cjs');
const id='22aa0935-996f-4f0d-bfbb-567502e850c5';
function setup(t,overrides={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-policy-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const events=[];const record={operationId:id,kind:'install',target:{request:{port:18999}}};
  const context={operationId:id,ownerEpoch:7,get snapshot(){return record;},get target(){return record.target;},check(){},stage:async()=>{},
    plan:async target=>{record.target=target;},journal:async reference=>{record.journalRefs=[reference];}};
  let runtime={effectState:'untouched',reason:'no_journal'};
  const options={home,hermesHome:path.join(home,'hermes'),installRoot:path.join(home,'tavern'),
    bridge:async(command)=>{events.push(command);return {effects:{effectState:'untouched'}};},
    inspectRuntime:()=>runtime,runRuntime:async()=>{events.push('recover-runtime');runtime={effectState:'restored'};},...overrides};
  const journal=path.join(home,'installer/operations',id,'first-install/transaction.json');
  return {home,events,record,context,options,policy:create(options),journal,setRuntime:next=>{runtime=next;}};
}
test('a failure before any journal exists stays untouched without executing recovery',async t=>{
  const f=setup(t);
  assert.equal((await f.policy.observe(f.record)).effectState,'untouched');
  assert.equal((await f.policy.recover(f.context)).effectState,'untouched');
  assert.deepEqual(f.events,[]);
});
test('whole-install recovery waits for the system writer before restoring the runtime',async t=>{
  const order=[];let runtime={effectState:'changed',reason:'committed'};
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    order.push(command);
    if(command==='operation-effects')return {effects:{effectState:'changed',canRecover:true}};
    if(command==='recover-install')return {firstInstallRecovered:true,recoveryVerification:'confirmed'};
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
  },runRuntime:async()=>{order.push('runtime-closed');runtime={effectState:'restored'};}});
  fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'confirmed');
  assert.deepEqual(order,['operation-effects','recover-install','recovery-stop','runtime-closed']);
});
test('whole-install recovery reports the final absent runtime rather than the intermediate installed core',async t=>{
  let runtime={effectState:'changed',reason:'committed'};
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    if(command==='operation-effects')return {effects:{effectState:'changed',canRecover:true}};
    if(command==='recover-install')return {firstInstallRecovered:true,recoveryVerification:'confirmed',
      hermesInstalled:true,noraInstalled:true,installed:true,systemReady:true,setupCompleted:true,
      running:false,gatewayRunning:false,clawchatConnected:false};
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
    throw new Error(`The absent Python runtime cannot execute ${command}`);
  },runRuntime:async()=>{runtime={effectState:'restored',reason:'previous-absent'};}});
  fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'confirmed');
  assert.equal(result.value.firstInstallRecovered,true);
  for(const key of ['installed','hermesInstalled','noraInstalled','systemReady','setupCompleted','running','gatewayRunning','clawchatConnected'])
    assert.equal(result.value[key],false,key);
});
test('whole recovery rechecks the restored core and restores only the original recorded service',async t=>{
  let runtime={effectState:'changed'},running=false;
  const calls=[];
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async(command,options)=>{
    calls.push([command,options]);
    if(command==='operation-effects')return {effects:{effectState:'changed',canRecover:true}};
    const state={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
      version:'2.4.2',running,gatewayRunning:false,clawchatConnected:false};
    if(command==='recover-install')return {...state,running:true,firstInstallRecovered:true,recoveryVerification:'confirmed'};
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
    if(command==='status')return state;
    if(command==='verify-current-update')return {...state,updateVerified:true};
    if(command==='start'){assert.equal(options.service,'tavern');running=true;return {...state,running};}
    throw new Error(`Unexpected command ${command}`);
  },runRuntime:async()=>{runtime={effectState:'restored'};}});
  fs.mkdirSync(f.options.hermesHome);fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'confirmed');assert.equal(result.value.running,true);
  assert.equal(result.value.gatewayRunning,false);
  assert.deepEqual(calls.map(([command])=>command),['operation-effects','recover-install','recovery-stop','status','verify-current-update','start','status']);
  assert.equal(calls.find(([command])=>command==='verify-current-update')[1].version,'2.4.2');
});
test('failed final service restoration keeps a bounded recovery choice and never exchanges files again',async t=>{
  let runtime={effectState:'changed'},filesRestored=false,running=false,allowStart=false,runtimeRestores=0,systemRestores=0;
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    if(command==='operation-effects')return {effects:{effectState:filesRestored?'restored':'changed',canRecover:!filesRestored}};
    const state={installed:true,hermesInstalled:true,noraInstalled:true,systemReady:true,setupCompleted:true,
      version:'2.4.2',running,gatewayRunning:false,clawchatConnected:false};
    if(command==='recover-install'){systemRestores++;filesRestored=true;
      return {...state,running:true,firstInstallRecovered:true,recoveryVerification:'confirmed'};}
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
    if(command==='status')return state;
    if(command==='verify-current-update')return {...state,updateVerified:true};
    if(command==='start'){if(!allowStart)throw Object.assign(new Error('old service failed to start'),{code:'PROCESS_START_FAILED'});
      running=true;return {...state,running};}
    throw new Error(`Unexpected command ${command}`);
  },runRuntime:async()=>{runtimeRestores++;runtime={effectState:'restored'};}});
  fs.mkdirSync(f.options.hermesHome);fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const first=await f.policy.recover(f.context);
  assert.equal(first.verification,'failed');assert.equal(first.filesRestored,true);assert.equal(first.value.running,false);
  assert.equal(first.secondaryErrors[0].error.code,'PROCESS_START_FAILED');
  f.record.result=first.value;f.record.recoveryOutcome='files-restored-start-failed';allowStart=true;
  const next=await f.policy.recover(f.context);
  assert.equal(next.verification,'confirmed');assert.equal(next.value.running,true);
  assert.equal(runtimeRestores,1);assert.equal(systemRestores,1);
});
test('an incomplete final status is never replaced with the earlier healthy status',async t=>{
  let runtime={effectState:'changed'};
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    if(command==='operation-effects')return {effects:{effectState:'changed',canRecover:true}};
    if(command==='recover-install')return {firstInstallRecovered:true,recoveryVerification:'confirmed',
      version:'2.4.2',running:true,gatewayRunning:false,clawchatConnected:false,hermesInstalled:true};
    if(command==='recovery-stop')return {offline:true,running:false,gatewayRunning:false};
    if(command==='status')return {running:false};
    throw new Error(`Unconfirmed status must not execute ${command}`);
  },runRuntime:async()=>{runtime={effectState:'restored'};}});
  fs.mkdirSync(f.options.hermesHome);fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'failed');assert.equal(result.filesRestored,true);
  assert.equal(result.value.hermesInstalled,undefined);assert.equal(result.value.running,undefined);
  assert.equal(result.value.recoveryServiceState.running,true);
});
test('an exit result without actual stop proof never allows runtime rollback',async t=>{
  let restored=false;
  const f=setup(t,{inspectRuntime:()=>({effectState:'changed'}),bridge:async()=>({running:false}),runRuntime:async()=>{restored=true;}});
  await assert.rejects(f.policy.recover(f.context),{code:'VERIFICATION_FAILED'});
  assert.equal(restored,false);
});
test('unknown configuration effects block mutation and cannot reset retries',async t=>{
  let writes=0;
  const f=setup(t,{bridge:async()=>({effects:{effectState:'unknown',canRecover:false}}),
    runRuntime:async()=>{writes++;},checkConditions:async()=>({eligible:true,facts:{network:true}})});
  fs.mkdirSync(path.dirname(f.journal),{recursive:true});fs.writeFileSync(f.journal,'fixture');
  assert.equal((await f.policy.observe(f.record)).canRecover,false);
  await assert.rejects(f.policy.recover(f.context),{code:'UPDATE_RECOVERY_REQUIRED'});
  assert.equal((await f.policy.recheck(f.record)).changed,false);
  assert.equal(writes,0);
});
test('a first healthy measurement without a failure-bound baseline cannot grant attempts',async t=>{
  const f=setup(t,{checkConditions:async()=>({eligible:true,facts:{release:true,directory:[1,2]}})});
  const first=await f.policy.recheck(f.record);assert.equal(first.changed,false);
  assert.equal(first.baseline,undefined);
  assert.equal((await f.policy.recheck(f.record)).changed,false);
});

function capturedInstallPolicy(t,{tag}={}){
  const captured=JSON.parse(require('node:zlib').brotliDecompressSync(fs.readFileSync(path.join(__dirname,'fixtures/published-v2.4.4/metadata.json.br'))));
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-install-recheck-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const directory=path.join(home,'installer');fs.mkdirSync(directory);
  const requests=[];
  const networkFetch=async url=>{
    requests.push(url);
    if(url==='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest'
      ||url==='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/v2.4.4')return Response.json(captured.release);
    const asset=captured.release.assets.find(item=>item.browser_download_url===url);
    assert.ok(asset&&captured.files[asset.name],`Only captured official metadata can be read: ${url}`);
    return new Response(captured.files[asset.name],{headers:{'Content-Type':'application/json'}});
  };
  const policyOptions={home,hermesHome:path.join(home,'hermes'),installRoot:path.join(home,'tavern'),
    bridge:async()=>{throw new Error('Untouched selection must not call the system writer');},
    runRuntime:async()=>{throw new Error('Rechecking metadata must not move runtime files');},
    networkFetch,launcherVersion:'2.1.1',platform:'win32',arch:'x64'};
  let policy=create(policyOptions),failedSelection=true,runs=0,failAfterSelection=false;
  const options={directory,lock:createTestOperationLock(),captureConditions:(record,context)=>policy.initialConditions(record,context),
    identifyFailureCondition:(error,record)=>policy.identifyFailureCondition(error,record),observeEffects:record=>policy.observe(record),
    recheckers:{install:(record,context)=>policy.recheck(record,context)},executors:{install:async context=>{
      runs++;
      if(failedSelection||failAfterSelection)throw new Error('完整系统与固定发布清单校验信息不符。');
      const operationDirectory=path.join(directory,'operations',context.operationId);
      const releases=require('../installer/desktop/releases');
      const plan=await releases.selectPlan({fetcher:networkFetch,launcherVersion:'2.1.1',platform:'win32',arch:'x64',mode:'install',tag});
      await context.plan({...context.target,releasePlan:releases.sealPlan(plan,{operationDirectory,assertOwner:()=>context.check(),launcherVersion:'2.1.1'})});
      return {verification:'confirmed'};
    }}};
  const target={request:{action:'install',...(tag?{tag}:{})}};
  return {home,directory,requests,options,target,policyOptions,reopen:()=>createOperationController(options),
    replaceLauncher:()=>{failedSelection=false;policy=create(policyOptions);},failAgain:()=>{failAfterSelection=true;},runs:()=>runs};
}

test('a fixed system descriptor read may prove network recovery before the launcher minimum handoff without authorizing installation',async t=>{
  const releases=require('../installer/desktop/releases');
  const captured=JSON.parse(require('node:zlib').brotliDecompressSync(fs.readFileSync(path.join(__dirname,'fixtures/published-v2.4.4/metadata.json.br'))));
  const descriptor=JSON.parse(captured.files['nora-system-win32-x64.json']);
  descriptor.minimumLauncherVersion='2.1.2';
  const url=releases.assetUrl(captured.release,'nora-system-win32-x64.json'),resource={url,routeHash:'a'.repeat(64),expectedSystemVersion:captured.release.tag_name};
  let current=descriptor,requests=0;
  const f=setup(t,{launcherVersion:'2.1.1',platform:'win32',arch:'x64',networkFetch:async()=>{requests++;return Response.json(current);}});
  Object.assign(f.record,{state:'failed',stageId:'downloading',effectState:'untouched',recoveryOutcome:'not-required',target:{request:{tag:captured.release.tag_name}}});
  f.record.conditionBaseline=await f.policy.initialConditions(f.record);
  f.record.conditionFingerprint=f.record.conditionBaseline.fingerprint;
  const condition={kind:'release-metadata',resource,retryAt:null};
  f.record.primaryFailure={code:'ETIMEDOUT',conditionTarget:condition};
  const proved=await f.policy.recheck(f.record);
  assert.equal(proved.changed,true);assert.equal(proved.baseline.facts.networkReads.length,1);
  assert.equal(proved.baseline.facts.installSelections,undefined);
  assert.throws(()=>releases.validateSystem(descriptor,null,'win32','x64','2.1.1'),/2\.1\.2/);
  await assert.rejects(releases.selectPlan({selectedRelease:captured.release,mode:'install',launcherVersion:'2.1.1',platform:'win32',arch:'x64',
    fetcher:async read=>read===url?Response.json(descriptor):new Response(captured.files[captured.release.assets.find(asset=>asset.browser_download_url===read)?.name])}),/2\.1\.2/);
  f.record.conditionBaseline=proved.baseline;f.record.conditionFingerprint=proved.fingerprint;
  assert.equal((await f.policy.recheck(f.record)).changed,false);assert.equal(requests,1);
  for(const malformed of [
    {...descriptor,version:'2.4.3'}, {...descriptor,platform:'darwin'}, {...descriptor,candidate:true},
    {...descriptor,minimumLauncherVersion:'invalid'}, {...descriptor,files:{}},
  ]){
    current=malformed;f.record.conditionBaseline=await f.policy.initialConditions(f.record);
    assert.equal((await f.policy.recheck(f.record)).changed,false);
  }
  current=descriptor;f.record.conditionBaseline=await f.policy.initialConditions(f.record);
  for(const invalid of [
    {...resource,expectedSystemVersion:'v2.4.3'}, {...resource,expectedVersion:'2.1.1'},
    {...resource,url:url.replace('win32-x64','darwin-arm64')}, {...resource,url:url.replace('nora-system','nora-launcher')},
  ])assert.equal((await f.policy.recheck(f.record,{conditionTarget:{...condition,resource:invalid}})).changed,false);
  assert.equal((await f.policy.recheck(f.record,{conditionTarget:{...condition,resource:{url,routeHash:resource.routeHash,expectedVersion:'2.1.1'}}})).changed,false,
    'legacy proof must retain its original launcher minimum gate');
  current={...descriptor,minimumLauncherVersion:'2.1.1'};
  assert.equal((await f.policy.recheck(f.record,{conditionTarget:{...condition,resource:{url,routeHash:resource.routeHash,expectedVersion:'2.1.1'}}})).changed,true,
    'legacy proofs remain readable under their original launcher minimum');
});

test('official platform selection unblocks an untouched legacy first-install operation while preserving its identity and first failure',async t=>{
  const f=capturedInstallPolicy(t,{tag:'v2.4.4'}),controller=f.reopen();
  const first=await controller.start('install',{target:f.target},'legacy-install');
  const repeated=await controller.resume(first.operationId,{snapshotSequence:first.snapshotSequence});
  assert.equal(repeated.attempt,2);assert.deepEqual(repeated.allowedActions,['recheck','logs']);
  assert.equal(repeated.effectState,'untouched');assert.equal(repeated.target.releasePlan,undefined);
  f.replaceLauncher();f.requests.length=0;
  const checked=await f.reopen().recheck(repeated.operationId,{snapshotSequence:repeated.snapshotSequence});
  assert.equal(checked.operationId,repeated.operationId);assert.deepEqual(checked.primaryFailure,repeated.primaryFailure);
  assert.ok(checked.allowedActions.includes('retry'));
  assert.ok(f.requests.includes('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/v2.4.4'));
  assert.ok(f.requests.some(url=>url.endsWith('/win32-x64-release-manifest.json')));
  assert.equal(f.requests.some(url=>url.endsWith('/release-manifest.json')),false);
  const record=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',first.operationId,'operation.json')));
  assert.equal(record.conditionBaseline.facts.installSelections.length,1);
  assert.equal(record.target.releasePlan,undefined,'Recheck must not overwrite or seal the old target');
  const succeeded=await f.reopen().resume(checked.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(succeeded.operationId,first.operationId);assert.equal(succeeded.state,'succeeded');
  assert.deepEqual(succeeded.primaryFailure,first.primaryFailure);
  assert.equal(succeeded.target.releasePlan.systemManifest.files['release-manifest.json'].asset,'win32-x64-release-manifest.json');
  assert.equal(f.runs(),3);
});

test('the same accepted platform selection cannot repeatedly renew retry allowance after reopening or changing launcher version',async t=>{
  const f=capturedInstallPolicy(t),controller=f.reopen();
  const first=await controller.start('install',{target:f.target},'legacy-repeat');
  const second=await controller.resume(first.operationId,{snapshotSequence:first.snapshotSequence});f.replaceLauncher();
  const checked=await f.reopen().recheck(second.operationId,{snapshotSequence:second.snapshotSequence});
  assert.ok(checked.allowedActions.includes('retry'));f.failAgain();
  const again=await f.reopen().resume(checked.operationId,{snapshotSequence:checked.snapshotSequence});
  const twice=await f.reopen().resume(again.operationId,{snapshotSequence:again.snapshotSequence});
  assert.deepEqual(twice.allowedActions,['recheck','logs']);
  const saved=fs.readFileSync(path.join(f.directory,'operations',first.operationId,'operation.json'));
  f.policyOptions.launcherVersion='2.1.2';f.replaceLauncher();
  const same=await f.reopen().recheck(twice.operationId,{snapshotSequence:twice.snapshotSequence});
  assert.deepEqual(same.allowedActions,['recheck','logs']);
  assert.deepEqual(fs.readFileSync(path.join(f.directory,'operations',first.operationId,'operation.json')),saved);
  await assert.rejects(f.reopen().resume(same.operationId,{snapshotSequence:same.snapshotSequence}),{code:'OPERATION_ACTION_UNAVAILABLE'});
});

test('first-install selection recheck refuses frozen plans, uncertain effects, journals, replacement jobs, and redirected operation directories',async t=>{
  for(const obstacle of ['releasePlan','changed','unknown','runtime-journal','first-journal','system-journal','replacement','symbolic-link','home-link','install-root-link','handoff','journal-ref','channel','platform','arch']){
    const f=capturedInstallPolicy(t),first=await f.reopen().start('install',{target:f.target},`blocked-${obstacle}`);
    f.replaceLauncher();
    const operationDirectory=path.join(f.directory,'operations',first.operationId),file=path.join(operationDirectory,'operation.json');
    const record=JSON.parse(fs.readFileSync(file));
    if(obstacle==='releasePlan'){record.target.releasePlan={schema:'nora-release-plan/1'};fs.writeFileSync(file,JSON.stringify(record));}
    if(['changed','unknown'].includes(obstacle))f.policyOptions.inspectRuntime=()=>({effectState:obstacle,recoveryOutcome:'recovery-required',canRecover:false});
    if(obstacle==='handoff')record.handoffRef='/unowned/launcher-job';
    if(obstacle==='journal-ref')record.journalRefs=['runtime-bootstrap.json'];
    if(['channel','platform','arch'].includes(obstacle))record.target.request[obstacle]='another-target';
    if(obstacle==='runtime-journal')fs.writeFileSync(path.join(operationDirectory,'runtime-bootstrap.json'),'{}');
    if(obstacle==='first-journal'){fs.mkdirSync(path.join(operationDirectory,'first-install'));fs.writeFileSync(path.join(operationDirectory,'first-install/transaction.json'),'{}');}
    if(obstacle==='system-journal'){fs.mkdirSync(path.join(f.home,'tavern/tavern-updates'),{recursive:true});fs.writeFileSync(path.join(f.home,'tavern/tavern-updates/transaction.json'),'{}');}
    if(obstacle==='replacement'){fs.mkdirSync(path.join(f.home,'installer/launcher-update/job-pending'),{recursive:true});}
    if(obstacle==='symbolic-link'){
      fs.mkdirSync(path.join(f.home,'other-operation'));fs.symlinkSync(path.join(f.home,'other-operation'),path.join(operationDirectory,'release-plan'),'dir');
    }
    if(obstacle==='home-link'){const linked=f.home+'-link';fs.symlinkSync(f.home,linked,'dir');t.after(()=>fs.unlinkSync(linked));f.policyOptions.home=linked;}
    if(obstacle==='install-root-link')fs.symlinkSync(f.home,path.join(f.home,'tavern'),'dir');
    const policy=create(f.policyOptions);f.requests.length=0;
    const proof=await policy.recheck(record);
    assert.equal(proof.changed,false,obstacle);assert.deepEqual(f.requests,[],obstacle);
  }
});

test('accepted first-install selection proofs are bounded and an exhausted or invalid proof history cannot grant attempts',async t=>{
  for(const count of [8,9]){
    const f=capturedInstallPolicy(t),first=await f.reopen().start('install',{target:f.target},`bounded-${count}`);f.replaceLauncher();
    const file=path.join(f.directory,'operations',first.operationId,'operation.json'),record=JSON.parse(fs.readFileSync(file));
    record.attempt=2;record.conditionBaseline.facts.installSelections=Array.from({length:count},(_,index)=>({
      identity:require('node:crypto').createHash('sha256').update(`accepted-old-${index}`).digest('hex'),verified:true}));
    record.conditionBaseline.fingerprint=require('node:crypto').createHash('sha256').update(JSON.stringify(record.conditionBaseline.facts)).digest('hex');
    record.conditionFingerprint=record.conditionBaseline.fingerprint;fs.writeFileSync(file,JSON.stringify(record));
    const before=fs.readFileSync(file);f.requests.length=0;
    const checked=await f.reopen().recheck(first.operationId,{snapshotSequence:first.snapshotSequence});
    assert.deepEqual(checked.allowedActions,['recheck','logs']);assert.deepEqual(f.requests,[]);
    assert.deepEqual(fs.readFileSync(file),before);assert.equal(f.runs(),1);
  }
});

test('first-install verification cannot grant attempts when a journal appears during the metadata read or the writer lease is lost',async t=>{
  for(const interruption of ['journal','lease']){
    const f=capturedInstallPolicy(t),first=await f.reopen().start('install',{target:f.target},`mid-read-${interruption}`);f.replaceLauncher();
    const file=path.join(f.directory,'operations',first.operationId,'operation.json'),record=JSON.parse(fs.readFileSync(file));
    const fetch=f.policyOptions.networkFetch;let lost=false;
    f.policyOptions.networkFetch=async(...args)=>{
      const result=await fetch(...args);
      if(interruption==='journal')fs.mkdirSync(path.join(path.dirname(file),'first-install'),{recursive:true});
      else lost=true;
      return result;
    };
    const proof=await create(f.policyOptions).recheck(record,{lease:{assertActive(){if(lost)throw Object.assign(new Error('lost writer'),{code:'LOCK_GUARD_LOST'});}}});
    assert.equal(proof.changed,false);assert.equal(record.conditionBaseline.facts.installSelections,undefined);
  }
});

test('failed official platform metadata verification preserves the blocked operation without granting attempts',async t=>{
  const f=capturedInstallPolicy(t),first=await f.reopen().start('install',{target:f.target},'invalid-official');
  const twice=await f.reopen().resume(first.operationId,{snapshotSequence:first.snapshotSequence});f.replaceLauncher();
  const fetch=f.policyOptions.networkFetch;
  f.policyOptions.networkFetch=async(...args)=>{
    const response=await fetch(...args);
    return args[0].endsWith('/win32-x64-release-manifest.json')?new Response((await response.text())+' ',{headers:{'Content-Type':'application/json'}}):response;
  };
  f.options.recheckers.install=(record,context)=>create(f.policyOptions).recheck(record,context);
  const file=path.join(f.directory,'operations',first.operationId,'operation.json'),before=fs.readFileSync(file);
  const checked=await f.reopen().recheck(twice.operationId,{snapshotSequence:twice.snapshotSequence});
  assert.deepEqual(checked.allowedActions,['recheck','logs']);assert.deepEqual(fs.readFileSync(file),before);
});

test('directory repair preserves consumed first-install selection identities, including an exhausted eight-entry history',async t=>{
  for(const count of [1,8]){
    const f=capturedInstallPolicy(t),first=await f.reopen().start('install',{target:f.target},`directory-history-${count}`);
    const record=JSON.parse(fs.readFileSync(path.join(f.directory,'operations',first.operationId,'operation.json')));
    const hash=facts=>require('node:crypto').createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    record.conditionBaseline.facts.directories[0].writable=false;
    record.conditionBaseline.fingerprint=hash(record.conditionBaseline.facts);record.conditionFingerprint=record.conditionBaseline.fingerprint;
    const policy=create(f.policyOptions),selected=await policy.recheck(record);assert.equal(selected.changed,true);
    for(let index=1;index<count;index++)selected.baseline.facts.installSelections.push({identity:hash({accepted:index}),verified:true});
    selected.baseline.fingerprint=hash(selected.baseline.facts);record.conditionBaseline=selected.baseline;
    record.conditionFingerprint=selected.baseline.fingerprint;record.currentFailure={conditionTarget:{kind:'directory-write',directory:'noraHome'}};
    const conditions=JSON.parse(JSON.stringify(record.conditionBaseline.facts));delete conditions.installSelections;conditions.directories[0].writable=true;
    const directoryPolicy=create({...f.policyOptions,networkFetch:async()=>{throw Object.assign(new Error('temporarily offline'),{code:'ENOTFOUND'});},
      checkConditions:()=>({schema:'nora-operation-conditions/1',facts:conditions,fingerprint:hash(conditions)})});
    const repaired=await directoryPolicy.recheck(record);assert.equal(repaired.changed,true);
    assert.deepEqual(repaired.baseline.facts.installSelections,selected.baseline.facts.installSelections);
    record.conditionBaseline=repaired.baseline;record.conditionFingerprint=repaired.fingerprint;
    const repeated=await policy.recheck(record);assert.equal(repeated.changed,false);
  }
});

test('historical recovery is an explicit sealed choice and requires positive stop proof before a file writer',async t=>{
  const legacy={kind:'legacy',canRecover:true,journalDigest:'a'.repeat(64),journalReference:'/fixture/journal',
    restoreVersion:'2.4.2',dataPolicy:'restore-backup-preserve-current'};
  const order=[];
  const f=setup(t,{inspectLegacy:()=>legacy,bridge:async command=>{
    order.push(command);return {offline:true,running:false,gatewayRunning:false};
  },runLegacy:async(context,request)=>{
    order.push('restore-files');assert.equal(request.journalDigest,legacy.journalDigest);
    assert.deepEqual(request.offlineProof,{operationId:id,ownerEpoch:7,offline:true,running:false,gatewayRunning:false});
    return {legacyFilesRestored:true,effectState:'restored',recoveryVerification:'files-only',restoreVersion:'2.4.2'};
  }});
  await assert.rejects(f.policy.recover(f.context,{error:new Error('update failed')}),{code:'UPDATE_RECOVERY_REQUIRED'});
  assert.deepEqual(order,[]);
  const result=await f.policy.recover(f.context);
  assert.deepEqual(order,['recovery-stop','restore-files']);
  assert.equal(result.verification,'failed');assert.equal(result.filesRestored,true);
  assert.equal(result.value.originalServiceState,'unrecorded');assert.equal(f.record.target.legacyRecovery.journalDigest,legacy.journalDigest);
});

test('a changed legacy journal or unconfirmed service stop cannot move either tree',async t=>{
  let restored=false;
  const legacy={canRecover:true,journalDigest:'a'.repeat(64),journalReference:'/fixture/journal'};
  const f=setup(t,{inspectLegacy:()=>legacy,bridge:async()=>({running:false}),runLegacy:async()=>{restored=true;}});
  f.record.target.legacyRecovery={journalDigest:'b'.repeat(64)};
  await assert.rejects(f.policy.recover(f.context),{code:'CONDITIONS_CHANGED'});
  delete f.record.target.legacyRecovery;
  await assert.rejects(f.policy.recover(f.context),{code:'VERIFICATION_FAILED'});
  assert.equal(restored,false);
});

test('a restored historical version starts only after actual fixed-version acceptance and never restores files twice',async t=>{
  const calls=[];
  const f=setup(t,{inspectLegacy:()=>null,bridge:async(command,options)=>{
    calls.push([command,options]);return command==='start'?{running:true,systemReady:true,version:'2.4.2'}:
      {updateVerified:true,systemReady:true,version:'2.4.2'};
  },runLegacy:async()=>{throw new Error('must not restore twice');}});
  f.record.kind='recover';f.record.result={legacyFilesRestored:true,restoreVersion:'2.4.2',port:18999};
  const result=await f.policy.recover(f.context);
  assert.equal(result.verification,'confirmed');assert.equal(result.value.legacyServicesVerified,true);
  assert.deepEqual(calls.map(call=>call[0]),['verify-current-update','start']);
  assert.equal(calls[0][1].version,'2.4.2');assert.equal(calls[1][1].service,'tavern');
});

test('an APP handoff without a trusted inspector is unknown and blocks system recovery',async t=>{
  const f=setup(t);f.record.kind='update';f.record.handoffRef='/unconfirmed/app-job';
  assert.equal((await f.policy.observe(f.record)).effectState,'unknown');
  await assert.rejects(f.policy.recover(f.context),{code:'LAUNCHER_RECOVERY_REQUIRED'});
  assert.deepEqual(f.events,[]);
});

test('a restored runtime with failed probe remains pending until the real recovery executor verifies it',async t=>{
  let runtime={effectState:'restored',recoveryOutcome:'recovery-required',canRecover:true,reason:'runtime-verification-required'};
  const calls=[];
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async command=>{
    calls.push(command);return {offline:true,running:false,gatewayRunning:false};
  },runRuntime:async()=>{calls.push('runtime-probe');runtime={effectState:'restored',recoveryOutcome:'restored'};},
    checkConditions:async()=>{throw new Error('network checks cannot clear pending runtime acceptance');}});
  const facts=await f.policy.observe(f.record);
  assert.equal(facts.recoveryOutcome,'recovery-required');assert.equal(facts.canRecover,true);
  assert.equal((await f.policy.recheck(f.record)).changed,false);
  const recovered=await f.policy.recover(f.context);
  assert.equal(recovered.verification,'confirmed');assert.deepEqual(calls,['recovery-stop','runtime-probe']);
});

test('a recovery process exit without confirmation of the restored runtime cannot complete recovery',async t=>{
  const runtime={effectState:'restored',recoveryOutcome:'recovery-required',canRecover:true};
  const f=setup(t,{inspectRuntime:()=>runtime,bridge:async()=>({offline:true,running:false,gatewayRunning:false}),runRuntime:async()=>{}});
  await assert.rejects(f.policy.recover(f.context),{code:'UPDATE_RECOVERY_REQUIRED'});
});
