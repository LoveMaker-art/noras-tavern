const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const desktop = fs.existsSync(path.join(__dirname,'../../launcher/desktop/telemetry.js'))
  ? path.join(__dirname,'../../launcher/desktop') : path.join(__dirname,'../installer/desktop');
const {createTelemetry, errorCode} = require(path.join(desktop,'telemetry'));
const contract = require(path.join(desktop,'telemetry-contract.json'));
const vm = require('node:vm');
const { parse } = require(path.join(desktop,'node_modules/acorn'));

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
  if (options.consent !== false) client.setEnabled(true);
  t.after(()=>{client.close();fs.rmSync(root,{recursive:true,force:true});});
  return {get client(){return client;},file,requests, read:()=>JSON.parse(fs.readFileSync(file)),
    advance:ms=>{time+=ms;}, restart:()=>{client.close();client=createTelemetry(config);return client;}};
}
test('actual update preflight uploads sanitized failures only with diagnostic consent and excludes service output', async t => {
  const {EventEmitter}=require('node:events');
  const {PassThrough}=require('node:stream');
  const {createFaultPackets}=require(path.join(desktop,'fault-packet'));
  const {launcherError}=require(path.join(desktop,'launcher-errors'));
  const {consumeLines}=require(path.join(desktop,'process-output'));
  const source=fs.readFileSync(path.join(desktop,'main.js'),'utf8');
  const node=parse(source,{ecmaVersion:'latest'}).body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='runBridge');
  assert.ok(node);
  for (const [command,consent] of [['plan-update',true],['plan-update',false],['status',true]]) {
    const clean=value=>String(value).replaceAll('fixture-secret','[REDACTED]');
    const f=fixture(t,{consent,clean});
    const child=new EventEmitter();
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin={end(){}};child.pid=42;
    const context={diagnostics:{addSecret(){},write(){},error(){},event(){},clean},
      faultPackets:createFaultPackets({clean}),telemetry:f.client,launcherError,consumeLines,
      bridgeArgs:()=>({command:'fixture-python',args:[]}),launcherEnv:()=>({}),installerRoot:()=>os.tmpdir(),
      process:{platform:'win32'},processSite:()=> 'process.run',sendBridgeEvent(){},terminateProcess(){},
      sanitizeLine:line=>line,parseJsonLine:JSON.parse,setInterval,setTimeout,clearInterval,clearTimeout,
      activeProcess:null,cancelled:false,spawn:()=>{
        queueMicrotask(()=>{
          child.stdout.end(JSON.stringify({event:'error',message:'缺少系统安装记录 fixture-secret'})+'\n');
          child.stderr.end('preflight evidence fixture-secret\n');
          setImmediate(()=>child.emit('close',1,null));
        });
        return child;
      }};
    const runBridge=vm.runInNewContext(`(${source.slice(node.start,node.end)})`,context);
    f.client.begin('update');f.client.stage('verify');
    let failure;
    try {await runBridge(command);} catch(error) {failure=error;}
    assert.ok(failure);assert.match(failure.message,/缺少系统安装记录/);
    f.client.finish('failed',failure);await f.client.flush();
    const event=f.requests.flatMap(r=>r.data.events).find(e=>e.event==='operation_finished');
    assert.equal(event.error_code,'process_failed');
    assert.doesNotMatch(JSON.stringify(f.requests),/fixture-secret/);
    if (!consent) {assert.equal(event.fault,null);continue;}
    if (command==='plan-update') {
      assert.ok(event.fault.errors.some(e=>e.message.includes('缺少系统安装记录')));
      assert.ok(event.fault.output.some(line=>line.includes('preflight evidence')));
    } else {
      assert.equal(event.fault.output.length,0);
      assert.doesNotMatch(JSON.stringify(event.fault),/缺少系统安装记录|preflight evidence/);
    }
  }
});
test('the actual desktop upload gate permits explicit reporting candidates while keeping diagnostic consent separate', async t => {
  const source = fs.readFileSync(path.join(desktop,'main.js'),'utf8');
  let enabledNode;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.name === 'createTelemetry') {
      enabledNode = node.arguments[0].properties.find(item => item.key.name === 'enabled').value;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parse(source,{ecmaVersion:'latest'}));
  assert.ok(enabledNode);
  const expression = source.slice(enabledNode.start,enabledNode.end);
  for (const [packaged,localTest,beta,localRelease,expected] of [
    [true,null,false,'',true], [true,{},false,'',false],
    [true,{telemetryEnabled:false},false,'',false], [true,{telemetryEnabled:true},false,'',true],
    [true,null,true,'',false], [false,{telemetryEnabled:true},false,'',false],
    [true,{telemetryEnabled:true},false,'fixture-release',false],
  ]) {
    const enabled = vm.runInNewContext(expression,{app:{isPackaged:packaged},LOCAL_TEST:localTest,
      ISOLATED_TEST:localTest || beta,localReleaseDirectory:localRelease});
    assert.equal(enabled,expected);
    const f=fixture(t,{enabled,consent:false});
    assert.equal(f.client.settings().available,expected);
    assert.equal(f.client.settings().enabled,false);
    f.client.begin('install');f.client.stage('runtime_extract');f.client.finish('failed',new Error('unconsented-install-detail'));
    await f.client.flush();
    if (!expected) {assert.equal(f.requests.length,0);continue;}
    assert.ok(f.requests[0].data.events.some(e=>e.event==='operation_finished' && e.status==='failed'));
    assert.ok(f.requests[0].data.events.every(e=>e.fault===null));
    assert.doesNotMatch(JSON.stringify(f.requests),/unconsented-install-detail/);
    f.client.setEnabled(true);f.client.begin('repair');f.client.finish('failed',new Error('authorized-install-detail'));
    f.advance(1000);await f.client.flush();
    assert.ok(f.requests.at(-1).data.events.some(e=>e.fault));
  }
});
test('authorized collection records stages, errors and actual readiness, not just installed files',async t=>{
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
test('diagnostic opt out strips queued packets, preserves statistics and remains off after restart',async t=>{
  const f=fixture(t);f.client.begin('install');f.client.finish('failed',new Error('queued-detail'));
  const ids=f.read().queue.map(e=>e.event_id);assert.ok(f.read().queue.some(e=>e.fault));
  const operation=f.client.begin('update');f.client.setEnabled(false);
  assert.deepEqual(f.read().queue.slice(0,ids.length).map(e=>e.event_id),ids);
  assert.equal(f.read().active.id,operation);
  f.client.stage('download');f.advance(2000);f.client.pulse();f.client.finish('failed',new Error('disabled-detail'));
  await f.client.flush();assert.equal(f.requests.length,1);assert.equal(f.read().queue.length,0);
  const events=f.requests[0].data.events;
  assert.ok(events.every(e=>e.fault===null));assert.ok(events.some(e=>e.event==='heartbeat'));
  assert.ok(events.some(e=>e.operation_id===operation&&e.event==='operation_finished'&&e.elapsed_ms===2000));
  assert.doesNotMatch(JSON.stringify(events),/queued-detail|disabled-detail/);
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
  const before=f.read().queue.length;
  f.client.setEnabled(false);f.client.setEnabled(true);f.client.begin('start');
  reply(Response.json({paused:true}));await sending;
  assert.equal(f.read().queue.length,before+2);assert.equal(f.read().pauseUntil,undefined);
});
test('disabled builds do not collect; corrupt storage never blocks installation',t=>{
  const f=fixture(t,{enabled:false});f.client.begin('install');assert.equal(fs.existsSync(f.file),false);
  fs.writeFileSync(f.file,'broken');assert.doesNotThrow(()=>f.restart());assert.equal(f.client.settings().available,false);
});
test('structured error classification does not inspect messages',()=>{
  assert.equal(errorCode({code:'ENOENT'}),'file_not_found');
  assert.equal(errorCode({code:'TIMEOUT'}),'timeout');
  assert.equal(errorCode({message:'ENOENT disk_full token=SECRET'}),'unknown');
});
test('unknown exceptions retain a fixed failure site and kind without serializing private properties',async t=>{
  const f=fixture(t);
  const error=Object.assign(new TypeError('PRIVATE chat /Users/person'),{code:'PRIVATE_KEY',response:'PRIVATE response',url:'https://private.example'});
  error.cause=error;
  f.client.report(error,{source:'launcher',site:'launcher.main'});await f.client.flush();
  const last=f.requests[0].data.events.at(-1);
  assert.equal(last.error_code,'unknown');assert.equal(last.error_kind,'TypeError');assert.equal(last.error_site,'launcher.main');
  assert.equal(last.system_code,'');assert.doesNotMatch(JSON.stringify(f.requests[0].data),/PRIVATE|Users|private\.example/);
});
test('cancelled launcher operations are not counted as failures',async t=>{
  const f=fixture(t);const error=Object.assign(new Error('PRIVATE cancellation'),{name:'AbortError'});
  f.client.begin('install');f.client.finish('failed',error);
  await assert.rejects(f.client.track('list_models','model_test',async()=>{throw error;}),e=>e===error);
  await f.client.flush();
  const endings=f.requests[0].data.events.filter(e=>e.event==='operation_finished');
  assert.equal(endings.length,2);assert.ok(endings.every(e=>e.status==='cancelled'&&e.error_code==='none'&&e.error_site===''));
});
test('upgrade preserves queued v1 events alongside v2 and refuses private detail fields in a tampered queue',async t=>{
  const f=fixture(t);const saved=f.read();
  const old={...saved.queue[0],schema_version:1};for(const key of [...contract.detailFields,'fault'])delete old[key];
  saved.queue=[old];fs.writeFileSync(f.file,JSON.stringify(saved));
  f.restart();f.client.begin('start');f.client.finish('succeeded');await f.client.flush();
  const events=f.requests[0].data.events;assert.equal(events[0].schema_version,1);assert.ok(events.some(e=>e.schema_version===3));
  f.client.report(new Error('test'));const invalid=f.read();invalid.queue[0].error_site='/Users/private';
  fs.writeFileSync(f.file,JSON.stringify(invalid));f.restart();await f.client.flush();
  assert.equal(f.client.settings().available,false);assert.equal(f.requests.length,1);
});
test('model test HTTP failure reaches telemetry with technical evidence but no private response', async t => {
  const http = require('node:http');
  const {testCustomModel} = require(path.join(desktop, 'model-config'));
  const server = http.createServer((req,res) => { req.resume(); res.writeHead(401); res.end(JSON.stringify({error:{message:'PRIVATE CHAT /Users/person token=private-key'}})); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = fixture(t); f.client.begin('model'); f.client.stage('model_test');
  await assert.rejects(testCustomModel(`http://127.0.0.1:${server.address().port}/v1`, 'private-key', 'private-model'), error => {
    f.client.finish('failed', error); return true;
  });
  await f.client.flush();
  const events = f.requests.flatMap(r => r.data.events);
  const failure = events.find(e => e.event === 'operation_finished');
  assert.equal(failure.http_status, 401);
  assert.equal(failure.error_source, 'model_service');
  assert.equal(failure.error_site, 'model.test');
  assert.equal(failure.error_code, 'http_unauthorized');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|private-key|private-model|127\.0\.0\.1|Users/);
});
test('launcher-only observation ignores runtime logs, deduplicates reported errors, and keeps process evidence', async t => {
  const f=fixture(t);f.client.begin('start');f.client.stage('start_tavern');
  f.client.observe({event:'error',code:'ENOSPC',message:'PRIVATE MVU failure'});
  f.client.observe({event:'log',line:'PRIVATE Hermes conversation'});
  const error=Object.assign(new Error('PRIVATE process output'),{remoteMessage:'Launcher service failed.',exitCode:2,signal:'SIGTERM',source:'launcher_process',site:'process.start'});
  f.client.report(error);f.client.report(error);
  f.client.finish('failed',error);await f.client.flush();
  const events=f.requests.flatMap(r=>r.data.events);
  assert.equal(events.filter(e=>e.event==='launcher_error').length,1);
  const last=events.at(-1);assert.equal(last.exit_code,2);assert.equal(last.exit_signal,'SIGTERM');
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE|MVU|Hermes/);
});
test('independent launcher checks retain basic completion and install ownership across consent changes', async t => {
  const f=fixture(t);const install=f.client.begin('install');let finish;
  const check=f.client.track('check_update','release_check',()=>new Promise(resolve=>{finish=resolve;}));
  assert.equal(f.read().active.id,install);
  f.client.setEnabled(false);f.client.setEnabled(true);finish({});await check;
  assert.equal(f.read().active.id,install);
  assert.ok(f.read().queue.some(e=>e.action==='check_update'&&e.event==='operation_finished'&&e.status==='succeeded'));
  const disabled=fixture(t,{enabled:false});await disabled.client.track('check_update','release_check',async()=>({}));
  assert.equal(fs.existsSync(disabled.file),false);
});
test('release transport retry is associated with its launcher check and eventual success', async t => {
  const {createReleaseNetwork}=require(path.join(desktop,'release-network'));let attempts=0;
  const f=fixture(t);
  const network=createReleaseNetwork({app:{whenReady:async()=>{}},diagnostics:{write(){},error(){}},
    onRetry:error=>f.client.report(error),net:{fetch:async()=>{if(++attempts===1)throw Error('net::ERR_NETWORK_CHANGED');return new Response('{}');}}});
  await f.client.track('check_update','release_check',()=>network.fetch('https://github.com/example'));
  await f.client.flush();const events=f.requests.flatMap(r=>r.data.events);
  const error=events.find(e=>e.event==='launcher_error');assert.equal(error.system_code,'ERR_NETWORK_CHANGED');
  assert.equal(error.attempt,1);assert.equal(error.operation_id,events.at(-1).operation_id);assert.equal(events.at(-1).status,'succeeded');
});
test('failed isolated runtime worker exposes exit evidence, not its output or temporary paths', async t => {
  const {spawnSync}=require('node:child_process');
  const {launcherError}=require(path.join(desktop,'launcher-errors'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'launcher-process-private-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'nora-hermes-runtime.json'),JSON.stringify({schema:999}));
  const child=spawnSync(process.execPath,[path.join(desktop,'runtime-worker.js'),root,path.join(root,'home'),path.join(root,'hermes')],{encoding:'utf8'});
  assert.equal(child.status,1);
  const f=fixture(t);f.client.begin('install');f.client.stage('runtime_extract');
  const record=child.stdout.trim().split('\n').map(line=>{try{return JSON.parse(line);}catch{return {};}}).find(e=>e.event==='error');
  assert.ok(record, 'the worker itself must return the error, not fail loading its modules');
  f.client.finish('failed',launcherError(child.stderr,{source:'launcher_process',site:'process.run',exitCode:child.status,signal:child.signal,code:record?.code}));
  await f.client.flush();const events=f.requests.flatMap(r=>r.data.events);
  assert.equal(events.at(-1).exit_code,1);assert.equal(events.at(-1).error_source,'launcher_process');
  assert.equal(JSON.stringify(events).includes(root),false);assert.equal(events.at(-1).fault.output.length,0);
});

test('detailed diagnostics require fresh explicit consent, including upgrades from stage statistics', async t => {
  const f=fixture(t,{consent:false});
  assert.equal(f.client.settings().enabled,false);
  f.client.begin('install');f.client.report(new Error('before authorization'));
  await f.client.flush();assert.equal(f.requests.length,1);assert.ok(f.requests[0].data.events.every(e=>e.fault===null));
  assert.doesNotMatch(JSON.stringify(f.requests),/before authorization/);
  f.client.setEnabled(true);f.client.begin('install');f.client.finish('failed',new Error('authorized failure'));
  const legacy=f.read();delete legacy.consentVersion;legacy.enabled=true;
  fs.writeFileSync(f.file,JSON.stringify(legacy));f.restart();
  assert.equal(f.client.settings().enabled,false);await f.client.flush();assert.equal(f.requests.length,2);
  assert.ok(f.requests[1].data.events.every(e=>e.fault===null));
  f.client.setEnabled(true);await f.client.flush();
  assert.doesNotMatch(JSON.stringify(f.requests),/authorized failure|before authorization/);
  f.client.setEnabled(false);f.restart();assert.equal(f.client.settings().enabled,false);
});

test('basic statistics upload without consent after restart; newly authorized tasks alone gain fault packets',async t=>{
  const f=fixture(t,{consent:false});const id=f.client.settings().installationId;
  const oldOperation=f.client.begin('install');f.client.stage('runtime_extract');
  f.client.setEnabled(true);f.client.finish('failed',new Error('started-before-consent'));
  const authorized=f.client.begin('update');f.client.finish('failed',new Error('new-authorized-task'));
  const oldFailure=f.read().queue.find(e=>e.operation_id===oldOperation&&e.event==='operation_finished');
  const newFailure=f.read().queue.find(e=>e.operation_id===authorized&&e.event==='operation_finished');
  assert.equal(oldFailure.fault,null);assert.match(JSON.stringify(newFailure.fault),/new-authorized-task/);
  f.client.setEnabled(false);await f.client.flush();assert.ok(f.requests[0].data.events.every(e=>e.fault===null));
  f.restart();assert.equal(f.client.settings().installationId,id);assert.equal(f.client.settings().enabled,false);
  const current=f.client.begin('start');f.advance(9000);f.client.finish('succeeded');await f.client.flush();
  const completion=f.requests.at(-1).data.events.find(e=>e.operation_id===current&&e.event==='operation_finished');
  assert.equal(completion.elapsed_ms,9000);assert.equal(completion.fault,null);
});

test('self-update handoff keeps its original detailed consent across restart without gaining a later one',async t=>{
  for (const initialConsent of [false,true]) {
    for (const reauthorize of [false,true]) {
      const f=fixture(t,{consent:initialConsent});const operation=f.client.begin('update');
      f.client.stage('update_handoff');f.client.finish('handoff');
      if (reauthorize) { f.client.setEnabled(false);f.client.setEnabled(true); }
      else if (!initialConsent) f.client.setEnabled(true);
      f.restart();assert.equal(f.client.begin('update'),operation);
      f.client.finish('failed',new Error('handoff-failure'));
      const failure=f.read().queue.find(e=>e.event==='operation_finished'&&e.status==='failed');
      assert.equal(failure.operation_id,operation);
      assert.equal(Boolean(failure.fault),initialConsent&&!reauthorize);
    }
  }
});

test('fault packets retain technical cause, source frames and installer evidence while stripping private material', async t => {
  const {createFaultPackets,validFaultPacket}=require(path.join(desktop,'fault-packet'));
  const clean=value=>String(value).replaceAll('short-key-fixture','[REDACTED]').replaceAll('pair-fixture','[REDACTED]');
  const projection=createFaultPackets({clean,roots:()=>['/Users/private/Nora'],environment:{launcher_build:'b'.repeat(64)}});
  const collector=projection.collector(true);
  collector.observe({event:'diagnostic',error:{name:'PermissionError',message:"EPERM symlink '/Users/private/Nora/skills/apple'",code:'EPERM',syscall:'symlink',path:'/Users/private/Nora/skills/apple',stack:'File "/Users/private/Nora/install.py", line 42, in install'}});
  collector.observe({event:'log',stream:'combined',line:'tool failed key=short-key-fixture pair_code=pair-fixture https://private.example/token'});
  const cause=Object.assign(new TypeError('copy failed'),{code:'EPERM',syscall:'symlink',path:'C:\\Users\\Private Name\\Nora\\file.py',stack:'TypeError: private\n at copy (C:\\Users\\Private Name\\Nora\\main.js:42:8)'});
  const {launcherError}=require(path.join(desktop,'launcher-errors'));
  const error=collector.attach(launcherError('installer failed',{source:'launcher_process',site:'process.run',exitCode:1},cause));
  const f=fixture(t,{clean,roots:()=>['/Users/private/Nora'],environment:{launcher_build:'b'.repeat(64)}});
  f.client.begin('install');f.client.stage('runtime_extract');f.client.finish('failed',error);await f.client.flush();
  const failure=f.requests.flatMap(r=>r.data.events).find(e=>e.event==='operation_finished');
  const packet=failure.fault;assert.equal(validFaultPacket(packet),true);
  assert.equal(failure.error_kind,'TypeError');assert.ok(packet.errors.some(e=>e.relation==='cause'&&e.syscall==='symlink'));
  assert.ok(packet.errors.some(e=>e.relation==='child'));assert.ok(packet.errors.flatMap(e=>e.frames).some(s=>s.includes('main.js:42:8')));
  assert.ok(packet.breadcrumbs.some(e=>e.stage==='runtime_extract'));assert.equal(packet.environment.launcher_build,'b'.repeat(64));
  assert.match(JSON.stringify(packet),/copy failed|installer failed/);
  assert.doesNotMatch(JSON.stringify(packet),/Private Name|Users|short-key-fixture|pair-fixture|private\.example|skills\/apple/);
  collector.observe({event:'log',stream:'combined',line:'{"messages":[{"content":"private model reply"}]}'});
  assert.doesNotMatch(JSON.stringify(projection.packet(collector.attach(error),{action:'install'})),/private model reply/);
});

test('service failures exclude runtime output and provider response text from fault packets',async t=>{
  const {createFaultPackets}=require(path.join(desktop,'fault-packet'));
  const packets=createFaultPackets();const collector=packets.collector(false);
  collector.observe({event:'log',stream:'stderr',line:'PRIVATE Hermes conversation'});
  const error=collector.attach(Object.assign(new Error('launcher service failed'),{source:'launcher_process'}));
  assert.equal(packets.packet(error,{action:'start'}).output.length,0);
  const f=fixture(t);await assert.rejects(f.client.track('list_models','model_test',async()=>{
    throw Object.assign(new Error('PRIVATE provider reply'),{source:'model_service',site:'model.list'});
  }));await f.client.flush();assert.doesNotMatch(JSON.stringify(f.requests),/PRIVATE provider reply/);
});

test('operation history only projects bounded contract values even from modified local state',()=>{
  const {createFaultPackets,validFaultPacket}=require(path.join(desktop,'fault-packet'));
  const packet=createFaultPackets().packet(new Error('failed'),{action:'install',history:[
    {event:'stage_started',stage:'runtime_extract',status:'running',elapsed_ms:5,private:'private-history'},
    {event:'private-history',stage:'runtime_extract',status:'running',elapsed_ms:5},
    {event:'stage_started',stage:'private-history',status:'running',elapsed_ms:5},
    {event:'stage_started',stage:'runtime_extract',status:'private-history',elapsed_ms:5},
    {event:'stage_started',stage:'runtime_extract',status:'running',elapsed_ms:'private-history'},
  ]});
  assert.equal(validFaultPacket(packet),true);
  assert.equal(packet.breadcrumbs.length,1);
  assert.doesNotMatch(JSON.stringify(packet),/private-history/);
});

test('packet and batch budgets hold for multi-byte output; persisted evidence is revalidated',async t=>{
  const {createFaultPackets,validFaultPacket}=require(path.join(desktop,'fault-packet'));
  const projection=createFaultPackets(),collector=projection.collector(true);
  for(let i=0;i<30;i++) collector.observe({event:'log',stream:'stderr',line:'诊断'.repeat(1500)});
  const error=collector.attach(new Error('unknown installer fault'));
  const f=fixture(t);for(let i=0;i<8;i++) {f.client.begin('install');f.client.stage('runtime_extract');f.client.finish('failed',error);}
  while(f.read().queue.length) {await f.client.flush();f.advance(2000);}
  assert.ok(f.requests.length>1);
  for(const request of f.requests) {
    assert.ok(Buffer.byteLength(request.opts.body)<=contract.faultLimits.batchBytes);
    for(const e of request.data.events.filter(e=>e.fault)) {assert.equal(validFaultPacket(e.fault),true);assert.ok(Buffer.byteLength(JSON.stringify(e.fault))<=contract.faultLimits.packetBytes);assert.equal(e.fault.truncated,true);}
  }
  f.client.report(error);const saved=f.read();saved.queue[0].fault.errors[0].privateKey='do-not-send';
  fs.writeFileSync(f.file,JSON.stringify(saved));f.restart();assert.equal(f.client.settings().available,false);
});

test('long operations retain basic failure and their identity without detailed evidence after consent changes',async t=>{
  const f=fixture(t);f.client.begin('install');let resume;
  const pending=f.client.scope(async()=>{await new Promise(resolve=>resume=resolve);f.client.report(new Error('old operation'));f.client.finish('failed',new Error('old finish'));});
  f.client.setEnabled(false);f.client.setEnabled(true);resume();await pending;
  const failure=f.read().queue.find(e=>e.event==='operation_finished');
  const retry=f.read().queue.find(e=>e.event==='launcher_error');
  assert.equal(failure.status,'failed');assert.equal(retry.operation_id,failure.operation_id);
  assert.equal(failure.fault,null);assert.equal(retry.fault,null);
  f.client.begin('start');f.client.finish('succeeded');await f.client.flush();assert.doesNotMatch(JSON.stringify(f.requests),/old operation|old finish/);
});

test('installer diagnostic causes survive child projection and diagnostic redaction failures fail closed',()=>{
  const {createFaultPackets}=require(path.join(desktop,'fault-packet'));
  const packets=createFaultPackets(),child=packets.collector(true);
  child.observe({event:'diagnostic',error:{name:'RuntimeError',message:'extraction failed',cause:{name:'PermissionError',message:'access denied',code:'EPERM',syscall:'symlink'},secondaryErrors:[{operation:'cleanup',error:{name:'OSError',message:'cleanup denied',code:'EACCES',syscall:'unlink'}}]}});
  const packet=packets.packet(child.attach(new Error('worker failed')),{action:'install'});
  assert.ok(packet.errors.some(e=>e.kind==='PermissionError'&&e.relation==='cause'&&e.syscall==='symlink'));
  assert.ok(packet.errors.some(e=>e.relation==='secondary'&&e.code==='EACCES'&&e.syscall==='unlink'));
  const broken=createFaultPackets({clean:()=>{throw Error('redaction unavailable');}});
  const collector=broken.collector(true);
  assert.doesNotThrow(()=>collector.observe({event:'log',stream:'stderr',line:'private-credential'}));
  assert.doesNotMatch(JSON.stringify(broken.packet(collector.attach(new Error('private-credential')),{action:'install'})),/private-credential/);
  assert.equal(packets.packet('primitive failure',{action:'install'}).errors[0].message,'primitive failure');
});

test('space-containing private paths and safe model-helper messages survive all wrapping boundaries',()=>{
  const {createFaultPackets,validFaultPacket}=require(path.join(desktop,'fault-packet'));
  const {launcherError}=require(path.join(desktop,'launcher-errors'));
  const packets=createFaultPackets({roots:()=>['/Users/alice']});
  for(const pathValue of ['/Users/alice/My Secret Project/cache/data.json','/Users/bob/Private Photos 2026/data.json','/home/Jane Doe/private/config.yaml','C:\\Users\\Private Name\\Nora\\config.yaml','\\\\server\\Private Photos\\config.yaml']) {
    const packet=packets.packet(Object.assign(new Error(`npm error path ${pathValue}`),{path:pathValue}),{action:'install'});
    assert.equal(validFaultPacket(packet),true);assert.doesNotMatch(JSON.stringify(packet),/Secret Project|Private Photos|Jane|Doe|Private Name|server/);
  }
  const helper=Object.assign(new Error('PRIVATE_MODEL_RESPONSE personal-story-text'),{source:'launcher_process',site:'model.save',remoteMessage:'Model configuration helper failed.'});
  const wrapper=launcherError(`Model setup failed: ${helper.message}`,{site:'model.save'},helper);
  assert.doesNotMatch(JSON.stringify(packets.packet(wrapper,{action:'model'})),/PRIVATE_MODEL_RESPONSE|personal-story-text/);
});


test('desktop default enables only new diagnostic choices and preserves explicit opt out', async t => {
  const source=fs.readFileSync(path.join(desktop,'main.js'),'utf8');
  let config;
  function visit(node) {
    if(!node || typeof node!=='object')return;
    if(node.type==='CallExpression' && node.callee.name==='createTelemetry')config=node.arguments[0];
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value && typeof value==='object')visit(value);
  }
  visit(parse(source,{ecmaVersion:'latest'}));
  const defaultNode=config.properties.find(p=>p.key.name==='diagnosticDefault');
  assert.ok(defaultNode,'desktop must explicitly select the user-visible diagnostic default');
  const diagnosticDefault=vm.runInNewContext(source.slice(defaultNode.value.start,defaultNode.value.end));
  assert.equal(diagnosticDefault,true);
  const f=fixture(t,{diagnosticDefault,consent:false});
  assert.equal(f.client.settings().enabled,true);
  f.client.begin('install');f.client.finish('failed',new Error('default-program-error'));
  await f.client.flush();assert.ok(f.requests[0].data.events.some(e=>e.fault));
  f.client.setEnabled(false);const restarted=f.restart();assert.equal(restarted.settings().enabled,false);
  restarted.begin('repair');restarted.finish('failed',new Error('opted-out-program-error'));
  f.advance(1100);await restarted.flush();assert.ok(f.requests.at(-1).data.events.every(e=>e.fault===null));
  const disabled=fixture(t,{diagnosticDefault,enabled:false,consent:false});
  assert.equal(disabled.client.settings().enabled,false);
});
