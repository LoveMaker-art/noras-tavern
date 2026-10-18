// Native APP-only proof producer. The normal baseline APP owns the upgrade;
// this tool only launches it, observes sealed evidence and hashes actual files.
// prepare/observe/finish can be driven by native UI tools; run uses AX/MSAA.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const net=require('node:net');
const {execFileSync,spawn}=require('node:child_process');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const bytesHash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function sha(file){const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}return hash.digest('hex');}
function snapshotTree(root){
 const files=[];
 function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  const file=path.join(directory,entry.name),relative=path.relative(root,file).split(path.sep).join('/'),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink())files.push({path:relative,link:fs.readlinkSync(file)});
  else if(stat.isDirectory())visit(file);else{assert.ok(stat.isFile(),'Special file in native snapshot');files.push({path:relative,size:stat.size,sha256:sha(file)});}
 }}visit(root);return {files,sha256:bytesHash(JSON.stringify(files))};
}
function assertSnapshot(root,before){assert.deepEqual(snapshotTree(root),before,'Actual core or protected data changed');}
function assertTransition(core,product,before,after){
 assert.equal(core.schema,'tavern-release/v2');assert.equal(core.candidate,false);assert.equal(core.dirty,false);
 assert.equal(product.schema,'tavern-release/v2');assert.equal(product.candidate,false);assert.equal(product.dirty,false);
 assert.equal(core.versions.tavern,product.versions.tavern,'APP-only must retain core version');
 const parse=value=>{assert.match(value||'',/^\d+\.\d+\.\d+$/);return value.split('.').map(Number);};
 const next=parse(after.version),old=parse(before.version),at=next.findIndex((n,i)=>n!==old[i]);
 assert.ok(at>=0&&next[at]>old[at],'APP version must increase');assert.equal(after.version,product.launcherVersion);assert.equal(after.commit,product.commit);
}
function application(root){
 if(process.platform==='darwin'){
  const base=root.endsWith('.app')?root:path.join(root,fs.readdirSync(root).find(name=>name.endsWith('.app'))||'missing');
  const names=fs.readdirSync(path.join(base,'Contents/MacOS'));assert.equal(names.length,1);
  return {root:base,executable:path.join(base,'Contents/MacOS',names[0]),asar:path.join(base,'Contents/Resources/app.asar')};
 }
 const names=fs.readdirSync(root).filter(name=>name.endsWith('.exe')&&!/^uninstall/i.test(name));assert.equal(names.length,1);
 return {root,executable:path.join(root,names[0]),asar:path.join(root,'resources/app.asar')};
}
function operationFiles(home){const root=path.join(home,'installer/operations');if(!fs.existsSync(root))return [];return fs.readdirSync(root).filter(id=>/^[a-f0-9-]{36}$/.test(id)).map(id=>path.join(root,id,'operation.json')).filter(fs.existsSync);}
function runtimeOptions(options){
 const runtime=json(path.join(options.baseline,'nora-hermes-runtime.json'));
 return {python:path.join(options.hermes,runtime.venvPython),runtime,env:{...process.env,HOME:options.hermes,USERPROFILE:options.hermes,HERMES_INSTALL_DIR:path.join(options.hermes,'hermes-agent'),TAVERN_DATA_ROOT:options.installRoot,TAVERN_NODE_EXECUTABLE:path.join(options.hermes,process.platform==='win32'?'node/node.exe':'node/bin/node'),HERMES_HOME:options.hermes,NORA_HERMES_HOME:options.hermes,NORA_TAVERN_HOME:options.home,NORA_TAVERN_INSTALL_ROOT:options.installRoot,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PATH:[path.join(options.hermes,process.platform==='win32'?'node':'node/bin'),path.join(options.hermes,process.platform==='win32'?'hermes-agent/venv/Scripts':'hermes-agent/venv/bin'),...(process.platform==='win32'?[path.join(process.env.SystemRoot||'C:\\Windows','System32'),process.env.SystemRoot||'C:\\Windows',path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0')]:['/usr/bin','/bin','/usr/sbin','/sbin'])].join(path.delimiter)}};
}
function status(options){const {python,env}=runtimeOptions(options),bridge=path.join(options.installRoot,'apps/tavern-ops/installer/launcher_bridge.py');
 return JSON.parse(execFileSync(python,['-B',bridge,'--nora-home',options.home,'--hermes-home',options.hermes,'--install-root',options.installRoot,'--port',String(options.port),'status'],{env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024}));}
function inventories(options){
 const core=Object.fromEntries(['tavern-runtime','tavern-ops','nora-mcp'].map(name=>[name,snapshotTree(path.join(options.installRoot,'apps',name))]));
 const declared=json(path.join(options.installRoot,'tavern-updates/installed-manifest.json'));
 for(const [relative,expected]of Object.entries(declared.artifacts||{})){const slash=relative.indexOf('/'),part=relative.slice(0,slash),tail=relative.slice(slash+1),root={app:'tavern-runtime',ops:'tavern-ops','nora-mcp':'nora-mcp'}[part];assert.ok(root&&!tail.split('/').includes('..'));assert.equal(sha(path.join(options.installRoot,'apps',root,tail)),expected,'Declared core program byte differs: '+relative);}
 const retained=path.join(options.installRoot,'tavern-updates'),receipts=Object.fromEntries(['installed.json','installed-manifest.json','nora-system.json'].map(name=>[name,sha(path.join(retained,name))]));
 const protectedData=snapshotTree(path.join(options.installRoot,'tavern-state/native'));
 const config=Object.fromEntries(['.env','config.yaml','SOUL.md','AGENTS.md','nora-instance.json'].filter(name=>fs.existsSync(path.join(options.hermes,name))).map(name=>[name,sha(path.join(options.hermes,name))]));
 for(const name of ['model.json']){const file=path.join(options.home,'installer',name);if(fs.existsSync(file))config['installer/'+name]=sha(file);}
 return {core,receipts,protectedData,config,coreFilesSha256:bytesHash(JSON.stringify({core,receipts})),protectedDataSha256:protectedData.sha256,userConfigurationDigest:bytesHash(JSON.stringify(config))};
}
function write(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
function runtimeProbe(options,{execute=execFileSync}={}){
 const {python,env}=runtimeOptions(options);for(const key of Object.keys(env))if(key.startsWith('NORA_OPERATION_'))delete env[key];
 env.PYTHONPATH=path.join(options.hermes,'hermes-agent');
 const module=path.join(options.installRoot,'apps/tavern-ops/installer/nora_system.py');
 const source=`import importlib.util,json,os,sys,urllib.request
from pathlib import Path
file=Path(sys.argv[1]);sys.path.insert(0,str(file.parent))
spec=importlib.util.spec_from_file_location("nora_system_native_acceptance",file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
native=Path(sys.argv[3])/'apps/tavern-runtime/native_lifecycle.py';spec=importlib.util.spec_from_file_location("native_app_only_probe",native);lifecycle=importlib.util.module_from_spec(spec);sys.modules[spec.name]=lifecycle;spec.loader.exec_module(lifecycle)
runtime=lifecycle.NativeRuntime.from_environment();was_running=bool(runtime.status()['processes']['native']);temporary=not was_running
try:
 if temporary: assert runtime.start(port=int(sys.argv[4]))['health']['ok']
 result=module.verify_runtime(Path(sys.argv[2]),Path(sys.argv[3]),int(sys.argv[4]),sys.executable,dict(os.environ))
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor())
 with opener.open('http://127.0.0.1:'+sys.argv[4]+'/api/nora-boot/shell?lang=zh-cn',timeout=15) as response:
  assert response.status==200;assert json.load(response)['worlds'],'Actual shell/world must be readable'
 with opener.open('http://127.0.0.1:'+sys.argv[4]+'/api/nora-worlds-v2/worlds',timeout=15) as response:
  assert response.status==200;worlds=json.load(response)['worlds']
 assert worlds and any(world.get('sessions',{}).get('items') for world in worlds),'Actual world/session missing'
 result.update(httpStatus=200,worldCount=len(worlds),sessionReadable=True,temporarilyStarted=temporary)
finally:
 if temporary: runtime.stop_run();assert runtime.status()['processes']['native'] is False
result['restoredRunning']=bool(runtime.status()['processes']['native']);assert result['restoredRunning']==was_running
print(json.dumps(result))`;
 const result=JSON.parse(execute(python,['-B','-c',source,module,options.hermes,options.installRoot,String(options.port)],{env,cwd:options.hermes,encoding:'utf8',timeout:240000,maxBuffer:4*1024*1024}));
 for(const key of ['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'])assert.equal(result[key],true);return result;
}
function processCensus(options){const {python,env}=runtimeOptions(options);return JSON.parse(execFileSync(python,['-B','-c',
 'import json,os,sys,psutil; app=os.path.normcase(os.path.realpath(sys.argv[1])); jobs=os.path.normcase(os.path.realpath(sys.argv[2])); hermes=os.path.normcase(os.path.realpath(sys.argv[3])); rows=[]; observer=set(); current=psutil.Process(); producer=int(sys.argv[4])\nwhile current.pid!=producer:\n observer.add(current.pid); current=current.parent(); assert current is not None, "Census is not a child of the exact producer"\nobserver.add(producer)\nfor p in psutil.process_iter(["pid","exe","cmdline"]):\n try:\n  exe=os.path.normcase(os.path.realpath(p.info["exe"] or "")); args=p.info["cmdline"] or []; owned=exe.startswith(app+os.sep) or exe.startswith(hermes+os.sep) or any(os.path.normcase(str(a)).startswith(jobs+os.sep) for a in args[1:]);\n  if p.pid not in observer and owned: rows.append(p.info)\n except (psutil.NoSuchProcess,psutil.AccessDenied): pass\nprint(json.dumps(rows))',options.appRoot,path.join(options.home,'installer'),options.hermes,String(process.pid)],{env,encoding:'utf8',timeout:30000}));}
async function assertOffline(port){await new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();reject(Error('Owned Tavern listener remains'));});socket.once('error',error=>error.code==='ECONNREFUSED'?resolve():reject(error));socket.setTimeout(3000,()=>{socket.destroy();reject(Error('Port state unconfirmed'));});});}
async function prepare(options){
 assert.ok(['running','stopped'].includes(options.state));assert.ok(!fs.existsSync(options.output),'Use a fresh native evidence directory');
 const product=json(path.join(options.target,'release-manifest.json')),baseline=json(path.join(options.baseline,'release-manifest.json'));
 const platform=process.platform+'-'+process.arch,before=json(path.join(options.baselineLauncher,`nora-launcher-${platform}.json`)),after=json(path.join(options.target,`nora-launcher-${platform}.json`));
 assertTransition(baseline,product,before,after);
 const {assertCoreReleasePayload,releasePublicationTag,coreReceiptRepresentations}=await import('./system-release.mjs');
 assertCoreReleasePayload(product,fs.readFileSync(path.join(options.baseline,'release-manifest.json')),platform);
 for(const [directory,descriptor] of [[options.baselineLauncher,before],[options.target,after]]){assert.match(descriptor.asset,/^[A-Za-z0-9][A-Za-z0-9._-]*-update\.zip$/);assert.equal(fs.statSync(path.join(directory,descriptor.asset)).size,descriptor.size);assert.equal(sha(path.join(directory,descriptor.asset)),descriptor.sha256);}
 const installed=path.join(options.installRoot,'tavern-updates/installed-manifest.json'),actualInstalledManifestSha256=sha(installed);
 const sourceBytes=fs.readFileSync(path.join(options.baseline,'release-manifest.json')),system=json(path.join(options.baseline,'nora-system.json'));
 const dependencyEntry=system.files?.['nora-tavern-dependencies.json'];
 const receiptIdentity=coreReceiptRepresentations(sourceBytes,{platform:process.platform,arch:process.arch,
  ...(dependencyEntry?{dependencyEntry,dependenciesBytes:fs.readFileSync(path.join(options.baseline,'nora-tavern-dependencies.json'))}:{})});
 assert.ok(receiptIdentity.representations.some(value=>value.sha256===actualInstalledManifestSha256),'Actual core receipt is not an exact authenticated baseline representation');
 const current=status(options);assert.equal(current.systemReady,true,JSON.stringify(current.systemProblems));assert.equal(current.version,baseline.versions.tavern);assert.equal(current.commit,baseline.commit);assert.equal(current.running,options.state==='running');
 const app=application(options.appRoot),native={executableSha256:sha(app.executable),asarSha256:sha(app.asar)};
 // Compare the real baseline APP to the authenticated archive, not a version label.
 fs.mkdirSync(options.output,{recursive:true,mode:0o700});
 try{
  const extracted=path.join(options.output,'baseline-app-bytes');fs.mkdirSync(extracted);
  const helper=path.resolve(__dirname,'../../launcher/desktop/replace-launcher.py'),{python,env}=runtimeOptions(options);
  execFileSync(python,['-B','-c','import runpy,sys; from pathlib import Path; runpy.run_path(sys.argv[1])["extract"](Path(sys.argv[2]),Path(sys.argv[3]),sys.argv[4])',helper,path.join(options.baselineLauncher,before.asset),extracted,process.platform],{env,timeout:120000});
  const original=application(extracted);assert.equal(sha(original.executable),native.executableSha256);assert.equal(sha(original.asar),native.asarSha256);
  const sourceFile=path.join(options.baseline,'baseline-source-receipt.json'),sourceReceipt=fs.existsSync(sourceFile)?json(sourceFile):null;
  const runtimeProof=runtimeProbe(options);
  const checkpoint={producerSha256:sha(__filename),runtimeProof,schema:'nora-app-native-checkpoint/1',options:{...options,appRoot:app.root},platform,productCommit:product.commit,targetTag:releasePublicationTag(product),actualInstalledManifestSha256,
   baselineTag:sourceReceipt?.tag||releasePublicationTag(baseline),sourceReceiptSha256:sourceReceipt?sha(sourceFile):null,
   scope:sourceReceipt?.mode==='materialized'?'published-baseline':'private-frozen-baseline',
   coreIdentity:{version:baseline.versions.tavern,commit:baseline.commit,manifestSha256:receiptIdentity.sourceManifestSha256},
   baselineLauncher:{version:before.version,commit:before.commit,descriptorSha256:sha(path.join(options.baselineLauncher,`nora-launcher-${platform}.json`)),archiveSha256:before.sha256,archiveSize:before.size,...native},
   targetLauncher:{version:after.version,commit:after.commit,descriptorSha256:sha(path.join(options.target,`nora-launcher-${platform}.json`)),archiveSha256:after.sha256,archiveSize:after.size},
   before:inventories(options),operationIds:operationFiles(options.home).map(file=>json(file).operationId),createdAt:new Date().toISOString(),status:current};
  write(path.join(options.output,'checkpoint.json'),checkpoint);return checkpoint;
 }catch(error){write(path.join(options.output,'prepare-error.json'),{error:error.stack});throw error;}
}
function launch(options){const app=application(options.appRoot),{env}=runtimeOptions(options);delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.NODE_PATH;
 const child=spawn(app.executable,['--force-renderer-accessibility','--nora-local-release='+options.target],{env,cwd:path.dirname(app.executable),stdio:'ignore',detached:process.platform!=='win32'});child.unref();return child.pid;}
function appSourceProof(options){
 const app=application(options.appRoot),product=json(path.join(options.target,'release-manifest.json'));
 const expected=Object.fromEntries(Object.entries(product.artifacts).filter(([name])=>name.startsWith('ops/installer/desktop/')&&/\.(?:js|mjs|cjs|json)$/.test(name)&&!['ops/installer/desktop/package.json','ops/installer/desktop/package-lock.json'].includes(name)).map(([name,hash])=>[name.slice('ops/installer/desktop/'.length),hash]));
 const resources=path.dirname(app.asar),script='const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),expected=JSON.parse(process.argv[2]);const sha=f=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");const modules=Object.fromEntries(Object.keys(expected).map(name=>[name,sha(path.join(process.argv[1],name))]));const actors=Object.fromEntries(["operation_control.py","operation_cli.py","operation_evidence.py"].map(name=>[name,sha(path.join(path.dirname(process.argv[1]),name))]));actors["desktop/operation-delegate.js"]=sha(path.join(process.argv[1],"operation-delegate.js"));console.log(JSON.stringify({modules,actors}));';
 const proof=JSON.parse(execFileSync(app.executable,['-e',script,app.asar,JSON.stringify(expected)],{env:{...runtimeOptions(options).env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}));
 assert.deepEqual(proof.modules,expected,'Actual new APP production modules differ from fixed product source');for(const [name,hash]of Object.entries(proof.actors))assert.equal(hash,product.artifacts['ops/installer/'+name]);
 return proof;
}
function assertPostHandoffReady(checkpoint){
 const state=json(path.join(checkpoint.options.home,'installer/state.json'));
 assert.equal(state.phase,'ready','APP-only installer phase did not return to ready');
 assert.equal(state.resumeTarget,null,'APP-only installer still has a resume target');
 assert.equal(state.error,'','APP-only installer still projects an error');
 assert.equal(state.task,'','APP-only installer still projects an unfinished task');
 const starts=operationFiles(checkpoint.options.home).map(json).filter(op=>!checkpoint.operationIds.includes(op.operationId)&&op.kind==='start');
 for(const start of starts){assert.equal(start.state,'succeeded','A new start failed or has not ended');assert.equal(start.verification,'confirmed','A new start has not been verified');}
 return {installer:state,starts};
}
async function observe(output){
 const checkpoint=json(path.join(output,'checkpoint.json')),options=checkpoint.options;assert.equal(checkpoint.producerSha256,sha(__filename),'Native acceptance producer changed after prepare');
 const newOperations=operationFiles(options.home).map(json).filter(op=>!checkpoint.operationIds.includes(op.operationId));
 const operations=newOperations.filter(op=>op.kind==='update');
 const actual=operations.filter(op=>op.target?.request?.launcherOnly===true&&op.target?.releasePlan?.tag===checkpoint.targetTag);
 assert.equal(actual.length,1,'Expected one genuine APP-only canonical operation');const operation=actual[0];
 assert.equal(operation.state,'succeeded',JSON.stringify(operation.currentFailure||operation.primaryFailure));assert.equal(operation.verification,'confirmed');assert.equal(operation.result?.updateVerified,true);
 assert.equal(operation.result.running,options.state==='running','APP handoff must verify the state it actually inherited');
 assert.equal(operation.result.version,checkpoint.coreIdentity.version);assert.equal(operation.result.commit,checkpoint.coreIdentity.commit);
 assert.ok(!operations.some(op=>op.target?.request?.launcherOnly!==true),'APP-only must not execute a core update operation');
 assert.deepEqual(operation.target.releasePlan.launcherManifest,json(path.join(options.target,`nora-launcher-${checkpoint.platform}.json`)));
 assert.ok(operation.handoffRef);const ready=json(path.join(operation.handoffRef,'ready.json')),plan=json(path.join(operation.handoffRef,'plan.json'));
 assert.equal(ready.schema,'nora-launcher-handoff/1');assert.equal(ready.operationId,operation.operationId);assert.equal(ready.planDigest,operation.planDigest);assert.equal(ready.version,checkpoint.targetLauncher.version);
 assert.equal(plan.localRelease,options.target);assert.equal(plan.version,checkpoint.targetLauncher.version);
 const app=application(options.appRoot),after={...checkpoint.targetLauncher,executableSha256:sha(app.executable),asarSha256:sha(app.asar)};
 assert.ok(after.asarSha256!==checkpoint.baselineLauncher.asarSha256||after.executableSha256!==checkpoint.baselineLauncher.executableSha256,'APP did not change actual bytes');
 // Inspect the real UI projection and all intervening starts before any probe
 // can temporarily own the Tavern port. A ready APP must not retain old errors.
 const readiness=assertPostHandoffReady(checkpoint),sourceProof=appSourceProof(options),runtimeProof=runtimeProbe(options);
 const now=inventories(options);assert.deepEqual(now,checkpoint.before,'Core program, receipts, user data or configuration changed');
 const current=status(options);assert.equal(current.systemReady,true);
 const continuationOperations=newOperations.filter(op=>op.kind==='start'&&Date.parse(op.createdAt)>=Date.parse(operation.updatedAt));
 if(options.state==='stopped'&&current.running){assert.ok(continuationOperations.length>0,'Running service needs its own subsequent start operation');for(const start of continuationOperations){assert.equal(start.target?.request?.service,'tavern');assert.equal(start.state,'succeeded');assert.equal(start.verification,'confirmed');assert.equal(start.result?.version,checkpoint.coreIdentity.version);assert.equal(start.result?.commit,checkpoint.coreIdentity.commit);}}else assert.equal(current.running,options.state==='running');
 write(path.join(output,'observed.json'),{readiness,continuationOperations,operations,operation,ready,plan,sourceProof,runtimeProof,status:current,targetLauncher:after,after:now,observedAt:new Date().toISOString()});return {operationId:operation.operationId,targetLauncher:after};
}
async function finish(output){
 const checkpoint=json(path.join(output,'checkpoint.json')),observed=json(path.join(output,'observed.json')),options=checkpoint.options;assert.equal(checkpoint.producerSha256,sha(__filename),'Native acceptance producer changed after prepare');
 assert.deepEqual(inventories(options),checkpoint.before,'Final core/data/config snapshot changed');const current=status(options);assert.equal(current.running,false,'Stop the isolated Tavern through its normal APP before final proof');assert.equal(current.systemReady,true);await assertOffline(options.port);
 const processes=processCensus(options);assert.deepEqual(processes,[],'Native APP or maintenance worker is still running');
 const app=application(options.appRoot),lockProof=JSON.parse(execFileSync(app.executable,['-e','require(process.argv[1]).probe({directory:process.argv[2]}).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1})',app.asar+'/operation-lock.js',path.join(options.home,'installer')],{env:{...runtimeOptions(options).env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:30000}));assert.equal(lockProof.busy,false);
 const count=Object.values(checkpoint.before.core).reduce((n,item)=>n+item.files.length,0)+Object.keys(checkpoint.before.receipts).length;
 const proof={schema:'nora-app-upgrade-baseline/1',sourceTag:checkpoint.baselineTag,baselineTag:checkpoint.baselineTag,targetTag:checkpoint.targetTag,sourceReceiptSha256:checkpoint.sourceReceiptSha256,
  platform:checkpoint.platform,baselineVersion:checkpoint.coreIdentity.version,baselineCommit:checkpoint.coreIdentity.commit,baselineManifestSha256:checkpoint.coreIdentity.manifestSha256,
  systemManifestSha256:sha(path.join(options.baseline,'nora-system.json')),targetVersion:checkpoint.coreIdentity.version,targetCommit:checkpoint.productCommit,targetManifestSha256:checkpoint.coreIdentity.manifestSha256,
  acceptance:'launcher-transition-required',coreIdentity:checkpoint.coreIdentity,baselineLauncher:checkpoint.baselineLauncher,targetLauncher:observed.targetLauncher,
  verifiedFiles:fs.existsSync(path.join(options.baseline,'baseline-source-receipt.json'))?json(path.join(options.baseline,'baseline-source-receipt.json')).declaredFiles:Object.keys(json(path.join(options.baseline,'nora-system.json')).files).length,actualInstalledManifestSha256:checkpoint.actualInstalledManifestSha256,coreFilesCount:count,coreFilesSha256:checkpoint.before.coreFilesSha256,protectedDataSha256:checkpoint.before.protectedDataSha256,userConfigurationDigest:checkpoint.before.userConfigurationDigest};
 const report={schema:'nora-launcher-products-smoke/1',root:options.home,platform:process.platform,arch:process.arch,outcome:'passed',
  releaseManifestSha256:proof.targetManifestSha256,runtimeSha256:runtimeOptions(options).runtime.sha256,actorSourceFiles:observed.sourceProof.actors,moduleHashes:observed.sourceProof.modules,actorSourceBinding:'verified-native-app-source',
  launcherTransition:{...proof,startState:options.state},update:'verified-launcher-transition',releaseAcceptance:'isolated-launcher-transition',updateInitialService:options.state,
  executorHandles:'verified-closed',operation:'verified',runtime:'verified',http:'verified',hermesSkills:'verified',mcp:'verified',stop:'verified',userData:'retained',
  coreBefore:checkpoint.coreIdentity,coreAfter:checkpoint.coreIdentity,preservedCoreFiles:count,coreFilesBeforeSha256:proof.coreFilesSha256,coreFilesAfterSha256:proof.coreFilesSha256,
  protectedDataBeforeSha256:proof.protectedDataSha256,protectedDataAfterSha256:proof.protectedDataSha256,userConfigurationDigest:proof.userConfigurationDigest,
  changedLauncherFiles:Number(checkpoint.baselineLauncher.executableSha256!==observed.targetLauncher.executableSha256)+Number(checkpoint.baselineLauncher.asarSha256!==observed.targetLauncher.asarSha256),
  nativeOperationId:observed.operation.operationId,nativeEvidenceScope:checkpoint.scope};
 write(path.join(output,'finished-status.json'),{status:current,processes,lockProof,offline:true});
 proof.nativeEvidence={checkpointSha256:sha(path.join(output,'checkpoint.json')),observedSha256:sha(path.join(output,'observed.json')),finishedStatusSha256:sha(path.join(output,'finished-status.json'))};
 report.launcherTransition={...proof,startState:options.state};write(path.join(output,'harness-result.json'),report);write(path.join(output,'app-case-proof.json'),proof);return report;
}
function combine(running,stopped,output){
 const directories={running,stopped},proofs=Object.fromEntries(Object.entries(directories).map(([state,directory])=>{const proof=json(path.join(directory,'app-case-proof.json')),report=json(path.join(directory,'harness-result.json'));assert.equal(report.launcherTransition.startState,state);assert.equal(report.outcome,'passed');return [state,proof];}));
 const variable=['coreFilesCount','coreFilesSha256','protectedDataSha256','userConfigurationDigest','nativeEvidence','actualInstalledManifestSha256'];
 const common=proof=>Object.fromEntries(Object.entries(proof).filter(([key])=>!variable.includes(key)));
 assert.deepEqual(common(proofs.running),common(proofs.stopped),'Native states must target the same authenticated releases');
 const proof={...common(proofs.running),cases:Object.fromEntries(Object.entries(proofs).map(([state,value])=>[state,Object.fromEntries(variable.map(name=>[name,value[name]]))]))};
 for(const [state,directory]of Object.entries(directories)){const file=path.join(directory,'harness-result.json'),report=json(file);report.launcherTransition={...proof,startState:state};fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
 write(output,proof);return proof;
}
function stageTarget(release,destination){fs.mkdirSync(destination,{recursive:true,mode:0o700});
 const folders=[release,path.join(release,'system-assets'),path.join(release,'nora-tavern-launcher/desktop/dist')];
 for(const directory of folders){assert.ok(fs.existsSync(directory));for(const name of fs.readdirSync(directory)){const source=path.join(directory,name);if(!fs.lstatSync(source).isFile()||directory===folders[2]&&!/^nora-launcher-.*\.json$|^Nora-Tavern-Launcher-.*-update\.zip$/.test(name))continue;
 const output=path.join(destination,name);if(fs.existsSync(output)){assert.equal(sha(output),sha(source),'Ambiguous target logical asset');continue;}fs.copyFileSync(source,output,fs.constants.COPYFILE_FICLONE);}}
}
function nativeUI(appRoot,action,output){
 if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'app-only-native-ui.ps1'),'-AppRoot',appRoot,'-Action',action,'-Output',output],{stdio:'inherit',timeout:120000});
 else{const app=application(appRoot),pids=execFileSync('/usr/bin/pgrep',['-f',app.executable],{encoding:'utf8'}).trim().split(/\s+/).map(Number).filter(Number.isInteger);assert.equal(pids.length,1,'Expected one owned normal APP process for native accessibility');const result=execFileSync('/usr/bin/osascript',[path.join(__dirname,'app-only-native-ui.applescript'),String(pids[0]),action],{encoding:'utf8',timeout:120000});write(output,{scope:'native-SystemEvents-AXPress',action,pid:pids[0],result});}
}
function stopManagedRuntime(settings){const {python,env}=runtimeOptions(settings);execFileSync(python,['-B','-c','import importlib.util,sys; from pathlib import Path; file=Path(sys.argv[1]); spec=importlib.util.spec_from_file_location("app_native_precondition",file); module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module); runtime=module.NativeRuntime.from_environment(); runtime.stop_run(); assert runtime.status()["processes"]["native"] is False',path.join(settings.installRoot,'apps/tavern-runtime/native_lifecycle.py')],{env,timeout:60000});}
async function settleStoppedPrecondition(settings,previousIds,dependencies={}){
 const now=dependencies.now||Date.now,sleep=dependencies.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms))),operations=dependencies.operations||(()=>operationFiles(settings.home).map(json)),readStatus=dependencies.readStatus||(()=>status(settings)),stop=dependencies.stop||(()=>stopManagedRuntime(settings));
 const deadline=now()+120000;while(now()<deadline){await dependencies.ready?.();const recent=operations().filter(op=>!previousIds.includes(op.operationId)),starts=recent.filter(op=>op.kind==='start');
  assert.ok(!starts.some(op=>['failed','blocked','rolled-back','cancelled'].includes(op.state)),'Native UI initial start did not succeed');
  if(recent.some(op=>!['succeeded','failed','cancelled','rolled-back','blocked'].includes(op.state))){await sleep(300);continue;}
  for(const start of starts)assert.equal(start.verification,'confirmed','Initial start must be verified');
  stop();const current=readStatus();assert.equal(current.running,false,'Native stopped precondition was not restored');return {initialStart:starts.find(op=>op.state==='succeeded')||null,status:current};
 }throw Error('Native UI environment blocked: initial UI tasks did not settle');
}
async function observeAfterNativeReady(output,ready){const checkpoint=json(path.join(output,'checkpoint.json')),options=checkpoint.options;
 const updates=operationFiles(options.home).map(json).filter(op=>!checkpoint.operationIds.includes(op.operationId)&&op.kind==='update'&&op.target?.request?.launcherOnly===true&&op.target?.releasePlan?.tag===checkpoint.targetTag);
 assert.equal(updates.length,1,'Expected one native APP-only operation');assert.equal(updates[0].state,'succeeded','Wait for native APP handoff');assert.equal(updates[0].verification,'confirmed');
 await ready();return observe(output);
}
async function runNative(options){
 assert.ok(!fs.existsSync(options.output),'Use a fresh native matrix directory');fs.mkdirSync(options.output,{recursive:true,mode:0o700});
 const target=path.join(options.output,'target-delivery');stageTarget(options.target,target);
 const repository=path.resolve(__dirname,'../..'),directories={};
 for(const state of ['running','stopped']){
  const base=path.join(options.output,state),harness=path.join(base,'instances');fs.mkdirSync(base,{mode:0o700});
  const log=path.join(base,'preparation.log');let result;
  try{result=execFileSync(process.execPath,[path.join(repository,'tooling/run.mjs'),'node',path.join(repository,'tests/deployment/launcher_product_refactor_smoke.cjs'),
   '--payload',options.baseline,'--baseline-release',options.baseline,'--product-manifest',path.join(target,'release-manifest.json'),'--app-only-prepare','--start-state',state,'--scratch-base',harness,'--keep'],{encoding:'utf8',timeout:1200000,maxBuffer:16*1024*1024});fs.writeFileSync(log,result,{flag:'wx',mode:0o600});}
  catch(error){fs.writeFileSync(log,String(error.stdout||'')+'\n'+String(error.stderr||'')+'\n'+error.stack,{flag:'wx',mode:0o600});throw error;}
  const instances=fs.readdirSync(harness).map(name=>path.join(harness,name)).filter(file=>fs.existsSync(path.join(file,'harness-result.json')));assert.equal(instances.length,1);const home=instances[0],initial=json(path.join(home,'harness-result.json'));assert.equal(initial.outcome,'prepared-for-native-app-upgrade');fs.renameSync(path.join(home,'harness-result.json'),path.join(home,'baseline-preparation.json'));
  const {python,env}=runtimeOptions({...options,hermes:path.join(home,'hermes')}),appRoot=path.join(base,'baseline-app');fs.mkdirSync(appRoot);
  const platform=process.platform+'-'+process.arch,descriptor=json(path.join(options.baselineLauncher,`nora-launcher-${platform}.json`));
  execFileSync(python,['-B','-c','import runpy,sys; from pathlib import Path; runpy.run_path(sys.argv[1])["extract"](Path(sys.argv[2]),Path(sys.argv[3]),sys.argv[4])',path.join(repository,'launcher/desktop/replace-launcher.py'),path.join(options.baselineLauncher,descriptor.asset),appRoot,process.platform],{env,timeout:120000});
  const output=path.join(base,'native-app-proof'),settings={home,hermes:path.join(home,'hermes'),installRoot:path.join(home,'tavern'),port:initial.port,appRoot:application(appRoot).root,target,baseline:options.baseline,baselineLauncher:options.baselineLauncher,output,state};
  const previousIds=operationFiles(home).map(file=>json(file).operationId);launch(settings);
  if(state==='stopped')write(path.join(base,'native-stopped-precondition.json'),await settleStoppedPrecondition(settings,previousIds,{ready:()=>nativeUI(settings.appRoot,'ready',path.join(base,'native-ready-actions.json'))}));
  await prepare(settings);nativeUI(settings.appRoot,'update',path.join(output,'native-update-actions.json'));
  const deadline=Date.now()+600000;let lastError;while(Date.now()<deadline){try{await observeAfterNativeReady(output,()=>nativeUI(settings.appRoot,'ready',path.join(output,'native-reopen-ready-actions.json')));lastError=null;break;}catch(error){lastError=error;const operations=operationFiles(home).map(json).filter(op=>op.createdAt>=json(path.join(output,'checkpoint.json')).createdAt&&op.kind==='update');if(operations.some(op=>['failed','blocked','rolled-back'].includes(op.state)))throw error;await new Promise(resolve=>setTimeout(resolve,500));}}
  if(lastError)throw lastError;nativeUI(settings.appRoot,'close',path.join(output,'native-close-actions.json'));
  const end=Date.now()+120000;while(Date.now()<end&&processCensus(settings).length)await new Promise(resolve=>setTimeout(resolve,300));
  await finish(output);directories[state]=output;
 }
 return combine(directories.running,directories.stopped,path.join(options.output,'nora-upgrade-baseline-acceptance.json'));
}
function options(argv){const result={};for(let i=0;i<argv.length;i++){const name=argv[i];assert.ok(['--phase','--home','--hermes','--install-root','--port','--app-root','--target','--baseline','--baseline-launcher','--output','--state','--running','--stopped'].includes(name)&&!Object.hasOwn(result,name.slice(2)),'Unknown or duplicate native acceptance option');const value=argv[++i];assert.ok(value&&!value.startsWith('--'));result[name.slice(2)]=value;}
 const converted={};for(const [name,value]of Object.entries(result))converted[name.replace(/-([a-z])/g,(_,n)=>n.toUpperCase())]=value;if(converted.port!==undefined){converted.port=Number(converted.port);assert.ok(Number.isInteger(converted.port)&&converted.port>=1024&&converted.port<=65535);}return converted;}
async function main(){const opts=options(process.argv.slice(2));assert.ok(opts.output);let value;if(opts.phase==='run')value=await runNative(opts);else if(opts.phase==='combine')value=combine(opts.running,opts.stopped,opts.output);else if(opts.phase==='prepare')value=await prepare(opts);else if(opts.phase==='launch'){const c=json(path.join(opts.output,'checkpoint.json'));value={pid:launch(c.options)};}else if(opts.phase==='observe')value=await observe(opts.output);else if(opts.phase==='finish')value=await finish(opts.output);else throw Error('Use --phase prepare|launch|observe|finish|combine|run (native UI clicks occur between launch and observe)');console.log(JSON.stringify(value));}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={snapshotTree,assertSnapshot,assertTransition,prepare,observe,finish,application,options,launch,combine,runNative,stageTarget,runtimeOptions,settleStoppedPrecondition,runtimeProbe,processCensus,nativeUI,observeAfterNativeReady,assertPostHandoffReady};
