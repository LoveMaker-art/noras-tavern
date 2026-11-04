// KEEP activates only bundled program paths. User paths stay at the same
// inode and are never used as rollback sources.
const fs=process.versions.electron?require('original-fs'):require('node:fs');
const path=require('node:path');

const SCHEMA='nora-runtime-bootstrap/2';
const programs=new Map([
  ['hermes-agent','directory'],['python','directory'],['node','directory'],['bin','directory'],
  ['.local/bin','directory'],['plugins/clawchat','directory'],['clawchat/liveware','directory'],
  ['nora-components.json','file'],['nora-clawchat-check.py','file'],
]);
const directories=['audio_cache','cron','hooks','image_cache','logs','memories','pairing','sessions','skills'];
const phases=new Set(['staged','activating','active','archiving','archived']);
const unavailable=()=>Object.assign(new Error('保留数据重装的程序路径或归属无法核验，未覆盖现有文件。'),{code:'RUNTIME_IDENTITY_UNKNOWN'});
const stat=file=>{try{return fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const same=(a,b)=>Boolean(a&&b&&a.device===b.device&&a.inode===b.inode);
const validIdentity=value=>value&&typeof value.device==='string'&&typeof value.inode==='string'&&/^\d+$/.test(value.device)&&/^[1-9]\d*$/.test(value.inode);
function identity(file,type){
  const value=stat(file);
  if(!value)return null;
  if(value.ino===0n||value.isSymbolicLink()||(type==='directory'?!value.isDirectory():!value.isFile()))throw unavailable();
  return {device:String(value.dev),inode:String(value.ino)};
}
function directory(base,relative,create=false){
  for(const part of relative.split('/').filter(Boolean)){
    base=path.join(base,part);
    if(!stat(base)&&create){
      fs.mkdirSync(base);
      syncDirectory(path.dirname(base));
    }
    if(!identity(base,'directory'))return null;
  }
  return base;
}
function syncDirectory(file){
  if(process.platform==='win32')return;
  const fd=fs.openSync(file,'r');
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function move(source,target){
  if(stat(target))throw unavailable();
  fs.renameSync(source,target);
  syncDirectory(path.dirname(target));
  syncDirectory(path.dirname(source));
}
function entryPath(base,relative,create=false){
  const parent=directory(base,path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative),create);
  return parent&&path.join(parent,path.posix.basename(relative));
}
function retirement(journal,location){
  if(!journal.retirement)return null;
  const {relative,tree}=journal.retirement;
  if(!/^runtime-history\/[0-9a-f-]{36}$/i.test(relative||'')||!validIdentity(tree))throw unavailable();
  const archive=directory(path.dirname(location.directory),relative);
  if(!archive)throw unavailable();
  const archived=path.join(archive,'tree'),atCurrent=identity(location.directory,'directory'),atArchive=identity(archived,'directory');
  if(Boolean(atCurrent)===Boolean(atArchive)||!same(atCurrent||atArchive,tree))throw unavailable();
  return {archive,archived,alreadyMoved:Boolean(atArchive)};
}
function requireHome(journal,home){
  if(!same(identity(home,'directory'),journal.identities.next))throw unavailable();
}
function requirePrivate(base,expected){
  if(!validIdentity(expected)||!same(identity(base,'directory'),expected))throw unavailable();
}
function entries(journal){
  const value=journal.entries;
  if(value===undefined&&['staging','failed'].includes(journal.status))return [];
  if(!Array.isArray(value)||value.length>programs.size||!value.some(item=>item?.relative==='hermes-agent'))throw unavailable();
  const names=new Set();
  for(const entry of value){
    if(!programs.has(entry?.relative)||names.has(entry.relative)||!validIdentity(entry.identity)||!validIdentity(entry.parent)||!phases.has(entry.phase))throw unavailable();
    names.add(entry.relative);
  }
  return value;
}
function markerMatches(journal,home){
  const file=path.join(home,'hermes-agent','.hermes-bootstrap-complete'),value=stat(file);
  if(!value?.isFile()||value.isSymbolicLink()||value.size>4096n)return false;
  const marker=JSON.parse(fs.readFileSync(file,'utf8'));
  return marker.schema===1&&marker.source==='nora-integrated-runtime'&&marker.operationId===journal.operationId
    &&marker.sha256===journal.target.sha256&&marker.platform===journal.target.platform&&marker.arch===journal.target.arch;
}
function entryState(journal,location,entry,{terminal=false}={}){
  const type=programs.get(entry.relative);
  const staged=entryPath(location.stage,entry.relative),failed=entryPath(location.failed,entry.relative);
  const stagedIdentity=staged&&identity(staged,type),failedIdentity=failed&&identity(failed,type);
  if(stagedIdentity&&!same(stagedIdentity,entry.identity)||failedIdentity&&!same(failedIdentity,entry.identity))throw unavailable();
  let active,activeIdentity;
  if(!terminal){
    active=entryPath(location.hermesHome,entry.relative);
    if(!active||!same(identity(path.dirname(active),'directory'),entry.parent))throw unavailable();
    activeIdentity=identity(active,type);
    if(activeIdentity&&!same(activeIdentity,entry.identity))throw unavailable();
  }
  const positions=[stagedIdentity&&'staged',activeIdentity&&'active',failedIdentity&&'archived'].filter(Boolean);
  if(positions.length!==1)throw unavailable();
  const allowed={
    staged:['staged'],activating:['staged','active'],active:['active'],
    archiving:['active','archived'],archived:['archived'],
  };
  if(!allowed[entry.phase].includes(positions[0]))throw unavailable();
  return {position:positions[0],staged,active,failed};
}

function facts(journal,location){
  const retired=retirement(journal,location);
  if(retired?.alreadyMoved)location={...location,directory:retired.archived,
    stage:path.join(retired.archived,path.basename(location.stage)),failed:path.join(retired.archived,path.basename(location.failed))};
  const planned=entries(journal);
  if(journal.status!=='rolled-back')requireHome(journal,location.hermesHome);
  if(planned.length){
    requirePrivate(location.stage,journal.identities.stage);
    requirePrivate(location.failed,journal.identities.failed);
  }
  const observed=planned.map(entry=>entryState(journal,location,entry,{terminal:journal.status==='rolled-back'}));
  const active=observed.filter(item=>item.position==='active');
  if(journal.status==='committed'){
    if(active.length!==planned.length||!markerMatches(journal,location.hermesHome))throw unavailable();
    return {effectState:'changed',recoveryOutcome:'not-required',canRecover:true,canResume:true,hasChanges:true,reason:'committed'};
  }
  if(journal.status==='rolled-back')
    return {effectState:'restored',recoveryOutcome:'restored',canRecover:false,hasChanges:true,reason:'retained-programs-restored'};
  if(active.length)
    return {effectState:'changed',recoveryOutcome:'recovery-required',canRecover:true,hasChanges:true,reason:'retained-programs-active'};
  if(journal.recoveryStartedAt)
    return {effectState:'restored',recoveryOutcome:'recovery-required',canRecover:true,hasChanges:true,reason:'retained-programs-awaiting-confirmation'};
  return {effectState:'untouched',recoveryOutcome:'not-required',canRecover:false,hasChanges:false,reason:'retained-programs-untouched'};
}

function prepare(journal,location){
  requireHome(journal,location.hermesHome);
  const stage=identity(location.stage,'directory');
  if(!stage)throw unavailable();
  fs.mkdirSync(location.failed);
  syncDirectory(location.directory);
  const planned=[];
  for(const [relative,type] of programs){
    const source=entryPath(location.stage,relative),from=source&&identity(source,type);
    if(!from)continue;
    const target=entryPath(location.hermesHome,relative,true),parent=identity(path.dirname(target),'directory');
    if(stat(target)||from.device!==parent.device)throw unavailable();
    entryPath(location.failed,relative,true);
    planned.push({relative,identity:from,parent,phase:'staged'});
  }
  if(!planned.some(entry=>entry.relative==='hermes-agent'))throw unavailable();
  return {status:'prepared',entries:planned,identities:{...journal.identities,stage,failed:identity(location.failed,'directory')}};
}

function activate(journal,location,save,afterMove){
  save({status:'applying'});
  for(const entry of entries(journal)){
    requireHome(journal,location.hermesHome);
    requirePrivate(location.stage,journal.identities.stage);
    entry.phase='activating';
    save({});
    const {position,staged,active}=entryState(journal,location,entry);
    if(position!=='staged')throw unavailable();
    move(staged,active);
    afterMove(entry.relative);
    entry.phase='active';
    save({});
  }
}

function rollback(journal,location,save,afterMove){
  for(const entry of entries(journal).slice().reverse()){
    requireHome(journal,location.hermesHome);
    requirePrivate(location.stage,journal.identities.stage);
    requirePrivate(location.failed,journal.identities.failed);
    const {position,active,failed}=entryState(journal,location,entry);
    if(position==='staged')continue;
    if(position==='active'){
      entry.phase='archiving';
      save({});
      move(active,failed);
      afterMove(entry.relative);
    }
    entry.phase='archived';
    save({});
  }
}

function initializeDefaults(location,skills){
  const {stage,hermesHome:home}=location;
  const publish=(source,target)=>{
    if(stat(target)||!stat(source))return;
    if(stat(source).isFile()){
      const fd=fs.openSync(source,'r+');
      try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      // The filesystem must reject a concurrent user-created target. The
      // source is a private template; never copy into an open live path.
      try{fs.linkSync(source,target);}catch(error){if(error.code==='EEXIST')return;throw error;}
      syncDirectory(path.dirname(target));
      fs.unlinkSync(source);
      syncDirectory(path.dirname(source));
    }else if(stat(source).isDirectory())move(source,target);
  };
  for(const name of directories){
    const target=path.join(home,name);
    if(!stat(target)){
      try{fs.mkdirSync(target);}catch(error){if(error.code==='EEXIST')continue;throw error;}
      syncDirectory(home);
    }
  }
  for(const name of ['.env','config.yaml'])publish(path.join(stage,name),path.join(home,name));
  const source=path.join(stage,'skills'),target=path.join(home,'skills');
  if(stat(source)?.isDirectory()&&stat(target)?.isDirectory())
    for(const name of skills)publish(path.join(source,name),path.join(target,name));
}

function detachDefaultTemplates(journal,location){
  requireHome(journal,location.hermesHome);
  requirePrivate(location.stage,journal.identities.stage);
  for(const name of ['.env','config.yaml']){
    const source=path.join(location.stage,name),target=path.join(location.hermesHome,name);
    if(!stat(source)?.isFile()||!stat(target)?.isFile())continue;
    // A cut after atomic publication can leave a second name for the same
    // file. Drop the private name and preserve the active file and its edits.
    if(same(identity(source,'file'),identity(target,'file'))){
      fs.unlinkSync(source);
      syncDirectory(location.stage);
    }
  }
}

function assertActive(journal,location){
  requireHome(journal,location.hermesHome);
  requirePrivate(location.stage,journal.identities.stage);
  requirePrivate(location.failed,journal.identities.failed);
  if(!entries(journal).every(entry=>entry.phase==='active'&&entryState(journal,location,entry).position==='active'))throw unavailable();
}

function verifyBackup(journal,home){
  try{
    requireHome(journal,home);
    return journal.status==='committed'&&entries(journal).every(entry=>{
      const file=entryPath(home,entry.relative);
      return entry.phase==='active'&&file&&same(identity(file,programs.get(entry.relative)),entry.identity)
        &&same(identity(path.dirname(file),'directory'),entry.parent);
    })&&markerMatches(journal,home);
  }catch{return false;}
}

module.exports={SCHEMA,facts,prepare,activate,rollback,initializeDefaults,detachDefaultTemplates,assertActive,verifyBackup,retirement,move};
