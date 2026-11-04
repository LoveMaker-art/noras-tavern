const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { launcherError,programError } = require('./launcher-errors');
const {downloadAsset,createReleaseSourceContext} = require('./release-network');
const releases = () => require('./releases');

function validateManifest(item,{release,manifest,platform = process.platform,arch = process.arch}) {
  if (!item || item.schema !== 'nora-launcher/v1' || item.candidate || item.platform !== platform || item.arch !== arch
    || item.version !== manifest.launcherVersion || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
    || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 2 * 1024 ** 3
    || !/^Nora-Tavern-Launcher-[\w.-]+-update\.zip$/.test(item.asset || '')) throw new Error('启动器更新清单无效，当前安装未修改。');
  releases().assetUrl(release,item.asset);
  releases().validateAssetIntegrity(release,item.asset,item);
  return item;
}
async function inspect({ release, manifest, launcherVersion, fetcher, signal, platform = process.platform, arch = process.arch, launcherManifest,metadataCache,networkPolicy,channel }) {
  const r = releases();
  if (manifest.launcherVersion !== undefined && r.compare(manifest.launcherVersion, manifest.launcherVersion) !== 0) throw new Error('发布中的启动器版本无效。');
  if (r.compare(launcherVersion, manifest.launcherVersion) !== -1) return null;
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(`${platform}-${arch}`)) throw new Error('此系统暂不支持自动替换启动器。');
  const item = launcherManifest || await r.requestJson(r.assetUrl(release, `nora-launcher-${platform}-${arch}.json`), fetcher, signal,{metadataCache,networkPolicy,channel,conditionIdentity:{expectedVersion:manifest.launcherVersion}});
  return validateManifest(item,{release,manifest,platform,arch});
}

async function prepare(options) {
  options={...options,networkPolicy:{...options.networkPolicy,
    sourceContext:options.networkPolicy?.sourceContext || createReleaseSourceContext()}};
  const r = releases();
  options.onEvent?.({ event: 'task', stage_id: 'release_check', task: '检查最新版本与更新清单' });
  const selectedPlan = options.selectedPlan ? (options.selectedPlan.client==='app'?r.validateAppPlan:r.validatePlan)(options.selectedPlan,options)
    :await (r.selectAppPlan||r.selectPlan)(options);
  options.networkPolicy.sourceContext.bindTarget(selectedPlan.tag);
  const release = selectedPlan.release, manifest = selectedPlan.releaseManifest;
  const item = await inspect({ ...options, release, manifest,launcherManifest:selectedPlan.launcherManifest });
  if(selectedPlan.client!=='app')r.validateUpdate(manifest, release, item?.version || options.launcherVersion,
    selectedPlan.mode==='install' ? {systemManifest:selectedPlan.systemManifest,platform:selectedPlan.platform,
      arch:selectedPlan.arch,channel:selectedPlan.channel} : undefined);
  if (!item) return { tag: release.tag_name, manifest, launcher: null,releasePlan:selectedPlan };
  const root = path.join(options.cacheRoot, 'launcher-' + item.sha256.slice(0, 16));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const archive = path.join(root, item.asset);
  await downloadAsset({url:r.assetUrl(release,item.asset),target:archive,identity:{tag:release.tag_name,asset:item.asset,sha256:item.sha256,size:item.size},
    fetcher:options.fetcher,signal:options.signal,policy:options.networkPolicy,fixedPlanSourceEvidence:r.fixedPlanSourceEvidence(selectedPlan),task:'正在下载启动器更新',
    onEvent:event=>options.onEvent?.({...event,...(event.event==='progress'?{ratio:event.total ? event.current/event.total:0}:{})})});
  return { tag: release.tag_name, manifest, launcher: { ...item, archive },releasePlan:selectedPlan };
}

function applicationRoot(executable, platform = process.platform) {
  return platform === 'darwin' ? path.resolve(executable, '../../..') : path.dirname(executable);
}
function helperCwd(job) {
  if (process.platform !== 'win32' || job.length < 248) return job;
  const root = path.parse(process.execPath).root;
  if (!root || root.length >= 248 || !fs.statSync(root).isDirectory()) throw new Error('没有可用的短启动目录，请保留程序和恢复日志。');
  return root;
}
const OPERATION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function atomicJson(file,value){
  const temporary=`${file}.${crypto.randomUUID()}.tmp`,fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
  if(process.platform!=='win32'){const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
}
async function prepareHandoff(options){
  const {prepared,home,executable,python,helper,previousVersion,localRelease,skillId,
    operation,spawnChild,onEvent=()=>{}}=options;
  if(process.env.PORTABLE_EXECUTABLE_FILE)throw new Error('Windows 便携版不能原位替换临时运行目录。请使用安装版覆盖升级；现有数据不会被删除。');
  if(!OPERATION_ID.test(operation?.operationId||'')||!Number.isSafeInteger(operation.ownerEpoch)||operation.ownerEpoch<1
    ||!/^[a-f0-9]{64}$/.test(operation.planDigest||'')||typeof spawnChild!=='function')
    throw launcherError('启动器替换缺少当前操作的执行协议，未修改程序。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  const fixed=operation.target?.releasePlan;
  const r=releases();
  (fixed?.client==='app'?r.validateAppPlan:r.validatePlan)(fixed,{launcherVersion:previousVersion,channel:prepared.releasePlan?.channel,
    operationDirectory:path.join(home,'installer','operations',operation.operationId)});
  if(!prepared.launcher||prepared.releasePlan?.planId!==fixed.planId
    ||crypto.createHash('sha256').update(JSON.stringify(operation.target)).digest('hex')!==operation.planDigest)
    throw new Error('启动器替换与固定发布计划不一致，未修改程序。');
  // APP replacement consumes its own sealed resources. A locally changed core
  // updater is not an execution source for this handoff.
  const capabilities=require('./launcher-capability');
  const capability=await (operation.target.request?.launcherOnly===true?capabilities.validateApp:capabilities.refresh)(
    {receiptPath:path.join(home,'installer','launcher-control.json'),noraHome:home,currentExecutable:executable});
  if(options.appHelperRuntime!==undefined){
    const pinned=capability.resources['replace-launcher.py'];
    if(fs.realpathSync(helper)!==fs.realpathSync(pinned.path)
      ||crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex')!==pinned.sha256)
      throw launcherError('APP替换助手与当前本体记录不一致，未修改程序。',{code:'OPERATION_CAPABILITY_INVALID'});
  }
  const pending=await assessPending({...options,home,executable,python,helper});
  if(pending)throw new Error(pending.reason||'尚有未完成的启动器更新，请先恢复旧启动器再重试。');
  const root=applicationRoot(executable);
  if(root===path.parse(root).root||home===root||home.startsWith(root+path.sep))throw new Error('应用与用户数据必须位于不同目录。');
  fs.accessSync(path.dirname(root),fs.constants.W_OK);
  const jobs=path.join(home,'installer','launcher-update');
  onEvent({event:'task',stage_id:'update_handoff',task:'正在校验启动器更新，完成后自动重启并继续同一个更新任务'});
  fs.mkdirSync(jobs,{recursive:true,mode:0o700});
  const identity=await callHelper(options,helper,['--process-identity',String(process.pid)],jobs,{spawnChild});
  if(identity.pid!==process.pid||!Number.isFinite(identity.creationTime)||identity.creationTime<=0)
    throw new Error('尚未确认启动器进程身份，未准备程序替换。');
  const job=fs.mkdtempSync(path.join(jobs,'job-'));
  const plan={schema:2,executorProtocol:capability.executorProtocol,operationId:operation.operationId,ownerEpoch:operation.ownerEpoch,
    planDigest:operation.planDigest,releasePlan:fixed,token:crypto.randomUUID(),parentPid:process.pid,parentCreationTime:identity.creationTime,
    home,appRoot:root,executable:path.relative(root,executable),platform:process.platform,arch:prepared.launcher.arch,
    target:prepared.tag,version:prepared.launcher.version,previousVersion,sha256:prepared.launcher.sha256,
    archive:prepared.launcher.archive,localRelease:localRelease||null,skillId:skillId||null,
    rollbackCompatibility:{operationSchema:capability.operationSchema,executorProtocol:capability.executorProtocol,
      telemetrySchema:3,faultSchema:2,compatible:true}};
  if(options.appHelperRuntime){const runtime=options.appHelperRuntime;
    plan.helperRuntime={schema:'nora-app-helper-runtime-ref/1',imageSha256:runtime.imageSha256,
      descriptorSha256:runtime.descriptorSha256,root:runtime.root,
      executable:path.relative(runtime.root,runtime.command).split(path.sep).join('/')};}
  for(const name of ['operation_control.py','operation_evidence.py','error_diagnostics.py','operation-budget.json']){
    const source=capability.resources[name];
    fs.copyFileSync(source.path,path.join(job,name));fs.chmodSync(path.join(job,name),0o600);
  }
  fs.copyFileSync(helper,path.join(job,'replace.py'));fs.chmodSync(path.join(job,'replace.py'),0o600);
  atomicJson(path.join(job,'plan.json'),plan);
  const result=await callHelper(options,path.join(job,'replace.py'),['--prepare',job],job,{spawnChild});
  if(result.prepared!==true)throw helperError(result.diagnosticError,'启动器更新准备未完成，请查看更新日志。');
  return job;
}
function independentPython(options,{detached=false}={}){
  if(options.appHelperRuntime!==undefined){
    if(!require('./app-helper-runtime').isVerified(options.appHelperRuntime)
      ||detached&&!options.appHelperRuntime.materialized)
      throw launcherError('APP助手运行闭包尚未通过本体校验，未执行程序替换。',{code:'APP_HELPER_RUNTIME_UNTRUSTED'});
    return {command:options.appHelperRuntime.command,env:{...options.appHelperRuntime.env}};
  }
  const environment={...options.env||process.env};
  for(const key of Object.keys(environment))if(key.startsWith('NORA_OPERATION_'))delete environment[key];
  delete environment.NODE_OPTIONS;delete environment.NODE_PATH;
  return require('./managed-python').resolveExecution(options.python,{managedPythonRoot:options.managedPythonRoot||path.join(options.home,'hermes','python'),
    venvHome:options.venvHome||path.join(options.home,'hermes','hermes-agent','venv'),env:environment});
}
async function launchHandoff(options){
  const job=ownedJob(options.job,options),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
  if(plan.schema!==2)throw launcherError('旧启动器替换记录不支持当前执行协议，请保留数据并覆盖安装新版启动器。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  const execution=independentPython(options,{detached:true});
  const log=fs.openSync(path.join(job,'replace.log'),'a',0o600);
  let child;
  try{child=spawn(execution.command,[...(options.appHelperRuntime?['-I','-B']:['-B']),path.join(job,'replace.py'),job],{cwd:helperCwd(job),env:execution.env,
    detached:true,windowsHide:true,stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
  child.unref();
  return workerReady(child,job,state=>{
    if(state.workerPid!==child.pid)return;
    if(state.status==='waiting-parent')return {job};
    if(['error','not-replaced','cancelled','recovery-failed','restored'].includes(state.status))
      throw helperError(state.diagnosticError,state.error||'启动器更新未完成，请保留当前程序和日志。');
  },true);
}

function resume(job,{home,executable,version,operation}){
  if(!job||path.dirname(path.resolve(job))!==path.resolve(home,'installer','launcher-update')||!/^job-[\w-]+$/.test(path.basename(job)))return null;
  ownedJob(job,{home,executable});
  const plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
  if(plan.schema!==2||plan.version!==version||!OPERATION_ID.test(plan.operationId||'')||!/^[a-f0-9]{64}$/.test(plan.planDigest||''))
    throw launcherError('旧更新记录不能安全续跑。现有数据与备份已保留，请重新安装新版启动器并检查原更新状态。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  if(operation===undefined)return plan;
  if(operation?.operationId!==plan.operationId||operation.planDigest!==plan.planDigest||operation.handoffRef!==job)
    throw launcherError('启动器交接与原操作记录不一致，未确认新版程序。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  atomicJson(path.join(job,'ready.json'),{schema:'nora-launcher-handoff/1',token:plan.token,version,operationId:plan.operationId,planDigest:plan.planDigest});
  return plan;
}
async function assessJob(options){
  const job=ownedJob(options.job,options);
  return callHelper(options,options.helper,['--assess',job],job);
}
async function verifyHandoff(options){
  try{
    const job=ownedJob(options.job,options),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
    if(plan.schema!==2||plan.operationId!==options.operation.operationId||plan.planDigest!==options.planDigest
      ||options.operation.planDigest!==plan.planDigest||options.operation.handoffRef!==job||plan.version!==options.version)return false;
    const observed=await assessJob({...options,job});
    if(observed?.status==='awaiting-system'&&observed.busy===false&&observed.workerOffline===true)return true;
    if(observed===null)return (await inspectOutcome(options))?.status==='committed';
    return false;
  }catch{return false;}
}
async function inspectOutcome(options){
  const job=ownedJob(options.job,options),operation=options.operation;
  const plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
  if(plan.schema!==2||!operation||plan.operationId!==operation.operationId
    ||plan.planDigest!==operation.planDigest||operation.handoffRef!==job)return null;
  const outcome=await callHelper(options,options.helper,['--inspect-outcome',job],job,
    {spawnChild:options.spawnChild});
  if(outcome?.status==='committed'&&!appOperation(operation))return null;
  return projectOutcome(outcome,operation,plan,job);
}
function projectOutcome(outcome,operation,plan,job,{checkTarget=false}={}){
  if(outcome?.operationId!==operation.operationId||outcome.planDigest!==operation.planDigest
    ||outcome.job!==job||outcome.verification!=='confirmed'
    ||!(outcome.status==='restored'&&outcome.effectState==='restored'
      ||outcome.status==='cancelled'&&outcome.effectState==='untouched'
      ||outcome.status==='committed'&&outcome.effectState==='changed'
        &&outcome.version===plan.version&&(!checkTarget||outcome.target===plan.target))
    ||outcome.workerOffline!==true||outcome.busy!==false)return null;
  if(outcome.status==='committed')return outcome;
  return {...outcome,failure:helperError(outcome.diagnosticError,outcome.status==='cancelled'
    ?'启动器更新未能应用，原程序和数据已保留。请查看日志后重试。':'新版启动器启动失败，旧程序已恢复。')};
}
async function waitHandoff(options){
  const deadline=Date.now()+20000;
  while(deadline-Date.now()>3000){
    const observed=await reconcile({...options,factTimeoutMs:Math.min(10000,deadline-Date.now()-3000)});
    if(observed.kind==='terminal')return observed.outcome;
    const state=observed.state;
    if(state?.status==='awaiting-system'&&state.busy===false&&state.workerOffline===true)return state;
    if(state&&!state.busy&&state.status!=='awaiting-launcher')throw helperError(state.diagnosticError,'启动器替换尚未确认完成，请保留日志和备份。');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw launcherError('启动器替换程序尚未确认结束，请重新查询状态。',{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
}

async function workerReady(child, job, select, cancelOnTimeout = false) {
  let closed = false, processError,retainListeners=false;
  const cleanup=()=>{child.off('error',onError);child.off('close',onClose);};
  const onError = error => { processError ||= error; };
  const onClose = (code, signal) => {
    closed = true;
    processError ||= launcherError('启动器更新或恢复程序已退出，请保留当前窗口并查看更新日志。',
      { source: 'launcher_process', site: 'process.run', exitCode: code, signal });
    if(retainListeners)cleanup();
  };
  child.on('error', onError); child.once('close', onClose);
  try {
    for (let i = 0; i < 1200; i++) {
      const file = path.join(job, 'status.json');
      if (fs.existsSync(file)) {
        const result = select(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (result !== undefined && (!closed || result.restored === true)) return result;
      }
      if (closed || processError) throw processError;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw launcherError('准备更新或恢复超时，当前窗口继续保留，请查看更新日志。', { code: 'TIMEOUT' });
  } catch (error) {
    // Returning a bounded UI result does not certify child closure or release
    // its native writer. The journal and actual helper remain authoritative.
    if (!closed && cancelOnTimeout) {
      try { fs.writeFileSync(path.join(job, 'cancel'), 'cancel'); }
      catch (cancelError) { error.secondaryErrors = [...error.secondaryErrors||[],{ operation: 'cancel_launcher_prepare', error: cancelError }]; }
    }
    const spawnFailed=processError&&child.pid===undefined;
    if(!closed&&!spawnFailed){
      // An unconfirmed replacement/recovery process may already be writing.
      // Only its existing cancel protocol is requested; elapsed time grants no
      // authority to force-kill a program transaction or release its writer.
      for(let i=0;i<70&&!closed;i++)await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!closed&&!spawnFailed){
      retainListeners=true;
      const pending=launcherError('APP助手尚未确认退出，请保留原任务并重新查询状态。',
        {code:'OPERATION_EXECUTOR_UNCONFIRMED'},error);
      pending.job=job;pending.pending=true;pending.executorTerminationConfirmed=false;
      pending.workerPid=child.pid;throw pending;
    }
    throw error;
  } finally {
    if(!retainListeners)cleanup();
  }
}

function ownedJob(job, { home, executable }) {
  const resolved = path.resolve(job), jobs = path.resolve(home, 'installer', 'launcher-update');
  if (path.dirname(resolved) !== jobs || !/^job-[\w-]+$/.test(path.basename(resolved)) || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('启动器恢复任务目录无效。');
  const plan = JSON.parse(fs.readFileSync(path.join(resolved, 'plan.json'), 'utf8'));
  if (![1,2].includes(plan.schema) || path.resolve(plan.home) !== path.resolve(home)
    || path.resolve(plan.appRoot) !== applicationRoot(executable)
    || path.resolve(plan.appRoot, plan.executable) !== path.resolve(executable)) throw new Error('启动器恢复任务与当前安装不匹配。');
  return resolved;
}
function nativeHelperError(record) {
  return programError(record);
}
function helperError(record, message = '启动器恢复未完成，请查看更新日志。') {
  return launcherError(message, { source: 'launcher', site: 'launcher.operation' }, nativeHelperError(record));
}
// This reader has no recovery authority. The helper validates the sealed job;
// only a bounded, reviewed projection enters the existing telemetry outbox.
async function readDiagnostics(options,operationId,{details=true}={}){
  if(!OPERATION_ID.test(operationId||''))throw new TypeError('Invalid diagnostic operation ID');
  const root=path.resolve(options.home,'installer'),directory=path.join(root,'operations',operationId);
  const read=(file,maximum)=>{
    for(let current=file;current!==path.dirname(root);current=path.dirname(current)){
      const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw Error('Linked diagnostic record');
    }
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>maximum)throw Error('Invalid diagnostic record');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{
      const before=fs.fstatSync(fd);
      if(!before.isFile()||before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size)throw Error('Changed diagnostic record');
      const buffer=Buffer.alloc(stat.size+1);let size=0,count;
      do{count=fs.readSync(fd,buffer,size,buffer.length-size,null);size+=count;}while(count&&size<buffer.length);
      const after=fs.fstatSync(fd);
      if(size!==stat.size||after.size!==stat.size||after.mtimeMs!==before.mtimeMs)throw Error('Changed diagnostic record');
      return JSON.parse(buffer.subarray(0,size).toString('utf8'));
    }finally{fs.closeSync(fd);}
  };
  let operation;
  try{
    operation=read(path.join(directory,'operation.json'),256*1024);
    if(operation.schema!=='nora-operation/1'||operation.operationId!==operationId||!['update','repair','recover'].includes(operation.kind)
      ||typeof operation.handoffRef!=='string'||!/^[a-f0-9]{64}$/.test(operation.planDigest||''))throw Error('Unbound diagnostic record');
    const job=path.resolve(operation.handoffRef);
    if(path.dirname(job)!==path.join(root,'launcher-update'))throw Error('Diagnostic job outside installation');
    const plan=read(path.join(job,'plan.json'),2*1024*1024);
    if(plan.schema!==2||plan.operationId!==operationId||plan.planDigest!==operation.planDigest)throw Error('Diagnostic plan mismatch');
    ownedJob(job,options);
    // Opt-out keeps basic technical results, without reading retained errors.
    const observed=await callHelper(options,options.helper,['--diagnostics',job,...(!details?['--no-diagnostic-details']:[])],job,{timeoutMs:5000,recordErrors:false});
    if(!observed)return null;
    if(observed.operationId!==operationId||observed.planDigest!==operation.planDigest)throw Error('Diagnostic result mismatch');
    if(observed.status==='succeeded')return operation.target?.request?.launcherOnly===true||operation.state==='succeeded'
      ?{status:'succeeded'}:null; // An APP commit alone cannot finish a legacy combined operation.
    if(!['failed','interrupted'].includes(observed.status))throw Error('Invalid diagnostic outcome');
    const phases=new Set(['prepared','waiting-parent','moving-old','installing-new','awaiting-launcher','awaiting-system',
      'recovery-prepared','moving-failed','restoring-old','recovery-failed','cancelled','restored']);
    const phase=phases.has(observed.phase)?observed.phase:'unknown',step=phases.has(observed.failurePhase)?observed.failurePhase:'unknown';
    const error=programError(observed.diagnosticError)||launcherError('更新执行进程已退出，未取得原始失败原因。',{code:'UNKNOWN_PROGRAM_ERROR'});
    const stage=['recovery-prepared','moving-failed','restoring-old','recovery-failed'].includes(step)?'rollback':'update_apply';
    const project=(value,depth=0)=>value&&depth<4?{name:value.name,message:value.message,code:value.code,
      frames:typeof value.stack==='string'?value.stack.split(/\r?\n/).slice(-12):[],cause:project(value.cause,depth+1)}:null;
    const evidence={operationId,primary:project(error),secondary:(error.secondaryErrors||[]).map(item=>({error:project(item.error)})),
      context:{stage},missingReasons:[],truncated:observed.truncated===true};
    const roles={'moving-old':'launcher-app -> launcher-backup','installing-new':'launcher-staged-app -> launcher-app',
      'moving-failed':'launcher-app -> launcher-failed-app','restoring-old':'launcher-backup -> launcher-app'};
    const effect=['untouched','restored','unknown'].includes(observed.effectState)?observed.effectState:'unknown';
    const recovery=['not-required','restored-and-verified','recovery-required'].includes(observed.recoveryOutcome)?observed.recoveryOutcome:'recovery-required';
    const verification=observed.verification==='confirmed'?'confirmed':'unconfirmed';
    evidence.reviewedOutput=[`[INFO] launcher_step=${step} launcher_status=${phase}`,
      ...(roles[step]?[`[INFO] launcher_object=${roles[step]}`]:[]),
      `[INFO] launcher_effect=${effect} recovery=${recovery} verification=${verification}`];
    evidence.missingReasons=[...new Set([...evidence.missingReasons,...(observed.missingReasons||[]),
      ...(step==='unknown'?['unknown_evidence_gap']:[])])].slice(0,16);
    return {status:observed.status,error,context:{operation:{...operation,currentVersion:operation.target?.currentVersion||operation.currentVersion,
      target:{releasePlan:plan.releasePlan,tag:plan.target},
      effectState:effect,recoveryOutcome:recovery,verification},evidence}};
  }catch(cause){
    const safeCause=cause?.source==='launcher'?cause:launcherError('交接诊断记录读取或身份核验失败。',
      {code:typeof cause?.code==='string'&&/^[A-Z_]{1,32}$/.test(cause.code)?cause.code:'UNKNOWN_PROGRAM_ERROR'});
    const error=launcherError('启动器交接诊断无法读取，实际程序修改和恢复结果尚未确认。',{code:'UNKNOWN_PROGRAM_ERROR'},safeCause);
    return {status:'interrupted',retry:true,error,context:{operation:operation?.operationId===operationId?{operationId,
      effectState:'unknown',recoveryOutcome:'recovery-required',verification:'unconfirmed'}:null,
      evidence:{operationId,primary:null,secondary:[],missingReasons:['evidence_missing','primary_detail_missing'],truncated:false}}};
  }
}
function callHelper(options,helper,args,cwd,extra={}){
  const execution=options.appHelperRuntime!==undefined?independentPython(options):{command:options.python};
  return helperCall(execution.command,helper,args,cwd,{spawnChild:options.spawnChild,onEvent:options.onEvent,...extra,
    ...(options.appHelperRuntime?{environment:execution.env,appHelperRuntime:options.appHelperRuntime}:{})});
}
function helperCall(python, helper, args, cwd, {spawnChild,timeoutMs,recordErrors=true,environment,appHelperRuntime,onEvent} = {}) {
  return new Promise((resolve, reject) => {
    const child = (spawnChild||spawn)(python, [...(appHelperRuntime?['-I','-B']:['-B']), helper, ...args], { cwd: helperCwd(cwd), windowsHide: true,
      ...(environment?{env:environment}:{}),...(appHelperRuntime?{appHelperRuntime}:{}),
      ...(spawnChild ? {} : {stdio: ['ignore', 'pipe', 'pipe']}) });
    child.stdout.setEncoding?.('utf8'); child.stderr.setEncoding?.('utf8');
    let output = '', errors = '', failed,settled=false,closed=false,stopping=false,force,unconfirmed;
    const mutating=args.some(value=>['--prepare','--prepare-recovery','--recover','--finalize'].includes(value));
    const cleanup=()=>{clearTimeout(timeout);clearTimeout(force);clearTimeout(unconfirmed);child.off('error',onError);};
    const finish=(error,value)=>{if(settled)return;settled=true;if(closed)cleanup();error?reject(error):resolve(value);};
    const signal=name=>{try{child.kill(name);}catch(error){
      failed.secondaryErrors=[...failed.secondaryErrors||[],{operation:'terminate_launcher_helper',error}];}};
    const stop=error=>{
      failed ||=error;if(stopping||closed)return;stopping=true;
      const incomplete=()=>{
        if(closed)return;
        const pending=launcherError('APP助手尚未确认退出，请保留原任务并重新查询状态。',
          {code:'OPERATION_EXECUTOR_UNCONFIRMED'},failed);
        pending.job=cwd;pending.pending=true;pending.executorTerminationConfirmed=false;
        pending.workerPid=child.pid;pending.readOnly=!mutating;
        try{onEvent?.({event:'executor-pending',task:'APP助手退出尚未确认',
          reason:'原任务仍在等待执行者关闭；已保留写入保护，请保留窗口并查看日志。',canCancel:false});}
        catch(error){pending.secondaryErrors=[...pending.secondaryErrors||[],{operation:'report_executor_pending',error}];}
        // Keep the real child's error/close observers. Neither this Promise nor
        // the timeout is an authority to clear its guard or native writer.
        finish(pending);
      };
      if(mutating){unconfirmed=setTimeout(incomplete,3000);unconfirmed?.unref?.();return;}
      signal('SIGTERM');force=setTimeout(()=>{if(closed)return;signal('SIGKILL');
        unconfirmed=setTimeout(incomplete,1000);unconfirmed?.unref?.();},2000);force?.unref?.();
    };
    const timeout=setTimeout(()=>stop(launcherError('APP助手检查或准备超时。',{code:'TIMEOUT'})),
      timeoutMs??(mutating?120000:10000));timeout?.unref?.();
    child.stdout.on('data', chunk => {
      if (failed) return;
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { output = '';stop(new Error('启动器恢复程序返回内容过大。')); }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
    const onError=error=>{
      if(child.pid===undefined){failed ||=error;clearTimeout(timeout);finish(failed);}
      else stop(error);
    };
    child.on('error',onError);
    child.once('close', code => {
      closed=true;cleanup();if(settled)return;
      if (failed) return finish(failed);
      if (code !== 0) {
        let record;
        try { record = JSON.parse(output).error; } catch {}
        const error = helperError(record, '启动器恢复检查未完成，请保留日志和备份。');
        try { if (recordErrors&&errors) fs.appendFileSync(path.join(cwd, 'replace.log'), errors, { mode: 0o600 }); }
        catch (logError) { error.secondaryErrors = [{ operation: 'save_recovery_log', error: logError }]; }
        return finish(error);
      }
      try { finish(null,JSON.parse(output)); } catch { finish(new Error('启动器恢复程序返回了无效结果。')); }
    });
    if (spawnChild)try{child.stdin.end();}catch(error){stop(error);}
  });
}
async function assessPending(options) {
  const jobs = path.join(options.home, 'installer', 'launcher-update');
  if (!fs.existsSync(jobs)) return null;
  const entries = fs.readdirSync(jobs, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^job-[\w-]+$/.test(entry.name));
  entries.sort((a, b) => fs.statSync(path.join(jobs, b.name)).birthtimeMs - fs.statSync(path.join(jobs, a.name)).birthtimeMs);
  for (const entry of entries) {
    const job = path.join(jobs, entry.name);
    let owned = false;
    try {
      ownedJob(job, options); owned = true;
      const snapshot = await callHelper(options, options.helper, ['--assess', job], job);
      // A newer successfully finished job supersedes older records for this app.
      return snapshot;
    } catch (error) {
      // Jobs for another application are not a recovery plan for this executable.
      if (error.message === '启动器恢复任务与当前安装不匹配。') continue;
      return { job, canRecover: false, reason: '启动器恢复记录暂时无法核验。请保留日志和备份。', diagnosticError: error, ...(owned ? { log: path.join(job, 'replace.log') } : {}) };
    }
  }
  return null;
}
const historicalRecoveryArgs=options=>options.historicalAppSegment===true
  ?['--historical-app-segment-sequence',String(options.operation.snapshotSequence)]:[];
async function recover(options) {
  const job = ownedJob(options.job, options);
  const state = await callHelper(options, options.helper, ['--assess', job], job);
  if (state === null) {
    const result = await callHelper(options, options.helper, ['--recover',job,...historicalRecoveryArgs(options)],job);
    if (result.restored !== true) throw new Error('此启动器任务无需恢复。');
    return { job, restarting: false, restored: true };
  }
  if (!state.canRecover) throw helperError(state.diagnosticError, state.reason || '当前启动器更新不能安全恢复，请保留更新日志。');
  options.onEvent?.({ event: 'task', task: '正在核验旧启动器备份，完成后将关闭当前窗口并恢复' });
  if(!Number.isFinite(options.parentCreationTime)||options.parentCreationTime<=0)
    throw launcherError('恢复缺少受管父进程身份，旧程序与备份已保留。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  const execution=independentPython(options,{detached:true}),log=fs.openSync(path.join(job,'replace.log'),'a',0o600);
  let child;
  // The current APP's recovery reader already validates the sealed old plan
  // and resources. Execute that same helper so fixes also reach historical
  // jobs, without replacing their original helper, snapshots or backup proof.
  try{child=spawn(execution.command,[...(options.appHelperRuntime?['-I','-B']:['-B']),options.helper,'--recover',job,'--parent-pid',String(process.pid),
    '--parent-created',String(options.parentCreationTime),...historicalRecoveryArgs(options)],{cwd:helperCwd(job),env:execution.env,
      detached:true,windowsHide:true,stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
  child.unref();
  return workerReady(child, job, state => {
    if (state.workerPid !== child.pid) return;
    if (state.status === 'recovery-prepared') return { job, restarting: true };
    if (state.status === 'restored') return { job, restarting: false, restored: true };
    if (state.status === 'error' || state.status === 'recovery-failed') throw helperError(state.diagnosticError, '恢复未完成，当前程序和备份已保留，请查看更新日志。');
  });
}
async function prepareRecovery(options){
  const job=ownedJob(options.job,options),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
  if(plan.schema!==2||plan.operationId!==options.operation?.operationId
    ||plan.planDigest!==options.operation?.planDigest||options.operation?.handoffRef!==job||typeof options.spawnChild!=='function')
    throw launcherError('原启动器恢复记录无法绑定当前操作，未修改程序。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  const state=await assessJob({...options,job});
  if(options.historicalAppSegment===true&&(state?.canRecover!==true||state.busy!==false||state.workerOffline!==true))
    throw launcherError('历史任务的APP助手尚未确认退出，已保留原任务和备份。',{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
  options.onEvent?.({event:'task',stage_id:'update_handoff',task:'核验旧启动器备份，准备恢复'});
  if(state?.untouched===true){
    const cancelled=await callHelper(options,options.helper,['--recover',job,...historicalRecoveryArgs(options)],job,{spawnChild:options.spawnChild});
    if(cancelled.untouched!==true)throw helperError(null,'原程序尚未确认未修改，已保留现场。');
    return {job,untouched:true};
  }
  const identity=await callHelper(options,options.helper,['--process-identity',String(process.pid)],job,{spawnChild:options.spawnChild});
  if(identity.pid!==process.pid||!Number.isFinite(identity.creationTime)||identity.creationTime<=0)
    throw launcherError('恢复父进程身份尚未确认，未修改程序。',{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
  const prepared=await callHelper(options,options.helper,['--prepare-recovery',job,
    '--parent-pid',String(process.pid),'--parent-created',String(identity.creationTime),...historicalRecoveryArgs(options)],job,
    {spawnChild:options.spawnChild});
  if(prepared.prepared!==true)throw helperError(prepared.diagnosticError,'旧启动器恢复准备未完成，请保留日志和备份。');
  return {job,parentCreationTime:identity.creationTime};
}
async function verifyRecovery(options){
  try{
    const job=ownedJob(options.job,options),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
    if(plan.schema!==2||plan.operationId!==options.operation.operationId||plan.planDigest!==options.operation.planDigest)return false;
    if(!options.operation.handoffRef)return Boolean(await unpublishedPrepared(options,plan,job));
    if(options.operation.handoffRef!==job)return false;
    const state=await assessJob({...options,job});
    return state?.canRecover===true&&state.busy===false&&state.workerOffline===true;
  }catch{return false;}
}
async function finalize(options) {
  const job = ownedJob(options.job, options);
  if(options.appOnly===true){
    if(!await verifyHandoff({...options,job,planDigest:options.operation?.planDigest}))
      throw new Error('启动器替换结果尚未确认，旧启动器备份继续保留。');
  }else if(options.systemReady!==true||options.updateVerified!==true)
    throw new Error('联合更新尚未通过实际验收，旧启动器备份继续保留。');
  return callHelper(options, options.helper,
    ['--finalize', job, '--target', options.target, '--version', options.version, '--verified'], job, {spawnChild:options.spawnChild});
}
const noEffect=()=>({effectState:'untouched',recoveryOutcome:'not-required',canRecover:false,canResume:false});
const appOperation=operation=>operation?.kind==='update'&&operation.target?.request?.launcherOnly===true;
const historicalAppOperation=operation=>operation?.kind==='update'&&operation.target?.request?.action==='update'&&!appOperation(operation);
const canonicalPlan=value=>Array.isArray(value)?value.map(canonicalPlan):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalPlan(value[key])])):value;
const sameSealedTarget=(operation,plan)=>Boolean(operation.target?.releasePlan
  &&JSON.stringify(canonicalPlan(plan.releasePlan))===JSON.stringify(canonicalPlan(operation.target.releasePlan))
  &&crypto.createHash('sha256').update(JSON.stringify(operation.target)).digest('hex')===operation.planDigest);
async function unpublishedPrepared(options,plan,job){
  const operation=options.operation;
  if(!appOperation(operation)||operation.handoffRef||plan.schema!==2
    ||plan.operationId!==operation.operationId||plan.planDigest!==operation.planDigest
    ||!Number.isSafeInteger(plan.ownerEpoch)||plan.ownerEpoch<1||plan.ownerEpoch>operation.ownerEpoch
    ||!sameSealedTarget(operation,plan))return null;
  const state=await callHelper(options,options.helper,['--inspect-prepared',job],job,
    {recordErrors:false,timeoutMs:options.factTimeoutMs});
  return state?.job===job&&state.operationId===operation.operationId&&state.planDigest===operation.planDigest
    &&state.status==='prepared'&&state.verification==='confirmed'&&state.effectState==='untouched'
    &&state.canRecover===true&&state.busy===false&&state.workerOffline===true?state:null;
}
async function readUnpublished(options){
  const {operation}=options;
  if(!appOperation(operation)||operation.stageId!=='prepared'||!operation.target.releasePlan
    ||!OPERATION_ID.test(operation.operationId||''))return null;
  const installer=path.resolve(options.home,'installer'),jobs=path.join(installer,'launcher-update');
  const unknown=job=>({kind:'unknown',job,effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false,
    reason:'APP准备记录尚未和原任务交接，请保留日志和备份。'});
  let entries;
  try{
    if(fs.lstatSync(installer).isSymbolicLink()||fs.lstatSync(jobs).isSymbolicLink())return unknown(null);
    entries=fs.readdirSync(jobs,{withFileTypes:true});
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
  const matches=[];
  for(const entry of entries){
    if(!entry.isDirectory()||!/^job-[\w-]+$/.test(entry.name))continue;
    const job=path.join(jobs,entry.name);
    let plan;
    try{
      const file=path.join(job,'plan.json'),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.size>2*1024*1024)continue;
      plan=JSON.parse(fs.readFileSync(file,'utf8'));
    }catch{continue;}
    if(plan?.operationId===operation.operationId)matches.push({job,plan});
  }
  if(!matches.length)return null;
  if(matches.length!==1)return unknown(null);
  const {job,plan}=matches[0];
  try{
    ownedJob(job,options);
    const state=await unpublishedPrepared(options,plan,job);
    return state?{kind:'pending',job,state,unpublished:true}:unknown(job);
  }catch(diagnosticError){return {...unknown(job),diagnosticError};}
}
async function read(options){
  const operation=options.operation,job=options.job||operation?.handoffRef;
  if(!job){
    if(operation){
      const unpublished=await readUnpublished(options);
      if(unpublished)return unpublished;
      return {kind:operation.effectState==='untouched'||!operation.effectState?'idle':'unknown',
        ...(!operation.effectState||operation.effectState==='untouched'?noEffect():{effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false})};
    }
    const state=await assessPending(options);
    return state?{kind:'pending',job:state.job,state}:{kind:'idle',...noEffect()};
  }
  ownedJob(job,options);
  const plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
  const historical=historicalAppOperation(operation);
  if(operation&&(plan.schema!==2||plan.operationId!==operation.operationId||plan.planDigest!==operation.planDigest
    ||operation.handoffRef!==job||historical&&(plan.releasePlan?.client==='app'
      ||!Number.isSafeInteger(operation.ownerEpoch)||operation.ownerEpoch<plan.ownerEpoch||!sameSealedTarget(operation,plan))))
    return {kind:'unknown',job,effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false,
      reason:'APP记录不属于本次原任务。'};
  options.context?.check();
  const result=await callHelper(options,options.helper,['--read-outcome',job],job,{timeoutMs:options.factTimeoutMs});
  options.context?.check();
  if(!result||result.job!==job||!['idle','pending','terminal','unknown'].includes(result.kind))
    throw launcherError('APP助手没有返回有效的程序事实。',{code:'VERIFICATION_FAILED'});
  if(result.kind==='terminal'){
    const outcome=operation?projectOutcome(result.outcome,operation,plan,job,{checkTarget:true}):result.outcome;
    if(outcome)return {kind:'terminal',job,outcome};
    return {kind:'unknown',job,effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false,
      reason:'APP终态文件或原任务绑定尚未确认。'};
  }
  if(result.kind==='idle')return operation?{kind:'unknown',job,effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false,
    reason:'原APP任务缺少可核验的程序效果记录。'}:{kind:'idle',...noEffect()};
  return {...result,...(result.kind==='unknown'?{effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false}:{})};
}
async function reconcile(options){
  // Ordinary startup, SELF startup and explicit recheck consume the same fact
  // reader. A terminal program never has to re-enter awaiting-system.
  return read(options);
}
async function observeApp(options){
  try{
    const result=await read(options);
    if(result.kind==='idle')return noEffect();
    if(result.kind==='terminal'){
      const outcome=result.outcome;
      const appSegmentSettled=outcome.status==='committed'&&historicalAppOperation(options.operation);
      return {status:outcome.status,effectState:outcome.effectState,
        ...(appSegmentSettled?{appSegmentSettled:true}:{}),
        recoveryOutcome:outcome.status==='restored'?'restored-and-verified':'not-required',
        canRecover:false,canResume:outcome.status==='committed'&&!appSegmentSettled,workerOffline:true,busy:false,
        operationId:outcome.operationId,planDigest:outcome.planDigest,job:outcome.job,reason:outcome.status};
    }
    if(result.kind==='unknown')return {effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false,canResume:false,reason:result.reason};
    const state=result.state;
    return {status:state.status,effectState:state.effectState||'unknown',
      recoveryOutcome:!result.unpublished&&state.effectState==='untouched'?'not-required':'recovery-required',
      canRecover:state.canRecover===true,canResume:state.status==='awaiting-system'&&state.busy===false&&state.workerOffline===true,
      workerOffline:state.workerOffline===true,busy:state.busy===true,reason:state.reason};
  }catch(error){return {effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false,canResume:false,reason:error.code||error.message};}
}
async function reconcileAppHandoff(options){
  const operation=options.operation;
  // APP evidence may describe the APP segment of an old combined task, but it
  // cannot certify that entire task or grant its core recovery authority.
  if(!appOperation(operation)||!operation.handoffRef)return null;
  const observed=await reconcile(options);
  if(observed.kind!=='terminal')return null;
  const outcome=observed.outcome;
  if(outcome.status==='committed')return {...outcome,value:{launcherVersion:outcome.version,
    appUpdateComplete:true,updateComplete:true,updateVerified:true,coreUpdateComplete:false}};
  if(outcome.status==='cancelled')return {...outcome,value:{notAppliedVerification:'confirmed'}};
  return {...outcome,value:{recoveryVerification:'confirmed'}};
}
async function start(options){
  const {context,launcherVersion:version}=options;
  if(!context||!appOperation(context.snapshot))throw launcherError('APP更新缺少原任务授权。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  if(options.localTest)throw launcherError('本地候选包不用于在线自更新，请使用正式模式包。',{code:'RELEASE_COMPATIBILITY'});
  context.check();
  options.signal?.throwIfAborted();
  const value={launcherVersion:version,appUpdateComplete:true,updateComplete:true,coreUpdateComplete:false};
  const operation=context.snapshot;
  if(operation.handoffRef){
    const job=ownedJob(operation.handoffRef,options);
    const observed=await reconcile({...options,operation,job});
    if(observed.kind==='terminal'){
      if(observed.outcome.status!=='committed'||observed.outcome.version!==version)
        throw observed.outcome.failure||launcherError('APP替换未完成，原程序已保留或恢复。',{code:'LAUNCHER_START_FAILED'});
      await context.stage('verifying');
    }else{
      if(observed.kind!=='pending'||observed.state?.status!=='awaiting-system'
        ||observed.state.busy!==false||observed.state.workerOffline!==true)
        throw launcherError('APP替换事实尚未确认，请检查原任务。',{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
      const plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
      await context.stage('verifying');
      await finalize({...options,job,operation:context.snapshot,appOnly:true,version,target:plan.target});
    }
    await context.effect('changed');
    return {verification:'confirmed',value:{...value,updateVerified:true}};
  }
  const r=releases(),validation={...options,launcherVersion:version,operationDirectory:options.operationDirectory};
  const validate=plan=>(plan.client==='app'?r.validateAppPlan:r.validatePlan)(plan,validation);
  let plan=context.target.releasePlan?validate(context.target.releasePlan)
    :await r.selectAppPlan({...validation,tag:options.payloadTag});
  if(plan.mode!=='update')throw launcherError('APP自更新不能使用核心安装计划。',{code:'RELEASE_COMPATIBILITY'});
  if(!context.target.releasePlan){
    const sealed=r.sealPlan(plan,{...validation,assertOwner:()=>context.check()});
    await context.plan({...context.target,releasePlan:sealed});
    plan=validate(sealed);
  }
  await context.stage('downloading');
  const prepared=await prepare({...validation,selectedPlan:plan,tag:plan.tag,
    cacheRoot:options.cacheRoot||path.join(options.home,'cache/releases')});
  context.check();
  options.signal?.throwIfAborted();
  if(!prepared.launcher)return {verification:'confirmed',value:{...value,unchanged:true}};
  if(options.isPackaged!==true||!require('./app-helper-runtime').isVerified(options.appHelperRuntime))
    throw launcherError('APP自身的辅助执行资源尚未就绪，未替换程序。',{code:'APP_HELPER_RUNTIME_UNAVAILABLE'});
  await context.stage('prepared');
  const job=await prepareHandoff({...options,prepared,operation:context.snapshot,previousVersion:version,
    python:options.appHelperRuntime.command});
  context.check();
  await context.handoff(job);
  return {handoff:true,value:{restarting:true,job}};
}
async function restore(options){
  const operation=options.context?.snapshot||options.operation;
  const historical=options.historicalAppSegment===true;
  if(!(historical?historicalAppOperation(operation):appOperation(operation))
    ||!require('./app-helper-runtime').isVerified(options.appHelperRuntime))
    throw launcherError('APP恢复缺少原任务授权或自身助手运行资源。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  const job=ownedJob(options.job||operation.handoffRef,options),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
  if(plan.schema!==2||plan.operationId!==operation.operationId||plan.planDigest!==operation.planDigest)
    throw launcherError('APP恢复记录不属于本次原任务，未修改程序。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  if(historical){
    if(operation.handoffRef!==job||!Number.isSafeInteger(operation.snapshotSequence)||operation.snapshotSequence<1
      ||!Number.isSafeInteger(operation.ownerEpoch)||operation.ownerEpoch<plan.ownerEpoch
      ||plan.releasePlan?.client==='app'||!sameSealedTarget(operation,plan))
      throw launcherError('历史任务的APP交接记录无法绑定，已保留原程序与证据。',{code:'OPERATION_CAPABILITY_REQUIRED'});
    const bound={...options,operation,job};
    options.context?.check();
    const result=await (options.context?prepareRecovery(bound):recover(bound));
    options.context?.check();
    return {...result,appSegmentOnly:true,...(result.untouched?{restarting:false}:{})};
  }
  if(operation.handoffRef!==job){
    if(!options.context||!await unpublishedPrepared({...options,operation},plan,job))
      throw launcherError('未交接的APP准备记录尚未确认原程序未改，未接管任务。',{code:'OPERATION_CAPABILITY_REQUIRED'});
    // Publish only the exact original APP job while its controller writer is
    // held. A crash before or after cancellation can then use the existing
    // handoff reader; no second task or altered historical plan is needed.
    options.context.check();await options.context.handoff(job);
  }
  options.context?.check();
  if(options.context){
    const prepared=await prepareRecovery({...options,operation:options.context.snapshot,job});options.context.check();
    if(prepared.untouched)return {effectState:'untouched',verification:'confirmed',value:{untouched:true,restarting:false}};
    await options.context.handoff(job);return {handoff:true,value:prepared};
  }
  return recover({...options,operation,job});
}
module.exports = { read,start,reconcile,restore,observeApp,reconcileAppHandoff,
  inspect, prepare, prepareHandoff, launchHandoff, resume, waitHandoff,verifyHandoff,verifyRecovery,readDiagnostics,
  prepareRecovery,assessJob,inspectOutcome, applicationRoot, assessPending, recover, finalize,validateManifest };
