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
async function recover(value,{worker=path.join(desktop,'legacy-recovery-worker.js'),offline=true,epoch=1,extraEnv={},digest=update.inspect(value.home).journalDigest}={}){
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
test('known legacy recovery preserves the current data view and returns files-only facts',{timeout:20000},async t=>{
 const value=fixture(t),before=update.inspect(value.home);
 assert.equal(before.canRecover,true);assert.equal(before.restoreVersion,'2.4.0');assert.equal(before.dataPolicy,'restore-backup-preserve-current');
 const result=await recover(value);assert.equal(result.code,0,result.stdout+result.stderr);
 const response=result.stdout.trim().split('\n').map(JSON.parse).find(event=>event.event==='result');
 assert.equal(response.legacyFilesRestored,true);assert.equal(response.recoveryVerification,'files-only');assert.equal(response.systemReady,undefined);
 assert.equal(response.dataMerged,false);assert.equal(fs.readFileSync(path.join(value.home,'hermes/.env'),'utf8'),'old credentials');
 const journal=JSON.parse(fs.readFileSync(path.join(value.directory,'journal.json'),'utf8'));
 assert.equal(fs.readFileSync(path.join(value.directory,journal.restoreSteps[0].failedName,'.env'),'utf8'),'new credentials');
 assert.equal(fs.readFileSync(path.join(value.directory,journal.restoreSteps[1].failedName,'story.json'),'utf8'),'new story');
 assert.equal(update.pending(value.home),false);
 assert.equal(result.snapshot.jobs[0].delegation.identityStatus,'reported');
 assert.ok(result.snapshot.jobs[0].executionIdentity.jobArgument);assert.ok(result.snapshot.jobs[0].closedAt);
});
test('unknown schema, missing backup and foreign instance are never offered recovery',{timeout:20000},async t=>{
 for(const mode of ['unknown','missing','foreign']){
  const value=fixture(t);
  if(mode==='unknown')value.write('installer/system-update/journal.json',{schema:9,phase:'applying'});
  if(mode==='missing')fs.rmSync(path.join(value.directory,'hermes'),{recursive:true});
  if(mode==='foreign')value.write('installer/system-update/hermes/nora-instance.json',{schema:1,noraHome:path.dirname(value.home),hermesHome:path.join(value.home,'hermes'),installRoot:path.join(value.home,'tavern'),port:18799});
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
test('recovery can resume after hard interruption immediately after restoring the first tree',{timeout:25000},async t=>{
 const value=fixture(t),worker=path.join(value.home,'legacy-recovery-worker.js');
 fs.writeFileSync(worker,`const fs=require('node:fs'),path=require('node:path');const rename=fs.promises.rename;fs.promises.rename=async(from,to)=>{await rename(from,to);if(from===path.join(process.argv[2],'installer/system-update/hermes'))process.kill(process.pid,'SIGKILL');};require(${JSON.stringify(path.join(desktop,'legacy-recovery-worker.js'))}).main();`);
 assert.notEqual((await recover(value,{worker})).code,0);assert.equal(update.inspect(value.home).canRecover,true);
 const result=await recover(value,{epoch:2});assert.equal(result.code,0,result.stdout+result.stderr);
 assert.equal(update.pending(value.home),false);assert.equal(fs.readFileSync(path.join(value.home,'tavern/story.json'),'utf8'),'old story');
});
test('a changed live identity or modified sealed backup blocks resumed recovery before replacing more files',{timeout:25000},async t=>{
 for(const mode of ['live','backup']){
  const value=fixture(t),worker=path.join(value.home,'legacy-recovery-worker.js');
  fs.writeFileSync(worker,`const fs=require('node:fs'),path=require('node:path');const rename=fs.promises.rename;fs.promises.rename=async(from,to)=>{if(from===path.join(process.argv[2],'hermes'))process.kill(process.pid,'SIGKILL');return rename(from,to);};require(${JSON.stringify(path.join(desktop,'legacy-recovery-worker.js'))}).main();`);
  assert.notEqual((await recover(value,{worker})).code,0);
  if(mode==='live'){fs.renameSync(path.join(value.home,'tavern'),path.join(value.home,'unrelated-original'));fs.mkdirSync(path.join(value.home,'tavern'));}
  else value.write('installer/system-update/tavern/story.json','changed backup');
  const inspected=update.inspect(value.home);
  assert.equal(inspected.canRecover,mode==='backup');
  if(mode==='backup')assert.equal(inspected.backupVerification,'verify-on-recovery');
  assert.notEqual((await recover(value,{epoch:2})).code,0);
  assert.equal(fs.readFileSync(path.join(value.home,'hermes/.env'),'utf8'),'new credentials');
 }
});

test('an interrupted legacy swap resumes with a separate process profile while the active Hermes tree is absent',{timeout:25000},async t=>{
 const value=fixture(t),worker=path.join(value.home,'legacy-recovery-worker.js');
 fs.writeFileSync(worker,`const fs=require('node:fs'),path=require('node:path');const rename=fs.promises.rename;fs.promises.rename=async(from,to)=>{if(from===path.join(process.argv[2],'installer/system-update/hermes'))process.kill(process.pid,'SIGKILL');return rename(from,to);};require(${JSON.stringify(path.join(desktop,'legacy-recovery-worker.js'))}).main();`);
 assert.notEqual((await recover(value,{worker})).code,0);assert.equal(fs.existsSync(path.join(value.home,'hermes')),false);
 fs.writeFileSync(worker,`process.stdout.write(JSON.stringify({event:'fixture',profile:process.env.USERPROFILE})+'\\n');require(${JSON.stringify(path.join(desktop,'legacy-recovery-worker.js'))}).main();`);
 const result=await recover(value,{worker,epoch:2,extraEnv:{HOME:path.join(value.home,'hermes'),USERPROFILE:path.join(value.home,'hermes'),
  APPDATA:path.join(value.home,'appdata/roaming'),LOCALAPPDATA:path.join(value.home,'appdata/local')}});
 assert.equal(result.code,0,result.stdout+result.stderr);
 const facts=result.stdout.trim().split('\n').map(JSON.parse).find(value=>value.event==='fixture');
 assert.equal(facts.profile,path.join(value.home,'installer','operations',value.operationId,'bootstrap-profile'));
 assert.equal(fs.readFileSync(path.join(value.home,'hermes/.env'),'utf8'),'old credentials');
 assert.equal(update.pending(value.home),false);
});
