// Short-lived per-operation guard. Only this process owns the native OS lock.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const osLock = require('./os-lock');
const {resolveExecution}=require('./managed-python');
const {creationIdentity,projectDiagnostic}=require('./operation-delegate');
const {createEvidenceStore,OPERATION_BUDGET}=require('./evidence-store');
const faultText=require('./fault-packet').createFaultPackets().text;
const children = new Map();
let writerLock, context, session, ledgerFile, initialized=false, ledgerError, ownerConnected = true, releasing = false;
let server, endpoint;
const sockets=new Set();
let cancelling=false;
const cancellations=[];
let operationEvidence;

function failureReply(error,{code=error.code||'LOCK_FAILED',message=error.message}={}) {
  return {code,message:faultText(message,1200).replaceAll('\0',''),diagnostic:projectDiagnostic(error,{text:faultText,directory:__dirname})};
}

function atomicJson(file,value){
  const temporary=`${file}.${crypto.randomUUID()}.tmp`;let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,file);
    if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.rmSync(temporary,{force:true});}catch{}}
}
function commitOperation(message){
  const failed=message=>Object.assign(new Error(message),{code:'OPERATION_STALE_EVENT'});
  if(!writerLock||releasing)throw failed('The operation writer is no longer active');
  const record=message.record,expected=message.expected,id=record?.operationId;
  if(record?.schema!=='nora-operation/1'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id||'')
    ||!Number.isSafeInteger(record.sequence)||record.sequence<1||!Number.isSafeInteger(record.ownerEpoch)
    ||Buffer.byteLength(JSON.stringify(record))>256*1024)throw failed('Operation commit is invalid');
  const archive=message.archive===true;
  if(!archive&&(id!==context.operationId||record.ownerEpoch!==context.ownerEpoch))throw failed('This guard does not own the operation');
  const root=path.join(context.directory,'operations'),directory=path.join(root,id),file=path.join(directory,'operation.json');
  if(expected===null&&!fs.existsSync(directory)&&fs.readdirSync(root).filter(name=>/^[a-f0-9-]{36}$/i.test(name)).length
    >=OPERATION_BUDGET.historyCapacity+OPERATION_BUDGET.stopReserve)
    throw Object.assign(new Error('Operation history capacity exceeded'),{code:'OPERATION_HISTORY_CAPACITY'});
  for(const target of [context.directory,root,directory]){
    if(!fs.existsSync(target)){if(target===directory&&expected===null)fs.mkdirSync(target,{mode:0o700});else throw failed('Operation directory is missing');}
    const stat=fs.lstatSync(target);if(!stat.isDirectory()||stat.isSymbolicLink())throw failed('Operation directory identity is invalid');
  }
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});let current;
  if(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw failed('Operation record identity is invalid');current=JSON.parse(fs.readFileSync(file,'utf8'));}
  if(expected===null){if(current||record.sequence!==1)throw failed('Operation already exists');}
  else if(!expected||!current||current.schema!==record.schema||current.operationId!==id
    ||current.ownerEpoch!==expected.ownerEpoch||current.sequence!==expected.sequence||record.sequence!==expected.sequence+1)
    throw failed('Operation changed before commit');
  if(archive&&(!current||record.archived!==true||record.ownerEpoch!==current.ownerEpoch
    ||!['succeeded','failed','cancelled','rolled-back','blocked'].includes(current.state)
    ||!['untouched','restored'].includes(current.effectState)||current.handoffRef
    ||current.effectState==='restored'&&current.verification!=='confirmed'
    ||['recovery-required','files-restored-start-failed'].includes(current.recoveryOutcome)))throw failed('Operation cannot be archived');
  // The CAS and every rename run synchronously in the process holding the
  // native fd. Its death releases the lock after its last completed syscall.
  let evidence;
  if(message.evidence){
    if(archive||message.evidence.operationId!==id)throw failed('Evidence does not belong to this operation');
    evidence=operationEvidence.commitSnapshot(message.evidence);
    if(record.primaryFailure){record.evidenceStatus=evidence.missingReasons?.some(value=>value.startsWith('save_failed:'))?'save-failed':evidence.truncated?'saved-truncated':'saved';
      record.evidenceMissingReasons=evidence.missingReasons||[];record.evidenceRef=path.join(directory,'evidence');}
  }
  const generation=path.join(root,'.history-generation.json'),generationStat=fs.lstatSync(generation,{throwIfNoEntry:false});
  if(generationStat&&(!generationStat.isFile()||generationStat.isSymbolicLink()))throw failed('Operation generation identity is invalid');
  atomicJson(generation,{schema:1,id:crypto.randomUUID(),writing:true});
  atomicJson(file,record);
  const generationId=crypto.randomUUID();atomicJson(generation,{schema:1,id:generationId,writing:false});
  if(archive)operationEvidence.archive(id);
  return {record,evidence,generation:generationId};
}

function send(value) { if (process.connected) process.send(value, () => {}); }
function sendFinalReady(value) {
  // A probe can return more than the IPC buffer. Do not let disconnect's
  // finish() exit until the complete terminal response has been written.
  if(process.connected)process.send(value,()=>{if(process.connected)process.disconnect();});
}
function persist() {
  session.updatedAt=new Date().toISOString();
  const temporary=`${ledgerFile}.${crypto.randomUUID()}.tmp`;
  const file=fs.openSync(temporary,'wx',0o600);
  try {fs.writeFileSync(file,JSON.stringify(session));fs.fsyncSync(file);} finally {fs.closeSync(file);}
  fs.renameSync(temporary,ledgerFile);
}
function record(jobId) {
  try {persist();return true;} catch(error) {
    ledgerError=failureReply(error,{code:'LOCK_LEDGER_FAILED',message:'Maintenance child facts could not be saved'});
    send({type:'failure',jobId,error:ledgerError});return false;
  }
}
function history(directory) {
  const root=path.join(directory,'.guards'),sessions=[],errors=[];
  if(fs.existsSync(root)) {
    if(fs.lstatSync(root).isSymbolicLink())throw Object.assign(new Error('Guard ledger directory cannot be a symlink'),{code:'LOCK_IDENTITY'});
    for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.json'))) {
      try {
        const file=path.join(root,name),stat=fs.lstatSync(file);
        if(!stat.isFile() || stat.isSymbolicLink() || stat.size>128*1024)throw new Error('Invalid child ledger');
        const value=JSON.parse(fs.readFileSync(file,'utf8'));
        if(value.schema!=='nora-operation-guard/1' || !Array.isArray(value.jobs))throw new Error('Invalid child ledger');
        sessions.push(value);
      } catch {errors.push({ledger:name,code:'LOCK_LEDGER_UNREADABLE'});}
    }
  }
  return {sessions,errors,inspectionRequired:errors.length>0 || sessions.some(value=>value.jobs.some(job=>!job.closedAt && !job.spawnFailedAt))};
}
function finish() {
  if(cancelling && children.size===0 && cancellations.length) {
    session.cancellationClosedAt=new Date().toISOString();record();
    for(const id of cancellations.splice(0))send({type:'reply',id,result:{closed:true}});
  }
  if ((!ownerConnected || releasing) && children.size === 0) {
    if(session) {session.status='released';session.releasedAt=new Date().toISOString();record();}
    if(writerLock){writerLock.release();writerLock=undefined;}
    for(const socket of sockets)socket.destroy();
    server?.close();
    if (process.connected) process.send({type:'released'}, () => process.exit(ledgerError ? 1 : 0));
    else process.exit(ledgerError ? 1 : 0);
  }
}
async function initialize(message) {
  context = message;
  const directory=path.join(message.directory,'operations');
  try{writerLock=osLock.acquire({directory:message.directory,probe:message.probe});}
  catch(error){if(error.code!=='OPERATION_BUSY')throw error;sendFinalReady({type:'ready',busy:true});return;}
  if(message.probe){const ready={type:'ready',busy:writerLock.busy,...history(directory)};writerLock.release();writerLock=undefined;sendFinalReady(ready);return;}
  const root=path.join(directory,'.guards');fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(fs.lstatSync(root).isSymbolicLink())throw Object.assign(new Error('Guard ledger directory cannot be a symlink'),{code:'LOCK_IDENTITY'});
  const leaseId=crypto.randomUUID();ledgerFile=path.join(root,`${leaseId}.json`);
  session={schema:'nora-operation-guard/1',leaseId,operationId:message.operationId,ownerEpoch:message.ownerEpoch,
    guardPid:process.pid,ownerConnected:true,status:'held',createdAt:new Date().toISOString(),jobs:[]};
  persist();
  operationEvidence=createEvidenceStore({directory:message.directory});
  server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);if(socket.jobId){const job=session.jobs.find(value=>value.jobId===socket.jobId);if(job){job.outputDeliveryInterrupted=true;record(job.jobId);}}});socket.on('error',()=>{});
    socket.setTimeout(10000,()=>socket.destroy());let frame='';
    const reject=()=>socket.end(JSON.stringify({schema:'nora-operation-delegation-rejected/1'})+'\n');
    socket.on('data',data=>{
      frame+=data.toString('utf8');
      const limit=socket.authorized ? 256*1024 : 8192;
      while(frame.includes('\n')) {
        const split=frame.indexOf('\n'),line=frame.slice(0,split);frame=frame.slice(split+1);
        if(line.length>limit){reject();return;}
        try {
          const identity=JSON.parse(line);
          if(socket.authorized){delegatedRequest(socket,socket.jobId,identity);continue;}
          const entry=children.get(identity.jobId);
          if(!entry || identity.schema!=='nora-operation-executor/1' || identity.token!==entry.token
              || identity.pid!==entry.child.pid || !Number.isFinite(identity.creationTime) || identity.creationTime<=0
              || (identity.precisionSeconds!==undefined && (!Number.isFinite(identity.precisionSeconds) || identity.precisionSeconds<0 || identity.precisionSeconds>1))
              || entry.job.delegation.identityStatus!=='pending')throw new Error('Invalid executor handshake');
          entry.job.delegation.identityStatus='reported';
          entry.job.creationIdentity={pid:identity.pid,creationTime:identity.creationTime,
            precisionSeconds:Math.max(0,Number(identity.precisionSeconds)||0),source:'executor-self-report'};
          if(!record(identity.jobId)){entry.child.kill('SIGTERM');socket.destroy();return;}
          socket.authorized=true;socket.jobId=identity.jobId;socket.setTimeout(0);entry.socket=socket;
          socket.write(JSON.stringify({schema:'nora-operation-delegation-ack/1',jobId:identity.jobId,
            operationId:context.operationId,ownerEpoch:context.ownerEpoch,token:entry.token})+'\n');
          notify(entry,{type:'child',event:'identity',jobId:identity.jobId,identity:entry.job.creationIdentity});
        } catch {reject();return;}
      }
      if(frame.length>limit)reject();
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  endpoint=`127.0.0.1:${server.address().port}`;initialized=true;
  send({type:'ready',busy:false,guardPid:process.pid});
}
function snapshot() {
  return {...session,releasing,cancelling,ledgerError};
}

function notify(entry,value) {
  if(!entry.sink){send(value);return;}
  if(!entry.sink.destroyed && entry.sink.writable) {
    const writable=entry.sink.write(JSON.stringify(value)+'\n');
    if(!writable && ['stdout','stderr'].includes(value.event)) {
      const stream=entry.child[value.event];stream.pause();
      entry.sink.once('drain',()=>stream.resume());entry.sink.once('close',()=>stream.resume());
    }
  }
}
// Process-identity queries may initialize Windows special folders. Keep every
// pre-activation helper profile inside the already owned operation scratch area.
function bootstrapProfile(noraHome) {
  const root=path.join(noraHome,'installer','operations',context.operationId,'bootstrap-profile');
  for(const suffix of ['', 'AppData/Roaming', 'AppData/Local', 'tmp', 'cache']) {
    const target=path.join(root,suffix);let current=noraHome;
    for(const part of path.relative(noraHome,target).split(path.sep).filter(Boolean)) {
      current=path.join(current,part);
      try {fs.mkdirSync(current);} catch(error) {if(error.code!=='EEXIST')throw error;}
      const stat=fs.lstatSync(current);
      if(!stat.isDirectory()||stat.isSymbolicLink())
        throw Object.assign(new Error('Bootstrap profile is redirected'),{code:'LOCK_CHILD_IDENTITY'});
    }
  }
  return {HOME:root,USERPROFILE:root,HERMES_HOME:root,APPDATA:path.join(root,'AppData','Roaming'),
    LOCALAPPDATA:path.join(root,'AppData','Local'),TMP:path.join(root,'tmp'),TEMP:path.join(root,'tmp'),
    TMPDIR:path.join(root,'tmp'),XDG_CACHE_HOME:path.join(root,'cache')};
}

function spawnJob(message,sink,parentJobId) {
  if (cancelling || (!parentJobId && releasing) || ledgerError) throw Object.assign(new Error('Operation cannot start another child'),{code:ledgerError?.code || (cancelling ? 'LOCK_CANCELLING' : 'LOCK_RELEASING')});
  if(session.jobs.length>=64)throw Object.assign(new Error('Operation child limit reached'),{code:'LOCK_CHILD_LIMIT'});
  const job={jobId:message.jobId,parentJobId,kind:message.kind,pid:null,spawnIntentAt:new Date().toISOString(),
    delegation:{tokenDigest:crypto.createHash('sha256').update(message.delegationToken).digest('hex'),identityStatus:'pending'}};
  if(typeof message.command!=='string' || !Array.isArray(message.args) || message.args.some(value=>typeof value!=='string')
      || !/^[a-z][a-z-]{0,63}$/.test(message.kind || '') || message.options?.detached || message.options?.shell || message.options?.stdio)
    throw Object.assign(new Error('Invalid guarded spawn request'),{code:'LOCK_CHILD_IDENTITY'});
  const args=[...message.args],options={...message.options};let command=message.command;
  const managedPythonRoot=options.managedPythonRoot,venvHome=options.venvHome,managedNodeRoot=options.managedNodeRoot;
  const runtimeRoot=options.runtimeRoot,purpose=options.purpose;
  delete options.managedPythonRoot;delete options.venvHome;delete options.managedNodeRoot;delete options.runtimeRoot;delete options.purpose;
  let childEnv={...(options.env || process.env)};
  if(message.kind==='python-maintenance') {
    const resolved=resolveExecution(command,{managedPythonRoot,venvHome,env:childEnv});
    command=resolved.command;childEnv=resolved.env;job.executionIdentity=resolved.executionIdentity;
  }
  if(message.kind==='runtime-bootstrap') {
    if(!path.isAbsolute(message.command) || !path.isAbsolute(args[0] || '') || path.basename(args[0])!=='runtime-worker.js')
      throw Object.assign(new Error('Runtime bootstrap identity is invalid'),{code:'LOCK_CHILD_IDENTITY'});
    if(!args.slice(1,4).every(path.isAbsolute)||path.resolve(args[3])!==path.join(path.resolve(args[2]),'hermes'))
      throw Object.assign(new Error('Runtime bootstrap scope is invalid'),{code:'LOCK_CHILD_IDENTITY'});
    job.executionIdentity={executable:fs.realpathSync(message.command),script:fs.realpathSync(args[0]),
      jobArgument:`--nora-operation-job=${message.jobId}`};
    const noraHome=fs.realpathSync(args[2]);
    job.runtimeScope={payloadRoot:fs.existsSync(args[1])?fs.realpathSync(args[1]):path.resolve(args[1]),noraHome,hermesHome:path.join(noraHome,'hermes')};
    childEnv={...childEnv,...bootstrapProfile(noraHome)};
    args.push(job.executionIdentity.jobArgument);
  }
  if(message.kind==='legacy-recovery') {
    if(!path.isAbsolute(message.command)||!path.isAbsolute(args[0]||'')||path.basename(args[0])!=='legacy-recovery-worker.js'
      ||!path.isAbsolute(args[1]||'')||path.resolve(context.directory)!==path.join(fs.realpathSync(args[1]),'installer'))
      throw Object.assign(new Error('Legacy recovery scope is invalid'),{code:'LOCK_CHILD_IDENTITY'});
    job.executionIdentity={executable:fs.realpathSync(message.command),script:fs.realpathSync(args[0]),
      jobArgument:`--nora-operation-job=${message.jobId}`};
    childEnv={...childEnv,...bootstrapProfile(fs.realpathSync(args[1]))};
    args.push(job.executionIdentity.jobArgument);
  }
  if(message.kind==='runtime-helper') {
    const parent=children.get(parentJobId),scope=parent?.job.runtimeScope;
    if(parent?.job.kind!=='runtime-bootstrap'||!scope||!path.isAbsolute(command))
      throw Object.assign(new Error('Runtime helpers require the owning bootstrap executor'),{code:'LOCK_CHILD_IDENTITY'});
    const actual=fs.realpathSync(command),same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    const system=process.env.SystemRoot||'C:\\Windows';
    if(purpose==='extract'){
      const permitted=process.platform==='win32'?[path.join(system,'System32','tar.exe'),path.join(system,'System32','WindowsPowerShell','v1.0','powershell.exe')]:['/usr/bin/tar'];
      if(!permitted.some(file=>{try{return same(actual,fs.realpathSync(file));}catch{return false;}}))
        throw Object.assign(new Error('The system runtime extractor is not trusted'),{code:'LOCK_CHILD_IDENTITY'});
    }else{
      const staging=path.join(scope.noraHome,'installer','operations',context.operationId,'runtime','hermes-runtime');
      if(!path.isAbsolute(runtimeRoot||'')||![scope.hermesHome,staging].some(root=>same(path.resolve(root),path.resolve(runtimeRoot))))
        throw Object.assign(new Error('Runtime helper directory is outside this operation'),{code:'LOCK_CHILD_IDENTITY'});
      const root=fs.realpathSync(runtimeRoot);
      if(purpose==='python'){
        const python=process.platform==='win32'?fs.realpathSync(path.join(root,'python','python.exe')):actual;
        if(process.platform==='darwin'&&(!actual.startsWith(fs.realpathSync(path.join(root,'python'))+path.sep)||!/^python(?:\d+(?:\.\d+)*)?$/.test(path.basename(actual))))
          throw Object.assign(new Error('Runtime Python is outside this tree'),{code:'LOCK_CHILD_IDENTITY'});
        if(venvHome){
          const resolved=resolveExecution(command,{managedPythonRoot,venvHome,env:childEnv});command=resolved.command;childEnv=resolved.env;job.executionIdentity=resolved.executionIdentity;
          if(!same(fs.realpathSync(command),python))throw Object.assign(new Error('Runtime virtual Python does not belong to this tree'),{code:'LOCK_CHILD_IDENTITY'});
        }else if(!same(actual,python))throw Object.assign(new Error('Runtime Python is outside this tree'),{code:'LOCK_CHILD_IDENTITY'});
      }else if(purpose==='node'){
        const node=fs.realpathSync(path.join(root,process.platform==='win32'?'node/node.exe':'node/bin/node'));
        if(!same(actual,node))throw Object.assign(new Error('Runtime Node is outside this tree'),{code:'LOCK_CHILD_IDENTITY'});
      }else throw Object.assign(new Error('Unsupported runtime helper purpose'),{code:'LOCK_CHILD_IDENTITY'});
    }
    job.delegation.identityStatus='not-required';job.executionIdentity={...job.executionIdentity,purpose};
  }
  if(message.kind==='node-maintenance') {
    if(!path.isAbsolute(managedNodeRoot || '') || !path.isAbsolute(command) || !path.isAbsolute(args[0] || '')
        || path.basename(args[0])!=='operation_node.mjs')
      throw Object.assign(new Error('Managed Node maintenance identity is required'),{code:'LOCK_CHILD_IDENTITY'});
    const root=fs.realpathSync(managedNodeRoot),expected=fs.realpathSync(path.join(root,process.platform==='win32' ? 'node.exe' : 'bin/node'));
    const actual=fs.realpathSync(command);
    if((process.platform==='win32' ? actual.toLowerCase()!==expected.toLowerCase() : actual!==expected))
      throw Object.assign(new Error('Node command does not belong to the managed runtime'),{code:'LOCK_CHILD_IDENTITY'});
    job.executionIdentity={executable:actual,managedNodeRoot:root,script:fs.realpathSync(args[0]),
      jobArgument:`--nora-operation-job=${message.jobId}`};
    args.splice(1,0,job.executionIdentity.jobArgument);
  }
  const delegateIndex=args.indexOf('--delegate-exec');
  if(message.kind==='python-maintenance' && delegateIndex>0
      && path.isAbsolute(args[delegateIndex-1]) && path.basename(args[delegateIndex-1])==='operation_control.py') {
    job.executionIdentity={...job.executionIdentity,script:fs.realpathSync(args[delegateIndex-1]),
      jobArgument:`--nora-operation-job=${message.jobId}`};
    args.splice(delegateIndex,0,job.executionIdentity.jobArgument);
  }
  const executable=path.isAbsolute(command) ? fs.realpathSync(command) : undefined;
  job.executionIdentity={...job.executionIdentity,executable,
    argvDigest:crypto.createHash('sha256').update(JSON.stringify([executable || command,...args])).digest('hex'),
    argvEncoding:'realpath-first-json-array'};
  session.jobs.push(job);persist();
  const child=spawn(command,args,{...options,detached:false,stdio:['pipe','pipe','pipe'],
    env:{...childEnv,NORA_OPERATION_DELEGATE_ENDPOINT:endpoint,
      NORA_OPERATION_DELEGATE_TOKEN:message.delegationToken,NORA_OPERATION_JOB_ID:message.jobId,
      NORA_OPERATION_ID:context.operationId,NORA_OPERATION_OWNER_EPOCH:String(context.ownerEpoch)}});
  child.stdin.on('error',()=>{});
  const entry={child,job,token:message.delegationToken,sink,parentJobId};children.set(message.jobId,entry);
  child.once('spawn',()=>{
    job.pid=child.pid;job.spawnConfirmedAt=new Date().toISOString();
    if(!record(message.jobId)){child.kill('SIGTERM');return;}
    notify(entry,{type:'child',event:'spawn',jobId:message.jobId,pid:child.pid});
    if(message.kind==='runtime-helper')creationIdentity(child.pid).then(identity=>{
      if(children.has(message.jobId)){job.creationIdentity={...identity,source:'guard-os-inspection'};record(message.jobId);}
    },()=>{if(children.has(message.jobId)){job.creationIdentityUnknown=true;record(message.jobId);}});
  });
  for (const stream of ['stdout','stderr']) child[stream].on('data',value=>notify(entry,{type:'child',event:stream,jobId:message.jobId,data:value.toString('base64')}));
  child.once('error',error=>{job.spawnFailedAt=new Date().toISOString();job.spawnErrorCode=error.code;record(message.jobId);
    notify(entry,{type:'child',event:'error',jobId:message.jobId,error:failureReply(error,{code:error.code,message:'Maintenance child could not start'})});});
  child.once('exit',(code,signal)=>{job.exitedAt=new Date().toISOString();job.exitCode=code;job.exitSignal=signal;record(message.jobId);
    notify(entry,{type:'child',event:'exit',jobId:message.jobId,code,signal});});
  child.once('close',(code,signal)=>{
    job.closedAt=new Date().toISOString();job.exitCode=code;job.exitSignal=signal;record(message.jobId);
    entry.socket?.destroy();children.delete(message.jobId);
    notify(entry,{type:'child',event:'close',jobId:message.jobId,code,signal});finish();
  });
  return entry;
}

function delegatedRequest(socket,parentJobId,message) {
  const reply=(result,error)=>socket.write(JSON.stringify({type:'reply',requestId:message.requestId,result,error})+'\n');
  try {
    if(!/^[\w-]{1,120}$/.test(message.requestId || '') || !children.get(parentJobId)?.socket?.authorized)
      throw Object.assign(new Error('Live parent delegation is required'),{code:'STALE_DELEGATION'});
    if(message.type==='spawn') {
      if(!['python-maintenance','node-maintenance','runtime-helper'].includes(message.kind))throw Object.assign(new Error('Nested executor must use a managed runtime'),{code:'LOCK_CHILD_IDENTITY'});
      const entry=spawnJob({...message,jobId:crypto.randomUUID(),delegationToken:crypto.randomBytes(32).toString('hex')},socket,parentJobId);
      reply({jobId:entry.job.jobId});return;
    }
    const entry=children.get(message.jobId);
    const saved=session.jobs.find(job=>job.jobId===message.jobId && job.parentJobId===parentJobId);
    if(!saved)throw Object.assign(new Error('This parent does not own the child'),{code:'STALE_DELEGATION'});
    if(message.type==='snapshot'){reply({...saved});return;}
    if(message.type==='kill'){reply({sent:entry?.child.kill(message.signal || 'SIGTERM') || false});return;}
    if(message.type==='stdin'){
      if(typeof message.data!=='string' || message.data.length>128*1024)throw new Error('Invalid stdin frame');
      if(entry?.child.stdin.writable)entry.child.stdin.write(Buffer.from(message.data,'base64'));reply({});return;
    }
    if(message.type==='stdin-end'){entry?.child.stdin.end();reply({});return;}
    throw new Error('Unsupported delegated request');
  } catch(error){reply(undefined,failureReply(error,{code:error.code||'DELEGATED_REQUEST_FAILED'}));}
}

process.on('message', async message => {
  try {
    if (!context) { await initialize(message);return; }
    if (message.token!==context.token || message.ownerEpoch!==context.ownerEpoch || message.operationId!==context.operationId) {
      send({type:'reply',id:message.id,error:failureReply(Object.assign(new Error('This request does not own the operation'),{code:'STALE_OWNER'}))});return;
    }
    if (message.type==='snapshot') {send({type:'reply',id:message.id,result:snapshot()});return;}
    if(message.type==='operation-commit'){
      try{send({type:'reply',id:message.id,result:commitOperation(message)});}
      catch(error){send({type:'reply',id:message.id,error:failureReply(error,{code:error.code||'OPERATION_COMMIT_FAILED'})});}
      return;
    }
    if(message.type==='cancel') {
      if(!['SIGTERM','SIGKILL','SIGINT'].includes(message.signal))throw Object.assign(new Error('Unsupported cancellation signal'),{code:'LOCK_CANCEL_SIGNAL'});
      cancelling=true;cancellations.push(message.id);session.cancellationRequestedAt=new Date().toISOString();
      session.cancellationSignal=message.signal;record();
      for(const entry of children.values()){entry.job.cancelRequestedAt=session.cancellationRequestedAt;entry.child.kill(message.signal);}
      record();finish();return;
    }
    if (message.type==='release') {releasing=true;finish();return;}
    if(message.type==='spawn'){spawnJob(message);return;}
    const child=children.get(message.jobId)?.child;
    if (message.type==='kill') {child?.kill(message.signal);return;}
    if (message.type==='stdin') {if(child?.stdin.writable) child.stdin.write(Buffer.from(message.data,'base64'));return;}
    if (message.type==='stdin-end') {child?.stdin.end();return;}
  } catch(error) {
    const response={type:initialized ? 'failure' : 'ready',jobId:message.jobId,error:failureReply(error)};
    if(initialized)send(response);
    else {
      if(writerLock){try{writerLock.release();}catch{}writerLock=undefined;}
      sendFinalReady(response);
    }
  }
});
process.on('disconnect',()=>{ownerConnected=false;if(session){session.ownerConnected=false;session.outputDeliveryInterrupted=true;record();}finish();});
