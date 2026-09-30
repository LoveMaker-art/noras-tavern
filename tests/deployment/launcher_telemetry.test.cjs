const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const desktop = fs.existsSync(path.join(__dirname,'../../launcher/desktop/telemetry.js'))
  ? path.join(__dirname,'../../launcher/desktop') : path.join(__dirname,'../installer/desktop');
const {createTelemetry, errorCode} = require(path.join(desktop,'telemetry'));
const contract = require(path.join(desktop,'telemetry-contract.json'));

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-telemetry-'));
  let time = Date.now(); const requests = [];
  const file = path.join(root, 'telemetry.json');
  const config = {file, launcherVersion:'1.1.2', cohort:'new', platform:'win32',arch:'x64', automatic:false,
    now:()=>time, random:()=>0, fetcher:async (url, opts) => {
      const data = JSON.parse(opts.body); requests.push({url,opts,data});
      return Response.json({accepted_event_ids:data.events.map(e=>e.event_id),rejected_event_ids:[]});
    }, ...options};
  let client = createTelemetry(config);
  t.after(()=>{client.close();fs.rmSync(root,{recursive:true,force:true});});
  return {get client(){return client;},file,requests, read:()=>JSON.parse(fs.readFileSync(file)),
    advance:ms=>{time+=ms;}, restart:()=>{client.close();client=createTelemetry(config);return client;}};
}
test('default enabled; records stages, errors and actual readiness, not just installed files',async t=>{
  const f=fixture(t), c=f.client; c.begin('install');c.stage('runtime_extract');f.advance(2000);c.finish('succeeded');
  c.status({version:'2.3.17',systemReady:true,installed:true,setupCompleted:false});
  assert.equal(f.read().queue.some(e=>e.event==='runtime_first_ready'),false);
  assert.equal(f.read().queue.at(-1).stage,'wait_model');
  c.begin('start');c.stage('start_tavern');c.finish('failed',{code:'ENOSPC',message:'SECRET CHAT /Users/name'});
  c.status({version:'2.3.17',systemReady:true,running:true,gatewayRunning:true,clawchatConnected:true,setupCompleted:true});
  await c.flush();
  const events=f.requests[0].data.events;
  assert.ok(events.some(e=>e.error_code==='disk_full'));
  assert.ok(events.some(e=>e.event==='runtime_first_ready'));
  assert.ok(events.every(e=>Object.keys(e).every(k=>contract.fields.includes(k))));
  assert.equal(JSON.stringify(events).includes('SECRET'),false);
  assert.equal(f.requests[0].opts.headers.Authorization,undefined);
  assert.equal(f.read().queue.length,0);
});
test('off clears queue and persists; re-enable does not reconstruct private actions',async t=>{
  const f=fixture(t); f.client.begin('install');f.client.setEnabled(false);f.client.stage('download');await f.client.flush();
  assert.equal(f.requests.length,0);assert.equal(f.read().queue.length,0);
  const c=f.restart();assert.equal(c.settings().enabled,false);c.setEnabled(true);assert.equal(f.read().queue.length,0);
});
test('retries preserve ids, queue is bounded, heartbeat does not fake progress',async t=>{
  let count=0;
  const f=fixture(t,{fetcher:async()=>{count++;throw Error('offline');}});f.client.begin('update');f.client.stage('download');
  f.client.observe({event:'progress',current:0});f.advance(150000);f.client.pulse();
  assert.equal(f.read().queue.at(-1).progress_age_ms,150000);
  const id=f.read().queue[0].event_id;await f.client.flush();await f.client.flush();assert.equal(count,1);assert.equal(f.read().queue[0].event_id,id);
  for(let i=0;i<520;i++)f.client.pulse();assert.equal(f.read().queue.length,500);
  assert.ok(f.read().queue.some(e=>e.event==='operation_started'));
});
test('restart records interrupted, update handoff is preserved without false crash',t=>{
  const f=fixture(t);const id=f.client.begin('start');f.restart();
  assert.ok(f.read().queue.some(e=>e.operation_id===id&&e.status==='interrupted'));
  const update=f.client.begin('update');f.client.stage('update_handoff');f.client.finish('handoff');f.restart();
  assert.equal(f.client.begin('update'),update);
  assert.equal(f.read().queue.some(e=>e.operation_id===update&&e.status==='interrupted'),false);
});
test('late response after opt out and back in cannot erase the new queue',async t=>{
  let reply;
  const f=fixture(t,{fetcher:()=>new Promise(resolve=>{reply=resolve;})});const sending=f.client.flush();
  f.client.setEnabled(false);f.client.setEnabled(true);f.client.begin('start');
  reply(Response.json({paused:true}));await sending;
  assert.equal(f.read().queue.length,2);assert.equal(f.read().pauseUntil,undefined);
});
test('disabled builds do not collect; corrupt storage never blocks installation',t=>{
  const f=fixture(t,{enabled:false});f.client.begin('install');assert.equal(fs.existsSync(f.file),false);
  fs.writeFileSync(f.file,'broken');assert.doesNotThrow(()=>f.restart());assert.equal(f.client.settings().available,false);
});
test('structured error classification does not inspect messages',()=>{
  assert.equal(errorCode({code:'ENOENT'}),'missing_dependency');
  assert.equal(errorCode({code:'TIMEOUT'}),'timeout');
  assert.equal(errorCode({message:'ENOENT disk_full token=SECRET'}),'unknown');
});
