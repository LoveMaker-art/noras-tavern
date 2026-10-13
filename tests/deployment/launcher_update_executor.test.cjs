const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {create}=require('../installer/desktop/system-update-executor');
const operationId='df489037-5361-4b6a-b02a-8c6cf6cb256e';
const fixture=()=>({operationId,target:{releasePlan:{releaseManifest:{versions:{tavern:'2.4.0'}}}},
  snapshot:{handoffRef:'/owned/job'},stage:async()=>{},effectStates:[],effect:async function(state){this.effectStates.push(state);}});

async function sealedFixture(t){
  const releases=require('../installer/desktop/releases'),{createLocalRelease}=require('../installer/desktop/local-release');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-update-acceptance-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const local=path.join(root,'release'),operationDirectory=path.join(root,'installer/operations',operationId);
  fs.mkdirSync(local);fs.mkdirSync(operationDirectory,{recursive:true});
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const manifest={schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.4.0'},launcherVersion:'2.1.2',
    launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.1.2',sha256:sha('bootstrap')}};
  const bytes={'release-manifest.json':JSON.stringify(manifest),'tavern-updater-bootstrap.py':'bootstrap'};
  bytes.SHA256SUMS=Object.entries(bytes).map(([name,value])=>`${sha(value)}  ${name}`).join('\n');
  for(const [name,value] of Object.entries(bytes))fs.writeFileSync(path.join(local,name),value);
  const options={fetcher:createLocalRelease(local),mode:'update',launcherVersion:'2.1.2',platform:process.platform,
    arch:process.arch,channel:'stable',operationDirectory};
  const selected=await releases.selectPlan(options),plan=releases.sealPlan(selected,{...options,
    assertOwner:()=>assert.equal(path.basename(operationDirectory),operationId)});
  assert.equal(releases.validatePlan(plan,options).commit,manifest.commit);
  assert.equal(plan.manifestRef.schema,'nora-operation-manifest/1');
  assert.equal(fs.readFileSync(path.join(operationDirectory,plan.manifestRef.file),'utf8'),bytes['release-manifest.json']);
  return {...fixture(),target:{releasePlan:plan}};
}

for(const route of ['apply','resumeCommitted'])test(`shared ${route} rejects a different commit under a real sealed plan before retiring the APP backup`,async t=>{
  const context=await sealedFixture(t),calls=[];
  // The release selection and manifest seal are real. This callable boundary
  // deliberately injects a backend result; it is not native transaction proof.
  const result={operationVerified:true,updateVerified:true,systemReady:true,version:context.target.releasePlan.version,commit:'b'.repeat(40)};
  const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async command=>{
    calls.push(command);return command==='operation-effects'?{effects:{operationId,status:'committed',canResume:true}}:result;
  },finalizeLauncher:async()=>calls.push('finalize')});
  await assert.rejects(route==='apply'?executor.apply(context,{releaseDir:'/owned/release',target:result.version})
    :executor.resumeCommitted(context,{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
  assert.deepEqual(calls,route==='apply'?['update']:['operation-effects','resume-committed-update']);
});

for(const route of ['apply','resumeCommitted'])test(`shared ${route} preserves the actual matching fixed-commit result and finalizes once`,async t=>{
  const context=await sealedFixture(t),calls=[],plan=context.target.releasePlan;
  context.stage=async stage=>calls.push(stage);
  const result={operationVerified:true,updateVerified:true,systemReady:true,version:plan.version,commit:plan.commit};
  const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async command=>{
    calls.push(command);return command==='operation-effects'?{effects:{operationId,status:'committed',canResume:true}}:result;
  },finalizeLauncher:async(job,actual,owned)=>{
    assert.equal(job,context.snapshot.handoffRef);assert.equal(actual,result);assert.equal(owned,context);calls.push('finalize');
  }});
  assert.equal(await (route==='apply'?executor.apply(context,{releaseDir:'/owned/release',target:plan.version})
    :executor.resumeCommitted(context,{hasTransaction:true})),result);
  assert.deepEqual(calls,route==='apply'?['update','finalize']:['operation-effects','verifying','resume-committed-update','finalize']);
});

for(const route of ['apply','resumeCommitted'])test(`shared ${route} requires an exact returned commit when the sealed plan has one`,async t=>{
  const context=await sealedFixture(t),plan=context.target.releasePlan;
  for(const commit of [undefined,null,123,'a'.repeat(39),'A'.repeat(40)]){
    const calls=[],result={operationVerified:true,updateVerified:true,systemReady:true,version:plan.version,commit};
    const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async command=>{
      calls.push(command);return command==='operation-effects'?{effects:{operationId,status:'committed',canResume:true}}:result;
    },finalizeLauncher:async()=>calls.push('finalize')});
    await assert.rejects(route==='apply'?executor.apply(context,{releaseDir:'/owned/release',target:plan.version})
      :executor.resumeCommitted(context,{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
    assert.deepEqual(calls,route==='apply'?['update']:['operation-effects','resume-committed-update']);
  }
});

test('shared completion refuses malformed or conflicting claimed fixed commits',async t=>{
  const original=await sealedFixture(t),sealed=original.target.releasePlan;
  for(const changes of [{commit:null},{commit:''},{commit:'a'.repeat(39)},
    {releaseManifest:{commit:'b'.repeat(40),versions:{tavern:sealed.version}}}]){
    const context={...original,target:{releasePlan:{...sealed,...changes}}};let finalized=false;
    const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async()=>({updateVerified:true,systemReady:true,version:sealed.version,commit:sealed.commit}),
      finalizeLauncher:async()=>{finalized=true;}});
    await assert.rejects(executor.apply(context,{releaseDir:'/owned/release',target:sealed.version}),{code:'VERIFICATION_FAILED'});
    assert.equal(finalized,false);
  }
});

test('an older inline fixed commit remains binding while a legacy plan without one can continue',async()=>{
  for(const plan of [{schema:'nora-release-plan/1',releaseManifest:{versions:{tavern:'2.4.0'}}},
    {releaseManifest:{versions:{tavern:'2.4.0'},commit:'a'.repeat(40)}}]){
    for(const different of [false,true]){
      const context={...fixture(),target:{releasePlan:plan}},calls=[],result={operationVerified:true,updateVerified:true,
        systemReady:true,version:'2.4.0',...(plan.releaseManifest.commit?{commit:(different?'b':'a').repeat(40)}:{})};
      const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async command=>{
        calls.push(command);return command==='operation-effects'?{effects:{operationId,status:'committed',canResume:true}}:result;
      },finalizeLauncher:async()=>calls.push('finalize')});
      if(plan.releaseManifest.commit&&different)await assert.rejects(executor.resumeCommitted(context,{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
      else assert.equal(await executor.resumeCommitted(context,{hasTransaction:true}),result);
      assert.deepEqual(calls,['operation-effects','resume-committed-update',...(plan.releaseManifest.commit&&different?[]:['finalize'])]);
    }
  }
});
test('committed continuation verifies the original operation and finalizes its retained APP backup',async()=>{
  const calls=[];const context=fixture();
  const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async(command,options)=>{
    calls.push([command,options.operationId]);
    return command==='operation-effects'?{effects:{operationId,status:'committed',canResume:true}}:
      {operationVerified:true,updateVerified:true,systemReady:true,version:'2.4.0'};
  },finalizeLauncher:async job=>{calls.push(['finalize',job]);}});
  assert.equal((await executor.resumeCommitted(context,{hasTransaction:true})).version,'2.4.0');
  assert.deepEqual(calls,[['operation-effects',operationId],['resume-committed-update',operationId],['finalize','/owned/job']]);
});
test('a foreign completed transaction is never resumed or finalized',async()=>{
  let finalized=false;
  const executor=create({compare:()=>0,bridge:async()=>({effects:{operationId:'foreign',status:'committed',canResume:true}}),
    finalizeLauncher:async()=>{finalized=true;}});
  assert.equal(await executor.resumeCommitted(fixture(),{hasTransaction:true}),null);assert.equal(finalized,false);
});
test('an unverified continuation keeps the APP backup and never applies files again',async()=>{
  const calls=[];
  const executor=create({compare:()=>0,bridge:async command=>{
    calls.push(command);return command==='operation-effects'?{effects:{operationId,status:'committed',canResume:true}}:
      {operationVerified:true,updateVerified:true,systemReady:false,version:'2.4.0'};
  },finalizeLauncher:async()=>{calls.push('finalize');}});
  await assert.rejects(executor.resumeCommitted(fixture(),{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
  assert.deepEqual(calls,['operation-effects','resume-committed-update']);
});
test('matching version without the operation verification flag cannot retire the backup',async()=>{
  const executor=create({compare:()=>0,bridge:async command=>command==='operation-effects'?
    {effects:{operationId,status:'committed',canResume:true}}:{updateVerified:true,systemReady:true,version:'2.4.0'}});
  await assert.rejects(executor.resumeCommitted(fixture(),{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
});

test('committed first installation verifies the original fixed target without installing or finalizing an APP job',async()=>{
  const calls=[];
  const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async(command,options)=>{
    calls.push([command,options.operationId]);return command==='operation-effects'?
      {effects:{operationId,status:'committed',canResume:true,version:'2.4.0'}}:
      {operationVerified:true,firstInstallVerified:true,systemReady:true,version:'2.4.0'};
  },finalizeLauncher:async()=>{throw new Error('first installation must not retire APP backups');}});
  const context=fixture();context.effect=async state=>{assert.equal(calls.length,2,'effects must remain unknown until current acceptance succeeds');context.effectStates.push(state);};
  assert.equal((await executor.resumeInstallation(context,{hasTransaction:true})).version,'2.4.0');
  assert.deepEqual(calls,[['operation-effects',operationId],['resume-committed-install',operationId]]);
  assert.deepEqual(context.effectStates,['changed']);
});

test('a foreign or mismatched first-install commit never runs acceptance against a different target',async()=>{
  for(const facts of [{operationId:'foreign',status:'committed',canResume:true,version:'2.4.0'},
    {operationId,status:'committed',canResume:true,version:'2.3.0'}]){
    const calls=[];const executor=create({compare:(a,b)=>a===b?0:-1,bridge:async command=>{calls.push(command);return {effects:facts};}});
    const context=fixture();
    if(facts.operationId==='foreign')assert.equal(await executor.resumeInstallation(context,{hasTransaction:true}),null);
    else await assert.rejects(executor.resumeInstallation(context,{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
    assert.deepEqual(calls,['operation-effects']);
    assert.deepEqual(context.effectStates,[]);
  }
});

test('a first-install process success without runtime proof cannot complete the original operation',async()=>{
  const calls=[];
  const executor=create({compare:()=>0,bridge:async command=>{calls.push(command);return command==='operation-effects'?
    {effects:{operationId,status:'committed',canResume:true,version:'2.4.0'}}:
    {operationVerified:true,firstInstallVerified:true,systemReady:false,version:'2.4.0'};}});
  const context=fixture();await assert.rejects(executor.resumeInstallation(context,{hasTransaction:true}),{code:'VERIFICATION_FAILED'});
  assert.deepEqual(calls,['operation-effects','resume-committed-install']);
  assert.deepEqual(context.effectStates,[]);
});
