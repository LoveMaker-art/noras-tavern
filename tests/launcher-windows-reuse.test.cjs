const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {verifyModes,verifySource,verifyArchive,verifyPackage,downloadArchive,requiredSteps,extractScript}=require('../tooling/release/reuse-windows-build.cjs');
const {execFileSync}=require('node:child_process');
const commit='a'.repeat(40),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function sourceFixture() {
 const run={id:123,head_sha:commit,repository:{id:42,full_name:'owner/tavern'},path:'.github/workflows/build-integrated-launcher.yml',event:'workflow_dispatch',status:'completed',conclusion:'success'};
 const artifacts={total_count:2,artifacts:['nora-tavern-win32-x64','nora-operation-acceptance-win32-x64'].map((name,index)=>({id:index+1,name,expired:false,size_in_bytes:1,digest:'sha256:'+sha('x'),workflow_run:{id:123,head_sha:commit,repository_id:42,head_repository_id:42}}))};
 const jobs={total_count:1,jobs:[{name:'build (windows-latest, win32, x64, pack:win:x64)',run_id:123,head_sha:commit,status:'completed',conclusion:'success',steps:requiredSteps.map(name=>({name,status:'completed',conclusion:'success'}))}]};
 return {run,artifacts,jobs,options:{commit,repository:'owner/tavern',runId:'123'}};
}
test('only a complete same-commit native Windows-only source can be reused',()=>{const f=sourceFixture();assert.equal(verifySource(f.run,f.artifacts,f.jobs,f.options).length,2);});
test('a successful Windows run cannot be reused without the new stability gate passing',()=>{
 for(const mode of ['missing','skipped']){
  const f=sourceFixture(),name='Require launcher source stability before preparing runtimes';
  assert.ok(f.jobs.jobs[0].steps.some(step=>step.name===name),'The stability step must be mandatory');
  if(mode==='missing')f.jobs.jobs[0].steps=f.jobs.jobs[0].steps.filter(step=>step.name!==name);
  else f.jobs.jobs[0].steps.find(step=>step.name===name).conclusion='skipped';
  assert.throws(()=>verifySource(f.run,f.artifacts,f.jobs,f.options),/native gate|Native gate/);
 }
});

test('a successful Windows run cannot be reused without native test prerequisites passing',()=>{
 const f=sourceFixture(),name='Verify native launcher test prerequisites';
 f.jobs.jobs[0].steps=f.jobs.jobs[0].steps.filter(step=>step.name!==name);
 assert.throws(()=>verifySource(f.run,f.artifacts,f.jobs,f.options),/Verify native launcher test prerequisites/);
});
test('a same-run decision plan is verified but is not extracted over native acceptance evidence',()=>{
 const f=sourceFixture();f.artifacts.artifacts.push({...f.artifacts.artifacts[0],id:3,name:'nora-release-plan'});f.artifacts.total_count++;
 assert.deepEqual(verifySource(f.run,f.artifacts,f.jobs,f.options).map(item=>item.name),['nora-tavern-win32-x64','nora-operation-acceptance-win32-x64']);
 f.artifacts.artifacts[2].workflow_run={...f.artifacts.artifacts[2].workflow_run,head_sha:'b'.repeat(40)};
 assert.throws(()=>verifySource(f.run,f.artifacts,f.jobs,f.options));
});
test('failed native diagnostic evidence remains available without replacing the accepted Windows delivery',()=>{
 const f=sourceFixture();f.artifacts.artifacts.push({...f.artifacts.artifacts[0],id:3,name:'nora-windows-failed-packaging-diagnostic'});f.artifacts.total_count++;
 assert.equal(verifySource(f.run,f.artifacts,f.jobs,f.options).length,2);
});
for(const [label,change] of [
 ['wrong commit',f=>f.run.head_sha='b'.repeat(40)],['wrong repository',f=>f.run.repository.full_name='other/tavern'],
 ['wrong workflow',f=>f.run.path='other.yml'],['wrong event',f=>f.run.event='push'],['failed run',f=>f.run.conclusion='failure'],['running source',f=>f.run.status='in_progress'],
 ['incomplete artifact page',f=>f.artifacts.total_count++],['extra platform',f=>{f.artifacts.artifacts.push({...f.artifacts.artifacts[0],name:'nora-tavern-darwin-arm64'});f.artifacts.total_count++;}],
 ['duplicate artifact name',f=>f.artifacts.artifacts[1].name=f.artifacts.artifacts[0].name],['duplicate artifact ID',f=>f.artifacts.artifacts[1].id=1],
 ['expired artifact',f=>f.artifacts.artifacts[0].expired=true],['empty artifact',f=>f.artifacts.artifacts[0].size_in_bytes=0],['missing API digest',f=>delete f.artifacts.artifacts[0].digest],
 ['other artifact run',f=>f.artifacts.artifacts[0].workflow_run.id=124],['other artifact SHA',f=>f.artifacts.artifacts[0].workflow_run.head_sha='b'.repeat(40)],
 ['fork artifact',f=>f.artifacts.artifacts[0].workflow_run.head_repository_id=43],['incomplete jobs page',f=>f.jobs.total_count++],
 ['wrong native job SHA',f=>f.jobs.jobs[0].head_sha='b'.repeat(40)],['failed native job',f=>f.jobs.jobs[0].conclusion='failure'],
 ['skipped Setup gate',f=>f.jobs.jobs[0].steps.find(step=>step.name==='Test the actual Windows setup and installed application').conclusion='skipped'],
 ['missing historical gate',f=>f.jobs.jobs[0].steps=f.jobs.jobs[0].steps.filter(step=>!step.name.startsWith('Freeze verified historical'))],
 ['masked failed step',f=>f.jobs.jobs[0].steps.push({name:'extra contract',conclusion:'failure'})],
])test(`rejects ${label}`,()=>{const f=sourceFixture();change(f);assert.throws(()=>verifySource(f.run,f.artifacts,f.jobs,f.options));});
function modeFixture() {return {GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF_TYPE:'branch',GITHUB_RUN_ID:'124',NORA_BUILD_TARGET:'all',NORA_PUBLISH_SOURCE_RUN:'',NORA_LAUNCHER_BASELINE_TAG:'',NORA_PRODUCTION_MODE:'true',NORA_VERIFIED_WINDOWS_RUN:'123'};}
test('final assembly requires all-platform mode and an independent source run',()=>{verifyModes(modeFixture());});
for(const [label,field,value] of [['Windows-only reuse','NORA_BUILD_TARGET','win32-x64'],['Intel-only reuse','NORA_BUILD_TARGET','darwin-x64'],['ARM-only reuse','NORA_BUILD_TARGET','darwin-arm64'],['bootstrap reuse','NORA_BUILD_TARGET','win32-bootstrap'],['publish-source conflict','NORA_PUBLISH_SOURCE_RUN','125'],['baseline conflict','NORA_LAUNCHER_BASELINE_TAG','v2.4.2'],['candidate branch','NORA_PRODUCTION_MODE','false'],['self-reuse','NORA_VERIFIED_WINDOWS_RUN','124'],['invalid source ID','NORA_VERIFIED_WINDOWS_RUN','123;echo bad']])test(`rejects ${label}`,()=>{const env=modeFixture();env[field]=value;assert.throws(()=>verifyModes(env));});
function packageFixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-win-reuse-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const delivery=path.join(root,'delivery'),acceptance=path.join(root,'acceptance');fs.mkdirSync(delivery);fs.mkdirSync(acceptance);
 const write=(directory,name,value)=>{const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));return file;};
 const payload={commit,candidate:false,dirty:false,versions:{tavern:'2.4.3'},hermesRuntime:{sha256:sha('runtime')},artifacts:{'ops/installer/desktop/operation-delegate.js':sha('actor')}};
 const payloadFile=write(delivery,'win32-x64-release-manifest.json',payload),payloadHash=sha(fs.readFileSync(payloadFile));
 const system={schema:'nora-system/v1',commit,candidate:false,channel:'stable',platform:'win32',arch:'x64',version:'2.4.3',launcherVersion:'2.1.0',files:{'release-manifest.json':{asset:path.basename(payloadFile),size:fs.statSync(payloadFile).size,sha256:payloadHash}}};
 const systemFile=write(delivery,'nora-system-win32-x64.json',system),systemHash=sha(fs.readFileSync(systemFile));
 write(delivery,'update.zip','original update');write(delivery,'nora-launcher-win32-x64.json',{commit,candidate:false,platform:'win32',arch:'x64',version:'2.1.0',asset:'update.zip',size:15,sha256:sha('original update')});
 write(delivery,'Nora-Tavern-package-verification-win32-x64.json',{commit,version:'2.4.3',nativeIcon:true});
 const installer='Nora-Tavern-2.4.3-win-x64-setup.exe';write(delivery,installer,'original setup');
 write(acceptance,'nora-installed-setup-acceptance.json',{schema:'nora-installed-setup/1',exitCode:0,autoLaunch:false,verifiedUnpackedFiles:3,installer,installerSha256:sha('original setup')});
 const app={schema:'nora-app-candidate-gate/1',platform:'win32',arch:'x64',identity:null,payloadManifestSha256:systemHash,assertions:Object.fromEntries(['actualElectron','nativeDependencyComplete','allFlatResourceHashesMatchCandidate','jsPythonReceiptAgree','arbitraryCliRefusedBeforeOperation'].map(name=>[name,true]))};
 write(acceptance,'nora-packaged-app-acceptance.json',app);write(acceptance,'nora-installed-app-acceptance.json',app);
 const baseline={schema:'nora-upgrade-baseline/1',acceptance:'version-transition-required',platform:'win32-x64',targetCommit:commit,targetVersion:'2.4.3',targetManifestSha256:payloadHash,baselineVersion:'2.4.2'};write(acceptance,'nora-upgrade-baseline-acceptance.json',baseline);
 const harness={schema:'nora-launcher-products-smoke/1',outcome:'passed',platform:'win32',arch:'x64',executorHandles:'verified-closed',runtime:'verified',runtimeSha256:sha('runtime'),operation:'verified',stop:'verified',firstInstall:'verified',http:'verified',hermesSkills:'verified',mcp:'verified',modelConfiguration:'verified-local-A-to-B-model-requests',userConfigurationDigest:sha('preferences'),actorSourceFiles:{'desktop/operation-delegate.js':sha('actor')},actorSourceBinding:'verified-selected-candidate-manifest',userData:'retained',releaseManifestSha256:payloadHash};
 write(acceptance,'fresh/harness-result.json',{...harness,committedFirstInstall:'verified-real-resume-without-reinstall',missingSystemReceipt:'verified-bound-repair-and-preserved-user-data',releaseAcceptance:'isolated-same-version-repair',update:'verified-noop'});write(acceptance,'runtime/harness-result.json',{...harness,releaseManifestSha256:null,stop:'no-service-started'});
 for(const state of ['running','stopped'])write(acceptance,`upgrade-${state}/harness-result.json`,{...harness,versionTransition:{...baseline,startState:state},actorSourceBinding:'verified-selected-candidate-manifest',releaseAcceptance:'isolated-version-transition',update:'verified-content-transition',changedSourceArtifacts:1,userData:'retained',updateInitialService:state});
 return {root,delivery,acceptance,write};
}
test('native APP identity=null is bound to exact descriptor bytes and historical target source',async t=>{const f=packageFixture(t);const inventory=await verifyPackage(f.delivery,f.acceptance,commit);assert.equal(inventory['Nora-Tavern-2.4.3-win-x64-setup.exe'].sha256,sha('original setup'));});
for(const [label,file,change] of [
 ['changed installer','Nora-Tavern-2.4.3-win-x64-setup.exe',null],
 ['installed APP from another payload','nora-installed-app-acceptance.json',v=>v.payloadManifestSha256='b'.repeat(64)],
 ['unpacked APP from another platform','nora-packaged-app-acceptance.json',v=>v.arch='arm64'],
 ['false native APP assertion','nora-installed-app-acceptance.json',v=>v.assertions.jsPythonReceiptAgree=false],
 ['Setup autolaunch','nora-installed-setup-acceptance.json',v=>v.autoLaunch=true],
 ['wrong historical commit','nora-upgrade-baseline-acceptance.json',v=>v.targetCommit='b'.repeat(40)],
 ['wrong historical manifest','upgrade-running/harness-result.json',v=>v.releaseManifestSha256='b'.repeat(64)],
 ['wrong actor source','upgrade-stopped/harness-result.json',v=>v.actorSourceFiles['desktop/operation-delegate.js']='b'.repeat(64)],
 ['failed historical update','upgrade-stopped/harness-result.json',v=>v.outcome='failed'],
 ['unclosed runtime handles','runtime/harness-result.json',v=>v.executorHandles='unconfirmed'],
 ['missing fresh resume proof','fresh/harness-result.json',v=>delete v.committedFirstInstall],
 ['changed user preferences','upgrade-running/harness-result.json',v=>v.userConfigurationDigest='b'.repeat(64)],
 ['copied same-version proof in historical report','upgrade-stopped/harness-result.json',v=>v.releaseAcceptance='isolated-same-version-repair'],
])test(`rejects ${label} before reupload`,async t=>{const f=packageFixture(t);if(!change)f.write(f.delivery,file,'changed setup');else{const p=path.join(f.acceptance,file),value=JSON.parse(fs.readFileSync(p));change(value);f.write(f.acceptance,file,value);}await assert.rejects(verifyPackage(f.delivery,f.acceptance,commit));});
test('archive digest mismatch fails rather than being a download warning',async t=>{const f=packageFixture(t),file=f.write(f.root,'raw.zip','raw zip');await assert.rejects(verifyArchive(file,{size_in_bytes:7,digest:'sha256:'+sha('other')}),/digest differs/);await assert.rejects(verifyArchive(file,{size_in_bytes:8,digest:'sha256:'+sha('raw zip')}),/size differs/);await verifyArchive(file,{size_in_bytes:7,digest:'sha256:'+sha('raw zip')});});
test('safe extraction rejects path traversal, duplicate case-folded names and symbolic or special entries',t=>{
 const f=packageFixture(t),python=process.env.NORA_TEST_PYTHON||process.env.NORA_PYTHON||(process.platform==='win32'?'python':'python3');
 for(const kind of ['traversal','duplicate','symlink','fifo','windows-absolute']) {
  const archive=path.join(f.root,kind+'.zip');execFileSync(python,['-B','-c',`import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n if sys.argv[2]=='traversal': z.writestr('../escape','bad')\n elif sys.argv[2]=='windows-absolute': z.writestr('C:/escape','bad')\n elif sys.argv[2]=='duplicate': z.writestr('file','a');z.writestr('FILE','b')\n else:\n  i=zipfile.ZipInfo('link');i.external_attr=(0o010777 if sys.argv[2]=='fifo' else 0o120777)<<16;z.writestr(i,'target')\n`,archive,kind]);
  assert.throws(()=>execFileSync(python,['-B','-c',extractScript,archive,path.join(f.root,kind)],{stdio:'pipe'}));
 }assert.equal(fs.existsSync(path.join(f.root,'escape')),false);
});
const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/build-integrated-launcher.yml'),'utf8');
function condition(job) {return workflow.match(new RegExp(`^  ${job}:\\n(?:[^\\n]*\\n)*?    if: ([^\\n]+)`,'m'))[1];}
function evaluate(expression,inputs,github,needs={},cancelled=false) {return Function('inputs','github','needs','always','cancelled','startsWith','return '+expression.replaceAll('needs.reuse-windows','needs["reuse-windows"]'))(inputs,github,needs,()=>true,()=>cancelled,(a,b)=>a.startsWith(b));}
const buildWorkflow=workflow.split('\n  build:\n')[1].split(/\n  [\w-]+:\n/)[0];
const matrixExpression=buildWorkflow.match(/\$\{\{ fromJSON\(([\s\S]*?)\) \}\}/)[1];
test('actual build workflow routes package diagnostics independently, gates native work and never publishes',()=>{
 assert.match(condition('build'),/always\(\)/);assert.match(workflow,/  build:\n    needs: \[preflight, reuse-windows\]/);
 assert.doesNotMatch(workflow,/^  (?:bootstrap-contract|replacement-contract|gui-exit-contract|publish-release):/m);
 const tuples={
  'darwin-arm64':{runner:'macos-15',platform:'darwin',arch:'arm64',package_script:'pack:mac:arm64'},
  'darwin-x64':{runner:'macos-15-intel',platform:'darwin',arch:'x64',package_script:'pack:mac:x64'},
  'win32-x64':{runner:'windows-latest',platform:'win32',arch:'x64',package_script:'pack:win:x64'},
 },all=['darwin-arm64','darwin-x64','win32-x64'],macs=['darwin-arm64','darwin-x64'];
 for(const [target,reuse,packageSource,ref,expectedBuild,expectedTargets] of [
  ['all','','','branch',true,all],['win32-x64','','','branch',true,['win32-x64']],
  ['darwin-x64','','','branch',true,['darwin-x64']],['darwin-arm64','','','branch',true,['darwin-arm64']],
  ['darwin-x64','','','tag',true,['darwin-x64']],['darwin-arm64','','','tag',true,['darwin-arm64']],
  ['all','','','tag',true,all],['all','123','','branch',true,macs],['all','123','','tag',true,macs],
  ['win32-package-check','','123','branch',false,all],['all','','123','branch',false,all],
  ['win32-x64','','123','branch',false,['win32-x64']],['all','123','125','tag',false,macs],
  ['darwin-x64','','123','branch',false,['darwin-x64']],['darwin-arm64','','123','branch',false,['darwin-arm64']],
  ['unknown-target','','','branch',false,all],
 ]) {
  const inputs={target,verified_windows_run:reuse,package_source_run:packageSource},github={event_name:'workflow_dispatch',ref_type:ref},needs={preflight:{result:'success'},'reuse-windows':{result:reuse&&!packageSource?'success':'skipped'}};
  assert.equal(Boolean(evaluate(condition('package-check'),inputs,github,needs)),target==='win32-package-check'||packageSource!=='');
  assert.equal(Boolean(evaluate(condition('reuse-windows'),inputs,github,needs)),reuse!==''&&packageSource==='');
  assert.equal(Boolean(evaluate(condition('build'),inputs,github,needs)),expectedBuild);
  assert.deepEqual(JSON.parse(evaluate(matrixExpression,inputs,github)),expectedTargets.map(target=>tuples[target]));
  for(const result of ['failure','cancelled']) {needs.preflight.result=result;assert.equal(Boolean(evaluate(condition('build'),inputs,github,needs)),false);}
  needs.preflight.result='success';assert.equal(Boolean(evaluate(condition('build'),inputs,github,needs,true)),false);
 }
 for(const target of ['all','win32-x64','darwin-x64','darwin-arm64']) {
  const inputs={target,verified_windows_run:'123',package_source_run:''},github={event_name:'workflow_dispatch',ref_type:'branch'};
  for(const result of ['failure','cancelled']) {
   const needs={preflight:{result:'success'},'reuse-windows':{result}};
   assert.equal(Boolean(evaluate(condition('build'),inputs,github,needs)),false);
  }
 }
 const betaInputs={target:'',verified_windows_run:'',package_source_run:''},beta={event_name:'push',ref_type:'tag'},needs={preflight:{result:'success'},'reuse-windows':{result:'skipped'}};
 assert.equal(Boolean(evaluate(condition('build'),betaInputs,beta,needs)),true);
 assert.deepEqual(JSON.parse(evaluate(matrixExpression,betaInputs,beta)),all.map(target=>tuples[target]));
});

// Pure stream/process seams: no gh, APP, native actor or public request is executed.
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const fixtureSetTimeout=setTimeout,fixtureClearTimeout=clearTimeout;
function downloadFixture(t,mode){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-held-download-fake-')),outputs=[];
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const child=new EventEmitter();child.pid=4242;child.stdout=new PassThrough();child.exitCode=null;child.signalCode=null;
 const signals=[];let startedResolve,termResolve,createdResolve,closed=false;
 const started=new Promise(resolve=>{startedResolve=resolve;}),terminated=new Promise(resolve=>{termResolve=resolve;}),created=new Promise(resolve=>{createdResolve=resolve;});
 const finish=(code,signal)=>{if(closed)return;closed=true;child.stdout.end();child.emit('close',code,signal);};
 child.kill=signal=>{signals.push(signal);if(signal==='SIGTERM')termResolve();
  if(signal==='SIGKILL'&&mode!=='unclosed')queueMicrotask(()=>finish(null,'SIGKILL'));return true;};
 const spawnProcess=(command,args,options)=>{
  assert.equal(command,'gh');assert.deepEqual(args,['api','repos/owner/repo/actions/artifacts/1/zip']);assert.equal(options.env.FIXTURE,'only');
  // Product listeners are installed before this explicit fake-child ACK.
  queueMicrotask(()=>{if(mode==='spawn-error')child.emit('error',Object.assign(Error('spawn failed'),{code:'ENOENT'}));
   else if(mode==='success')child.stdout.end('ready');
   else{child.stdout.write('ready');if(mode==='pipes-after-close'){closed=true;child.emit('close',0,null);}}
   startedResolve();});return child;
 };
 t.after(async()=>{
  let deadline;
  try{
   child.stdout.destroy();finish(null,'SIGKILL');
   for(const output of outputs)if(!output.didClose)output.stream.destroy();
   await Promise.race([Promise.all(outputs.map(output=>output.closed)),new Promise((_,reject)=>{
    deadline=fixtureSetTimeout(()=>reject(Object.assign(Error('Fixture output closure unconfirmed; retain '+root),{fixtureRoot:root})),2000);
   })]);
   assert.equal(closed,true);assert.ok(outputs.every(output=>output.didClose));
   fs.rmSync(root,{recursive:true,force:true});
  }finally{fixtureClearTimeout(deadline);}
 });
 return {root,archive:path.join(root,'archive.zip'),child,signals,spawnProcess,started,terminated,created,finish,
  download:(...args)=>{const original=fs.createWriteStream;fs.createWriteStream=function(file,...options){const stream=original.call(this,file,...options);if(file===args[2]){
    const output={stream,didClose:false};output.closed=new Promise(resolve=>stream.once('close',()=>{output.didClose=true;resolve();}));outputs.push(output);
    stream.once('open',()=>createdResolve(true));stream.once('error',()=>createdResolve(false));
   }return stream;};
   try{return downloadArchive(...args);}finally{fs.createWriteStream=original;}},
  tick:ms=>t.mock.timers.tick(ms)};
}
const downloadPolicy=f=>({env:{FIXTURE:'only'},timeout:35,idleTimeout:100,killGrace:5,closeTimeout:45,spawnProcess:f.spawnProcess});
test('success waits held close and preserves the independent exact digest gate',{timeout:5000},async t=>{
 const f=downloadFixture(t,'success'),original=fs.createWriteStream;let output,outputClosed,settled=false,pending;
 fs.createWriteStream=function(file,...args){const stream=original.call(this,file,...args);if(file===f.archive){output=stream;outputClosed=new Promise(resolve=>stream.once('close',resolve));}return stream;};
 try{pending=f.download({id:1,name:'fixture'},'owner/repo',f.archive,downloadPolicy(f));pending.then(()=>{settled=true;},()=>{settled=true;});}
 finally{fs.createWriteStream=original;}
 await f.started;await outputClosed;assert.equal(output.writableFinished,true);assert.equal(settled,false,'real file completion must still wait for the held child close');
 assert.deepEqual(f.signals,[]);f.finish(0,null);assert.deepEqual(await pending,{code:0,signal:null});
 const digest=sha('ready');await verifyArchive(f.archive,{size_in_bytes:5,digest:'sha256:'+digest});
 await assert.rejects(verifyArchive(f.archive,{size_in_bytes:5,digest:'sha256:'+'a'.repeat(64)}),/digest/);assert.deepEqual(f.signals,[]);
});
for(const mode of ['total','idle'])test(mode+' timeout escalates and awaits the held fake close',{timeout:5000},async t=>{
 const f=downloadFixture(t,mode),options=downloadPolicy(f);if(mode==='idle'){options.timeout=100;options.idleTimeout=10;}
 const pending=assert.rejects(f.download({id:1,name:'fixture'},'owner/repo',f.archive,options),e=>e.code==='ETIMEDOUT'&&e.closeConfirmed===true&&e.childClose.signal==='SIGKILL');
 await f.started;assert.equal(await f.created,true);
 if(mode==='total'){for(let n=0;n<3;n++){f.tick(10);f.child.stdout.write('x');}f.tick(4);assert.deepEqual(f.signals,[]);f.tick(1);}
 else{f.tick(9);assert.deepEqual(f.signals,[]);f.tick(1);}
 await f.terminated;assert.deepEqual(f.signals,['SIGTERM']);f.tick(4);assert.deepEqual(f.signals,['SIGTERM']);f.tick(1);
 await pending;assert.deepEqual(f.signals,['SIGTERM','SIGKILL']);assert.equal(fs.existsSync(f.archive),true);
});
test('pipeline failure retains primary EEXIST and waits held fake close',{timeout:5000},async t=>{
 const f=downloadFixture(t,'idle');fs.writeFileSync(f.archive,'original');
 const pending=assert.rejects(f.download({id:1,name:'fixture'},'owner/repo',f.archive,downloadPolicy(f)),e=>e.code==='EEXIST'&&e.closeConfirmed===true);
 await f.terminated;f.tick(5);await pending;assert.deepEqual(f.signals,['SIGTERM','SIGKILL']);assert.equal(fs.readFileSync(f.archive,'utf8'),'original');
});
test('spawn error retains its original failure and still awaits close',{timeout:5000},async t=>{
 const f=downloadFixture(t,'spawn-error');let settled=false;
 const pending=assert.rejects(f.download({id:1,name:'fixture'},'owner/repo',f.archive,downloadPolicy(f)),e=>e.code==='ENOENT'&&e.closeConfirmed===true);
 pending.then(()=>{settled=true;},()=>{settled=true;});await f.terminated;assert.equal(settled,false);f.finish(null,null);await pending;
});
test('unconfirmed close is finite and is reported pending without deleting output',{timeout:5000},async t=>{
 const f=downloadFixture(t,'unclosed'),began=Date.now();
 const pending=assert.rejects(f.download({id:1,name:'fixture'},'owner/repo',f.archive,downloadPolicy(f)),e=>e.closeConfirmed===false&&e.childClose===null&&e.preserveArchive===true&&/unconfirmed/.test(e.cleanupFailure));
 await f.started;assert.equal(await f.created,true);f.tick(35);await f.terminated;f.tick(5);assert.deepEqual(f.signals,['SIGTERM','SIGKILL']);f.tick(40);await pending;
 assert.ok(Date.now()-began<500);assert.equal(fs.existsSync(f.archive),true);
});
test('exit with an open pipe is bounded without killing an already closed child',{timeout:5000},async t=>{
 const f=downloadFixture(t,'pipes-after-close');const pending=assert.rejects(f.download({id:1,name:'fixture'},'owner/repo',f.archive,downloadPolicy(f)),e=>e.code==='ETIMEDOUT'&&e.closeConfirmed===true);
 await f.started;assert.equal(await f.created,true);f.tick(35);await pending;assert.deepEqual(f.signals,[]);
});
