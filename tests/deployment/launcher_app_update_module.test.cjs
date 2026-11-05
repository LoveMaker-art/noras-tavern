const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {EventEmitter}=require('node:events'),vm=require('node:vm');
const {createRequire}=require('node:module');
const update=require('../installer/desktop/launcher-update');
const releases=require('../installer/desktop/releases');
const {createLocalRelease}=require('../installer/desktop/local-release');
const desktop=path.resolve(__dirname,'../installer/desktop');
const python=process.env.NORA_TEST_PYTHON||process.env.NORA_PYTHON||'python3';
// Keep the exact NTFS file identities written by Python when editing a fixture.
const mutableRecovery=bytes=>JSON.parse(bytes.toString('utf8'),(_key,value,context)=>
  typeof value==='number'&&!Number.isSafeInteger(value)&&Number.isInteger(value)?JSON.rawJSON(context.source):value);
const setup=String.raw`
import sys,json,importlib.util,hashlib,uuid,os,shutil
from pathlib import Path
p=json.load(sys.stdin);helper=Path(p['helper']);home=Path(p['home']);app=Path(p['app']);job=Path(p['job']);operation=p['operation']
s=importlib.util.spec_from_file_location('module_fixture_replacement',helper);r=importlib.util.module_from_spec(s);s.loader.exec_module(r)
for n in ('operation_control.py','operation_evidence.py','error_diagnostics.py','operation-budget.json'):shutil.copy2(helper.parent.parent/n,job/n)
shutil.copy2(helper,job/'replace.py')
plan={'schema':2,'token':str(uuid.uuid4()),'home':str(home),'appRoot':str(app),'executable':p['relative'],'platform':p['platform'],'arch':p['arch'],'version':'1.1.0','previousVersion':'1.0.0','target':'v2.6.0','operationId':operation['operationId'],'ownerEpoch':operation['ownerEpoch'],'planDigest':operation['planDigest'],'releasePlan':operation['target']['releasePlan'],'executorProtocol':'nora-operation-executor/1','rollbackCompatibility':{'operationSchema':'nora-operation/1','executorProtocol':'nora-operation-executor/1','telemetrySchema':3,'faultSchema':2,'compatible':True},'parentPid':os.getpid(),'parentCreationTime':1}
r.write_json(job/'plan.json',plan);ctx=r.context(job)
old={'identity':r.file_identity(app),'digest':r.tree_digest(app,p['platform']),'version':'1.0.0'}
os.replace(app,ctx['backup']);app.mkdir();(app/p['relative']).parent.mkdir(parents=True,exist_ok=True);(app/p['relative']).write_text('new synthetic APP')
incoming={'identity':r.file_identity(app),'digest':r.tree_digest(app,p['platform'])}
snapshot={k:plan[k] for k in ('token','home','appRoot','executable','platform','arch','version','target','operationId','ownerEpoch','planDigest','releasePlan','executorProtocol','rollbackCompatibility','parentPid','parentCreationTime')}
snapshot.update(schema='nora-launcher-recovery/1',homeIdentity=r.file_identity(home),helperDigest=r.digest(job/'replace.py'),resourceDigests={n:r.digest(job/n) for n in ('operation_control.py','operation_evidence.py','error_diagnostics.py','operation-budget.json')},old=old,incoming=incoming,planSeal=hashlib.sha256(json.dumps(plan,sort_keys=True,separators=(',',':')).encode()).hexdigest(),workerPid=2147483647,workerCreationTime=1)
r.checkpoint(ctx,snapshot,'awaiting-system')
if p['phase']=='prepared':
    os.replace(app,ctx['stage']);os.replace(ctx['backup'],app)
    snapshot.update(stageIdentity=r.file_identity(ctx['stage']),stageDigest=r.tree_digest(ctx['stage'],p['platform']),incomingRelative='.')
    r.checkpoint(ctx,snapshot,'prepared')
elif p['phase']=='committed':
    r.write_json(job/'ready.json',{'schema':'nora-launcher-handoff/1','token':plan['token'],'version':plan['version'],'operationId':plan['operationId'],'planDigest':plan['planDigest']})
    r.finalize(job,target=plan['target'],version=plan['version'],verified=True)
elif p['phase']=='restored':
    os.replace(app,ctx['failed']);os.replace(ctx['backup'],app);r.checkpoint(ctx,snapshot,'restored')
elif p['phase']=='cancelled':
    os.replace(app,ctx['stage']);os.replace(ctx['backup'],app);r.checkpoint(ctx,snapshot,'cancelled')
print(json.dumps({'phase':r.read_json(job/'recovery.json')['phase']}))
`;
function fixture(t,{phase='committed',launcherOnly=true,releasePlan,platform=process.platform,arch=process.arch}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-module-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'data'),app=path.join(root,'app'),job=path.join(home,'installer/launcher-update/job-fixture');
  fs.mkdirSync(job,{recursive:true});fs.mkdirSync(app);
  const relative=process.platform==='darwin'?'Contents/MacOS/launcher':'launcher.exe',executable=path.join(app,relative);
  fs.mkdirSync(path.dirname(executable),{recursive:true});fs.writeFileSync(executable,'old synthetic APP');
  const target={request:{action:'update',...(launcherOnly?{launcherOnly:true}:{})},releasePlan:releasePlan||{schema:'nora-release-plan/1'}};
  const operation={operationId:crypto.randomUUID(),ownerEpoch:1,kind:'update',state:'verifying',target,
    planDigest:crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex'),handoffRef:job};
  const operationDirectory=path.join(home,'installer/operations',operation.operationId);
  fs.mkdirSync(operationDirectory,{recursive:true});
  if(releasePlan){
    target.releasePlan=releases.sealPlan(releasePlan,{operationDirectory,launcherVersion:'1.0.0',assertOwner:()=>{}});
    operation.planDigest=crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex');
  }
  const protectedPaths=['hermes/config.yaml','hermes/skills/custom/SKILL.md','tavern/tavern-state/chats/story.jsonl'];
  for(const name of protectedPaths){const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'current content including malformed core metadata: '+name);}
  const before=protectedPaths.map(name=>fs.readFileSync(path.join(home,name)));
  const helper=path.join(desktop,'replace-launcher.py');
  execFileSync(python,['-B','-c',setup],{encoding:'utf8',input:JSON.stringify({home,app,job,helper,relative,operation,phase,platform,arch})});
  return {home,app,job,executable,operation,helper,python,operationDirectory,assertPreserved:()=>protectedPaths.forEach((name,i)=>assert.deepEqual(fs.readFileSync(path.join(home,name)),before[i]))};
}
function publication(t,{platform=process.platform,arch=process.arch}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-publication-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('offline APP archive fixture'),version='1.1.0',asset=`Nora-Tavern-Launcher-${version}-${platform}-${arch}-update.zip`;
  const manifest={schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.6.0'},
    launcherVersion:version,launcherCapabilities:{...releases.LAUNCHER_CAPABILITIES},bootstrap:{malformedCore:'outside APP admission'}};
  const item={schema:'nora-launcher/v1',version,platform,arch,asset,
    sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
  fs.writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.join(root,`nora-launcher-${platform}-${arch}.json`),JSON.stringify(item));
  fs.writeFileSync(path.join(root,asset),bytes);
  return {fetcher:createLocalRelease(root),channel:'stable',networkPolicy:{maxAttempts:1,totalBudgetMs:3000,attemptTimeoutMs:1000,backoffMs:[0]},
    platform,arch,launcherVersion:'1.0.0'};
}
function contextFor(operation){
  const stages=[],effects=[],handoffs=[];
  return {get snapshot(){return operation;},get target(){return operation.target;},stages,effects,handoffs,
    check:()=>{},plan:async target=>{operation.target=target;operation.planDigest=crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex');},
    stage:async stage=>{operation.state=stage;stages.push(stage);},effect:async effect=>{operation.effectState=effect;effects.push(effect);},
    handoff:async job=>{operation.handoffRef=job;handoffs.push(job);}};
}
for(const state of ['awaiting-handoff','verifying','committing','interrupted','failed'])
test(`APP module terminal proof is independent from the raw original task stage (${state})`,async t=>{
  const f=fixture(t);f.operation.state=state;let checks=0;
  const result=await update.reconcileAppHandoff({...f,context:{check:()=>checks++}});
  assert.equal(result.status,'committed');assert.equal(result.verification,'confirmed');
  assert.equal(result.value.appUpdateComplete,true);assert.equal(result.value.coreUpdateComplete,false);
  assert.equal(result.value.launcherVersion,'1.1.0');assert.equal(result.value.systemReady,undefined);
  assert.equal(checks>=2,true);f.assertPreserved();
});
test('SELF and ordinary APP reads consume committed proof without waiting for a retired intermediate phase',async t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.job,'status.json'));
  const read=await update.read(f),reconciled=await update.reconcile(f),waited=await update.waitHandoff(f);
  assert.equal(read.kind,'terminal');assert.equal(reconciled.kind,'terminal');assert.equal(waited.status,'committed');
  const observed=await update.observeApp(f);assert.equal(observed.effectState,'changed');assert.equal(observed.reason,'committed');
  assert.equal(observed.appSegmentSettled,undefined);f.assertPreserved();
});
test('SELF plan ownership can be inspected without ACK; only an authenticated operation may write the ACK',t=>{
  const f=fixture(t,{phase:'awaiting-system'}),ready=path.join(f.job,'ready.json'),before=fs.readFileSync(path.join(f.job,'plan.json'));
  const plan=update.resume(f.job,{home:f.home,executable:f.executable,version:'1.1.0'});
  assert.equal(plan.operationId,f.operation.operationId);assert.equal(fs.existsSync(ready),false);
  assert.deepEqual(fs.readFileSync(path.join(f.job,'plan.json')),before);
  assert.throws(()=>update.resume(f.job,{home:f.home,executable:f.executable,version:'1.1.0',operation:{...f.operation,operationId:crypto.randomUUID()}}),{code:'OPERATION_CAPABILITY_REQUIRED'});
  update.resume(f.job,{home:f.home,executable:f.executable,version:'1.1.0',operation:f.operation});
  assert.deepEqual(JSON.parse(fs.readFileSync(ready)),{schema:'nora-launcher-handoff/1',token:plan.token,version:'1.1.0',
    operationId:f.operation.operationId,planDigest:f.operation.planDigest});f.assertPreserved();
});
test('ordinary reopen only resumes an offline APP handoff with an existing matching acknowledgement',async t=>{
  const f=fixture(t,{phase:'awaiting-system'}),ready=path.join(f.job,'ready.json');
  const options={...f,version:'1.1.0',planDigest:f.operation.planDigest,ordinaryReopen:true};
  assert.equal(await update.verifyHandoff(options),false);
  assert.equal(fs.existsSync(ready),false);
  update.resume(f.job,{...options,operation:f.operation});
  const acknowledged=fs.readFileSync(ready);
  assert.equal(await update.verifyHandoff(options),true);
  assert.deepEqual(fs.readFileSync(ready),acknowledged);
  assert.equal(await update.verifyHandoff({...options,version:'1.0.0'}),false);
  const recoveryFile=path.join(f.job,'recovery.json'),snapshot=mutableRecovery(fs.readFileSync(recoveryFile));
  snapshot.recoveryParent={pid:123,creationTime:1};
  fs.writeFileSync(recoveryFile,JSON.stringify(snapshot));
  assert.equal(await update.verifyHandoff(options),false,'An already requested rollback must retain priority');
  assert.throws(()=>execFileSync(python,['-B',f.helper,'--finalize',f.job,'--target','v2.6.0','--version','1.1.0','--verified'],
    {encoding:'utf8',stdio:['ignore','pipe','pipe']}),error=>error.status===1&&/已准备恢复/.test(error.stderr));
  f.assertPreserved();
});
for(const phase of ['restored','cancelled'])test(`APP module projects ${phase} without core acceptance`,async t=>{
  const f=fixture(t,{phase});const result=await update.reconcileAppHandoff(f);
  assert.equal(result.status,phase);assert.equal(result.value[phase==='restored'?'recoveryVerification':'notAppliedVerification'],'confirmed');
  assert.equal(result.value.launcherVersion,'1.0.0');
  assert.equal(result.value.systemReady,undefined);f.assertPreserved();
});
for(const phase of ['restored','cancelled'])test(`APP ${phase} survives a lost status cache write`,async t=>{
  const releasePlan=await releases.selectAppPlan(publication(t));
  const f=fixture(t,{phase,releasePlan});
  fs.unlinkSync(path.join(f.job,'status.json'));
  const result=await update.reconcileAppHandoff(f);
  assert.equal(result.status,phase);
  assert.equal(result.value[phase==='restored'?'recoveryVerification':'notAppliedVerification'],'confirmed');
  f.assertPreserved();
});
for(const [winerror,schema] of [[33,'nora-app-sharing-failure/1'],[5,'nora-app-move-denied/1']])
test(`APP move proof checks the original sealed manifest bytes before permitting retry (${winerror})`,async t=>{
  const platform='win32',arch='x64',releasePlan=await releases.selectAppPlan(publication(t,{platform,arch}));
  const f=fixture(t,{phase:'cancelled',releasePlan,platform,arch}),file=path.join(f.job,'recovery.json');
  const sharing={schema,phase:'moving-old',winerror};
  const snapshot=mutableRecovery(fs.readFileSync(file));
  if(winerror===5){
    fs.writeFileSync(file,JSON.stringify({...snapshot,failurePhase:'moving-old',sharingFailure:{...sharing,schema:'nora-app-sharing-failure/1'}}));
    assert.equal((await update.observeApp(f)).effectState,'unknown','access denial is not a proven sharing violation');
  }
  fs.writeFileSync(file,JSON.stringify({...snapshot,failurePhase:'moving-old',sharingFailure:sharing}));
  const before=await update.observeApp(f);
  assert.deepEqual(before.sharingFailure,sharing);assert.equal(before.workerOffline,true);
  if(winerror===5){
    const {presentError}=require('../installer/desktop/error-presentation');
    const result=await update.reconcileAppHandoff(f);
    assert.equal(result.failure.userCode,'APP_MOVE_BLOCKED');
    assert.match(presentError(result.failure,{action:'update'}).next,/占用.*重试.*权限/);
  }
  const manifest=path.join(f.operationDirectory,f.operation.target.releasePlan.manifestRef.file);
  const bytes=fs.readFileSync(manifest);bytes[bytes.indexOf('a'.repeat(40))]='b'.charCodeAt(0);fs.writeFileSync(manifest,bytes);
  const after=await update.observeApp(f);
  assert.equal(after.effectState,'unknown');assert.equal(after.sharingFailure,undefined);
  f.assertPreserved();
});
test('APP facts never settle a whole legacy combined operation',async t=>{
  const f=fixture(t,{launcherOnly:false});assert.equal((await update.read(f)).kind,'terminal');
  const observed=await update.observeApp(f);
  assert.equal(observed.appSegmentSettled,true);assert.equal(observed.effectState,'changed');assert.equal(observed.canResume,false);
  assert.equal(await update.reconcileAppHandoff(f),null);
  for(const operation of [{...f.operation,planDigest:'0'.repeat(64)},
    {...f.operation,target:{...f.operation.target,request:{action:'update',port:8799}}}]){
    const wrong=await update.observeApp({...f,operation});
    assert.equal(wrong.appSegmentSettled,undefined);assert.equal(wrong.effectState,'unknown');
  }
  f.assertPreserved();
});
test('wrong operation binding, changed program and a live worker do not grant APP completion',async t=>{
  const f=fixture(t),file=path.join(f.job,'recovery.json'),before=fs.readFileSync(file);
  assert.equal(await update.reconcileAppHandoff({...f,operation:{...f.operation,planDigest:'0'.repeat(64)}}),null);
  const identity=JSON.parse(execFileSync(python,['-B',f.helper,'--process-identity',String(process.pid)],{encoding:'utf8'}));
  const value=mutableRecovery(before);value.workerPid=identity.pid;value.workerCreationTime=identity.creationTime;fs.writeFileSync(file,JSON.stringify(value));
  assert.equal((await update.read(f)).kind,'pending');assert.equal(await update.reconcileAppHandoff(f),null);
  fs.writeFileSync(file,before);fs.writeFileSync(f.executable,'unknown APP content');
  assert.equal((await update.observeApp(f)).effectState,'unknown');
  await assert.rejects(update.reconcileAppHandoff(f));f.assertPreserved();
});
test('public APP start seals and accepts an unchanged APP without loading core state or an interpreter',async t=>{
  const source=publication(t),f=fixture(t);delete f.operation.target.releasePlan;delete f.operation.handoffRef;
  const context=contextFor(f.operation),result=await update.start({...f,...source,context,launcherVersion:'1.1.0'});
  assert.equal(result.verification,'confirmed');assert.equal(result.value.unchanged,true);assert.equal(result.value.appUpdateComplete,true);
  assert.equal(result.value.coreUpdateComplete,false);assert.equal(context.target.releasePlan.client,'app');
  assert.equal(context.target.releasePlan.manifestRef.operationId,f.operation.operationId);
  assert.deepEqual(context.stages,['downloading']);assert.deepEqual(context.effects,[]);assert.deepEqual(context.handoffs,[]);
  assert.equal(fs.existsSync(path.join(f.home,'hermes/hermes-agent/venv')),false);f.assertPreserved();
});
test('public APP start consumes committed program proof in the original verifying task',async t=>{
  const source=publication(t),selected=await releases.selectAppPlan(source),f=fixture(t,{releasePlan:selected});
  fs.unlinkSync(path.join(f.job,'status.json'));const context=contextFor(f.operation);
  const result=await update.start({...f,...source,context,launcherVersion:'1.1.0',fetcher:()=>{throw Error('terminal program evidence must not depend on remote revalidation');}});
  assert.equal(result.verification,'confirmed');assert.equal(result.value.appUpdateComplete,true);assert.equal(result.value.coreUpdateComplete,false);
  assert.deepEqual(context.stages,['verifying']);assert.deepEqual(context.effects,['changed']);assert.deepEqual(context.handoffs,[]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.job,'recovery.json'))).phase,'committed');f.assertPreserved();
});
test('public APP start cannot fall back to core Python when its own runtime is unavailable',async t=>{
  const source=publication(t),f=fixture(t);delete f.operation.target.releasePlan;delete f.operation.handoffRef;
  const context=contextFor(f.operation),jobsBefore=fs.readdirSync(path.dirname(f.job));
  await assert.rejects(update.start({...f,...source,context,isPackaged:true}),{code:'APP_HELPER_RUNTIME_UNAVAILABLE'});
  assert.equal(context.target.releasePlan.client,'app');assert.deepEqual(context.handoffs,[]);
  assert.deepEqual(fs.readdirSync(path.dirname(f.job)),jobsBefore);f.assertPreserved();
});
test('public APP restore rejects a legacy combined task and unverified runtime before any mutation',async t=>{
  const f=fixture(t,{phase:'awaiting-system',launcherOnly:false}),before=fs.readFileSync(path.join(f.job,'recovery.json'));
  await assert.rejects(update.restore({...f,appHelperRuntime:{command:python}}),{code:'OPERATION_CAPABILITY_REQUIRED'});
  assert.deepEqual(fs.readFileSync(path.join(f.job,'recovery.json')),before);f.assertPreserved();
});
test('explicit legacy APP recovery closes only its physically bound segment',async t=>{
  const f=fixture(t,{phase:'prepared',launcherOnly:false}),file=path.join(desktop,'launcher-update.js');
  const operation={...f.operation,schema:'nora-operation/1',state:'awaiting-handoff',snapshotSequence:2};
  const operationFile=path.join(f.operationDirectory,'operation.json');
  const save=record=>fs.writeFileSync(operationFile,JSON.stringify({...record,sequence:record.snapshotSequence}));
  save(operation);
  const stored=fs.readFileSync(operationFile),journal=path.join(f.job,'recovery.json'),before=fs.readFileSync(journal);
  const runtime={command:python,env:process.env},localRequire=createRequire(file),loaded={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:loaded,process,setTimeout,clearTimeout,
    require:name=>name==='./app-helper-runtime'?{isVerified:value=>value===runtime}:localRequire(name)}, {filename:file});
  const context={snapshot:operation,check:()=>{},handoff:()=>{throw Error('original joint record is read-only');}};
  const options={...f,operation,context,appHelperRuntime:runtime,historicalAppSegment:true,
    spawnChild:(command,args,{appHelperRuntime,...opts})=>require('node:child_process').spawn(command,args,opts)};
  await assert.rejects(loaded.exports.restore({...options,context:{...context,snapshot:{...operation,handoffRef:null}}}),
    {code:'OPERATION_CAPABILITY_REQUIRED'});
  save({...operation,snapshotSequence:3});
  await assert.rejects(loaded.exports.restore(options));
  assert.deepEqual(fs.readFileSync(journal),before);
  save(operation);

  const result=await loaded.exports.restore(options);
  assert.equal(result.appSegmentOnly,true);assert.equal(result.untouched,true);assert.equal(result.restarting,false);
  assert.equal(result.coreUpdateComplete,undefined);
  assert.deepEqual(fs.readFileSync(operationFile),stored,'the joint operation itself is not settled or rewritten');
  fs.unlinkSync(path.join(f.job,'status.json'));
  assert.equal((await update.read({...f,operation})).outcome.status,'cancelled');
  assert.equal(await update.reconcileAppHandoff({...f,operation}),null);
  f.assertPreserved();
});

test('historical APP rollback restores old bytes without launching the old joint runner',async t=>{
  const f=fixture(t,{phase:'awaiting-system',launcherOnly:false});
  const operation={...f.operation,schema:'nora-operation/1',state:'awaiting-handoff',sequence:2};
  const operationFile=path.join(f.operationDirectory,'operation.json');
  const installerState=path.join(f.home,'installer/state.json');
  fs.writeFileSync(operationFile,JSON.stringify(operation));
  fs.writeFileSync(installerState,'legacy installer state');
  const original=fs.readFileSync(operationFile);
  const invoke=sequence=>execFileSync(python,['-B',f.helper,'--recover',f.job,'--historical-app-segment-sequence',String(sequence)],
    {encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const journal=path.join(f.job,'recovery.json'),before=fs.readFileSync(journal),status=fs.readFileSync(path.join(f.job,'status.json'));
  assert.throws(()=>invoke(3));
  assert.deepEqual(fs.readFileSync(journal),before);assert.deepEqual(fs.readFileSync(path.join(f.job,'status.json')),status);
  assert.equal(fs.readFileSync(f.executable,'utf8'),'new synthetic APP');
  const result=JSON.parse(invoke(2)),record=JSON.parse(fs.readFileSync(journal));
  assert.deepEqual(result,{restored:true,restarting:false,appSegmentOnly:true});
  assert.equal(record.phase,'restored');assert.notEqual(record.launchAttempted,true);
  fs.unlinkSync(path.join(f.job,'status.json'));
  assert.equal((await update.read({...f,operation})).outcome.status,'restored');
  assert.equal(await update.reconcileAppHandoff({...f,operation}),null);
  assert.equal(fs.readFileSync(f.executable,'utf8'),'old synthetic APP');
  assert.deepEqual(fs.readFileSync(operationFile),original);
  assert.equal(fs.readFileSync(installerState,'utf8'),'legacy installer state');
  f.assertPreserved();
});

test('APP recovery adapter closes the original restored operation using its final handoff revision',async t=>{
  const f=fixture(t,{phase:'restored'});
  const operation={...f.operation,schema:'nora-operation/1',state:'awaiting-handoff',stageId:'recovering',
    sequence:8,snapshotSequence:8,verification:'unconfirmed'};
  const file=path.join(f.operationDirectory,'operation.json');
  fs.writeFileSync(file,JSON.stringify(operation));
  const journal=path.join(f.job,'recovery.json'),snapshot=JSON.parse(fs.readFileSync(journal));
  fs.writeFileSync(journal,JSON.stringify({...snapshot,launchAttempted:true}));
  const result=await update.recover({...f,operation});
  assert.equal(result.restored,true);
  const closed=JSON.parse(fs.readFileSync(file));
  assert.equal(closed.sequence,9);assert.ok(closed.ownerEpoch>operation.ownerEpoch);
  assert.equal(closed.state,'rolled-back');assert.equal(closed.verification,'confirmed');
  assert.equal(closed.result.launcherVersion,'1.0.0');
  assert.equal(closed.currentFailure,null);assert.equal(closed.handoffRef,f.job);
  f.assertPreserved();
});

test('interrupted APP preparation is visible before its job reference is published',async t=>{
  const f=fixture(t,{phase:'prepared'}),operation={...f.operation,handoffRef:null,stageId:'prepared',effectState:'untouched'};
  const options={...f,job:undefined,operation};
  const previous=path.join(path.dirname(f.job),'job-archived');fs.mkdirSync(previous);
  fs.copyFileSync(path.join(f.job,'plan.json'),path.join(previous,'plan.json'));
  operation.journalRefs=[previous];
  const read=await update.read(options);
  assert.equal(read.kind,'pending');assert.equal(read.job,f.job);assert.equal(read.state.status,'prepared');
  const observed=await update.observeApp(options);
  assert.equal(observed.effectState,'untouched');assert.equal(observed.recoveryOutcome,'recovery-required');
  assert.equal(observed.canRecover,true);assert.equal(observed.canResume,false);

  const sameProgramDifferentTask={...operation,operationId:crypto.randomUUID()};
  const noHelper={...options,helper:path.join(f.home,'missing-helper.py')};
  assert.equal((await update.read({...noHelper,operation:sameProgramDifferentTask})).kind,'idle');
  const selecting={...operation,stageId:'selecting',target:{request:operation.target.request}};
  assert.equal((await update.read({...noHelper,operation:selecting})).kind,'idle');
  const sameTaskDifferentPlan={...operation,planDigest:'0'.repeat(64)};
  assert.equal((await update.read({...noHelper,operation:sameTaskDifferentPlan})).kind,'unknown');
  fs.writeFileSync(f.executable,'changed old program at the same inode');
  assert.equal((await update.read(options)).kind,'unknown');
  assert.equal(fs.existsSync(path.join(f.job,'recovery.json')),true);
  f.assertPreserved();
});

test('only the exact unpublished APP preparation with an offline worker and unchanged program can enter cancellation',async t=>{
  const f=fixture(t,{phase:'prepared'});delete f.operation.handoffRef;
  assert.equal(await update.verifyRecovery(f),true);
  for(const operation of [{...f.operation,operationId:crypto.randomUUID()},
    {...f.operation,handoffRef:path.join(path.dirname(f.job),'job-other')},
    {...f.operation,target:{...f.operation.target,request:{action:'update'}}},
    {...f.operation,target:{...f.operation.target,releasePlan:{schema:'nora-release-plan/1',planId:'foreign'}}}])
    assert.equal(await update.verifyRecovery({...f,operation}),false);
  const file=path.join(f.job,'recovery.json'),before=fs.readFileSync(file),value=mutableRecovery(before);
  const identity=JSON.parse(execFileSync(python,['-B',f.helper,'--process-identity',String(process.pid)],{encoding:'utf8'}));
  value.workerPid=identity.pid;value.workerCreationTime=identity.creationTime;fs.writeFileSync(file,JSON.stringify(value));
  assert.equal(await update.verifyRecovery(f),false,'a PID with its exact live birth cannot be adopted');
  fs.writeFileSync(file,before);value.workerPid=2147483647;value.workerCreationTime=1;value.phase='waiting-parent';
  fs.writeFileSync(file,JSON.stringify(value));assert.equal(await update.verifyRecovery(f),false,'only prepared is eligible');
  fs.writeFileSync(file,before);fs.writeFileSync(f.executable,'changed old program at the same inode');
  assert.equal(await update.verifyRecovery(f),false,'a directory identity alone is not proof of unchanged APP bytes');f.assertPreserved();
});
test('APP helper readiness has a bounded unconfirmed result and retains real job evidence until late close',async t=>{
  const f=fixture(t,{phase:'awaiting-system'}),file=path.join(desktop,'launcher-update.js'),localRequire=createRequire(file),loaded={exports:{}};
  const child=new EventEmitter(),signals=[];child.pid=2147483646;child.kill=signal=>{signals.push(signal);return true;};child.unref=()=>{};
  let ticks=0;
  const fixtureRequire=name=>{
    if(name==='node:child_process')return {...localRequire(name),spawn:()=>child};
    if(name==='./managed-python')return {resolveExecution:command=>({command,env:process.env})};
    return localRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:loaded,process,
    setTimeout:callback=>{ticks++;queueMicrotask(callback);},require:fixtureRequire}, {filename:file});
  const before=fs.readFileSync(path.join(f.job,'recovery.json'));
  await assert.rejects(loaded.exports.launchHandoff(f),error=>error.code==='OPERATION_EXECUTOR_UNCONFIRMED'
    &&error.pending===true&&error.executorTerminationConfirmed===false&&error.job===f.job&&error.cause.code==='TIMEOUT');
  assert.deepEqual(signals,[],'an unknown APP transaction must not be force-killed because its UI budget elapsed');
  assert.equal(ticks,1270);assert.equal(fs.existsSync(path.join(f.job,'cancel')),true);
  assert.deepEqual(fs.readFileSync(path.join(f.job,'recovery.json')),before,'a UI timeout must not settle or delete the worker journal');
  assert.equal(child.listenerCount('close'),1);assert.equal(child.listenerCount('error'),1,'retain the actual child until closure');
  child.emit('close',null,'SIGKILL');assert.equal(child.listenerCount('close'),0);assert.equal(child.listenerCount('error'),0);f.assertPreserved();
});
test('public APP fact reads report visible pending before returning unknown closure and retain the still-owned child',async t=>{
  const f=fixture(t),file=path.join(desktop,'launcher-update.js'),localRequire=createRequire(file),loaded={exports:{}};
  const child=new EventEmitter(),signals=[],delays=[];child.pid=2147483646;
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin={end:()=>{}};
  child.kill=signal=>{signals.push(signal);return true;};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:loaded,process,
    setTimeout:(callback,delay)=>{delays.push(delay);queueMicrotask(callback);},clearTimeout:()=>{},require:localRequire},{filename:file});
  const before=fs.readFileSync(path.join(f.job,'recovery.json')),events=[];
  await assert.rejects(loaded.exports.read({...f,spawnChild:()=>child,onEvent:event=>events.push(event)}),error=>error.code==='OPERATION_EXECUTOR_UNCONFIRMED'
    &&error.pending===true&&error.readOnly===true&&error.executorTerminationConfirmed===false&&error.cause.code==='TIMEOUT');
  assert.equal(events.length,1);assert.equal(events[0].event,'executor-pending');assert.equal(events[0].canCancel,false);
  assert.match(events[0].reason,/原任务仍在等待执行者关闭/);
  assert.deepEqual(delays,[10000,2000,1000]);assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  assert.equal(child.listenerCount('close'),1);assert.equal(child.listenerCount('error'),1);
  assert.deepEqual(fs.readFileSync(path.join(f.job,'recovery.json')),before);
  child.emit('close',null,'SIGKILL');assert.equal(child.listenerCount('close'),0);assert.equal(child.listenerCount('error'),0);f.assertPreserved();
});
test('APP commit timeout reports pending without killing or settling its program writer',async t=>{
  const f=fixture(t,{phase:'awaiting-system'}),file=path.join(desktop,'launcher-update.js'),localRequire=createRequire(file),loaded={exports:{}};
  const child=new EventEmitter(),signals=[],delays=[];child.pid=2147483646;
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin={end:()=>{}};child.kill=signal=>{signals.push(signal);};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:loaded,process,
    setTimeout:(callback,delay)=>{delays.push(delay);queueMicrotask(callback);},clearTimeout:()=>{},require:localRequire},{filename:file});
  const before=fs.readFileSync(path.join(f.job,'recovery.json'));
  const events=[],eventError=new Error('controlled progress delivery failed');
  await assert.rejects(loaded.exports.finalize({...f,systemReady:true,updateVerified:true,target:'v2.6.0',version:'1.1.0',spawnChild:()=>child,
    onEvent:event=>{events.push(event);throw eventError;}}),
    error=>error.code==='OPERATION_EXECUTOR_UNCONFIRMED'&&error.pending===true&&error.readOnly===false
      &&error.executorTerminationConfirmed===false&&error.cause.code==='TIMEOUT'
      &&error.secondaryErrors?.some(item=>item.operation==='report_executor_pending'&&item.error===eventError));
  assert.equal(events.length,1);assert.equal(events[0].event,'executor-pending');assert.equal(events[0].canCancel,false);
  assert.deepEqual(delays,[120000,3000]);assert.deepEqual(signals,[]);
  assert.equal(child.listenerCount('close'),1);assert.deepEqual(fs.readFileSync(path.join(f.job,'recovery.json')),before);
  child.emit('close',0);assert.equal(child.listenerCount('error'),0);f.assertPreserved();
});
test('handoff wait accounts for elapsed helper time within its wall-clock budget',async t=>{
  const f=fixture(t,{phase:'awaiting-system'}),file=path.join(desktop,'launcher-update.js'),localRequire=createRequire(file),loaded={exports:{}};
  let now=0,calls=0;const budgets=[];
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:loaded,process,Date:{now:()=>now},
    setTimeout:(callback,delay)=>{if(delay===100){now+=100;queueMicrotask(callback);}else budgets.push(delay);return {unref:()=>{}};},
    clearTimeout:()=>{},require:localRequire},{filename:file});
  const spawnChild=()=>{
    calls++;const child=new EventEmitter();child.pid=2147483646;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin={end:()=>{}};
    queueMicrotask(()=>{now+=Math.min(9000,budgets.at(-1));child.stdout.emit('data',JSON.stringify({kind:'pending',job:f.job,
      state:{status:'awaiting-launcher',effectState:'changed',busy:true,workerOffline:false}}));child.emit('close',0);});return child;
  };
  await assert.rejects(loaded.exports.waitHandoff({...f,spawnChild}),{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
  assert.equal(calls,2);assert.deepEqual(budgets,[10000,7900]);assert.equal(now,17100);assert.equal(now<=20000,true);f.assertPreserved();
});
