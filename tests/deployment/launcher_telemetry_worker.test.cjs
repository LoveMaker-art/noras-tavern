const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {DatabaseSync} = require('node:sqlite');
const desktop = fs.existsSync(path.join(__dirname,'../../launcher/desktop/telemetry.js'))
  ? path.join(__dirname,'../../launcher/desktop') : path.join(__dirname,'../installer/desktop');
const {createTelemetry} = require(path.join(desktop,'telemetry'));

test('receiver stores ordered raw operation chunks independently of error statistics', {skip:!process.env.NORA_LANDING_ROOT}, async t => {
  const f = await integratedFixture(t);
  f.db.exec(fs.readFileSync(path.join(process.env.NORA_LANDING_ROOT,'migrations/0008_launcher_operation_logs.sql'),'utf8'));
  const {default:worker} = await import(pathToFileURL(path.join(process.env.NORA_LANDING_ROOT,'server/worker.mjs')));
  const id = require('node:crypto').randomUUID(), installation = require('node:crypto').randomUUID(), logId=require('node:crypto').randomUUID();
  const send = async (index,text,final=false) => {
    const chunk = {schema:1,installation_id:installation,operation_id:id,log_id:logId,index,text,final,missing:[]};
    chunk.chunk_id = require('node:crypto').createHash('sha256').update(JSON.stringify([id,logId,index,text,final,[]])).digest('hex');
    return worker.fetch(new Request('https://noratavern.com/api/launcher/logs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(chunk)}),f.env);
  };
  const first = await send(0,'[START] install\n'); assert.equal(first.status,202);
  assert.equal((await send(0,'[START] install\n')).status,202);
  assert.equal((await send(0,'different')).status,409);
  assert.equal((await send(1,'ExtractError: invalid archive\n  at unpack (archive.js:42:3)\n',true)).status,202);
  const endpoint = `https://noratavern.com/api/launcher/logs?operation_id=${id}`;
  assert.equal((await worker.fetch(new Request(endpoint),f.env)).status,401);
  const response = await worker.fetch(new Request(endpoint,{headers:{Authorization:'Bearer integration-read-only'}}),f.env);
  assert.equal(response.status,200); const data = await response.json();
  assert.equal(data.complete,true); assert.equal(data.chunks.length,2);
  assert.match(data.chunks.map(c=>c.text).join(''),/\n  at unpack/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM launcher_events').get().n,0);
});

test('real producer raw logs resume after offline restart and lost ACK without exposing service logs or secrets', {skip:!process.env.NORA_LANDING_ROOT}, async t => {
  const f=await integratedFixture(t);
  f.db.exec(fs.readFileSync(path.join(process.env.NORA_LANDING_ROOT,'migrations/0008_launcher_operation_logs.sql'),'utf8'));
  const {default:worker}=await import(pathToFileURL(path.join(process.env.NORA_LANDING_ROOT,'server/worker.mjs')));
  const {createDiagnostics}=require(path.join(desktop,'diagnostics'));
  const {createFaultPackets}=require(path.join(desktop,'fault-packet'));
  const {createOperationLogDelivery}=require(path.join(desktop,'operation-log-delivery'));
  const {consumeLines}=require(path.join(desktop,'process-output'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-raw-log-chain-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id=require('node:crypto').randomUUID(),installation=require('node:crypto').randomUUID(),consentId=require('node:crypto').randomUUID();
  const file=path.join(root,'install.log'),fallback=path.join(root,'fallback.log'),blocked=path.join(root,'blocked');
  fs.mkdirSync(blocked);let unavailable=false,outputIndex=0;
  const diagnostics=createDiagnostics({primary:()=>unavailable?blocked:file,fallback});
  diagnostics.begin('real-child',{operationId:id,action:'install'});
  const child=require('node:child_process').spawn(process.execPath,['-e',
    'for(let i=0;i<360;i++)process.stderr.write("[INFO] unpack entry "+i+" "+"entry data ".repeat(120)+"\\n");process.stderr.write("ExtractError: invalid archive\\n  at unpack (archive.js:42:3)\\napi_key=fixture-private-key\\n");process.exitCode=7']);
  consumeLines(child.stderr,line=>{unavailable=outputIndex++%3===1;diagnostics.event({event:'log',stream:'stderr',uploadScope:'maintenance',line});});
  await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  unavailable=false;diagnostics.event({event:'log',line:'PRIVATE_HERMES_DAILY_OUTPUT',stream:'stdout'});
  diagnostics.finish('failed');
  let time=Date.now(),offline=true,lostAck=false,enabled=true;
  const options={file:path.join(root,'outbox.json'),read:diagnostics.readOperation,project:text=>createFaultPackets().text(text,Number.MAX_SAFE_INTEGER),
    now:()=>time,consent:()=>({enabled,id:consentId,installation}),fetcher:async(url,init)=>{
      if(offline)throw Error('offline');const result=await worker.fetch(new Request(url,init),f.env);
      if(!lostAck){lostAck=true;throw Error('lost ACK');}return result;}};
  let delivery=createOperationLogDelivery(options);delivery.begin(id);delivery.finish(id);await delivery.flush();
  assert.equal(delivery.summary(id).received,0);assert.ok(delivery.summary(id).queued>1);delivery.close();
  delivery=createOperationLogDelivery(options);const relocated=path.join(root,'selected-directory/outbox.json');
  assert.equal(delivery.relocate(relocated),true);assert.equal(fs.existsSync(options.file),false);delivery.close();
  offline=false;time+=400000;delivery=createOperationLogDelivery({...options,file:relocated});
  for(let i=0;i<64&&!delivery.summary(id).complete;i++){await delivery.flush();time+=400000;}
  assert.equal(delivery.summary(id).complete,true,JSON.stringify(delivery.summary(id)));
  const rows=f.db.prepare('SELECT text,missing FROM launcher_operation_logs ORDER BY chunk_index').all();
  const text=rows.map(row=>row.text).join('');
  assert.match(text,/unpack entry 0/);assert.match(text,/unpack entry 359/);assert.match(text,/\n  at unpack/);
  assert.deepEqual([...text.matchAll(/\[INFO\] unpack entry (\d+)/g)].map(match=>Number(match[1])),Array.from({length:360},(_,index)=>index));
  assert.doesNotMatch(text,/fixture-private-key|PRIVATE_HERMES_DAILY_OUTPUT/);
  assert.ok(rows.some(row=>JSON.parse(row.missing).includes('service_output_omitted')));
  const originalLog=delivery.summary(id).logId;
  delivery.begin(id);assert.notEqual(delivery.summary(id).logId,originalLog);delivery.finish(id);
  for(let i=0;i<64&&!delivery.summary(id).complete;i++){await delivery.flush();time+=400000;}
  assert.equal(delivery.summary(id).complete,true,'a second failed attempt keeps a new immutable capture under the original operation');
  assert.equal(f.db.prepare('SELECT count(DISTINCT log_id) n FROM launcher_operation_logs').get().n,2);
  const another=require('node:crypto').randomUUID();delivery.begin(another);enabled=false;delivery.sync();
  assert.equal(delivery.summary(another),null);delivery.close();
});

test('launcher events traverse the actual Worker contract and D1 schema', {skip:!process.env.NORA_LANDING_ROOT}, async t => {
  const landing = process.env.NORA_LANDING_ROOT;
  const {default:worker} = await import(pathToFileURL(path.join(landing,'server/worker.mjs')));
  assert.deepEqual(require(path.join(desktop,'telemetry-contract.json')),JSON.parse(fs.readFileSync(path.join(landing,'server/launcher-contract.json'),'utf8')));
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(landing,'migrations/0005_launcher_events.sql'),'utf8'));
  db.exec(fs.readFileSync(path.join(landing,'migrations/0006_launcher_error_details.sql'),'utf8'));
  db.exec(fs.readFileSync(path.join(landing,'migrations/0007_launcher_fault_packets.sql'),'utf8'));
  const statement = (sql,args=[])=>({bind(...values){return statement(sql,values);},async run(){return db.prepare(sql).run(...args);},async all(){return {results:db.prepare(sql).all(...args)};}});
  const env = {DB:{prepare:statement},VISITOR_HASH_SECRET:'integration-only',STATS_READ_KEY:'integration-read-only'};
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'nora-worker-contract-'));
  const client = createTelemetry({file:path.join(root,'telemetry.json'),launcherVersion:'1.1.2',cohort:'new',automatic:false,
    fetcher:(url,options)=>worker.fetch(new Request(url,options),env)});
  t.after(()=>{client.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
  client.setEnabled(true);
  const operation = client.begin('install');client.stage('runtime_extract');client.finish('failed',{code:'ENOENT'});
  await client.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'telemetry.json'))).queue.length,0);
  const date = new Date(Date.now()+28800000).toISOString().slice(0,10);
  const result = await worker.fetch(new Request(`https://noratavern.com/api/launcher/stats?from=${date}&to=${date}&operation_id=${operation}`,{headers:{Authorization:'Bearer integration-read-only'}}),env);
  assert.equal(result.status,200);
  const data = await result.json();
  assert.equal(data.timeline.at(-1).error_code,'file_not_found');
  assert.equal(data.timeline.at(-1).system_code,'ENOENT');
  assert.equal(data.timeline.at(-1).status,'failed');
  assert.notEqual(data.timeline[0].installation_id,client.settings().installationId);
});

async function integratedFixture(t, transport, consent = true, options = {}) {
  const landing = process.env.NORA_LANDING_ROOT;
  const {default:worker} = await import(pathToFileURL(path.join(landing,'server/worker.mjs')));
  const db = new DatabaseSync(':memory:');
  for (const file of ['0005_launcher_events.sql','0006_launcher_error_details.sql','0007_launcher_fault_packets.sql','0008_launcher_operation_logs.sql']) db.exec(fs.readFileSync(path.join(landing,'migrations',file),'utf8'));
  const statement = (sql,args=[])=>({bind(...values){return statement(sql,values);},async run(){return db.prepare(sql).run(...args);},async all(){return {results:db.prepare(sql).all(...args)};}});
  const env={DB:{prepare:statement},VISITOR_HASH_SECRET:'integration-only',STATS_READ_KEY:'integration-read-only'};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-outcomes-contract-'));
  let time=Date.now();
  const requests=[],rawRequests=[];
  const client=createTelemetry({file:path.join(root,'telemetry.json'),launcherVersion:'1.1.2',cohort:'new',automatic:false,now:()=>time,random:()=>0,...options,
    fetcher:async(url,options)=>{
      if(url==='https://noratavern.com/api/launcher/logs'){
        assert.equal(options.headers.Authorization,undefined);rawRequests.push(JSON.parse(options.body));
        return worker.fetch(new Request(url,options),env);
      }
      assert.equal(url,'https://noratavern.com/api/launcher/events');
      assert.equal(options.headers.Authorization,undefined);
      requests.push(JSON.parse(options.body));
      const response=await worker.fetch(new Request(url,options),env);
      return transport?transport(response,requests.length):response;
    }});
  t.after(()=>{client.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
  if (consent) client.setEnabled(true);
  const date=new Date(time+28800000).toISOString().slice(0,10);
  return {client,db,env,requests,rawRequests,reopen:()=>createTelemetry({file:path.join(root,'telemetry.json'),launcherVersion:'2.0.2',automatic:false,...options,
      fetcher:async(url,init)=>{if(url.endsWith('/logs'))rawRequests.push(JSON.parse(init.body));return worker.fetch(new Request(url,init),env);}}),
    advance:()=>{time+=10000;},queue:()=>JSON.parse(fs.readFileSync(path.join(root,'telemetry.json'))).queue,
    stats:async()=>{const response=await worker.fetch(new Request(`https://noratavern.com/api/launcher/stats?from=${date}&to=${date}`,{headers:{Authorization:'Bearer integration-read-only'}}),env);assert.equal(response.status,200);return response.json();}};
}

test('the real telemetry client uploads whole logs only after failure or interrupted restart', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const {createDiagnostics}=require(path.join(desktop,'diagnostics'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-failed-log-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const diagnostics=createDiagnostics({primary:()=>path.join(root,'install.log')});
  const f=await integratedFixture(t,undefined,true,{operationLogs:(id,cursor)=>diagnostics.readOperation(id,cursor)});
  const begin=()=>{const id=f.client.begin('update');diagnostics.begin(id,{operationId:id,action:'update'});return id;};
  const output=line=>diagnostics.event({event:'log',line,stream:'stderr',uploadScope:'maintenance'});
  begin();output('successful update original output');await f.client.flush();assert.equal(f.rawRequests.length,0);
  diagnostics.finish('succeeded');f.client.finish('succeeded');await f.client.flush();assert.equal(f.rawRequests.length,0);
  const failed=begin();output('ExtractError: update failed\n  at apply (updater.js:18:4)');await f.client.flush();assert.equal(f.rawRequests.length,0);
  diagnostics.finish('failed');f.client.finish('failed',new Error('update failed'));await f.client.flush();
  assert.equal(f.rawRequests.length,1);assert.equal(f.rawRequests[0].operation_id,failed);assert.ok(f.rawRequests[0].final);
  assert.match(f.rawRequests[0].text,/\n  at apply/);assert.doesNotMatch(f.rawRequests[0].text,/successful update original output/);
  f.advance();await f.client.flush();
  const monitor=(await f.stats()).current.find(row=>row.operation_id===failed);assert.ok(monitor);
  const {default:worker}=await import(pathToFileURL(path.join(process.env.NORA_LANDING_ROOT,'server/worker.mjs')));
  const query=new URL('https://noratavern.com/api/launcher/logs');
  query.searchParams.set('operation_id',failed);query.searchParams.set('installation_id',monitor.installation_id);
  query.searchParams.set('log_id',f.rawRequests[0].log_id);
  const response=await worker.fetch(new Request(query,{headers:{Authorization:'Bearer integration-read-only'}}),f.env);
  assert.equal(response.status,200);const log=await response.json();
  assert.equal(log.installation_id,monitor.installation_id);assert.equal(log.complete,true);
  assert.match(log.chunks.map(chunk=>chunk.text).join(''),/ExtractError: update failed\n  at apply/);
  const interrupted=begin();output('interrupted native attempt');f.client.close();
  const reopened=f.reopen();t.after(()=>reopened.close());await reopened.flush();
  assert.equal(f.rawRequests.at(-1).operation_id,interrupted);assert.match(f.rawRequests.at(-1).text,/interrupted native attempt/);
  assert.ok(f.db.prepare('SELECT count(*) n FROM launcher_operation_logs').get().n>=2);
});

test('real receiver retains success after retry errors and lost acknowledgement does not double count', {skip:!process.env.NORA_LANDING_ROOT}, async t=>{
  const f=await integratedFixture(t,(_response,n)=>{if(n===1)throw Error('lost acknowledgement');return _response;});
  f.client.begin('install');f.client.stage('download');
  f.client.report({code:'ETIMEDOUT'},{source:'release_service',site:'release.download'});
  f.client.stage('install_verify');f.client.finish('succeeded');
  f.client.status({version:'2.3.17',systemReady:true,running:true,gatewayRunning:true,clawchatConnected:true});
  await f.client.flush();assert.ok(f.queue().length>0);
  const count=f.db.prepare('SELECT count(*) n FROM launcher_events').get().n;
  f.advance();await f.client.flush();assert.equal(f.queue().length,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM launcher_events').get().n,count);
  assert.equal(f.requests[0].events[0].event_id,f.requests[1].events[0].event_id);
  const data=await f.stats();assert.equal(data.summary.new_environments,1);assert.equal(data.summary.completed_installations,1);
  assert.equal(data.summary.first_ready_installations,1);assert.equal(data.summary.failed_operations,0);
  assert.equal(data.errors[0].operation_outcome,'succeeded');
});

test('receiver pause prevents all upload; cancellation stays distinct from failure', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const f=await integratedFixture(t);f.client.begin('install');f.client.finish('cancelled');await f.client.flush();
  assert.equal((await f.stats()).summary.failed_operations,0);
  f.advance();f.env.LAUNCHER_TELEMETRY_PAUSED='true';f.client.begin('start');await f.client.flush();
  assert.equal(f.queue().length,0);const calls=f.requests.length;f.advance();await f.client.flush();assert.equal(f.requests.length,calls);
  f.client.setEnabled(false);f.client.begin('install');f.client.finish('failed',{code:'ENOENT'});await f.client.flush();assert.equal(f.requests.length,calls);
});

test('real receiver gets basic stages and outcomes without diagnostic consent, including after opt out', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const f=await integratedFixture(t,undefined,false);
  f.client.begin('install');f.client.stage('runtime_extract');f.advance();
  f.client.finish('failed',Object.assign(new Error('unconsented-private-error'),{code:'EPERM'}));await f.client.flush();
  let data=await f.stats();assert.equal(data.summary.failed_operations,1);assert.equal(data.issues.length,0);
  assert.equal(data.errors[0].fault,null);assert.equal(data.errors[0].system_code,'EPERM');assert.equal(data.errors[0].elapsed_ms,10000);
  f.client.setEnabled(true);const operation=f.client.begin('update');f.client.stage('download');
  f.client.report(new Error('queued-private-detail'));assert.ok(f.queue().some(e=>e.fault));
  f.client.setEnabled(false);f.advance();f.client.pulse();f.client.finish('succeeded');await f.client.flush();
  data=await f.stats();assert.equal(data.operations.find(e=>e.operation_id===operation).status,'succeeded');
  assert.ok(data.errors.every(e=>e.fault===null));assert.equal(data.issues.length,0);
  assert.doesNotMatch(JSON.stringify(f.requests),/unconsented-private-error|queued-private-detail/);
});

test('authorized fault packets traverse the real receiver, retain cause details, and group by fingerprint', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const f=await integratedFixture(t);const error=Object.assign(new TypeError('Cannot read property of undefined'),{code:'EPERM',syscall:'symlink',path:'/Users/private/file.js'});
  error.stack='TypeError: failure\n at install (/Users/private/launcher/main.js:42:8)';
  for(let i=0;i<2;i++){f.client.begin('install');f.client.stage('runtime_extract');f.client.finish('failed',error);await f.client.flush();f.advance();}
  const data=await f.stats();assert.equal(data.summary.failed_operations,2);
  assert.equal(data.issues.length,1);assert.equal(data.issues[0].operations,2);
  const fault=data.errors[0].fault;assert.equal(fault.errors[0].syscall,'symlink');assert.match(fault.errors[0].frames[0],/main\.js:42:8/);
  assert.ok(fault.breadcrumbs.some(e=>e.stage==='runtime_extract'));assert.doesNotMatch(JSON.stringify(fault),/Users\/private/);
});

test('real Python bridge failure reaches Worker storage with its sanitized cause and no service stderr', {
  skip:!process.env.NORA_LANDING_ROOT||!process.env.NORA_TEST_PYTHON||!fs.existsSync(process.env.NORA_TEST_PYTHON),timeout:15000,
},async t=>{
  const {spawn}=require('node:child_process');
  const vm=require('node:vm');
  const {parse}=require(path.join(desktop,'node_modules/acorn'));
  const {createFaultPackets}=require(path.join(desktop,'fault-packet'));
  const {launcherError}=require(path.join(desktop,'launcher-errors'));
  const {consumeLines}=require(path.join(desktop,'process-output'));
  const f=await integratedFixture(t);
  // The bridge projects only frames owned by its ops tree. Keep this fixture
  // beside the projected tests so the real ownership filter is exercised.
  const fixtureRoot=fs.mkdtempSync(path.join(__dirname,'.nora-python-bridge-contract-'));
  const script=path.join(fixtureRoot,'bridge_fault_fixture.py');
  fs.writeFileSync(script,`import errno
import sys
from ops.installer.launcher_bridge import fail

print('PRIVATE_HERMES_CHAT 聊天正文', file=sys.stderr, flush=True)
print('PRIVATE_MODEL_REPLY 模型回复正文 api_key=fixture-secret', file=sys.stderr, flush=True)

def fixture_start():
    try:
        raise PermissionError(errno.EACCES, '系统拒绝读取进程信息 api_key=fixture-secret', '/Users/Private Test User/hermes/config.yaml')
    except PermissionError as cause:
        raise RuntimeError('此隔离目录已有其他方式启动的 Hermes，请先关闭该进程。') from cause

try:
    fixture_start()
except RuntimeError as error:
    fail(str(error), error=error)
`);
  let child;
  t.after(()=>{if(child?.exitCode===null)child.kill();fs.rmSync(fixtureRoot,{recursive:true,force:true});});
  const source=fs.readFileSync(path.join(desktop,'main.js'),'utf8');
  const node=parse(source,{ecmaVersion:'latest'}).body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='runBridge');
  assert.ok(node);
  const projectedRoot=path.resolve(__dirname,'../..');
  const clean=value=>String(value);
  const context={diagnostics:{addSecret(){},write(){},error(){},event(){},clean},
    faultPackets:createFaultPackets({clean}),telemetry:f.client,launcherError,consumeLines,
    bridgeArgs:()=>({command:process.env.NORA_TEST_PYTHON,args:[script]}),
    launcherEnv:()=>({...process.env,PYTHONPATH:projectedRoot,PYTHONDONTWRITEBYTECODE:'1'}),installerRoot:()=>projectedRoot,
    process,processSite:()=> 'process.start',sendBridgeEvent(){},terminateProcess:proc=>proc.kill(),
    sanitizeLine:line=>line,parseJsonLine:JSON.parse,setInterval,setTimeout,clearInterval,clearTimeout,
    activeProcess:null,activeOperationContext:{snapshot:{}},cancelled:false,
    spawnMaintenance:(...args)=>{child=spawn(...args);return child;},spawn:(...args)=>{child=spawn(...args);return child;}};
  const runBridge=vm.runInNewContext(`(${source.slice(node.start,node.end)})`,context);
  const operation=f.client.begin('start');f.client.stage('start_nora');
  const failure=await runBridge('start',{service:'nora'}).then(()=>assert.fail('fixture bridge must fail'),error=>error);
  assert.equal(child.exitCode,1);assert.match(failure.message,/此隔离目录已有其他方式启动的 Hermes/);
  f.client.finish('failed',failure);await f.client.flush();
  assert.equal(f.queue().length,0);
  assert.ok(f.db.prepare('SELECT count(*) n FROM launcher_events WHERE operation_id = ?').get(operation).n>0);
  const data=await f.stats();
  assert.equal(data.summary.failed_operations,1);
  assert.equal(data.operations.find(item=>item.operation_id===operation).status,'failed');
  const fault=data.errors.find(item=>item.operation_id===operation).fault;
  assert.ok(fault);assert.ok(fault.errors.length<=4);assert.equal(fault.output.length,0);
  assert.ok(fault.errors.some(error=>error.kind==='RuntimeError'&&error.message.includes('此隔离目录已有其他方式启动的 Hermes，请先关闭该进程。')));
  assert.ok(fault.errors.some(error=>error.relation==='cause'&&error.kind==='PermissionError'&&error.code==='EACCES'));
  assert.match(fault.errors.flatMap(error=>error.frames).join('\n'),/File "bridge_fault_fixture\.py", line \d+, in fixture_start/);
  assert.ok(fault.breadcrumbs.some(item=>item.stage==='start_nora'));
  const uploaded=JSON.stringify({requests:f.requests,stats:data});
  assert.doesNotMatch(uploaded,/PRIVATE_HERMES_CHAT|PRIVATE_MODEL_REPLY|聊天正文|模型回复正文|fixture-secret|Private Test User|\/Users\//);
  assert.equal(uploaded.includes(fixtureRoot),false);
});

test('independent model lookup cannot replace a running installation in the real monitor', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const f=await integratedFixture(t);const operation=f.client.begin('install');f.client.stage('runtime_extract');
  await f.client.track('list_models','model_test',async()=>({models:[]}));await f.client.flush();
  const data=await f.stats();assert.equal(data.current[0].operation_id,operation);assert.equal(data.current[0].status,'running');
  assert.ok(data.operations.some(e=>e.action==='list_models'&&e.status==='succeeded'));
});

test('frozen Operation facts and reviewed primary/secondary errors roundtrip through the real Worker and SQLite', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const operationId=require('node:crypto').randomUUID();
  const persistent={operationId,snapshotSequence:11,target:{releasePlan:{tag:'v2.4.3'},currentVersion:'2.4.2'},planDigest:'a'.repeat(64),stageId:'applying',
    effectState:'restored',recoveryOutcome:'files-restored-start-failed',verification:'failed',attempt:2,totalAttempts:3,evidenceStatus:'saved-truncated',
    primaryFailure:{code:'PROGRAM_EXIT'},secondaryFailures:[{code:'RECOVERY_START_FAILED'}],api_key:'secret-fixture',body:'PRIVATE MODEL BODY',
    evidence:{schema:1,operationId,primary:{name:'PermissionError',message:'rename failed api_key=secret-fixture',code:'EPERM',frames:['File "C:\\Users\\Private User\\apply.py", line 42, in apply']},
      secondary:[{operation:'recover',error:{name:'RuntimeError',message:'restart failed',frames:[]}}],truncated:true,missingReasons:['unreviewed_output'],output:['PRIVATE CHAT BODY']}};
  const f=await integratedFixture(t,null,true,{operationContext:()=>persistent});
  assert.equal(f.client.begin('update',{operationId}),operationId);f.client.stage('update_apply');f.client.finish('failed',{code:'EPERM',message:'outer wrapper'});await f.client.flush();
  const row=f.db.prepare("SELECT * FROM launcher_events WHERE operation_id=? AND event='operation_finished'").get(operationId),fault=JSON.parse(row.fault);
  assert.equal(fault.schema,2);assert.equal(fault.operation.target_version,'2.4.3');assert.equal(fault.operation.current_version,'2.4.2');assert.equal(fault.operation.plan_digest,persistent.planDigest);
  assert.equal(fault.operation.recovery_outcome,'files-restored-start-failed');assert.equal(fault.evidence.local_status,'saved-truncated');assert.equal(fault.truncated,true);
  assert.match(fault.errors[fault.evidence.primary_error_index].message,/rename failed/);assert.equal(fault.evidence.secondary_error_indexes.length,1);assert.deepEqual(fault.output,[]);
  assert.doesNotMatch(JSON.stringify(f.requests),/secret-fixture|PRIVATE CHAT BODY|PRIVATE MODEL BODY|Private User|api_key":"/);
  assert.equal(f.client.deliverySummary(operationId).queued,0);assert.equal(f.client.deliverySummary(operationId).accepted,f.db.prepare('SELECT count(*) n FROM launcher_events WHERE operation_id=?').get(operationId).n);
  const stats=await f.stats();assert.deepEqual(stats.errors[0].fault,fault);assert.equal(stats.errors[0].operation_outcome,'failed');
  const {validLauncherEvent}=await import(pathToFileURL(path.join(process.env.NORA_LANDING_ROOT,'server/launcher.mjs')));
  const event=f.requests[0].events.find(event=>event.event==='operation_finished');
  for(const operation of [{...fault.operation,operation_id:require('node:crypto').randomUUID()},{...fault.operation,current_version:'api_key=secret-fixture'}, {...fault.operation,stage_id:'/Users/Private User'}])
    assert.equal(validLauncherEvent({...event,fault:{...fault,operation}}),false);
  for(const invalid of [{...fault,body:'private reply'},{...fault,errors:[{...fault.errors[0],message:'Bearer secret-fixture'}]}, {...fault,evidence:{...fault.evidence,missing_reasons:['/Users/Private User']}}])
    assert.equal(validLauncherEvent({...event,fault:invalid}),false);
});
test('automatic recovery roundtrip retains the first failure stage and reports the actual recovery outcome', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-recovery-evidence-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const {createEvidenceStore}=require(path.join(desktop,'evidence-store'));
  const {createOperationController}=require(path.join(desktop,'operation-state'));
  const evidence=createEvidenceStore({directory});let operation;
  const controller=createOperationController({directory,evidence,
    lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),
    executors:{update:async context=>{await context.stage('applying');await context.effect('changed');
      throw Object.assign(new Error('component rename denied'),{code:'EPERM',stack:'Error: denied\n at apply (update.js:42:3)'});}},
    recoverers:{update:async context=>{await context.stage('recovering');return {verification:'confirmed',effectState:'restored'};}}});
  operation=await controller.start('update',{target:{releasePlan:{tag:'v2.4.3'},currentVersion:'2.4.2'}},'recover-fixture');
  assert.equal(operation.stageId,'recovering');assert.equal(operation.state,'rolled-back');
  const f=await integratedFixture(t,null,true,{operationContext:()=>({...operation,evidence:evidence.read(operation.operationId)})});
  f.client.begin('update',{operationId:operation.operationId});f.client.stage('rollback');
  f.client.finish('failed',{code:'EPERM',message:'outer wrapper'});await f.client.flush();
  const stats=await f.stats(),fault=stats.errors.find(row=>row.event==='operation_finished').fault;
  assert.equal(fault.operation.stage_id,'applying');assert.equal(fault.operation.recovery_outcome,'restored-and-verified');
  assert.equal(fault.errors[0].code,'EPERM');assert.match(fault.errors[0].message,/component rename denied/);
  assert.ok(f.client.deliverySummary(operation.operationId).accepted>0);
});

test('legacy readonly ACK artifacts cannot become phantom operations that block the next owned write',{skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-readonly-ack-history-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const {createEvidenceStore}=require(path.join(desktop,'evidence-store')),
    {createOperationController}=require(path.join(desktop,'operation-state'));const evidence=createEvidenceStore({directory});
  const f=await integratedFixture(t,null,true,{onDelivery:({operationId,summary})=>evidence.begin({operationId}).finish({delivery:summary})});
  await f.client.track('check_update','release_check',async()=>({latest:'v2.4.3'}));await f.client.flush();
  const artifacts=fs.readdirSync(path.join(directory,'operations')).filter(name=>/^[a-f0-9-]{36}$/i.test(name));
  assert.equal(artifacts.length,1);assert.equal(fs.existsSync(path.join(directory,'operations',artifacts[0],'operation.json')),false);
  let writes=0;const controller=createOperationController({directory,evidence,lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),
    executors:{install:async()=>{writes++;return {verification:'confirmed'};}}});
  const result=await controller.start('install',{target:{fixed:'new-install'}},'new-after-readonly-check');
  assert.equal(result.state,'succeeded');assert.equal(writes,1);assert.ok(evidence.read(artifacts[0]).delivery.accepted>0);
});

test('partial ACK of rows already stored permits deduplicated retry without claiming missing events delivered', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const f=await integratedFixture(t,async(response,n)=>{
    if(n!==1)return response;const value=await response.json(),id=value.accepted_event_ids[1];return Response.json({accepted_event_ids:[id,id],rejected_event_ids:[]}, {status:202});});
  const id=f.client.begin('install');f.client.finish('succeeded');await f.client.flush();
  assert.equal(f.client.deliverySummary(id).accepted,1);assert.ok(f.client.deliverySummary(id).queued>0);
  const stored=f.db.prepare('SELECT count(*) n FROM launcher_events').get().n;f.advance();await f.client.flush();
  assert.equal(f.db.prepare('SELECT count(*) n FROM launcher_events').get().n,stored);assert.equal(f.client.deliverySummary(id).queued,0);
  assert.equal(f.client.deliverySummary(id).accepted,f.db.prepare('SELECT count(*) n FROM launcher_events WHERE operation_id=?').get(id).n);
});
test('unknown fixed-plan facts are explicitly missing; opting out still uploads the basic same-ID result', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const id=require('node:crypto').randomUUID(),f=await integratedFixture(t,null,true,{operationContext:()=>({operationId:id,stageId:'selecting',effectState:'untouched',evidenceMissingReasons:['save_failed:CAPACITY']})});
  f.client.begin('update',{operationId:id});f.client.finish('failed',{code:'ETIMEDOUT'});await f.client.flush();
  const fault=JSON.parse(f.db.prepare("SELECT fault FROM launcher_events WHERE operation_id=? AND event='operation_finished'").get(id).fault);
  assert.equal(fault.operation.target_version,null);assert.equal(fault.operation.current_version,null);assert.equal(fault.operation.plan_digest,null);
  assert.ok(fault.evidence.missing_reasons.includes('target_version_missing'));assert.ok(fault.evidence.missing_reasons.includes('plan_digest_missing'));
  assert.ok(fault.evidence.missing_reasons.includes('save_failed:CAPACITY'));
  const next=require('node:crypto').randomUUID();f.client.setEnabled(false);f.client.begin('update',{operationId:next});f.client.finish('failed',{code:'EPERM',message:'UNCONSENTED PROGRAM DETAIL'});f.advance();await f.client.flush();
  const row=f.db.prepare("SELECT * FROM launcher_events WHERE operation_id=? AND event='operation_finished'").get(next);assert.equal(row.fault,null);assert.equal(row.error_code,'permission_denied');
  assert.doesNotMatch(JSON.stringify(f.requests),/UNCONSENTED PROGRAM DETAIL/);assert.equal(f.client.deliverySummary(next).queued,0);
});
