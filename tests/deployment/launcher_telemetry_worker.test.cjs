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

async function integratedFixture(t, transport, consent = true) {
  const landing = process.env.NORA_LANDING_ROOT;
  const {default:worker} = await import(pathToFileURL(path.join(landing,'server/worker.mjs')));
  const db = new DatabaseSync(':memory:');
  for (const file of ['0005_launcher_events.sql','0006_launcher_error_details.sql','0007_launcher_fault_packets.sql']) db.exec(fs.readFileSync(path.join(landing,'migrations',file),'utf8'));
  const statement = (sql,args=[])=>({bind(...values){return statement(sql,values);},async run(){return db.prepare(sql).run(...args);},async all(){return {results:db.prepare(sql).all(...args)};}});
  const env={DB:{prepare:statement},VISITOR_HASH_SECRET:'integration-only',STATS_READ_KEY:'integration-read-only'};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-outcomes-contract-'));
  let time=Date.now();
  const requests=[];
  const client=createTelemetry({file:path.join(root,'telemetry.json'),launcherVersion:'1.1.2',cohort:'new',automatic:false,now:()=>time,random:()=>0,
    fetcher:async(url,options)=>{
      assert.equal(url,'https://noratavern.com/api/launcher/events');
      assert.equal(options.headers.Authorization,undefined);
      requests.push(JSON.parse(options.body));
      const response=await worker.fetch(new Request(url,options),env);
      return transport?transport(response,requests.length):response;
    }});
  t.after(()=>{client.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
  if (consent) client.setEnabled(true);
  const date=new Date(time+28800000).toISOString().slice(0,10);
  return {client,db,env,requests,advance:()=>{time+=10000;},queue:()=>JSON.parse(fs.readFileSync(path.join(root,'telemetry.json'))).queue,
    stats:async()=>{const response=await worker.fetch(new Request(`https://noratavern.com/api/launcher/stats?from=${date}&to=${date}`,{headers:{Authorization:'Bearer integration-read-only'}}),env);assert.equal(response.status,200);return response.json();}};
}

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

test('independent model lookup cannot replace a running installation in the real monitor', {skip:!process.env.NORA_LANDING_ROOT},async t=>{
  const f=await integratedFixture(t);const operation=f.client.begin('install');f.client.stage('runtime_extract');
  await f.client.track('list_models','model_test',async()=>({models:[]}));await f.client.flush();
  const data=await f.stats();assert.equal(data.current[0].operation_id,operation);assert.equal(data.current[0].status,'running');
  assert.ok(data.operations.some(e=>e.action==='list_models'&&e.status==='succeeded'));
});
