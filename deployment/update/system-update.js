// Supported schema-1 recovery only. New updates use the Python file journal.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {treeSeal,sameSeal}=require('./tree-integrity');
const fsp=fs.promises,NAMES=['hermes','tavern'];
const fail=(code,message)=>Object.assign(new Error(message),{code});
const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const RECOVERY_POINT='恢复更新前备份；较新的数据保留在故障目录，不会自动合并。';
function canonical(file){if(fs.existsSync(file))return fs.realpathSync(file);const parent=path.dirname(file);return parent===file?file:path.join(canonical(parent),path.basename(file));}
function safePath(root,relative){
 const target=path.resolve(root,relative);
 if(target!==root&&!target.startsWith(root+path.sep))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新路径越过安装目录，已保留现场。');
 let current=root;
 for(const part of path.relative(root,target).split(path.sep).filter(Boolean)){
  current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新目录被链接重定向，已保留现场。');}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return target;
}
function locations(home){
 if(!path.isAbsolute(home||''))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新安装目录无效。');
 if(fs.lstatSync(home).isSymbolicLink())throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新安装目录被链接重定向。');
 const root=canonical(home),directory=safePath(root,'installer/system-update');
 for(const name of NAMES)safePath(root,name);
 return {root,directory,journal:safePath(root,'installer/system-update/journal.json')};
}
function object(file){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新记录无法核验，已保留现场。');
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
function read(home){
 if(path.isAbsolute(home||'')){try{fs.lstatSync(home);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 const location=locations(home);if(!fs.existsSync(location.journal))return null;
 const value=object(location.journal);
 if(value.schema!==1||!['snapshot','applying','restoring','committed','rolled-back'].includes(value.phase))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新格式不受支持，请保留数据并重新安装新版启动器。');
 return value;
}
function identity(file){
 let stat;try{stat=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino<=0n)throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新目录身份无法核验，已保留现场。');
 return {dev:String(stat.dev),ino:String(stat.ino)};
}
function validIdentity(value){return value&&Object.entries(value).length===2&&['dev','ino'].every(key=>
 typeof value[key]==='string'?/^\d+$/.test(value[key]):Number.isSafeInteger(value[key])&&value[key]>=0)&&String(value.ino)!=='0';}
function same(left,right){return Boolean(left&&validIdentity(right)&&left.dev===String(right.dev)&&left.ino===String(right.ino));}
function phase(location,item){
 const backup=identity(path.join(location.directory,item.name)),current=identity(path.join(location.root,item.name));
 const failed=identity(path.join(location.directory,item.failedName));
 if(same(current,item.backupIdentity)&&!backup)return 'restored';
 if(!same(backup,item.backupIdentity))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新备份身份已变化，未替换当前安装。');
 if(!current&&(!item.currentIdentity||same(failed,item.currentIdentity)))return 'preserved';
 if(same(current,item.currentIdentity)&&!failed)return 'prepared';
 throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新现场与恢复记录不一致，未替换当前安装。');
}
function verifyOwner(location,sources){
 const owner=object(safePath(location.root,'nora-owner.json'));
 if(owner.schema!==1||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(owner.id||''))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新缺少安装目录归属记录。');
 const instance=object(safePath(sources.hermes,'nora-instance.json'));
 if(instance.schema!==1||[['noraHome',location.root],['hermesHome',path.join(location.root,'hermes')],['installRoot',path.join(location.root,'tavern')]].some(([field,expected])=>
  !path.isAbsolute(instance[field]||'')||!equal(canonical(instance[field]),expected)))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧备份属于其他安装实例，未修改现有安装。');
 const receipt=object(safePath(sources.tavern,'tavern-updates/installed.json'));
 const manifest=object(safePath(sources.tavern,'tavern-updates/installed-manifest.json'));
 const marker=object(safePath(sources.hermes,'hermes-agent/.hermes-bootstrap-complete'));
 if(receipt.schema!==1||manifest.schema!=='tavern-release/v2'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(receipt.version||'')
  ||!/^[a-f0-9]{40}$/.test(receipt.commit||'')||receipt.commit!==manifest.commit||receipt.version!==manifest.versions?.tavern
  ||marker.schema!==1||marker.source!=='nora-integrated-runtime'||!/^[a-f0-9]{64}$/.test(marker.sha256||'')
  ||marker.sha256!==manifest.hermesRuntime?.sha256||manifest.hermesRuntime.platform!==process.platform||manifest.hermesRuntime.arch!==process.arch
  ||receipt.hermesRuntime?.sha256!==marker.sha256||marker.platform!==process.platform||marker.arch!==process.arch
  ||!Number.isInteger(instance.port)||instance.port<1||instance.port>65535)throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧备份的程序版本或完整安装记录无法核验。请保留数据并重新安装新版启动器。');
 return {owner:owner.id,restoreVersion:receipt.version,restoreCommit:receipt.commit,port:instance.port};
}
function assess(home){
 const state=read(home);if(!state||state.phase==='committed')return null;
 const location=locations(home);
 let steps=state.restoreSteps;
 if(steps){
  if(!Array.isArray(steps)||steps.length!==2||steps.some((item,index)=>item.name!==NAMES[index]
   ||!new RegExp(`^failed-${item.name}-[a-f0-9-]{36}$`).test(item.failedName||'')||!validIdentity(item.backupIdentity)
   ||item.currentIdentity!==null&&!validIdentity(item.currentIdentity)||!['prepared','preserved','restored'].includes(item.phase)))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新恢复检查点不完整，已保留现场。');
 }else steps=NAMES.map(name=>{const saved=identity(path.join(location.directory,name));if(!saved)throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新备份不完整，已保留现场。');return {name,backupIdentity:saved,currentIdentity:identity(path.join(location.root,name)),failedName:`failed-${name}-${crypto.randomUUID()}`,phase:'prepared'};});
 const phases=steps.map(item=>phase(location,item));
 const sources=Object.fromEntries(steps.map((item,index)=>[item.name,path.join(phases[index]==='restored'?location.root:location.directory,item.name)]));
 const ownership=verifyOwner(location,sources);
 if(state.sourceJournalDigest!==undefined&&!/^[a-f0-9]{64}$/.test(state.sourceJournalDigest))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新恢复摘要不完整，已保留现场。');
 if(state.adapterOwner&&state.adapterOwner!==ownership.owner)throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧更新归属记录已变化，已保留现场。');
 const digest=hash(fs.readFileSync(location.journal));
 return {location,state,steps,phases,ownership,journalDigest:state.sourceJournalDigest||digest,currentJournalDigest:digest};
}
function pending(home){const state=read(home);return Boolean(state&&!['committed','rolled-back'].includes(state.phase));}
function inspect(home){
 try{
  const value=assess(home);if(!value||value.state.phase==='rolled-back')return null;
  return {kind:'legacy',status:value.state.phase,canRecover:true,journalReference:value.location.journal,
   journalDigest:value.journalDigest,currentJournalDigest:value.currentJournalDigest,restoreVersion:value.ownership.restoreVersion,
   restoreCommit:value.ownership.restoreCommit,restorePoint:value.state.snapshotAt||value.state.createdAt||null,
   backup:value.location.directory,dataPolicy:'restore-backup-preserve-current',backupVerification:'verify-on-recovery',
   reason:RECOVERY_POINT};
 }catch(error){return {kind:'legacy',status:'unknown',canRecover:false,reason:error.code==='ENOENT'?'旧备份或安装记录不完整，请保留当前安装、数据和日志。':error.message};}
}
async function save(location,value){
 const temporary=`${location.journal}.${crypto.randomUUID()}.tmp`,fd=await fsp.open(temporary,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}
 try{await fsp.rename(temporary,location.journal);if(process.platform!=='win32'){const directory=await fsp.open(location.directory,'r');try{await directory.sync();}finally{await directory.close();}}}
 finally{await fsp.rm(temporary,{force:true});}
}
async function recover(home,{delegate,journalDigest,offlineProof,onEvent=()=>{}}={}){
 delegate?.assertActive();
 if(!delegate?.active)throw fail('OPERATION_CAPABILITY_REQUIRED','旧版本恢复缺少有效执行授权。');
 if(offlineProof?.operationId!==delegate.context.operationId||offlineProof.ownerEpoch!==delegate.context.ownerEpoch
  ||offlineProof.offline!==true||offlineProof.running!==false||offlineProof.gatewayRunning!==false)
  throw fail('VERIFICATION_FAILED','尚未确认服务停止，未恢复旧版本文件。');
 const value=assess(home);if(!value)throw fail('LEGACY_RECOVERY_UNSUPPORTED','没有可核验的旧版本恢复记录。');
 if(!/^[a-f0-9]{64}$/.test(journalDigest||'')||journalDigest!==value.journalDigest)throw fail('CONDITIONS_CHANGED','旧更新记录已变化，请重新检查恢复条件。');
 const {location,ownership}=value;let state=value.state;
 const steps=value.steps.map((item,index)=>({...item,phase:value.phases[index]}));
 // Integrity is checked before preserving either active tree. No chat/config
 // content is stored in this journal; only the full-tree digest is persisted.
 for(const item of steps){
  const source=path.join(item.phase==='restored'?location.root:location.directory,item.name),seal=treeSeal(source);
  if(item.backupSeal&&!sameSeal(item.backupSeal,seal))throw fail('LEGACY_RECOVERY_UNSUPPORTED','旧备份内容已变化，未替换当前安装。');
  item.backupSeal=seal;delegate.assertActive();await new Promise(setImmediate);
 }
 state={...state,phase:'restoring',sourceJournalDigest:value.journalDigest,adapterOwner:ownership.owner,restoreSteps:steps};
 await save(location,state);delegate.assertActive();
 for(const item of steps){
  item.phase=phase(location,item);if(item.phase==='restored')continue;
  if(item.phase==='prepared'&&item.currentIdentity){
   await fsp.rename(path.join(location.root,item.name),path.join(location.directory,item.failedName));
   item.phase='preserved';await save(location,state);delegate.assertActive();
   onEvent({event:'task',phase:`legacy.${item.name}-preserved`,task:'保留当前版本和较新的数据'});
  }
  await fsp.rename(path.join(location.directory,item.name),path.join(location.root,item.name));
  item.phase='restored';await save(location,state);delegate.assertActive();
  onEvent({event:'task',phase:`legacy.${item.name}-restored`,task:'恢复更新前的备份文件'});
 }
 // Actual service/content acceptance belongs to the subsequent Python check.
 await save(location,{...state,phase:'rolled-back',filesRestoredAt:new Date().toISOString()});
 return {legacyFilesRestored:true,effectState:'restored',recoveryVerification:'files-only',dataMerged:false,
  restoreVersion:ownership.restoreVersion,restoreCommit:ownership.restoreCommit,port:ownership.port,
  journalReference:location.journal,preservedDirectories:steps.filter(item=>item.currentIdentity).map(item=>path.join(location.directory,item.failedName)),
  restorePoint:state.snapshotAt||state.createdAt||null,dataPolicy:'restore-backup-preserve-current',reason:RECOVERY_POINT};
}
module.exports={pending,inspect,recover};
