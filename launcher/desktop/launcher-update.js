const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { launcherError,programError } = require('./launcher-errors');
const {downloadAsset} = require('./release-network');
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
  const r = releases();
  options.onEvent?.({ event: 'task', stage_id: 'release_check', task: '检查最新版本与更新清单' });
  const selectedPlan = options.selectedPlan ? r.validatePlan(options.selectedPlan,options) : await r.selectPlan(options);
  const release = selectedPlan.release, manifest = selectedPlan.releaseManifest;
  const item = await inspect({ ...options, release, manifest,launcherManifest:selectedPlan.launcherManifest });
  r.validateUpdate(manifest, release, item?.version || options.launcherVersion);
  if (!item) return { tag: release.tag_name, manifest, launcher: null,releasePlan:selectedPlan };
  const root = path.join(options.cacheRoot, 'launcher-' + item.sha256.slice(0, 16));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const archive = path.join(root, item.asset);
  await downloadAsset({url:r.assetUrl(release,item.asset),target:archive,identity:{tag:release.tag_name,asset:item.asset,sha256:item.sha256,size:item.size},
    fetcher:options.fetcher,signal:options.signal,policy:options.networkPolicy,task:'正在下载启动器更新',
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
async function prepareHandoff({prepared,home,executable,python,helper,previousVersion,localRelease,skillId,
  operation,spawnChild,onEvent=()=>{}}){
  if(process.env.PORTABLE_EXECUTABLE_FILE)throw new Error('Windows 便携版不能原位替换临时运行目录。请使用安装版覆盖升级；现有数据不会被删除。');
  if(!OPERATION_ID.test(operation?.operationId||'')||!Number.isSafeInteger(operation.ownerEpoch)||operation.ownerEpoch<1
    ||!/^[a-f0-9]{64}$/.test(operation.planDigest||'')||typeof spawnChild!=='function')
    throw launcherError('启动器替换缺少当前操作的执行协议，未修改程序。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  const fixed=operation.target?.releasePlan;
  releases().validatePlan(fixed,{launcherVersion:previousVersion,
    operationDirectory:path.join(home,'installer','operations',operation.operationId)});
  if(!prepared.launcher||prepared.releasePlan?.planId!==fixed.planId
    ||crypto.createHash('sha256').update(JSON.stringify(operation.target)).digest('hex')!==operation.planDigest)
    throw new Error('启动器替换与固定发布计划不一致，未修改程序。');
  const capability=await require('./launcher-capability').validate({receiptPath:path.join(home,'installer','launcher-control.json'),
    noraHome:home,currentExecutable:executable});
  const pending=await assessPending({home,executable,python,helper});
  if(pending)throw new Error(pending.reason||'尚有未完成的启动器更新，请先恢复旧启动器再重试。');
  const root=applicationRoot(executable);
  if(root===path.parse(root).root||home===root||home.startsWith(root+path.sep))throw new Error('应用与用户数据必须位于不同目录。');
  fs.accessSync(path.dirname(root),fs.constants.W_OK);
  const jobs=path.join(home,'installer','launcher-update');
  onEvent({event:'task',stage_id:'update_handoff',task:'正在校验启动器更新，完成后自动重启并继续同一个更新任务'});
  fs.mkdirSync(jobs,{recursive:true,mode:0o700});
  const identity=await helperCall(python,helper,['--process-identity',String(process.pid)],jobs,{spawnChild});
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
  for(const name of ['operation_control.py','operation_evidence.py','error_diagnostics.py','operation-budget.json']){
    const source=capability.resources[name];
    fs.copyFileSync(source.path,path.join(job,name));fs.chmodSync(path.join(job,name),0o600);
  }
  fs.copyFileSync(helper,path.join(job,'replace.py'));fs.chmodSync(path.join(job,'replace.py'),0o600);
  atomicJson(path.join(job,'plan.json'),plan);
  const result=await helperCall(python,path.join(job,'replace.py'),['--prepare',job],job,{spawnChild});
  if(result.prepared!==true)throw helperError(result.diagnosticError,'启动器更新准备未完成，请查看更新日志。');
  return job;
}
function independentPython(options){
  const environment={...options.env||process.env};
  for(const key of Object.keys(environment))if(key.startsWith('NORA_OPERATION_'))delete environment[key];
  delete environment.NODE_OPTIONS;delete environment.NODE_PATH;
  return require('./managed-python').resolveExecution(options.python,{managedPythonRoot:options.managedPythonRoot||path.join(options.home,'hermes','python'),
    venvHome:options.venvHome||path.join(options.home,'hermes','hermes-agent','venv'),env:environment});
}
async function launchHandoff(options){
  const job=ownedJob(options.job,options),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
  if(plan.schema!==2)throw launcherError('旧启动器替换记录不支持当前执行协议，请保留数据并覆盖安装新版启动器。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  const execution=independentPython(options);
  const log=fs.openSync(path.join(job,'replace.log'),'a',0o600);
  let child;
  try{child=spawn(execution.command,['-B',path.join(job,'replace.py'),job],{cwd:helperCwd(job),env:execution.env,
    detached:true,windowsHide:true,stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
  child.unref();
  return workerReady(child,job,state=>{
    if(state.workerPid!==child.pid)return;
    if(state.status==='waiting-parent')return {job};
    if(['error','not-replaced','cancelled','recovery-failed','restored'].includes(state.status))
      throw helperError(state.diagnosticError,state.error||'启动器更新未完成，请保留当前程序和日志。');
  },true);
}

function resume(job,{home,executable,version}){
  if(!job||path.dirname(path.resolve(job))!==path.resolve(home,'installer','launcher-update')||!/^job-[\w-]+$/.test(path.basename(job)))return null;
  ownedJob(job,{home,executable});
  const plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
  if(plan.schema!==2||plan.version!==version||!OPERATION_ID.test(plan.operationId||'')||!/^[a-f0-9]{64}$/.test(plan.planDigest||''))
    throw launcherError('旧更新记录不能安全续跑。现有数据与备份已保留，请重新安装新版启动器并检查原更新状态。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  atomicJson(path.join(job,'ready.json'),{schema:'nora-launcher-handoff/1',token:plan.token,version,operationId:plan.operationId,planDigest:plan.planDigest});
  return plan;
}
async function assessJob(options){
  const job=ownedJob(options.job,options);
  return helperCall(options.python,options.helper,['--assess',job],job);
}
async function verifyHandoff(options){
  try{
    const job=ownedJob(options.job,options),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
    if(plan.schema!==2||plan.operationId!==options.operation.operationId||plan.planDigest!==options.planDigest
      ||options.operation.planDigest!==plan.planDigest||options.operation.handoffRef!==job||plan.version!==options.version)return false;
    const observed=await assessJob({...options,job});
    return observed?.status==='awaiting-system'&&observed.busy===false&&observed.workerOffline===true;
  }catch{return false;}
}
async function waitHandoff(options){
  for(let count=0;count<200;count++){
    const state=await assessJob(options);
    if(state?.status==='awaiting-system'&&state.busy===false&&state.workerOffline===true)return state;
    if(state&&!state.busy&&state.status!=='awaiting-launcher')throw helperError(state.diagnosticError,'启动器替换尚未确认完成，请保留日志和备份。');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw launcherError('启动器替换程序尚未确认结束，请重新查询状态。',{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
}

async function workerReady(child, job, select, cancelOnTimeout = false) {
  let closed = false, processError;
  const onError = error => { processError ||= error; closed = true; };
  const onClose = (code, signal) => {
    closed = true;
    processError ||= launcherError('启动器更新或恢复程序已退出，请保留当前窗口并查看更新日志。',
      { source: 'launcher_process', site: 'process.run', exitCode: code, signal });
  };
  child.once('error', onError); child.once('close', onClose);
  try {
    for (let i = 0; i < 1200; i++) {
      const file = path.join(job, 'status.json');
      if (fs.existsSync(file)) {
        const result = select(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (result !== undefined && (!closed || result.restored === true)) return result;
      }
      if (closed) throw processError;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw launcherError('准备更新或恢复超时，当前窗口继续保留，请查看更新日志。', { code: 'TIMEOUT' });
  } catch (error) {
    // Do not release the owner while a worker can still prepare or change files.
    if (!closed && cancelOnTimeout) {
      try { fs.writeFileSync(path.join(job, 'cancel'), 'cancel'); }
      catch (cancelError) { error.secondaryErrors = [{ operation: 'cancel_launcher_prepare', error: cancelError }]; }
    }
    while (!closed) await new Promise(resolve => setTimeout(resolve, 100));
    throw error;
  } finally {
    child.off('error', onError); child.off('close', onClose);
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
function helperCall(python, helper, args, cwd, {spawnChild} = {}) {
  return new Promise((resolve, reject) => {
    const child = (spawnChild||spawn)(python, ['-B', helper, ...args], { cwd: helperCwd(cwd), windowsHide: true,
      ...(spawnChild ? {} : {stdio: ['ignore', 'pipe', 'pipe']}) });
    child.stdout.setEncoding?.('utf8'); child.stderr.setEncoding?.('utf8');
    let output = '', errors = '', failed;
    child.stdout.on('data', chunk => {
      if (failed) return;
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { failed = new Error('启动器恢复程序返回内容过大。'); output = ''; }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
    child.once('error', reject);
    child.once('close', code => {
      if (failed) return reject(failed);
      if (code !== 0) {
        let record;
        try { record = JSON.parse(output).error; } catch {}
        const error = helperError(record, '启动器恢复检查未完成，请保留日志和备份。');
        try { if (errors) fs.appendFileSync(path.join(cwd, 'replace.log'), errors, { mode: 0o600 }); }
        catch (logError) { error.secondaryErrors = [{ operation: 'save_recovery_log', error: logError }]; }
        return reject(error);
      }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('启动器恢复程序返回了无效结果。')); }
    });
    if (spawnChild) child.stdin.end();
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
      const snapshot = await helperCall(options.python, options.helper, ['--assess', job], job);
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
async function recover(options) {
  const job = ownedJob(options.job, options);
  const state = await helperCall(options.python, options.helper, ['--assess', job], job);
  if (state === null) {
    const result = await helperCall(options.python, options.helper, ['--recover', job], job);
    if (result.restored !== true) throw new Error('此启动器任务无需恢复。');
    return { job, restarting: false, restored: true };
  }
  if (!state.canRecover) throw helperError(state.diagnosticError, state.reason || '当前启动器更新不能安全恢复，请保留更新日志。');
  options.onEvent?.({ event: 'task', task: '正在核验旧启动器备份，完成后将关闭当前窗口并恢复' });
  if(!Number.isFinite(options.parentCreationTime)||options.parentCreationTime<=0)
    throw launcherError('恢复缺少受管父进程身份，旧程序与备份已保留。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  const execution=independentPython(options),log=fs.openSync(path.join(job,'replace.log'),'a',0o600);
  let child;
  try{child=spawn(execution.command,['-B',path.join(job,'replace.py'),'--recover',job,'--parent-pid',String(process.pid),
    '--parent-created',String(options.parentCreationTime)],{cwd:helperCwd(job),env:execution.env,
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
  options.onEvent?.({event:'task',stage_id:'update_handoff',task:'核验旧启动器备份，准备恢复'});
  if(state?.untouched===true){
    const cancelled=await helperCall(options.python,path.join(job,'replace.py'),['--recover',job],job,{spawnChild:options.spawnChild});
    if(cancelled.untouched!==true)throw helperError(null,'原程序尚未确认未修改，已保留现场。');
    return {job,untouched:true};
  }
  const identity=await helperCall(options.python,path.join(job,'replace.py'),['--process-identity',String(process.pid)],job,{spawnChild:options.spawnChild});
  if(identity.pid!==process.pid||!Number.isFinite(identity.creationTime)||identity.creationTime<=0)
    throw launcherError('恢复父进程身份尚未确认，未修改程序。',{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
  const prepared=await helperCall(options.python,path.join(job,'replace.py'),['--prepare-recovery',job,
    '--parent-pid',String(process.pid),'--parent-created',String(identity.creationTime)],job,{spawnChild:options.spawnChild});
  if(prepared.prepared!==true)throw helperError(prepared.diagnosticError,'旧启动器恢复准备未完成，请保留日志和备份。');
  return {job,parentCreationTime:identity.creationTime};
}
async function verifyRecovery(options){
  try{
    const job=ownedJob(options.job,options),plan=JSON.parse(fs.readFileSync(path.join(job,'plan.json'),'utf8'));
    if(plan.schema!==2||plan.operationId!==options.operation.operationId||plan.planDigest!==options.operation.planDigest
      ||options.operation.handoffRef!==job)return false;
    const state=await assessJob({...options,job});
    return state?.canRecover===true&&state.busy===false&&state.workerOffline===true;
  }catch{return false;}
}
async function finalize(options) {
  const job = ownedJob(options.job, options);
  if (options.systemReady !== true || options.updateVerified !== true) throw new Error('联合更新尚未通过实际验收，旧启动器备份继续保留。');
  return helperCall(options.python, options.helper,
    ['--finalize', job, '--target', options.target, '--version', options.version, '--verified'], job, {spawnChild:options.spawnChild});
}
module.exports = { inspect, prepare, prepareHandoff, launchHandoff, resume, waitHandoff,verifyHandoff,verifyRecovery,
  prepareRecovery,assessJob, applicationRoot, assessPending, recover, finalize,validateManifest };
