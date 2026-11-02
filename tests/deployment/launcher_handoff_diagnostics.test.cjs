const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const vm=require('node:vm');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {DatabaseSync}=require('node:sqlite');
const {createRequire}=require('node:module');
const {captureChild,firstJsonLine,stopChild}=require('./launcher_test_lifecycle.cjs');
const desktop=path.join(__dirname,'../installer/desktop');
const {createTelemetry}=require(path.join(desktop,'telemetry'));
const {createDiagnostics}=require(path.join(desktop,'diagnostics'));
const {parse}=require(path.join(desktop,'node_modules/acorn'));
// The existing Python replacement fixture models a Windows application tree.
// Only that platform-dependent root calculation is selected here; subprocesses
// and filesystem operations still run natively on the actual test host.
const updateFile=path.join(desktop,'launcher-update.js'),loaded={exports:{}};
vm.runInNewContext(fs.readFileSync(updateFile,'utf8'),{module:loaded,require:createRequire(updateFile),
  process:{...process,platform:'win32'},Buffer,setTimeout,clearTimeout},{filename:updateFile});
const fixtureUpdate=loaded.exports;

// Actual sealed replacement fixture and Python writer. Only fault edges and
// fake launcher execution are injected; the worker, snapshots and evidence are real.
const producer=String.raw`
import importlib.util,json,sys,os
from pathlib import Path
from unittest.mock import patch
source=Path(sys.argv[1]);sys.path.insert(0,str(source.parent))
spec=importlib.util.spec_from_file_location('replacement_fixture',source)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
case=m.OperationReplacementTests('test_first_failure_is_frozen_before_restore_and_restoration_cannot_replace_it')
f=case.fixture();w=m.worker;mode=sys.argv[2]
f['plan']['target']='v2.6.4';f['plan']['releasePlan']['tag']='v2.6.4'
if mode!='live-parent':f['plan']['parentCreationTime']-=100
w.write_json(f['job']/'plan.json',f['plan']);w.prepare(f['job'])
for name in ('chat','role','world','config'):(f['home']/(name+'.fixture')).write_text('PRIVATE_USER_'+name)
print(json.dumps({'base':str(f['base']),'home':str(f['home']),'job':str(f['job']),
 'app':str(f['app']),'executable':str(f['app']/'launcher.exe'),'id':f['plan']['operationId'],
 'planDigest':f['plan']['planDigest']}),flush=True)
if sys.stdin.readline().strip()!='run':sys.exit(2)
if mode=='hard-exit':
 result=f['owner'].execute(f,edge='moving-old',check=False)
 assert result.returncode==91,result.stderr
else:
 real=w.retry_rename
 def rename(source,target):
  if (mode=='busy' and source==f['app']) or (mode=='recovery-failed' and source==f['app'].parent/('.nora-previous-'+f['plan']['token'])):
   error=PermissionError(13,'controlled sharing violation api_key=fixture-private-value',str(source),None,str(target));error.winerror=32
   raise error
  return real(source,target)
 class Child:
  polls=0
  def poll(self):
   self.polls+=1
   if self.polls==1:raise RuntimeError('controlled new launcher failure')
   return 1
 with patch.object(w,'parent_alive',return_value=False),patch.object(w,'launch_old',return_value=None),patch.object(w,'retry_rename',side_effect=rename),patch.object(w.subprocess,'Popen',return_value=Child()):
  try:w.run(f['job'])
  except (PermissionError,RuntimeError):pass
  else:raise AssertionError('injected replacement must fail')
`;

async function fixture(t,mode='busy'){
  const child=spawn(process.env.NORA_TEST_PYTHON||'python3',['-B','-c',producer,path.join(__dirname,'test_launcher_replacement.py'),mode],{env:process.env});
  const tracked=captureChild(child);let info,client;
  t.after(async()=>{client?.close();await stopChild(child);if(info)fs.rmSync(info.base,{recursive:true,force:true});});
  info=await firstJsonLine(child);const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-handoff-diagnostics-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const operation={schema:'nora-operation/1',operationId:info.id,kind:'update',stageId:'applying',state:'awaiting-handoff',
    handoffRef:info.job,planDigest:info.planDigest,snapshotSequence:1,attempt:1,totalAttempts:1,
    target:{currentVersion:'2.5.7',releasePlan:{tag:'v2.6.4'}}};
  const directory=path.join(info.home,'installer/operations',info.id);fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'operation.json'),JSON.stringify(operation));
  const options={home:info.home,executable:info.executable,helper:path.join(desktop,'replace-launcher.py'),python:process.env.NORA_TEST_PYTHON||'python3'};
  // Exercise the real main.js adapter, rather than a hand-written test route.
  const source=fs.readFileSync(path.join(desktop,'main.js'),'utf8');let callback;
  function visit(node){if(!node||typeof node!=='object')return;
    if(node.type==='Property'&&node.key?.name==='readHandoffOutcome')callback=node.value;
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);}
  visit(parse(source,{ecmaVersion:'latest'}));assert.ok(callback,'the production telemetry must bind the diagnostic reader');
  const readHandoffOutcome=vm.runInNewContext('('+source.slice(callback.start,callback.end)+')',{launcherUpdate:fixtureUpdate,launcherRecoveryOptions:()=>options});
  const diagnostics=createDiagnostics({primary:()=>path.join(root,'install.log')});
  let clock=Date.now();const requests=[];
  const config={file:path.join(root,'telemetry.json'),launcherVersion:'2.2.8',enabled:true,diagnosticDefault:true,automatic:false,
    readHandoffOutcome,now:()=>clock,operationLogs:diagnostics.readOperation,
    fetcher:async(url,init)=>{requests.push(JSON.parse(init.body));return Response.json({accepted_event_ids:JSON.parse(init.body).events?.map(e=>e.event_id)||[],rejected_event_ids:[]});}};
  client=createTelemetry(config);client.begin('update',{operationId:info.id});diagnostics.begin('update',{operationId:info.id,action:'update'});
  client.stage('update_handoff');client.finish('handoff');client.close();
  const complete=async()=>{child.stdin.end('run\n');const result=await tracked.closed;assert.equal(result.code,0,tracked.stderr);};
  const reopen=()=>{client?.close();client=createTelemetry(config);return client;};
  return {...info,root,options,operation,config,requests,diagnostics,complete,reopen,readHandoffOutcome,
    advance:()=>{clock+=400000;},get client(){return client;}};
}
function bytes(root){
  const files={};function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile())files[path.relative(root,file)]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }}walk(root);return files;
}

for(const mode of ['busy','recovery-failed','hard-exit'])test('real detached '+mode+' survives process close, restart and a later UI operation',async t=>{
  const f=await fixture(t,mode);await f.complete();
  if(mode==='busy'){
    require(path.join(desktop,'evidence-store')).createEvidenceStore({directory:path.join(f.home,'installer')})
      .begin({operationId:f.id,action:'update'}).freeze({error:new Error('outer fallback summary')});
  }
  const before=bytes(f.base);
  const outcome=await f.readHandoffOutcome(f.id,{details:true});
  assert.equal(outcome.status,mode==='hard-exit'?'interrupted':'failed',String(outcome.error?.cause?.stack||outcome.error));
  assert.equal(outcome.context.operation.operationId,f.id);
  if(mode==='busy'){
    assert.equal(outcome.error.code,'EACCES');assert.equal(outcome.context.operation.effectState,'untouched');
    assert.match(outcome.context.evidence.reviewedOutput.join('\n'),/launcher_step=moving-old.*launcher_status=cancelled/);
    assert.match(outcome.context.evidence.reviewedOutput.join('\n'),/launcher-app -> launcher-backup/);
  }else if(mode==='recovery-failed'){
    assert.match(outcome.error.message,/controlled new launcher failure/);
    assert.ok(outcome.error.secondaryErrors.some(item=>item.error.name==='PermissionError'));
    assert.equal(outcome.context.operation.recoveryOutcome,'recovery-required');
    assert.equal(outcome.context.operation.verification,'unconfirmed');
  }else assert.ok(outcome.context.evidence.missingReasons.includes('primary_detail_missing'));
  f.reopen();f.client.begin('start');f.client.finish('succeeded');await f.client.flush();
  const events=f.requests.flatMap(body=>body.events||[]);
  const final=events.findLast(event=>event.operation_id===f.id&&event.status===outcome.status&&event.fault);
  assert.ok(final,JSON.stringify(events));assert.equal(final.fault.operation.operation_id,f.id);
  assert.equal(final.fault.operation.current_version,'2.5.7');assert.equal(final.fault.operation.target_version,'2.6.4');
  assert.doesNotMatch(JSON.stringify(events),/fixture-private-value|PRIVATE_USER_|nora-durable-replace-|\/Users\//);
  assert.deepEqual(bytes(f.base),before,'diagnostic inspection must not modify recovery files or user data');
});

test('a live parent is not misreported as an interrupted detached update',async t=>{
  const f=await fixture(t,'live-parent');const before=bytes(f.base);
  assert.equal(await f.readHandoffOutcome(f.id,{details:true}),null);assert.deepEqual(bytes(f.base),before);
  await f.complete();
});

test('with details disabled the reader returns only a fixed message and technical code',async t=>{
  const f=await fixture(t);await f.complete();const outcome=await f.readHandoffOutcome(f.id,{details:false});
  assert.equal(outcome.error.code,'EACCES');assert.doesNotMatch(JSON.stringify(outcome),/controlled sharing|fixture-private-value/);
});

test('reported target comes from the sealed plan rather than an edited operation summary',async t=>{
  const f=await fixture(t);await f.complete();
  fs.writeFileSync(path.join(f.home,'installer/operations',f.id,'operation.json'),JSON.stringify({...f.operation,
    target:{releasePlan:{tag:'v99.99.99'}}}));
  const outcome=await f.readHandoffOutcome(f.id,{details:true});assert.equal(outcome.context.operation.target.releasePlan.tag,'v2.6.4');
});

test('the detached reader refuses linked, oversized, unbound and cross-installation records without reading arbitrary logs',async t=>{
  const f=await fixture(t);await f.complete();const file=path.join(f.home,'installer/operations',f.id,'operation.json'),original=fs.readFileSync(file);
  const before=bytes(f.base);
  for(const record of [{...f.operation,operationId:crypto.randomUUID()},{...f.operation,handoffRef:path.join(f.root,'job-foreign')},
    {...f.operation,planDigest:'b'.repeat(64)}]){
    fs.writeFileSync(file,JSON.stringify(record));const result=await f.readHandoffOutcome(f.id,{details:true});
    assert.equal(result.status,'interrupted');assert.ok(result.context.evidence.missingReasons.includes('evidence_missing'));
  }
  fs.writeFileSync(file,' '.repeat(256*1024+1));assert.equal((await f.readHandoffOutcome(f.id)).status,'interrupted');
  fs.rmSync(file);fs.symlinkSync(path.join(f.root,'private-config'),file);
  assert.equal((await f.readHandoffOutcome(f.id)).status,'interrupted');
  fs.rmSync(file);fs.writeFileSync(file,original);assert.deepEqual(bytes(f.base),before);
});

for(const repaired of [false,true])test('real receiver stores detached failure after offline restart and lost ACK exactly once'+(repaired?' following same-ID recovery':''), {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const f=await fixture(t);await f.complete();const before=bytes(f.base),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const file of ['0005_launcher_events.sql','0006_launcher_error_details.sql','0007_launcher_fault_packets.sql','0008_launcher_operation_logs.sql'])
    db.exec(fs.readFileSync(path.join(process.env.NORA_LANDING_ROOT,'migrations',file),'utf8'));
  const statement=(sql,args=[])=>({bind(...values){return statement(sql,values);},async run(){return db.prepare(sql).run(...args);},async all(){return {results:db.prepare(sql).all(...args)};}});
  const env={DB:{prepare:statement},VISITOR_HASH_SECRET:'integration-only',STATS_READ_KEY:'integration-read-only'};
  const {default:worker}=await import(pathToFileURL(path.join(process.env.NORA_LANDING_ROOT,'server/worker.mjs')));
  let offline=true,lost=false;
  f.config.fetcher=async(url,init)=>{if(offline)throw Error('offline');const response=await worker.fetch(new Request(url,init),env);
    if(!lost&&url.endsWith('/events')){lost=true;throw Error('lost ACK');}return response;};
  f.reopen();
  if(repaired){
    f.client.begin('repair',{operationId:f.id});f.client.finish('succeeded');
    assert.ok(f.client.rawLogSummary(f.id),'successful recovery cannot discard pending original failure logs');
    f.reopen();
  }
  await f.client.flush();assert.ok(f.client.deliverySummary(f.id).queued>0);f.reopen();offline=false;
  for(let i=0;i<15;i++){f.advance();await f.client.flush();}
  const rows=db.prepare("SELECT * FROM launcher_events WHERE operation_id=? AND event=? AND status='failed'").all(f.id,repaired?'launcher_error':'operation_finished');
  assert.equal(rows.length,1);assert.equal(rows[0].system_code,'EACCES');assert.equal(rows[0].error_code,'permission_denied');
  const fault=JSON.parse(rows[0].fault);assert.match(fault.errors[0].message,/winerror=32/);
  assert.equal(fault.operation.stage_id,'update_apply');
  assert.match(fault.output.join('\n'),/launcher_step=moving-old/);assert.equal(fault.operation.effect_state,'untouched');
  assert.equal(fault.operation.recovery_outcome,'not-required');assert.equal(fault.operation.verification,'confirmed');
  assert.doesNotMatch(rows[0].fault,/fixture-private-value|PRIVATE_USER_|nora-durable-replace-/);
  if(repaired){
    const from=new Date(Date.now()-86400000).toISOString().slice(0,10),to=new Date(Date.now()+86400000).toISOString().slice(0,10);
    const response=await worker.fetch(new Request('https://noratavern.com/api/launcher/stats?from='+from+'&to='+to,
      {headers:{Authorization:'Bearer '+env.STATS_READ_KEY}}),env);
    assert.equal(response.status,200);const stats=await response.json();
    assert.equal(stats.operations.find(row=>row.operation_id===f.id)?.status,'succeeded');
    assert.equal(stats.errors.find(row=>row.event_id===rows[0].event_id)?.operation_outcome,'succeeded');
  }
  const count=db.prepare('SELECT count(*) n FROM launcher_events').get().n;
  f.reopen();f.advance();await f.client.flush();assert.equal(db.prepare('SELECT count(*) n FROM launcher_events').get().n,count);
  assert.deepEqual(bytes(f.base),before);
});
