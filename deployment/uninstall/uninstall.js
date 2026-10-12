// Treat .asar as an ordinary file when removing an application bundle.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const osLock=require('./os-lock');

const OWNER = 'nora-owner.json';
const RETAINED = 'nora-retained.json';
const PROGRAMS = ['hermes-agent', 'python', 'node', 'bin', '.local/bin', 'plugins/clawchat',
  'clawchat/liveware', 'nora-components.json', 'nora-clawchat-check.py', 'nora-installation.json',
  'nora-instance.json', 'gateway.pid', 'gateway.lock', 'gateway_state.json'];

function canonical(file) {
  const full = path.resolve(file);
  if (fs.existsSync(full)) return fs.realpathSync(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(canonical(parent), path.basename(full));
}

function safeRoot(home) {
  if (fs.existsSync(home) && fs.lstatSync(home).isSymbolicLink()) throw new Error('隔离目录不能是符号链接。');
  const root = canonical(home), userHome = canonical(os.homedir());
  if (root === path.parse(root).root || root === userHome
    || userHome.startsWith(root + path.sep)) throw new Error('不能卸载用户目录或磁盘根目录。');
  return root;
}

function contained(root, relative) {
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('卸载路径越过隔离目录。');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`卸载路径被链接重定向：${relative}`);
    }
  }
  return target;
}

function own(home) {
  const root = safeRoot(home);
  const file = contained(root, OWNER);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ schema: 1, id: crypto.randomUUID() }), { mode: 0o600, flag: 'wx' });
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schema !== 1 || typeof value.id !== 'string') throw new Error('安装目录归属记录无效。');
  return value.id;
}

function makePlan({ home, hermesHome, installRoot, mode, executable = process.execPath, appPath = null, port = 8799, serviceMode = 'port' }) {
  if (!['keep', 'all'].includes(mode)) throw new Error('卸载方式无效。');
  if(!['port','native-root'].includes(serviceMode)||serviceMode==='native-root'&&(mode!=='all'||port!==null))
    throw Object.assign(new Error('卸载现场检查方式无效，未删除文件。'),{code:'UNINSTALL_SERVICES_UNCONFIRMED'});
  const root = safeRoot(home);
  if (path.resolve(executable).startsWith(root + path.sep)) throw new Error('启动器位于数据目录内，请将启动器移到独立应用目录后重试。');
  const hermes = path.relative(root, canonical(hermesHome));
  const tavern = path.relative(root, canonical(installRoot));
  contained(root, hermes); contained(root, tavern);
  if (hermes === tavern || hermes.startsWith(tavern + path.sep) || tavern.startsWith(hermes + path.sep)) throw new Error('程序目录不能互相包含。');
  const plan={ schema: 1, root, owner: own(root), hermes, tavern, mode, executable, appPath, port, serviceMode, parentIdentity:processIdentity(process.pid) };
  plan.serviceCheck=require('./uninstall-offline-check').capture({root,hermesHome:contained(root,hermes),installRoot:contained(root,tavern),port,mode:serviceMode,executable,
    entry:__dirname.endsWith('.asar')?__dirname:__filename,resourcesRoot:path.dirname(__dirname)});
  return plan;
}

function validate(plan) {
  if (plan.schema !== 1 || !['keep', 'all'].includes(plan.mode)) throw new Error('卸载计划无效。');
  if(plan.serviceMode==='native-root'&&(plan.mode!=='all'||plan.port!==null))throw Object.assign(new Error('卸载现场检查方式无效，未删除文件。'),{code:'UNINSTALL_SERVICES_UNCONFIRMED'});
  const root = safeRoot(plan.root);
  const owner = JSON.parse(fs.readFileSync(contained(root, OWNER), 'utf8'));
  if (owner.id !== plan.owner) throw new Error('安装目录已变化，已停止卸载。');
  contained(root, plan.hermes); contained(root, plan.tavern);
  return root;
}

function processIdentity(pid) {
  if(!Number.isSafeInteger(pid)||pid<1)throw Object.assign(new Error('启动器进程身份无效。'),{code:'UNINSTALL_PARENT_UNCONFIRMED'});
  let result,creationTime,precisionSeconds;
  const unconfirmed=cause=>Object.assign(new Error('无法核验启动器进程身份，未删除文件。',cause?{cause}:undefined),
    {code:'UNINSTALL_PARENT_UNCONFIRMED',
      ...(result?.status===null||Number.isSafeInteger(result?.status)?{exitCode:result.status}:{}),
      ...(result?.signal===null||typeof result?.signal==='string'?{signal:result.signal}:{})});
  try{
    if(process.platform==='darwin'){
      result=spawnSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:10000});
    }else if(process.platform==='win32'){
      result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -eq $p){'absent'}else{([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()}`],
        {encoding:'utf8',windowsHide:true,timeout:10000});
    }
  }catch(error){throw unconfirmed(error);}
  if(result?.error)throw unconfirmed(result.error);
  if(!result||result.signal||typeof result.stdout!=='string'||typeof result.stderr!=='string'||result.stderr.trim())throw unconfirmed();
  const output=result.stdout.trim();
  if(process.platform==='darwin'){
    if(result.status===1&&!output)return null;
    creationTime=Date.parse(output)/1000;precisionSeconds=1;
  }else if(process.platform==='win32'){
    if(result.status===0&&output==='absent')return null;
    creationTime=/^\d+$/.test(output)?Number(output)/1000:NaN;precisionSeconds=0.001;
  }
  if(result.status!==0||!Number.isFinite(creationTime)||creationTime<=0)throw unconfirmed();
  return {pid,creationTime,precisionSeconds};
}

const OPERATION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recoveryRequired=cause=>Object.assign(new Error('上次文件事务尚未确认结束，请先恢复并保留日志与备份，再卸载程序。',cause?{cause}:undefined),{code:'UNINSTALL_RECOVERY_REQUIRED'});
function localDiagnostic(error,depth=0){return {name:String(error.name||'Error').slice(0,100),code:String(error.code||'').slice(0,100),
  message:String(error.message||'').slice(0,2000),stack:String(error.stack||'').slice(0,8192),
  ...(typeof error.syscall==='string'?{syscall:error.syscall.slice(0,200)}:{}),
  ...(Number.isFinite(error.errno)?{errno:error.errno}:typeof error.errno==='string'?{errno:error.errno.slice(0,100)}:{}),
  ...(error.exitCode===null||Number.isSafeInteger(error.exitCode)?{exitCode:error.exitCode}:{}),
  ...(error.signal===null||typeof error.signal==='string'&&/^SIG[A-Z0-9]+$/.test(error.signal)?{signal:error.signal}:{}),
  ...(error.cause&&depth<3?{cause:localDiagnostic(error.cause,depth+1)}:{})};}
function present(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function readJournal(file,limit=4*1024*1024){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw recoveryRequired();
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw recoveryRequired();
  return value;
}
function transactionCatalog(root,plan){
  const directory=contained(root,'installer/operations'),operations=[];
  for(const name of fs.readdirSync(directory)){
    if(!OPERATION_ID.test(name)){
      const other=contained(root,path.join('installer/operations',name));
      if(fs.lstatSync(other).isDirectory()&&(present(path.join(other,'runtime-bootstrap.json'))
        ||present(path.join(other,'first-install/transaction.json'))))throw recoveryRequired();
      continue;
    }
    const base=contained(root,path.join('installer/operations',name));
    if(!fs.lstatSync(base).isDirectory())throw recoveryRequired();
    const file=contained(root,path.join('installer/operations',name,'operation.json'));
    const record=present(file)?readJournal(file,256*1024):null;
    if(record&&(record.schema!=='nora-operation/1'||record.operationId!==name))throw recoveryRequired();
    const runtimeFile=contained(root,path.join('installer/operations',name,'runtime-bootstrap.json'));
    const firstFile=contained(root,path.join('installer/operations',name,'first-install/transaction.json'));
    const runtime=present(runtimeFile)?readJournal(runtimeFile):null;
    const first=present(firstFile)?readJournal(firstFile,2*1024*1024):null;
    if(first&&(first.schema!==1||first.owner!=='nora-first-install'||first.operationId!==name
      ||canonical(first.noraHome||'')!==root||canonical(first.roots?.hermes||'')!==contained(root,plan.hermes)
      ||canonical(first.roots?.tavern||'')!==contained(root,plan.tavern)))throw recoveryRequired();
    operations.push({id:name,record,runtime,runtimeFile,first,firstFile});
  }
  const systemFile=contained(root,path.join(plan.tavern,'tavern-updates/transaction.json'));
  const system=present(systemFile)?readJournal(systemFile,64*1024*1024):null;
  // A corrupt authoritative journal is never hidden by a missing Operation.
  if(system&&(system.schema!==1||!system.recoveryPlan||typeof system.recoveryPlan!=='object'))throw recoveryRequired();
  const legacyFile=contained(root,'installer/system-update/journal.json');
  let legacy=null;
  if(present(legacyFile)){
    const state=readJournal(legacyFile);legacy=state;
    const facts=require('./system-update').inspect(root);
    if(facts||!['committed','rolled-back'].includes(state.phase))throw recoveryRequired();
    // The old adapter intentionally has no current-file assessment for a
    // committed journal. A later authenticated system transaction must prove
    // it was superseded; the saved word "committed" cannot grant deletion.
    if(state.phase==='committed'&&(!system||typeof state.target!=='string'||!/^v?\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(state.target)))throw recoveryRequired();
  }
  const appDirectory=contained(root,'installer/launcher-update');
  const appJobs=present(appDirectory)?fs.readdirSync(appDirectory).filter(name=>/^job-[\w-]+$/.test(name))
    .map(name=>contained(root,path.join('installer/launcher-update',name))):[];
  return {operations,system,systemFile,appJobs,legacy};
}
function runtimeEffects(root,plan,catalog){
  const inspect=require('./runtime-transaction').inspect;
  const facts=new Map(catalog.operations.filter(item=>item.runtime).map(item=>[item.id,
    inspect({noraHome:root,hermesHome:contained(root,plan.hermes),operationId:item.id})]));
  // A later committed swap must actually seal the current tree and link its
  // previous identity to the older tree. Success labels alone are insufficient.
  const closureHistory=require('./operation-history').inspect(root);
  const superseded=new Set(closureHistory.closed.keys());
  const committedAncestors=new Set();
  const historical=[];
  const partialRuntimes=[];
  const epoch=value=>Number.isSafeInteger(value)&&value>0;
  const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
  const ordered=values=>values.every(value=>value!==null)&&values.every((value,index)=>index===0||values[index-1]<=value);
  const bound=item=>item.record?.schema==='nora-operation/1'&&item.record.operationId===item.id
    &&(item.record.kind==='install'||['update','repair'].includes(item.record.kind)
      &&item.record.target?.request?.action===item.record.kind&&item.record.target?.releasePlan?.mode==='install'
      &&item.runtime?.originalPartial?.schema==='nora-managed-partial-installation/1'&&item.runtime.identities?.previous)
    &&item.runtime?.schema==='nora-runtime-bootstrap/1'&&item.runtime.operationId===item.id
    &&epoch(item.record.ownerEpoch)&&item.runtime.ownerEpoch===item.record.ownerEpoch
    &&item.record.verification==='confirmed'&&item.runtime.paths?.noraHome===root
    &&item.runtime.paths?.hermesHome===contained(root,plan.hermes);
  const completedRuntime=item=>bound(item)&&item.record.state==='succeeded'&&item.record.effectState==='changed'
    &&(item.record.recoveryOutcome==null||item.record.recoveryOutcome==='not-required')&&item.runtime.status==='committed'
    &&ordered([item.record.createdAt,item.runtime.createdAt,item.runtime.committedAt,item.runtime.updatedAt,item.record.updatedAt].map(time));
  for(const item of catalog.operations){
    if(facts.get(item.id)?.reason!=='committed')continue;
    let authenticated=completedRuntime(item),successor=item;
    if(authenticated)committedAncestors.add(item.id);
    let predecessor=item.runtime.identities.previous;
    const seen=new Set([item.id]);
    while(predecessor){
      const old=catalog.operations.find(value=>!seen.has(value.id)&&value.record?.state==='succeeded'
        &&value.runtime?.status==='committed'&&value.runtime.schema==='nora-runtime-bootstrap/1'
        &&value.runtime.operationId===value.id&&value.runtime.paths?.noraHome===root
        &&value.runtime.paths?.hermesHome===contained(root,plan.hermes)
        &&facts.get(value.id)?.reason!=='RUNTIME_JOURNAL_INVALID'
        &&value.runtime.identities?.next?.device===predecessor.device&&value.runtime.identities.next.inode===predecessor.inode);
      if(!old)break;
      superseded.add(old.id);seen.add(old.id);
      authenticated=authenticated&&completedRuntime(old)&&facts.get(old.id)?.reason==='directory-identity-unconfirmed'
        &&old.record.ownerEpoch<successor.record.ownerEpoch&&time(old.record.updatedAt)<time(successor.record.createdAt);
      if(authenticated)committedAncestors.add(old.id);
      successor=old;predecessor=old.runtime.identities.previous;
    }
  }
  // A completed rollback to an originally absent root remains complete after
  // a later first install creates that root. The old inspector cannot establish
  // this cross-operation fact: bind its preserved failed tree and completion to
  // a committed successor in the actual current tree's identity chain instead.
  const absentSuccessors=catalog.operations.filter(item=>committedAncestors.has(item.id)&&item.runtime.identities.previous===null);
  for(const item of catalog.operations){
    if(facts.get(item.id)?.reason!=='directory-identity-unconfirmed'||!bound(item)
      ||item.record.state!=='rolled-back'||item.record.effectState!=='restored'
      ||item.record.recoveryOutcome!=='restored-and-verified'||item.runtime.status!=='rolled-back'
      ||item.runtime.identities.previous!==null||item.runtime.previousRuntimeSpec!=null||item.runtime.previousSeal!==null
      ||item.runtime.recoveryVerification!=='files-restored'||item.runtime.newTreePreserved!==true
      ||!ordered([item.record.createdAt,item.runtime.createdAt,item.runtime.recoveryStartedAt,
        item.runtime.recoveryCompletedAt,item.runtime.updatedAt,item.record.updatedAt].map(time)))continue;
    const successor=absentSuccessors.find(value=>item.record.ownerEpoch<value.record.ownerEpoch
      &&time(item.record.updatedAt)<time(value.record.createdAt));
    if(!successor)continue;
    const stage=contained(root,path.relative(root,item.runtime.paths.stage)),backup=contained(root,path.relative(root,item.runtime.paths.backup));
    // lstat also detects dangling links, which must never count as absence.
    if(present(stage)||present(backup))continue;
    const failed=contained(root,path.relative(root,item.runtime.paths.failed));
    if(!present(failed))continue;
    const stat=fs.lstatSync(failed,{bigint:true}),next=item.runtime.identities.next;
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino===0n||!next
      ||next.device!==String(stat.dev)||next.inode!==String(stat.ino))continue;
    superseded.add(item.id);
  }
  // Partial rollback is a candidate until the complete current system check
  // also authenticates its data outside Hermes. Do not make a saved recovery
  // label, or an absent old stage, sufficient permission to delete.
  for(const item of catalog.operations){
    const old=item.runtime;
    if(facts.get(item.id)?.reason!=='directory-identity-unconfirmed'||!bound(item)
      ||item.record.state!=='rolled-back'||item.record.effectState!=='restored'
      ||item.record.recoveryOutcome!=='restored-and-verified'||old.status!=='rolled-back'
      ||!old.identities.previous||old.originalPartial?.schema!=='nora-managed-partial-installation/1'
      ||old.previousSeal?.schema!=='nora-runtime-tree-seal/1'||old.recoveryVerification!=='original-partial-confirmed'
      ||old.newTreePreserved!==true||!old.partialSystemProof
      ||!['untouched','restored'].includes(old.partialSystemProof.effects?.effectState)
      ||!['not-required','restored','restored-and-verified'].includes(old.partialSystemProof.effects?.recoveryOutcome)
      ||!/^[a-f0-9]{64}$/.test(old.partialSystemProof.stateDigest||'')
      ||!ordered([item.record.createdAt,old.createdAt,old.recoveryStartedAt,old.recoveryCompletedAt,old.updatedAt,item.record.updatedAt].map(time)))continue;
    const matches=catalog.operations.filter(value=>committedAncestors.has(value.id)&&value.id===catalog.system?.operationId
      &&value.runtime.identities.previous?.device===old.identities.previous.device
      &&value.runtime.identities.previous?.inode===old.identities.previous.inode
      &&item.record.ownerEpoch<value.record.ownerEpoch&&time(item.record.updatedAt)<time(value.record.createdAt)
      &&JSON.stringify(objectContent(old.originalPartial))===JSON.stringify(objectContent(value.runtime.originalPartial))
      &&require('./tree-integrity').sameSeal(old.previousSeal,value.runtime.previousSeal));
    if(matches.length!==1)continue;
    const successor=matches[0];
    if(present(contained(root,path.relative(root,old.paths.stage)))||present(contained(root,path.relative(root,old.paths.backup))))continue;
    const failed=contained(root,path.relative(root,old.paths.failed)),backup=contained(root,path.relative(root,successor.runtime.paths.backup));
    const identityMatches=(file,expected)=>{if(!present(file))return false;const stat=fs.lstatSync(file,{bigint:true});return stat.isDirectory()
      &&!stat.isSymbolicLink()&&stat.ino!==0n&&expected?.device===String(stat.dev)&&expected.inode===String(stat.ino);};
    if(!identityMatches(failed,old.identities.next)||!identityMatches(backup,old.identities.previous))continue;
    partialRuntimes.push({old:item,successor});
  }
  for(const item of catalog.operations){
    if(item.runtime&&!superseded.has(item.id)&&!partialRuntimes.some(candidate=>candidate.old.id===item.id)){
      const observed=facts.get(item.id);
      if(observed.effectState==='unknown'||observed.recoveryOutcome==='recovery-required'
        ||observed.effectState==='changed'&&observed.reason!=='committed')throw recoveryRequired(
          Object.assign(new Error(`Nora runtime journal: ${observed.reason}`),{code:'UNINSTALL_RUNTIME_UNCONFIRMED'}));
    }
    if(!item.runtime&&!item.first&&item.record&&(!['untouched','restored'].includes(item.record.effectState)
      ||item.record.recoveryOutcome==='recovery-required')&&catalog.system?.operationId!==item.id){
      if(!catalog.system||!completedSystemOperation(item.record))throw recoveryRequired();
      // This is a candidate, never permission to delete. The authenticated
      // current transaction and sealed predecessor content are checked below.
      historical.push(item);
    }
  }
  return {historical,partialRuntimes,closureHistory};
}
function completedSystemOperation(record){
  return record?.schema==='nora-operation/1'&&['update','repair'].includes(record.kind)
    &&record.state==='succeeded'&&record.verification==='confirmed'&&record.effectState==='changed'
    &&(record.recoveryOutcome==null||record.recoveryOutcome==='not-required')
    &&record.planSelected===true&&record.result?.systemReady===true&&record.result?.updateVerified===true;
}
function systemPlanMode(record){
  const mode=record.target?.releasePlan?.mode;
  if(!['update','repair'].includes(record.kind)||record.target?.request?.action!==record.kind
    ||!['update','install'].includes(mode)
    ||require('./releases').compare(record.target?.currentVersion,record.target?.currentVersion)!==0)throw recoveryRequired();
  // Managed repair selects the complete install resource set while retaining
  // update intent. Validate that exact mode, including every system asset.
  return mode;
}
function objectContent(value){
  if(Array.isArray(value))return value.map(objectContent);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,objectContent(value[key])]));
  return value;
}
function systemHandoffs(root,catalog,historical){
  const current=catalog.operations.find(item=>item.id===catalog.system?.operationId);
  return [...historical,...(current?[current]:[])].filter(item=>item.record?.handoffRef).map(item=>{
    const record=item.record,ref=record.handoffRef,selected=record.target?.releasePlan;
    if(typeof ref!=='string'||!path.isAbsolute(ref)||!catalog.appJobs.some(job=>canonical(job)===canonical(ref)))throw recoveryRequired();
    return {job:canonical(ref),operationId:item.id,ownerEpoch:record.ownerEpoch,planDigest:record.planDigest,
      planId:selected?.planId,manifestSha256:selected?.manifestSha256,target:selected?.tag,
      releasePlanSha256:crypto.createHash('sha256').update(JSON.stringify(objectContent(selected))).digest('hex')};
  }).sort((a,b)=>a.job.localeCompare(b.job));
}
function verifiedHandoffPlans(root,capability,catalog,handoffs){
  const releases=require('./releases');
  for(const requested of handoffs){
    const item=catalog.operations.find(value=>value.id===requested.operationId),record=item?.record;
    if(!completedSystemOperation(record)||crypto.createHash('sha256').update(JSON.stringify(record.target)).digest('hex')!==record.planDigest)
      throw recoveryRequired();
    try{
      const selected=releases.validatePlan(record.target.releasePlan,{operationDirectory:contained(root,path.join('installer/operations',item.id)),
        launcherVersion:capability.launcherVersion,platform:capability.platform,arch:capability.arch,channel:capability.channel,mode:systemPlanMode(record)});
      if(!selected.launcherManifest||record.result.version!==selected.version||record.result.commit!==selected.commit)throw recoveryRequired();
    }catch(error){throw recoveryRequired(error);}
  }
}
function verifiedSystemHistory(root,plan,catalog,historical,capability,proof){
  if(!historical.length)return;
  const reject=()=>{throw recoveryRequired(Object.assign(new Error('历史系统更新缺少完整的已提交后继证明，未删除文件。'),
    {code:'UNINSTALL_SYSTEM_HISTORY_UNCONFIRMED'}));};
  const releases=require('./releases'),journal=catalog.system;
  const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const checkedObject=(file,expected)=>{
    const before=fs.lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink()||before.size>4*1024*1024)reject();
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{
      const actual=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(file);
      if(!actual.isFile()||actual.dev!==before.dev||actual.ino!==before.ino||named.isSymbolicLink()
        ||named.dev!==actual.dev||named.ino!==actual.ino||after.size!==actual.size||after.mtimeMs!==actual.mtimeMs
        ||bytes.length!==actual.size||!/^[a-f0-9]{64}$/.test(expected||'')||sha(Buffer.concat([Buffer.from('F\0'),bytes]))!==expected)reject();
      const value=JSON.parse(bytes);if(!value||typeof value!=='object'||Array.isArray(value))reject();return value;
    }finally{fs.closeSync(fd);}
  };
  const validateOperation=item=>{
    const record=item?.record,target=record?.target,request=target?.request,result=record?.result;
    if(!completedSystemOperation(record)||record.operationId!==item.id||!OPERATION_ID.test(item.id)
      ||!Number.isSafeInteger(record.ownerEpoch)||record.ownerEpoch<1||!Number.isSafeInteger(record.sequence)||record.sequence<1
      ||!Number.isFinite(Date.parse(record.createdAt))||!Number.isFinite(Date.parse(record.updatedAt))
      ||Date.parse(record.updatedAt)<Date.parse(record.createdAt)||request?.action!==record.kind
      ||Object.keys(request).some(key=>!['action','port','tag'].includes(key))
      ||Object.keys(target).some(key=>!['request','releasePlan','currentVersion'].includes(key))
      ||request.port!==undefined&&request.port!==capability.port||releases.compare(target?.currentVersion,target?.currentVersion)!==0
      ||sha(JSON.stringify(target))!==record.planDigest||!target.releasePlan?.manifestRef
      ||[['noraHome',root],['hermesHome',contained(root,plan.hermes)],['installRoot',contained(root,plan.tavern)]].some(([key,expected])=>
        typeof result[key]!=='string'||!path.isAbsolute(result[key])||canonical(result[key])!==expected))reject();
    let selected;try{selected=releases.validatePlan(target.releasePlan,{operationDirectory:contained(root,path.join('installer/operations',item.id)),
      launcherVersion:capability.launcherVersion,platform:capability.platform,arch:capability.arch,channel:capability.channel,mode:systemPlanMode(record)});}catch{reject();}
    if(result.version!==selected.version||result.commit!==selected.commit
      ||record.handoffRef&&!selected.launcherManifest
      ||request.tag!==undefined&&request.tag!==selected.tag)reject();
    return {item,selected};
  };
  const current=catalog.operations.find(item=>item.id===journal.operationId),anchor=validateOperation(current);
  if(journal.status!=='committed'||proof?.operationId!==current.id||proof.ownerEpoch!==journal.ownerEpoch
    ||current.record.ownerEpoch!==journal.ownerEpoch||proof.version!==journal.version||anchor.selected.version!==journal.version
    ||proof.beforeVersion!==journal.recoveryPlan.before?.version||current.record.target.currentVersion!==proof.beforeVersion
    ||typeof proof.backup!=='string'||!path.isAbsolute(proof.backup)||canonical(proof.backup)!==canonical(journal.backup)||!proof.receipts)reject();
  const backup=contained(root,path.relative(root,canonical(proof.backup)));
  if(path.dirname(backup)!==contained(root,path.join(plan.tavern,'tavern-backups')))reject();
  const installed=checkedObject(contained(root,path.join(plan.tavern,'tavern-updates/installed.json')),proof.receipts.installed);
  const manifest=checkedObject(contained(root,path.join(plan.tavern,'tavern-updates/installed-manifest.json')),proof.receipts.manifest);
  const previousInstalled=checkedObject(contained(root,path.relative(root,path.join(backup,'host/update-receipts/installed.json'))),proof.receipts.previousInstalled);
  const previousManifest=checkedObject(contained(root,path.relative(root,path.join(backup,'host/update-receipts/installed-manifest.json'))),proof.receipts.previousManifest);
  const contentMatches=(receipt,manifest,selected)=>receipt.version===selected.version&&receipt.commit===selected.commit
    &&receipt.releaseManifestSha256===selected.manifestSha256&&manifest.commit===selected.commit&&manifest.versions?.tavern===selected.version
    &&JSON.stringify(objectContent(manifest))===JSON.stringify(objectContent(selected.releaseManifest))
    &&(manifest.sourceDigest===undefined||receipt.sourceDigest===manifest.sourceDigest);
  if(!contentMatches(installed,manifest,anchor.selected)||previousInstalled.version!==proof.beforeVersion)reject();
  // The updater has one authoritative system journal. Only a completed later
  // writer may replace it. Its hashed backup anchors the direct predecessor;
  // older successful fixed plans must form an uninterrupted version chain.
  // Same-version maintenance retains the exact content identity in that chain.
  let successor=current,expectedVersion=proof.beforeVersion,expectedContent={receipt:previousInstalled,manifest:previousManifest};
  const older=historical.map(validateOperation).sort((a,b)=>b.item.record.ownerEpoch-a.item.record.ownerEpoch);
  for(const {item,selected} of older){
    if(item.record.ownerEpoch>=successor.record.ownerEpoch||Date.parse(item.record.updatedAt)>Date.parse(successor.record.createdAt)
      ||selected.version!==expectedVersion||expectedContent&&!contentMatches(expectedContent.receipt,expectedContent.manifest,selected))reject();
    const before=item.record.target.currentVersion;
    expectedContent=before===selected.version?{receipt:{version:selected.version,commit:selected.commit,
      releaseManifestSha256:selected.manifestSha256,sourceDigest:selected.releaseManifest.sourceDigest},manifest:selected.releaseManifest}:null;
    expectedVersion=before;successor=item;
  }
}
function verifiedPartialRuntimes(root,plan,catalog,candidates,capability,proof){
  if(!candidates.length)return;
  const reject=()=>{throw recoveryRequired(Object.assign(new Error('部分安装的历史恢复缺少完整物理后继证明，未删除文件。'),
    {code:'UNINSTALL_PARTIAL_HISTORY_UNCONFIRMED'}));};
  const transaction=require('./runtime-transaction'),{treeSeal,sameSeal}=require('./tree-integrity'),releases=require('./releases');
  const equal=(a,b)=>JSON.stringify(objectContent(a))===JSON.stringify(objectContent(b));
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const bytes=file=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)reject();
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{
      const before=fs.fstatSync(fd),value=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(file);
      if(before.dev!==stat.dev||before.ino!==stat.ino||named.isSymbolicLink()||named.dev!==before.dev||named.ino!==before.ino
        ||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||value.length!==before.size)reject();return value;
    }finally{fs.closeSync(fd);}};
  const boundFile=(file,expected)=>{if(expected===null){if(present(file))reject();return null;}
    if(!/^[a-f0-9]{64}$/.test(expected||''))reject();const value=bytes(file);if(hash(value)!==expected)reject();return value;};
  const operationShape=record=>{const target=record.target,request=target?.request;
    if(!record.planSelected||!Number.isSafeInteger(record.sequence)||record.sequence<1||!target?.releasePlan?.manifestRef
      ||Object.keys(target).some(key=>!['request','releasePlan','currentVersion'].includes(key))
      ||!request||Object.keys(request).some(key=>!['action','port','tag'].includes(key))
      ||request.port!==undefined&&request.port!==capability.port)reject();};
  const current=candidates[0].successor,record=current.record,journal=catalog.system;
  operationShape(record);
  if(candidates.some(value=>value.successor.id!==current.id)||!completedSystemOperation(record)
    ||record.target?.releasePlan?.mode!=='install'||hash(JSON.stringify(record.target))!==record.planDigest
    ||proof?.operationId!==current.id||journal?.operationId!==current.id||proof.ownerEpoch!==record.ownerEpoch
    ||journal.ownerEpoch!==record.ownerEpoch||journal.status!=='committed'||proof.version!==journal.version
    ||!proof.receipts||proof.journalSha256!==hash(fs.readFileSync(catalog.systemFile)))reject();
  const selected=releases.validatePlan(record.target.releasePlan,{operationDirectory:contained(root,path.join('installer/operations',current.id)),
    launcherVersion:capability.launcherVersion,platform:capability.platform,arch:capability.arch,channel:capability.channel,mode:systemPlanMode(record)});
  if(record.result.version!==selected.version||record.result.commit!==selected.commit||journal.version!==selected.version
    ||record.target.request.tag!==undefined&&record.target.request.tag!==selected.tag
    ||record.target.currentVersion!==journal.recoveryPlan.before?.version||proof.beforeVersion!==record.target.currentVersion
    ||[['noraHome',root],['hermesHome',contained(root,plan.hermes)],['installRoot',contained(root,plan.tavern)]].some(([key,file])=>record.result[key]!==file)
    ||typeof proof.backup!=='string'||!path.isAbsolute(proof.backup)||canonical(proof.backup)!==canonical(journal.backup))reject();
  const backup=contained(root,path.relative(root,proof.backup));
  if(path.dirname(backup)!==contained(root,path.join(plan.tavern,'tavern-backups')))reject();
  const installedFile=contained(root,path.join(plan.tavern,'tavern-updates/installed.json')),
    manifestFile=contained(root,path.join(plan.tavern,'tavern-updates/installed-manifest.json'));
  for(const [file,digest] of [[installedFile,proof.receipts.installed],[manifestFile,proof.receipts.manifest]])
    if(hash(Buffer.concat([Buffer.from('F\0'),bytes(file)]))!==digest)reject();
  const installed=JSON.parse(bytes(installedFile)),manifest=JSON.parse(bytes(manifestFile));
  if(installed.version!==selected.version||installed.commit!==selected.commit||installed.releaseManifestSha256!==selected.manifestSha256
    ||!equal(manifest,selected.releaseManifest))reject();
  const savedBaseline=journal.recoveryPlan.partialBaseline;
  const pythonOnly=savedBaseline===undefined&&proof.partialHistoryKind==='python-only'
    &&journal.recoveryPlan.lifecycle?.partialRepair===undefined&&journal.recoveryPlan.before?.systemReady===true
    &&['running','gatewayRunning','clawchatConnected'].every(key=>journal.recoveryPlan.before?.[key]===false)
    &&candidates.every(({old})=>old.runtime.originalPartial.missing.nativeRuntime===false
      &&old.runtime.originalPartial.missing.nativeLifecycle===false&&old.runtime.originalPartial.missing.python===true);
  const original=candidates[0].old.runtime.originalPartial;
  const markerBytes=bytes(contained(root,path.join(plan.hermes,'hermes-agent/.hermes-bootstrap-complete')));
  const baseline=pythonOnly?{schema:'nora-managed-partial-repair-baseline/1',
    partialRepair:{...original,missing:{...original.missing,python:false},bindings:{...original.bindings,runtimeMarker:hash(markerBytes)}},
    stateDigest:proof.stateDigest,storyInventory:proof.storyInventory,worlds:journal.recoveryPlan.worlds,
    readerManifestSha256:selected.manifestSha256,readerCommit:selected.commit}:savedBaseline;
  const currentSnapshot=baseline?.partialRepair;
  if(!baseline||Object.keys(baseline).sort().join(',')!=='partialRepair,readerCommit,readerManifestSha256,schema,stateDigest,storyInventory,worlds'
    ||baseline.schema!=='nora-managed-partial-repair-baseline/1'||!pythonOnly&&!equal(currentSnapshot,journal.recoveryPlan.lifecycle?.partialRepair)
    ||!/^[a-f0-9]{64}$/.test(baseline.stateDigest||'')||baseline.stateDigest!==journal.recoveryPlan.state?.savedDigest
    ||baseline.readerManifestSha256!==selected.manifestSha256||baseline.readerCommit!==selected.commit
    ||!baseline.storyInventory||typeof baseline.storyInventory!=='object'||Array.isArray(baseline.storyInventory)
    ||!baseline.worlds||typeof baseline.worlds!=='object'||Array.isArray(baseline.worlds)
    ||!equal(baseline.worlds,journal.recoveryPlan.worlds)||!Array.isArray(proof.targets))reject();
  for(const {old,successor} of candidates){
    const previous=contained(root,path.relative(root,successor.runtime.paths.backup)),snapshot=old.runtime.originalPartial;
    operationShape(old.record);
    if(old.record.planSelected!==true||old.record.target?.releasePlan?.mode!=='install'
      ||hash(JSON.stringify(old.record.target))!==old.record.planDigest||old.record.target.currentVersion!==snapshot.version)reject();
    const oldPlan=releases.validatePlan(old.record.target.releasePlan,{operationDirectory:contained(root,path.join('installer/operations',old.id)),
      launcherVersion:capability.launcherVersion,platform:capability.platform,arch:capability.arch,channel:capability.channel,mode:systemPlanMode(old.record)});
    if(old.record.target.request.tag!==undefined&&old.record.target.request.tag!==oldPlan.tag)reject();
    const oldSystem=old.runtime.partialSystemProof.journalSeal;
    if(oldSystem!==null&&(!oldSystem||!Array.isArray(oldSystem.identity)||oldSystem.identity.length!==2
      ||!oldSystem.identity.every(value=>typeof value==='string'&&/^\d+$/.test(value))||oldSystem.identity[1]==='0'
      ||!/^[a-f0-9]{64}$/.test(oldSystem.sha256||'')))reject();
    if(!sameSeal(old.runtime.previousSeal,treeSeal(previous))||!sameSeal(old.runtime.previousSeal,successor.runtime.previousSeal)
      ||!equal(snapshot,successor.runtime.originalPartial)||snapshot.version!==record.target.currentVersion
      ||snapshot.commit!==currentSnapshot?.commit||snapshot.version!==currentSnapshot?.version
      ||!Number.isInteger(old.runtime.partialPort)||old.runtime.partialPort!==capability.port
      ||old.runtime.partialPort!==successor.runtime.partialPort)reject();
    const bindings=snapshot.bindings;
    if(Object.keys(snapshot).sort().join(',')!=='bindings,commit,missing,programs,schema,version'
      ||!bindings||Object.keys(bindings).sort().join(',')!=='config,instance,manifest,nativeConfig,receipt,runtimeMarker,system'
      ||!snapshot.missing||Object.keys(snapshot.missing).sort().join(',')!=='nativeLifecycle,nativeRuntime,python'
      ||!Object.values(snapshot.missing).every(value=>typeof value==='boolean')||!Object.values(snapshot.missing).some(Boolean)
      ||!snapshot.programs||Object.keys(snapshot.programs).sort().join(',')!=='app,nora-mcp,ops')reject();
    // Hermes was swapped first; the system preflight legitimately sees a new
    // Python and marker. All other original bindings/programs stay exact.
    for(const key of ['instance','config','manifest','nativeConfig','receipt','system'])
      if(bindings[key]!==currentSnapshot.bindings?.[key])reject();
    for(const key of ['nativeLifecycle','nativeRuntime'])if(snapshot.missing[key]!==currentSnapshot.missing?.[key])reject();
    if(snapshot.missing.python!==true||currentSnapshot.missing?.python!==false||!equal(snapshot.programs,currentSnapshot.programs))reject();
    boundFile(contained(root,path.join(plan.hermes,'hermes-agent/.hermes-bootstrap-complete')),currentSnapshot.bindings?.runtimeMarker);
    const originalFiles={instance:path.join(previous,'nora-instance.json'),config:path.join(previous,'config.yaml'),
      runtimeMarker:path.join(previous,'hermes-agent/.hermes-bootstrap-complete'),manifest:path.join(backup,'host/update-receipts/installed-manifest.json'),
      receipt:path.join(backup,'host/update-receipts/installed.json'),system:path.join(backup,'host/update-receipts/nora-system.json'),
      nativeConfig:path.join(backup,'state/native-runtime/config.yaml')};
    for(const [name,file] of Object.entries(originalFiles))boundFile(contained(root,path.relative(root,file)),bindings[name]);
    const instance=JSON.parse(bytes(originalFiles.instance)),receipt=JSON.parse(bytes(originalFiles.receipt)),
      originalManifest=JSON.parse(bytes(originalFiles.manifest)),originalSystem=JSON.parse(bytes(originalFiles.system)),marker=JSON.parse(bytes(originalFiles.runtimeMarker));
    if(instance.schema!==1||instance.noraHome!==root||instance.hermesHome!==contained(root,plan.hermes)
      ||instance.installRoot!==contained(root,plan.tavern)||instance.port!==capability.port
      ||![1,2].includes(receipt.schema)||receipt.version!==snapshot.version||receipt.commit!==snapshot.commit
      ||originalManifest.schema!=='tavern-release/v2'||originalManifest.versions?.tavern!==snapshot.version||originalManifest.commit!==snapshot.commit
      ||originalSystem.schema!==1||originalSystem.version!==snapshot.version||originalSystem.commit!==snapshot.commit
      ||['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'].some(key=>originalSystem.proof?.[key]!==true)
      ||marker.schema!==1||marker.source!=='nora-integrated-runtime'||marker.platform!==capability.platform||marker.arch!==capability.arch
      ||!/^[a-f0-9]{64}$/.test(marker.sha256||''))reject();
    for(const relative of capability.platform==='win32'?['Scripts/python.exe']:['bin/python3','bin/python'])
      if(present(contained(root,path.relative(root,path.join(previous,'hermes-agent/venv',relative)))))reject();
    if(baseline.stateDigest!==old.runtime.partialSystemProof.stateDigest
      ||transaction.programDigest(contained(root,path.relative(root,path.join(backup,'state'))))!==baseline.stateDigest)reject();
    const targets=journal.recoveryPlan.targets;
    if(!Array.isArray(targets))reject();
    for(const [name,relative] of Object.entries({app:'tavern-runtime',ops:'tavern-ops','nora-mcp':'nora-mcp'})){
      const matches=targets.filter(value=>value.name===name&&value.namespace==='install'&&value.relative==='apps/'+relative);
      if(matches.length>1)reject();
      const target=matches[0],file=contained(root,path.relative(root,target?path.join(backup,'trees',name):path.join(root,plan.tavern,'apps',relative))),expected=snapshot.programs[name];
      // Python retains the exact journal integer. JSON.parse cannot preserve
      // Windows file IDs above 2^53, so never stringify its rounded number.
      const exact=target?proof.targets.filter(value=>value.name===target.name&&value.namespace===target.namespace&&value.relative===target.relative):[];
      if(target&&(exact.length!==1||exact[0].oldDigest!==target.oldDigest))reject();
      const oldIdentity=exact[0]?.oldIdentity;
      if(name==='app')for(const [key,leaf] of Object.entries({nativeRuntime:'native-runtime.json',nativeLifecycle:'native_lifecycle.py'})){
        const program=path.join(file,leaf);let exists=false;if(present(program)){const stat=fs.lstatSync(program);if(stat.isSymbolicLink()||!stat.isFile())reject();exists=true;}
        if(snapshot.missing[key]===exists)reject();
      }
      if(expected===null){if(present(file)||target?.oldIdentity!=null||target?.oldDigest!=null||oldIdentity!=null)reject();continue;}
      if(!expected||!Array.isArray(expected.identity)||expected.identity.length!==2||!present(file))reject();
      const stat=fs.lstatSync(file,{bigint:true});
      if(!stat.isDirectory()||stat.isSymbolicLink()||expected.identity[0]!==String(stat.dev)||expected.identity[1]!==String(stat.ino)
        ||expected.digest!==transaction.programDigest(file)||target&&(!Array.isArray(oldIdentity)||oldIdentity.length!==2
          ||!oldIdentity.every(value=>typeof value==='string'&&/^\d+$/.test(value))||oldIdentity[1]==='0'
          ||!equal(oldIdentity,expected.identity)||target.oldDigest!==expected.digest))reject();
    }
    // Re-read the bound records after all external bytes were checked. The
    // native writer remains held, and a changed journal cannot reuse this proof.
    for(const item of [old,successor])if(!equal(readJournal(item.runtimeFile),item.runtime)
      ||!equal(readJournal(contained(root,path.join('installer/operations',item.id,'operation.json'))),item.record))reject();
  }
  if(proof.journalSha256!==hash(fs.readFileSync(catalog.systemFile)))reject();
}
function assertNoPendingTransaction(root,plan){
  try{
    const catalog=transactionCatalog(root,plan);
    runtimeEffects(root,plan,catalog);
    if(!catalog.system&&!catalog.appJobs.length&&!catalog.operations.some(item=>item.first))return;
    // Keep the public cleanup synchronous. This bounded child only reads
    // sealed current-APP resources; the parent keeps the native writer fd
    // throughout inspection and deletion. It never acquires a second owner.
    readOnlyNodeCheck('inspectSealedTransactions',plan);
  }catch(error){if(error.code==='UNINSTALL_RECOVERY_REQUIRED'||['UNINSTALL_INSPECTION_STALLED','UNINSTALL_INSPECTION_LIMIT'].includes(error.code))throw error;throw recoveryRequired(error);}
}
function readOnlyNodeCheck(method,plan){
  const script=`(async()=>{await require(${JSON.stringify(__filename)})[${JSON.stringify(method)}](JSON.parse(process.argv[1]));process.stdout.write('nora-uninstall-facts-ok');})().catch(error=>{process.stdout.write(JSON.stringify(${localDiagnostic.toString()}(error)),()=>process.exit(1));});`;
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1',PYTHONDONTWRITEBYTECODE:'1'};
  delete env.NODE_OPTIONS;for(const key of Object.keys(env))if(key.startsWith('NORA_OPERATION_'))delete env[key];
  // The transaction inspector supervises and reaps its own Python process.
  // Killing this Node from outside would orphan Python on Windows. Executor
  // inspection does not spawn Python and retains its short startup deadline.
  const result=spawnSync(process.execPath,['-e',script,JSON.stringify(plan)],{env,encoding:'utf8',windowsHide:true,
    ...(method==='inspectSealedTransactions'?{}:{timeout:60000}),maxBuffer:64*1024});
  if(result.error)throw recoveryRequired(result.error);
  if(result.status!==0||result.stdout!=='nora-uninstall-facts-ok'){
    let detail;try{detail=JSON.parse(result.stdout);}catch{}
    const cause=Object.assign(new Error(detail?.message||String(result.stderr||'只读事务检查未返回有效结果。').slice(0,2000)),
      {name:detail?.name||'Error',code:detail?.code||'UNINSTALL_INSPECTION_FAILED',stack:detail?.stack,
        ...(detail?.cause?{cause:Object.assign(new Error(detail.cause.message),detail.cause)}:{})});
    if(['UNINSTALL_INSPECTION_STALLED','UNINSTALL_INSPECTION_LIMIT'].includes(cause.code))throw cause;
    throw recoveryRequired(cause);
  }
}
async function inspectExecutorHistory(plan){
  const root=validate(plan),history=await require('./operation-lock').probe({directory:contained(root,'installer')});
  const facts=require('./operation-inspection').inspectExecutors({sessions:history.sessions});
  if(history.errors?.length||!facts.safe)throw Object.assign(new Error('尚未确认上次维护进程已结束，未删除文件。'),{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
}
const INSPECTION_POLICY=Object.freeze({idleMs:120000,maxMs:30*60*1000,pollMs:1000});
const inspectionFailure=(code,message)=>Object.assign(new Error(message),{code});
async function inspectionStartup(promise){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(inspectionFailure('UNINSTALL_INSPECTION_STALLED','启动器校验连续 120 秒未完成，未删除文件。')),INSPECTION_POLICY.idleMs);
  })]);}finally{clearTimeout(timer);}
}
function runPythonInspection(execution,input,policy=INSPECTION_POLICY){
  return new Promise((resolve,reject)=>{
    const started=performance.now();let lastProgress=started,sequence=0,bytes=0,entries=0;
    let stdout='',pending='',diagnostic='',failure=null,closed=false;
    const child=spawn(execution.command,['-B','-c',PYTHON_TRANSACTION_FACTS],
      {env:execution.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    // Every failure waits for close: no caller may release the writer or
    // delete files while a timed-out inspector is still running.
    const stop=error=>{if(!failure)failure=error;if(!closed)child.kill('SIGKILL');};
    const failed=message=>inspectionFailure('UNINSTALL_PYTHON_INSPECTION_FAILED',message);
    const frame=line=>{
      if(!line.startsWith('{"schema": "nora-uninstall-progress/1"')&&!line.startsWith('{"schema":"nora-uninstall-progress/1"'))return;
      let value;try{value=JSON.parse(line);}catch{stop(failed('只读检查进度记录无效，未删除文件。'));return;}
      if(value.schema!=='nora-uninstall-progress/1'||![value.sequence,value.bytes,value.entries].every(Number.isSafeInteger)
        ||value.sequence<1||value.bytes<0||value.entries<0||value.bytes<bytes||value.entries<entries){
        stop(failed('只读检查进度记录无效，未删除文件。'));return;
      }
      // Replayed counters, diagnostic messages and periodic heartbeats do
      // not extend the deadline. Only confirmed read/entry work counts.
      if(value.sequence>sequence&&(value.bytes>bytes||value.entries>entries)){
        sequence=value.sequence;bytes=value.bytes;entries=value.entries;lastProgress=performance.now();
      }
    };
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',value=>{stdout+=value;if(Buffer.byteLength(stdout)>16*1024){stdout='';stop(failed('只读检查输出超过限制，未删除文件。'));}});
    child.stderr.on('data',value=>{
      diagnostic=(diagnostic+value).slice(-8192);pending+=value;
      let newline;while((newline=pending.indexOf('\n'))!==-1){
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);
        if(line.length<=1024)frame(line);
        else if(line.startsWith('{"schema"'))stop(failed('只读检查进度记录超过限制，未删除文件。'));
      }
      if(pending.length>8192){if(pending.startsWith('{"schema"'))stop(failed('只读检查进度记录超过限制，未删除文件。'));pending=pending.slice(-1024);}
    });
    child.on('error',error=>stop(failed(`无法运行只读检查：${error.message}`)));
    child.stdin.on('error',error=>stop(failed(`无法传入只读检查计划：${error.message}`)));
    const timer=setInterval(()=>{
      const now=performance.now();
      if(now-started>=policy.maxMs)stop(inspectionFailure('UNINSTALL_INSPECTION_LIMIT','只读事务检查超过 30 分钟安全上限，未删除文件。'));
      else if(now-lastProgress>=policy.idleMs)stop(inspectionFailure('UNINSTALL_INSPECTION_STALLED','只读事务检查连续 120 秒没有读取进展，未删除文件。'));
    },policy.pollMs);
    child.once('exit',()=>clearInterval(timer));
    child.on('close',(status,signal)=>{
      closed=true;clearInterval(timer);
      if(failure){reject(failure);return;}
      if(status!==0||signal){reject(failed(diagnostic||'Python 只读事务检查失败，未删除文件。'));return;}
      let facts;try{facts=JSON.parse(stdout);}catch{reject(failed('只读事务检查未返回有效结果，未删除文件。'));return;}
      if(facts?.schema!=='nora-uninstall-facts/1'||facts.safe!==true){reject(failed('只读事务检查未确认安全，未删除文件。'));return;}
      resolve(facts);
    });
    child.stdin.end(input);
  });
}
async function inspectSealedTransactions(plan,{captureContext}={}){
  const root=validate(plan),catalog=transactionCatalog(root,plan);
  const {historical,partialRuntimes,closureHistory}=runtimeEffects(root,plan,catalog);
  const handoffs=systemHandoffs(root,catalog,historical);
  const capability=await inspectionStartup(require('./launcher-capability').validate({receiptPath:path.join(root,'installer/launcher-control.json'),
    noraHome:root,currentExecutable:process.execPath}));
  if(canonical(capability.hermesHome)!==contained(root,plan.hermes)||canonical(capability.installRoot)!==contained(root,plan.tavern))throw recoveryRequired();
  verifiedHandoffPlans(root,capability,catalog,handoffs);
  const venv=path.join(capability.hermesHome,'hermes-agent','venv');
  const command=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const environment={...process.env,PYTHONDONTWRITEBYTECODE:'1'};
  delete environment.NODE_OPTIONS;for(const key of Object.keys(environment))if(key.startsWith('NORA_OPERATION_'))delete environment[key];
  const execution=require('./managed-python').resolveExecution(command,{managedPythonRoot:path.join(capability.hermesHome,'python'),venvHome:venv,env:environment});
  const input={root,hermesHome:capability.hermesHome,installRoot:capability.installRoot,
    first:catalog.operations.filter(item=>item.first).map(item=>({id:item.id,file:item.firstFile,
      record:item.record?{operationId:item.record.operationId,state:item.record.state}:null})),
    system:catalog.system!==null&&catalog.system!==undefined,systemHistory:historical.length>0,partialHistory:partialRuntimes.length>0,
    retiredHistory:closureHistory.closed.size>0,
    systemJournalSha256:partialRuntimes.length||closureHistory.closed.size?crypto.createHash('sha256').update(fs.readFileSync(catalog.systemFile)).digest('hex'):null,
    partialOrigins:partialRuntimes.map(item=>item.old.runtime.originalPartial),legacy:catalog.legacy,
    appJobs:catalog.appJobs,requiredHandoffs:handoffs,executable:process.execPath,
    resources:capability.resources};
  const facts=await runPythonInspection(execution,JSON.stringify(input));
  try{
    if(handoffs.length&&(facts.handoffs?.count!==handoffs.length
      ||facts.handoffs.sha256!==crypto.createHash('sha256').update(JSON.stringify(objectContent(handoffs))).digest('hex')))throw recoveryRequired();
    verifiedSystemHistory(root,plan,catalog,historical,capability,facts.system);
    verifiedPartialRuntimes(root,plan,catalog,partialRuntimes,capability,facts.system);
    if(closureHistory.closed.size)verifiedCurrentSystem(root,plan,catalog,capability,facts.system);
  }
  catch(error){if(error.code==='UNINSTALL_RECOVERY_REQUIRED')throw error;throw recoveryRequired(error);}
  if(!captureContext)return;
  captureContext.check();
  const references=closureHistory.references.slice();
  if(partialRuntimes.length){
    const successor=partialRuntimes[0].successor,history=require('./operation-history');
    const source={record:successor.record,runtimeSha256:history.hash(fs.readFileSync(successor.runtimeFile)),
      systemJournal:fs.readFileSync(catalog.systemFile,'utf8'),systemJournalSha256:history.hash(fs.readFileSync(catalog.systemFile)),proof:facts.system,
      reader:{launcherVersion:capability.launcherVersion,platform:capability.platform,arch:capability.arch,channel:capability.channel}};
    const closed=partialRuntimes.map(({old})=>({record:old.record,runtimeSha256:history.hash(fs.readFileSync(old.runtimeFile))}));
    const ref=history.save(root,captureContext,source,closed);
    const prior=references.find(item=>item.path===ref.path);if(prior&&prior.sha256!==ref.sha256)throw recoveryRequired();
    if(!prior)references.push(ref);await captureContext.journal(path.join(root,ref.path));
  }
  captureContext.check();return references;
}
async function prepareHistory(context,roots){if(!roots)throw recoveryRequired();
  const plan=makePlan({home:roots.noraHome,hermesHome:roots.hermesHome,installRoot:roots.installRoot,mode:'keep'});
  return inspectSealedTransactions(plan,{captureContext:context});
}
function verifiedCurrentSystem(root,plan,catalog,capability,proof){
  const journal=catalog.system,item=catalog.operations.find(value=>value.id===journal?.operationId),record=item?.record;
  const restored=journal?.status==='restored'&&record?.state==='rolled-back'&&record.effectState==='restored'
    &&record.verification==='confirmed'&&record.recoveryOutcome==='restored-and-verified'
    &&record.result?.updateRecovered===true&&record.result?.recoveryVerification==='confirmed'&&proof?.restored===true;
  if(!item||(!restored&&!completedSystemOperation(record))||!proof||proof.operationId!==item.id
    ||!restored&&journal.status!=='committed'||proof.ownerEpoch!==record.ownerEpoch||journal.ownerEpoch!==record.ownerEpoch
    ||proof.journalSha256!==crypto.createHash('sha256').update(fs.readFileSync(catalog.systemFile)).digest('hex')
    ||crypto.createHash('sha256').update(JSON.stringify(record.target)).digest('hex')!==record.planDigest)throw recoveryRequired();
  const selected=require('./releases').validatePlan(record.target.releasePlan,{operationDirectory:contained(root,`installer/operations/${item.id}`),
    launcherVersion:capability.launcherVersion,platform:capability.platform,arch:capability.arch,channel:capability.channel,mode:systemPlanMode(record)});
  const installedFile=contained(root,path.join(plan.tavern,'tavern-updates/installed.json')),manifestFile=contained(root,path.join(plan.tavern,'tavern-updates/installed-manifest.json'));
  const installed=readJournal(installedFile),manifest=readJournal(manifestFile),digest=file=>crypto.createHash('sha256').update(Buffer.concat([Buffer.from('F\0'),fs.readFileSync(file)])).digest('hex');
  if(journal.version!==selected.version||!proof.receipts||proof.receipts.installed!==digest(installedFile)||proof.receipts.manifest!==digest(manifestFile)
    ||[['noraHome',root],['hermesHome',contained(root,plan.hermes)],['installRoot',contained(root,plan.tavern)]].some(([key,file])=>record.result[key]!==file))throw recoveryRequired();
  if(restored){
    if(installed.version!==record.target.currentVersion||installed.version!==journal.recoveryPlan.before.version
      ||proof.beforeVersion!==record.target.currentVersion||proof.version!==installed.version||record.result.version!==installed.version
      ||record.result.commit!==installed.commit||manifest.commit!==installed.commit||manifest.versions?.tavern!==installed.version
      ||proof.receipts.installed!==proof.receipts.previousInstalled||proof.receipts.manifest!==proof.receipts.previousManifest)throw recoveryRequired();
  }else if(record.result.version!==selected.version||record.result.commit!==selected.commit||installed.version!==selected.version
    ||installed.commit!==selected.commit||installed.releaseManifestSha256!==selected.manifestSha256
    ||JSON.stringify(objectContent(manifest))!==JSON.stringify(objectContent(selected.releaseManifest)))throw recoveryRequired();
}
// Pure read-only public inspectors are reused here. No recovery CLI or write
// capability is invoked; Python bytecode creation is disabled by both -B/env.
const PYTHON_TRANSACTION_FACTS=String.raw`
import importlib.util,json,sys,re,time,hashlib,math
from pathlib import Path
args=json.load(sys.stdin)
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,file);value=importlib.util.module_from_spec(spec)
    sys.modules[name]=value;spec.loader.exec_module(value);return value
recovery=module('nora_uninstall_recovery',args['resources']['update_recovery.py']['path'])
first=module('nora_uninstall_first',args['resources']['first_install.py']['path'])
progress_bytes=0;progress_entries=0;progress_sequence=0;progress_sent=time.monotonic()
def emit_progress(force=False):
    global progress_sequence,progress_sent
    now=time.monotonic()
    if not force and now-progress_sent<0.25:return
    if not progress_bytes and not progress_entries:return
    progress_sequence+=1;progress_sent=now
    print(json.dumps({'schema':'nora-uninstall-progress/1','sequence':progress_sequence,
        'bytes':progress_bytes,'entries':progress_entries}),file=sys.stderr,flush=True)
def progressed(bytes_read,entries_completed):
    global progress_bytes,progress_entries
    progress_bytes+=bytes_read;progress_entries+=entries_completed;emit_progress()
def observe_digest(original):
    def observed(*args,**kwargs):
        kwargs['on_progress']=progressed
        try:return original(*args,**kwargs)
        finally:emit_progress(force=True)
    return observed
# first_install loads its own recovery module and owns an independent code
# hasher; all three must report genuine work without changing hash bytes.
recovery.digest=observe_digest(recovery.digest)
first._recovery.digest=observe_digest(first._recovery.digest)
first.first_install_code_digest=observe_digest(first.first_install_code_digest)
system=None
if args['system']:
    system=recovery.effects(args['hermesHome'],args['installRoot'])
    if system['effectState']=='unknown' or (system['effectState']=='changed' and system.get('status')!='committed'):
        raise RuntimeError('unconfirmed system effects: '+str(system.get('reason','')))
successor=None
system_proof=None
if system and system.get('status')=='committed':
    operation=Path(args['root'])/'installer/operations'/str(system.get('operationId'))/'operation.json'
    record=recovery.read_object(operation,max_bytes=256*1024)
    journal=recovery.load(args['hermesHome'],args['installRoot'],full=bool(args.get('partialHistory') or args.get('retiredHistory')))
    installed=recovery.read_object(Path(args['installRoot'])/'tavern-updates/installed.json')
    if record.get('operationId')==system.get('operationId') and record.get('state')=='succeeded' and installed.get('version')==journal.record.get('version'):
        successor=system['operationId']
    if args.get('systemHistory') or args.get('partialHistory') or args.get('retiredHistory'):
        if not successor:raise RuntimeError('unconfirmed historical system successor')
        receipts=Path(args['installRoot'])/'tavern-updates'
        previous=journal.backup/'host/update-receipts'
        system_proof={'operationId':successor,'ownerEpoch':journal.record.get('ownerEpoch'),
            'version':journal.record.get('version'),'beforeVersion':journal.plan['before']['version'],
            'backup':str(journal.backup),'receipts':{
                'installed':recovery.digest(receipts/'installed.json'),'manifest':recovery.digest(receipts/'installed-manifest.json'),
                'previousInstalled':recovery.digest(previous/'installed.json'),'previousManifest':recovery.digest(previous/'installed-manifest.json')}}
        if args.get('partialHistory') or args.get('retiredHistory'):
            raw=(Path(args['installRoot'])/'tavern-updates/transaction.json').read_bytes()
            sealed=hashlib.sha256(raw).hexdigest()
            if sealed!=args.get('systemJournalSha256') or json.loads(raw)!=journal.record:raise RuntimeError('partial successor journal changed')
            if not args.get('partialHistory'):
                system_proof['journalSha256']=sealed
            else:
                baseline=journal.plan.get('partialBaseline');state=journal.plan.get('state')
                python_only=(baseline is None and 'partialBaseline' not in journal.plan
                    and 'partialRepair' not in journal.plan.get('lifecycle',{})
                    and isinstance(args.get('partialOrigins'),list) and bool(args['partialOrigins'])
                    and all(isinstance(item,dict) and item.get('missing')=={'nativeRuntime':False,'nativeLifecycle':False,'python':True}
                        for item in args['partialOrigins'])
                    and journal.plan['before'].get('systemReady') is True
                    and all(journal.plan['before'].get(key) is False for key in ('running','gatewayRunning','clawchatConnected')))
                if python_only:
                    if (not isinstance(state,dict) or state.get('phase')!='saved' or state.get('mode')!='copy'
                            or not re.fullmatch('[a-f0-9]{64}',str(state.get('savedDigest') or ''))
                            or not isinstance(state.get('storyInventory'),dict)
                            or not isinstance(journal.plan.get('worlds'),dict)):
                        raise RuntimeError('Python-only successor baseline invalid')
                    baseline={'stateDigest':state['savedDigest'],'worlds':journal.plan['worlds']}
                else:
                    keys={'schema','partialRepair','stateDigest','storyInventory','worlds','readerManifestSha256','readerCommit'}
                    if (not isinstance(baseline,dict) or set(baseline)!=keys
                            or baseline.get('schema')!='nora-managed-partial-repair-baseline/1'
                            or baseline.get('partialRepair')!=journal.plan.get('lifecycle',{}).get('partialRepair')
                            or not isinstance(state,dict) or baseline.get('stateDigest')!=state.get('savedDigest')
                            or not re.fullmatch('[a-f0-9]{64}',str(baseline.get('stateDigest') or ''))
                            or not re.fullmatch('[a-f0-9]{64}',str(baseline.get('readerManifestSha256') or ''))
                            or not re.fullmatch('[a-f0-9]{40}',str(baseline.get('readerCommit') or ''))
                            or not isinstance(baseline.get('storyInventory'),dict)
                            or not isinstance(baseline.get('worlds'),dict) or baseline['worlds']!=journal.plan.get('worlds')):
                        raise RuntimeError('partial successor baseline invalid')
                saved=recovery.safe_path(journal.backup,'state')
                if recovery.digest(saved)!=baseline['stateDigest']:raise RuntimeError('partial successor original state changed')
                # Reuse the recovery helper's full story-resource traversal, but
                # compare the updater baseline's raw SHA (without its F\\0 prefix).
                inventory={}
                for relative in recovery.story_inventory(saved):
                    if Path(relative).parts[0]!='native':continue
                    digest=hashlib.sha256();file=recovery.safe_path(saved,relative)
                    with recovery._io_path(file).open('rb') as stream:
                        for block in iter(lambda:stream.read(1024*1024),b''):
                            digest.update(block);progressed(len(block),0)
                    inventory[str(Path(relative))]=digest.hexdigest()
                emit_progress(force=True)
                if python_only:
                    if recovery.story_inventory(saved)!=state['storyInventory']:raise RuntimeError('Python-only original story inventory changed')
                    system_proof.update(partialHistoryKind='python-only',stateDigest=baseline['stateDigest'],storyInventory=inventory)
                elif inventory!=baseline['storyInventory']:raise RuntimeError('partial successor story inventory changed')
                system_proof['journalSha256']=sealed
                system_proof['targets']=[{'name':item['name'],'namespace':item['namespace'],'relative':item['relative'],
                    'oldIdentity':None if item['oldIdentity'] is None else list(map(str,item['oldIdentity'])),
                    'oldDigest':item['oldDigest']} for item in journal.plan['targets'] if item['namespace']=='install']

if system and system.get('status')=='restored' and args.get('retiredHistory') and not args.get('partialHistory'):
    journal=recovery.load(args['hermesHome'],args['installRoot'],full=True)
    record=recovery.read_object(Path(args['root'])/'installer/operations'/str(system.get('operationId'))/'operation.json',max_bytes=256*1024)
    if (record.get('state')!='rolled-back' or record.get('verification')!='confirmed'
            or record.get('effectState')!='restored' or record.get('recoveryOutcome')!='restored-and-verified'):
        raise RuntimeError('retired history current recovery unconfirmed')
    raw=(Path(args['installRoot'])/'tavern-updates/transaction.json').read_bytes();sealed=hashlib.sha256(raw).hexdigest()
    if sealed!=args.get('systemJournalSha256') or json.loads(raw)!=journal.record:raise RuntimeError('restored successor journal changed')
    receipts=Path(args['installRoot'])/'tavern-updates';previous=journal.backup/'host/update-receipts'
    installed=recovery.read_object(receipts/'installed.json')
    system_proof={'operationId':journal.record['operationId'],'ownerEpoch':journal.record['ownerEpoch'],
        'version':installed['version'],'beforeVersion':journal.plan['before']['version'],'backup':str(journal.backup),
        'journalSha256':sealed,'restored':True,'receipts':{
        'installed':recovery.digest(receipts/'installed.json'),'manifest':recovery.digest(receipts/'installed-manifest.json'),
        'previousInstalled':recovery.digest(previous/'installed.json'),'previousManifest':recovery.digest(previous/'installed-manifest.json')}}
if (args.get('systemHistory') or args.get('partialHistory') or args.get('retiredHistory')) and not system_proof:raise RuntimeError('missing historical system successor')
if args['legacy'] and args['legacy'].get('phase')=='committed' and not successor:
    raise RuntimeError('unconfirmed legacy successor')
for item in args['first']:
    facts=first.inspect_first_install(item['file'])
    value=recovery.read_object(item['file'])
    # An authenticated, actually committed successor owns the live files.
    # Historical successful journals retain their original sealed intent,
    # while their old root identities legitimately no longer match live trees.
    historical=(item['record'] or {}).get('state')=='succeeded' and successor and successor!=item['id']
    if historical and value.get('checkpoints',{}).get('commit',{}).get('state')=='result':
        def identity_shape(value):
            return isinstance(value,list) and len(value)==2 and all(type(number) is int and number>=0 for number in value) and value[1]>0
        if (not re.fullmatch('[a-f0-9]{64}',str(value.get('targetDigest','')))
                or not isinstance(value.get('targets'),list) or len(value['targets'])>128
                or set(value.get('rootIdentities',{}))!={'hermes','tavern'}
                or not all(identity_shape(identity) for identity in value['rootIdentities'].values())
                or value.get('checkpoints',{}).get('restore',{}).get('state') in ('intent','result')):
            raise RuntimeError('invalid historical first install')
        seen=set()
        for target in value['targets']:
            namespace,relative=target.get('namespace'),target.get('path')
            allowed=first.FirstInstallJournal.TAVERN if namespace=='tavern' else first.FirstInstallJournal.HERMES if namespace=='hermes' else set()
            if (relative not in allowed or (namespace,relative) in seen or type(target.get('existed')) is not bool
                    or target['existed'] and (not identity_shape(target.get('oldIdentity'))
                        or not re.fullmatch('[a-f0-9]{64}',str(target.get('digest',''))))):
                raise RuntimeError('invalid historical target')
            seen.add((namespace,relative))
        if not {('tavern','tavern-updates/installed.json'),('tavern','tavern-updates/installed-manifest.json')}.issubset(seen):
            raise RuntimeError('historical install receipts missing')
        continue
    if facts['effectState']=='unknown' or (facts['effectState']=='changed' and facts.get('canResume') is not True):
        raise RuntimeError('unconfirmed first install effects: '+str(facts.get('reason','')))
handoff_proof=None
if args['appJobs']:
    replacement=module('nora_uninstall_launcher',args['resources']['replace-launcher.py']['path'])
    replacement.digest=observe_digest(replacement.digest)
    replacement.tree_digest=observe_digest(replacement.tree_digest)
    executable=Path(args['executable']).resolve()
    jobs=sorted(map(Path,args['appJobs']),key=lambda file:file.stat().st_ctime_ns,reverse=True)
    contexts=[]
    for job in jobs:
        context=replacement.context(job)
        if (context['app']/context['executable']).resolve()!=executable:continue
        contexts.append(context)
    required=args.get('requiredHandoffs',[])
    if required and not contexts:raise RuntimeError('launcher successor missing')
    if contexts:
        latest=contexts[0]
        pending=replacement.assess(latest['job'])
        if pending is not None:raise RuntimeError('unconfirmed launcher effects')
        if required:
            # A full current APP check anchors the chain. Committed backups
            # may already be retired; the sealed old/incoming inventories stay.
            if latest['plan'].get('schema')!=2:raise RuntimeError('launcher successor protocol unknown')
            snapshot=replacement.validate_snapshot(latest,full=True)
            verified={str(latest['job'])} if snapshot['phase']=='committed' else set()
            pointer={**snapshot['old'],'version':latest['plan']['previousVersion']}
            def historical_snapshot(ctx):
                plan=ctx['plan'];saved=replacement.read_json(ctx['job']/'recovery.json')
                bound=('token','home','appRoot','executable','platform','arch','version','target','operationId',
                    'ownerEpoch','planDigest','releasePlan','executorProtocol','rollbackCompatibility','parentPid','parentCreationTime')
                resources={'operation_control.py','operation_evidence.py','error_diagnostics.py','operation-budget.json'}
                def valid_identity(value):
                    return isinstance(value,list) and len(value)==2 and all(type(number) is int and number>=0 for number in value) and value[1]>0
                if (plan.get('schema')!=2 or saved.get('schema')!='nora-launcher-recovery/1' or saved.get('phase')!='committed'
                        or any(saved.get(key)!=plan.get(key) for key in bound)
                        or replacement.file_identity(ctx['home'])!=saved.get('homeIdentity')
                        or saved.get('planSeal')!=hashlib.sha256(json.dumps(plan,sort_keys=True,separators=(',',':')).encode()).hexdigest()
                        or saved.get('helperDigest')!=replacement.digest(ctx['job']/'replace.py')
                        or replacement.file_identity(ctx['job']/'replace.py') is None
                        or not isinstance(saved.get('resourceDigests'),dict) or set(saved['resourceDigests'])!=resources
                        or any(replacement.file_identity(ctx['job']/name) is None or saved['resourceDigests'][name]!=replacement.digest(ctx['job']/name) for name in resources)
                        or type(saved.get('workerPid')) is not int or saved['workerPid']<=0
                        or type(saved.get('workerCreationTime')) not in (int,float)
                        or not math.isfinite(saved['workerCreationTime']) or saved['workerCreationTime']<=0
                        or any(not isinstance(saved.get(key),dict) or not valid_identity(saved[key].get('identity'))
                            or not re.fullmatch('[a-f0-9]{64}',str(saved[key].get('digest',''))) for key in ('old','incoming'))
                        or not saved['old'].get('version') or saved['old'].get('version')!=plan.get('previousVersion')):
                    raise RuntimeError('invalid historical launcher seal')
                if replacement.exists(ctx['backup']) and (replacement.file_identity(ctx['backup'])!=saved['old']['identity']
                        or replacement.tree_digest(ctx['backup'],plan['platform'])!=saved['old']['digest']):
                    raise RuntimeError('historical launcher backup changed')
                if replacement.exists(ctx['failed']):raise RuntimeError('historical launcher failed tree remains')
                return saved
            wanted={item['job'] for item in required}
            while not wanted.issubset(verified):
                matches=[]
                for ctx in contexts[1:]:
                    if str(ctx['job']) in verified:continue
                    saved=replacement.read_json(ctx['job']/'recovery.json')
                    if (saved.get('incoming',{}).get('identity')==pointer['identity']
                            and saved.get('incoming',{}).get('digest')==pointer['digest']
                            and ctx['plan'].get('version')==pointer['version']):matches.append(ctx)
                if len(matches)!=1:raise RuntimeError('historical launcher successor chain missing or ambiguous')
                ctx=matches[0];saved=historical_snapshot(ctx);verified.add(str(ctx['job']))
                pointer={**saved['old'],'version':ctx['plan']['previousVersion']}
            for item in required:
                ctx=next((value for value in contexts if str(value['job'])==item['job']),None)
                plan=ctx['plan'] if ctx else {}
                if (str(ctx['home'])!=args['root'] or plan.get('schema')!=2 or plan.get('operationId')!=item['operationId']
                        or type(item.get('ownerEpoch')) is not int or plan.get('ownerEpoch',0)>item['ownerEpoch']
                        or plan.get('planDigest')!=item['planDigest'] or plan.get('target')!=item['target']
                        or plan.get('releasePlan',{}).get('planId')!=item['planId']
                        or plan.get('releasePlan',{}).get('manifestSha256')!=item['manifestSha256']
                        or hashlib.sha256(json.dumps(plan.get('releasePlan'),ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()!=item['releasePlanSha256']
                        or plan.get('releasePlan',{}).get('launcherManifest',{}).get('version')!=plan.get('version')
                        or plan.get('releasePlan',{}).get('launcherManifest',{}).get('sha256')!=plan.get('sha256')
                        or plan.get('releasePlan',{}).get('platform')!=plan.get('platform')
                        or plan.get('releasePlan',{}).get('arch')!=plan.get('arch')):
                    raise RuntimeError('launcher completion belongs to another operation')
                saved=replacement.read_json(ctx['job']/'recovery.json')
                with replacement.job_lock(ctx['job'],readonly=True):pass
                if replacement.parent_alive(saved['workerPid'],saved['workerCreationTime']):raise RuntimeError('launcher replacement worker remains active')
            handoff_proof={'count':len(required),'sha256':hashlib.sha256(json.dumps(required,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
print(json.dumps({'schema':'nora-uninstall-facts/1','safe':True,'system':system_proof,'handoffs':handoff_proof}))
`;

function remove(file) {
  fs.rmSync(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  if (fs.existsSync(file)) throw new Error(`未能删除：${file}`);
}

function cleanup(plan,onProgress=()=>{}) {
  const root=validate(plan),writer=osLock.acquire({directory:contained(root,'installer')});
  try{cleanupLocked(plan,onProgress);}finally{writer.release();}
}

function cleanupLocked(plan, onProgress = () => {}, onRemoved = () => {}) {
  const root = validate(plan);
  if(present(contained(root,'installer/operations/.guards'))){
    try{readOnlyNodeCheck('inspectExecutorHistory',plan);}
    catch(error){throw Object.assign(new Error('尚未确认上次维护进程已结束，未删除文件。',{cause:error}),{code:'OPERATION_EXECUTOR_UNCONFIRMED'});}
  }
  // KEEP must preserve an interrupted transaction's data and recovery chain.
  // ALL deliberately deletes that entire confirmed installation, including
  // its backups: historical proof cannot be a prerequisite for that choice.
  // Current ownership, the held writer and executor-offline checks above still
  // apply to both modes; no path from a historical journal grants deletion.
  if(plan.mode==='keep')assertNoPendingTransaction(root,plan);
  // Resolve every top-level deletion before changing anything. Node rm does not
  // follow links inside a removed tree; redirected deletion roots are rejected.
  const relatives = plan.mode === 'all'
    ? fs.readdirSync(root).filter(name => name !== OWNER && name !== 'installer')
    : [...PROGRAMS.map(name => path.join(plan.hermes, name)),
      path.join(plan.tavern, 'apps'), path.join(plan.tavern, 'tavern-state/native-runtime'),
      'cache', 'launcher'];
  if(plan.mode==='all'){
    const installer=contained(root,'installer');
    for(const name of fs.readdirSync(installer).filter(name=>name!=='operations'))relatives.push(path.join('installer',name));
    const operations=contained(root,'installer/operations');
    for(const name of fs.readdirSync(operations).filter(name=>name!=='.writer.lock'))relatives.push(path.join('installer/operations',name));
  }
  const targets = relatives.map(relative => contained(root, relative));
  if (plan.mode === 'keep') {
    const config = contained(root, path.join(plan.tavern, 'tavern-state/native-runtime/config.yaml'));
    const retainedConfig = contained(root, path.join(plan.tavern, 'tavern-state/nora-retained-config.yaml'));
    if (fs.existsSync(config)) fs.copyFileSync(config, retainedConfig);
    // This receipt enables a subsequent runtime extraction to merge retained data.
    fs.writeFileSync(contained(root, RETAINED), JSON.stringify({ schema: 1, hermes: plan.hermes }), { mode: 0o600 });
  }
  for (let index = 0; index < targets.length; index++) {
    onProgress({ stage: 'cleanup', current: index + 1, total: targets.length, path: targets[index] });
    remove(targets[index]);
    onRemoved(targets[index]);
  }
  // Even all retains only the ownership record and native lock inode.
  // Unlinking the held lock would let a new installer create another owner.
}

function restoreRetained(noraHome, previous, current) {
  const receipt = path.join(noraHome, RETAINED);
  if (!fs.existsSync(receipt)) return false;
  const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (value.schema !== 1 || path.resolve(noraHome, value.hermes) !== path.resolve(current)) throw new Error('保留数据目录不匹配。');
  // Program folders were removed during uninstall. Only retained files are
  // overlaid; never replace fresh runtime binaries with an old backup.
  const excluded = PROGRAMS.map(name => name.split('/').join(path.sep));
  const copy = relative => {
    if (excluded.some(name => relative === name || relative.startsWith(name + path.sep))) return;
    const source = contained(path.resolve(previous), relative);
    const target = contained(path.resolve(current), relative);
    if (fs.statSync(source).isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(source)) copy(path.join(relative, entry));
    } else fs.copyFileSync(source, target);
  };
  for (const entry of fs.readdirSync(previous)) copy(entry);
  return true;
}

async function worker(planFile, showMessage = notify) {
  const directory = path.dirname(planFile);
  const resultFile = path.join(directory, 'result.json');
  let plan,writer,serviceFacts,lifecycle,recordFailure,consentRemoved=false;
  const report = value => fs.writeFileSync(resultFile, JSON.stringify(value), { mode: 0o600 });
  try {
    plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    if (path.resolve(plan.executable) !== path.resolve(process.execPath)) throw new Error('卸载程序与应用不匹配。');
    if (plan.executable.startsWith(path.resolve(plan.root) + path.sep)) throw new Error('启动器不能位于数据目录内。');
    try{if(plan.diagnostics?.enabled===true&&plan.diagnostics.launcherVersion===require('./package.json').version){
      // Preload the existing transport before ALL or APP deletion removes its
      // source resources. The default store is outside the installation root.
      lifecycle=require('./lifecycle-diagnostics').createLifecycleDiagnostics({enabled:true,
          launcherVersion:plan.diagnostics.launcherVersion});
    }}catch{try{await lifecycle?.close();}catch{}lifecycle=null;recordFailure=null;}
    if (process.platform === 'darwin' && plan.appPath) {
      const expected = path.resolve(process.execPath, '../../..');
      if (plan.appPath !== expected || !expected.endsWith('.app') || fs.lstatSync(expected).isSymbolicLink()) throw new Error('应用目录校验失败。');
    }
    if (plan.parentPid) {
      const expected=plan.parentIdentity;
      if(expected?.pid!==plan.parentPid||!Number.isFinite(expected.creationTime)||expected.creationTime<=0
        ||!Number.isFinite(expected.precisionSeconds)||expected.precisionSeconds<0||expected.precisionSeconds>1)
        throw Object.assign(new Error('旧启动器身份记录不完整，未删除文件。'),{code:'UNINSTALL_PARENT_UNCONFIRMED'});
      const deadline = Date.now() + 60000;
      while (true) {
        const actual=processIdentity(plan.parentPid);
        if(!actual||Math.abs(actual.creationTime-expected.creationTime)>Math.max(actual.precisionSeconds,expected.precisionSeconds))break;
        if (Date.now() > deadline) throw new Error('启动器尚未退出，未删除文件。');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    const root=validate(plan);
    writer=osLock.acquire({directory:contained(root,'installer')});
    await inspectExecutorHistory(plan);
    // The GUI released its shutdown owner before this helper took over. A
    // service may have restarted in that gap, so prove offline under our own
    // writer before deleting anything. This proof uses current APP resources,
    // never historical transaction completeness or deletion paths.
    serviceFacts=await require('./uninstall-offline-check').inspect({check:plan.serviceCheck,hermesHome:contained(root,plan.hermes),
      expected:{root,hermesHome:contained(root,plan.hermes),installRoot:contained(root,plan.tavern),port:plan.port,mode:plan.serviceMode,
        executable:process.execPath,entry:__dirname.endsWith('.asar')?__dirname:__filename,resourcesRoot:path.dirname(__dirname)}});
    try{recordFailure=lifecycle?.prepare({home:root,budgetMs:1500});}catch{}
    report({ state: 'running', stage: 'cleanup' });
    cleanupLocked(plan, progress => { report({ state: 'running', ...progress }); process.stdout.write(`清理文件 ${progress.current}/${progress.total}\n`); },removed=>{
      const consent=path.join(root,'installer','telemetry.json');
      if(plan.mode==='all'&&(process.platform==='win32'?removed.toLowerCase()===consent.toLowerCase():removed===consent))consentRemoved=true;
    });
    if (process.platform === 'darwin' && plan.appPath) {
      report({ state: 'running', stage: 'application' });
      remove(plan.appPath);
    }
    report({ state: 'complete', mode: plan.mode, retained: plan.mode === 'keep' ? plan.root : null, serviceVerification:serviceFacts });
    if (process.platform === 'darwin') showMessage(plan.mode === 'keep' ? '卸载完成。用户数据已保留，可在重装后继续使用。' : '卸载完成。本地程序和数据已清理。');
  } catch (error) {
    const result={ state: 'error', code:error.code||'UNINSTALL_FAILED', error: error.message, diagnosticError:localDiagnostic(error) };
    report(result);
    let handle;
    try{
      // A failure before cleanup reads the current choice; only confirmed
      // removal by this worker permits the pre-cleanup snapshot for live send.
      recordFailure ||= lifecycle?.prepare({home:plan.root,budgetMs:1500});
      handle=recordFailure?.('uninstall',error,{consentRemoved});
      if(handle){result.diagnosticDelivery={operationId:handle.operationId,phase:'queued'};report(result);
        result.diagnosticDelivery=await handle.flush();report(result);}
    }catch{result.diagnosticDelivery={phase:'unavailable'};try{report(result);}catch{}}
    finally{try{await handle?.close();}catch{}}
    if (process.platform === 'darwin') showMessage(`卸载未完成。请保留剩余文件并重试。详情：${resultFile}`);
    process.stderr.write(`卸载未完成：${error.message}\n`);
    process.exitCode = 1;
  }finally{try{await lifecycle?.close();}catch{}finally{writer?.release();}}
}

function notify(message) {
  spawnSync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display dialog (item 1 of argv) with title "诺拉·酒馆" buttons {"好"} default button "好"', '-e', 'end run', message], { timeout: 120000 });
}

module.exports = { own, makePlan, cleanup, restoreRetained, worker, RETAINED, PROGRAMS, safeRoot, contained,inspectSealedTransactions,inspectExecutorHistory,prepareHistory };
if (require.main === module) worker(process.argv[2]);
