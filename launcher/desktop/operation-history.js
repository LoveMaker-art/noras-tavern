// Historical closure of already verified partial effects. This module owns only
// immutable transaction metadata; runtime/system readers still own live effects.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/,MAX=64*1024*1024,MAX_REFS=128;
const fail=()=>Object.assign(new Error('历史恢复证明缺失、变化或不属于当前安装，保留文件与备份。'),{code:'OPERATION_HISTORY_UNCONFIRMED'});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const keys=(value,wanted)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===wanted.split(',').sort().join(',');
function safe(root,relative){
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).some(v=>!v||v==='.'||v==='..'))throw fail();
 const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep))throw fail();
 let current=root;for(const part of path.relative(root,file).split(path.sep)){current=path.join(current,part);let stat;
  try{stat=fs.lstatSync(current);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(stat.isSymbolicLink())throw fail();}
 return file;
}
function read(file,limit=MAX){
 const stat=fs.lstatSync(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.size>BigInt(limit))throw fail();
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.size>BigInt(limit)||before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size
   ||before.mtimeNs!==stat.mtimeNs||before.ctimeNs!==stat.ctimeNs)throw fail();
  const buffer=Buffer.alloc(Number(before.size)+1);let size=0,count;
  do{count=fs.readSync(fd,buffer,size,buffer.length-size,null);size+=count;}while(count&&size<buffer.length);
  const bytes=buffer.subarray(0,size),after=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(file,{bigint:true});
  if(after.dev!==before.dev||after.ino!==before.ino||named.isSymbolicLink()||named.dev!==before.dev||named.ino!==before.ino||named.size!==before.size
   ||named.mtimeNs!==before.mtimeNs||named.ctimeNs!==before.ctimeNs||before.size!==after.size
   ||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(bytes.length)!==before.size)throw fail();
  return {bytes,value:JSON.parse(bytes)};
 }finally{fs.closeSync(fd);}
}
function refs(value=[]){
 if(!Array.isArray(value)||value.length>MAX_REFS)throw fail();const seen=new Set();
 for(const item of value){if(!keys(item,'path,sha256')||!SHA.test(item.sha256||'')
  ||!/^installer\/operations\/[0-9a-f-]{36}\/partial-history\.json$/i.test(item.path||'')||seen.has(item.path))throw fail();seen.add(item.path);}
 return value;
}
function fingerprint(record){return Object.fromEntries(['schema','operationId','kind','ownerEpoch','createdAt','state','effectState',
 'recoveryOutcome','verification','planDigest','planSelected','attempt','totalAttempts'].filter(k=>record[k]!==undefined).map(k=>[k,record[k]]));}
function recordMatches(current,saved){
 if(!equal(fingerprint(current),fingerprint(saved)))throw fail();
 if(current.archived!==true&&(!equal(current.target,saved.target)||!equal(current.result,saved.result)||current.updatedAt!==saved.updatedAt))throw fail();
 if(current.archived===true&&(Object.keys(current.target||{}).length||!Number.isFinite(Date.parse(current.archivedAt))
  ||!Number.isFinite(Date.parse(saved.updatedAt))||Date.parse(current.archivedAt)<Date.parse(saved.updatedAt)))throw fail();
}
function record(root,id){if(!ID.test(id||''))throw fail();return read(safe(root,`installer/operations/${id}/operation.json`),256*1024).value;}
function collect(root){
 root=path.resolve(root);const all=new Map(),directory=safe(root,'installer/operations');
 if(fs.existsSync(directory))for(const name of fs.readdirSync(directory)){if(!ID.test(name))continue;
  const file=safe(root,`installer/operations/${name}/operation.json`);if(!fs.existsSync(file))continue;
  for(const item of refs(read(file,256*1024).value.effectClosureRefs)){const old=all.get(item.path);if(old&&!equal(old,item))throw fail();all.set(item.path,item);}}
 const system=safe(root,'tavern/tavern-updates/transaction.json');if(fs.existsSync(system))
  for(const item of refs(read(system).value.recoveryPlan?.effectClosureRefs)){const old=all.get(item.path);if(old&&!equal(old,item))throw fail();all.set(item.path,item);}
 return refs([...all.values()]);
}
function validate(root,ref,{unpublished=false}={}){
 root=path.resolve(root);refs([ref]);const {bytes,value}=read(safe(root,ref.path));if(hash(bytes)!==ref.sha256)throw fail();
 const owner=read(safe(root,'nora-owner.json'),65536).value;
 if(!keys(value,'schema,noraHome,owner,producer,source,closed,capturedAt')||value.schema!=='nora-partial-effects-closure/1'
  ||value.noraHome!==root||value.owner!==owner.id||!Number.isFinite(Date.parse(value.capturedAt))
  ||!keys(value.producer,'operationId,ownerEpoch,planDigest,createdAt')||!ID.test(value.producer.operationId||'')
  ||ref.path!==`installer/operations/${value.producer.operationId}/partial-history.json`||!SHA.test(value.producer.planDigest||'')
  ||!keys(value.source,'record,runtimeSha256,systemJournal,systemJournalSha256,proof,reader')
  ||!SHA.test(value.source.runtimeSha256||'')||!SHA.test(value.source.systemJournalSha256||'')
  ||!Array.isArray(value.closed)||!value.closed.length||value.closed.length>128)throw fail();
 if(!Number.isSafeInteger(value.producer.ownerEpoch)||value.producer.ownerEpoch<1
  ||!Number.isFinite(Date.parse(value.producer.createdAt)))throw fail();
 const producer=record(root,value.producer.operationId);
 if(!Number.isSafeInteger(producer.ownerEpoch)||producer.ownerEpoch<value.producer.ownerEpoch||producer.planDigest!==value.producer.planDigest||producer.planSelected!==true
  ||producer.createdAt!==value.producer.createdAt||!['install','update','repair'].includes(producer.kind)
  ||!unpublished&&!refs(producer.effectClosureRefs).some(item=>equal(item,ref)))throw fail();
 const reader=value.source.reader;if(!keys(reader,'launcherVersion,platform,arch,channel')||reader.platform!==process.platform||reader.arch!==process.arch
  ||!['stable','beta'].includes(reader.channel)||!/^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(reader.launcherVersion||''))throw fail();
 const saved=value.source.record,current=record(root,saved.operationId);recordMatches(current,saved);
 if(!Number.isSafeInteger(saved.ownerEpoch)||saved.ownerEpoch<1
  ||![saved.createdAt,saved.updatedAt].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))throw fail();
 require('./releases').validatePlan(saved.target?.releasePlan,{...reader,operationDirectory:safe(root,`installer/operations/${saved.operationId}`),mode:'install'});
 if(saved.state!=='succeeded'||saved.verification!=='confirmed'||saved.effectState!=='changed'||saved.recoveryOutcome!=='not-required'
  ||saved.result?.systemReady!==true||saved.result?.updateVerified!==true||saved.ownerEpoch>=value.producer.ownerEpoch
  ||Date.parse(saved.updatedAt)>Date.parse(producer.createdAt)||Date.parse(value.capturedAt)<Date.parse(producer.createdAt)
  ||saved.target?.releasePlan?.mode!=='install'||hash(JSON.stringify(saved.target))!==saved.planDigest)throw fail();
 const sourceRuntime=read(safe(root,`installer/operations/${saved.operationId}/runtime-bootstrap.json`));
 if(hash(sourceRuntime.bytes)!==value.source.runtimeSha256)throw fail();
 if(typeof value.source.systemJournal!=='string'||hash(value.source.systemJournal)!==value.source.systemJournalSha256)throw fail();
 const journal=JSON.parse(value.source.systemJournal),plan=journal?.recoveryPlan,proof=value.source.proof,selected=saved.target.releasePlan;
 if(!plan||journal.operationId!==saved.operationId||journal.ownerEpoch!==saved.ownerEpoch||journal.status!=='committed'
  ||journal.version!==selected.version||proof.operationId!==saved.operationId||proof.ownerEpoch!==saved.ownerEpoch
  ||proof.journalSha256!==value.source.systemJournalSha256||proof.backup!==journal.backup
  ||proof.version!==selected.version||proof.beforeVersion!==saved.target.currentVersion
  ||saved.result.version!==selected.version||saved.result.commit!==selected.commit
  ||!SHA.test(plan.state?.savedDigest||'')||!Array.isArray(proof.targets)
  ||plan.before?.version!==saved.target.currentVersion||plan.before.running!==false||plan.before.gatewayRunning!==false||plan.before.clawchatConnected!==false
  ||plan.hermesHome!==path.join(root,'hermes')||plan.installRoot!==path.join(root,'tavern')
  ||plan.lifecycle?.noraHome!==root||plan.lifecycle?.hermesHome!==path.join(root,'hermes')||plan.lifecycle?.installRoot!==path.join(root,'tavern')
  ||!equal(plan.lifecycle?.before,plan.before)||!plan.worlds||typeof plan.worlds!=='object'||Array.isArray(plan.worlds))throw fail();
 const installedTargets=plan.targets?.filter(item=>item.namespace==='install');
 if(!installedTargets||installedTargets.length!==proof.targets.length)throw fail();
 for(const target of proof.targets){const matches=installedTargets.filter(item=>item.name===target.name&&item.namespace===target.namespace&&item.relative===target.relative);
  if(matches.length!==1||target.oldDigest!==matches[0].oldDigest||!keys(target,'name,namespace,relative,oldIdentity,oldDigest')
   ||target.oldIdentity!==null&&(!Array.isArray(target.oldIdentity)||target.oldIdentity.length!==2||!target.oldIdentity.every(v=>typeof v==='string'&&/^\d+$/.test(v))||target.oldIdentity[1]==='0'))throw fail();}
 const ids=new Set();for(const item of value.closed){
  if(!keys(item,'record,runtimeSha256')||!SHA.test(item.runtimeSha256||'')||ids.has(item.record?.operationId))throw fail();ids.add(item.record.operationId);
  if(!Number.isSafeInteger(item.record.ownerEpoch)||item.record.ownerEpoch<1
   ||![item.record.createdAt,item.record.updatedAt].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))throw fail();
  const oldRecord=record(root,item.record.operationId);recordMatches(oldRecord,item.record);
  require('./releases').validatePlan(item.record.target?.releasePlan,{...reader,operationDirectory:safe(root,`installer/operations/${item.record.operationId}`),mode:'install'});
  const actual=read(safe(root,`installer/operations/${item.record.operationId}/runtime-bootstrap.json`));
  if(hash(actual.bytes)!==item.runtimeSha256)throw fail();const old=actual.value,snapshot=old.originalPartial;
  if(item.record.state!=='rolled-back'||item.record.effectState!=='restored'||item.record.verification!=='confirmed'
   ||item.record.recoveryOutcome!=='restored-and-verified'||item.record.ownerEpoch>=saved.ownerEpoch
   ||Date.parse(item.record.updatedAt)>=Date.parse(saved.createdAt)||item.record.target?.releasePlan?.mode!=='install'
   ||hash(JSON.stringify(item.record.target))!==item.record.planDigest||old.recoveryVerification!=='original-partial-confirmed'
   ||old.status!=='rolled-back'||old.ownerEpoch!==item.record.ownerEpoch||old.paths?.noraHome!==root||old.newTreePreserved!==true
   ||!equal(snapshot,sourceRuntime.value.originalPartial)||!equal(old.previousSeal,sourceRuntime.value.previousSeal)
   ||old.partialSystemProof?.stateDigest!==plan.state.savedDigest||!equal(old.identities.previous,sourceRuntime.value.identities.previous)
   ||!snapshot?.bindings||!keys(snapshot.bindings,'config,instance,manifest,nativeConfig,receipt,runtimeMarker,system'))throw fail();
  const baseline=plan.partialBaseline;
  if(baseline!==undefined){if(!keys(baseline,'schema,partialRepair,stateDigest,storyInventory,worlds,readerManifestSha256,readerCommit')
    ||baseline.schema!=='nora-managed-partial-repair-baseline/1'||baseline.stateDigest!==plan.state.savedDigest
    ||baseline.readerManifestSha256!==selected.manifestSha256||baseline.readerCommit!==selected.commit
    ||!equal(baseline.worlds,plan.worlds)||!equal(baseline.partialRepair,plan.lifecycle.partialRepair)
    ||!baseline.storyInventory||typeof baseline.storyInventory!=='object'||Array.isArray(baseline.storyInventory))throw fail();
    const now=baseline.partialRepair;
    for(const key of ['instance','config','manifest','nativeConfig','receipt','system'])if(snapshot.bindings[key]!==now.bindings?.[key])throw fail();
    if(!equal(snapshot.programs,now.programs)||snapshot.missing.python!==true||now.missing.python!==false
      ||snapshot.missing.nativeRuntime!==now.missing.nativeRuntime||snapshot.missing.nativeLifecycle!==now.missing.nativeLifecycle)throw fail();
  }else if(proof.partialHistoryKind!=='python-only'||!equal(snapshot.missing,{nativeRuntime:false,nativeLifecycle:false,python:true})
    ||plan.before.systemReady!==true||plan.lifecycle.partialRepair!==undefined||proof.stateDigest!==plan.state.savedDigest)throw fail();
  if(!['untouched','restored'].includes(old.partialSystemProof?.effects?.effectState)
   ||!['not-required','restored','restored-and-verified'].includes(old.partialSystemProof?.effects?.recoveryOutcome))throw fail();
  for(const [name,program] of Object.entries(snapshot.programs||{})){
   const target=proof.targets.filter(value=>value.name===name);if(target.length>1)throw fail();
   if(target.length&&(!equal(target[0].oldIdentity,program?.identity??null)||target[0].oldDigest!==(program?.digest??null)))throw fail();
  }
  for(const absent of [old.paths.stage,old.paths.backup])if(fs.existsSync(safe(root,path.relative(root,absent))))throw fail();
  const failed=safe(root,path.relative(root,old.paths.failed)),stat=fs.lstatSync(failed,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||old.identities.next?.device!==String(stat.dev)||old.identities.next?.inode!==String(stat.ino))throw fail();
  // A closure is not permission to restore the retired old tree. The current
  // system/runtime writer must still independently prove its own live effects.
 }
 return value;
}
function inspect(root){try{const references=collect(root),closed=new Map();for(const ref of references){const proof=validate(root,ref);
 for(const item of proof.closed){const old=closed.get(item.record.operationId);if(old&&!equal(old.item,item))throw fail();closed.set(item.record.operationId,{item,proof,ref});}}
 return {references,closed};
 }catch(error){if(error.code==='OPERATION_HISTORY_UNCONFIRMED')throw error;const failure=fail();failure.cause=error;throw failure;}
}
function save(root,context,source,closed){
 context.check();root=path.resolve(root);const current=record(root,context.operationId);
 const savedProducer=current;
 if(!savedProducer.planSelected||!SHA.test(savedProducer.planDigest||'')||savedProducer.operationId!==context.operationId||savedProducer.ownerEpoch!==context.ownerEpoch)throw fail();
 const relative=`installer/operations/${savedProducer.operationId}/partial-history.json`,file=safe(root,relative);
 const value={schema:'nora-partial-effects-closure/1',noraHome:root,owner:read(safe(root,'nora-owner.json'),65536).value.id,
  producer:{operationId:savedProducer.operationId,ownerEpoch:savedProducer.ownerEpoch,planDigest:savedProducer.planDigest,createdAt:savedProducer.createdAt},source,closed,capturedAt:new Date().toISOString()};
 if(fs.existsSync(file)){const existing=read(file);if(!equal(existing.value.source,source)||!equal(existing.value.closed,closed)||existing.value.producer.operationId!==value.producer.operationId||existing.value.producer.planDigest!==value.producer.planDigest
    ||existing.value.producer.createdAt!==value.producer.createdAt||existing.value.producer.ownerEpoch>value.producer.ownerEpoch)throw fail();
  const ref={path:relative,sha256:hash(existing.bytes)};validate(root,ref,{unpublished:true});return ref;}
 const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>MAX)throw fail();
 const temporary=file+'.'+crypto.randomUUID()+'.tmp';let fd;
 try{context.check();fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  context.check();fs.renameSync(temporary,file);if(process.platform!=='win32'){const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.rmSync(temporary,{force:true});}catch{}}
 context.check();const ref={path:relative,sha256:hash(bytes)};validate(root,ref,{unpublished:true});return ref;
}
module.exports={collect,inspect,validate,save,refs,hash,fingerprint,recordMatches};
