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
const {downloadAsset}=require('../installer/desktop/release-network');
const releases=require('../installer/desktop/releases');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t,{execute,capture=true,policyOptions={}}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-retry-conditions-'));
  const hermesHome=path.join(home,'hermes'),installRoot=path.join(home,'tavern');
  fs.mkdirSync(hermesHome);fs.mkdirSync(installRoot);
  t.after(()=>{fs.chmodSync(hermesHome,0o700);fs.rmSync(home,{recursive:true,force:true});});
  const policy=create({home,hermesHome,installRoot,bridge:async()=>({}),runRuntime:async()=>{},
    inspectRuntime:()=>({effectState:'untouched',recoveryOutcome:'not-required'}),inspectLegacy:()=>null,...policyOptions});
  let runs=0;
  const options={directory:path.join(home,'installer'),lock,observeEffects:policy.observe,recheckers:{install:policy.recheck},
    identifyFailureCondition:policy.identifyFailureCondition,
    ...(capture?{captureConditions:policy.initialConditions}:{}),executors:{install:async context=>{
      runs++;if(execute)return execute(context,{home,hermesHome,installRoot});
      fs.writeFileSync(path.join(hermesHome,'managed-file'),'owned');return {verification:'confirmed'};
    }}};
  const controller=()=>createOperationController(options);
  return {home,hermesHome,installRoot,policy,controller,options,get runs(){return runs;},target:{request:{action:'install'},planId:'same-target'}};
}

test('native writer records the baseline before two real permission failures; recheck, reopen and new requests cannot add execution',{skip:process.platform==='win32'?'POSIX chmod does not prove Windows ACL behavior':false},async t=>{
  const f=fixture(t);fs.chmodSync(f.hermesHome,0o500);
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
  const f=fixture(t);fs.chmodSync(f.hermesHome,0o500);
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
  const f=fixture(t,{capture:false});fs.chmodSync(f.hermesHome,0o500);
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
  const f=fixture(t,{policyOptions:{networkFetch:release.fetcher},execute:async(_context,{home})=>{
    await downloadAsset({url:release.url,target:path.join(home,'download'),identity:release.identity,fetcher:release.fetcher,
      policy:{maxAttempts:1,totalBudgetMs:1000}});return {verification:'confirmed'};
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
  const fourth=await f.controller().resume(blocked.operationId,{snapshotSequence:third.snapshotSequence});assert.equal(f.runs,4);
  const reads=release.requests;
  const consumed=await f.controller().recheck(fourth.operationId,{snapshotSequence:fourth.snapshotSequence});
  assert.equal(consumed.attempt,2);assert.equal(release.requests,reads,'a consumed proof does not re-read and re-authorize');
  const fresh=await f.controller().start('install',{target},'network-fresh-after-proof');assert.equal(fresh.state,'blocked');assert.equal(f.runs,4);
  const freshCheck=await f.controller().recheck(fresh.operationId,{snapshotSequence:fresh.snapshotSequence});assert.equal(freshCheck.allowedActions.includes('retry'),false);
  release.setRoute('PROXY fixture-changed');
  const changed=await f.controller().recheck(fresh.operationId,{snapshotSequence:freshCheck.snapshotSequence});
  assert.equal(changed.attempt,0);assert.equal(release.requests,reads+1);assert.equal(changed.allowedActions.includes('retry'),true);
});

test('a malformed original-resource range cannot authorize another attempt',async t=>{
  const release=await releaseFixture(t);
  const f=fixture(t,{policyOptions:{networkFetch:release.fetcher},execute:async(_context,{home})=>{
    await downloadAsset({url:release.url,target:path.join(home,'download'),identity:release.identity,fetcher:release.fetcher,policy:{maxAttempts:1,totalBudgetMs:1000}});
  }});
  const target={request:{action:'install'},releasePlan:release.plan};
  await f.controller().start('install',{target},'range-one');const failed=await f.controller().start('install',{target},'range-two');
  release.setMode('bad-range');
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(checked.attempt,2);assert.equal(checked.allowedActions.includes('retry'),false);assert.equal(f.runs,2);
});

test('an original-resource recheck respects Retry-After before probing, then requires actual bytes',async t=>{
  const release=await releaseFixture(t);release.setMode('throttled');let clock=Date.now();
  const f=fixture(t,{policyOptions:{networkFetch:release.fetcher,now:()=>clock},execute:async(_context,{home})=>{
    await downloadAsset({url:release.url,target:path.join(home,'download'),identity:release.identity,fetcher:release.fetcher,policy:{maxAttempts:1,totalBudgetMs:1000}});
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
  const f=fixture(t,{policyOptions:{networkFetch:metadata.fetcher},execute:async()=>{
    const release=await releases.latest(metadata.fetcher,undefined,'stable',undefined,{networkPolicy:{maxAttempts:1,totalBudgetMs:1000}});
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
  const consumed=await f.controller().recheck(again.operationId,{snapshotSequence:again.snapshotSequence});
  assert.equal(consumed.attempt,2);assert.equal(metadata.requests,reads);
  const fresh=await f.controller().start('install',{target},'metadata-after-consumed');assert.equal(fresh.state,'blocked');assert.equal(f.runs,5);
});

test('initial explicit metadata recheck must prove the original fixed tag',async t=>{
  const metadata=await metadataFixture(t,{tag:'v2.4.2'});
  const f=fixture(t,{policyOptions:{networkFetch:metadata.fetcher},execute:async()=>{
    await releases.latest(metadata.fetcher,undefined,'stable','v2.4.2',{networkPolicy:{maxAttempts:1,totalBudgetMs:1000}});
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

async function manifestFixture(t,type){
  const platform=process.platform,arch=process.arch,tag='v2.4.2',capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
  const manifest={schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.4.2'},launcherVersion:'2.0.3',launcherCapabilities:capabilities,
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.0.0',sha256:hash('bootstrap')}};
  const launcher={schema:'nora-launcher/v1',platform,arch,version:'2.0.3',asset:`Nora-Tavern-Launcher-2.0.3-${platform}-${arch}-update.zip`,size:7,sha256:hash('archive')};
  const payloads={'release-manifest.json':manifest,[`nora-launcher-${platform}-${arch}.json`]:launcher};
  const bytes={'release-manifest.json':JSON.stringify(manifest),[`nora-launcher-${platform}-${arch}.json`]:JSON.stringify(launcher),
    [launcher.asset]:'archive','tavern-updater-bootstrap.py':'bootstrap','SHA256SUMS':'hashes',
    'nora-tavern-app.tar.gz':'app','nora-tavern-ops.tar.gz':'ops','nora-tavern-nora-mcp.tar.gz':'mcp',
    'nora-tavern-first-install-bootstrap.py':'install','first-install-manifest.json':'{}','nora-hermes-runtime.json':'{}','nora-tavern-dependencies.json':'{}'};
  const system={schema:'nora-system/v1',version:'2.4.2',commit:'a'.repeat(40),platform,arch,minimumLauncherVersion:'2.0.3',launcherCapabilities:capabilities,files:{}};
  for(const [name,body] of Object.entries(bytes))if(!name.startsWith('nora-launcher-')&&name!==launcher.asset&&name!=='tavern-updater-bootstrap.py')
    system.files[name]={asset:name,sha256:hash(body),size:Buffer.byteLength(body)};
  bytes[`nora-system-${platform}-${arch}.json`]=JSON.stringify(system);payloads[`nora-system-${platform}-${arch}.json`]=system;
  const release={tag_name:tag,draft:false,prerelease:false,assets:Object.entries(bytes).map(([name,body])=>({name,size:Buffer.byteLength(body),
    browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${tag}/${name}`}))};
  const name=type==='release'?'release-manifest.json':`nora-${type}-${platform}-${arch}.json`;
  const url=releases.assetUrl(release,name);let mode='failed',originalReads=0;
  const server=http.createServer((request,response)=>{
    const requested=decodeURIComponent(request.url.slice(1));
    if(requested==='api'){response.writeHead(200);response.end(JSON.stringify(release));return;}
    if(requested===name){
      originalReads++;
      if(mode==='failed'){response.writeHead(503);response.end('unavailable');return;}
      let result=payloads[name];
      if(mode==='bad-tag')result=type==='release'?{...result,versions:{tavern:'2.4.3'}}:type==='system'?{...result,version:'2.4.3'}:{...result,version:'2.0.4'};
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
  return {url,fetcher,expectedVersion:type==='release'?undefined:'2.0.3',setMode:value=>{mode=value;},get originalReads(){return originalReads;}};
}

for(const type of ['release','launcher','system'])test(`real selectPlan ${type} metadata failure requires the original tag/platform/expected-version JSON before install can continue`,async t=>{
  const metadata=await manifestFixture(t,type);let completedPlans=0;
  const f=fixture(t,{policyOptions:{networkFetch:metadata.fetcher},execute:async context=>{
    const selected=await releases.selectPlan({fetcher:metadata.fetcher,mode:'install',tag:'v2.4.2',launcherVersion:'2.0.2',
      networkPolicy:{maxAttempts:1,totalBudgetMs:1000}});
    await context.plan({...context.target,releasePlan:selected});completedPlans++;return {verification:'confirmed'};
  }});
  const target={request:{action:'install',tag:'v2.4.2'}};
  await f.controller().start('install',{target},`${type}-one`);const failed=await f.controller().start('install',{target},`${type}-two`);
  assert.equal(f.runs,2);assert.equal(failed.currentFailure.conditionTarget.kind,'release-metadata');
  assert.equal(failed.currentFailure.conditionTarget.resource.url,metadata.url);
  assert.equal(failed.currentFailure.conditionTarget.resource.expectedVersion,metadata.expectedVersion);
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
  const f=fixture(t,{policyOptions:{networkFetch:release.fetcher},execute:async(context,{home})=>{
    if(!context.target.releasePlan)await context.plan({...context.target,releasePlan:release.plan});
    downloadRuns++;
    await downloadAsset({url:release.url,target:path.join(home,`asset-${downloadRuns}`),identity:release.identity,
      fetcher:release.fetcher,policy:{maxAttempts:1,totalBudgetMs:1000}});
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
  const release=await releaseFixture(t),f=fixture(t);
  const fetcher=async()=>{throw Object.assign(new Error('original asset DNS failed'),{code:'ENOTFOUND'});};
  fetcher.conditionRoute=release.fetcher.conditionRoute;
  let error;
  try{await downloadAsset({url:release.url,target:path.join(f.home,'asset'),identity:release.identity,fetcher,policy:{maxAttempts:1,totalBudgetMs:1000}});}catch(caught){error=caught;}
  assert.equal(error.site,'release.download');
  const condition=f.policy.identifyFailureCondition(error,{kind:'install',operationId:'bb100075-1af2-4b83-ac46-a9f8e24b6b01',target:{releasePlan:release.plan}});
  assert.equal(condition.kind,'release-read');assert.equal(condition.resource.url,release.url);
});

test('certificate, content hash and manifest errors cannot borrow an asset readability proof or upload local condition URLs',async t=>{
  const release=await releaseFixture(t),f=fixture(t);
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
  const f=fixture(t,{execute:async()=>{throw new Error('unknown native failure');}});
  fs.chmodSync(f.hermesHome,0o500);
  await f.controller().start('install',{target:f.target},'unknown-first');
  const failed=await f.controller().start('install',{target:f.target},'unknown-second');
  fs.chmodSync(f.hermesHome,0o700);
  const checked=await f.controller().recheck(failed.operationId,{snapshotSequence:failed.snapshotSequence});
  assert.equal(checked.attempt,2);assert.equal(checked.allowedActions.includes('retry'),false);assert.equal(f.runs,2);
});

test('a failed current condition measurement cannot disconnect the same-target failure budget',async t=>{
  const f=fixture(t,{execute:async()=>{throw new Error('same native failure');}});
  await f.controller().start('install',{target:f.target},'measurement-first');
  await f.controller().start('install',{target:f.target},'measurement-second');
  const unavailable=create({home:f.home,hermesHome:f.hermesHome,installRoot:f.installRoot,
    bridge:async()=>({}),runRuntime:async()=>{},checkConditions:async()=>{throw Object.assign(new Error('condition measurement inaccessible'),{code:'EACCES'});}});
  f.options.captureConditions=unavailable.initialConditions;
  const blocked=await f.controller().start('install',{target:f.target},'measurement-new-request');
  assert.equal(blocked.state,'blocked');assert.equal(f.runs,2);
});

test('a successful metadata check does not improve the failed asset download condition',async t=>{
  const f=fixture(t,{execute:async()=>{throw Object.assign(new Error('asset reset'),{code:'ECONNRESET',source:'release_service',site:'release.download'});}});
  await f.controller().start('install',{target:f.target},'network-first');
  const failed=await f.controller().start('install',{target:f.target},'network-second');
  let reads=0;
  const unrelated=create({...f.options,home:f.home,hermesHome:f.hermesHome,installRoot:f.installRoot,
    bridge:async()=>({}),runRuntime:async()=>{},inspectRuntime:()=>({effectState:'untouched'}),inspectLegacy:()=>null,
    checkConditions:async()=>{reads++;return {eligible:true,facts:{metadataHead:true,checkedAt:Date.now()}};}});
  assert.equal((await unrelated.recheck({...failed,conditionBaseline:(await f.policy.initialConditions(failed))})).changed,false);
  assert.equal(reads,0);
  assert.equal(f.runs,2);
});

test('legacy Nora setup failures unlock only after the missing setup is positively verified, and the proof is consumed once',async t=>{
  const f=fixture(t);let paired=false,runs=0;
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
    const f=fixture(t);let paired=false,failing=true,runs=0;
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
  const f=fixture(t);let status={systemReady:true,modelConfigured:true,clawchatPaired:false};
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
