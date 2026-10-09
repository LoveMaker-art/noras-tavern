const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn,execFile } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');

const modulePath = path.resolve(__dirname, '../installer/desktop/operation-lock.js');
const helperPath = process.env.NORA_TEST_OPERATION_HELPER || path.resolve(__dirname, '../installer/operation_control.py');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a fresh runtime bootstrap acknowledges its actual process before examining payload bytes',
  {timeout:180000},async()=>{
  const {acquire}=require(modulePath);
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-bootstrap-identity-')));
  const directory=path.join(root,'installer'),hermes=path.join(root,'hermes'),payload=path.join(root,'payload');
  const temporary=path.join(root,'tmp');
  for(const folder of [directory,payload,temporary])fs.mkdirSync(folder);
  fs.writeFileSync(path.join(payload,'nora-hermes-runtime.json'),JSON.stringify({schema:0,platform:process.platform,arch:process.arch}));
  const env={HOME:hermes,USERPROFILE:hermes,HERMES_HOME:hermes,NORA_HERMES_HOME:hermes,
    NORA_TAVERN_HOME:root,TAVERN_DATA_ROOT:path.join(root,'tavern'),NORA_INSTALLER_DIRECTORY:directory,
    APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),
    TMP:temporary,TEMP:temporary,TMPDIR:temporary,XDG_CACHE_HOME:path.join(root,'cache'),
    SystemRoot:process.env.SystemRoot||'',WINDIR:process.env.WINDIR||'',COMSPEC:process.env.COMSPEC||'',
    PATH:[path.join(hermes,'node/bin'),path.join(hermes,'node'),path.join(hermes,'hermes-agent/venv/bin'),
      path.join(hermes,'hermes-agent/venv/Scripts'),process.platform==='win32'?process.env.PATH||'':'/usr/bin:/bin:/usr/sbin:/sbin'].join(path.delimiter)};
  const operationId=crypto.randomUUID();
  const lease=await acquire({directory,operationId,ownerEpoch:1});let child;
  try {
    child=lease.spawn(process.execPath,[path.resolve(path.dirname(modulePath),'runtime-worker.js'),payload,root,hermes],
      {kind:'runtime-bootstrap',env,cwd:path.resolve(__dirname,'../..'),windowsHide:true});
    let stdout='',stderr='';
    child.stdout.on('data',value=>{stdout+=value;if(stdout.length>32768)stdout=stdout.slice(-32768);});
    child.stderr.on('data',value=>{stderr+=value;if(stderr.length>32768)stderr=stderr.slice(-32768);});
    const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal}));});
    child.stdin.end();const end=await ended;
    const job=(await lease.snapshot()).jobs.find(value=>value.jobId===child.jobId);
    if(process.platform==='win32'&&job?.delegation.identityStatus!=='reported') {
      const profile=path.join(directory,'operations',operationId,'bootstrap-profile');
      const profileEnv={HOME:profile,USERPROFILE:profile,HERMES_HOME:profile,
        APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),
        TMP:path.join(profile,'tmp'),TEMP:path.join(profile,'tmp'),TMPDIR:path.join(profile,'tmp'),XDG_CACHE_HOME:path.join(profile,'cache')};
      const lean={...env,...profileEnv};
      const queryEnvironment=async(name,environment)=>{
        const began=Date.now();
        return await new Promise(resolve=>{
          const query=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
            `([DateTimeOffset](Get-Process -Id ${process.pid}).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`],
            {env:environment,windowsHide:true,timeout:8000},(error,output,errors)=>{
              console.log('[DEBUG-bootstrap]',JSON.stringify({name,elapsedMs:Date.now()-began,code:error?.code,signal:error?.signal,
                stdout:output.slice(-2048),stderr:errors.slice(-2048)}));resolve(!error&&Number(output.trim())>0);
            });query.stdin?.end();
        });
      };
      const names=['SystemDrive','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles',
        'CommonProgramFiles(x86)','CommonProgramW6432','ProgramW6432','PSModulePath','OS','PATHEXT',
        'NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','ALLUSERSPROFILE','COMPUTERNAME','USERNAME',
        'USERDOMAIN','USERDOMAIN_ROAMINGPROFILE','HOMEDRIVE','HOMEPATH','PUBLIC'];
      let selected=names.filter(name=>process.env[name]!==undefined);
      const add=keys=>({...lean,...Object.fromEntries(keys.map(name=>[name,process.env[name]]))});
      if(await queryEnvironment('system-variables',add(selected))) {
        while(selected.length>1) {
          const split=Math.ceil(selected.length/2),left=selected.slice(0,split),right=selected.slice(split);
          if(await queryEnvironment('system-left:'+left.join(','),add(left)))selected=left;
          else if(await queryEnvironment('system-right:'+right.join(','),add(right)))selected=right;
          else break;
        }
        console.log('[DEBUG-bootstrap] required-system-variables',JSON.stringify(selected));
      } else {
        await queryEnvironment('inherited',process.env);
        await queryEnvironment('inherited-profile',{...process.env,...lean});
      }
    }
    const evidence=`Native bootstrap output:\n${stdout}\n${stderr}`;
    assert.equal(job?.delegation.identityStatus,'reported',evidence);
    assert.equal(job.pid,child.pid,evidence);assert.ok(job.creationIdentity.creationTime>0,evidence);assert.ok(job.closedAt,evidence);
    // Deliberately invalid manifest: an authenticated actor must reject it before
    // creating the real runtime. This probe needs no runtime download or build.
    assert.equal(end.status,1,evidence);assert.equal(end.signal,null,evidence);
    const errors=stdout.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).filter(value=>value.event==='error');
    assert.equal(errors.length,1,evidence);assert.equal(errors[0].code,'VERIFICATION_FAILED',evidence);
    assert.equal(fs.existsSync(hermes),false,'A rejected payload must leave the runtime absent');
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null)await lease.cancel({signal:'SIGKILL'});
    await lease.release();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

const pythonGate=`import os,json,psutil,socket,sys,time,base64
endpoint=os.environ['NORA_OPERATION_DELEGATE_ENDPOINT'].split(':')
connection=socket.create_connection((endpoint[0],int(endpoint[1])),timeout=10)
connection.settimeout(None)
gate=connection.makefile('rwb',buffering=0)
def send(message): gate.write((json.dumps(message)+'\\n').encode())
def receive():
    line=gate.readline()
    if not line: raise RuntimeError('guard lost')
    return json.loads(line)
send({'schema':'nora-operation-executor/1','jobId':os.environ['NORA_OPERATION_JOB_ID'],'token':os.environ['NORA_OPERATION_DELEGATE_TOKEN'],'pid':os.getpid(),'creationTime':psutil.Process().create_time(),'precisionSeconds':0.001})
ack=receive()
assert ack['schema']=='nora-operation-delegation-ack/1' and ack['token']==os.environ['NORA_OPERATION_DELEGATE_TOKEN'] and ack['jobId']==os.environ['NORA_OPERATION_JOB_ID']
pending=[]
sequence=0
def rpc(action,**fields):
    global sequence
    sequence+=1
    request_id=str(sequence)
    send(dict(type=action,requestId=request_id,**fields))
    while True:
        message=receive()
        if message.get('type')=='reply' and message.get('requestId')==request_id:
            if message.get('error'): raise RuntimeError(message['error'])
            return message['result']
        pending.append(message)
def event():
    return pending.pop(0) if pending else receive()
def spawn_nested(source,output):
    return rpc('spawn',command=sys.executable,args=['-B','-u','-c',source,output],kind='python-maintenance',options={'venvHome':sys.prefix,'managedPythonRoot':os.environ.get('NORA_TEST_MANAGED_PYTHON_ROOT'),'windowsHide':True})['jobId']
`;
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!(await fn())) { if (Date.now() >= end) throw new Error('Condition was not reached'); await delay(25); }
}
function firstLine(proc) {
  return new Promise((resolve, reject) => {
    let text = '', errors = '';
    proc.stderr.on('data', value => errors += value);
    proc.stdout.on('data', value => { text += value; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); });
    proc.once('exit', code => { if (!text.includes('\n')) reject(new Error(`Owner exited ${code}: ${errors}`)); });
    proc.once('error', reject);
  });
}

test('large guard history reaches the caller before a read-only probe exits', {timeout:15000}, async () => {
  const {acquire,probe}=require(modulePath);
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-guard-large-history-')));
  const lease=await acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});
  try {
    const guards=path.join(directory,'operations','.guards');
    const template=JSON.parse(fs.readFileSync(path.join(guards,fs.readdirSync(guards)[0]),'utf8'));
    const fixtures=[];
    for(let index=0;index<8;index++) {
      const leaseId=crypto.randomUUID();
      const session={...template,leaseId,status:'released',ownerConnected:false,
        jobs:Array.from({length:72},()=>({jobId:crypto.randomUUID(),kind:'verification',
          createdAt:template.createdAt,closedAt:template.createdAt,exitCode:0}))};
      const file=path.join(guards,leaseId+'.json'),bytes=JSON.stringify(session);
      assert.ok(Buffer.byteLength(bytes)<128*1024,'each saved session obeys the existing reader limit');
      fs.writeFileSync(file,bytes,{flag:'wx'});fixtures.push({file,bytes,leaseId});
    }
    assert.ok(fixtures.reduce((sum,value)=>sum+Buffer.byteLength(value.bytes),0)>80*1024,
      'the native IPC reply must exceed the small-message happy path');
    const busy=await probe({directory});
    assert.equal(busy.busy,true,'a large reply must preserve the active writer fact');
    assert.equal(busy.sessions.filter(value=>fixtures.some(saved=>saved.leaseId===value.leaseId)).length,8);
    await lease.release();
    const released=await probe({directory});
    assert.equal(released.busy,false);assert.equal(released.inspectionRequired,false);
    assert.equal(released.sessions.reduce((sum,value)=>sum+value.jobs.length,0),8*72);
    for(const fixture of fixtures)assert.equal(fs.readFileSync(fixture.file,'utf8'),fixture.bytes,
      'read-only status must retain every saved child fact');
  } finally {await lease.release();fs.rmSync(directory,{recursive:true,force:true});}
});

test('a synchronous managed spawn failure preserves sanitized project frames through the real native guard',
  {timeout:15000}, async () => {
  const {acquire,probe}=require(modulePath);
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-guard-spawn-diagnostic-')));
  const operationId=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
  const privateRoot=path.join(directory,'missing-'+token),command=path.join(privateRoot,process.platform==='win32'?'python.exe':'python');
  const url='https://private.invalid/maintenance?token='+token;
  const lease=await acquire({directory,operationId,ownerEpoch:1});
  try {
    const child=lease.spawn(command,['-B','-c','pass',url],{kind:'python-maintenance',
      managedPythonRoot:path.join(privateRoot,'base'),venvHome:path.join(privateRoot,'venv'),
      env:{...process.env,TEST_PRIVATE_TOKEN:token,TEST_PRIVATE_URL:url}});
    const error=await new Promise(resolve=>child.once('error',resolve));
    assert.equal(error.code,'ENOENT');assert.equal(child.pid,undefined,'identity failure must occur before an actual process is spawned');
    assert.match(error.stack,/File "managed-python\.js", line \d+, in /);
    assert.match(error.stack,/File "operation-lock-worker\.js", line \d+, in /);
    assert.ok(error.missingReasons.includes('non_project_frames_omitted'),'omitted real Node fs/runtime frames must be explicit');
    function project(value){if(!value)return;return {name:value.name,code:value.code,message:value.message,stack:value.stack,
      missingReasons:value.missingReasons,remoteMessage:value.remoteMessage,cause:project(value.cause)};}
    const projection=JSON.stringify(project(error));
    for(const secret of [token,url,directory,privateRoot,command])assert.equal(projection.includes(secret),false,'Guard diagnostic disclosed private input');
    assert.ok(Buffer.byteLength(projection)<=16*1024,'guard diagnostic must remain bounded');
    assert.equal((await probe({directory})).busy,true);
    await lease.release();assert.equal((await probe({directory})).busy,false);
  } finally {await lease.release();fs.rmSync(directory,{recursive:true,force:true});}
});

test('product acceptance actor terminates a native guard refusal which has no close event', {timeout:10000}, async () => {
  const {actor}=require('./launcher_product_refactor_smoke.cjs');
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-product-refusal-')));
  const lease=await require(modulePath).acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});
  let timer;
  try{
    const result=actor({lease,observe(){}},path.join(directory,'missing/python'),[],{label:'refused',kind:'python-maintenance',
      managedPythonRoot:path.join(directory,'missing/base'),venvHome:path.join(directory,'missing/venv'),
      env:{...process.env,NORA_TAVERN_HOME:directory}});
    await assert.rejects(Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Harness still waiting for an impossible close')),2000);})]),{code:'ENOENT'});
    assert.equal((await lease.snapshot()).jobs.length,0,'Rejected spawn must not pretend to own a closed child');
  }finally{clearTimeout(timer);await lease.release();fs.rmSync(directory,{recursive:true,force:true});}
});

test('product actor preserves a real child error and its raw output when checkpoint observation also fails',
  {timeout:15000,skip:!process.env.NORA_TEST_PYTHON},async()=>{
    const {actor}=require('./launcher_product_refactor_smoke.cjs');
    const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-product-evidence-')));
    const lease=await require(modulePath).acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});
    try{
      const source='import json,sys; print(json.dumps({"event":"error","message":"actual updater failure","code":"FIXTURE_UPDATER_ERROR"}),flush=True); sys.exit(7)';
      await assert.rejects(actor({lease,observe(){}},process.env.NORA_TEST_PYTHON,
        ['-B','-u',helperPath,'--delegate-exec','-c',source],{
          label:'checkpoint-error',kind:'python-maintenance',
          managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,
          venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON)),
          env:{...process.env,NORA_TAVERN_HOME:directory},
          onSpawn:()=>Promise.reject(new Error('checkpoint not observed')),
        }),error=>{
          assert.equal(error.message,'actual updater failure');assert.equal(error.code,'FIXTURE_UPDATER_ERROR');
          assert.equal(error.secondaryErrors[0].error.message,'checkpoint not observed');
          assert.match(fs.readFileSync(error.fixtureLog,'utf8'),/actual updater failure/);
          return true;
        });
      assert.ok((await lease.snapshot()).jobs.every(job=>job.closedAt));
    }finally{await lease.release();fs.rmSync(directory,{recursive:true,force:true});}
  });

test('guard diagnostic protocol bounds the entire error group and loads as an isolated flat delegate', async () => {
  const delegatePath=path.join(path.dirname(modulePath),'operation-delegate.js');
  const {projectDiagnostic,restoreDiagnostic}=require(delegatePath);
  const text=require(path.join(path.dirname(modulePath),'fault-packet.js')).createFaultPackets().text;
  const secret=crypto.randomBytes(32).toString('hex'),privateUrl='https://private.invalid/?token='+secret;
  const frame=`    at originalCause (${path.join(path.dirname(modulePath),'managed-python.js')}:11:17)`;
  const error=depth=>{const value=new Error('token='+secret+' '+privateUrl+' '+os.tmpdir()+' '+'汉'.repeat(900));
    value.code='ENOENT';value.stack=[...Array(20).fill(frame),'    at NativeFs (node:fs:2806:25)'].join('\n');
    if(depth)value.cause=error(depth-1);return value;};
  const nodes=[];
  function collect(value){if(!value)return;nodes.push(value);collect(value.cause);for(const child of value.secondaryErrors||[])collect(child.error);}
  const record=projectDiagnostic(error(6),{text,directory:path.dirname(modulePath)});collect(record);
  assert.equal(nodes.length,4);assert.equal(record.truncated,true);
  assert.equal(nodes.reduce((sum,value)=>sum+(value.stack?value.stack.split('\n').length:0),0),12);
  for(const value of nodes)assert.ok(Buffer.byteLength(value.message)<=1200);
  const encoded=JSON.stringify(record);assert.ok(Buffer.byteLength(encoded)<=16*1024);
  for(const value of [secret,privateUrl,os.tmpdir()])assert.equal(encoded.includes(value),false);
  const branching=error(0);branching.secondaryErrors=Array.from({length:5},()=>({error:error(0)}));
  const bounded=projectDiagnostic(branching,{text,directory:path.dirname(modulePath)});
  assert.equal(bounded.secondaryErrors.length,2);assert.equal(bounded.truncated,true);
  const restored=restoreDiagnostic({code:'ENOENT',message:'Maintenance child could not start',diagnostic:record});
  assert.equal(restored.message,'Maintenance child could not start');assert.equal(restored.code,'ENOENT');
  assert.equal(restored.remoteMessage,record.message);assert.equal(restored.cause.code,'ENOENT');
  assert.equal(restoreDiagnostic({code:'ENOENT',message:'Safe guidance',diagnostic:{...record,unexpected:secret}}).remoteMessage,undefined);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-flat-delegate-'));
  try {
    const flat=path.join(root,'operation-delegate.js');fs.copyFileSync(delegatePath,flat);
    const child=spawn(process.execPath,['-e',"const m=require(process.argv[1]);process.stdout.write(JSON.stringify({connect:typeof m.connect,restore:typeof m.restoreDiagnostic,project:typeof m.projectDiagnostic}))",flat],
      {env:{...process.env,NODE_PATH:''},stdio:['ignore','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>errors+=value);
    const [code]=await once(child,'close');assert.equal(code,0,errors);
    assert.deepEqual(JSON.parse(output),{connect:'function',restore:'function',project:'function'});
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('actual native guard commit rejection retains its project origin without writing a record', {timeout:15000}, async () => {
  const {acquire,probe}=require(modulePath),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-guard-commit-error-')));
  const lease=await acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});
  try {
    let failure;try{await lease.commitOperation({record:{},expected:null});}catch(error){failure=error;}
    assert.equal(failure.code,'OPERATION_STALE_EVENT');
    assert.match(failure.stack,/File "operation-lock-worker\.js", line \d+, in commitOperation/);
    assert.equal(failure.stack.includes(directory),false);assert.equal((await probe({directory})).busy,true);
    await lease.release();assert.equal((await probe({directory})).busy,false);
    assert.equal(fs.readdirSync(path.join(directory,'operations')).filter(name=>/^[a-f0-9-]{36}$/.test(name)).length,0);
  } finally {await lease.release();fs.rmSync(directory,{recursive:true,force:true});}
});

test('actual asynchronous child start error keeps safe guidance and original remote diagnostic until real close', {timeout:15000}, async () => {
  const {acquire,probe}=require(modulePath),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-guard-async-error-')));
  const lease=await acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});
  try {
    const child=lease.spawn(directory,[],{kind:'verification'}),closed=new Promise(resolve=>child.once('close',resolve));
    const error=await new Promise(resolve=>child.once('error',resolve));await closed;
    assert.ok(['EACCES','EPERM','ENOENT','ENOEXEC'].includes(error.code));
    assert.equal(error.message,'Maintenance child could not start');assert.ok(error.remoteMessage);
    assert.notEqual(error.remoteMessage,error.message);
    for(const frame of error.stack.split('\n').filter(Boolean))assert.match(frame,/^File "[A-Za-z0-9_.-]+\.js", line \d+, in /);
    assert.equal(error.stack.includes('node:internal'),false);
    assert.ok(error.missingReasons.includes('non_project_frames_omitted'));
    const output=JSON.stringify({message:error.message,remoteMessage:error.remoteMessage,stack:error.stack});assert.equal(output.includes(directory),false);
    const job=(await lease.snapshot()).jobs[0];assert.equal(job.spawnErrorCode,error.code);assert.ok(job.closedAt);
    assert.equal((await probe({directory})).busy,true);await lease.release();assert.equal((await probe({directory})).busy,false);
  } finally {await lease.release();fs.rmSync(directory,{recursive:true,force:true});}
});

test('unavailable source and malformed private diagnostics cannot replace the original failure', () => {
  const {projectDiagnostic,restoreDiagnostic}=require(path.join(path.dirname(modulePath),'operation-delegate.js'));
  const text=require(path.join(path.dirname(modulePath),'fault-packet.js')).createFaultPackets().text;
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-guard-removed-source-')),former=path.join(directory,'former-source.js');
  fs.writeFileSync(former,'// former project source');
  const token=crypto.randomBytes(32).toString('hex'),error=Object.assign(new Error('Original missing source; token='+token),{code:'ENOENT'});
  error.stack=`    at originalFailure (${former}:10:1)\n    at NativeFs (node:fs:2806:25)`;
  fs.rmSync(directory,{recursive:true,force:true});
  let record;assert.doesNotThrow(()=>{record=projectDiagnostic(error,{text,directory});});
  assert.equal(record.code,'ENOENT');assert.equal(record.name,'Error');assert.match(record.message,/Original missing source/);
  assert.equal(record.stack,'');assert.ok(record.missingReasons.includes('unknown_evidence_gap'));
  assert.ok(record.missingReasons.includes('non_project_frames_omitted'));assert.equal(JSON.stringify(record).includes(token),false);
  let opaque;assert.doesNotThrow(()=>{opaque=projectDiagnostic(error,{text(){throw new Error('Broken sanitizer '+token);},directory:path.dirname(modulePath)});});
  assert.equal(opaque.code,'ENOENT');assert.ok(opaque.missingReasons.includes('program_message_unreviewed'));
  assert.equal(JSON.stringify(opaque).includes(token),false);
  const cyclic={name:'Error',message:'Private diagnostic',code:'ENOENT',stack:''};cyclic.cause=cyclic;
  const getter={};Object.defineProperty(getter,'name',{enumerable:true,get(){throw new Error('Invalid private getter');}});
  for(const diagnostic of [cyclic,getter,null,[],42,'invalid',{...record,unknown:token}]){
    let restored;assert.doesNotThrow(()=>{restored=restoreDiagnostic({code:'ENOENT',message:'Safe public guidance',diagnostic});});
    assert.equal(restored.code,'ENOENT');assert.equal(restored.message,'Safe public guidance');assert.equal(restored.remoteMessage,undefined);
  }
});

test('a maintenance child keeps exclusion after the desktop dies, then releases on close', {timeout:20000}, async () => {
  const { acquire, probe } = require(modulePath);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-operation-lock-'));
  const output = path.join(directory, 'writes.txt');
  const childSource = `
    const fs=require('node:fs');
    const {connect}=require(process.argv[2]);
    (async()=>{const delegation=await connect();
      const out=process.argv[1];fs.appendFileSync(out,'started\\n');process.stdout.write('started\\n');
      const timer=setInterval(()=>fs.appendFileSync(out,'write\\n'),30);
      setTimeout(()=>{clearInterval(timer);fs.appendFileSync(out,'done\\n');delegation.close();},1500);
    })().catch(error=>{console.error(error);process.exitCode=1});`;
  const ownerSource = `
    const {acquire}=require(process.argv[1]);
    (async()=>{const lease=await acquire({directory:process.argv[2],operationId:'desktop-death',ownerEpoch:1});
      const child=lease.spawn(process.execPath,['-e',process.argv[3],process.argv[4],process.argv[5]],{kind:'verification'});
      child.stdout.once('data',()=>process.stdout.write(JSON.stringify({ready:true,pid:child.pid})+'\\n'));
      process.stdin.resume();
    })().catch(error=>{console.error(error);process.exitCode=1});`;
  const owner = spawn(process.execPath, ['-e', ownerSource, modulePath, directory, childSource, output,
    path.resolve(path.dirname(modulePath),'operation-delegate.js')], {stdio:['pipe','pipe','pipe']});
  let next;
  try {
    assert.equal((await firstLine(owner)).ready, true);
    owner.kill('SIGKILL');
    await new Promise(resolve => owner.once('close', resolve));
    const before = fs.statSync(output).size;
    await assert.rejects(acquire({directory,operationId:'too-early',ownerEpoch:2}), {code:'OPERATION_BUSY'});
    await delay(120);
    assert.ok(fs.statSync(output).size > before, 'the original child must still be writing');
    await until(() => fs.readFileSync(output,'utf8').includes('done\n'));
    // Final output precedes delegation/socket and real process closure. The
    // guard must retain exclusion until those events arrive on every platform.
    let finished;
    await until(async () => { finished = await probe({directory}); return !finished.busy; });
    const prior = finished.sessions.find(session => session.operationId === 'desktop-death');
    assert.equal(prior.status, 'released');
    assert.equal(prior.ownerConnected, false);
    assert.ok(prior.releasedAt);
    assert.equal(prior.jobs.length, 1);
    assert.ok(prior.jobs[0].closedAt);
    assert.equal(prior.jobs[0].exitCode, 0);
    assert.deepEqual(finished.errors, []);
    next = await acquire({directory,operationId:'after-close',ownerEpoch:2});
    assert.equal((await next.snapshot()).ownerEpoch, 2);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    if (next) await next.release();
    await delay(100);
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('release waits for real close and an old lease cannot release a later epoch', {timeout:15000}, async () => {
  const { acquire, probe }=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-release-'));
  const old=await acquire({directory,operationId:'old',ownerEpoch:1});let next;
  try {
    const child=old.spawn(process.execPath,['-e',"process.stdout.write('ready');setTimeout(()=>process.exit(7),300)"],{kind:'verification'});
    await once(child.stdout,'data');const closing=once(child,'close');
    const released=old.release();
    assert.equal((await probe({directory})).busy,true);
    await closing;await released;
    assert.equal(child.exitCode,7);
    next=await acquire({directory,operationId:'new',ownerEpoch:2});
    await old.release();
    assert.equal((await probe({directory})).busy,true);
    assert.equal((await next.snapshot()).ownerEpoch,2);
  } finally {await old.release();if(next)await next.release();fs.rmSync(directory,{recursive:true,force:true});}
});

test('the public snapshot retains actual child close facts without exposing command arguments', {timeout:15000}, async () => {
  const { acquire, snapshot } = require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-ledger-'));
  const lease=await acquire({directory,operationId:'ledger',ownerEpoch:1});
  try {
    const child=lease.spawn(process.execPath,['-e',"process.stdout.write('ready');setTimeout(()=>{},10000)",'PRIVATE-ARG'],{kind:'verification'});
    await once(child.stdout,'data');
    const running=await lease.snapshot();
    const job=running.jobs.find(job=>job.jobId===child.jobId);
    assert.equal(job.pid,child.pid);
    assert.ok(job.spawnConfirmedAt);
    assert.ok(!JSON.stringify(running).includes('PRIVATE-ARG'));
    const ended=once(child,'close');child.kill('SIGTERM');await ended;
    assert.ok((await lease.snapshot()).jobs.find(job=>job.jobId===child.jobId).closedAt);
    await lease.release();
    const recorded=await snapshot({directory});
    assert.equal(recorded.busy,false);
    assert.equal(recorded.sessions[0].operationId,'ledger');
    assert.ok(recorded.sessions[0].jobs[0].closedAt);
    assert.equal(recorded.inspectionRequired,false);
  } finally {await lease.release();fs.rmSync(directory,{recursive:true,force:true});}
});

test('a Python executor reports creation identity to its private endpoint before receiving write delegation',
  {timeout:15000,skip:!process.env.NORA_TEST_PYTHON},async()=>{
  const {acquire}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-python-'));
  const lease=await acquire({directory,operationId:'python-handshake',ownerEpoch:1});let child;
  const source=`import os,json,psutil,socket,sys,ssl,requests,hermes_cli
endpoint=os.environ['NORA_OPERATION_DELEGATE_ENDPOINT'].split(':')
connection=socket.create_connection((endpoint[0],int(endpoint[1])),timeout=10)
pipe=connection.makefile('rwb',buffering=0)
identity={'schema':'nora-operation-executor/1','pid':os.getpid(),'creationTime':psutil.Process().create_time(),'token':os.environ['NORA_OPERATION_DELEGATE_TOKEN'],'jobId':os.environ['NORA_OPERATION_JOB_ID']}
pipe.write((json.dumps(identity)+'\\n').encode())
ack=json.loads(pipe.readline())
assert ack['schema']=='nora-operation-delegation-ack/1' and ack.get('token')==identity['token'] and ack.get('jobId')==identity['jobId'],json.dumps({'ackSchema':ack['schema'],'executorPid':identity['pid'],'parentPid':os.getppid()})
print(json.dumps({'pid':identity['pid'],'creationTime':identity['creationTime'],'prefix':sys.prefix,'executable':sys.executable,'psutil':psutil.__version__,'requests':requests.__version__,'hermes':hermes_cli.__version__,'ssl':ssl.OPENSSL_VERSION}),flush=True)
`;
  try {
    child=lease.spawn(process.env.NORA_TEST_PYTHON,['-B','-u','-c',source],{kind:'python-maintenance',
      managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,
      venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON)),
      cwd:path.dirname(path.dirname(path.dirname(process.env.NORA_TEST_PYTHON)))});
    const output=await new Promise((resolve,reject)=>{
      let text='',errors='';child.stderr.on('data',value=>errors+=value);
      child.stdout.on('data',value=>{text+=value;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]));});
      child.once('error',reject);child.once('close',code=>{if(!text.includes('\n'))reject(new Error(`Python delegation failed ${code}, handle pid ${child.pid}: ${errors}`));});
    });
    const job=(await lease.snapshot()).jobs.find(job=>job.jobId===child.jobId);
    assert.equal(job.delegation.identityStatus,'reported');
    assert.equal(child.pid,output.pid,'the held handle must belong to the real Python writer');
    assert.deepEqual(job.creationIdentity,{pid:output.pid,creationTime:output.creationTime,precisionSeconds:0,source:'executor-self-report'});
    assert.equal(fs.realpathSync(output.prefix),fs.realpathSync(path.dirname(path.dirname(process.env.NORA_TEST_PYTHON))));
    assert.equal(fs.realpathSync(output.executable),fs.realpathSync(process.env.NORA_TEST_PYTHON));
    for(const key of ['psutil','requests','hermes','ssl'])assert.ok(output[key]);
  } finally {
    if(Number.isInteger(child?.pid) && child.exitCode===null && child.signalCode===null){const ended=once(child,'close');child.kill();await ended;}
    await lease.release();fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('an idle probe does not create operation or lock files',async()=>{
  const {probe}=require(modulePath);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-probe-')),directory=path.join(root,'missing');
  try {assert.equal((await probe({directory})).busy,false);assert.equal(fs.existsSync(directory),false);}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('environment values alone cannot delegate writes without the live guard acknowledgement',{timeout:15000},async()=>{
  const {acquire}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-invalid-'));
  const output=path.join(directory,'must-not-exist');
  const lease=await acquire({directory,operationId:'invalid-delegation',ownerEpoch:1});
  const source=`const {connect}=require(process.argv[1]);
    (async()=>{await connect({env:{...process.env,NORA_OPERATION_DELEGATE_TOKEN:'0'.repeat(64)}});
      require('node:fs').writeFileSync(process.argv[2],'unsafe');})().catch(error=>{process.stdout.write(error.code);});`;
  try {
    const child=lease.spawn(process.execPath,['-e',source,path.join(path.dirname(modulePath),'operation-delegate.js'),output],{kind:'verification'});
    let text='';child.stdout.on('data',data=>text+=data);await once(child,'close');
    assert.equal(text,'DELEGATION_REJECTED');assert.equal(fs.existsSync(output),false);
    assert.equal((await lease.snapshot()).jobs[0].delegation.identityStatus,'pending');
  } finally {await lease.release();fs.rmSync(directory,{recursive:true,force:true});}
});

test('guard hard death signals loss and retains an unresolved ledger instead of manufacturing child closure',{timeout:15000},async()=>{
  const {acquire,probe}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-guard-death-'));
  const output=path.join(directory,'guard-lost');
  const lease=await acquire({directory,operationId:'guard-death',ownerEpoch:1});let child,guardKilled=false,closed=false;
  const source=`const {connect}=require(process.argv[1]);
    (async()=>{const delegation=await connect();process.stdout.write('ready');
      delegation.once('lost',()=>{require('node:fs').writeFileSync(process.argv[2],'EOF');process.exit(23);});
    })().catch(error=>{console.error(error);process.exitCode=1});`;
  try {
    child=lease.spawn(process.execPath,['-e',source,path.join(path.dirname(modulePath),'operation-delegate.js'),output],{kind:'verification'});
    await once(child.stdout,'data');child.on('close',()=>closed=true);
    const lost=once(lease,'guard-lost');const state=await lease.snapshot();
    process.kill(state.guardPid,'SIGKILL');guardKilled=true;await lost;
    if(process.platform==='win32') {
      // libuv's Windows job may terminate the child with its killed guard. The
      // persistent ledger still requires inspection; no synthetic close is safe.
      await delay(150);
      try {process.kill(child.pid,0);await until(()=>fs.existsSync(output));}catch(error){if(error.code!=='ESRCH')throw error;}
    } else await until(()=>fs.existsSync(output));
    assert.equal(closed,false);
    const retained=await probe({directory});assert.equal(retained.busy,false);assert.equal(retained.inspectionRequired,true);
    assert.equal(retained.sessions[0].jobs[0].closedAt,undefined);
    assert.equal(retained.sessions[0].jobs[0].delegation.identityStatus,'reported');
    await assert.rejects(lease.release(),{code:'LOCK_GUARD_EXITED'});
  } finally {
    if(!guardKilled){if(child){const ended=once(child,'close');child.kill();await ended;}await lease.release();}
    await delay(100);fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('a guard-owned nested Python writer survives its parent death and blocks takeover until actual close',
  {timeout:20000,skip:!process.env.NORA_TEST_PYTHON},async()=>{
  const {acquire,probe}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-nested-')),output=path.join(directory,'writes');
  const lease=await acquire({directory,operationId:'nested-parent-death',ownerEpoch:1});let parent,next;
  const nested=pythonGate+`\nwith open(sys.argv[1],'a') as stream:\n    stream.write('started\\n');stream.flush()\nprint('ready',flush=True)\nend=time.monotonic()+12\nwhile not os.path.exists(sys.argv[1]+'.finish'):\n    if time.monotonic()>end: raise RuntimeError('writer completion was not requested')\n    with open(sys.argv[1],'a') as stream: stream.write('write\\n')\n    time.sleep(0.03)\nwith open(sys.argv[1],'a') as stream: stream.write('done\\n')\n`;
  const source=pythonGate+`\nnested_source=${JSON.stringify(nested)}\njob=spawn_nested(nested_source,sys.argv[1])\nwhile True:\n    message=event()\n    if message.get('event')=='stdout' and b'ready' in base64.b64decode(message['data']): break\nprint(json.dumps({'ready':True,'jobId':job}),flush=True)\ntime.sleep(20)\n`;
  try {
    parent=lease.spawn(process.env.NORA_TEST_PYTHON,['-B','-u','-c',source,output],{kind:'python-maintenance',
      managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON))});
    const ready=await firstLine(parent);assert.equal(ready.ready,true);
    const ended=once(parent,'close');parent.kill('SIGKILL');await ended;
    const before=fs.statSync(output).size;
    const releasing=lease.release();assert.equal((await probe({directory})).busy,true);
    await assert.rejects(acquire({directory,operationId:'nested-too-early',ownerEpoch:2}),{code:'OPERATION_BUSY'});
    await until(()=>fs.statSync(output).size>before);
    fs.writeFileSync(output+'.finish','finish');
    await until(()=>/(^|\n)done\r?\n/.test(fs.readFileSync(output,'utf8')));await releasing;
    next=await acquire({directory,operationId:'nested-after-close',ownerEpoch:2});
    const history=await probe({directory});const prior=history.sessions.find(value=>value.operationId==='nested-parent-death');
    assert.ok(prior.jobs.find(job=>job.jobId===ready.jobId).closedAt);
    assert.ok(prior.jobs.find(job=>job.jobId===ready.jobId).parentJobId);
  } finally {
    if(Number.isInteger(parent?.pid) && parent.exitCode===null && parent.signalCode===null){const ended=once(parent,'close');parent.kill();await ended;}
    await lease.release();if(next)await next.release();fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('nested cancellation reports real close and saved child facts before releasing the operation',
  {timeout:15000,skip:!process.env.NORA_TEST_PYTHON},async()=>{
  const {acquire}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-nested-cancel-')),output=path.join(directory,'writes');
  const lease=await acquire({directory,operationId:'nested-cancel',ownerEpoch:1});let parent;
  const nested=pythonGate+`\nprint('ready',flush=True)\nwhile True:\n    with open(sys.argv[1],'a') as stream: stream.write('write\\n')\n    time.sleep(0.03)\n`;
  const source=pythonGate+`\njob=spawn_nested(${JSON.stringify(nested)},sys.argv[1])\nwhile True:\n    message=event()\n    if message.get('event')=='stdout' and b'ready' in base64.b64decode(message['data']): break\nassert rpc('kill',jobId=job)['sent']\nwhile True:\n    message=event()\n    if message.get('jobId')==job and message.get('event')=='close': break\nsaved=rpc('snapshot',jobId=job)\nassert saved['closedAt']\nprint(json.dumps({'jobId':job,'closedAt':saved['closedAt']}),flush=True)\n`;
  try {
    parent=lease.spawn(process.env.NORA_TEST_PYTHON,['-B','-u','-c',source,output],{kind:'python-maintenance',
      managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON))});
    const result=await firstLine(parent);assert.ok(result.closedAt);
    const before=fs.existsSync(output)?fs.statSync(output).size:0;await delay(100);
    assert.equal(fs.existsSync(output)?fs.statSync(output).size:0,before);
    const state=await lease.snapshot();assert.ok(state.jobs.find(job=>job.jobId===result.jobId).closedAt);
  } finally {
    if(Number.isInteger(parent?.pid) && parent.exitCode===null && parent.signalCode===null){const ended=once(parent,'close');parent.kill();await ended;}
    await lease.release();fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('cancelling an operation closes every guard-owned maintenance handle including nested writers',
  {timeout:15000,skip:!process.env.NORA_TEST_PYTHON},async()=>{
  const {acquire}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-cancel-all-')),output=path.join(directory,'writes');
  const lease=await acquire({directory,operationId:'cancel-all',ownerEpoch:1});let parent;
  const nested=pythonGate+`\nprint('ready',flush=True)\nwhile True:\n    with open(sys.argv[1],'a') as stream: stream.write('write\\n')\n    time.sleep(0.03)\n`;
  const source=pythonGate+`\njob=spawn_nested(${JSON.stringify(nested)},sys.argv[1])\nwhile True:\n    message=event()\n    if message.get('event')=='stdout' and b'ready' in base64.b64decode(message['data']): break\nprint(json.dumps({'ready':True}),flush=True)\ntime.sleep(20)\n`;
  try {
    parent=lease.spawn(process.env.NORA_TEST_PYTHON,['-B','-u','-c',source,output],{kind:'python-maintenance',
      managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON))});
    await firstLine(parent);assert.equal((await lease.cancel({signal:'SIGTERM'})).closed,true);
    const state=await lease.snapshot();assert.equal(state.jobs.length,2);assert.ok(state.jobs.every(job=>job.closedAt));
    assert.ok(state.cancellationClosedAt);assert.throws(()=>lease.spawn(process.execPath,[]),{code:'LOCK_CANCELLING'});
    const before=fs.existsSync(output)?fs.statSync(output).size:0;await delay(100);
    assert.equal(fs.existsSync(output)?fs.statSync(output).size:0,before);
  } finally {
    if(parent && parent.exitCode===null && parent.signalCode===null)await lease.cancel({signal:'SIGKILL'});
    await lease.release();fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('the production Python delegate preserves script, module and command arguments plus stdin and actual close',
  {timeout:20000,skip:!process.env.NORA_TEST_PYTHON},async()=>{
  const {acquire}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-production-'));
  const lease=await acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});let parent;
  const body="import sys,json;print(json.dumps({'arg':sys.argv[1],'input':sys.stdin.read()}),flush=True)";
  const script=path.join(directory,'script.py');fs.writeFileSync(script,body);
  fs.writeFileSync(path.join(directory,'nora_gate_case.py'),body);
  const source=`import sys,json,os\nsys.path.insert(0,${JSON.stringify(path.dirname(helperPath))})\nfrom operation_control import managed_run\ncommands=[['-c',${JSON.stringify(body)},'command'],['-m','nora_gate_case','module'],[${JSON.stringify(script)},'script']]\nresults=[]\nfor args in commands:\n    result=managed_run([sys.executable,*args],input='hello',capture_output=True,text=True,check=True,cwd=${JSON.stringify(directory)})\n    results.append(json.loads(result.stdout))\nprint(json.dumps(results),flush=True)\n`;
  try {
    parent=lease.spawn(process.env.NORA_TEST_PYTHON,['-B','-u',helperPath,'--delegate-exec','-c',source],{kind:'python-maintenance',
      managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON))});
    assert.deepEqual(await firstLine(parent),[{arg:'command',input:'hello'},{arg:'module',input:'hello'},{arg:'script',input:'hello'}]);
    const state=await lease.snapshot();assert.equal(state.jobs.length,4);assert.ok(state.jobs.slice(1).every(job=>job.closedAt));
  } finally {
    if(parent && parent.exitCode===null && parent.signalCode===null)await lease.cancel({signal:'SIGKILL'});
    await lease.release();fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('a production ManagedPopen child remains guard-owned after its authenticated parent is killed',
  {timeout:20000,skip:!process.env.NORA_TEST_PYTHON},async()=>{
  const {acquire,probe}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-production-parent-')),output=path.join(directory,'writes');
  const lease=await acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});let parent;
  const body=`import os,sys,time\nwith open(sys.argv[1],'a') as stream:stream.write('started\\n')\nprint('ready',flush=True)\nend=time.monotonic()+12\nwhile not os.path.exists(sys.argv[1]+'.finish'):\n    if time.monotonic()>end: raise RuntimeError('writer completion was not requested')\n    with open(sys.argv[1],'a') as stream:stream.write('write\\n')\n    time.sleep(0.03)\nwith open(sys.argv[1],'a') as stream:stream.write('done\\n')\n`;
  const source=`import sys,subprocess,json,time\nsys.path.insert(0,${JSON.stringify(path.dirname(helperPath))})\nfrom operation_control import managed_popen\nchild=managed_popen([sys.executable,'-c',${JSON.stringify(body)},${JSON.stringify(output)}],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)\nassert child.stdout.readline().strip()=='ready'\nprint(json.dumps({'ready':True}),flush=True)\ntime.sleep(20)\n`;
  try {
    parent=lease.spawn(process.env.NORA_TEST_PYTHON,['-B','-u',helperPath,'--delegate-exec','-c',source],{kind:'python-maintenance',
      managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON))});
    assert.equal((await firstLine(parent)).ready,true);
    const ended=once(parent,'close');parent.kill('SIGKILL');await ended;
    const before=fs.statSync(output).size;
    const releasing=lease.release();assert.equal((await probe({directory})).busy,true);
    await until(()=>fs.statSync(output).size>before);
    fs.writeFileSync(output+'.finish','finish');
    await until(()=>/(^|\n)done\r?\n/.test(fs.readFileSync(output,'utf8')));await releasing;
    assert.equal((await probe({directory})).inspectionRequired,false);
  } finally {
    if(parent && parent.exitCode===null && parent.signalCode===null)await lease.cancel({signal:'SIGKILL'});
    await lease.release();fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('production ManagedPopen runs pinned Node maintenance with identity acknowledgement and preserved arguments',
  {timeout:20000,skip:!process.env.NORA_TEST_PYTHON || !process.env.NORA_TEST_NODE},async()=>{
  const {acquire}=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-node-maintenance-'));
  const lease=await acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});let parent;
  const script=path.join(directory,'maintenance.mjs');
  fs.writeFileSync(script,"let text='';for await(const part of process.stdin)text+=part;console.log(JSON.stringify({arg:process.argv[2],input:text}));");
  const source=`import sys,json,os\nsys.path.insert(0,${JSON.stringify(path.dirname(helperPath))})\nfrom operation_control import managed_run\nenv=dict(os.environ,TAVERN_NODE_EXECUTABLE=os.environ['NORA_TEST_NODE'])\nresult=managed_run([env['TAVERN_NODE_EXECUTABLE'],${JSON.stringify(script)},'node'],input='hello',capture_output=True,text=True,check=True,env=env)\nprint(result.stdout.strip(),flush=True)\n`;
  try {
    parent=lease.spawn(process.env.NORA_TEST_PYTHON,['-B','-u',helperPath,'--delegate-exec','-c',source],{kind:'python-maintenance',
      managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,venvHome:path.dirname(path.dirname(process.env.NORA_TEST_PYTHON))});
    assert.deepEqual(await firstLine(parent),{arg:'node',input:'hello'});
    const job=(await lease.snapshot()).jobs.find(job=>job.kind==='node-maintenance');
    assert.ok(job.closedAt);assert.equal(job.delegation.identityStatus,'reported');
    assert.equal(job.pid,job.creationIdentity.pid);assert.ok(job.executionIdentity.jobArgument);assert.ok(job.executionIdentity.argvDigest);
  } finally {
    if(parent && parent.exitCode===null && parent.signalCode===null)await lease.cancel({signal:'SIGKILL'});
    await lease.release();fs.rmSync(directory,{recursive:true,force:true});
  }
});
