// A KEEP receipt describes removed programs and retained data, never readiness.
// Finished journals are kept as immutable history outside the active reader set.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const fileName='nora-retained.json';
const completionWarning='安装已完成，保留数据卸载记录的收尾尚未完成。现有程序和数据已保留；请检查目录权限及磁盘空间后重新操作。';
const archiveIo=new Set(['EACCES','EPERM','ENOSPC','EDQUOT','EBUSY','EIO','EROFS']);
const error=(code='RETAINED_INSTALLATION_UNCONFIRMED')=>Object.assign(new Error(code==='RETAINED_UNINSTALL_INCOMPLETE'
 ?'保留数据卸载尚未完成。请在“更多→卸载”继续保留数据卸载，现有数据和记录已保留。'
 :'保留数据卸载记录或目录归属无法核验。现有数据和记录已保留，请查看日志。'),{code});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const present=file=>{try{fs.lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const identity=file=>{const stat=fs.lstatSync(file,{bigint:true});if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw error();
 return {device:String(stat.dev),inode:String(stat.ino),kind:stat.isDirectory()?'directory':'file'};};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function rootOf(home){return require('./uninstall').safeRoot(home);}
function safe(root,relative){if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).some(v=>!v||v==='.'||v==='..'))throw error();
 const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep))throw error();let current=root;
 for(const part of path.relative(root,file).split(path.sep)){current=path.join(current,part);if(present(current)&&fs.lstatSync(current).isSymbolicLink())throw error();}return file;}
function readBytes(file){const before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.size>2n*1024n*1024n)throw error();
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{const opened=fs.fstatSync(fd,{bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw error();
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  const after=fs.lstatSync(file,{bigint:true});if(after.isSymbolicLink()||length!==Number(before.size)
   ||['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]))throw error();return bytes.subarray(0,length);
 }finally{fs.closeSync(fd);}}
function readObject(file){return JSON.parse(readBytes(file).toString('utf8'));}
function owner(root){const value=readObject(safe(root,'nora-owner.json'));if(value.schema!==1||typeof value.id!=='string'||!value.id)throw error();return value.id;}
function atomic(file,value){const bytes=JSON.stringify(value)+'\n';if(Buffer.byteLength(bytes)>2*1024*1024)throw error();
 const temporary=file+'.'+crypto.randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);
  if(process.platform!=='win32'){const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}}
function programs(root,hermes='hermes',tavern='tavern'){
 return [...require('./uninstall').PROGRAMS.map(name=>path.posix.join(hermes,name)),path.posix.join(tavern,'apps'),path.posix.join(tavern,'tavern-state/native-runtime')];
}
function absentPrograms(root,value){return programs(root,value.hermes,value.tavern).every(relative=>!present(safe(root,relative)));}
function metadataSeal(file){
 if(identity(file).kind==='file'){if(fs.statSync(file).size>64*1024*1024)throw error();return {'':hash(fs.readFileSync(file))};}
 const files={};function visit(directory,relative='',depth=0){
  for(const name of fs.readdirSync(directory).sort()){
   const target=path.join(directory,name),stat=fs.lstatSync(target),member=relative?relative+'/'+name:name;
   if(stat.isFile()&&/^(?:operation|runtime-bootstrap|transaction|partial-history|journal|installed|installed-manifest|nora-system|metadata|session|owner|snapshot)\.json$/.test(name)){
    if(stat.size>64*1024*1024)throw error();files[member]=hash(fs.readFileSync(target));
   }else if(stat.isDirectory()&&!stat.isSymbolicLink()&&depth<2&&!['previous','failed','runtime','attempts','targets','backups','evidence'].includes(name))visit(target,member,depth+1);
  }
 }visit(file);return files;
}
function verifyEntry(root,entry,completed=false,verifyRecreated){
 const from=safe(root,entry.from),to=safe(root,entry.to),atSource=present(from),atArchive=present(to);
 if(completed){
  // Completion seals the old archive, not permanent absence of a path that a
  // later first install must recreate. Nothing may replace the sealed archive.
  if(!atArchive||!same(identity(to),entry.identity)||!same(metadataSeal(to),entry.metadata))throw error();
  if(atSource){if(!verifyRecreated)throw error();verifyRecreated(entry.from,from);}
 }else{
  if(atSource===atArchive)throw error();const file=atSource?from:to;
  if(!same(identity(file),entry.identity)||!same(metadataSeal(file),entry.metadata))throw error();
 }
 return {from,to,atSource};
}
function recreatedReceipt(value,record,relative,file){
 if(!record||!['installed.json','installed-manifest.json','nora-system.json'].map(name=>'tavern/tavern-updates/'+name).includes(relative)
  ||value.state!=='complete'||record.planSelected!==true||record.planDigest!==hash(JSON.stringify(record.target))
  ||record.target?.releasePlan?.mode!=='install')throw error();
 const root=value.root,operationId=value.reinstallOperationId;
 // Python journals encode NTFS identities as JSON integers. Preserve the exact
 // integer text beyond JS's safe range instead of authorizing a rounded inode.
 const first=JSON.parse(readBytes(safe(root,`installer/operations/${operationId}/first-install/transaction.json`)).toString('utf8'),
  (_key,number,context)=>typeof number==='number'&&Number.isInteger(number)&&!Number.isSafeInteger(number)?context.source:number);
 const matches=(target,expected)=>{
  const observed=identity(target);
  return Array.isArray(expected)&&expected.length===2&&expected.every(part=>/^[0-9]+$/.test(String(part)))
   &&observed.device===String(expected[0])&&observed.inode===String(expected[1]);
 };
 if(first.schema!==1||first.owner!=='nora-first-install'||first.operationId!==operationId||first.noraHome!==root
  ||first.roots?.hermes!==path.join(root,value.hermes)||first.roots?.tavern!==path.join(root,value.tavern)
  ||!matches(safe(root,value.hermes),first.rootIdentities?.hermes)||!matches(safe(root,value.tavern),first.rootIdentities?.tavern)
  ||!SHA.test(first.targetDigest||'')||first.applyIntent!==true||!['applying','installed','recovery_failed'].includes(first.status)
  ||!Array.isArray(first.targets)||first.targets.length>2048)throw error();
 const seen=new Set();let selected;
 for(const target of first.targets){
  if(!['hermes','tavern'].includes(target.namespace))throw error();const name=target.namespace+'/'+target.path;safe(root,name);
  if(seen.has(name))throw error();seen.add(name);if(name===relative)selected=target;
 }
 if(!selected||!SHA.test(selected.newDigest||'')||identity(file).kind!=='file')throw error();
 // Atomic setup writes may replace nora-system after success. The terminal
 // completionFacts call below validates its current semantics and immutable
 // install receipts; in-flight files still need exact journal identity/bytes.
 if(relative==='tavern/tavern-updates/nora-system.json'&&record.state==='succeeded')return;
 if(!matches(file,selected.newIdentity)||hash(Buffer.concat([Buffer.from('F\0'),readBytes(file)]))!==selected.newDigest)throw error();
}
function inspect(home,{allowPending=false,operationId,allowProgramTree=false}={}){
 const file=path.join(path.resolve(home),fileName);if(!present(file))return null;
 try{const root=rootOf(home),value=readObject(file),owned=owner(root);
  if(value.schema===1){
   if(Object.keys(value).sort().join(',')!=='hermes,schema'||value.hermes!=='hermes'||!absentPrograms(root,{hermes:'hermes',tavern:'tavern'}))throw error();
   return {schema:1,root,owner:owned,hermes:'hermes',tavern:'tavern',state:'complete',legacy:true};
  }
  if(value.schema!==2||!ID.test(value.id||'')||value.root!==root||value.owner!==owned||value.hermes!=='hermes'||value.tavern!=='tavern'
   ||!['prepared','complete'].includes(value.state)||!Number.isInteger(value.port)||value.port<1024||value.port>65535
   ||value.archive!==`installer/retained/${value.id}`||!Array.isArray(value.entries)||value.entries.length>2048
   ||!Array.isArray(value.targets)||value.targets.length!==programs(root).length+2||!Number.isFinite(Date.parse(value.createdAt)))throw error();
  let reinstall;
  if(value.reinstallOperationId!==undefined){if(!ID.test(value.reinstallOperationId))throw error();reinstall=installRecord(root,value.reinstallOperationId);}
  const verifyRecreated=(relative,source)=>recreatedReceipt(value,reinstall,relative,source);
  const seen=new Set();for(const entry of value.entries){if(seen.has(entry.from)
    ||!['installed.json','installed-manifest.json','nora-system.json','transaction.json'].map(name=>'tavern/tavern-updates/'+name)
      .concat(['installer/system-update','installer/launcher-update']).includes(entry.from)&&!/^installer\/operations\/[0-9a-f-]{36}$/i.test(entry.from)
    ||entry.from.startsWith('installer/operations/')&&!ID.test(entry.from.slice('installer/operations/'.length))
    ||entry.to!==value.archive+'/history/'+entry.from)throw error();seen.add(entry.from);verifyEntry(root,entry,value.state==='complete',verifyRecreated);}
  const targetNames=new Set();for(const target of value.targets){if(targetNames.has(target.path)||!programs(root).concat(['cache','launcher']).includes(target.path))throw error();targetNames.add(target.path);safe(root,target.path);
   if(value.state==='prepared'&&!['cache','launcher'].includes(target.path)&&present(safe(root,target.path))&&!same(identity(safe(root,target.path)),target.identity))throw error();}
  if(value.state==='complete'){
   const completed=readObject(safe(root,value.archive+'/keep-receipt.json')),base={...value};delete base.reinstallOperationId;
   if(!same(completed,base))throw error();
   if(value.reinstallOperationId===undefined&&['installed.json','installed-manifest.json','nora-system.json','transaction.json']
    .some(name=>present(safe(root,'tavern/tavern-updates/'+name))))throw error();
  }
  if(value.reinstallOperationId!==undefined){
   const record=reinstall;
   if(record.state==='succeeded'){
    completionFacts(value,record);
    // Derived from the actual terminal install and its physical owners. This
    // read never consumes the receipt and does not assert current service health.
    return {...value,reinstalled:true,cleanupPending:true,warning:completionWarning};
   }
   if(operationId!==value.reinstallOperationId)throw error();
  }else if(value.state==='complete'&&!allowProgramTree&&!absentPrograms(root,value))throw error();
  if(value.state==='prepared'&&!allowPending)throw error('RETAINED_UNINSTALL_INCOMPLETE');
  return value;
 }catch(cause){if(cause.code?.startsWith('RETAINED_'))throw cause;throw Object.assign(error(),{cause});}
}
function begin(plan,{excludeOperationId}={}){
 const root=rootOf(plan.root),prior=inspect(root,{allowPending:true});if(prior?.state==='prepared')return prior;
 const value={schema:2,id:crypto.randomUUID(),root,owner:owner(root),hermes:plan.hermes,tavern:plan.tavern,port:plan.port||8799,
  state:'prepared',createdAt:new Date().toISOString(),entries:[],targets:[]};
 if(value.hermes!=='hermes'||value.tavern!=='tavern')throw error();value.archive=`installer/retained/${value.id}`;
 const base=safe(root,value.archive);fs.mkdirSync(base,{recursive:true,mode:0o700});
 if(prior)fs.copyFileSync(safe(root,fileName),path.join(base,'previous-retained.json'));
 const sources=['installed.json','installed-manifest.json','nora-system.json','transaction.json'].map(name=>path.posix.join(value.tavern,'tavern-updates',name));
 sources.push('installer/system-update','installer/launcher-update');
 // Guard ledgers and generation files continue to prove native executor lifetime.
 // Only operation IDs consumed by the business-history reader are retired; unknown
 // user backup/evidence directories retain their existing locations.
 const operations=safe(root,'installer/operations');if(present(operations))for(const name of fs.readdirSync(operations).filter(name=>ID.test(name)&&name!==excludeOperationId))sources.push('installer/operations/'+name);
 for(const relative of sources){const from=safe(root,relative);if(!present(from))continue;value.entries.push({from:relative,to:value.archive+'/history/'+relative,identity:identity(from),metadata:metadataSeal(from)});}
 for(const relative of programs(root).concat(['cache','launcher'])){const file=safe(root,relative);value.targets.push({path:relative,identity:present(file)?identity(file):null});}
 atomic(safe(root,fileName),value);return value;
}
function archive(plan,value){const root=rootOf(plan.root);if(value.owner!==owner(root)||value.root!==root)throw error();
 const changedHistory=value.entries.some(entry=>entry.from.startsWith('installer/operations/'));
 // Publish through the existing reader generation protocol. An interrupted
 // rename leaves writing:true so readers rescan rather than retaining old IDs.
 const generation=safe(root,'installer/operations/.history-generation.json');
 if(changedHistory)atomic(generation,{schema:1,id:crypto.randomUUID(),writing:true});
 for(const entry of value.entries){const observed=verifyEntry(root,entry);if(observed.atSource){fs.mkdirSync(path.dirname(observed.to),{recursive:true,mode:0o700});fs.renameSync(observed.from,observed.to);}verifyEntry(root,entry,true);}
 if(changedHistory)atomic(generation,{schema:1,id:crypto.randomUUID(),writing:false});
}
function complete(plan,value){const root=rootOf(plan.root);archive(plan,value);if(!absentPrograms(root,value))throw error();
 value={...value,state:'complete',completedAt:new Date().toISOString()};atomic(safe(root,value.archive+'/keep-receipt.json'),value);atomic(safe(root,fileName),value);return value;
}
function installRecord(root,operationId){if(!ID.test(operationId||''))throw error();
 try{const record=readObject(safe(root,`installer/operations/${operationId}/operation.json`));
  if(record.schema!=='nora-operation/1'||record.operationId!==operationId||record.kind!=='install')throw error();return record;
 }catch(cause){if(cause.code?.startsWith('RETAINED_'))throw cause;throw error();}
}
function completionFacts(value,record,{result=record.result,terminal=true}={}){
 try{
  const root=value.root,operationId=value.reinstallOperationId,hermes=path.join(root,value.hermes),tavern=path.join(root,value.tavern);
  if(value.state!=='complete'||record.operationId!==operationId||record.effectState!=='changed'
    ||terminal&&(record.state!=='succeeded'||record.verification!=='confirmed'||record.currentFailure
      ||['recovery-required','files-restored-start-failed'].includes(record.recoveryOutcome))
    ||!terminal&&!['verifying','committing','succeeded'].includes(record.state)
    ||record.planDigest!==hash(JSON.stringify(record.target))||record.planSelected!==true
    ||!result||result.systemReady!==true||result.noraHome!==root||result.hermesHome!==hermes||result.installRoot!==tavern||result.port!==value.port)throw error();
  const first=readObject(safe(root,`installer/operations/${operationId}/first-install/transaction.json`));
  if(first.schema!==1||first.owner!=='nora-first-install'||first.operationId!==operationId||first.noraHome!==root
    ||first.roots?.hermes!==hermes||first.roots?.tavern!==tavern||first.status!=='installed'||!SHA.test(first.targetDigest||'')
    ||first.checkpoints?.commit?.state!=='result'||first.checkpoints?.apply?.state!=='result'||first.unrestored?.length
    ||first.checkpoints?.restore?.state||!Array.isArray(first.targets)||first.targets.length>2048)throw error();
  const targets=new Map();for(const target of first.targets){
   if(!['hermes','tavern'].includes(target.namespace))throw error();const relative=target.namespace+'/'+target.path;safe(root,relative);
   if(targets.has(relative))throw error();targets.set(relative,target);
  }
  const metadata={};
  for(const relative of ['hermes/nora-instance.json','tavern/tavern-updates/installed.json','tavern/tavern-updates/installed-manifest.json']){
   const file=safe(root,relative),target=targets.get(relative),bytes=readBytes(file);
   if(!target||!SHA.test(target.newDigest||'')||hash(Buffer.concat([Buffer.from('F\0'),bytes]))!==target.newDigest)throw error();
   metadata[relative]=JSON.parse(bytes.toString('utf8'));
  }
  const instance=metadata['hermes/nora-instance.json'],installed=metadata['tavern/tavern-updates/installed.json'],manifest=metadata['tavern/tavern-updates/installed-manifest.json'];
  const system=readObject(safe(root,'tavern/tavern-updates/nora-system.json')),plan=record.target.releasePlan;
  if(instance.schema!==1||instance.noraHome!==root||instance.hermesHome!==hermes||instance.installRoot!==tavern||instance.port!==value.port
    ||installed.schema!==1||installed.mode!=='first-install'||installed.manifestDigest!==first.targetDigest
    ||manifest.schema!=='tavern-release/v2'||!/^[a-f0-9]{40}$/.test(manifest.commit||'')||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/.test(manifest.versions?.tavern||'')
    ||installed.commit!==manifest.commit||installed.version!==manifest.versions.tavern||installed.sourceDigest!==manifest.sourceDigest
    ||!same(installed.components,manifest.versions)||!same(installed.hermesRuntime,manifest.hermesRuntime)
    ||result.version!==installed.version||result.commit!==installed.commit||!plan||plan.mode!=='install'||plan.commit!==installed.commit||plan.tag!=='v'+installed.version
    ||system.schema!==1||system.version!==installed.version||system.commit!==installed.commit
    ||!targets.has('tavern/tavern-updates/nora-system.json')
    ||['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'].some(key=>system.proof?.[key]!==true))throw error();
  // setupCompleted and normal runtime observations can legitimately change.
  // The immutable install receipts stay bound to their first-install digests.
  for(const name of ['native-runtime.json','native_lifecycle.py'])if(identity(safe(root,'tavern/apps/tavern-runtime/'+name)).kind!=='file')throw error();
  if(require('./runtime-transaction').inspect({noraHome:root,hermesHome:hermes,operationId}).canResume!==true)throw error();
 }catch(cause){if(cause.code?.startsWith('RETAINED_'))throw cause;throw Object.assign(error(),{cause});}
}
function claim(home,operationId){let value=inspect(home,{operationId});if(!value)return null;if(value.legacy)throw error('RETAINED_UNINSTALL_INCOMPLETE');
 const record=installRecord(value.root,operationId);if(!['created','selecting','prepared','applying','verifying','recovering'].includes(record.state))throw error();
 if(value.reinstallOperationId!==undefined){if(value.reinstallOperationId!==operationId)throw error();return value;}
 value={...value,reinstallOperationId:operationId};atomic(safe(value.root,fileName),value);return value;
}
function legacyHistory(root,operationId){
 const operations=safe(root,'installer/operations'),records=new Map(),runtimes=[];
 for(const name of present(operations)?fs.readdirSync(operations):[]){
  if(!ID.test(name)){const directory=safe(root,'installer/operations/'+name);if(identity(directory).kind==='directory'
    &&['runtime-bootstrap.json','first-install/transaction.json'].some(relative=>present(path.join(directory,relative))))throw error();continue;}
  if(name===operationId)continue;
  const record=readObject(safe(root,`installer/operations/${name}/operation.json`));
  if(record.schema!=='nora-operation/1'||record.operationId!==name||!['succeeded','failed','cancelled','rolled-back','blocked'].includes(record.state)
   ||['recovery-required','files-restored-start-failed'].includes(record.recoveryOutcome)
   ||!['untouched','changed','restored'].includes(record.effectState)||record.state==='succeeded'&&record.verification!=='confirmed')throw error();
  records.set(name,record);
  const runtimeFile=safe(root,`installer/operations/${name}/runtime-bootstrap.json`),firstFile=safe(root,`installer/operations/${name}/first-install/transaction.json`);
  if(present(runtimeFile)){
   const journal=readObject(runtimeFile),expected=require('./runtime-transaction').paths({noraHome:root,hermesHome:path.join(root,'hermes'),operationId:name});
   if(journal.schema!=='nora-runtime-bootstrap/1'||journal.operationId!==name||!['committed','rolled-back'].includes(journal.status)
     ||Object.entries(expected).some(([key,file])=>journal.paths?.[key]!==file)||!SHA.test(journal.target?.sha256||'')
     ||journal.status==='committed'&&(record.state!=='succeeded'||record.verification!=='confirmed')
     ||journal.status==='rolled-back'&&(record.verification!=='confirmed'||!['confirmed','files-restored','retained-data-confirmed'].includes(journal.recoveryVerification)))throw error();
   runtimes.push(journal);
  }
  if(present(firstFile)){
   const first=readObject(firstFile);
   if(first.schema!==1||first.owner!=='nora-first-install'||first.operationId!==name||first.noraHome!==root
     ||first.roots?.hermes!==path.join(root,'hermes')||first.roots?.tavern!==path.join(root,'tavern')
     ||!['installed','restored'].includes(first.status)||!Array.isArray(first.targets)||first.unrestored?.length
     ||first.status==='installed'&&(record.state!=='succeeded'||record.verification!=='confirmed'||!SHA.test(first.targetDigest||''))
     ||first.status==='restored'&&first.checkpoints?.restore?.state!=='result')throw error();
   for(const target of first.targets){if(!['hermes','tavern'].includes(target.namespace))throw error();safe(root,target.namespace+'/'+target.path);}
  }
  if(!present(runtimeFile)&&!present(firstFile)&&['install','update','repair','recover'].includes(record.kind)
    &&!['untouched','restored'].includes(record.effectState)&&!present(safe(root,'tavern/tavern-updates/transaction.json')))throw error();
 }
 // Removed programs cannot provide today's ready proof. Their retained root
 // identity and sealed predecessor backups still have to match the original
 // completed runtime chain; unfinished swaps never become a legacy KEEP.
 const shape=id=>id&&typeof id.device==='string'&&typeof id.inode==='string'&&/^\d+$/.test(id.device)&&/^\d+$/.test(id.inode)&&id.inode!=='0';
 const match=(file,id)=>{if(!shape(id)||!present(file))return false;const actual=identity(file);return actual.device===id.device&&actual.inode===id.inode;};
 for(const journal of runtimes){
  if(present(journal.paths.stage))throw error();
  if(journal.status==='committed'){
   if(!match(path.join(root,'hermes'),journal.identities?.next)&&!runtimes.some(next=>next!==journal
      &&match(next.paths.backup,journal.identities?.next)&&same(next.identities?.previous,journal.identities.next)))throw error();
   if(journal.identities.previous){if(!match(journal.paths.backup,journal.identities.previous)
      ||!require('./tree-integrity').sameSeal(journal.previousSeal,require('./tree-integrity').treeSeal(journal.paths.backup)))throw error();}
   else if(present(journal.paths.backup))throw error();
  }else{
   if(present(journal.paths.backup)||journal.identities.previous&&!match(path.join(root,'hermes'),journal.identities.previous)
     ||journal.identities.previous===null&&present(path.join(root,'hermes'))&&fs.readdirSync(path.join(root,'hermes')).length)throw error();
   if(present(journal.paths.failed)&&!match(journal.paths.failed,journal.identities.next))throw error();
  }
 }
 const system=safe(root,'tavern/tavern-updates/transaction.json');if(present(system)){
  const journal=readObject(system),record=records.get(journal.operationId),plan=journal.recoveryPlan;
  if(journal.schema!==1||!record||!['committed','rolled-back'].includes(journal.status)||!plan
    ||plan.hermesHome!==path.join(root,'hermes')||plan.installRoot!==path.join(root,'tavern')
    ||journal.status==='committed'&&(record.state!=='succeeded'||record.verification!=='confirmed'))throw error();
 }
 const receipts=['installed.json','installed-manifest.json','nora-system.json'].map(name=>safe(root,'tavern/tavern-updates/'+name));
 if(receipts.some(present)){
  if(!receipts.every(present))throw error();const [installed,manifest,system]=receipts.map(readObject);
  if(![1,2].includes(installed.schema)||!/^[a-f0-9]{40}$/.test(installed.commit||'')||typeof installed.version!=='string'
    ||manifest.schema!=='tavern-release/v2'||manifest.commit!==installed.commit||manifest.versions?.tavern!==installed.version
    ||system.schema!==1||system.commit!==installed.commit||system.version!==installed.version
    ||['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'].some(key=>system.proof?.[key]!==true))throw error();
 }
 for(const relative of ['installer/launcher-update','installer/system-update']){const file=safe(root,relative);if(present(file)&&fs.readdirSync(file).length)throw error();}
}
async function upgradeLegacy(home,port,context){const value=inspect(home);if(!value?.legacy)return value;
 context?.check();const operationId=context?.operationId;const record=installRecord(value.root,operationId);
 if(!['selecting','prepared','applying','recovering'].includes(record.state)||typeof context?.check!=='function')throw error();
 legacyHistory(value.root,operationId);
 const offline=require('./uninstall-offline-check');await offline.portOffline(port);offline.nativeOffline({root:value.root});await offline.portOffline(port);
 context.check();legacyHistory(value.root,operationId);
 const plan={root:value.root,owner:value.owner,hermes:value.hermes,tavern:value.tavern,port};
 const prepared=begin(plan,{excludeOperationId:operationId});context.check();return complete(plan,prepared);
}
function release(home,operationId){const value=inspect(home,{operationId});if(!value||value.reinstallOperationId!==operationId||!absentPrograms(value.root,value))throw error();
 delete value.reinstallOperationId;atomic(safe(value.root,fileName),value);return value;
}
function archiveCompletion(value,{result,terminal=true}={}){
 const record=installRecord(value.root,value.reinstallOperationId);
 // Readiness labels or a claim alone never retire the removal receipt, even
 // when the filesystem would permit its rename immediately.
 completionFacts(value,record,{result,terminal});
 const from=safe(value.root,fileName),to=safe(value.root,value.archive+`/reinstalled-${value.reinstallOperationId}.json`);
 if(present(to))throw error();
 try{fs.renameSync(from,to);return null;}
 catch(cause){
  if(!archiveIo.has(cause.code))throw cause;
  // Only a failed archive rename may be deferred, after the actual committed
  // installation is still proved. Validation/tamper failures remain fatal.
  completionFacts(value,record,{result,terminal});
  return {pending:true,code:cause.code,warning:completionWarning};
 }
}
function consume(home,operationId,{result}={}){const value=inspect(home,{operationId});if(!value)return null;if(value.reinstallOperationId!==operationId)throw error();
 return archiveCompletion(value,{result,terminal:false});
}
function retryCompletion(home,context){
 if(typeof context?.check!=='function'||typeof context.lease?.assertActive!=='function'||!ID.test(context.operationId||''))throw error();context.check();
 const value=inspect(home,{operationId:context.operationId});if(!value?.reinstalled)return null;
 context.check();return archiveCompletion(value);
}
module.exports={inspect,begin,archive,complete,claim,release,consume,retryCompletion,upgradeLegacy,legacyHistory,absentPrograms,error,fileName};
