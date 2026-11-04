const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {once}=require('node:events');
const test=require('node:test');
const update=require('../installer/desktop/system-update');
const {acquire}=require('../installer/desktop/operation-lock');
const desktop=path.resolve(__dirname,'../installer/desktop');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function retainedBytes(value){
 const result={};
 const visit=file=>{
  if(!fs.existsSync(file)){result[path.relative(value.home,file)]={missing:true};return;}
  const stat=fs.lstatSync(file),relative=path.relative(value.home,file);
  result[relative]=stat.isDirectory()?{directory:true,dev:stat.dev,ino:stat.ino}
   :stat.isSymbolicLink()?{link:fs.readlinkSync(file)}:{bytes:fs.readFileSync(file).toString('hex')};
  if(stat.isDirectory())for(const name of fs.readdirSync(file).sort())visit(path.join(file,name));
 };
 for(const relative of ['hermes','tavern','installer/system-update'])visit(path.join(value.home,relative));
 return result;
}

// Recreate durable checkpoints produced by the retired whole-root adapter;
// never execute an unsafe exchange just to set up its future rejection case.
function interrupted(value,{firstRestored=false,preserveOnly=false}={}){
 const journal=path.join(value.directory,'journal.json'),state=JSON.parse(fs.readFileSync(journal));
 const identity=file=>{const stat=fs.statSync(file,{bigint:true});return {dev:String(stat.dev),ino:String(stat.ino)};};
 const steps=['hermes','tavern'].map(name=>({name,backupIdentity:identity(path.join(value.directory,name)),
  currentIdentity:identity(path.join(value.home,name)),failedName:`failed-${name}-${crypto.randomUUID()}`,phase:'prepared'}));
 if(firstRestored||preserveOnly){
  fs.renameSync(path.join(value.home,'hermes'),path.join(value.directory,steps[0].failedName));
  steps[0].phase='preserved';
  if(firstRestored){fs.renameSync(path.join(value.directory,'hermes'),path.join(value.home,'hermes'));steps[0].phase='restored';}
 }
 value.write('installer/system-update/journal.json',{...state,phase:'restoring',sourceJournalDigest:hash(fs.readFileSync(journal)),
  adapterOwner:JSON.parse(fs.readFileSync(path.join(value.home,'nora-owner.json'))).id,restoreSteps:steps});
}

function fixture(t){
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-legacy-recovery-')));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const write=(name,data)=>{const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof data==='string'?data:JSON.stringify(data));};
 write('nora-owner.json',{schema:1,id:crypto.randomUUID()});
 write('hermes/.env','old credentials');write('tavern/story.json','old story');
 write('hermes/nora-instance.json',{schema:1,noraHome:home,hermesHome:path.join(home,'hermes'),installRoot:path.join(home,'tavern'),port:18799});
 write('hermes/hermes-agent/.hermes-bootstrap-complete',{schema:1,source:'nora-integrated-runtime',sha256:'a'.repeat(64),platform:process.platform,arch:process.arch});
 const manifest={schema:'tavern-release/v2',commit:'b'.repeat(40),versions:{tavern:'2.4.0'},hermesRuntime:{sha256:'a'.repeat(64),platform:process.platform,arch:process.arch}};
 write('tavern/tavern-updates/installed-manifest.json',manifest);
 write('tavern/tavern-updates/installed.json',{schema:1,version:'2.4.0',commit:manifest.commit,hermesRuntime:manifest.hermesRuntime});
 const directory=path.join(home,'installer/system-update');fs.mkdirSync(directory,{recursive:true});
 for(const name of ['hermes','tavern'])fs.cpSync(path.join(home,name),path.join(directory,name),{recursive:true});
 write('installer/system-update/journal.json',{schema:1,phase:'applying',target:'v2.4.1'});
 write('hermes/.env','new credentials');write('tavern/story.json','new story');
 return {home,directory,write,operationId:crypto.randomUUID()};
}
async function recover(value,{worker=path.join(desktop,'legacy-recovery-worker.js'),offline=true,epoch=1,extraEnv={},digest}={}){
 digest??=update.inspect(value.home)?.journalDigest||hash(fs.readFileSync(path.join(value.directory,'journal.json')));
 const lease=await acquire({directory:path.join(value.home,'installer'),operationId:value.operationId,ownerEpoch:epoch});
 try{
  const child=lease.spawn(process.execPath,[worker,value.home],{kind:'legacy-recovery',env:{...process.env,...extraEnv,ELECTRON_RUN_AS_NODE:'1'}});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  child.stdin.end(JSON.stringify({journalDigest:digest,offlineProof:{operationId:value.operationId,ownerEpoch:epoch,offline,running:false,gatewayRunning:false}}));
  const [code,signal]=await once(child,'close');return {code,signal,stdout,stderr,snapshot:await lease.snapshot()};
 }finally{await lease.release();}
}

test('retired JS update and user-overlay executors are absent',()=>{
 assert.equal(update.perform,undefined);assert.equal(update.restoreUserHome,undefined);
});
test('legacy whole-user-tree recovery is rejected by the real worker without changing active or saved data',{timeout:20000},async t=>{
 const value=fixture(t),before=retainedBytes(value),result=await recover(value);
 assert.notEqual(result.code,0,result.stdout+result.stderr);assert.match(result.stdout,/LEGACY_RECOVERY_DATA_BOUNDARY/);
 assert.deepEqual(retainedBytes(value),before);
 const inspected=update.inspect(value.home);assert.equal(inspected.canRecover,false);
 assert.equal(inspected.dataPolicy,'preserve-current-no-automatic-restore');
 assert.match(inspected.reason,/程序.*用户数据|用户数据.*程序/);
 assert.equal(fs.readFileSync(path.join(value.home,'hermes/.env'),'utf8'),'new credentials');
 assert.equal(fs.readFileSync(path.join(value.home,'tavern/story.json'),'utf8'),'new story');
 assert.equal(update.pending(value.home),true,'refusal must not forge a completed history');
 assert.equal(result.snapshot.jobs[0].delegation.identityStatus,'reported');
 assert.ok(result.snapshot.jobs[0].executionIdentity.jobArgument);assert.ok(result.snapshot.jobs[0].closedAt);
});
test('unknown schema, missing backup and foreign instance are never offered recovery',{timeout:20000},async t=>{
 for(const mode of ['unknown','missing','foreign','linked']){
  const value=fixture(t);
  if(mode==='unknown')value.write('installer/system-update/journal.json',{schema:9,phase:'applying'});
  if(mode==='missing')fs.rmSync(path.join(value.directory,'hermes'),{recursive:true});
  if(mode==='foreign')value.write('installer/system-update/hermes/nora-instance.json',{schema:1,noraHome:path.dirname(value.home),hermesHome:path.join(value.home,'hermes'),installRoot:path.join(value.home,'tavern'),port:18799});
  if(mode==='linked'){
   fs.renameSync(path.join(value.directory,'hermes'),path.join(value.directory,'retained-hermes'));
   fs.symlinkSync(path.join(value.directory,'retained-hermes'),path.join(value.directory,'hermes'),process.platform==='win32'?'junction':'dir');
  }
  const journal=fs.readFileSync(path.join(value.directory,'journal.json'));
  assert.equal(update.inspect(value.home).canRecover,false);
  const result=await recover(value);assert.notEqual(result.code,0);
  assert.deepEqual(fs.readFileSync(path.join(value.directory,'journal.json')),journal);
  assert.equal(fs.readFileSync(path.join(value.home,'hermes/.env'),'utf8'),'new credentials');
 }
});
test('a private ACK without positive stop proof cannot replace files',{timeout:20000},async t=>{
 const value=fixture(t),journal=fs.readFileSync(path.join(value.directory,'journal.json'));
 const result=await recover(value,{offline:false});assert.notEqual(result.code,0);assert.match(result.stdout,/VERIFICATION_FAILED/);
 assert.deepEqual(fs.readFileSync(path.join(value.directory,'journal.json')),journal);
 assert.equal(fs.readFileSync(path.join(value.home,'tavern/story.json'),'utf8'),'new story');
});
test('legacy worker refuses an environment token without a live guard',{timeout:15000},async t=>{
 const value=fixture(t);const {spawnSync}=require('node:child_process');
 const result=spawnSync(process.execPath,[path.join(desktop,'legacy-recovery-worker.js'),value.home],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NORA_OPERATION_ID:value.operationId},input:'{}'});
 assert.notEqual(result.status,0);assert.match(result.stdout,/DELEGATION_REQUIRED/);
 assert.equal(fs.readFileSync(path.join(value.home,'hermes/.env'),'utf8'),'new credentials');
});
test('a changed journal digest cannot authorize recovery',{timeout:20000},async t=>{
 const value=fixture(t),before=update.inspect(value.home);value.write('installer/system-update/journal.json',{schema:1,phase:'applying',target:'v2.4.2'});
 const result=await recover(value,{digest:before.journalDigest});assert.notEqual(result.code,0);assert.match(result.stdout,/CONDITIONS_CHANGED/);
 assert.equal(fs.readFileSync(path.join(value.home,'hermes/.env'),'utf8'),'new credentials');
});
test('an interrupted legacy exchange is retained without replaying another whole user tree',{timeout:25000},async t=>{
 for(const position of ['prepared','preserved','restored']){
  const value=fixture(t);interrupted(value,{firstRestored:position==='restored',preserveOnly:position==='preserved'});
  const before=retainedBytes(value),result=await recover(value,{epoch:2});
  assert.notEqual(result.code,0);assert.match(result.stdout,/LEGACY_RECOVERY_DATA_BOUNDARY/);
  assert.deepEqual(retainedBytes(value),before);assert.equal(update.inspect(value.home).canRecover,false);
  assert.equal(update.pending(value.home),true);assert.equal(fs.readFileSync(path.join(value.home,'tavern/story.json'),'utf8'),'new story');
 }
});
test('an unknown live identity or changed old backup never authorizes legacy data replay',{timeout:25000},async t=>{
 for(const mode of ['live','backup']){
  const value=fixture(t);interrupted(value);
  if(mode==='live'){fs.renameSync(path.join(value.home,'tavern'),path.join(value.home,'unrelated-original'));fs.mkdirSync(path.join(value.home,'tavern'));}
  else value.write('installer/system-update/tavern/story.json','changed backup');
  const inspected=update.inspect(value.home);
  assert.equal(inspected.canRecover,false);
  const before=retainedBytes(value);
  assert.notEqual((await recover(value,{epoch:2})).code,0);
  assert.deepEqual(retainedBytes(value),before);
  assert.equal(fs.readFileSync(path.join(value.home,'hermes/.env'),'utf8'),'new credentials');
 }
});

test('an interrupted legacy swap refuses data replay with an independent profile while active Hermes is absent',{timeout:25000},async t=>{
 const value=fixture(t),worker=path.join(value.home,'legacy-recovery-worker.js');
 interrupted(value,{preserveOnly:true});const before=retainedBytes(value);
 assert.equal(fs.existsSync(path.join(value.home,'hermes')),false);
 fs.writeFileSync(worker,`process.stdout.write(JSON.stringify({event:'fixture',profile:process.env.USERPROFILE})+'\\n');require(${JSON.stringify(path.join(desktop,'legacy-recovery-worker.js'))}).main();`);
 const result=await recover(value,{worker,epoch:2,extraEnv:{HOME:path.join(value.home,'hermes'),USERPROFILE:path.join(value.home,'hermes'),
  APPDATA:path.join(value.home,'appdata/roaming'),LOCALAPPDATA:path.join(value.home,'appdata/local')}});
 assert.notEqual(result.code,0,result.stdout+result.stderr);assert.match(result.stdout,/LEGACY_RECOVERY_DATA_BOUNDARY/);
 const facts=result.stdout.trim().split('\n').map(JSON.parse).find(value=>value.event==='fixture');
 assert.equal(facts.profile,path.join(value.home,'installer','operations',value.operationId,'bootstrap-profile'));
 assert.deepEqual(retainedBytes(value),before);assert.equal(update.pending(value.home),true);
});

test('completed legacy history stays read-only and does not reopen recovery after later user edits',{timeout:20000},async t=>{
 for(const phase of ['committed','rolled-back']){
  const value=fixture(t);value.write('installer/system-update/journal.json',{schema:1,phase,target:'v2.4.1'});
  fs.rmSync(path.join(value.directory,'hermes'),{recursive:true});
  value.write('hermes/.env','credentials edited after completion');const before=retainedBytes(value);
  assert.equal(update.inspect(value.home),null);assert.equal(update.pending(value.home),false);
  const result=await recover(value);assert.notEqual(result.code,0);
  assert.deepEqual(retainedBytes(value),before);assert.equal(update.inspect(value.home),null);
 }
});
