// This journal owns only the bootstrap directory effects. Operation owns intent
// and references it; the Python system journal owns Tavern deployment effects.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {treeSeal,sameSeal}=require('./tree-integrity');
const SCHEMA='nora-runtime-bootstrap/1';
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,message)=>Object.assign(new Error(message),{code});
const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const PROGRAMS=['hermes-agent','python','node','bin','.local/bin','plugins/clawchat','clawchat/liveware',
  'nora-components.json','nora-clawchat-check.py','gateway.pid','gateway.lock','gateway_state.json'];

function paths({noraHome,hermesHome,operationId}){
  if(!ID.test(operationId||'')||!path.isAbsolute(noraHome||'')||!path.isAbsolute(hermesHome||'')
      ||!equal(path.resolve(hermesHome),path.join(path.resolve(noraHome),'hermes')))
    throw fail('RUNTIME_JOURNAL_INVALID','运行时操作目录无法核验，未修改现有安装。');
  function canonical(file){
    if(fs.existsSync(file))return fs.realpathSync(file);
    const parent=path.dirname(file);return parent===file?file:path.join(canonical(parent),path.basename(file));
  }
  try{if(fs.lstatSync(noraHome).isSymbolicLink())throw fail('RUNTIME_JOURNAL_INVALID','运行时数据目录被链接重定向。');}catch(error){if(error.code!=='ENOENT')throw error;}
  const root=canonical(path.resolve(noraHome)),directory=path.join(root,'installer','operations',operationId,'runtime');
  const value={noraHome:root,hermesHome:path.join(root,'hermes'),directory,stage:path.join(directory,'hermes-runtime'),
    backup:path.join(directory,'previous'),failed:path.join(directory,'failed'),journalReference:path.join(path.dirname(directory),'runtime-bootstrap.json')};
  for(const file of [root,value.hermesHome,directory,value.journalReference]){
    let current=root;
    for(const part of path.relative(root,file).split(path.sep).filter(Boolean)){
      current=path.join(current,part);
      try{if(fs.lstatSync(current).isSymbolicLink())throw fail('RUNTIME_JOURNAL_INVALID','运行时事务目录被链接重定向，未修改现有安装。');}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  return value;
}
function identity(file){
  try{
    const stat=fs.lstatSync(file,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino===0n)throw fail('RUNTIME_IDENTITY_UNKNOWN','无法核验运行时目录身份，请保留现场。');
    return {device:String(stat.dev),inode:String(stat.ino)};
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function sameIdentity(a,b){return Boolean(a&&b&&a.device===b.device&&a.inode===b.inode);}
function write(file,value){
  const temporary=`${file}.${crypto.randomUUID()}.tmp`;let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,file);
    if(process.platform!=='win32'){const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.rmSync(temporary,{force:true});}catch{}}
}
function read(options){
  const location=paths(options);if(!fs.existsSync(location.journalReference))return {location,journal:null};
  const stat=fs.lstatSync(location.journalReference);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw fail('RUNTIME_JOURNAL_INVALID','运行时恢复记录无法核验，请保留现场。');
  const journal=JSON.parse(fs.readFileSync(location.journalReference,'utf8'));
  if(journal.schema!==SCHEMA||journal.operationId!==options.operationId||!journal.target?.sha256||!journal.identities
      ||Object.entries(location).some(([key,value])=>!equal(journal.paths?.[key]||'',value)))
    throw fail('RUNTIME_JOURNAL_INVALID','运行时恢复记录不匹配，未修改现有安装。');
  return {location,journal};
}
function facts(journal,location){
  const live=identity(location.hermesHome),backup=identity(location.backup),failed=identity(location.failed);
  const previous=journal.identities.previous,newTree=journal.identities.next;
  if(journal.status==='committed'){
    let marker;try{marker=JSON.parse(fs.readFileSync(path.join(location.hermesHome,'hermes-agent','.hermes-bootstrap-complete'),'utf8'));}catch{}
    if(sameIdentity(live,newTree)&&marker?.schema===1&&marker.source==='nora-integrated-runtime'
        &&marker.operationId===journal.operationId&&marker.sha256===journal.target.sha256
        &&marker.platform===journal.target.platform&&marker.arch===journal.target.arch)
      return {effectState:'changed',recoveryOutcome:'not-required',canRecover:previous?
        sameIdentity(backup,previous)&&journal.previousSeal?.schema==='nora-runtime-tree-seal/1':!failed,
        hasChanges:true,canResume:true,reason:'committed',backupVerification:previous?'verify-on-recovery':'not-required'};
  }
  if(previous){
    if(sameIdentity(live,previous)&&!backup){
      const needsVerification=Boolean(journal.recoveryStartedAt&&journal.previousRuntimeSpec&&journal.recoveryVerification!=='confirmed');
      return {effectState:journal.recoveryStartedAt?'restored':'untouched',recoveryOutcome:needsVerification?'recovery-required':journal.recoveryStartedAt?'restored':'not-required',
        canRecover:needsVerification,hasChanges:Boolean(journal.recoveryStartedAt),reason:needsVerification?'runtime-verification-required':'previous-present'};
    }
    if(sameIdentity(backup,previous)&&(!live||sameIdentity(live,newTree))
        &&(!failed||sameIdentity(failed,newTree)))
      return {effectState:'changed',recoveryOutcome:'recovery-required',canRecover:true,hasChanges:true,reason:'previous-backup-present'};
  }else if(!live){
    return {effectState:journal.recoveryStartedAt?'restored':'untouched',recoveryOutcome:journal.recoveryStartedAt?'restored':'not-required',
      canRecover:false,hasChanges:Boolean(journal.recoveryStartedAt),reason:'previous-absent'};
  }else if(sameIdentity(live,newTree)&&!failed){
    return {effectState:'changed',recoveryOutcome:'recovery-required',canRecover:true,hasChanges:true,reason:'new-tree-present'};
  }
  return {effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false,hasChanges:null,reason:'directory-identity-unconfirmed'};
}
function inspect(options){
  try{
    const {location,journal}=read(options);
    if(!journal)return {effectState:'untouched',recoveryOutcome:'not-required',canRecover:false,hasChanges:false,reason:'no_journal',journalReference:location.journalReference};
    return {...facts(journal,location),journalReference:location.journalReference};
  }catch(error){return {effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false,hasChanges:null,reason:error.code||'RUNTIME_JOURNAL_INVALID'};}
}
function requireDelegate(delegate,operationId,ownerEpoch){
  delegate?.assertActive();
  if(!delegate||delegate.context?.operationId!==operationId||delegate.context.ownerEpoch!==ownerEpoch)
    throw fail('DELEGATION_REQUIRED','维护操作需要同一事务的有效执行授权。');
}
function update(journal,location,delegate,ownerEpoch,fields){
  requireDelegate(delegate,journal.operationId,ownerEpoch);
  Object.assign(journal,fields,{ownerEpoch,sequence:journal.sequence+1,updatedAt:new Date().toISOString()});
  write(location.journalReference,journal);
}
function report(onEvent,phase,task){onEvent({event:'task',stage_id:'runtime_init',milestone:0,current:2,total:3,phase,task});}
function verifyPrevious(location,target){
  if(!fs.existsSync(location.hermesHome))return;
  if(fs.readdirSync(location.hermesHome).length===0)return;
  let marker,retained;
  try{marker=JSON.parse(fs.readFileSync(path.join(location.hermesHome,'hermes-agent','.hermes-bootstrap-complete'),'utf8'));}catch{}
  if(marker?.schema===1&&marker.source==='nora-integrated-runtime'&&/^[a-f\d]{64}$/.test(marker.sha256||'')
      &&marker.platform===target.platform&&marker.arch===target.arch)return {platform:marker.platform,arch:marker.arch,
        venvPython:marker.platform==='win32'?'hermes-agent/venv/Scripts/python.exe':'hermes-agent/venv/bin/python',
        nodeBin:marker.platform==='win32'?'node':'node/bin',componentProbe:'nora-clawchat-check.py'};
  try{retained=JSON.parse(fs.readFileSync(path.join(location.noraHome,'nora-retained.json'),'utf8'));}catch{}
  if(retained?.schema===1&&equal(path.resolve(location.noraHome,retained.hermes||''),location.hermesHome))return;
  throw fail('RUNTIME_PARTIAL_UNCONFIRMED','上次 Nora 核心安装记录不完整。现有数据已保留，请先恢复上次操作或查看日志；重复安装不会覆盖这些文件。');
}
function copyUserData(previous,stage){
  for(const entry of fs.readdirSync(previous)){
    const source=path.join(previous,entry),target=path.join(stage,entry);
    fs.cpSync(source,target,{recursive:true,dereference:false,filter:(file)=>{
      const relative=path.relative(previous,file);
      return !PROGRAMS.some(value=>relative===value.split('/').join(path.sep)||relative.startsWith(value.split('/').join(path.sep)+path.sep));
    }});
  }
}
async function recover({noraHome,hermesHome,operationId,ownerEpoch,delegate,allowCommitted=false,onEvent=()=>{},tools}){
  requireDelegate(delegate,operationId,ownerEpoch);
  const {location,journal}=read({noraHome,hermesHome,operationId});
  if(!journal)throw fail('RUNTIME_JOURNAL_MISSING','缺少运行时恢复记录，未修改现有安装。');
  let observed=facts(journal,location);
  if(journal.status==='committed'&&!allowCommitted)return {...observed,journalReference:location.journalReference};
  if(observed.effectState==='unknown')throw fail('RUNTIME_IDENTITY_UNKNOWN','运行时目录身份无法核验，未覆盖任何文件。请保留现场并查看日志。');
  if(observed.effectState==='untouched'){
    update(journal,location,delegate,ownerEpoch,{status:'failed'});
    return {...observed,journalReference:location.journalReference};
  }
  if(journal.identities.previous&&!sameIdentity(identity(location.hermesHome),journal.identities.previous)){
    // Verify the whole previous tree before moving a usable current version.
    if(!sameIdentity(identity(location.backup),journal.identities.previous)||!sameSeal(journal.previousSeal,treeSeal(location.backup)))
      throw fail('RUNTIME_BACKUP_CHANGED','旧运行时备份不完整或内容已变化。当前版本和数据已保留，请查看日志；不要反复重试覆盖。');
    await new Promise(setImmediate);requireDelegate(delegate,operationId,ownerEpoch);
  }
  update(journal,location,delegate,ownerEpoch,{status:'recovering',recoveryStartedAt:journal.recoveryStartedAt||new Date().toISOString()});
  if(sameIdentity(identity(location.hermesHome),journal.identities.next)){
    if(identity(location.failed))throw fail('RUNTIME_IDENTITY_UNKNOWN','故障目录已存在，未覆盖保留的现场。');
    update(journal,location,delegate,ownerEpoch,{restoreIntent:'preserve-new-tree'});
    fs.renameSync(location.hermesHome,location.failed);
    update(journal,location,delegate,ownerEpoch,{newTreePreserved:true});
    report(onEvent,'runtime.failed-tree-preserved','保留未完成的 Nora 核心和日志');
  }
  if(journal.identities.previous&&!identity(location.hermesHome)){
    if(!sameIdentity(identity(location.backup),journal.identities.previous))throw fail('RUNTIME_IDENTITY_UNKNOWN','旧运行时备份身份无法核验，未修改保留文件。');
    update(journal,location,delegate,ownerEpoch,{restoreIntent:'restore-previous'});
    fs.renameSync(location.backup,location.hermesHome);
    update(journal,location,delegate,ownerEpoch,{previousRestored:true});
    report(onEvent,'runtime.previous-restored','已恢复原来的 Nora 核心');
  }
  const restored=journal.identities.previous?sameIdentity(identity(location.hermesHome),journal.identities.previous):!identity(location.hermesHome);
  if(!restored)throw fail('RUNTIME_IDENTITY_UNKNOWN','恢复结果尚未确认，请保留现场。');
  if(journal.previousRuntimeSpec){
    report(onEvent,'runtime.verify-previous','检查恢复后的 Nora 核心');
    await (tools||require('./runtime')).validateRuntimeAsync(location.hermesHome,journal.previousRuntimeSpec,delegate);
  }
  update(journal,location,delegate,ownerEpoch,{status:'rolled-back',recoveryVerification:journal.previousRuntimeSpec?'confirmed':'files-restored',recoveryCompletedAt:new Date().toISOString()});
  return {...facts(journal,location),journalReference:location.journalReference};
}
async function install({payloadRoot,noraHome,hermesHome,operationId,ownerEpoch,delegate,onEvent=()=>{},tools}){
  requireDelegate(delegate,operationId,ownerEpoch);
  const runtime=tools||require('./runtime');
  const bundle=runtime.findBundledRuntime(payloadRoot);if(!bundle)return null;
  if(runtime.sha256File(bundle.archive)!==bundle.manifest.sha256)throw fail('VERIFICATION_FAILED','Hermes 运行时校验失败，安装包可能不完整。');
  const location=paths({noraHome,hermesHome,operationId});
  // Use the identity-checked canonical directory consistently for relocation
  // and helpers; an ancestor alias must not become a different runtime scope.
  noraHome=location.noraHome;hermesHome=location.hermesHome;
  let preceding;
  if(fs.existsSync(location.journalReference)){
    const old=read({noraHome,hermesHome,operationId}).journal,observed=facts(old,location);
    const manifestDigest=crypto.createHash('sha256').update(fs.readFileSync(bundle.manifestPath)).digest('hex');
    if(!['untouched','restored'].includes(observed.effectState)||old.target.sha256!==bundle.manifest.sha256||old.target.manifestDigest!==manifestDigest)
      throw fail('RUNTIME_RECOVERY_REQUIRED','上次运行时操作尚未恢复，或此次目标版本不同。现有文件已保留，请先核验上次操作。');
    const archive=path.join(path.dirname(location.directory),'runtime-history',crypto.randomUUID());
    fs.mkdirSync(archive,{recursive:true,mode:0o700});
    write(path.join(archive,'bootstrap-evidence.json'),{schema:'nora-runtime-bootstrap-evidence/1',archivedAt:new Date().toISOString(),journal:old});
    if(fs.existsSync(location.directory))fs.renameSync(location.directory,path.join(archive,'tree'));
    preceding={attempt:(old.attempt||1)+1,evidenceReference:path.join(archive,'bootstrap-evidence.json')};
  }
  const previousRuntimeSpec=verifyPrevious(location,bundle.manifest);
  fs.mkdirSync(location.directory,{recursive:true,mode:0o700});
  const journal={schema:SCHEMA,operationId,ownerEpoch,sequence:0,status:'staging',attempt:preceding?.attempt||1,
    precedingEvidence:preceding?.evidenceReference,createdAt:new Date().toISOString(),
    previousRuntimeSpec,
    paths:location,target:{sha256:bundle.manifest.sha256,platform:bundle.manifest.platform,arch:bundle.manifest.arch,
      manifestDigest:crypto.createHash('sha256').update(fs.readFileSync(bundle.manifestPath)).digest('hex')},
    identities:{previous:identity(hermesHome),next:null}};
  update(journal,location,delegate,ownerEpoch,{});
  let phase='runtime_extract';
  try{
    onEvent({event:'task',stage_id:'runtime_extract',milestone:0,current:1,total:3,task:'释放 Nora 核心'});
    await runtime.extractArchiveAsync(bundle,location.directory,delegate,onEvent);
    runtime.validateRuntimeLinks(location.stage);
    report(onEvent,'runtime.prepare','准备 Nora 核心的配置和技能');
    phase='runtime_initialize_home';
    runtime.initializeHome(location.stage,bundle.manifest);
    phase='runtime_restore_retained';
    if(journal.identities.previous)copyUserData(hermesHome,location.stage);
    runtime.validateRuntimeLinks(location.stage);
    const previousSeal=journal.identities.previous?treeSeal(hermesHome):null;
    await new Promise(setImmediate);requireDelegate(delegate,operationId,ownerEpoch);
    update(journal,location,delegate,ownerEpoch,{status:'prepared',previousSeal,identities:{...journal.identities,next:identity(location.stage)}});
    // Relocation strings name the final directory; executable-specific repair
    // follows the durable switch, because Windows venv launchers embed paths.
    phase='runtime_relocate';runtime.relocateTextFiles(location.stage,bundle.manifest,hermesHome);
    phase='runtime_swap';
    if(journal.identities.previous){
      update(journal,location,delegate,ownerEpoch,{status:'applying',swapIntent:'backup-previous'});
      if(!sameIdentity(identity(hermesHome),journal.identities.previous))throw fail('RUNTIME_IDENTITY_UNKNOWN','现有运行时目录已变化，未覆盖数据。');
      fs.renameSync(hermesHome,location.backup);
      update(journal,location,delegate,ownerEpoch,{previousBackedUp:true});
      report(onEvent,'runtime.previous-backed-up','已保留原来的 Nora 核心');
      if(!sameSeal(previousSeal,treeSeal(location.backup)))throw fail('RUNTIME_BACKUP_CHANGED','原运行时在准备期间发生变化，未激活新版本。');
      await new Promise(setImmediate);requireDelegate(delegate,operationId,ownerEpoch);
    }
    update(journal,location,delegate,ownerEpoch,{status:'applying',swapIntent:'activate-next'});
    if(identity(hermesHome)||!sameIdentity(identity(location.stage),journal.identities.next))throw fail('RUNTIME_IDENTITY_UNKNOWN','新运行时目录身份无法核验，未覆盖保留文件。');
    fs.renameSync(location.stage,hermesHome);
    update(journal,location,delegate,ownerEpoch,{nextActivated:true,status:'verifying'});
    report(onEvent,'runtime.next-activated','初始化 Nora：迁移运行环境');
    phase='runtime_relocate';
    await runtime.repairRuntimeAsync(hermesHome,bundle.manifest,delegate);
    onEvent({event:'task',stage_id:'runtime_verify',milestone:0,current:3,total:3,task:'检查 Nora'});
    phase='runtime_verify';
    const version=await runtime.validateRuntimeAsync(hermesHome,bundle.manifest,delegate);
    requireDelegate(delegate,operationId,ownerEpoch);
    phase='runtime_commit';
    write(path.join(hermesHome,'hermes-agent','.hermes-bootstrap-complete'),{schema:1,source:'nora-integrated-runtime',
      operationId,platform:bundle.manifest.platform,arch:bundle.manifest.arch,version,sha256:bundle.manifest.sha256,installedAt:new Date().toISOString()});
    update(journal,location,delegate,ownerEpoch,{status:'committed',committedAt:new Date().toISOString(),version});
    return {...bundle.manifest,version,journalReference:location.journalReference};
  }catch(error){
    error.context={...(error.context||{}),phase};
    if(delegate.active){
      try{
        update(journal,location,delegate,ownerEpoch,{primaryFailure:journal.primaryFailure||{name:error.name,code:error.code,message:error.message,stack:error.stack},status:'failed'});
        await recover({noraHome,hermesHome,operationId,ownerEpoch,delegate,onEvent,tools:runtime});
      }catch(recoveryError){error.secondaryErrors=[...(error.secondaryErrors||[]),{operation:'runtime-recovery',error:recoveryError}];}
    }
    throw error;
  }
}
module.exports={install,inspect,recover};
