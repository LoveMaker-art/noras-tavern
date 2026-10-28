const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {create}=require('../installer/desktop/operation-policy');
const {createOperationController}=require('../installer/desktop/operation-state');
const lock=require('../installer/desktop/operation-lock');
const {downloadAsset,metadataJson}=require('../installer/desktop/release-network');
const {sourceCandidates}=require('../installer/desktop/release-sources');
const releases=require('../installer/desktop/releases');
const githubOnly={schema:1,primary:'github',mirrors:[]};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// These original-resource regressions describe a build whose configured source
// is GitHub. Load the same shipped policy with that explicit build-owned JSON;
// current domestic-source cases below use the production modules unchanged.
const desktop=path.resolve(__dirname,'../installer/desktop');
const legacyDesktop=fs.mkdtempSync(path.join(os.tmpdir(),'nora-retry-github-build-'));
for(const name of JSON.parse(fs.readFileSync(path.join(desktop,'package.json'))).build.files)
  fs.copyFileSync(path.join(desktop,name),path.join(legacyDesktop,name));
fs.writeFileSync(path.join(legacyDesktop,'release-sources.json'),JSON.stringify(githubOnly));
fs.symlinkSync(fs.realpathSync(process.env.NORA_TEST_DESKTOP_NODE_MODULES||path.join(desktop,'node_modules')),
  path.join(legacyDesktop,'node_modules'),process.platform==='win32'?'junction':'dir');
const legacyCreate=require(path.join(legacyDesktop,'operation-policy')).create;
test.after(()=>fs.rmSync(legacyDesktop,{recursive:true,force:true}));

async function fixture(t,{execute,capture=true,selectBeforeExecute=true,executionStage='applying',policyOptions={},policyFactory=create}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-retry-conditions-'));
  const hermesHome=path.join(home,'hermes'),installRoot=path.join(home,'tavern');
  fs.mkdirSync(hermesHome);fs.mkdirSync(installRoot);
  t.after(()=>{fs.chmodSync(hermesHome,0o700);fs.rmSync(home,{recursive:true,force:true});});
  let unexpectedReads=0;
  const networkFetch=policyOptions.networkFetch||(async()=>{unexpectedReads++;throw new Error('Unexpected network read in a post-selection fixture');});
  t.after(()=>assert.equal(unexpectedReads,0,'Post-selection failures must not query a new release'));
  const policy=policyFactory({home,hermesHome,installRoot,bridge:async()=>({}),runRuntime:async()=>{},networkFetch,
    inspectRuntime:()=>({effectState:'untouched',recoveryOutcome:'not-required'}),inspectLegacy:()=>null,...policyOptions});
  let runs=0;
  const options={directory:path.join(home,'installer'),lock,observeEffects:policy.observe,recheckers:{install:policy.recheck},
    recoverers:{install:policy.recover},
    identifyFailureCondition:policy.identifyFailureCondition,
    ...(capture?{captureConditions:policy.initialConditions}:{}),executors:{install:async context=>{
      // The real APP seals its selected target before runtime writes or downloads.
      // Metadata-selection fixtures explicitly opt out because they fail earlier.
      if(selectBeforeExecute){
        await context.plan(context.target);
        if(executionStage==='applying'){await context.stage('prepared');await context.effect('changed');}
        await context.stage(executionStage);
      }
      runs++;if(execute)return execute(context,{home,hermesHome,installRoot});
      fs.writeFileSync(path.join(hermesHome,'managed-file'),'owned');return {verification:'confirmed'};
    }}};
  const controller=()=>createOperationController(options);
  let target={request:{action:'install'},planId:'same-target'};
  if(selectBeforeExecute){
    const published=completeReleaseFixture();
    const plan=await releases.selectPlan({mode:'install',launcherVersion:'2.0.2',selectedRelease:published.release,
      fetcher:async url=>new Response(published.bytes[String(url).split('/').at(-1)]),
      networkPolicy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});
    target={request:{action:'install'},releasePlan:plan};
  }
  return {home,hermesHome,installRoot,policy,controller,options,networkFetch,get runs(){return runs;},target};
}

test('native service retries close real children, release the writer and preserve user files',async t=>{
  const f=await fixture(t);let clock=Date.parse('2026-10-27T00:00:00Z'),healthy=false,runs=0;
  const saved=path.join(f.home,'retained-user.json');fs.writeFileSync(saved,'fixture protected user file');
  const initial=fs.readFileSync(saved),{spawnSync}=require('node:child_process');
  const node=process.execPath;
  const entry=path.join(f.home,'service-child.cjs');
  fs.writeFileSync(entry,"process.exit(process.argv[2]==='healthy'?0:7);");
  const execute=async context=>{
    context.check();runs++;
    const child=spawnSync(node,[entry,healthy?'healthy':'failed'],{cwd:f.home,encoding:'utf8',timeout:5000});
    context.check();assert.equal(child.signal,null);
    if(child.status!==0)throw Object.assign(new Error('fixture ClawChat connection timeout'),{userCode:'CLAWCHAT_CONNECT_TIMEOUT',exitCode:child.status});
    return {verification:'confirmed'};
  };
  const options={...f.options,now:()=>new Date(clock).toISOString(),executors:{start:execute},recheckers:{start:f.policy.recheck}};
  const controller=()=>createOperationController(options),request={target:{request:{action:'start',service:'nora'}}};
  await controller().start('start',request,'first');await controller().start('start',request,'second');
  const blocked=await controller().start('start',request,'blocked');assert.equal(runs,2);
  clock+=31000;healthy=true;
  assert.equal((await controller().resume(blocked.operationId)).state,'succeeded');assert.equal(runs,3);
  assert.equal((await lock.probe({directory:options.directory})).busy,false);
  assert.equal((await controller().start('start',request,'next')).state,'succeeded');assert.equal(runs,4);
  assert.deepEqual(fs.readFileSync(saved),initial);
});

test('native writer records the baseline before two real permission failures; recheck, reopen and new requests cannot add execution',{skip:process.platform==='win32'?'POSIX chmod does not prove Windows ACL behavior':false},async t=>{
  const f=await fixture(t);fs.chmodSync(f.hermesHome,0o500);
  const first=await f.controller().start('install',{target:f.target},'first');
  const record=JSON.parse(fs.readFileSync(path.join(f.home,'installer/operations',first.operationId,'operation.json'),'utf8'));
  assert.equal(record.conditionBaseline.schema,'nora-operation-conditions/1');
  assert.equal(record.conditionBaseline.facts.directories.find(item=>item.name==='hermesHome').writable,false);
  assert.deepEqual(record.currentFailure.conditionTarget,{kind:'directory-write',directory:'hermesHome'});
  const second=await f.controller().start('install',{target:f.target},'second');
  assert.equal(f.runs,2);assert.equal(second.attempt,2);
  for(let index=0;index<3;index++){
    const checked=await f.controller().recheck(second.operationId,{snapshotSequence:second.snapshotSequence});
    assert.equal(checked.attempt,2);assert.deepEqual(checked.allowedActions,['recheck','logs']);
    await assert.rejects(f.controller().resume(second.operationId,{snapshotSequence:checked.snapshotSequence}),{code:'OPERATION_ACTION_UNAVAILABLE'});
    const fresh=await f.controller().start('install',{target:f.target},`fresh-${index}`);
    assert.equal(fresh.state,'blocked');
    const freshChecked=await f.controller().recheck(fresh.operationId,{snapshotSequence:fresh.snapshotSequence});
    assert.equal(freshChecked.allowedActions.includes('retry'),false);
  }
  assert.equal(f.runs,2);
});

test('an actual improvement in the failing owned directory grants one fresh attempt against the fixed target',{skip:process.platform==='win32'?'POSIX chmod does not prove Windows ACL behavior':false},async t=>{
  const f=await fixture(t);fs.chmodSync(f.hermesHome,0o500);
  await f.controller().start('install',{target:f.target},'first');
  const failed=await f.controller().start('install',{target:f.target},'second');
  assert.equal(f.runs,2);
  fs.chmodSync(f.hermesHome,0o700);
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(checked.attempt,0);assert.equal(checked.allowedActions.includes('retry'),true);
  assert.deepEqual(checked.target,f.target);
  const result=await f.controller().resume(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(result.state,'succeeded');assert.equal(f.runs,3);
  assert.equal(fs.readFileSync(path.join(f.hermesHome,'managed-file'),'utf8'),'owned');
});

test('legacy empty baselines cannot gain attempts when conditions are first measured',{skip:process.platform==='win32'?'POSIX chmod does not prove Windows ACL behavior':false},async t=>{
  const f=await fixture(t,{capture:false});fs.chmodSync(f.hermesHome,0o500);
  await f.controller().start('install',{target:f.target},'legacy-first');
  const failed=await f.controller().start('install',{target:f.target},'legacy-second');
  fs.chmodSync(f.hermesHome,0o700);
  f.options.captureConditions=f.policy.initialConditions;
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(checked.attempt,2);assert.equal(checked.allowedActions.includes('retry'),false);
  const fresh=await f.controller().start('install',{target:f.target},'new-request');
  assert.equal(fresh.state,'blocked');assert.equal(f.runs,2);
});

async function releaseFixture(t){
  const bytes=Buffer.alloc(2048,'a'),asset='tavern-updater-bootstrap.py';
  const manifest={schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.4.2'},launcherVersion:'2.0.2',
    launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.0.0',sha256:hash(bytes)}};
  const release={tag_name:'v2.4.2',assets:[['release-manifest.json',JSON.stringify(manifest)],[asset,bytes]].map(([name,body])=>({name,
    browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/${name}`,size:Buffer.byteLength(body)}))};
  const plan=await releases.selectPlan({selectedRelease:release,launcherVersion:'2.0.2',fetcher:async()=>Response.json(manifest)});
  let mode='failed',route='DIRECT',requests=0;
  const server=http.createServer((request,response)=>{
    requests++;
    if(mode==='range-only'&&request.headers.range==='bytes=0-1023'){
      response.writeHead(206,{'content-range':'bytes 0-1023/2048','content-length':'1024'});response.end(bytes.subarray(0,1024));
    }else if(mode==='success'){
      response.writeHead(200,{'content-length':String(bytes.length)});response.end(bytes);
    }else if(mode==='bad-range'){
      response.writeHead(206,{'content-range':'bytes 1-1024/2048','content-length':'1024'});response.end(bytes.subarray(0,1024));
    }else if(mode==='throttled'){
      response.writeHead(429,{'retry-after':'60'});response.end('limited');
    }else {response.writeHead(503);response.end('unavailable');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const fetcher=async(url,options)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/asset`,options);
    // The isolated transport maps the trusted production identity to the local
    // HTTP fixture; production URL/TLS validation is unchanged.
    Object.defineProperty(response,'url',{value:String(url),configurable:true});return response;
  };
  fetcher.conditionRoute=async()=>route;
  return {plan,fetcher,bytes,identity:{tag:plan.tag,asset,size:bytes.length,sha256:hash(bytes)},url:releases.assetUrl(release,asset),
    setMode:value=>{mode=value;},setRoute:value=>{route=value;},get requests(){return requests;}};
}

test('native retry remains bounded across real failed asset HTTP reads; original-resource proof is consumed once and a changed route needs another read',async t=>{
  const release=await releaseFixture(t);
  const f=await fixture(t,{executionStage:'downloading',policyOptions:{networkFetch:release.fetcher},execute:async(_context,{home})=>{
    await downloadAsset({url:release.url,target:path.join(home,'download'),identity:release.identity,fetcher:release.fetcher,
      policy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});return {verification:'confirmed'};
  }});
  const target={request:{action:'install'},releasePlan:release.plan};
  await f.controller().start('install',{target},'network-one');
  const failed=await f.controller().start('install',{target},'network-two');
  assert.equal(f.runs,2);assert.equal(failed.attempt,2);
  assert.equal(failed.currentFailure.conditionTarget.kind,'release-read');
  const unchanged=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(unchanged.attempt,2);assert.equal(unchanged.allowedActions.includes('retry'),false);
  await assert.rejects(f.controller().resume(failed.operationId,{snapshotSequence:unchanged.snapshotSequence}),{code:'OPERATION_ACTION_UNAVAILABLE'});
  const blocked=await f.controller().start('install',{target},'network-fresh');assert.equal(blocked.state,'blocked');assert.equal(f.runs,2);
  release.setMode('range-only');
  const checked=await f.controller().recheck(blocked.operationId,{snapshotSequence:blocked.snapshotSequence});
  assert.equal(checked.attempt,0);assert.equal(checked.allowedActions.includes('retry'),true);assert.deepEqual(checked.target,target);
  const third=await f.controller().resume(blocked.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(third.state,'failed');assert.equal(third.attempt,1);assert.equal(f.runs,3,'Replanning must preserve the verified proof and actually execute');
  const fourth=await f.controller().resume(blocked.operationId,{snapshotSequence:third.snapshotSequence});
  assert.equal(fourth.state,'failed');assert.equal(fourth.attempt,2);assert.equal(f.runs,4);
  const operationFile=path.join(f.home,'installer/operations',fourth.operationId,'operation.json');
  const baseline=JSON.parse(fs.readFileSync(operationFile)).conditionBaseline;
  assert.equal(baseline.facts.networkReads.length,1);
  const reads=release.requests;
  const consumed=await f.controller().recheck(fourth.operationId,{snapshotSequence:fourth.snapshotSequence});
  assert.equal(consumed.attempt,2);assert.equal(release.requests,reads,'a consumed proof does not re-read and re-authorize');
  assert.deepEqual(JSON.parse(fs.readFileSync(operationFile)).conditionBaseline.facts.networkReads,baseline.facts.networkReads);
  const fresh=await f.controller().start('install',{target},'network-fresh-after-proof');assert.equal(fresh.state,'blocked');assert.equal(f.runs,4);
  const freshCheck=await f.controller().recheck(fresh.operationId,{snapshotSequence:fresh.snapshotSequence});assert.equal(freshCheck.allowedActions.includes('retry'),false);
  assert.equal(release.requests,reads,'A recreated controller and fresh request cannot reuse the consumed proof');
  release.setRoute('PROXY fixture-changed');
  const changed=await f.controller().recheck(fresh.operationId,{snapshotSequence:freshCheck.snapshotSequence});
  assert.equal(changed.attempt,0);assert.equal(release.requests,reads+1);assert.equal(changed.allowedActions.includes('retry'),true);
});

test('a malformed original-resource range cannot authorize another attempt',async t=>{
  const release=await releaseFixture(t);
  const f=await fixture(t,{executionStage:'downloading',policyOptions:{networkFetch:release.fetcher},execute:async(_context,{home})=>{
    await downloadAsset({url:release.url,target:path.join(home,'download'),identity:release.identity,fetcher:release.fetcher,policy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});
  }});
  const target={request:{action:'install'},releasePlan:release.plan};
  await f.controller().start('install',{target},'range-one');const failed=await f.controller().start('install',{target},'range-two');
  release.setMode('bad-range');
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(checked.attempt,2);assert.equal(checked.allowedActions.includes('retry'),false);assert.equal(f.runs,2);
});

test('an original-resource recheck respects Retry-After before probing, then requires actual bytes',async t=>{
  const release=await releaseFixture(t);release.setMode('throttled');let clock=Date.now();
  const f=await fixture(t,{executionStage:'downloading',policyOptions:{networkFetch:release.fetcher,now:()=>clock},execute:async(_context,{home})=>{
    await downloadAsset({url:release.url,target:path.join(home,'download'),identity:release.identity,fetcher:release.fetcher,policy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});
  }});
  const target={request:{action:'install'},releasePlan:release.plan};
  await f.controller().start('install',{target},'limited-one');const failed=await f.controller().start('install',{target},'limited-two');
  const retryAt=failed.currentFailure.conditionTarget.retryAt;
  assert.ok(retryAt>clock);const requests=release.requests;release.setMode('range-only');
  const waiting=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(waiting.attempt,2);assert.equal(release.requests,requests);
  clock=retryAt+1;
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:waiting.snapshotSequence});
  assert.equal(checked.attempt,0);assert.equal(release.requests,requests+1);assert.equal(checked.allowedActions.includes('retry'),true);
});

async function metadataFixture(t,{tag,channel='stable'}={}){
  let mode='failed',requests=0;
  const base='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases';
  const url=tag?`${base}/tags/${encodeURIComponent(tag)}`:base+(channel==='beta'?'?per_page=100&page=1':'/latest');
  const release={tag_name:tag||'v2.4.2',draft:false,prerelease:false,assets:[]};
  const server=http.createServer((_request,response)=>{
    requests++;
    if(mode==='failed'){response.writeHead(503);response.end('unavailable');}
    else {response.writeHead(200,{'content-type':'application/json'});response.end(mode==='invalid'?'{}':
      JSON.stringify(mode==='wrong-tag'?{...release,tag_name:'v2.4.3'}:release));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const fetcher=async(original,options)=>{
    assert.equal(String(original),url,'the recheck reads the exact original official metadata URL');
    const response=await fetch(`http://127.0.0.1:${server.address().port}/metadata`,options);
    Object.defineProperty(response,'url',{value:String(original),configurable:true});return response;
  };
  fetcher.conditionRoute=async()=> 'DIRECT';
  return {url,fetcher,setMode:value=>{mode=value;},get requests(){return requests;}};
}

test('initial official metadata failure permits install to continue only after a valid original GET; its consumed proof cannot reset attempts',async t=>{
  const metadata=await metadataFixture(t),completedTags=[];
  const f=await fixture(t,{policyFactory:legacyCreate,selectBeforeExecute:false,policyOptions:{networkFetch:metadata.fetcher},execute:async()=>{
    const release=await releases.latest(metadata.fetcher,undefined,'stable',undefined,{networkPolicy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});
    completedTags.push(release.tag_name);return {verification:'confirmed'};
  }});
  const target={request:{action:'install'}};
  await f.controller().start('install',{target},'metadata-one');const failed=await f.controller().start('install',{target},'metadata-two');
  assert.equal(f.runs,2);assert.equal(failed.currentFailure.conditionTarget.kind,'release-metadata');
  const unchanged=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(unchanged.attempt,2);
  const blocked=await f.controller().start('install',{target},'metadata-new-request');assert.equal(blocked.state,'blocked');
  metadata.setMode('invalid');
  const invalid=await f.controller().recheck(blocked.operationId,{snapshotSequence:blocked.snapshotSequence});
  assert.equal(invalid.attempt,blocked.attempt);assert.equal(invalid.allowedActions.includes('retry'),false);assert.equal(f.runs,2);
  metadata.setMode('readable');
  const checked=await f.controller().recheck(blocked.operationId,{snapshotSequence:invalid.snapshotSequence});
  assert.equal(checked.attempt,0);assert.deepEqual(checked.target,target);assert.equal(checked.allowedActions.includes('retry'),true);
  const resumed=await f.controller().resume(blocked.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(resumed.state,'succeeded');assert.deepEqual(completedTags,['v2.4.2']);assert.equal(f.runs,3);
  metadata.setMode('failed');
  await f.controller().start('install',{target},'metadata-after-success-one');
  const again=await f.controller().start('install',{target},'metadata-after-success-two');assert.equal(again.attempt,2);
  metadata.setMode('readable');const reads=metadata.requests;
  const operationFile=path.join(f.home,'installer/operations',again.operationId,'operation.json');
  const baseline=JSON.parse(fs.readFileSync(operationFile)).conditionBaseline;
  const consumed=await f.controller().recheck(again.operationId,{snapshotSequence:again.snapshotSequence});
  assert.equal(consumed.attempt,2);assert.equal(consumed.allowedActions.includes('retry'),false);
  // One controlled GET attempts to verify a complete corrected installation.
  // This fixture has no complete system, so it cannot mint that separate proof.
  assert.equal(metadata.requests,reads+1);
  const after=JSON.parse(fs.readFileSync(operationFile)).conditionBaseline;
  assert.deepEqual(after.facts.networkReads,baseline.facts.networkReads);
  assert.equal(after.facts.installSelections,undefined);
  const fresh=await f.controller().start('install',{target},'metadata-after-consumed');assert.equal(fresh.state,'blocked');assert.equal(f.runs,5);
});

test('initial explicit metadata recheck must prove the original fixed tag',async t=>{
  const metadata=await metadataFixture(t,{tag:'v2.4.2'});
  const f=await fixture(t,{policyFactory:legacyCreate,selectBeforeExecute:false,policyOptions:{networkFetch:metadata.fetcher},execute:async()=>{
    await releases.latest(metadata.fetcher,undefined,'stable','v2.4.2',{networkPolicy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});
    return {verification:'confirmed'};
  }});
  const target={request:{action:'install',tag:'v2.4.2'}};
  await f.controller().start('install',{target},'tag-one');const failed=await f.controller().start('install',{target},'tag-two');
  metadata.setMode('wrong-tag');
  const wrong=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});assert.equal(wrong.attempt,2);
  metadata.setMode('readable');
  const valid=await f.controller().recheck(failed.operationId,{snapshotSequence:wrong.snapshotSequence});
  assert.equal(valid.attempt,0);assert.deepEqual(valid.target,target);assert.equal(valid.allowedActions.includes('retry'),true);
});

test('default Jihu metadata failure retains an admitted physical cause when canonical route lookup fails and recovery needs fresh bytes',async t=>{
  const canonical='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest';
  const primary=sourceCandidates(canonical)[0];assert.equal(primary.provider,'jihulab');
  let clock=Date.now(),mode='failed',canonicalRoute=false,lastError;const requests=[];
  const release={tag_name:'v2.4.2',draft:false,prerelease:false,assets:[]};
  const fetcher=async original=>{
    const url=String(original);requests.push(url);assert.equal(url,primary.url);
    if(mode==='failed'){clock+=2000;throw Object.assign(new Error('primary transport reset'),{code:'ECONNRESET'});}
    const response=mode==='not-modified'?new Response(null,{status:304}):Response.json(mode==='invalid'?{}:release);
    Object.defineProperty(response,'url',{value:url});return response;
  };
  fetcher.conditionRoute=async url=>{
    if(String(url)===canonical&&!canonicalRoute)throw Error('canonical route lookup unavailable');
    return 'DIRECT';
  };
  const f=await fixture(t,{selectBeforeExecute:false,policyOptions:{networkFetch:fetcher,now:()=>clock},execute:async()=>{
    try{await metadataJson(canonical,{fetcher,policy:{maxAttempts:1,totalBudgetMs:1000,now:()=>clock}});}
    catch(error){lastError=error;throw error;}
    return {verification:'confirmed'};
  }});
  const target={request:{action:'install'}};
  await f.controller().start('install',{target},'domestic-route-one');
  const failed=await f.controller().start('install',{target},'domestic-route-two');
  assert.equal(lastError.conditionResource,undefined,'the failed logical route lookup cannot invent canonical evidence');
  assert.equal(lastError.cause?.cause?.conditionResource?.url,primary.url,'the real failed primary read keeps its physical identity');
  assert.equal(failed.currentFailure.conditionTarget?.kind,'release-metadata');
  assert.equal(failed.currentFailure.conditionTarget.resource.url,canonical,'retry admission binds the admitted source back to the logical resource');
  canonicalRoute=true;mode='invalid';
  let checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(checked.attempt,2);assert.equal(checked.allowedActions.includes('retry'),false);
  mode='not-modified';checked=await f.controller().recheck(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(checked.attempt,2);assert.equal(checked.allowedActions.includes('retry'),false,'304 without fresh bytes cannot prove recovery');
  mode='readable';checked=await f.controller().recheck(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(checked.attempt,0);assert.equal(checked.allowedActions.includes('retry'),true);assert.deepEqual(checked.target,target);
  const before=requests.length,consumed=await f.controller().recheck(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(consumed.snapshotSequence,checked.snapshotSequence);
  // Selection may probe the catalogue once, but this incomplete publication
  // cannot create a separate full-install proof or reuse the metadata proof.
  assert.equal(requests.length,before+1);assert.equal(consumed.attempt,0);
  const resumed=await f.controller().resume(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(resumed.state,'succeeded');assert.equal(f.runs,3);
  assert.ok(requests.every(url=>url===primary.url),'a healthy domestic source never delegates this proof to another host');
});

test('canonical beta API metadata recheck keeps its valid page query with the current domestic source policy',async t=>{
  const canonical='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=1';
  const candidates=sourceCandidates(canonical,{channel:'beta'});assert.equal(candidates[0].provider,'jihulab');
  let mode='failed';const requests=[];
  const rows=[{tag_name:'v2.4.2-beta.1',draft:false,prerelease:true,assets:[]}];
  const fetcher=async original=>{
    const url=String(original);requests.push(url);assert.ok(candidates.some(item=>item.url===url));
    const response=mode==='failed'?new Response('unavailable',{status:503}):Response.json(mode==='invalid'?{}:rows);
    Object.defineProperty(response,'url',{value:url});return response;
  };
  fetcher.conditionRoute=async()=> 'DIRECT';
  const f=await fixture(t,{selectBeforeExecute:false,policyOptions:{networkFetch:fetcher,channel:'beta'},execute:async()=>{
    await metadataJson(canonical,{fetcher,channel:'beta',policy:{maxAttempts:1,totalBudgetMs:1000}});
    return {verification:'confirmed'};
  }});
  const target={request:{action:'install',channel:'beta'}};
  await f.controller().start('install',{target},'beta-query-one');
  const failed=await f.controller().start('install',{target},'beta-query-two');
  assert.equal(failed.currentFailure.conditionTarget?.kind,'release-metadata');
  assert.equal(failed.currentFailure.conditionTarget.resource.url,canonical);
  mode='invalid';const invalid=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(invalid.attempt,2);assert.equal(invalid.allowedActions.includes('retry'),false);
  mode='readable';const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:invalid.snapshotSequence});
  assert.equal(checked.attempt,0);assert.equal(checked.allowedActions.includes('retry'),true);assert.deepEqual(checked.target,target);
  const result=await f.controller().resume(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(result.state,'succeeded');assert.equal(f.runs,3);
  assert.equal(requests.at(-1),candidates[0].url);
});

test('physical Jihu metadata identity admits only the configured project, fixed tag and known resource shape',async t=>{
  const f=await fixture(t,{selectBeforeExecute:false});
  const logical='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/v2.4.2';
  const primary=sourceCandidates(logical)[0];assert.equal(primary.provider,'jihulab');
  const project=/\/projects\/([0-9]+)\//.exec(new URL(primary.url).pathname);assert.ok(project);
  const foreignProject=primary.url.replace(`/projects/${project[1]}/`,`/projects/${project[1]==='1'?'2':'1'}/`);
  const record={kind:'install',operationId:'bb100075-1af2-4b83-ac46-a9f8e24b6b01',target:{request:{action:'install',tag:'v2.4.2'}}};
  const error=url=>Object.assign(new Error('metadata unavailable'),{code:'TIMEOUT',source:'release_service',site:'release.request',
    conditionResource:{url,routeHash:hash('DIRECT')}});
  const valid=f.policy.identifyFailureCondition(error(primary.url),record);
  assert.equal(valid.kind,'release-metadata');assert.equal(valid.resource.url,logical);
  for(const url of [foreignProject,
    primary.url.replace('/generic/nora-tavern/','/generic/other/'),primary.url.replace('/v2.4.2/','/v2.4.3/'),
    primary.url+'?credential=external',primary.url+'#external',primary.url.replace('jihulab.com','unknown.example'),
    primary.url.replace('/release.json','/unowned.json'),
    sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest')[0].url,
    sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=1',{channel:'beta'})[0].url])
    assert.equal(f.policy.identifyFailureCondition(error(url),record),null,url);
  for(const code of ['CERT_HAS_EXPIRED','VERIFICATION_FAILED','INVALID_RESPONSE'])
    assert.equal(f.policy.identifyFailureCondition({...error(primary.url),code},record),null);
});

function completeReleaseFixture({publicationTag}={}){
  const platform=process.platform,arch=process.arch,tag=publicationTag||'v2.4.2',capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
  const publication=publicationTag?{publication:{schema:'nora-component-publication/1',tag:publicationTag}}:{};
  const manifest={schema:'tavern-release/v2',...publication,commit:'a'.repeat(40),versions:{tavern:'2.4.2'},launcherVersion:'2.0.3',launcherCapabilities:capabilities,
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.0.0',sha256:hash('bootstrap')}};
  const launcher={schema:'nora-launcher/v1',platform,arch,version:'2.0.3',asset:`Nora-Tavern-Launcher-2.0.3-${platform}-${arch}-update.zip`,size:7,sha256:hash('archive')};
  const payloads={'release-manifest.json':manifest,[`nora-launcher-${platform}-${arch}.json`]:launcher};
  const bytes={'release-manifest.json':JSON.stringify(manifest),[`nora-launcher-${platform}-${arch}.json`]:JSON.stringify(launcher),
    [launcher.asset]:'archive','tavern-updater-bootstrap.py':'bootstrap','SHA256SUMS':'hashes',
    'nora-tavern-app.tar.gz':'app','nora-tavern-ops.tar.gz':'ops','nora-tavern-nora-mcp.tar.gz':'mcp',
    'nora-tavern-first-install-bootstrap.py':'install','first-install-manifest.json':'{}','nora-hermes-runtime.json':'{}','nora-tavern-dependencies.json':'{}'};
  const system={schema:'nora-system/v1',...publication,version:'2.4.2',commit:'a'.repeat(40),platform,arch,minimumLauncherVersion:'2.0.3',launcherCapabilities:capabilities,files:{}};
  for(const [name,body] of Object.entries(bytes))if(!name.startsWith('nora-launcher-')&&name!==launcher.asset&&name!=='tavern-updater-bootstrap.py')
    system.files[name]={asset:name,sha256:hash(body),size:Buffer.byteLength(body)};
  bytes[`nora-system-${platform}-${arch}.json`]=JSON.stringify(system);payloads[`nora-system-${platform}-${arch}.json`]=system;
  const release={tag_name:tag,draft:false,prerelease:false,assets:Object.entries(bytes).map(([name,body])=>({name,size:Buffer.byteLength(body),
    browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${tag}/${name}`}))};
  return {platform,arch,tag,payloads,bytes,release};
}

async function selectedMetadataBlock(t,{legacy=false,laterUnknown=false,olderMetadata=false,domestic=false}={}){
  const published=completeReleaseFixture(),logical=releases.assetUrl(published.release,'release-manifest.json');
  const url=domestic?sourceCandidates(logical)[0].url:logical;
  let body=published.bytes['release-manifest.json'],reads=0,phase='history';
  const fetcher=async original=>{
    reads++;assert.equal(String(original),url);
    const response=new Response(body);Object.defineProperty(response,'url',{value:String(original)});return response;
  };
  fetcher.conditionRoute=async()=> 'DIRECT';
  const f=await fixture(t,{policyFactory:domestic?create:legacyCreate,selectBeforeExecute:false,policyOptions:{networkFetch:fetcher,launcherVersion:'2.0.3'}});
  const plan=await releases.selectPlan({mode:'update',launcherVersion:'2.0.3',selectedRelease:published.release,
    fetcher:async original=>new Response(published.bytes[String(original).split('/').at(-1)]),
    networkPolicy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});
  const request={action:'update',tag:published.tag},target={request};
  f.options.recheckers.update=f.policy.recheck;
  f.options.executors.update=async context=>{
    if(phase==='metadata')throw Object.assign(new Error('original metadata timeout'),{code:'TIMEOUT',source:'release_service',site:'release.request',
      conditionResource:{url,routeHash:hash('DIRECT')}});
    if(phase==='unknown')throw new Error('a later unrelated failure');
    const sealed=releases.sealPlan(plan,{operationDirectory:path.join(f.home,'installer/operations',context.operationId),
      assertOwner:context.check,launcherVersion:'2.0.3'});
    await context.plan({request,releasePlan:sealed});
    if(phase==='history')throw new Error('older unrelated verification failed');
    return {verification:'confirmed'};
  };
  const metadataFailure=async()=>{
    phase='metadata';const failed=await f.controller().start('update',{target},'original-metadata-timeout');
    assert.equal(failed.primaryFailure.code,'TIMEOUT');assert.equal(failed.totalAttempts,1);
    // A lost native commit ACK can leave the returned failure older than the
    // durable record. That is not this metadata-recheck scenario: do not hide
    // it by refreshing the snapshot or letting a later CAS failure obscure it.
    const persisted=JSON.parse(fs.readFileSync(path.join(f.home,'installer/operations',failed.operationId,'operation.json')));
    const guardFailures=failed.secondaryFailures.map(item=>({code:item.code,operation:item.operation}));
    assert.deepEqual(guardFailures,[],'Metadata fixture had an unexpected native writer failure: '+JSON.stringify(guardFailures));
    assert.deepEqual(failed.evidenceMissingReasons,[],'Metadata fixture must have a durable failure before rechecking');
    assert.equal(failed.snapshotSequence,persisted.sequence,'Metadata fixture returned a snapshot older than its durable failure');
    assert.equal(failed.effectState,'untouched');assert.equal(failed.currentFailure.code,'TIMEOUT');
    return failed;
  };
  let failed=olderMetadata?await metadataFailure():null;
  phase='history';await f.controller().start('update',{target},'selected-failure-one');
  const second=await f.controller().start('update',{target},'selected-failure-two');assert.equal(second.attempt,2);
  if(!failed)failed=await metadataFailure();
  if(laterUnknown){
    const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
    assert.equal(checked.attempt,0);
    phase='unknown';failed=await f.controller().resume(checked.operationId,{snapshotSequence:checked.snapshotSequence});
    assert.equal(failed.currentFailure.code,'UNKNOWN_PROGRAM_ERROR');assert.equal(failed.primaryFailure.code,'TIMEOUT');
    const unchanged=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
    assert.equal(unchanged.snapshotSequence,failed.snapshotSequence);assert.equal(reads,1);
  }
  phase='success';let blocked=await f.controller().resume(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(blocked.state,'blocked');assert.equal(blocked.totalAttempts,laterUnknown?3:2);
  assert.equal(blocked.currentFailure.code,'RETRY_CONDITIONS_UNCHANGED');assert.equal(blocked.attempt,3);
  if(legacy){
    // Replay the persisted pre-fix shape: the admission error lost its annotation.
    const file=path.join(f.home,'installer/operations',blocked.operationId,'operation.json');
    const record=JSON.parse(fs.readFileSync(file));delete record.currentFailure.conditionTarget;
    fs.writeFileSync(file,JSON.stringify(record));blocked=await f.controller().snapshot(blocked.operationId);
  }
  return {...f,blocked,published,url,setBody:value=>{body=value;},get reads(){return reads;}};
}

test('a metadata timeout followed by fixed-plan admission still verifies its exact sealed bytes before granting one retry',async t=>{
  for(const legacy of [false,true]){
    const f=await selectedMetadataBlock(t,{legacy}),fixed=JSON.stringify(f.blocked.target);
    // Identical parsed fields with altered raw bytes cannot prove the sealed target.
    f.setBody(f.published.bytes['release-manifest.json']+' ');
    const badSize=await f.controller().recheck(f.blocked.operationId,{snapshotSequence:f.blocked.snapshotSequence});
    assert.equal(badSize.attempt,3);assert.equal(badSize.allowedActions.includes('retry'),false);
    f.setBody(f.published.bytes['release-manifest.json'].replace('a'.repeat(40),'b'.repeat(40)));
    const badHash=await f.controller().recheck(badSize.operationId,{snapshotSequence:badSize.snapshotSequence});
    assert.equal(badHash.attempt,3);assert.equal(badHash.allowedActions.includes('retry'),false);
    f.setBody(f.published.bytes['release-manifest.json']);
    const checked=await f.controller().recheck(badHash.operationId,{snapshotSequence:badHash.snapshotSequence});
    assert.equal(checked.attempt,0);assert.equal(checked.allowedActions.includes('retry'),true);
    assert.equal(JSON.stringify(checked.target),fixed);assert.equal(f.reads,3);
    const consumed=await f.controller().recheck(checked.operationId,{snapshotSequence:checked.snapshotSequence});
    assert.equal(consumed.snapshotSequence,checked.snapshotSequence);assert.equal(f.reads,3);
    const resumed=await f.controller().resume(checked.operationId,{snapshotSequence:checked.snapshotSequence});
    assert.equal(resumed.state,'succeeded');assert.equal(resumed.attempt,1);assert.equal(JSON.stringify(resumed.target),fixed);
  }
});

test('current Jihu recheck of a selected update keeps the fixed tag and sealed manifest SHA through physical-source recovery',async t=>{
  const f=await selectedMetadataBlock(t,{domestic:true}),fixed=JSON.stringify(f.blocked.target);
  const current=f.blocked.currentFailure.conditionTarget.resource.url;
  assert.equal(current,releases.assetUrl(f.published.release,'release-manifest.json'),'the physical failure cannot replace the canonical fixed target');
  let record=f.blocked;
  for(const body of [f.published.bytes['release-manifest.json']+' ',
    f.published.bytes['release-manifest.json'].replace('a'.repeat(40),'b'.repeat(40))]){
    f.setBody(body);record=await f.controller().recheck(record.operationId,{snapshotSequence:record.snapshotSequence});
    assert.equal(record.attempt,3);assert.equal(record.allowedActions.includes('retry'),false);
    assert.equal(JSON.stringify(record.target),fixed);
  }
  f.setBody(f.published.bytes['release-manifest.json']);
  const checked=await f.controller().recheck(record.operationId,{snapshotSequence:record.snapshotSequence});
  assert.equal(checked.attempt,0);assert.equal(checked.allowedActions.includes('retry'),true);assert.equal(JSON.stringify(checked.target),fixed);
  assert.equal(f.reads,3);
  const resumed=await f.controller().resume(checked.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(resumed.state,'succeeded');assert.equal(JSON.stringify(resumed.target),fixed);
});

test('a later actual unknown failure and its admission block cannot revive the first metadata condition',async t=>{
  for(const legacy of [false,true]){
    const f=await selectedMetadataBlock(t,{legacy,laterUnknown:true});
    const checked=await f.controller().recheck(f.blocked.operationId,{snapshotSequence:f.blocked.snapshotSequence});
    assert.equal(checked.attempt,3);assert.equal(checked.allowedActions.includes('retry'),false);assert.equal(f.reads,1);
  }
});

test('an older metadata failure cannot replace later actual failures against the same selected plan',async t=>{
  for(const legacy of [false,true]){
    const f=await selectedMetadataBlock(t,{legacy,olderMetadata:true});
    const checked=await f.controller().recheck(f.blocked.operationId,{snapshotSequence:f.blocked.snapshotSequence});
    assert.equal(checked.attempt,3);assert.equal(checked.allowedActions.includes('retry'),false);assert.equal(f.reads,0);
  }
});

test('post-selection metadata proof refuses another tag, catalogue, descriptor or invalid sealed plan without network reads',async t=>{
  const f=await selectedMetadataBlock(t);
  const record=JSON.parse(fs.readFileSync(path.join(f.home,'installer/operations',f.blocked.operationId,'operation.json')));
  const condition=record.primaryFailure.conditionTarget;
  for(const url of [f.url.replace('v2.4.2','v2.4.3'),'https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest',
    releases.assetUrl(f.published.release,`nora-system-${process.platform}-${process.arch}.json`)]){
    assert.equal((await f.policy.recheck(record,{conditionTarget:{...condition,resource:{...condition.resource,url}}})).changed,false);
  }
  const invalid={...record,target:{...record.target,releasePlan:{...record.target.releasePlan,planId:'0'.repeat(64)}}};
  assert.equal((await f.policy.recheck(invalid,{conditionTarget:condition})).changed,false);assert.equal(f.reads,0);
});

async function manifestFixture(t,type,{publicationTag}={}){
  const {platform,arch,tag,payloads,bytes,release}=completeReleaseFixture({publicationTag});
  const name=type==='release'?'release-manifest.json':`nora-${type}-${platform}-${arch}.json`;
  const url=releases.assetUrl(release,name);let mode='failed',originalReads=0;
  const server=http.createServer((request,response)=>{
    const requested=decodeURIComponent(request.url.slice(1));
    if(requested==='api'){response.writeHead(200);response.end(JSON.stringify(release));return;}
    if(requested===name){
      originalReads++;
      if(mode==='failed'){response.writeHead(503);response.end('unavailable');return;}
      let result=payloads[name];
      if(mode==='bad-tag')result=publicationTag?{...result,publication:{...result.publication,tag:'v2.4.4'}}
        :type==='release'?{...result,versions:{tavern:'2.4.3'}}:type==='system'?{...result,version:'2.4.3'}:{...result,version:'2.0.4'};
      if(mode==='bad-platform')result={...result,platform:platform==='darwin'?'win32':'darwin'};
      response.writeHead(200);response.end(JSON.stringify(result));return;
    }
    response.writeHead(200);response.end(bytes[requested]);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const fetcher=async(original,options)=>{
    const name=String(original).includes('api.github.com')?'api':String(original).split('/').at(-1);
    const response=await fetch(`http://127.0.0.1:${server.address().port}/${name}`,options);
    Object.defineProperty(response,'url',{value:String(original),configurable:true});return response;
  };
  fetcher.conditionRoute=async()=> 'DIRECT';
  return {url,tag,fetcher,expectedVersion:type==='launcher'?'2.0.3':undefined,expectedSystemVersion:type==='system'?tag:undefined,
    setMode:value=>{mode=value;},get originalReads(){return originalReads;}};
}

for(const [type,publicationTag] of [['release'],['launcher'],['system'],['system','v2.4.3']])test(`real selectPlan ${type} metadata failure requires the original tag/platform/expected-version JSON before install can continue${publicationTag?' with a distinct publication batch':''}`,async t=>{
  const metadata=await manifestFixture(t,type,{publicationTag});let completedPlans=0;
  const f=await fixture(t,{selectBeforeExecute:false,policyOptions:{networkFetch:metadata.fetcher},execute:async context=>{
    const selected=await releases.selectPlan({fetcher:metadata.fetcher,mode:'install',tag:metadata.tag,launcherVersion:'2.0.2',
      networkPolicy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});
    await context.plan({...context.target,releasePlan:selected});completedPlans++;return {verification:'confirmed'};
  }});
  const target={request:{action:'install',tag:metadata.tag}};
  await f.controller().start('install',{target},`${type}-one`);const failed=await f.controller().start('install',{target},`${type}-two`);
  assert.equal(f.runs,2);assert.equal(failed.currentFailure.conditionTarget.kind,'release-metadata');
  assert.equal(failed.currentFailure.conditionTarget.resource.url,metadata.url);
  assert.equal(failed.currentFailure.conditionTarget.resource.expectedVersion,metadata.expectedVersion);
  assert.equal(failed.currentFailure.conditionTarget.resource.expectedSystemVersion,metadata.expectedSystemVersion);
  const unchanged=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});assert.equal(unchanged.attempt,2);
  metadata.setMode('bad-tag');
  const wrongTag=await f.controller().recheck(failed.operationId,{snapshotSequence:unchanged.snapshotSequence});
  assert.equal(wrongTag.allowedActions.includes('retry'),false);assert.equal(f.runs,2);
  let sequence=wrongTag.snapshotSequence;
  if(type!=='release'){
    metadata.setMode('bad-platform');const wrongPlatform=await f.controller().recheck(failed.operationId,{snapshotSequence:sequence});
    assert.equal(wrongPlatform.allowedActions.includes('retry'),false);sequence=wrongPlatform.snapshotSequence;
  }
  metadata.setMode('readable');
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:sequence});
  assert.equal(checked.attempt,0);assert.equal(checked.allowedActions.includes('retry'),true);assert.deepEqual(checked.target,target);
  const resumed=await f.controller().resume(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(resumed.state,'succeeded');assert.equal(completedPlans,1);assert.equal(f.runs,3);
});

test('a success keeps consumed original-asset proof when a new request selects the same actual fixed Plan',async t=>{
  const release=await releaseFixture(t);let downloadRuns=0;
  const f=await fixture(t,{selectBeforeExecute:false,policyOptions:{networkFetch:release.fetcher},execute:async(context,{home})=>{
    if(!context.target.releasePlan)await context.plan({...context.target,releasePlan:release.plan});
    downloadRuns++;
    await downloadAsset({url:release.url,target:path.join(home,`asset-${downloadRuns}`),identity:release.identity,
      fetcher:release.fetcher,policy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});
    return {verification:'confirmed'};
  }});
  const target={request:{action:'install'}};
  await f.controller().start('install',{target},'plan-one');const failed=await f.controller().start('install',{target},'plan-two');
  assert.equal(downloadRuns,2);release.setMode('range-only');
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(checked.allowedActions.includes('retry'),true);release.setMode('success');
  const succeeded=await f.controller().resume(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(succeeded.state,'succeeded');assert.equal(downloadRuns,3);release.setMode('failed');
  await f.controller().start('install',{target},'same-selected-plan-one');
  const again=await f.controller().start('install',{target},'same-selected-plan-two');assert.equal(again.attempt,2);assert.equal(downloadRuns,5);
  const blocked=await f.controller().start('install',{target},'same-selected-plan-third');assert.equal(blocked.state,'blocked');assert.equal(downloadRuns,5);
  release.setMode('range-only');const reads=release.requests;
  const consumed=await f.controller().recheck(blocked.operationId,{snapshotSequence:blocked.snapshotSequence});
  assert.equal(consumed.allowedActions.includes('retry'),false);assert.equal(release.requests,reads);assert.equal(downloadRuns,5);
});

test('an asset network exception retains the original asset identity rather than becoming a metadata failure',async t=>{
  const release=await releaseFixture(t),f=await fixture(t);
  const fetcher=async()=>{throw Object.assign(new Error('original asset DNS failed'),{code:'ENOTFOUND'});};
  fetcher.conditionRoute=release.fetcher.conditionRoute;
  let error;
  try{await downloadAsset({url:release.url,target:path.join(f.home,'asset'),identity:release.identity,fetcher,policy:{sources:githubOnly,maxAttempts:1,totalBudgetMs:1000}});}catch(caught){error=caught;}
  assert.equal(error.site,'release.download');
  const condition=f.policy.identifyFailureCondition(error,{kind:'install',operationId:'bb100075-1af2-4b83-ac46-a9f8e24b6b01',target:{releasePlan:release.plan}});
  assert.equal(condition.kind,'release-read');assert.equal(condition.resource.url,release.url);
});

test('certificate, content hash and manifest errors cannot borrow an asset readability proof or upload local condition URLs',async t=>{
  const release=await releaseFixture(t),f=await fixture(t);
  const record={kind:'install',operationId:'bb100075-1af2-4b83-ac46-a9f8e24b6b01',target:{releasePlan:release.plan}};
  const conditionResource={url:release.url,...release.identity,routeHash:hash('direct-node')};
  for(const code of ['CERT_HAS_EXPIRED','VERIFICATION_FAILED','INVALID_RESPONSE']){
    const error=Object.assign(new Error('rejected'),{code,source:'release_service',site:'release.download',conditionResource});
    assert.equal(f.policy.identifyFailureCondition(error,record),null);
  }
  const {createFaultPackets}=require('../installer/desktop/fault-packet');
  const error=Object.assign(new Error('asset unavailable'),{status:503,source:'release_service',site:'release.download',conditionResource});
  const fault=createFaultPackets().packet(error,{id:record.operationId,action:'install',stage:'download',started:Date.now(),stageStarted:Date.now()});
  assert.equal(JSON.stringify(fault).includes(release.url),false);
  assert.equal(JSON.stringify(fault).includes('conditionResource'),false);
});

test('unknown errors and unrelated directory improvements do not authorize retry',async t=>{
  const f=await fixture(t,{execute:async()=>{throw new Error('unknown native failure');}});
  fs.chmodSync(f.hermesHome,0o500);
  await f.controller().start('install',{target:f.target},'unknown-first');
  const failed=await f.controller().start('install',{target:f.target},'unknown-second');
  fs.chmodSync(f.hermesHome,0o700);
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(checked.attempt,2);assert.equal(checked.allowedActions.includes('retry'),false);assert.equal(f.runs,2);
});

test('a failed current condition measurement cannot disconnect the same-target failure budget',async t=>{
  const f=await fixture(t,{execute:async()=>{throw new Error('same native failure');}});
  await f.controller().start('install',{target:f.target},'measurement-first');
  await f.controller().start('install',{target:f.target},'measurement-second');
  const unavailable=create({home:f.home,hermesHome:f.hermesHome,installRoot:f.installRoot,
    bridge:async()=>({}),runRuntime:async()=>{},checkConditions:async()=>{throw Object.assign(new Error('condition measurement inaccessible'),{code:'EACCES'});}});
  f.options.captureConditions=unavailable.initialConditions;
  const blocked=await f.controller().start('install',{target:f.target},'measurement-new-request');
  assert.equal(blocked.state,'blocked');assert.equal(f.runs,2);
});

test('a successful metadata check does not improve the failed asset download condition',async t=>{
  const f=await fixture(t,{execute:async()=>{throw Object.assign(new Error('asset reset'),{code:'ECONNRESET',source:'release_service',site:'release.download'});}});
  await f.controller().start('install',{target:f.target},'network-first');
  const failed=await f.controller().start('install',{target:f.target},'network-second');
  let reads=0;
  const unrelated=create({...f.options,home:f.home,hermesHome:f.hermesHome,installRoot:f.installRoot,
    networkFetch:f.networkFetch,
    bridge:async()=>({}),runRuntime:async()=>{},inspectRuntime:()=>({effectState:'untouched'}),inspectLegacy:()=>null,
    checkConditions:async()=>{reads++;return {eligible:true,facts:{metadataHead:true,checkedAt:Date.now()}};}});
  assert.equal((await unrelated.recheck({...failed,conditionBaseline:(await f.policy.initialConditions(failed))})).changed,false);
  assert.equal(reads,0);
  assert.equal(f.runs,2);
});

test('legacy Nora setup failures unlock only after the missing setup is positively verified, and the proof is consumed once',async t=>{
  const f=await fixture(t);let paired=false,runs=0;
  const policy=create({home:f.home,hermesHome:f.hermesHome,installRoot:f.installRoot,
    bridge:async command=>{assert.equal(command,'status');return {systemReady:true,clawchatPaired:paired,modelConfigured:true};},
    runRuntime:async()=>{},inspectRuntime:()=>({effectState:'untouched',recoveryOutcome:'not-required'}),inspectLegacy:()=>null});
  const options={...f.options,captureConditions:policy.initialConditions,
    // Historical records have the typed failure but no condition annotation.
    identifyFailureCondition:undefined,recheckers:{start:policy.recheck},
    executors:{start:async()=>{runs++;throw Object.assign(new Error('not paired'),{userCode:'CLAWCHAT_PAIR_REQUIRED'});}}};
  const controller=()=>createOperationController(options),target={request:{action:'start',service:'nora',port:18999}};
  await controller().start('start',{target},'unpaired-one');await controller().start('start',{target},'unpaired-two');
  const blocked=await controller().start('start',{target},'legacy-blocked');assert.equal(blocked.state,'blocked');assert.equal(runs,2);
  options.identifyFailureCondition=policy.identifyFailureCondition;
  const unchanged=await controller().recheck(blocked.operationId,{snapshotSequence:blocked.snapshotSequence});
  assert.equal(unchanged.attempt,3);assert.equal(unchanged.allowedActions.includes('retry'),false);
  paired=true;
  const checked=await controller().recheck(blocked.operationId,{snapshotSequence:unchanged.snapshotSequence});
  assert.equal(checked.attempt,0);assert.equal(checked.allowedActions.includes('retry'),true);
  const failed=await controller().resume(blocked.operationId,{snapshotSequence:checked.snapshotSequence});
  const twice=await controller().start('start',{target},'still-not-paired');assert.equal(runs,4);
  const consumed=await controller().recheck(twice.operationId,{snapshotSequence:twice.snapshotSequence});
  assert.equal(consumed.attempt,2);assert.equal(consumed.allowedActions.includes('retry'),false);assert.equal(runs,4);
});

test('successful setup recovery survives fresh requests without resurrecting obsolete failures or reusing its proof',async t=>{
  for(const selectPlan of [false,true]){
    const f=await fixture(t);let paired=false,failing=true,runs=0;
    const policy=create({home:f.home,hermesHome:f.hermesHome,installRoot:f.installRoot,
      bridge:async()=>({systemReady:true,clawchatPaired:paired,modelConfigured:true}),runRuntime:async()=>{},
      inspectRuntime:()=>({effectState:'untouched',recoveryOutcome:'not-required'}),inspectLegacy:()=>null});
    const target={request:{action:'start',service:'nora',port:18999}};
    const options={...f.options,captureConditions:policy.initialConditions,identifyFailureCondition:policy.identifyFailureCondition,
      recheckers:{start:policy.recheck},executors:{start:async context=>{
        if(selectPlan)await context.plan(target);
        runs++;
        if(failing)throw Object.assign(new Error('not paired'),{userCode:'CLAWCHAT_PAIR_REQUIRED'});
        return {verification:'confirmed'};
      }}};
    const controller=()=>createOperationController(options);
    await controller().start('start',{target},'unpaired-one');
    await controller().start('start',{target},'unpaired-two');
    const failed=await controller().start('start',{target},'unpaired-third');
    paired=true;failing=false;
    const checked=await controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
    const recovered=await controller().resume(failed.operationId,{snapshotSequence:checked.snapshotSequence});
    assert.equal(recovered.state,'succeeded');
    const fresh=await controller().start('start',{target},'after-recovery');
    assert.equal(fresh.state,'succeeded');assert.equal(fresh.attempt,1);assert.equal(runs,4);
    assert.equal(fresh.conditionFingerprint,recovered.conditionFingerprint);
    failing=true;
    await controller().start('start',{target},'failed-again-one');
    await controller().start('start',{target},'failed-again-two');
    const blocked=await controller().start('start',{target},'failed-again-third');
    assert.equal(blocked.state,'blocked');assert.equal(runs,6);
    const consumed=await controller().recheck(blocked.operationId,{snapshotSequence:blocked.snapshotSequence});
    assert.equal(consumed.allowedActions.includes('retry'),false);assert.equal(runs,6);
  }
});

test('service setup recheck refuses unknown failures, unhealthy installations and unrelated readiness',async t=>{
  const f=await fixture(t);let status={systemReady:true,modelConfigured:true,clawchatPaired:false};
  const policy=create({home:f.home,hermesHome:f.hermesHome,installRoot:f.installRoot,
    bridge:async()=>status,runRuntime:async()=>{},inspectRuntime:()=>({effectState:'untouched',recoveryOutcome:'not-required'}),inspectLegacy:()=>null});
  const base={kind:'start',operationId:'11111111-1111-4111-8111-111111111111',target:{request:{action:'start',service:'nora'}},effectState:'untouched',conditionFingerprint:''};
  assert.equal((await policy.recheck({...base,primaryFailure:{code:'UNKNOWN_PROGRAM_ERROR'}})).changed,false);
  const pair={...base,primaryFailure:{code:'CLAWCHAT_PAIR_REQUIRED'}};
  assert.equal((await policy.recheck(pair)).changed,false);
  status={systemReady:false,modelConfigured:true,clawchatPaired:true};assert.equal((await policy.recheck(pair)).changed,false);
  status={systemReady:true,modelConfigured:false,clawchatPaired:true};assert.equal((await policy.recheck(pair)).changed,true);
  assert.equal((await policy.recheck({...base,primaryFailure:{code:'MODEL_SETUP_REQUIRED'}})).changed,false);
});

// Source fallback must preserve the fixed resource identity used by retry admission.
test('both sources failing retain the canonical asset and a recovered backup can authorize one bounded retry',async t=>{
  const release=await releaseFixture(t);
  const fetcher=async(url,options)=>{
    if(new URL(url).hostname==='github.com'){
      const response=new Response('unavailable',{status:503});
      Object.defineProperty(response,'url',{value:String(url)});return response;
    }
    return release.fetcher(url,options);
  };
  fetcher.conditionRoute=release.fetcher.conditionRoute;
  const f=await fixture(t,{executionStage:'downloading',policyOptions:{networkFetch:fetcher},execute:async(_context,{home})=>{
    await downloadAsset({url:release.url,target:path.join(home,'download'),identity:release.identity,fetcher,
      policy:{maxAttempts:1,totalBudgetMs:1000}});return {verification:'confirmed'};
  }});
  const target={request:{action:'install'},releasePlan:release.plan};
  await f.controller().start('install',{target},'both-sources-one');
  const failed=await f.controller().start('install',{target},'both-sources-two');
  assert.equal(failed.currentFailure.conditionTarget?.kind,'release-read');
  assert.equal(failed.currentFailure.conditionTarget.resource.url,release.url);
  release.setMode('bad-range');
  const malformed=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(malformed.allowedActions.includes('retry'),false);
  release.setMode('range-only');
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:malformed.snapshotSequence});
  assert.equal(checked.allowedActions.includes('retry'),true);
  release.setMode('success');
  const result=await f.controller().resume(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(result.state,'succeeded');assert.equal(f.runs,3);
});

test('both metadata sources failing retain the fixed tag and only valid backup metadata permits continuation',async t=>{
  const metadata=await metadataFixture(t,{tag:'v2.4.2'});
  const fetcher=async(url,options)=>{
    if(new URL(url).hostname==='api.github.com'){
      const response=new Response('unavailable',{status:503});
      Object.defineProperty(response,'url',{value:String(url)});return response;
    }
    const response=await metadata.fetcher(metadata.url,options);
    Object.defineProperty(response,'url',{value:String(url),configurable:true});return response;
  };
  fetcher.conditionRoute=metadata.fetcher.conditionRoute;
  const f=await fixture(t,{selectBeforeExecute:false,policyOptions:{networkFetch:fetcher},execute:async()=>{
    const release=await releases.latest(fetcher,undefined,'stable','v2.4.2',{networkPolicy:{maxAttempts:1,totalBudgetMs:1000}});
    assert.equal(release.tag_name,'v2.4.2');return {verification:'confirmed'};
  }});
  const target={request:{action:'install',tag:'v2.4.2'}};
  await f.controller().start('install',{target},'both-metadata-one');
  const failed=await f.controller().start('install',{target},'both-metadata-two');
  assert.equal(failed.currentFailure.conditionTarget?.kind,'release-metadata');
  assert.equal(failed.currentFailure.conditionTarget.resource.url,metadata.url);
  metadata.setMode('wrong-tag');
  const wrong=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(wrong.allowedActions.includes('retry'),false);
  metadata.setMode('readable');
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:wrong.snapshotSequence});
  assert.equal(checked.allowedActions.includes('retry'),true);
  const result=await f.controller().resume(failed.operationId,{snapshotSequence:checked.snapshotSequence});
  assert.equal(result.state,'succeeded');assert.equal(f.runs,3);
});
