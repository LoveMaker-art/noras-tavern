const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {test}=require('node:test');
const stage=require('../tooling/release/build-stage.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-stage-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const root=path.join(home,'source'),temp=path.join(home,'temp');fs.mkdirSync(root);fs.mkdirSync(temp);
 const expected={repository:'owner/repo',commit:'a'.repeat(40),runId:7,attempt:2,platform:'win32-x64',baseline:'EMPTY',options:{},environment:{imageOS:'win22',imageVersion:'1',node:'v24',python:'3.11',platform:'win32-x64'}};
 return {home,root,temp,expected};}
function job(f,s='source'){return {id:20,run_id:7,run_attempt:2,head_sha:f.expected.commit,name:stage.jobName(s,f.expected.platform),status:'completed',conclusion:'success',
 steps:[...stage.required[s],...(s==='package'?['Test Windows installation and managed update with legacy path limits']:[])].map(name=>({name,status:'completed',conclusion:'success'}))};}
function receipt(f,s='source'){return {schema:'nora-build-stage/1',stage:s,context:structuredClone(f.expected),inputs:stage.stages.slice(0,stage.stages.indexOf(s)).map(stage=>({stage})),archive:{size:10240,sha256:'b'.repeat(64)}};}
test('stage identity rejects another commit, platform, run, inputs, image, interpreter and future attempt',t=>{
 const f=fixture(t);stage.verifyContext(receipt(f),f.expected,'source');
 for(const [key,value] of [['commit','c'.repeat(40)],['platform','darwin-x64'],['runId',8],['repository','fork/repo'],['baseline','v0.1.0'],['attempt',3],['options',{app_only:true}],
  ...['node','python','imageVersion'].map(key=>['environment',{...f.expected.environment,[key]:'changed'}])]){
  const r=receipt(f);r.context[key]=value;assert.throws(()=>stage.verifyContext(r,f.expected,'source'));}
 const partial=receipt(f,'package');partial.inputs.pop();assert.throws(()=>stage.verifyContext(partial,f.expected,'package'));
});
test('an artifact name or same commit alone cannot replace repository, digest, freshness and run binding',t=>{
 const f=fixture(t),item={id:3,name:stage.name('source',f.expected.platform),expired:false,size_in_bytes:10,digest:'sha256:'+'b'.repeat(64),workflow_run:{id:7,head_sha:f.expected.commit,repository_id:9,head_repository_id:9}};
 stage.verifyArtifact(item,f.expected,'source',9);
 for(const change of [x=>x.expired=true,x=>delete x.digest,x=>x.workflow_run.head_repository_id=10,x=>x.workflow_run.id=8,x=>x.name='nora-stage-source-darwin-x64']){
  const bad=structuredClone(item);change(bad);assert.throws(()=>stage.verifyArtifact(bad,f.expected,'source',9));}
});
test('only a complete successful producer and all mandatory gates can be reused',t=>{
 const f=fixture(t);for(const s of stage.stages){stage.verifyJob(job(f,s),f.expected,s);
  for(const change of [j=>j.conclusion='failure',j=>j.conclusion='cancelled',j=>j.steps.pop(),j=>j.steps[0].conclusion='skipped',j=>j.steps.push({...j.steps[0]})]){
   const j=job(f,s);change(j);assert.throws(()=>stage.verifyJob(j,f.expected,s));}}
 const r=receipt(f);assert.throws(()=>stage.producerJobs(r,f.expected,()=>({total_count:1,jobs:[{...job(f),run_attempt:1}]})),/attempt/);
});
async function bundle(f,s,t){
 const output=path.join(f.home,'bundle-'+s);const r=await stage.seal(s,output,f);
 const zip=path.join(f.home,s+'.zip');execFileSync(process.env.NORA_STAGE_TEST_PYTHON||'python3',['-I','-B','-c',
  'import pathlib,zipfile,sys\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for f in p.iterdir():z.write(f,f.name)',output,zip]);
 const item={id:3+stage.stages.indexOf(s),name:stage.name(s,f.expected.platform),expired:false,size_in_bytes:fs.statSync(zip).size,digest:'sha256:'+hash(fs.readFileSync(zip)),workflow_run:{id:7,head_sha:f.expected.commit,repository_id:9,head_repository_id:9}};
 return {r,item,zip};
}
function transport(f,b,s){return {query:endpoint=>endpoint.includes('/attempts/')?{total_count:1,jobs:[job(f,s)]}:{id:7,head_sha:f.expected.commit,repository:{id:9,full_name:'owner/repo'},head_repository:{id:9},path:'.github/workflows/build-integrated-launcher.yml'},
 pages:()=>[{artifacts:[b.item]}],download:async(_item,_repo,file)=>fs.copyFileSync(b.zip,file)};}
test('a new machine restores the passed source group without re-executing its tests; altered ZIP is rejected first',async t=>{
 const f=fixture(t),impact={schema:'nora-test-impact/1',source:{commit:f.expected.commit},planDigest:'a'.repeat(64),full:false,ui:true,content:false,tavern:false};
 fs.writeFileSync(path.join(f.temp,'test-impact.json'),JSON.stringify(impact));const b=await bundle(f,'source',t);
 const temp=path.join(f.home,'new-machine');fs.mkdirSync(temp);
 await stage.restore('source',{...f,temp,...transport(f,b,'source')});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp,'test-impact.json'))),impact);
 const other=path.join(f.home,'altered');fs.mkdirSync(other);
 await assert.rejects(stage.restore('source',{...f,temp:other,...transport(f,b,'source'),download:async(_a,_r,file)=>fs.writeFileSync(file,'altered')}),/size|digest/i);
 assert.equal(fs.existsSync(path.join(other,'test-impact.json')),false);
});
test('package checkpoints preserve executable modes and framework links, exclude builder dependencies and reject changed upstream artifacts',async t=>{
 const f=fixture(t),release=path.join(f.root,'release/stable-test/nora-tavern-launcher/desktop');fs.mkdirSync(path.join(release,'dist'),{recursive:true});fs.mkdirSync(path.join(release,'node_modules'));
 fs.writeFileSync(path.join(release,'dist/Nora-Tavern-fixture.exe'),'pkg');
 fs.writeFileSync(path.join(release,'dist/app'),'exact bytes',{mode:0o755});fs.symlinkSync('app',path.join(release,'dist/current'));
 fs.writeFileSync(path.join(release,'node_modules/private-builder'),'not shipped');
 const template='app-builder-lib/templates/nsis/installSection.nsh';
 fs.mkdirSync(path.dirname(path.join(release,'node_modules',template)),{recursive:true});
 fs.writeFileSync(path.join(release,'node_modules',template),'exact pinned installer template');
 for(const s of ['source','runtime'])fs.writeFileSync(path.join(f.temp,`nora-stage-input-${s}.json`),JSON.stringify({artifact:{id:s==='source'?3:4,digest:'sha256:'+'a'.repeat(64)}}));
 const b=await bundle(f,'package',t),root=path.join(f.home,'target'),temp=path.join(f.home,'target-temp');fs.mkdirSync(root);fs.mkdirSync(temp);
 for(const s of ['source','runtime'])fs.copyFileSync(path.join(f.temp,`nora-stage-input-${s}.json`),path.join(temp,`nora-stage-input-${s}.json`));
 await stage.restore('package',{...f,root,temp,...transport(f,b,'package')});
 const restored=path.join(root,'release/stable-test/nora-tavern-launcher/desktop');
 assert.equal(fs.readFileSync(path.join(restored,'dist/current'),'utf8'),'exact bytes');assert.equal(fs.lstatSync(path.join(restored,'dist/current')).isSymbolicLink(),true);
 assert.equal(fs.statSync(path.join(restored,'dist/app')).mode&0o777,0o755);
 assert.equal(fs.existsSync(path.join(restored,'node_modules/private-builder')),false);
 assert.ok(fs.readFileSync(path.join(__dirname,'../tooling/checks/launcher-installed-check.ps1'),'utf8').includes('node_modules/app-builder-lib/templates/nsis/installSection.nsh'));
 assert.equal(fs.readFileSync(path.join(restored,'node_modules',template),'utf8'),'exact pinned installer template','The actual final Windows setup gate needs its pinned NSIS template after restoration');
 const mismatch=path.join(f.home,'mismatch');fs.mkdirSync(mismatch);
 for(const s of ['source','runtime'])fs.writeFileSync(path.join(mismatch,`nora-stage-input-${s}.json`),JSON.stringify({artifact:{id:999,digest:'sha256:'+'a'.repeat(64)}}));
 await assert.rejects(stage.restore('package',{...f,temp:mismatch,...transport(f,b,'package')}),/Upstream stage changed/);
});

function chain(f,platform='win32-x64'){
 const run={id:7,run_attempt:3,head_sha:f.expected.commit,repository:{id:9,full_name:'owner/repo'},head_repository:{id:9},status:'completed',conclusion:'success'};
 const artifacts={artifacts:[]},jobs={jobs:[]},inputs=[];
 for(const [index,s] of stage.stages.entries()){
  const ctx={...structuredClone(f.expected),platform,attempt:index+1,environment:{...f.expected.environment,platform}};
  const r={...receipt(f,s),context:ctx,inputs:inputs.map(input=>({stage:input.stage,...input.artifact})),delivery:s==='package'?{'Nora-Tavern-fixture.exe':{size:3,sha256:hash('pkg')}}:null};
  const item={id:3+index,name:stage.name(s,platform),expired:false,size_in_bytes:20,digest:'sha256:'+'b'.repeat(64),workflow_run:{id:7,head_sha:f.expected.commit,repository_id:9,head_repository_id:9}};
  artifacts.artifacts.push(item);const nativeJob=job(f,s);if(s==='package'&&platform!=='win32-x64')nativeJob.steps.at(-1).name='Test real fresh installation and managed update before desktop packaging';jobs.jobs.push({...nativeJob,id:20+index,name:stage.jobName(s,platform),run_attempt:index+1});
  inputs.push({schema:'nora-stage-input/1',stage:s,artifact:{id:item.id,name:item.name,size:item.size_in_bytes,digest:item.digest},receipt:r,producer:{id:20+index,attempt:index+1}});
 }
 artifacts.total_count=artifacts.artifacts.length;jobs.total_count=jobs.jobs.length;return {run,artifacts,jobs,proof:{schema:'nora-build-stages/1',inputs}};
}
test('resumption preserves successful earlier attempts but never mixes upstream products or failed/missing evidence',t=>{
 const f=fixture(t),c=chain(f);assert.deepEqual(stage.verifyStageEvidence(c.proof,c.run,c.artifacts,c.jobs,'win32-x64'),c.proof.inputs[2].receipt.delivery);
 for(const mutate of [
  c=>c.proof.inputs[2].receipt.inputs[1].id=999,
  c=>c.proof.inputs[1].receipt.context.environment.node='v26',
  c=>c.jobs.jobs[0].steps[0].conclusion='skipped',
  c=>c.jobs.jobs[1].conclusion='failure',
  c=>c.artifacts.artifacts[0].expired=true,
  c=>c.proof.inputs[1].producer.id=999,
  c=>c.proof.inputs.pop(),
  c=>c.jobs.jobs.push({...c.jobs.jobs[0]}),
 ]){const bad=chain(f);mutate(bad);bad.jobs.total_count=bad.jobs.jobs.length;
  assert.throws(()=>stage.verifyStageEvidence(bad.proof,bad.run,bad.artifacts,bad.jobs,'win32-x64'));}
});
test('unsafe checkpoint paths and links cannot escape into another runner directory',t=>{
 const f=fixture(t),archive=path.join(f.home,'bad.tar'),spec=path.join(f.home,'spec.json');
 for(const [member,link] of [['workspace/.git/config',null],['workspace/release/link','../../../temporary/outside'],['temporary/../../escape',null]]){
  execFileSync(process.env.NORA_STAGE_TEST_PYTHON||'python3',['-I','-B','-c',
   'import tarfile,sys,io\nwith tarfile.open(sys.argv[1],"w") as t:\n m=tarfile.TarInfo(sys.argv[2]);m.size=0\n if sys.argv[3]:m.type=tarfile.SYMTYPE;m.linkname=sys.argv[3]\n t.addfile(m,io.BytesIO())',archive,member,link||'']);
  const scratch=path.join(f.home,'unsafe-'+Math.random());fs.writeFileSync(spec,JSON.stringify({roots:{workspace:f.root,temporary:f.temp},allowed:['workspace/release'],scratch}));
  assert.throws(()=>execFileSync(process.env.NORA_STAGE_TEST_PYTHON||'python3',['-I','-B','-c',stage.tarScript,'restore',archive,spec],{stdio:'pipe'}));
  assert.equal(fs.existsSync(path.join(f.root,'.git/config')),false);assert.equal(fs.existsSync(path.join(f.home,'escape')),false);
 }
});

test('failed final acceptance reuses the exact three successful phase archives on another machine, without resealing a product',async t=>{
 const f=fixture(t),bundles={};let builds=0;
 fs.writeFileSync(path.join(f.temp,'test-impact.json'),JSON.stringify({schema:'nora-test-impact/1',source:{commit:f.expected.commit},planDigest:'a'.repeat(64),full:true,ui:false,content:false,tavern:false}));
 fs.mkdirSync(path.join(f.temp,'hermes-runtime'));fs.writeFileSync(path.join(f.temp,'hermes-runtime/fixture'),'sealed environment fixture');
 fs.writeFileSync(path.join(f.temp,'nora-hermes-cold-init-acceptance.json'),'{}');
 const dist=path.join(f.root,'release/stable-fixture/nora-tavern-launcher/desktop/dist');fs.mkdirSync(dist,{recursive:true});fs.writeFileSync(path.join(dist,'Nora-Tavern-fixture.exe'),'pkg');
 for(const s of stage.stages){bundles[s]=await bundle(f,s,t);builds++;
  fs.writeFileSync(path.join(f.temp,`nora-stage-input-${s}.json`),JSON.stringify({artifact:{id:bundles[s].item.id,name:bundles[s].item.name,size:bundles[s].item.size_in_bytes,digest:bundles[s].item.digest}}));}
 for(const attempt of [2,3]){
  const root=path.join(f.home,'attempt-root-'+attempt),temp=path.join(f.home,'attempt-temp-'+attempt);fs.mkdirSync(root);fs.mkdirSync(temp);
  for(const s of stage.stages)await stage.restore(s,{...f,root,temp,expected:{...f.expected,attempt},...transport(f,bundles[s],s)});
  assert.equal(fs.readFileSync(path.join(root,'release/stable-fixture/nora-tavern-launcher/desktop/dist/Nora-Tavern-fixture.exe'),'utf8'),'pkg');
  if(attempt===2)assert.throws(()=>{throw Error('isolated final-acceptance fixture failed');});
  else assert.equal((await stage.provenance(temp,root)).inputs.length,3);
 }
 assert.equal(builds,3,'no upstream phase was built or resealed by either acceptance attempt');
});

test('publication requires all three platform stage chains and rejects changed delivered bytes or a failed source group',async t=>{
 const f=fixture(t),delivery=path.join(f.home,'delivery'),acceptance=path.join(f.home,'acceptance');fs.mkdirSync(delivery);fs.mkdirSync(acceptance);
 fs.writeFileSync(path.join(delivery,'Nora-Tavern-fixture.exe'),'pkg');
 const all={artifacts:[],jobs:[]};let run;
 for(const platform of stage.platforms){const c=chain(f,platform);run=c.run;
  // Platform archives have globally unique API identities.
  for(const input of c.proof.inputs){const old=input.artifact.id;input.artifact.id+=all.artifacts.length;
   c.artifacts.artifacts.find(item=>item.id===old).id=input.artifact.id;
   for(const other of c.proof.inputs)for(const dependency of other.receipt.inputs)if(dependency.stage===input.stage)dependency.id=input.artifact.id;}
  fs.writeFileSync(path.join(acceptance,platform+'-nora-build-stages.json'),JSON.stringify(c.proof));
  const folder=path.join(acceptance,platform);fs.mkdirSync(folder);fs.renameSync(path.join(acceptance,platform+'-nora-build-stages.json'),path.join(folder,'nora-build-stages.json'));
  const finalNames=['Verify stage provenance and unchanged product before delivery','Verify real APP production module closure and executor receipts','Verify packaged network modules in native Chromium',
   'Verify packaged Nora images and instructions','Preserve isolated operation acceptance evidence','Upload launcher',...(platform==='win32-x64'?['Test the actual Windows setup and installed application']:[])];
  c.jobs.jobs.push({id:30,run_id:7,head_sha:run.head_sha,run_attempt:3,name:stage.jobName('build',platform),status:'completed',conclusion:'success',steps:finalNames.map(name=>({name,status:'completed',conclusion:'success'}))});
  all.artifacts.push(...c.artifacts.artifacts);all.jobs.push(...c.jobs.jobs);
 }
 const artifacts={total_count:all.artifacts.length,artifacts:all.artifacts},jobs={total_count:all.jobs.length,jobs:all.jobs};
 const options={readJobs:()=>jobs,query:()=>assert.fail('same-run proof cannot read another run')};
 assert.equal((await stage.verifyPublishedStages(delivery,acceptance,run,artifacts,options)).mode,'staged');
 fs.writeFileSync(path.join(delivery,'Nora-Tavern-fixture.exe'),'bad');
 await assert.rejects(stage.verifyPublishedStages(delivery,acceptance,run,artifacts,options),/differs from package stage/);
 fs.writeFileSync(path.join(delivery,'Nora-Tavern-fixture.exe'),'pkg');all.jobs[0].steps[0].conclusion='skipped';
 await assert.rejects(stage.verifyPublishedStages(delivery,acceptance,run,artifacts,options),/Stage gate did not pass/);
 all.jobs[0].steps[0].conclusion='success';
 // Preserve the pre-existing narrow reuse path when the Windows producer ran
 // before this workflow split. It still needs all original native gates.
 fs.rmSync(path.join(acceptance,'win32-x64'),{recursive:true});
 const originalRun={...run,id:6,event:'workflow_dispatch',path:'.github/workflows/build-integrated-launcher.yml'};
 run.path=originalRun.path;
 const originalArtifacts={total_count:2,artifacts:['nora-tavern-win32-x64','nora-operation-acceptance-win32-x64'].map((name,index)=>({id:100+index,name,expired:false,size_in_bytes:20,digest:'sha256:'+'b'.repeat(64),workflow_run:{id:6,head_sha:run.head_sha,repository_id:9,head_repository_id:9}}))};
 const originalJobs={total_count:1,jobs:[{id:60,name:'build (windows-latest, win32, x64, pack:win:x64)',run_id:6,run_attempt:1,head_sha:run.head_sha,status:'completed',conclusion:'success',steps:require('../tooling/release/reuse-windows-build.cjs').requiredSteps.map(name=>({name,status:'completed',conclusion:'success'}))}]};
 const retained={schema:'nora-verified-windows-reuse/1',sourceRun:6,commit:run.head_sha,artifacts:originalArtifacts.artifacts.map(item=>({id:item.id,name:item.name,size:item.size_in_bytes,digest:item.digest})),files:{'Nora-Tavern-fixture.exe':{size:3,sha256:hash('pkg')}}};
 const retainedFile=path.join(acceptance,'nora-verified-windows-reuse.json');fs.writeFileSync(retainedFile,JSON.stringify(retained));
 const mixed={query:()=>originalRun,readJobs:(_repo,id)=>id===6?originalJobs:jobs,readArtifacts:()=>originalArtifacts};
 assert.equal((await stage.verifyPublishedStages(delivery,acceptance,run,artifacts,mixed)).mode,'staged');
 originalJobs.jobs[0].steps[0].conclusion='skipped';
 await assert.rejects(stage.verifyPublishedStages(delivery,acceptance,run,artifacts,mixed),/Native gate did not pass/);
 originalJobs.jobs[0].steps[0].conclusion='success';
 retained.files['Nora-Tavern-fixture.exe'].sha256=hash('bad');fs.writeFileSync(retainedFile,JSON.stringify(retained));
 await assert.rejects(stage.verifyPublishedStages(delivery,acceptance,run,artifacts,mixed),/Reused Windows product/);
 retained.files['Nora-Tavern-fixture.exe'].sha256=hash('pkg');fs.writeFileSync(retainedFile,JSON.stringify(retained));
 const stagedOriginal=chain(f,'win32-x64');
 for(const input of stagedOriginal.proof.inputs)input.receipt.context.runId=6;
 for(const item of stagedOriginal.artifacts.artifacts)item.workflow_run.id=6;
 for(const item of stagedOriginal.jobs.jobs)item.run_id=6;
 const finalOriginal={...originalJobs.jobs[0],name:stage.jobName('build','win32-x64'),run_attempt:3,
  steps:[...originalJobs.jobs[0].steps,{name:'Verify stage provenance and unchanged product before delivery',status:'completed',conclusion:'success'}]};
 originalJobs.jobs=[...stagedOriginal.jobs.jobs,finalOriginal];originalJobs.total_count=originalJobs.jobs.length;
 originalArtifacts.artifacts.push(...stagedOriginal.artifacts.artifacts);originalArtifacts.total_count=originalArtifacts.artifacts.length;
 await assert.rejects(stage.verifyPublishedStages(delivery,acceptance,run,artifacts,mixed),/Staged Windows source still requires/);
 fs.mkdirSync(path.join(acceptance,'win32-x64'));fs.writeFileSync(path.join(acceptance,'win32-x64/nora-build-stages.json'),JSON.stringify(stagedOriginal.proof));
 assert.equal((await stage.verifyPublishedStages(delivery,acceptance,run,artifacts,mixed)).mode,'staged');
});
