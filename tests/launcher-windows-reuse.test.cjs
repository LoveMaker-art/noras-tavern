const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {verifyModes,verifySource,verifyArchive,verifyPackage,requiredSteps,extractScript}=require('../tooling/release/reuse-windows-build.cjs');
const {execFileSync}=require('node:child_process');
const commit='a'.repeat(40),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function sourceFixture() {
 const run={id:123,head_sha:commit,repository:{id:42,full_name:'owner/tavern'},path:'.github/workflows/build-integrated-launcher.yml',event:'workflow_dispatch',status:'completed',conclusion:'success'};
 const artifacts={total_count:2,artifacts:['nora-tavern-win32-x64','nora-operation-acceptance-win32-x64'].map((name,index)=>({id:index+1,name,expired:false,size_in_bytes:1,digest:'sha256:'+sha('x'),workflow_run:{id:123,head_sha:commit,repository_id:42,head_repository_id:42}}))};
 const jobs={total_count:1,jobs:[{name:'build (windows-latest, win32, x64, pack:win:x64)',run_id:123,head_sha:commit,status:'completed',conclusion:'success',steps:requiredSteps.map(name=>({name,status:'completed',conclusion:'success'}))}]};
 return {run,artifacts,jobs,options:{commit,repository:'owner/tavern',runId:'123'}};
}
test('only a complete same-commit native Windows-only source can be reused',()=>{const f=sourceFixture();assert.equal(verifySource(f.run,f.artifacts,f.jobs,f.options).length,2);});
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
for(const [label,field,value] of [['Windows-only reuse','NORA_BUILD_TARGET','win32-x64'],['bootstrap reuse','NORA_BUILD_TARGET','win32-bootstrap'],['publish-source conflict','NORA_PUBLISH_SOURCE_RUN','125'],['baseline conflict','NORA_LAUNCHER_BASELINE_TAG','v2.4.2'],['candidate branch','NORA_PRODUCTION_MODE','false'],['self-reuse','NORA_VERIFIED_WINDOWS_RUN','124'],['invalid source ID','NORA_VERIFIED_WINDOWS_RUN','123;echo bad']])test(`rejects ${label}`,()=>{const env=modeFixture();env[field]=value;assert.throws(()=>verifyModes(env));});
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
 const f=packageFixture(t);
 for(const kind of ['traversal','duplicate','symlink','fifo','windows-absolute']) {
  const archive=path.join(f.root,kind+'.zip');execFileSync('python3',['-c',`import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n if sys.argv[2]=='traversal': z.writestr('../escape','bad')\n elif sys.argv[2]=='windows-absolute': z.writestr('C:/escape','bad')\n elif sys.argv[2]=='duplicate': z.writestr('file','a');z.writestr('FILE','b')\n else:\n  i=zipfile.ZipInfo('link');i.external_attr=(0o010777 if sys.argv[2]=='fifo' else 0o120777)<<16;z.writestr(i,'target')\n`,archive,kind]);
  assert.throws(()=>execFileSync('python3',['-c',extractScript,archive,path.join(f.root,kind)],{stdio:'pipe'}));
 }assert.equal(fs.existsSync(path.join(f.root,'escape')),false);
});
const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/build-integrated-launcher.yml'),'utf8');
function condition(job) {return workflow.match(new RegExp(`^  ${job}:\\n(?:[^\\n]*\\n)*?    if: ([^\\n]+)`,'m'))[1];}
function evaluate(expression,inputs,github,needs={},cancelled=false) {return Function('inputs','github','needs','always','cancelled','startsWith','return '+expression.replaceAll('needs.reuse-windows','needs["reuse-windows"]'))(inputs,github,needs,()=>true,()=>cancelled,(a,b)=>a.startsWith(b));}
const matrixExpression=workflow.match(/\$\{\{ fromJSON\(([\s\S]*?)\) \}\}/)[1];
test('actual workflow conditions preserve default and publish-only paths and block failed reuse',()=>{
 assert.match(condition('build'),/always\(\)/);assert.match(workflow,/  build:\n    needs: reuse-windows/);assert.match(workflow,/    needs: \[build, reuse-windows\]/);
 for(const [target,reuse,publish,ref,expectedBuild,count,expectedPublish] of [
  ['all','','','branch',true,3,false],['win32-x64','','','branch',true,1,false],['win32-bootstrap','','','branch',false,3,false],['win32-replacement','','','branch',false,3,false],
  ['all','','','tag',true,3,true],['all','','123','tag',false,3,true],['all','123','','branch',true,2,false],['all','123','','tag',true,2,true],
 ]) {
  const inputs={target,verified_windows_run:reuse,publish_source_run:publish},github={event_name:'workflow_dispatch',ref_type:ref,ref_name:ref==='tag'?'v2.4.3':'branch'},needs={'reuse-windows':{result:reuse?'success':'skipped'},build:{result:expectedBuild?'success':'skipped'}};
  assert.equal(Boolean(evaluate(condition('replacement-contract'),inputs,github,needs)),target==='win32-replacement');
  assert.equal(Boolean(evaluate(condition('bootstrap-contract'),inputs,github,needs)),target==='win32-bootstrap');
  assert.equal(Boolean(evaluate(condition('build'),inputs,github,needs)),expectedBuild);assert.equal(JSON.parse(evaluate(matrixExpression,inputs,github)).length,count);assert.equal(Boolean(evaluate(condition('publish-release'),inputs,github,needs)),expectedPublish);
  for(const result of ['failure','cancelled']) {needs['reuse-windows'].result=result;assert.equal(Boolean(evaluate(condition('build'),inputs,github,needs)),false);assert.equal(Boolean(evaluate(condition('publish-release'),inputs,github,needs)),false);}
  needs['reuse-windows'].result=reuse?'success':'skipped';assert.equal(Boolean(evaluate(condition('build'),inputs,github,needs,true)),false);assert.equal(Boolean(evaluate(condition('publish-release'),inputs,github,needs,true)),false);
 }
});
