const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),{pipeline}=require('node:stream/promises');
const names=['nora-tavern-win32-x64','nora-operation-acceptance-win32-x64'];
const sourceStabilityNames=['darwin-arm64','darwin-x64','win32-x64'].flatMap(platform=>
 ['javascript','python'].map(group=>`nora-source-stability-${platform}-${group}`));
const otherPlatforms=new Map([
 ['darwin-arm64','build (macos-15, darwin, arm64, pack:mac:arm64)'],
 ['darwin-x64','build (macos-15-intel, darwin, x64, pack:mac:x64)'],
]);
const requiredSteps=['Require launcher source stability before preparing runtimes','Check release source contracts before preparing runtimes','Check installation source contracts before preparing runtimes',
 'Check presentation source contracts before preparing runtimes','Verify native launcher test prerequisites','Verify cold-profile bootstrap identity before preparing runtimes','Test release channels and update rollback',
 'Test installation diagnostics on the target platform',
 'Verify Windows runtime before long acceptance tests','Verify Windows owned model and profile fixtures before long tests',
 'Test operation ownership, evidence, bounded retry and recovery contracts','Require chat backup safety tests',
 'Test native transaction and complete evidence contracts','Test unified update and application replacement',
 'Test Nora initialization and profile synchronization','Freeze verified historical payload for version migration acceptance',
 'Test Windows installation and managed update with legacy path limits','Verify actual lightweight update archive',
 'Test the actual Windows setup and installed application','Verify real APP production module closure and executor receipts',
 'Verify packaged network modules in native Chromium',
 'Verify packaged Nora images and instructions','Upload launcher','Preserve isolated operation acceptance evidence'];
function verifyModes(env) {
 assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(env.NORA_BUILD_TARGET,'all');
 assert.equal(env.NORA_PUBLISH_SOURCE_RUN,'');assert.equal(env.NORA_LAUNCHER_BASELINE_TAG,'');
 assert.ok(env.GITHUB_REF_TYPE==='tag'||env.NORA_PRODUCTION_MODE==='true','Branch assembly requires production_mode');
 assert.match(env.NORA_VERIFIED_WINDOWS_RUN,/^[1-9][0-9]*$/);assert.ok(Number.isSafeInteger(Number(env.NORA_VERIFIED_WINDOWS_RUN)));
 assert.notEqual(env.NORA_VERIFIED_WINDOWS_RUN,env.GITHUB_RUN_ID,'Cannot reuse the assembling run');
}
function verifySource(run,artifacts,jobs,{commit,repository,runId}) {
 assert.match(commit,/^[a-f0-9]{40}$/);assert.match(repository,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);assert.match(String(runId),/^[1-9][0-9]*$/);assert.ok(Number.isSafeInteger(Number(runId)));
 assert.equal(run.id,Number(runId));assert.equal(run.head_sha,commit);assert.equal(run.repository.full_name,repository);
 assert.ok(Number.isSafeInteger(run.repository.id)&&run.repository.id>0);assert.equal(run.path,'.github/workflows/build-integrated-launcher.yml');
 assert.equal(run.event,'workflow_dispatch');assert.equal(run.status,'completed');assert.ok(['success','failure'].includes(run.conclusion),'Source must have finished without cancellation');
 assert.equal(artifacts.total_count,artifacts.artifacts.length);
 assert.equal(new Set(artifacts.artifacts.map(item=>item.name)).size,artifacts.artifacts.length,'Duplicate artifact names');
 const allowedNames=new Set([...names,...sourceStabilityNames,'nora-release-plan','nora-windows-failed-packaging-diagnostic','nora-tavern-shared',
  ...[...otherPlatforms.keys()].flatMap(platform=>['nora-tavern-'+platform,'nora-operation-acceptance-'+platform])]);
 assert.ok(artifacts.artifacts.every(item=>allowedNames.has(item.name)),'Unexpected source artifact');
 for(const platform of ['darwin-arm64','darwin-x64','win32-x64']) {
  const pair=['javascript','python'].map(group=>artifacts.artifacts.some(item=>item.name===`nora-source-stability-${platform}-${group}`));
  assert.equal(pair[0],pair[1],'Source artifacts must include both isolated groups for each platform');
 }
 assert.deepEqual(artifacts.artifacts.filter(item=>names.includes(item.name)).map(item=>item.name).sort(),[...names].sort());
 assert.equal(new Set(artifacts.artifacts.map(item=>item.id)).size,artifacts.artifacts.length,'Duplicate artifact IDs');
 for(const item of artifacts.artifacts) {
  assert.ok(Number.isSafeInteger(item.id)&&item.id>0);assert.equal(item.expired,false);assert.ok(Number.isSafeInteger(item.size_in_bytes)&&item.size_in_bytes>0);
  assert.match(item.digest,/^sha256:[a-f0-9]{64}$/);assert.equal(item.workflow_run.id,run.id);assert.equal(item.workflow_run.head_sha,commit);
  assert.equal(item.workflow_run.repository_id,run.repository.id);assert.equal(item.workflow_run.head_repository_id,run.repository.id);
 }
 assert.equal(jobs.total_count,jobs.jobs.length,'Incomplete job listing');
 // An unrelated failed platform cannot invalidate a fully accepted Windows
 // delivery. Its own native gates, API identities and archive/package proofs
 // remain mandatory; overall failure must be attributable to another builder.
 if(run.conclusion==='failure') {
  const preflight=jobs.jobs.filter(job=>job.name==='preflight');assert.equal(preflight.length,1,'Failed cohort requires a successful preflight');
  assert.equal(preflight[0].run_id,run.id);assert.equal(preflight[0].head_sha,commit);assert.equal(preflight[0].status,'completed');assert.equal(preflight[0].conclusion,'success');
  const failed=jobs.jobs.filter(job=>[...otherPlatforms.values()].includes(job.name)&&job.conclusion==='failure');
  assert.ok(failed.length>0,'Overall failure must be explained by another native platform');
  for(const job of failed){assert.equal(job.run_id,run.id);assert.equal(job.head_sha,commit);assert.equal(job.status,'completed');}
 }
 for(const [platform,jobName] of otherPlatforms){
  if(!artifacts.artifacts.some(item=>item.name==='nora-tavern-'+platform||platform==='darwin-arm64'&&item.name==='nora-tavern-shared'))continue;
  const completed=jobs.jobs.filter(job=>job.name===jobName);assert.equal(completed.length,1,'Unproven extra platform delivery');
  assert.equal(completed[0].run_id,run.id);assert.equal(completed[0].head_sha,commit);assert.equal(completed[0].status,'completed');assert.equal(completed[0].conclusion,'success');
 }
 const native=jobs.jobs.filter(job=>job.name==='build (windows-latest, win32, x64, pack:win:x64)');assert.equal(native.length,1);
 const job=native[0];assert.equal(job.run_id,run.id);assert.equal(job.head_sha,commit);assert.equal(job.status,'completed');assert.equal(job.conclusion,'success');
 assert.ok(job.steps.every(step=>!['failure','cancelled','timed_out','action_required'].includes(step.conclusion)),'Failed native step');
 for(const name of requiredSteps) {const steps=job.steps.filter(step=>step.name===name);assert.equal(steps.length,1,`Missing or duplicate native gate: ${name}`);assert.equal(steps[0].status,'completed');assert.equal(steps[0].conclusion,'success',`Native gate did not pass: ${name}`);}
 // The independently retained decision plan is not a package/acceptance archive.
 return artifacts.artifacts.filter(item=>names.includes(item.name));
}
function files(root,relative=false) {
 const result=new Map();for(const entry of fs.readdirSync(root,{recursive:true,withFileTypes:true})) {
  assert.ok(!entry.isSymbolicLink(),'Symbolic artifact file');if(entry.isDirectory())continue;assert.ok(entry.isFile());
  const file=path.join(entry.parentPath,entry.name),key=relative?path.relative(root,file):entry.name;assert.ok(!result.has(key),'Duplicate artifact basename');result.set(key,file);
 }return result;
}
function read(file) {return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
async function hash(file) {const value=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))value.update(chunk);return value.digest('hex');}
async function verifyArchive(file,item) {assert.equal(fs.statSync(file).size,item.size_in_bytes,'Artifact ZIP size differs');assert.equal('sha256:'+await hash(file),item.digest,'Artifact ZIP digest differs');}
async function verifyPackage(delivery,acceptance,commit) {
 const assets=files(delivery),reports=files(acceptance,true),get=name=>{assert.ok(assets.has(name),`Missing package object: ${name}`);return assets.get(name);};
 const systemFile=get('nora-system-win32-x64.json'),system=read(systemFile),systemHash=await hash(systemFile);
 assert.equal(system.schema,'nora-system/v1');assert.equal(system.commit,commit);assert.equal(system.candidate,false);assert.equal(system.channel,'stable');assert.equal(system.platform,'win32');assert.equal(system.arch,'x64');
 for(const entry of Object.values(system.files)) {assert.equal(fs.statSync(get(entry.asset)).size,entry.size);assert.equal(await hash(get(entry.asset)),entry.sha256);}
 const payload=read(get(system.files['release-manifest.json'].asset)),payloadHash=await hash(get(system.files['release-manifest.json'].asset));
 assert.equal(payload.commit,commit);assert.equal(payload.candidate,false);assert.equal(payload.dirty,false);assert.equal(payload.versions.tavern,system.version);
 const launcher=read(get('nora-launcher-win32-x64.json'));assert.equal(launcher.commit,commit);assert.equal(launcher.candidate,false);assert.equal(launcher.platform,'win32');assert.equal(launcher.arch,'x64');assert.equal(launcher.version,system.launcherVersion);
 assert.equal(fs.statSync(get(launcher.asset)).size,launcher.size);assert.equal(await hash(get(launcher.asset)),launcher.sha256);
 const image=read(get('Nora-Tavern-package-verification-win32-x64.json'));assert.equal(image.commit,commit);assert.equal(image.version,system.version);assert.equal(image.nativeIcon,true);
 const report=name=>{const matches=[...reports.values()].filter(file=>path.basename(file)===name);assert.equal(matches.length,1,`Missing or duplicate native report: ${name}`);return read(matches[0]);};
 const baseline=report('nora-upgrade-baseline-acceptance.json');assert.equal(baseline.schema,'nora-upgrade-baseline/1');assert.equal(baseline.acceptance,'version-transition-required');assert.equal(baseline.platform,'win32-x64');assert.equal(baseline.targetCommit,commit);assert.equal(baseline.targetVersion,system.version);assert.equal(baseline.targetManifestSha256,payloadHash);assert.notEqual(baseline.baselineVersion,baseline.targetVersion);
 const setup=report('nora-installed-setup-acceptance.json');assert.equal(setup.schema,'nora-installed-setup/1');assert.equal(setup.exitCode,0);assert.equal(setup.autoLaunch,false);assert.ok(Number.isSafeInteger(setup.verifiedUnpackedFiles)&&setup.verifiedUnpackedFiles>0);assert.ok(setup.installer.endsWith('-win-x64-setup.exe'));assert.equal(setup.installerSha256,await hash(get(setup.installer)));
 for(const name of ['nora-packaged-app-acceptance.json','nora-installed-app-acceptance.json']) {
  const app=report(name);assert.equal(app.schema,'nora-app-candidate-gate/1');assert.equal(app.platform,'win32');assert.equal(app.arch,'x64');assert.equal(app.payloadManifestSha256,systemHash);
  for(const key of ['actualElectron','nativeDependencyComplete','allFlatResourceHashesMatchCandidate','jsPythonReceiptAgree','arbitraryCliRefusedBeforeOperation'])assert.equal(app.assertions[key],true);
  // Full APPs need not contain launcher-update-info.json; bind their payload bytes instead.
  if(app.identity)assert.equal(app.identity.commit,commit);
 }
 const harness=[...reports.values()].filter(file=>path.basename(file)==='harness-result.json').map(read);
 assert.equal(harness.length,4,'Expected exactly runtime, fresh repair and two historical acceptance reports');
 for(const value of harness) {
  assert.equal(value.schema,'nora-launcher-products-smoke/1');assert.equal(value.outcome,'passed');assert.equal(value.platform,'win32');assert.equal(value.arch,'x64');assert.equal(value.executorHandles,'verified-closed');assert.equal(value.runtime,'verified');assert.equal(value.operation,'verified');assert.equal(value.runtimeSha256,payload.hermesRuntime.sha256);
  assert.match(value.actorSourceFiles['desktop/operation-delegate.js'],/^[a-f0-9]{64}$/);
  for(const [name,checksum] of Object.entries(value.actorSourceFiles))assert.equal(checksum,payload.artifacts['ops/installer/'+name]);
  if(value.releaseManifestSha256)assert.equal(value.releaseManifestSha256,payloadHash);
 }
 const runtime=harness.filter(value=>value.releaseManifestSha256===null);assert.equal(runtime.length,1);assert.equal(runtime[0].stop,'no-service-started');
 const fresh=harness.filter(value=>value.releaseManifestSha256===payloadHash&&!value.versionTransition);assert.equal(fresh.length,1);
 assert.equal(fresh[0].committedFirstInstall,'verified-real-resume-without-reinstall');assert.equal(fresh[0].missingSystemReceipt,'verified-bound-repair-and-preserved-user-data');assert.equal(fresh[0].releaseAcceptance,'isolated-same-version-repair');assert.equal(fresh[0].update,'verified-noop');
 for(const value of harness.filter(value=>value!==runtime[0])) {
  for(const key of ['firstInstall','http','hermesSkills','mcp','stop'])assert.equal(value[key],'verified');assert.equal(value.actorSourceBinding,'verified-selected-candidate-manifest');assert.equal(value.userData,'retained');
  assert.equal(value.modelConfiguration,'verified-local-A-to-B-model-requests');assert.match(value.userConfigurationDigest,/^[a-f0-9]{64}$/);assert.equal(value.userConfigurationDigest,fresh[0].userConfigurationDigest);
 }
 for(const state of ['running','stopped']) {
  const values=harness.filter(value=>value.versionTransition?.startState===state);assert.equal(values.length,1,'Missing or duplicate historical state');const value=values[0];
  const {startState,...proof}=value.versionTransition;assert.deepEqual(proof,baseline);assert.equal(value.releaseManifestSha256,payloadHash);assert.equal(value.actorSourceBinding,'verified-selected-candidate-manifest');
  assert.equal(value.releaseAcceptance,'isolated-version-transition');assert.equal(value.update,'verified-content-transition');assert.ok(value.changedSourceArtifacts>0);assert.equal(value.userData,'retained');assert.equal(value.updateInitialService,state);
 }
 const inventory={};for(const [name,file] of assets)inventory[name]={size:fs.statSync(file).size,sha256:await hash(file)};return inventory;
}
const extractScript=`import pathlib,shutil,stat,sys,zipfile
root=pathlib.Path(sys.argv[2]); root.mkdir(); seen=set()
with zipfile.ZipFile(sys.argv[1]) as archive:
 assert len(archive.infolist())<=50000 and sum(i.file_size for i in archive.infolist())<=8*1024**3
 for item in archive.infolist():
  name=pathlib.PurePosixPath(item.filename); key=str(name).casefold()
  assert name.parts and not name.is_absolute() and '..' not in name.parts and '\\\\' not in item.filename and ':' not in item.filename and '\\x00' not in item.orig_filename
  assert key not in seen and stat.S_IFMT(item.external_attr >> 16) in (0,stat.S_IFREG,stat.S_IFDIR); seen.add(key)
  target=root.joinpath(*name.parts)
  if item.is_dir(): target.mkdir(parents=True,exist_ok=True)
  else:
   target.parent.mkdir(parents=True,exist_ok=True)
   with archive.open(item) as source, target.open('xb') as output: shutil.copyfileobj(source,output,1024*1024)
`;
// A held gh child must close before its archive is inspected or reused. A
// timeout is evidence of failure, never evidence that the remote/process exited.
async function downloadArchive(item,repository,archive,{env=process.env,timeout=600000,idleTimeout=300000,
 killGrace=2000,closeTimeout=10000,spawnProcess=spawn}={}) {
 for(const value of [timeout,idleTimeout,killGrace,closeTimeout])assert.ok(Number.isSafeInteger(value)&&value>0,'Finite download lifecycle budgets required');
 assert.ok(closeTimeout>killGrace,'Held close budget must allow force escalation');
 const child=spawnProcess('gh',['api',`repos/${repository}/actions/artifacts/${item.id}/zip`],
  {env,stdio:['ignore','pipe','inherit'],windowsHide:true});
 let didClose=false,closedResult,closeResolve,failReject,total,idle,force,closeTimer,output;
 const closed=new Promise(resolve=>{closeResolve=resolve;});
 const failed=new Promise((_,reject)=>{failReject=reject;});
 const onClose=(code,signal)=>{didClose=true;closedResult={code,signal};child.removeListener('error',onError);closeResolve(closedResult);};
 const onError=error=>failReject(error);
 child.once('close',onClose);child.on('error',onError);
 const expire=reason=>failReject(Object.assign(new Error(`Artifact ${item.name} download ${reason}`),{code:'ETIMEDOUT'}));
 const resetIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>expire('idle deadline exceeded'),idleTimeout);};
 child.stdout?.on('data',resetIdle);resetIdle();total=setTimeout(()=>expire('total deadline exceeded'),timeout);
 try {
  output=fs.createWriteStream(archive,{flags:'wx'});
  await Promise.race([Promise.all([pipeline(child.stdout,output),closed.then(({code,signal})=>{
   if(code!==0||signal)throw new Error(`Artifact download exited ${signal||code}`);
  })]),failed]);
 } catch(error) {
  clearTimeout(total);clearTimeout(idle);
  const kill=signal=>{if(didClose)return;try{child.kill(signal);}catch(cause){error.stopError=String(cause.message||cause);}};
  if(!didClose){kill('SIGTERM');force=setTimeout(()=>kill('SIGKILL'),killGrace);}
  child.stdout?.destroy();output?.destroy();
  await Promise.race([closed,new Promise(resolve=>{closeTimer=setTimeout(resolve,closeTimeout);})]);
  error.closeConfirmed=didClose;error.childIdentity={pid:child.pid};error.childClose=closedResult||null;
  error.archivePath=archive;error.preserveArchive=true;
  if(!didClose){
   error.cleanupFailure='Held artifact child close remains unconfirmed; preserve the archive and process evidence';
   child.unref?.();error.childClosurePending=true;
  }
  throw error;
 } finally {
  for(const timer of [total,idle,force,closeTimer])clearTimeout(timer);
  child.stdout?.removeListener('data',resetIdle);if(didClose)child.removeListener('error',onError);
  // Keep the close listener attached when closure remains pending. It does not
  // turn a bounded failure into a fabricated successful process receipt.
 }
 return closedResult;
}
async function materialize(run,artifacts,jobs,options,root) {
 const accepted=verifySource(run,artifacts,jobs,options);assert.ok(!fs.existsSync(root),'Assembly directory already exists');fs.mkdirSync(root,{recursive:true});
 const proof={schema:'nora-verified-windows-reuse/1',sourceRun:run.id,commit:options.commit,artifacts:[]};
 for(const item of accepted) {
  const archive=path.join(root,item.name+'.zip'),output=path.join(root,item.name===names[0]?'delivery':'acceptance');
  await downloadArchive(item,options.repository,archive);await verifyArchive(archive,item);
  execFileSync('python3',['-c',extractScript,archive,output],{stdio:'inherit'});proof.artifacts.push({id:item.id,name:item.name,size:item.size_in_bytes,digest:item.digest});
 }
 proof.files=await verifyPackage(path.join(root,'delivery'),path.join(root,'acceptance'),options.commit);
 const provenance=path.join(root,'acceptance','nora-verified-windows-reuse.json');assert.ok(!fs.existsSync(provenance),'Source already contains reuse provenance');
 fs.writeFileSync(provenance,JSON.stringify(proof,null,2)+'\n');console.log(`Verified unchanged native Windows package from run ${run.id} at ${options.commit}.`);
}
module.exports={verifyModes,verifySource,verifyArchive,verifyPackage,downloadArchive,materialize,requiredSteps,extractScript,sourceStabilityNames};
if(require.main===module) {
 verifyModes(process.env);const [runFile,artifactsFile,jobsFile,commit,repository,runId,root]=process.argv.slice(2);
 materialize(read(runFile),read(artifactsFile),read(jobsFile),{commit,repository,runId},root).catch(error=>{console.error(error);process.exitCode=1;});
}
