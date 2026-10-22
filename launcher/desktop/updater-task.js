// Both callers submit to this detached owner. Job files contain only the
// submission and pointer; OperationController owns the one durable outcome.
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const capability=require('./updater-capability');
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminal=new Set(['succeeded','failed','rolled-back','blocked','cancelled','recovery-required','interrupted']);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const failure=(code,message)=>Object.assign(new Error(message),{code});
function diagnostic(error,depth=0){return {name:error.name,code:error.code,message:error.message,stack:error.stack,
  ...(error.cause&&depth<3?{cause:diagnostic(error.cause,depth+1)}:{})};}
function read(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)throw failure('UPDATER_JOB_INVALID','更新任务记录无法读取，请保留日志。');return JSON.parse(fs.readFileSync(file,'utf8'));}
function jobRoot(home,id){if(!ID.test(id))throw failure('UPDATER_JOB_INVALID','更新任务编号无效。');return path.join(path.resolve(home),'installer/update-jobs',id);}
function latest(home){
  const directory=path.join(path.resolve(home),'installer/update-jobs');
  if(!fs.existsSync(directory))return null;
  return fs.readdirSync(directory).filter(item=>ID.test(item)).sort((a,b)=>fs.statSync(path.join(directory,b)).mtimeMs-fs.statSync(path.join(directory,a)).mtimeMs)[0]||null;
}
function loadDependencies(receipt){process.env.NODE_PATH=path.join(receipt.opsRoot,'updater/actor-dependencies/node_modules');require('node:module').Module._initPaths();}
function writerBusy(home){
  // Query with the dependencies of this executing closure, never a path from
  // an untrusted job receipt. Electron already has its own native dependency.
  const opsRoot=path.resolve(__dirname,'../..');
  if(fs.existsSync(path.join(opsRoot,'updater/actor-dependencies/node_modules/fs-native-extensions/package.json')))
    loadDependencies({opsRoot});
  const probe=require('./os-lock').acquire({directory:path.join(path.resolve(home),'installer'),probe:true});
  try{return probe.busy;}finally{probe.release();}
}
let readerReady=false;
function prepareReader(options={}){
  if(readerReady)return;
  const opsRoot=path.resolve(__dirname,'../..');
  const manifestPath=[path.join(opsRoot,'../release-manifest.json'),
    path.join(opsRoot,'../../tavern-updates/installed-manifest.json')].find(file=>fs.existsSync(file))
    ||(options.opsRoot&&path.resolve(options.opsRoot)===opsRoot?options.manifestPath:null);
  // Bootstrap runners carry an explicit external manifest; their own directory
  // has no installed receipt or adjacent manifest yet. Verify that exact code
  // before making its locked native dependencies available. Packaged Electron
  // and source imports already belong to their executing closure.
  if(manifestPath)loadDependencies(capability.verifyReader({opsRoot,manifestPath}));
  // Pin the query's only non-builtin modules now. A later status poll must not
  // load new on-disk reader code after its installation has been replaced.
  require('./operation-delegate');require('./os-lock');
  readerReady=true;
}
function operationReference(home,id){
  const refFile=path.join(jobRoot(home,id),'operation-ref.json');
  if(fs.existsSync(refFile)){const ref=read(refFile);if(!ID.test(ref.operationId))throw failure('UPDATER_JOB_INVALID','更新操作编号无效。');return ref;}
  // Admission commits the canonical operation before publishing its pointer.
  // Reconcile that small crash window from the existing controller's record.
  const directory=path.join(path.resolve(home),'installer/operations');
  if(!fs.existsSync(directory))return null;
  let found;
  const requestFile=path.join(jobRoot(home,id),'request.json');
  const submission=fs.existsSync(requestFile)?read(requestFile):null;
  // A retry points to an existing terminal operation before its new worker
  // has acquired the writer. Only this worker's admission pointer proves the
  // attempt started; canonical lookup here would return the previous failure
  // (or an unrelated recheck) as if the new attempt had already finished.
  if(submission?.request?.operationId)return null;
  const canonicalId=submission?.operationRequestId||id;
  if(!ID.test(canonicalId))throw failure('UPDATER_JOB_INVALID','更新提交关联无效，请保留日志。');
  for(const operationId of fs.readdirSync(directory).filter(name=>ID.test(name))){
    const file=path.join(directory,operationId,'operation.json');if(!fs.existsSync(file))continue;
    const operation=read(file);
    if(operation.requestId===canonicalId){if(found)throw failure('UPDATER_JOB_INVALID','同一更新请求对应多个操作，请保留日志。');found={operationId};}
  }
  return found||null;
}
function inspection(id,error,message='无法核验更新任务是否结束，请保留日志，暂勿重复更新。'){
  return {status:'inspection-required',busy:null,settled:false,requestId:id,code:'UPDATER_INSPECTION_REQUIRED',message,diagnostic:diagnostic(error)};
}
async function identityAlive(identity){
  if(!Number.isSafeInteger(identity?.pid)||identity.pid<1||!Number.isFinite(identity.creationTime)||identity.creationTime<=0)
    throw failure('UPDATER_JOB_INVALID','更新进程身份记录无效，请保留日志。');
  try{process.kill(identity.pid,0);}catch(error){if(error.code==='ESRCH')return false;throw error;}
  try{
    const current=await require('./operation-delegate').creationIdentity(identity.pid);
    if(process.platform==='linux'){
      const stat=fs.readFileSync('/proc/'+identity.pid+'/stat','utf8');
      if(['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[0]))return false;
    }
    return current.creationTime===identity.creationTime;
  }
  catch(error){try{process.kill(identity.pid,0);}catch(probe){if(probe.code==='ESRCH')return false;}throw error;}
}
async function pending(home,id){
  const job=jobRoot(home,id);
  try{
    let busy=writerBusy(home);if(busy)return {status:'in-progress',requestId:id,busy:true,settled:false,log:path.join(job,'worker.log')};
    // Once a worker published its identity it is the only possible owner; a
    // still-open caller cannot keep a dead acknowledged worker 'submitting'.
    const owners=fs.existsSync(path.join(job,'worker.json'))?['worker.json']:['submitter.json'];
    const identities=owners.filter(name=>fs.existsSync(path.join(job,name))).map(name=>read(path.join(job,name)));
    if(!identities.length)throw failure('UPDATER_IDENTITY_UNKNOWN','旧更新提交缺少进程身份，不能确认是否已接管；请保留记录和日志。');
    const alive=await Promise.all(identities.map(identityAlive));
    // Re-read after liveness: a worker may have admitted while it was inspected.
    if(operationReference(home,id))return status(home,id);
    busy=writerBusy(home);if(busy)return {status:'in-progress',requestId:id,busy:true,settled:false,log:path.join(job,'worker.log')};
    if(alive.some(Boolean))return {status:'submitting',requestId:id,busy:false,settled:false,log:path.join(job,'worker.log')};
    return {status:'interrupted',requestId:id,busy:false,settled:true,code:'UPDATER_SUBMISSION_INTERRUPTED',
      message:'更新提交已中断，尚未开始替换程序；可以重新发起更新。',log:path.join(job,'worker.log')};
  }catch(error){return inspection(id,error);}
}
function status(home,id){
  if(!id){
    id=latest(home);if(!id)return {status:'none',busy:false,settled:true};
  }
  const job=jobRoot(home,id),ref=operationReference(home,id);
  if(ref){
    const file=path.join(path.resolve(home),'installer/operations',ref.operationId,'operation.json');
    let operation=read(file),busy;
    try{
      busy=writerBusy(home);
      // Read the committed record again after the first free-lock observation,
      // then probe once more rather than publish the pre-recovery failed bytes.
      if(!busy){operation=read(file);busy=writerBusy(home);}
    }catch(error){return {status:'inspection-required',busy:null,settled:false,requestId:id,
      code:'UPDATER_INSPECTION_REQUIRED',message:'无法核验更新任务是否结束，请保留日志，暂勿重复更新。',
      diagnostic:diagnostic(error),operation:{...operation,snapshotSequence:operation.sequence},log:path.join(job,'worker.log')};}
    return {status:busy?'in-progress':terminal.has(operation.state)?operation.state:'interrupted',busy,settled:!busy,
      requestId:id,operation:{...operation,snapshotSequence:operation.sequence},log:path.join(job,'worker.log')};
  }
  const error=path.join(job,'admission-error.json');
  if(fs.existsSync(error))return {status:'error',requestId:id,...read(error),busy:false,settled:true};
  return {status:'submitting',requestId:id,busy:null,settled:false,log:path.join(job,'worker.log')};
}
async function query(home,id){
  id=id||latest(home);if(!id)return status(home,id);
  try{
    prepareReader();
    const current=status(home,id);
    return current.status==='submitting'?await pending(home,id):current;
  }catch(error){return inspection(id,error,'更新任务的查询文件无法核验，请保留日志，暂勿重复更新。');}
}
async function submit(options,{admissionWaitMs=15000}={}){
  if(!Number.isFinite(admissionWaitMs)||admissionWaitMs<0||admissionWaitMs>15000)throw new TypeError('Invalid updater admission wait budget');
  const requestId=options.requestId||randomUUID(),job=jobRoot(options.noraHome,requestId);
  if(options.operationRequestId!==undefined&&!ID.test(options.operationRequestId))throw failure('UPDATER_JOB_INVALID','更新操作请求编号无效。');
  prepareReader(options);
  const submitter=await require('./operation-delegate').creationIdentity();
  fs.mkdirSync(path.dirname(job),{recursive:true,mode:0o700});
  if(fs.existsSync(job))return query(options.noraHome,requestId);
  // Publish the request with birth identity already present. Interrupted
  // preparation directories are not discovered as update tasks.
  const preparation=fs.mkdtempSync(path.join(path.dirname(job),'.submit-'));let workerStarted=false;
  try{
    capability.atomic(path.join(preparation,'submitter.json'),submitter);
    try{fs.renameSync(preparation,job);}
    catch(error){if(['EEXIST','ENOTEMPTY'].includes(error.code))return query(options.noraHome,requestId);throw error;}
  }finally{fs.rmSync(preparation,{recursive:true,force:true});}
  try{
    const staged=capability.stage({...options,jobDirectory:job});
    const target=staged.receipt.resources['launcher_bridge.py'].path;
    const argv=[target,'--nora-home',staged.receipt.noraHome,'--hermes-home',staged.receipt.hermesHome,
      '--install-root',staged.receipt.installRoot,'--port',String(staged.receipt.port),options.action==='recover'?'recover-update':'update'];
    for(const [key,flag] of [['releaseDir','--release-dir'],['tag','--tag'],['operationId','--operation-id'],['targetCommit','--target-commit']])if(options[key])argv.push(flag,options[key]);
    if(options.targetManifestSha256||options.manifestSha256)argv.push('--manifest-sha256',options.targetManifestSha256||options.manifestSha256);
    if(options.allowCandidate)argv.push('--allow-candidate');
    const request={schema:'nora-cli-request/1',kind:options.action==='recover'?'recover':'update',argv,stdin:'',
      ...(options.operationId?{operationId:options.operationId,snapshotSequence:options.snapshotSequence}:{})};
    capability.atomic(path.join(job,'request.json'),{request,requestId,
      ...(options.operationRequestId?{operationRequestId:options.operationRequestId}:{}),retiringSubmitter:options.retireSubmitter?process.pid:null});
    const log=fs.openSync(path.join(job,'worker.log'),'a',0o600);
    try{
      const env={...process.env};for(const name of Object.keys(env))if(name.startsWith('NORA_OPERATION_')||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(name))delete env[name];
      const child=spawn(staged.receipt.executable.path,[path.join(staged.receipt.opsRoot,'installer/desktop/updater-task.js'),'--worker',staged.receiptPath],
        {env,cwd:job,detached:true,windowsHide:true,stdio:['ignore',log,log,'ipc']});
      child.once('spawn',()=>{workerStarted=true;});child.unref();await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>finish(failure('UPDATER_HANDOFF_UNCONFIRMED','更新器接管未确认，未开始替换程序。请查询本次任务。')),15000);
        function finish(error){clearTimeout(timer);child.removeListener('error',finish);child.removeListener('exit',exited);child.removeListener('message',ready);error?reject(error):resolve();}
        function exited(){finish(failure('UPDATER_START_FAILED','更新器在接管前退出，未开始替换程序。'));}
        function ready(message){
          if(message?.event!=='updater-ready'||message.identity?.pid!==child.pid)return;
          // The worker persisted its birth before this event. It cannot execute
          // until acknowledged, and exits on an early parent disconnect.
          child.send({event:'updater-ack'},error=>finish(error));
        }
        child.once('error',finish);child.once('exit',exited);child.on('message',ready);
      });
    }finally{fs.closeSync(log);}
    const deadline=Date.now()+admissionWaitMs;
    while(Date.now()<deadline){const current=status(options.noraHome,requestId);if(current.status!=='submitting')return current;await delay(100);}
    // The worker acknowledged its independent lifetime. Slow controller
    // admission is pending, not a failed update; return its identity so the
    // short-lived caller can exit and follow this same request to completion.
    return {status:'submitting',requestId,busy:null,settled:false,code:'UPDATER_ADMISSION_PENDING',
      message:'更新器正在接管，请继续查询本次任务，不要重复启动更新。',log:path.join(job,'worker.log')};
  }catch(error){
    if(!workerStarted&&error.code!=='UPDATER_ADMISSION_PENDING')capability.atomic(path.join(job,'admission-error.json'),{code:error.code||'UPDATER_START_FAILED',message:error.message,diagnostic:diagnostic(error)});
    throw error;
  }
}
async function wait(home,id,{onEvent=()=>{},pollMs=500}={}){
  id=id||latest(home);let sequence;
  while(true){const current=await query(home,id);if(current.operation?.snapshotSequence!==sequence){sequence=current.operation?.snapshotSequence;onEvent(current);}
    if(current.status==='inspection-required')throw failure(current.code,current.message);
    if(current.settled===true&&(terminal.has(current.status)||['none','error'].includes(current.status)))return current;await delay(pollMs);}
}
async function worker(receiptPath){
  const job=path.dirname(receiptPath);
  try{
    const receipt=await capability.validate({receiptPath,currentExecutable:process.execPath});loadDependencies(receipt);
    const identity=await require('./operation-delegate').creationIdentity();
    capability.atomic(path.join(job,'worker.json'),identity);
    if(process.send&&!process.connected)throw failure('UPDATER_SUBMISSION_INTERRUPTED','提交进程在接管前退出，未开始替换程序。');
    if(process.send)await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(failure('UPDATER_HANDOFF_UNCONFIRMED','提交进程未确认接管，未开始替换程序。')),15000);
      function finish(error){clearTimeout(timer);process.removeListener('message',acknowledge);process.removeListener('disconnect',disconnected);if(process.connected)process.disconnect();error?reject(error):resolve();}
      function acknowledge(message){if(message?.event==='updater-ack')finish();}
      function disconnected(){finish(failure('UPDATER_SUBMISSION_INTERRUPTED','提交进程在接管前退出，未开始替换程序。'));}
      process.on('message',acknowledge);process.once('disconnect',disconnected);process.send({event:'updater-ready',identity});
    });
    const {request,requestId,operationRequestId,retiringSubmitter}=read(path.join(job,'request.json'));
    if(operationRequestId!==undefined&&!ID.test(operationRequestId))throw failure('UPDATER_JOB_INVALID','更新操作关联无法核验。');
    const result=await require('./operation-cli').execute({receiptPath,request},{client:'updater',validate:capability.validate,
      telemetry:!request.argv.includes('--allow-candidate'),
      authorizeTarget:capability.authorizeTarget,requestId:operationRequestId||requestId,
      onAdmission:async context=>{
        capability.atomic(path.join(job,'operation-ref.json'),{operationId:context.operationId});
        if(retiringSubmitter){
          // Gateway shutdown deliberately terminates its descendants. Wait for
          // the short-lived submitter to exit/reap before doing work; detached
          // flags alone do not remove an ancestor relationship on Windows.
          const deadline=Date.now()+15000;
          while(true){let alive=true;try{process.kill(retiringSubmitter,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
            if(!alive)break;if(Date.now()>=deadline)throw failure('UPDATER_HANDOFF_UNCONFIRMED','提交进程尚未退出，未开始替换程序。请查询本次任务，不要删除记录。');await delay(25);}
        }
      },
      onEvent:event=>process.stdout.write(JSON.stringify(event)+'\n')});
    if(!fs.existsSync(path.join(job,'operation-ref.json')))capability.atomic(path.join(job,'operation-ref.json'),{operationId:result.operationId});
    process.stdout.write(JSON.stringify(require('./operation-cli').terminalResult(result))+'\n');
  }catch(error){
    // A controller-owned failure already lives in operation.json. Admission
    // failures have no operation; retain just their diagnostic, never fake one.
    if(!fs.existsSync(path.join(job,'operation-ref.json')))capability.atomic(path.join(job,'admission-error.json'),{code:error.code||'UPDATER_FAILED',message:error.message,diagnostic:diagnostic(error)});
    throw error;
  }
}
async function check(options){
  // A version lookup has no file-transaction owner and publishes no job. Verify
  // the reader/dependencies, then query metadata without copying a writer.
  prepareReader(options);
  const opsRoot=options.opsRoot||path.join(options.installRoot,'apps/tavern-ops');
  const manifestPath=options.manifestPath||path.join(options.installRoot,'tavern-updates/installed-manifest.json');
  loadDependencies(capability.verifyReader({opsRoot,manifestPath}));
  const releases=require('./releases');
  return checkResult(await releases.check({client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES,installRoot:options.installRoot,
    channel:options.channel||'stable',platform:process.platform,arch:process.arch}));
}
function checkResult(result){
  // The caller needs a version decision, not a megabyte of internal sealed
  // metadata. The writer still selects and seals its own authoritative plan.
  const fields=['current','versionSource','latest','releaseTag','checkedAt','metadataSource','latestConfirmed','retryAt',
    'releaseUrl','updateSupported','channel','state','releaseAvailable','available','installable','compatibilityError'];
  return Object.fromEntries(fields.filter(name=>Object.hasOwn(result,name)).map(name=>[name,result[name]]));
}
async function main(){
  if(process.argv[2]==='--worker')return worker(process.argv[3]);
  let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>1024*1024)throw failure('UPDATER_REQUEST_INVALID','更新请求过大。');}
  const options=JSON.parse(data);
  options.retireSubmitter=true;
  prepareReader(options);
  if(options.scope==='desktop'){
    const result=await require('./skill-update').desktopRequest(options);
    process.stdout.write(JSON.stringify({...result,scope:'desktop'})+'\n');
    if(['error','inspection-required','interrupted'].includes(result.status))process.exitCode=1;
    return;
  }
  const result=options.action==='status'?await query(options.noraHome,options.requestId):options.action==='wait'?await wait(options.noraHome,options.requestId):
    options.action==='check'?await check(options):await submit(options);
  process.stdout.write(JSON.stringify({event:'result',...result})+'\n');
  if(['error','inspection-required'].includes(result.status)||terminal.has(result.status)&&result.status!=='succeeded'&&!(options.action==='recover'&&result.status==='rolled-back'))process.exitCode=1;
}
if(require.main===module)main().catch(error=>{process.stderr.write(JSON.stringify({event:'error',code:error.code||'UPDATER_FAILED',message:error.message,diagnostic:diagnostic(error)})+'\n');process.exitCode=1;});
module.exports={submit,status,query,wait,worker,checkResult,desktopProtocol:'nora-desktop-update/1'};
