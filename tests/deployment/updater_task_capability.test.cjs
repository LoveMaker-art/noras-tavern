const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {pathToFileURL}=require('node:url');
const capability=require('../installer/desktop/updater-capability');
const projection=path.resolve(__dirname,'../..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
let templatePromise,templateDirectory;
after(()=>{if(templateDirectory)fs.rmSync(templateDirectory,{recursive:true,force:true});});
async function template(){
  if(templatePromise)return templatePromise;
  templatePromise=(async()=>{
    templateDirectory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-task-cap-source-')));
    const helper=await import(pathToFileURL(path.join(projection,'ops/scripts/release-source.mjs')).href);
    const {buildCommand}=await import(pathToFileURL(path.join(projection,'ops/scripts/build-commands.mjs')).href);
    const copy=(from,to)=>{
      fs.mkdirSync(to,{recursive:true,mode:0o700});
      for(const entry of fs.readdirSync(from,{withFileTypes:true})){
        if(['node_modules','assets','tests','__pycache__'].includes(entry.name))continue;
        const source=path.join(from,entry.name),target=path.join(to,entry.name);
        if(entry.isDirectory())copy(source,target);
        else if(entry.isFile())fs.copyFileSync(source,target);
      }
    };
    for(const name of ['installer','updater'])copy(path.join(projection,'ops',name),path.join(templateDirectory,'ops',name));
    for(const name of ['ops/updater/task_backend.py','ops/installer/desktop/updater-policy.js']){
      assert.equal(fs.statSync(path.join(templateDirectory,name)).isFile(),true,'The real actor closure must be present: '+name);
    }
    helper.materializeUpdaterDependencies(templateDirectory,{install:directory=>{
      const npm=buildCommand('npm',['ci','--omit=dev','--ignore-scripts','--bin-links=false','--no-audit','--no-fund']);
      execFileSync(npm.command,npm.args,{cwd:directory,stdio:'pipe',timeout:60000});
    }});
    const artifacts={};
    const visit=relative=>{
      for(const entry of fs.readdirSync(path.join(templateDirectory,relative),{withFileTypes:true})){
        const name=relative+'/'+entry.name;
        if(entry.isDirectory())visit(name);else if(entry.isFile())artifacts[name]=sha(fs.readFileSync(path.join(templateDirectory,name)));
      }
    };
    visit('ops');
    const members=helper.groupRuntimeModules(Object.keys(artifacts)).get('updater');
    const manifest={schema:'tavern-release/v2',commit:'b'.repeat(40),versions:{tavern:'2.5.2'},artifacts,
      updaterCapabilities:helper.UPDATER_CAPABILITIES,
      modules:{updater:{name:'nora-tavern-module-updater.tar.gz',sha256:'c'.repeat(64),artifacts:members}}};
    fs.writeFileSync(path.join(templateDirectory,'source-manifest.json'),JSON.stringify(manifest));
    return {directory:templateDirectory,manifest};
  })();
  return templatePromise;
}
async function fixture(t,{managed=true,backend,reader,admissionDelayMs,homeMode}={}){
  let source=await template();
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-updater-cap-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  if(backend||reader||admissionDelayMs){
    const copied=path.join(directory,'source');fs.cpSync(source.directory,copied,{recursive:true});
    const manifest=JSON.parse(JSON.stringify(source.manifest));
    const delayed=admissionDelayMs?fs.readFileSync(path.join(copied,'ops/installer/desktop/operation-cli.js'),'utf8')+'\nconst originalExecute=module.exports.execute;module.exports.execute=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,'+admissionDelayMs+'));return originalExecute(...args);};\n':null;
    for(const [name,contents] of [['ops/updater/task_backend.py',backend],['ops/installer/desktop/updater-task.js',reader],['ops/installer/desktop/operation-cli.js',delayed]])if(contents){
      fs.writeFileSync(path.join(copied,name),contents);manifest.artifacts[name]=sha(Buffer.from(contents));
    }
    fs.writeFileSync(path.join(copied,'source-manifest.json'),JSON.stringify(manifest));source={directory:copied,manifest};
  }
  const home=path.join(directory,'instance'),hermes=managed?path.join(home,'hermes'):home,install=path.join(home,'tavern');
  for(const name of [hermes,path.join(install,'tavern-updates')])fs.mkdirSync(name,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(install,'tavern-updates/installed-manifest.json'),JSON.stringify({schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.4.2'}}),{mode:0o600});
  fs.writeFileSync(path.join(install,'tavern-updates/installed.json'),JSON.stringify({schema:2,commit:'a'.repeat(40),version:'2.4.2'}),{mode:0o600});
  if(managed)fs.writeFileSync(path.join(hermes,'nora-instance.json'),JSON.stringify({schema:1,noraHome:home,hermesHome:hermes,installRoot:install,port:18799}),{mode:0o600});
  const job=path.join(home,'installer/update-jobs',crypto.randomUUID());fs.mkdirSync(job,{recursive:true,mode:0o700});
  if(homeMode!==undefined)fs.chmodSync(home,homeMode);
  assert.ok(process.env.NORA_TEST_PYTHON,'Explicit native Python is required for updater identity verification');
  const options={noraHome:home,hermesHome:hermes,installRoot:install,jobDirectory:job,port:18799,
    python:process.env.NORA_TEST_PYTHON,node:process.execPath,opsRoot:path.join(source.directory,'ops'),
    manifestPath:path.join(source.directory,'source-manifest.json'),
    venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON)),managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT};
  const staged=capability.stage(options);
  return {directory,source,home,hermes,install,job,options,...staged};
}

test('real updater identity uses a manifest-bound private snapshot with no APP or GUI resources',async t=>{
  const f=await fixture(t),receipt=await capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath});
  assert.equal(receipt.sourceCommit,f.source.manifest.commit);
  assert.equal(receipt.executable.physical,fs.realpathSync(process.execPath));
  assert.ok(receipt.sourceManifest?.sha256,'source manifest must remain an authoritative snapshot input');
  assert.equal(receipt.files['ops/installer/desktop/main.js'],undefined);
  assert.equal(receipt.files['ops/installer/desktop/preload.js'],undefined);
  assert.equal(fs.existsSync(path.join(f.home,'installer/launcher-control.json')),false);
  assert.equal(process.versions.electron,undefined);
});

test('a changed resource pointer cannot execute a file outside the manifest-owned actor closure',async t=>{
  const f=await fixture(t),foreign=path.join(f.directory,'unreviewed.py');fs.writeFileSync(foreign,'print("unreviewed")');
  const receipt=JSON.parse(fs.readFileSync(f.receiptPath));
  receipt.resources['launcher_bridge.py']={path:foreign,physical:foreign,size:fs.statSync(foreign).size,sha256:sha(fs.readFileSync(foreign))};
  fs.writeFileSync(f.receiptPath,JSON.stringify(receipt));
  await assert.rejects(capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath}),{code:'UPDATER_IDENTITY_INVALID'});
});

test('snapshot edits cannot be authorized by merely rewriting the per-file receipt hash',async t=>{
  const f=await fixture(t),receipt=JSON.parse(fs.readFileSync(f.receiptPath));
  const name='ops/installer/desktop/operation-cli.js',file=receipt.files[name].path;
  fs.appendFileSync(file,'\n// changed snapshot bytes\n');
  const data=fs.readFileSync(file);Object.assign(receipt.files[name],{size:data.length,sha256:sha(data)});
  fs.writeFileSync(f.receiptPath,JSON.stringify(receipt));
  await assert.rejects(capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath}),{code:'UPDATER_IDENTITY_INVALID'});
});

test('write-mode differences are accepted but foreign installation bindings remain rejected',async t=>{
  const f=await fixture(t);
  if(process.platform!=='win32'){
    fs.chmodSync(f.receipt.opsRoot,0o770);
    try{assert.equal((await capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath})).noraHome,f.home);}
    finally{fs.chmodSync(f.receipt.opsRoot,0o700);}
  }
  const marker=path.join(f.hermes,'nora-instance.json'),record=JSON.parse(fs.readFileSync(marker));record.installRoot=path.join(f.directory,'another-tavern');
  fs.writeFileSync(marker,JSON.stringify(record));
  await assert.rejects(capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath}),{code:'UPDATER_IDENTITY_INVALID'});
});

for(const mode of [0o755,0o770,0o2770,0o2777])test('POSIX installation mode '+mode.toString(8)+' does not prevent verified updater admission',
  {skip:process.platform==='win32'},async t=>{
    const f=await fixture(t,{managed:false,homeMode:mode});
    assert.equal((await capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath})).noraHome,f.home);
    assert.equal(fs.statSync(f.home).mode&0o7777,mode,'updater does not rewrite deployment permissions');
    assert.equal(fs.statSync(f.receipt.opsRoot).mode&0o077,0,'new snapshots keep their existing private defaults');
  });

test('deployment write permissions do not permit a linked installation target',
  {skip:process.platform==='win32'},async t=>{
    const f=await fixture(t,{managed:false,homeMode:0o2770}),actual=f.install+'-actual';
    fs.renameSync(f.install,actual);fs.symlinkSync(actual,f.install,'dir');
    try{await assert.rejects(capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath}),error=>
      error.code==='UPDATER_IDENTITY_INVALID');}
    finally{fs.unlinkSync(f.install);fs.renameSync(actual,f.install);}
  });

test('unlisted executable files cannot shadow the sealed dependency graph',async t=>{
  const f=await fixture(t),shadow=path.join(f.receipt.opsRoot,'installer/desktop/node_modules/semver/index.js');
  fs.mkdirSync(path.dirname(shadow),{recursive:true,mode:0o700});fs.writeFileSync(shadow,'throw new Error("unreviewed shadow")');
  await assert.rejects(capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath}),{code:'UPDATER_IDENTITY_INVALID'});
});

test('source-manifest changes and removed required core bytes are rejected before execution',async t=>{
  const f=await fixture(t),source=JSON.parse(fs.readFileSync(f.receipt.sourceManifest.path));
  source.commit='d'.repeat(40);fs.writeFileSync(f.receipt.sourceManifest.path,JSON.stringify(source));
  await assert.rejects(capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath}),{code:'UPDATER_IDENTITY_INVALID'});
  const second=await fixture(t);
  fs.unlinkSync(second.receipt.files['ops/installer/operation_control.py'].path);
  await assert.rejects(capability.validate({receiptPath:second.receiptPath,currentExecutable:process.execPath}),{code:'UPDATER_IDENTITY_INVALID'});
});

test('read-only queries survive a legitimate changed install and missing old Python without weakening writer or closure checks',async t=>{
  const f=await fixture(t,{managed:false}),receipt=JSON.parse(fs.readFileSync(f.receiptPath));
  fs.writeFileSync(path.join(f.install,'tavern-updates/installed.json'),JSON.stringify({schema:2,commit:'b'.repeat(40),version:'2.5.2'}));
  receipt.python.path=receipt.python.physical=path.join(f.directory,'removed-old-python');
  receipt.readOnly=true; // An untrusted stored flag never downgrades a writer.
  fs.writeFileSync(f.receiptPath,JSON.stringify(receipt));
  assert.equal((await capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath,readOnly:true})).noraHome,f.home);
  await assert.rejects(capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath}),{code:'UPDATER_IDENTITY_INVALID'});
  const operationId=crypto.randomUUID(),file=path.join(f.home,'installer/operations',operationId,'operation.json');
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  capability.atomic(file,{operationId,state:'succeeded',sequence:1,verification:'confirmed'});
  capability.atomic(path.join(f.job,'operation-ref.json'),{operationId});
  const executable=process.execPath;
  try{
    process.execPath=path.join(f.directory,'different-reader/Electron');
    assert.equal((await require('../installer/desktop/updater-task').query(f.home,path.basename(f.job))).status,'succeeded');
  }finally{process.execPath=executable;}
  const environment={...process.env,HERMES_HOME:f.hermes,TAVERN_NODE_EXECUTABLE:process.execPath};delete environment.NODE_PATH;
  const queried=JSON.parse(execFileSync(process.env.NORA_TEST_PYTHON,['-I','-S','-B',
    path.join(projection,'ops/skills/system/tavern-updater/scripts/update.py'),'--status'],{env:environment,encoding:'utf8',timeout:15000}));
  assert.equal(queried.status,'succeeded');assert.equal(queried.settled,true);assert.equal(queried.busy,false);
  fs.appendFileSync(receipt.files['ops/installer/desktop/os-lock.js'].path,'\n// changed native-query module\n');
  await assert.rejects(capability.validate({receiptPath:f.receiptPath,currentExecutable:process.execPath,readOnly:true}),{code:'UPDATER_IDENTITY_INVALID'});
});

test('a newly installed verified reader queries the same old-protocol job and damaged installed code cannot fake completion',async t=>{
  const oldReader="let x='';process.stdin.on('data',b=>x+=b);process.stdin.on('end',()=>console.log(JSON.stringify({status:'succeeded',requestId:JSON.parse(x).requestId})));\n";
  const f=await fixture(t,{managed:false,reader:oldReader}),current=await template(),operationId=crypto.randomUUID();
  const file=path.join(f.home,'installer/operations',operationId,'operation.json');fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  capability.atomic(file,{operationId,state:'succeeded',sequence:1,verification:'confirmed'});
  capability.atomic(path.join(f.job,'operation-ref.json'),{operationId});
  const installedOps=path.join(f.install,'apps/tavern-ops');fs.mkdirSync(path.dirname(installedOps),{recursive:true,mode:0o700});
  fs.cpSync(path.join(current.directory,'ops'),installedOps,{recursive:true});
  fs.writeFileSync(path.join(f.install,'tavern-updates/installed-manifest.json'),JSON.stringify(current.manifest));
  fs.writeFileSync(path.join(f.install,'tavern-updates/installed.json'),JSON.stringify({version:'2.5.2',commit:current.manifest.commit}));
  const environment={...process.env,HERMES_HOME:f.hermes,TAVERN_NODE_EXECUTABLE:process.execPath};delete environment.NODE_PATH;delete environment.TAVERN_DATA_ROOT;
  const args=['-I','-S','-B',path.join(projection,'ops/skills/system/tavern-updater/scripts/update.py'),'--status'];
  const reply=JSON.parse(execFileSync(process.env.NORA_TEST_PYTHON,args,{env:environment,encoding:'utf8',timeout:15000}));
  assert.equal(reply.status,'succeeded');assert.equal(reply.settled,true);assert.equal(reply.operation.operationId,operationId);
  assert.deepEqual(fs.readdirSync(path.join(f.home,'installer/update-jobs')),[path.basename(f.job)],'query cannot create a substitute job');
  fs.appendFileSync(path.join(installedOps,'installer/desktop/os-lock.js'),'\n// damaged installed closure\n');
  let failed;
  try{execFileSync(process.env.NORA_TEST_PYTHON,args,{env:environment,encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']});}catch(error){failed=error;}
  assert.equal(failed?.status,1);assert.equal(JSON.parse(failed.stdout).status,'inspection-required');
});

// Only the backend's responses are controlled. The detached worker, capability
// checks, release selector, OperationController, native guard and final record
// are production code; this does not claim real program replacement acceptance.
const controlledBackend=`import argparse,json,os,sys,time
from pathlib import Path
p=argparse.ArgumentParser()
for name in ('nora-home','hermes-home','install-root','port','release-dir','operation-id','kind','version','service','tag'): p.add_argument('--'+name)
p.add_argument('--allow-candidate',action='store_true')
p.add_argument('command'); a=p.parse_args(); root=Path(a.nora_home); state_file=root/'controlled-backend.json'
state=json.loads(state_file.read_text()) if state_file.exists() else {'updated':False,'count':0}
def facts():
 return {'standalone':True,'systemReady':True,'gatewayManaged':False,'running':False,'version':'2.5.2' if state['updated'] else '2.4.2','commit':('b' if state['updated'] else 'a')*40,'port':int(a.port),'noraHome':a.nora_home,'hermesHome':a.hermes_home,'installRoot':a.install_root}
if a.command in ('status','repair-preflight'): result=facts()
elif a.command=='plan-update': result={'version':'2.5.2','archives':[]}
elif a.command=='operation-effects':
 result={'effects':{'effectState':'changed' if state['updated'] else 'untouched','recoveryOutcome':'not-required','canResume':state['updated'],'canRecover':False,'operationId':state.get('operationId'),'status':'committed' if state['updated'] else 'none'}}
elif a.command=='update':
 gate=getattr(sys,'_nora_operation_delegate',None); assert gate is not None; gate.assert_active()
 state['count']+=1; state['operationId']=gate.operation_id; state_file.write_text(json.dumps(state))
 (root/'controlled-update-started.json').write_text(json.dumps({'pid':os.getpid(),'operationId':gate.operation_id}))
 deadline=time.monotonic()+15
 while not (root/'finish-controlled-update').exists():
  if time.monotonic()>deadline: raise RuntimeError('controlled completion was not requested')
  time.sleep(.03)
 state['updated']=True; state_file.write_text(json.dumps(state)); result={**facts(),'updateVerified':True}
else: raise RuntimeError('Unexpected controlled backend command: '+a.command)
print(json.dumps({'event':'result',**result}),flush=True)
`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=15000){
  const deadline=Date.now()+timeout;
  while(!await check()){if(Date.now()>deadline)throw new Error('Independent updater condition was not reached');await pause(30);}
}
function processBirth(pid){
  return JSON.parse(execFileSync(process.env.NORA_TEST_PYTHON,['-B','-c',
    'import json,psutil,sys;p=psutil.Process(int(sys.argv[1]));print(json.dumps({"pid":p.pid,"birth":p.create_time(),"argv":p.cmdline()}))',String(pid)],{encoding:'utf8',timeout:5000}));
}
function processActive(identity){
  return execFileSync(process.env.NORA_TEST_PYTHON,['-B','-c',
    'import psutil,sys\ntry:\n p=psutil.Process(int(sys.argv[1]));active=abs(p.create_time()-float(sys.argv[2]))<.001 and p.is_running() and p.status()!=psutil.STATUS_ZOMBIE\nexcept psutil.NoSuchProcess: active=False\nprint("yes" if active else "no")',
    String(identity.pid),String(identity.birth)],{encoding:'utf8',timeout:5000}).trim()==='yes';
}

test('detached production worker finishes its real controller after the caller dies and duplicate request does not execute again',
  {timeout:45000},async t=>{
  const f=await fixture(t,{managed:false,backend:controlledBackend}),requestId=path.basename(f.job);
  const userFile=path.join(f.home,'user-story.json');fs.writeFileSync(userFile,'{"chat":"preserved","world":"same","model":"placeholder"}');
  const userDigest=sha(fs.readFileSync(userFile)),release=path.join(f.directory,'local-release');fs.mkdirSync(release);
  const bootstrap='controlled backend fixture does not execute this bootstrap\n';
  const manifest={schema:'tavern-release/v2',candidate:false,commit:'b'.repeat(40),versions:{tavern:'2.5.2'},
    updaterCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},
    bootstrap:{managedComponents:1,minimumLauncherVersion:'99.0.0',sha256:sha(Buffer.from(bootstrap))}};
  const bytes={'release-manifest.json':JSON.stringify(manifest),'tavern-updater-bootstrap.py':bootstrap};
  bytes.SHA256SUMS=Object.entries(bytes).map(([name,data])=>sha(Buffer.from(data))+'  '+name).join('\n');
  for(const [name,data] of Object.entries(bytes))fs.writeFileSync(path.join(release,name),data);
  const bridge=f.receipt.resources['launcher_bridge.py'].path;
  capability.atomic(path.join(f.job,'request.json'),{requestId,request:{schema:'nora-cli-request/1',kind:'update',stdin:'',argv:[bridge,
    '--nora-home',f.home,'--hermes-home',f.hermes,'--install-root',f.install,'--port','18799','update','--release-dir',release]}});
  const actor=path.join(f.receipt.opsRoot,'installer/desktop/updater-task.js'),ready=path.join(f.directory,'caller-ready.json');
  const workerSource=`globalThis.fetch=async()=>{throw new Error('Acceptance blocks external telemetry/network');};
require(process.argv[1]).worker(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});`;
  const callerSource=`const fs=require('node:fs'),{spawn}=require('node:child_process');const log=fs.openSync(process.argv[4],'a');
const child=spawn(process.execPath,['-e',process.argv[1],process.argv[2],process.argv[3]],{detached:true,stdio:['ignore',log,log]});
child.unref();child.once('spawn',()=>fs.writeFileSync(process.argv[5],JSON.stringify({pid:child.pid})));setInterval(()=>{},1000);`;
  const caller=spawn(process.execPath,['-e',callerSource,workerSource,actor,f.receiptPath,path.join(f.job,'worker.log'),ready],{stdio:'ignore'});
  const closed=once(caller,'close'),task=require('../installer/desktop/updater-task'),lock=require('../installer/desktop/operation-lock');
  let identity;
  try{
    await until(()=>fs.existsSync(ready));identity=processBirth(JSON.parse(fs.readFileSync(ready)).pid);
    assert.ok(identity.argv.includes(f.receiptPath));
    await until(()=>fs.existsSync(path.join(f.home,'controlled-update-started.json')));
    const before=task.status(f.home,requestId);assert.equal(before.status,'in-progress');assert.equal(before.settled,false);
    assert.equal((await lock.probe({directory:path.join(f.home,'installer')})).busy,true);
    caller.kill('SIGKILL');await closed;
    assert.equal(processActive(identity),true,'independent owner remains alive after its submitter is killed');
    const duplicate=await task.submit({...f.options,requestId});
    assert.equal(duplicate.operation.operationId,before.operation.operationId);
    fs.writeFileSync(path.join(f.home,'finish-controlled-update'),'finish');
    await until(()=>task.status(f.home,requestId).status==='succeeded');
    const result=task.status(f.home,requestId);
    assert.equal(result.operation.operationId,before.operation.operationId);assert.equal(result.operation.verification,'confirmed');
    assert.equal(result.operation.result.updateVerified,true);assert.equal(result.operation.result.version,'2.5.2');
    assert.equal(result.operation.target.releasePlan.client,'updater');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'controlled-backend.json'))).count,1);
    assert.equal((await task.submit({...f.options,requestId})).operation.operationId,before.operation.operationId);
    assert.equal(sha(fs.readFileSync(userFile)),userDigest);
    await until(async()=>!(await lock.probe({directory:path.join(f.home,'installer')})).busy);
    await until(()=>!processActive(identity));
    assert.equal(process.versions.electron,undefined);
  }catch(error){
    const log=path.join(f.job,'worker.log');if(fs.existsSync(log))error.message+='\n'+fs.readFileSync(log,'utf8').slice(-8000);throw error;
  }finally{
    fs.writeFileSync(path.join(f.home,'finish-controlled-update'),'finish');
    if(caller.exitCode===null&&caller.signalCode===null){caller.kill('SIGKILL');await closed;}
    if(identity)await until(()=>!processActive(identity),20000);
    await until(async()=>!(await lock.probe({directory:path.join(f.home,'installer')})).busy,10000);
  }
});

test('a submitter killed before admission is reported interrupted instead of waiting forever', {timeout:15000},async t=>{
  const f=await fixture(t,{managed:false}),requestId=crypto.randomUUID(),ready=path.join(f.directory,'before-admission.json');
  const hook=path.join(f.directory,'pause-publication.cjs');
  fs.writeFileSync(hook,`const fs=require('node:fs'),path=require('node:path'),original=fs.renameSync;
fs.renameSync=function(source,directory,...args){const result=original.call(this,source,directory,...args);
 if(path.resolve(directory)===process.env.NORA_PAUSE_JOB){fs.writeFileSync(process.env.NORA_PAUSE_READY,'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
 return result;};`);
  const entry=path.resolve(__dirname,'../installer/desktop/updater-task.js');
  const child=spawn(process.execPath,['--require',hook,entry],{env:{...process.env,
    NORA_PAUSE_JOB:path.join(f.home,'installer/update-jobs',requestId),NORA_PAUSE_READY:ready},stdio:['pipe','ignore','pipe']});
  const closed=once(child,'close');child.stdin.end(JSON.stringify({...f.options,requestId,action:'update'}));
  try{await until(()=>fs.existsSync(ready));child.kill('SIGKILL');await closed;
    const reply=await require('../installer/desktop/updater-task').query(f.home,requestId);
    assert.equal(reply.status,'interrupted');assert.equal(reply.settled,true);assert.equal(reply.busy,false);
    assert.equal(reply.operation,undefined,'no canonical operation or file effects were admitted');
    const waited=await require('../installer/desktop/updater-task').wait(f.home,requestId,{pollMs:10});
    assert.equal(waited.status,'interrupted');
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
});

test('a killed read-only version check leaves no durable update job', {timeout:20000},async t=>{
  const f=await fixture(t,{managed:false}),hook=path.join(f.directory,'stop-at-query.cjs');
  fs.writeFileSync(hook,`globalThis.fetch=async()=>{process.exit(47);};`);
  const before=fs.readdirSync(path.join(f.home,'installer/update-jobs'));
  const entry=path.resolve(__dirname,'../installer/desktop/updater-task.js');
  const child=spawn(process.execPath,['--require',hook,entry],{env:process.env,stdio:['pipe','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const closed=once(child,'close');child.stdin.end(JSON.stringify({...f.options,action:'check'}));
  const [code]=await closed;assert.equal(code,47,stderr);
  assert.deepEqual(fs.readdirSync(path.join(f.home,'installer/update-jobs')),before,
    'version lookup must not publish a task that an interrupted reader cannot remove');
});

test('repeated status queries use their current reader and do not rehash the original Node executable',async t=>{
  const f=await fixture(t,{managed:false}),task=require('../installer/desktop/updater-task'),operationId=crypto.randomUUID();
  const file=path.join(f.home,'installer/operations',operationId,'operation.json');fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  capability.atomic(file,{operationId,state:'succeeded',sequence:1,verification:'confirmed'});
  capability.atomic(path.join(f.job,'operation-ref.json'),{operationId});
  let executableReads=0;const readFileSync=fs.readFileSync;
  fs.readFileSync=function(file,...args){if(path.resolve(String(file))===f.receipt.executable.physical)executableReads++;return readFileSync.call(this,file,...args);};
  try{for(let i=0;i<3;i++)assert.equal((await task.query(f.home,path.basename(f.job))).status,'succeeded');}
  finally{fs.readFileSync=readFileSync;}
  assert.equal(executableReads,0,'a read-only task query must not hash an obsolete writer executable');
});

test('a worker cannot mutate files if its submitter dies before acknowledging handoff', {timeout:20000},async t=>{
  const f=await fixture(t,{managed:false,backend:controlledBackend}),ready=path.join(f.directory,'unacknowledged-worker.json');
  const requestId=path.basename(f.job),entry=path.join(f.receipt.opsRoot,'installer/desktop/updater-task.js');
  capability.atomic(path.join(f.job,'request.json'),{requestId,request:{schema:'nora-cli-request/1',kind:'update',stdin:'',argv:[]}});
  const parentSource=`const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,[process.argv[1],'--worker',process.argv[2]],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.unref();child.on('message',message=>{if(message.event==='updater-ready')fs.writeFileSync(process.argv[3],JSON.stringify({pid:child.pid}));});
setInterval(()=>{},1000);`;
  const parent=spawn(process.execPath,['-e',parentSource,entry,f.receiptPath,ready],{stdio:'ignore'}),closed=once(parent,'close');
  let identity;
  try{
    await until(()=>fs.existsSync(ready));identity=processBirth(JSON.parse(fs.readFileSync(ready)).pid);
    const task=require('../installer/desktop/updater-task');
    assert.equal((await task.query(f.home,requestId)).status,'submitting');
    assert.equal(fs.existsSync(path.join(f.job,'operation-ref.json')),false);
    parent.kill('SIGKILL');await closed;await until(()=>!processActive(identity));
    const result=await task.query(f.home,requestId);
    assert.equal(result.status,'error');assert.equal(result.settled,true);assert.equal(result.busy,false);
    assert.equal(result.code,'UPDATER_SUBMISSION_INTERRUPTED');
    assert.equal(fs.existsSync(path.join(f.home,'controlled-backend.json')),false);
    assert.equal(fs.existsSync(path.join(f.job,'operation-ref.json')),false);
  }finally{if(parent.exitCode===null&&parent.signalCode===null){parent.kill('SIGKILL');await closed;}if(identity)await until(()=>!processActive(identity));}
});

test('an orphan without admission is never settled while a real native writer is held',async t=>{
  const f=await fixture(t,{managed:false}),task=require('../installer/desktop/updater-task');
  capability.atomic(path.join(f.job,'submitter.json'),{pid:process.pid,creationTime:1,precisionSeconds:1});
  const lease=await require('../installer/desktop/operation-lock').acquire({directory:path.join(f.home,'installer'),operationId:crypto.randomUUID(),ownerEpoch:1});
  try{const result=await task.query(f.home,path.basename(f.job));assert.equal(result.status,'in-progress');assert.equal(result.settled,false);assert.equal(result.busy,true);}
  finally{await lease.release();}
  const result=await task.query(f.home,path.basename(f.job));assert.equal(result.status,'interrupted');assert.equal(result.settled,true);
});

test('legacy admission without a process identity fails closed with a bounded query result',async t=>{
  const f=await fixture(t,{managed:false}),task=require('../installer/desktop/updater-task');
  const result=await task.query(f.home,path.basename(f.job));
  assert.equal(result.status,'inspection-required');assert.equal(result.settled,false);assert.equal(result.busy,null);
  await assert.rejects(task.wait(f.home,path.basename(f.job)),{code:'UPDATER_INSPECTION_REQUIRED'});
  assert.ok(fs.existsSync(f.receiptPath),'unknown old job evidence is preserved');
});

for(const caller of ['in-process','extracted-bootstrap'])test('the public submit path acknowledges the real worker and a later operation remains usable: '+caller, {timeout:20000},async t=>{
  const f=await fixture(t,{managed:false,backend:controlledBackend}),task=require('../installer/desktop/updater-task');
  const release=path.join(f.directory,'public-submit-release');fs.mkdirSync(release);
  const bootstrap='controlled backend fixture does not execute bootstrap\n';
  const manifest={schema:'tavern-release/v2',candidate:false,commit:'b'.repeat(40),versions:{tavern:'2.5.2'},
    updaterCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},
    bootstrap:{managedComponents:1,minimumLauncherVersion:'99.0.0',sha256:sha(Buffer.from(bootstrap))}};
  const files={'release-manifest.json':JSON.stringify(manifest),'tavern-updater-bootstrap.py':bootstrap};
  files.SHA256SUMS=Object.entries(files).map(([name,data])=>sha(Buffer.from(data))+'  '+name).join('\n');
  for(const [name,data] of Object.entries(files))fs.writeFileSync(path.join(release,name),data);
  const requestId=crypto.randomUUID(),user=path.join(f.home,'world-and-chat.json');fs.writeFileSync(user,'{"chat":"same","world":"same","key":"placeholder"}');
  const digest=sha(fs.readFileSync(user));
  let admitted;
  try{
    const options={...f.options,requestId,action:'update',releaseDir:release,allowCandidate:true};
    if(caller==='in-process')admitted=await task.submit(options);
    else{
      const environment={...process.env};for(const name of Object.keys(environment))if(name.startsWith('NORA_OPERATION_')||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(name))delete environment[name];
      // Same runner layout and explicit external manifest as bootstrap.py's
      // extract_runner -> task.py --runner-root --runner-manifest handoff.
      const entry=path.join(f.source.directory,'ops/installer/desktop/updater-task.js');
      assert.equal(fs.existsSync(path.join(f.source.directory,'release-manifest.json')),false);
      admitted=JSON.parse(execFileSync(process.execPath,[entry],{env:environment,input:JSON.stringify(options),encoding:'utf8',timeout:15000}));
    }
    assert.ok(admitted.operation?.operationId);assert.equal(admitted.settled,false);
    await until(()=>fs.existsSync(path.join(f.home,'controlled-update-started.json')));
    fs.writeFileSync(path.join(f.home,'finish-controlled-update'),'finish');
    const result=await task.wait(f.home,requestId,{pollMs:25});
    assert.equal(result.status,'succeeded');assert.equal(result.operation.verification,'confirmed');
    if(caller==='extracted-bootstrap'){
      const environment={...process.env};delete environment.NODE_PATH;delete environment.NODE_OPTIONS;delete environment.ELECTRON_RUN_AS_NODE;
      const entry=path.join(f.source.directory,'ops/installer/desktop/updater-task.js');
      for(const action of ['status','wait']){
        const reply=JSON.parse(execFileSync(process.execPath,[entry],{env:environment,input:JSON.stringify({...options,action}),encoding:'utf8',timeout:15000}));
        assert.equal(reply.status,'succeeded');assert.equal(reply.settled,true);
      }
    }
    const lease=await require('../installer/desktop/operation-lock').acquire({directory:path.join(f.home,'installer'),operationId:crypto.randomUUID(),ownerEpoch:1});
    await lease.release();assert.equal(sha(fs.readFileSync(user)),digest);
  }finally{fs.writeFileSync(path.join(f.home,'finish-controlled-update'),'finish');if(admitted?.operation)await task.wait(f.home,requestId,{pollMs:25});}
});

for(const outcome of ['complete','worker-dies'])test('bounded slow admission remains a queryable pending request: '+outcome,{timeout:20000},async t=>{
  const f=await fixture(t,{managed:false,backend:controlledBackend,admissionDelayMs:500}),task=require('../installer/desktop/updater-task');
  const requestId=crypto.randomUUID(),release=path.join(f.directory,'slow-admission-release');fs.mkdirSync(release);
  const bootstrap='controlled backend fixture does not execute bootstrap\n';
  const manifest={schema:'tavern-release/v2',candidate:false,commit:'b'.repeat(40),versions:{tavern:'2.5.2'},
    updaterCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},
    bootstrap:{managedComponents:1,minimumLauncherVersion:'99.0.0',sha256:sha(Buffer.from(bootstrap))}};
  const files={'release-manifest.json':JSON.stringify(manifest),'tavern-updater-bootstrap.py':bootstrap};
  files.SHA256SUMS=Object.entries(files).map(([name,data])=>sha(Buffer.from(data))+'  '+name).join('\n');
  for(const [name,data] of Object.entries(files))fs.writeFileSync(path.join(release,name),data);
  const result=await task.submit({...f.options,requestId,action:'update',releaseDir:release,allowCandidate:true},{admissionWaitMs:40});
  const job=path.join(f.home,'installer/update-jobs',requestId),identity=processBirth(JSON.parse(fs.readFileSync(path.join(job,'worker.json'))).pid);
  try{
    assert.equal(result.status,'submitting');assert.equal(result.settled,false);assert.equal(result.requestId,requestId);
    assert.equal(result.operation,undefined,'pending admission must never pretend an operation was admitted');
    if(outcome==='worker-dies'){
      process.kill(identity.pid,'SIGKILL');await until(()=>!processActive(identity));
      const ended=await task.query(f.home,requestId);assert.equal(ended.status,'interrupted');assert.equal(ended.settled,true);assert.equal(ended.busy,false);
      assert.equal(fs.existsSync(path.join(f.home,'controlled-backend.json')),false);
    }else{
      await until(()=>fs.existsSync(path.join(f.home,'controlled-update-started.json')));
      fs.writeFileSync(path.join(f.home,'finish-controlled-update'),'finish');
      const ended=await task.wait(f.home,requestId,{pollMs:25});assert.equal(ended.status,'succeeded');assert.equal(ended.operation.verification,'confirmed');
    }
  }finally{
    fs.writeFileSync(path.join(f.home,'finish-controlled-update'),'finish');
    await until(()=>!processActive(identity));
  }
});

test('Nora version checks return the decision without internal program manifests or execution plans',()=>{
  const {checkResult}=require('../installer/desktop/updater-task');
  const reply=checkResult({current:'2.4.2',latest:'v2.5.2',state:'available',available:true,installable:true,
    updateSupported:true,checkedAt:'2026-10-16T00:00:00.000Z',metadataSource:'network',latestConfirmed:true,
    compatibilityError:'',releasePlan:{releaseManifestBytes:'x'.repeat(1024*1024),operationDirectory:'/private/internal'},
    launcherManifest:{minimumLauncherVersion:'2.2.2'},privateFutureField:'not a caller contract'});
  assert.equal(reply.available,true);assert.equal(reply.current,'2.4.2');assert.equal(reply.latest,'v2.5.2');
  assert.equal(reply.latestConfirmed,true);assert.equal(reply.compatibilityError,'');
  assert.equal(Object.hasOwn(reply,'releasePlan'),false);assert.equal(Object.hasOwn(reply,'launcherManifest'),false);
  assert.equal(Object.hasOwn(reply,'privateFutureField'),false);assert.ok(Buffer.byteLength(JSON.stringify(reply))<2048);
});

test('public status and wait cannot mistake an intermediate failed record for a completed task', {timeout:15000},async t=>{
  const f=await fixture(t,{managed:false}),task=require('../installer/desktop/updater-task');
  const requestId=path.basename(f.job),operationId=crypto.randomUUID(),directory=path.join(f.home,'installer');
  const lock=require('../installer/desktop/operation-lock'),lease=await lock.acquire({directory,operationId,ownerEpoch:1});
  t.after(()=>lease.release());
  const file=path.join(directory,'operations',operationId,'operation.json');
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  capability.atomic(path.join(f.job,'operation-ref.json'),{operationId});
  const record={schema:'nora-operation/1',operationId,requestId,state:'failed',stageId:'recovering',sequence:1,ownerEpoch:1,
    effectState:'unknown',recoveryOutcome:'recovery-required',verification:'unconfirmed'};
  capability.atomic(file,record);
  let returned=false,waiting;
  try{
    const during=task.status(f.home,requestId);
    assert.equal(during.status,'in-progress');assert.equal(during.busy,true);assert.equal(during.settled,false);
    assert.equal(during.operation.state,'failed','the canonical failure remains available for diagnostics');
    const environment={...process.env};delete environment.NODE_PATH;
    const cli=JSON.parse(execFileSync(process.execPath,[f.receipt.files['ops/installer/desktop/updater-task.js'].path],
      {input:JSON.stringify({action:'status',noraHome:f.home,requestId}),env:environment,encoding:'utf8',timeout:10000}));
    assert.equal(cli.status,'in-progress');assert.equal(cli.settled,false);assert.equal(cli.busy,true);
    waiting=task.wait(f.home,requestId,{pollMs:10}).then(value=>{returned=true;return value;});
    await pause(50);assert.equal(returned,false,'wait must not return while the actual writer still owns recovery');
    capability.atomic(file,{...record,state:'rolled-back',sequence:2,effectState:'restored',recoveryOutcome:'restored-and-verified',verification:'confirmed'});
    await lease.release();
    const final=await waiting;
    assert.equal(final.status,'rolled-back');assert.equal(final.settled,true);assert.equal(final.busy,false);
    assert.equal(final.operation.verification,'confirmed');
  }finally{await lease.release();if(waiting)await waiting;}
});

module.exports={template,fixture};

test('a fresh admission job reconnects the same canonical request without erasing old admission evidence',async t=>{
  const f=await fixture(t,{managed:false}),task=require('../installer/desktop/updater-task');
  const canonicalId=crypto.randomUUID(),operationId=crypto.randomUUID();
  capability.atomic(path.join(f.job,'request.json'),{requestId:path.basename(f.job),operationRequestId:canonicalId});
  const oldError=path.join(f.job,'admission-error.json');capability.atomic(oldError,{code:'old-admission-error'});
  const before=fs.readFileSync(oldError);
  const file=path.join(f.home,'installer/operations',operationId,'operation.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  capability.atomic(file,{schema:'nora-operation/1',operationId,requestId:canonicalId,state:'succeeded',sequence:2,
    effectState:'changed',verification:'confirmed',recoveryOutcome:'not-required'});
  const status=task.status(f.home,path.basename(f.job));
  assert.equal(status.operation.operationId,operationId);assert.equal(status.operation.requestId,canonicalId);
  assert.equal(status.status,'succeeded');assert.equal(status.settled,true);assert.deepEqual(fs.readFileSync(oldError),before);
});

test('a retry submission cannot publish its previous terminal result before this attempt is admitted',async t=>{
  const f=await fixture(t,{managed:false}),task=require('../installer/desktop/updater-task');
  const requestId=path.basename(f.job),canonicalId=crypto.randomUUID(),operationId=crypto.randomUUID();
  capability.atomic(path.join(f.job,'request.json'),{requestId,operationRequestId:canonicalId,
    request:{operationId,snapshotSequence:13,kind:'update'}});
  capability.atomic(path.join(f.job,'worker.json'),await require('../installer/desktop/operation-delegate').creationIdentity());
  const file=path.join(f.home,'installer/operations',operationId,'operation.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  const previous={schema:'nora-operation/1',operationId,requestId:canonicalId,state:'rolled-back',sequence:13,
    effectState:'restored',verification:'confirmed',recoveryOutcome:'restored-and-verified'};
  capability.atomic(file,previous);
  const pending=await task.query(f.home,requestId);
  assert.equal(pending.settled,false,'the previous failure is not this retry result');
  assert.equal(pending.status,'submitting');assert.equal(pending.operation,undefined);
  capability.atomic(file,{...previous,state:'succeeded',sequence:22,effectState:'changed',recoveryOutcome:'not-required'});
  assert.equal((await task.query(f.home,requestId)).settled,false,'another canonical observation is not this attempt admission');
  capability.atomic(path.join(f.job,'operation-ref.json'),{operationId});
  const completed=await task.wait(f.home,requestId,{pollMs:5});
  assert.equal(completed.status,'succeeded');assert.equal(completed.settled,true);assert.equal(completed.operation.operationId,operationId);
});

test('reader checks a namespaced Windows drive root through its equivalent absolute drive path',async t=>{
  const f=await fixture(t,{managed:false}),win=path.win32,prefix='\\\\?\\C:\\acceptance',drive='\\\\?\\C:\\',seen=[];
  const translate=file=>{
    seen.push(file);
    if(file===drive||file===drive.slice(0,-1))throw Object.assign(new Error('EISDIR lstat C:'),{code:'EISDIR'});
    if(file==='C:\\')return f.directory;
    assert.ok(file===prefix||file.startsWith(prefix+'\\'),file);
    return path.join(f.source.directory,...file.slice(prefix.length).split('\\').filter(Boolean));
  };
  const adapter=Object.create(fs);
  for(const method of ['lstatSync','readFileSync','readdirSync'])adapter[method]=(file,...args)=>fs[method](translate(file),...args);
  const file=require.resolve('../installer/desktop/updater-capability'),nativeRequire=require('node:module').createRequire(file);
  const context={module:{exports:{}},process:{platform:'win32',arch:'x64'},require:name=>name==='node:fs'?adapter:name==='node:path'?win:nativeRequire(name)};
  require('node:vm').runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  const result=context.module.exports.verifyReader({opsRoot:prefix+'\\ops',manifestPath:prefix+'\\source-manifest.json'});
  assert.equal(result.opsRoot,prefix+'\\ops');assert.ok(seen.includes('C:\\'));assert.equal(seen.includes(drive),false);
});
