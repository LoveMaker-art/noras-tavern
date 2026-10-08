const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {acquire}=require('../installer/desktop/operation-lock');
const transaction=require('../installer/desktop/runtime-transaction');
const desktop=path.resolve(__dirname,'../installer/desktop');

// These fixtures verify physical swap/recovery effects and real extraction
// process ownership. They deliberately do not claim a complete Hermes build.
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-transaction-'));
  const payload=path.join(root,'payload'),home=path.join(root,'home'),hermes=path.join(home,'hermes');
  const source=path.join(root,'source/hermes-runtime');fs.mkdirSync(path.join(source,'hermes-agent'),{recursive:true});
  fs.mkdirSync(path.join(source,'logs'));fs.writeFileSync(path.join(source,'logs/new-stage.log'),'new failure evidence');
  fs.writeFileSync(path.join(source,'hermes-agent/program.txt'),'new-program');fs.mkdirSync(payload);
  const archive=path.join(payload,'runtime.tar.gz');
  const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'):'/usr/bin/tar';
  const packed=spawnSync(tar,['-czf',archive,'-C',path.dirname(source),'hermes-runtime']);assert.equal(packed.status,0,String(packed.stderr));
  const manifest={schema:1,platform:process.platform,arch:process.arch,archive:path.basename(archive),format:'tar.gz',
    sha256:crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),nodeLinks:{},relocatableFiles:[],
    componentProbe:'nora-clawchat-check.py',components:{clawchat:{revision:'a'.repeat(40)},liveware:{sha256:'b'.repeat(64)},files:{}}};
  fs.writeFileSync(path.join(payload,'nora-hermes-runtime.json'),JSON.stringify(manifest));
  fs.mkdirSync(path.join(hermes,'hermes-agent'),{recursive:true});
  fs.writeFileSync(path.join(hermes,'hermes-agent/.hermes-bootstrap-complete'),JSON.stringify({schema:1,source:'nora-integrated-runtime',
    sha256:'c'.repeat(64),platform:process.platform,arch:process.arch}));
  fs.writeFileSync(path.join(hermes,'hermes-agent/program.txt'),'old-program');fs.writeFileSync(path.join(hermes,'.env'),'DUMMY_SETTING=preserved\n');
  fs.mkdirSync(path.join(hermes,'logs'));fs.writeFileSync(path.join(hermes,'logs/old-record.log'),'old evidence');
  const tools=path.join(root,'fixture-tools.cjs');
  fs.writeFileSync(tools,`const runtime=require(${JSON.stringify(path.join(desktop,'runtime.js'))});module.exports={...runtime,
    initializeHome(home,manifest){if(process.env.NORA_FIXTURE_PREPARE_FAILURE==='1')throw Object.assign(new Error('copy fixture denied'),{code:'EPERM'});runtime.initializeHome(home,manifest);},
    async repairRuntimeAsync(){},async validateRuntimeAsync(home){if(process.env.NORA_FIXTURE_VERIFY_FAILURE==='1')throw Object.assign(new Error('restored runtime probe failed'),{code:'VERIFICATION_FAILED'});if(!require('node:fs').existsSync(require('node:path').join(home,'hermes-agent/program.txt')))throw new Error('fixture program missing');return 'runtime-fixture';}};`);
  const worker=path.join(root,'runtime-worker.js');
  fs.writeFileSync(worker,`const [payloadRoot,noraHome,hermesHome,mode,killAt]=process.argv.slice(2);
    const {connect}=require(${JSON.stringify(path.join(desktop,'operation-delegate.js'))});
    const transaction=require(${JSON.stringify(path.join(desktop,'runtime-transaction.js'))});
    (async()=>{const delegate=await connect();const {operationId,ownerEpoch}=delegate.context;
      const onEvent=event=>{process.stdout.write(JSON.stringify(event)+'\\n');if(event.phase===killAt)process.kill(process.pid,'SIGKILL');};
      try{if(mode==='recover')await transaction.recover({noraHome,hermesHome,operationId,ownerEpoch,delegate,allowCommitted:true,onEvent,tools:require(${JSON.stringify(tools)})});
      else await transaction.install({payloadRoot,noraHome,hermesHome,operationId,ownerEpoch,delegate,onEvent,tools:require(${JSON.stringify(tools)})});}
      finally{delegate.close();}
    })().catch(error=>{process.stdout.write(JSON.stringify({error:error.code,message:error.message})+'\\n');process.exitCode=2;});`);
  return {root,payload,home,hermes,worker,operationId:crypto.randomUUID()};
}
async function run(value,epoch,mode='install',killAt='',extraEnv={}){
  const lease=await acquire({directory:path.join(value.home,'installer'),operationId:value.operationId,ownerEpoch:epoch});
  try{
    const child=lease.spawn(process.execPath,[value.worker,value.payload,value.home,value.hermes,mode,killAt],
      {kind:'runtime-bootstrap',env:{...process.env,...extraEnv}});
    let text='';child.stdout.on('data',data=>text+=data);let errors='';child.stderr.on('data',data=>errors+=data);
    const [code,signal]=await once(child,'close');
    const snapshot=await lease.snapshot();
    return {code,signal,text,errors,snapshot};
  }finally{await lease.release();}
}
const inspect=value=>transaction.inspect({noraHome:value.home,hermesHome:value.hermes,operationId:value.operationId});

test('a preparation failure preserves the old runtime, its data and its original failure evidence',{timeout:20000},async()=>{
  const value=fixture();
  try{
    const result=await run(value,1,'install','',{NORA_FIXTURE_PREPARE_FAILURE:'1'});assert.equal(result.code,2,result.errors);
    assert.equal(inspect(value).effectState,'untouched');
    assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'old-program');
    const journal=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));assert.equal(journal.primaryFailure.code,'EPERM');
    assert.equal(fs.readFileSync(path.join(journal.paths.stage,'logs/new-stage.log'),'utf8'),'new failure evidence');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('hard interruption after backing up the old tree is recovered using actual directory identity',{timeout:20000},async()=>{
  const value=fixture();
  try{
    const interrupted=await run(value,1,'install','runtime.previous-backed-up');assert.notEqual(interrupted.code,0);
    assert.equal(inspect(value).canRecover,true);assert.equal(inspect(value).effectState,'changed');assert.equal(fs.existsSync(value.hermes),false);
    const restored=await run(value,2,'recover');assert.equal(restored.code,0,restored.errors);
    assert.equal(inspect(value).effectState,'restored');assert.equal(inspect(value).canRecover,false);
    assert.equal(fs.readFileSync(path.join(value.hermes,'.env'),'utf8'),'DUMMY_SETTING=preserved\n');
    assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'old-program');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('recovery can itself be interrupted without deleting either the old data or the failed new tree',{timeout:25000},async()=>{
  const value=fixture();
  try{
    assert.notEqual((await run(value,1,'install','runtime.next-activated')).code,0);assert.equal(inspect(value).canRecover,true);
    assert.notEqual((await run(value,2,'recover','runtime.failed-tree-preserved')).code,0);
    const halfway=inspect(value);assert.equal(halfway.effectState,'changed');assert.equal(halfway.canRecover,true);
    assert.equal((await run(value,3,'recover')).code,0);assert.equal(inspect(value).effectState,'restored');
    const journal=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));
    assert.equal(fs.readFileSync(path.join(journal.paths.failed,'logs/new-stage.log'),'utf8'),'new failure evidence');
    assert.equal(fs.readFileSync(path.join(value.hermes,'logs/old-record.log'),'utf8'),'old evidence');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('a validated component retains its previous tree for explicit whole-operation rollback',{timeout:20000},async()=>{
  const value=fixture();
  try{
    const installed=await run(value,1);assert.equal(installed.code,0,installed.errors);
    assert.equal(inspect(value).reason,'committed');assert.equal(inspect(value).hasChanges,true);assert.equal(inspect(value).canResume,true);assert.equal(inspect(value).canRecover,true);
    assert.equal(fs.readFileSync(path.join(value.hermes,'.env'),'utf8'),'DUMMY_SETTING=preserved\n');
    assert.equal((await run(value,2,'recover')).code,0);assert.equal(inspect(value).effectState,'restored');
    assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'old-program');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('a missing or modified old backup blocks committed rollback before moving the working new version',{timeout:25000},async()=>{
  for(const scenario of ['missing','modified']){
    const value=fixture();
    try{
      assert.equal((await run(value,1)).code,0);
      const journal=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));
      if(scenario==='missing')fs.renameSync(journal.paths.backup,path.join(value.root,'kept-old-backup'));
      else fs.writeFileSync(path.join(journal.paths.backup,'.env'),'DUMMY_SETTING=changed\n');
      if(scenario==='missing')assert.equal(inspect(value).canRecover,false);
      const refused=await run(value,2,'recover');assert.equal(refused.code,2);assert.match(refused.text,/RUNTIME_BACKUP_CHANGED/);
      assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'new-program');
      assert.equal(fs.existsSync(journal.paths.failed),false);
    }finally{fs.rmSync(value.root,{recursive:true,force:true});}
  }
});
test('restoring files does not claim runtime verification when the restored component probe fails',{timeout:25000},async()=>{
  const value=fixture();
  try{
    assert.equal((await run(value,1)).code,0);
    assert.equal((await run(value,2,'recover','',{NORA_FIXTURE_VERIFY_FAILURE:'1'})).code,2);
    assert.equal(inspect(value).effectState,'restored');assert.equal(inspect(value).recoveryOutcome,'recovery-required');
    assert.equal(inspect(value).canRecover,true);assert.equal(inspect(value).reason,'runtime-verification-required');
    assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'old-program');
    assert.equal((await run(value,3,'recover')).code,0);assert.equal(inspect(value).recoveryOutcome,'restored');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('a retry archives the preceding failed attempt instead of deleting its journal or files',{timeout:25000},async()=>{
  const value=fixture();
  try{
    assert.equal((await run(value,1,'install','',{NORA_FIXTURE_PREPARE_FAILURE:'1'})).code,2);
    assert.equal((await run(value,2)).code,0);
    const current=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));assert.equal(current.attempt,2);
    const previous=JSON.parse(fs.readFileSync(current.precedingEvidence,'utf8'));assert.equal(previous.journal.primaryFailure.code,'EPERM');
    assert.equal(fs.readFileSync(path.join(path.dirname(current.precedingEvidence),'tree/hermes-runtime/logs/new-stage.log'),'utf8'),'new failure evidence');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('an unowned partial tree is not overwritten',{timeout:20000},async()=>{
  const value=fixture();
  try{
    fs.rmSync(path.join(value.hermes,'hermes-agent/.hermes-bootstrap-complete'));
    const refused=await run(value,1);assert.equal(refused.code,2);assert.match(refused.text,/RUNTIME_PARTIAL_UNCONFIRMED/);
    assert.equal(fs.readFileSync(path.join(value.hermes,'.env'),'utf8'),'DUMMY_SETTING=preserved\n');
    assert.equal(inspect(value).reason,'no_journal');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('an unfamiliar live directory blocks recovery without overwriting the old backup or new evidence',{timeout:25000},async()=>{
  const value=fixture();
  try{
    assert.notEqual((await run(value,1,'install','runtime.next-activated')).code,0);
    const journal=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));
    const retained=path.join(value.root,'retained-new-tree');fs.renameSync(value.hermes,retained);
    fs.mkdirSync(value.hermes);fs.writeFileSync(path.join(value.hermes,'unfamiliar-user-file'),'do not overwrite');
    assert.equal(inspect(value).effectState,'unknown');assert.equal(inspect(value).canRecover,false);
    const refused=await run(value,2,'recover');assert.equal(refused.code,2);assert.match(refused.text,/RUNTIME_IDENTITY_UNKNOWN/);
    assert.equal(fs.readFileSync(path.join(value.hermes,'unfamiliar-user-file'),'utf8'),'do not overwrite');
    assert.equal(fs.readFileSync(path.join(journal.paths.backup,'.env'),'utf8'),'DUMMY_SETTING=preserved\n');
    assert.equal(fs.readFileSync(path.join(retained,'logs/new-stage.log'),'utf8'),'new failure evidence');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});


test('runtime tools receive the verified canonical directory rather than an ancestor alias',{timeout:20000},async()=>{
  const value=fixture();
  try{
    const source=fs.readFileSync(path.join(value.root,'fixture-tools.cjs'),'utf8');
    fs.writeFileSync(path.join(value.root,'fixture-tools.cjs'),source.replace('async validateRuntimeAsync(home){',
      'async validateRuntimeAsync(home){if(require("node:fs").realpathSync(home)!==home)throw new Error("runtime directory was not canonical");'));
    const result=await run(value,1);assert.equal(result.code,0,result.text+result.errors);
    assert.equal(inspect(value).reason,'committed');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});

// Windows PowerShell initializes special folders beneath USERPROFILE even when
// -NoProfile is used. The pre-transaction ACK must never point that at Hermes.
test('fresh bootstrap profile initialization cannot create the managed target before its journal',{timeout:25000},async()=>{
  const value=fixture();
  try{
    fs.rmSync(value.hermes,{recursive:true});
    const worker=fs.readFileSync(value.worker,'utf8').replace('const delegate=await connect();',
      `const delegate=await connect();process.stdout.write(JSON.stringify({bootstrapFacts:{home:process.env.HOME,userprofile:process.env.USERPROFILE,targetExists:require('node:fs').existsSync(hermesHome)}})+'\\n');`);
    fs.writeFileSync(value.worker,worker);
    const installed=await run(value,1,'install','',{HOME:value.hermes,USERPROFILE:value.hermes,
      APPDATA:path.join(value.home,'appdata/roaming'),LOCALAPPDATA:path.join(value.home,'appdata/local')});
    assert.equal(installed.code,0,installed.text+installed.errors);
    const facts=installed.text.trim().split('\n').map(JSON.parse).find(value=>value.bootstrapFacts).bootstrapFacts;
    assert.equal(facts.targetExists,false,'process-identity initialization must not create Hermes before the component journal');
    const profile=path.join(fs.realpathSync(value.home),'installer','operations',value.operationId,'bootstrap-profile');
    assert.equal(facts.home,profile);assert.equal(facts.userprofile,profile);
    assert.equal(inspect(value).canResume,true);
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
