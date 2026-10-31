const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createSkillUpdateReceiver, finishHandoff,desktopRequest,desktopStatus } = require('../installer/desktop/skill-update');
const capability=require('../installer/desktop/launcher-capability');

async function fixture(t, execute, extra = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill update ')));
  const receiver = createSkillUpdateReceiver({ home: () => home, busy: () => false, execute, ...extra });
  t.after(() => { receiver.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await receiver.tick();
  const directory = path.join(home, 'installer/skill-update');
  const file = path.join(directory, 'request.json');
  const endpoint = JSON.parse(fs.readFileSync(path.join(directory, 'endpoint.json')));
  function submit(changes = {}) {
    const request = { schema: 1, id: randomUUID(), action: 'update', confirm: true,
      createdAt: Date.now(), session: endpoint.session, status: 'queued', ...changes };
    fs.writeFileSync(file, JSON.stringify(request));
    return request;
  }
  return { home, receiver, submit, status: () => JSON.parse(fs.readFileSync(file)) };
}
test('skill request hands off exactly once, with a persistent successful result', async t => {
  let calls = 0, finish;
  const f = await fixture(t, async action => {
    calls++; assert.equal(action, 'update');
    await new Promise(resolve => { finish = resolve; });
    return { version: '2.4.0', systemReady: true };
  });
  const request = f.submit();
  const task = f.receiver.tick();
  assert.equal(f.status().status, 'running');
  await f.receiver.tick();
  assert.equal(calls, 1);
  finish(); await task;
  assert.equal(f.status().id, request.id);
  assert.equal(f.status().result.systemReady, true);
  await f.receiver.tick();
  assert.equal(calls, 1);
});
test('busy launcher waits; expired or unconfirmed requests never execute', async t => {
  let busy = true;
  const f = await fixture(t, () => assert.fail('must not execute'), { busy: () => busy });
  f.submit({ createdAt: Date.now() - 70000 });
  await f.receiver.tick();
  assert.equal(f.status().status, 'queued');
  busy = false; await f.receiver.tick();
  assert.equal(f.status().status, 'error');
  f.submit({ confirm: false }); await f.receiver.tick();
  assert.equal(f.status().status, 'error');
});
test('restarting launcher never replays an accepted task', async t => {
  const f = await fixture(t, () => assert.fail('must not execute'));
  f.submit({ status: 'running', session: 'old-session' });
  await f.receiver.tick();
  assert.equal(f.status().status, 'interrupted');
});
test('application restart is not success until the unified update finishes', async t => {
  const f = await fixture(t, async () => ({ restarting: true }));
  const request = f.submit();
  await f.receiver.tick();
  assert.equal(f.status().status, 'restarting');
  finishHandoff(f.home, 'different-id', { version: '2.4.0' });
  assert.equal(f.status().status, 'restarting');
  finishHandoff(f.home, request.id, { version: '2.4.0', systemReady: true });
  assert.equal(f.status().status, 'success');
  await f.receiver.tick();
  assert.equal(f.status().result.version, '2.4.0');
});
test('failures remain failures and diagnostic secrets are cleaned', async t => {
  const f = await fixture(t, async () => { throw new Error('token secret'); }, { clean: value => value.replace('secret', '[redacted]') });
  f.submit(); await f.receiver.tick();
  assert.equal(f.status().status, 'error');
  assert.equal(f.status().error, 'token [redacted]');
});
test('desktop requests advertise support and preserve their scope through the existing receiver',async t=>{
  let received;
  const f=await fixture(t,async(action,id,options)=>{received={action,id,options};return {updateComplete:true,version:'2.5.6',launcherVersion:'2.2.6',systemReady:true};});
  const endpoint=JSON.parse(fs.readFileSync(path.join(f.home,'installer/skill-update/endpoint.json')));
  assert.equal(endpoint.desktopProtocol,'nora-desktop-update/1');
  const request=f.submit({scope:'desktop'});await f.receiver.tick();
  assert.equal(received.id,request.id);assert.equal(received.options.scope,'desktop');
  assert.equal(f.status().result.launcherVersion,'2.2.6');
});
test('desktop update never treats an APP restart or a component-only reply as full success',async t=>{
  const f=await fixture(t,async()=>({version:'2.5.6',systemReady:true}));
  f.submit({scope:'desktop'});await f.receiver.tick();
  assert.equal(f.status().status,'error');
  assert.equal(f.status().code,'DESKTOP_UPDATE_INCOMPLETE');
});
test('a restarting desktop sequence is retained across receiver sessions for canonical continuation',async t=>{
  const f=await fixture(t,()=>assert.fail('a restart must not replay the submission'));
  f.submit({scope:'desktop',status:'restarting',session:'previous-session',sequenceId:randomUUID()});
  await f.receiver.tick();assert.equal(f.status().status,'restarting');
});
async function desktopFixture(t,execute){
  const f=await fixture(t,execute),root=path.join(f.home,'app');
  const executable=process.platform==='darwin'?path.join(root,'Contents/MacOS/Nora'):path.join(root,'Nora.exe');
  const resourcesRoot=process.platform==='darwin'?path.join(root,'Contents/Resources'):path.join(root,'resources');
  const put=file=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'test APP resource',{mode:0o600});};
  for(const file of [executable,path.join(resourcesRoot,'app.asar'),path.join(resourcesRoot,
    `app.asar.unpacked/node_modules/fs-native-extensions/prebuilds/${process.platform}-${process.arch}/fs-native-extensions.node`),
    ...capability.RESOURCE_NAMES.map(name=>path.join(resourcesRoot,name))])put(file);
  await capability.register({noraHome:f.home,executable,resourcesRoot,isPackaged:true,launcherVersion:'2.2.6',port:8799});
  return {...f,resourcesRoot};
}
test('verified desktop submission joins an existing request without creating duplicate work',async t=>{
  let calls=0;const f=await desktopFixture(t,async()=>{calls++;return {updateComplete:true,version:'2.5.6',launcherVersion:'2.2.6',unchanged:true};});
  const request=()=>desktopRequest({noraHome:f.home,action:'update',confirm:true});
  const first=await request(),second=await request();assert.equal(first.requestId,second.requestId);assert.equal(second.joined,true);
  await f.receiver.tick();assert.equal(calls,1);
});
test('desktop capability absence keeps core deployments independent and an unsupported APP is explicit',async t=>{
  const none=await fixture(t,()=>{});assert.equal((await desktopRequest({noraHome:none.home,action:'update',confirm:true})).applicable,false);
  const f=await desktopFixture(t,()=>assert.fail('unsupported receiver cannot execute'));
  const endpoint=path.join(f.home,'installer/skill-update/endpoint.json'),value=JSON.parse(fs.readFileSync(endpoint));delete value.desktopProtocol;
  fs.writeFileSync(endpoint,JSON.stringify(value));
  await assert.rejects(desktopRequest({noraHome:f.home,action:'update',confirm:true}),{code:'DESKTOP_UPDATE_UNSUPPORTED'});
});
test('APP closure cannot be bypassed by the Nora submission path',async t=>{
  const f=await desktopFixture(t,()=>assert.fail('changed APP cannot execute'));
  fs.appendFileSync(path.join(f.resourcesRoot,'app.asar'),'changed');
  await assert.rejects(desktopRequest({noraHome:f.home,action:'update',confirm:true}),{code:'OPERATION_CAPABILITY_INVALID'});
});
test('closed verified APP is launched once and a read-only status never launches it',async t=>{
  const f=await desktopFixture(t,()=>{}),endpoint=path.join(f.home,'installer/skill-update/endpoint.json');fs.rmSync(endpoint);
  let launches=0,clock=Date.now();
  const result=await desktopRequest({noraHome:f.home,action:'update',confirm:true},{now:()=>clock,wait:async()=>{clock+=250;await f.receiver.tick();},
    launch:()=>{launches++;return {once(){}};}});
  assert.equal(launches,1);assert.equal(result.status,'queued');
  const status=await desktopRequest({noraHome:f.home,action:'status'});assert.equal(status.status,'queued');assert.equal(launches,1);
});
test('checking versions with a closed APP never launches it or creates an update request',async t=>{
  const f=await desktopFixture(t,()=>assert.fail('a version check cannot execute an update'));
  const endpoint=path.join(f.home,'installer/skill-update/endpoint.json');fs.rmSync(endpoint);
  let checks=0;
  const result=await desktopRequest({noraHome:f.home,action:'check'},{
    launch:()=>assert.fail('a version check cannot open the APP'),
    checkRelease:async options=>{
      checks++;
      assert.equal(options.installRoot,path.join(f.home,'tavern'));
      assert.equal(options.launcherVersion,'2.2.6');assert.equal(options.launcherDiscovery,true);
      assert.equal(options.client,'updater');assert.equal(options.channel,'stable');
      return {current:'2.5.6',latest:'v2.5.7',state:'available',releaseAvailable:true,
        launcherLatest:'2.2.7',launcherUpdateAvailable:true};
    },
  });
  assert.equal(checks,1);assert.equal(result.action,'check');assert.equal(result.status,'succeeded');assert.equal(result.settled,true);
  assert.equal(result.result.releaseAvailable,true);assert.equal(result.result.launcherUpdateAvailable,true);
  assert.equal(result.result.launcherVersion,'2.2.6');assert.equal(result.result.updateComplete,undefined);
  assert.equal(fs.existsSync(endpoint),false);
  assert.equal(fs.existsSync(path.join(f.home,'installer/skill-update/request.json')),false);
});
test('checking versions leaves an existing update request and receiver endpoint unchanged',async t=>{
  const f=await desktopFixture(t,()=>assert.fail('read-only check must not enter the receiver'));
  f.submit({scope:'desktop',status:'running'});
  const directory=path.join(f.home,'installer/skill-update');
  const request=fs.readFileSync(path.join(directory,'request.json')),endpoint=fs.readFileSync(path.join(directory,'endpoint.json'));
  const result=await desktopRequest({noraHome:f.home,action:'check'},{
    launch:()=>assert.fail('read-only check cannot launch'),
    checkRelease:async()=>({current:'2.5.6',latest:'v2.5.6',state:'current',releaseAvailable:false,launcherUpdateAvailable:false}),
  });
  assert.equal(result.status,'succeeded');assert.equal(result.result.state,'current');
  assert.deepEqual(fs.readFileSync(path.join(directory,'request.json')),request);
  assert.deepEqual(fs.readFileSync(path.join(directory,'endpoint.json')),endpoint);
});
for(const failed of [{state:'unavailable',error:'core lookup failed'},{state:'available',launcherError:'APP lookup failed'},
  {state:'blocked',compatibilityError:'incompatible target'}])
test(`read-only desktop check preserves an unconfirmed version result (${failed.state})`,async t=>{
  const f=await desktopFixture(t,()=>assert.fail('failed check must not update'));
  fs.rmSync(path.join(f.home,'installer/skill-update/endpoint.json'));
  await assert.rejects(desktopRequest({noraHome:f.home,action:'check'},{
    launch:()=>assert.fail('failed check must not open APP'),checkRelease:async()=>failed,
  }),error=>error.code==='DESKTOP_UPDATE_CHECK_FAILED'&&error.message===(failed.error||failed.launcherError||failed.compatibilityError));
  assert.equal(fs.existsSync(path.join(f.home,'installer/skill-update/request.json')),false);
});
test('read-only checking still rejects a changed APP and updating still requires confirmation before launch',async t=>{
  const f=await desktopFixture(t,()=>assert.fail('must not execute'));
  const never={launch:()=>assert.fail('unconfirmed or changed APP cannot launch'),checkRelease:()=>assert.fail('changed APP cannot be trusted')};
  fs.rmSync(path.join(f.home,'installer/skill-update/endpoint.json'));
  await assert.rejects(desktopRequest({noraHome:f.home,action:'update'},never),/explicit authorization/);
  fs.appendFileSync(path.join(f.resourcesRoot,'app.asar'),'changed');
  await assert.rejects(desktopRequest({noraHome:f.home,action:'check'},never),{code:'OPERATION_CAPABILITY_INVALID'});
});
test('a legacy or different active request is never joined as a complete desktop update',async t=>{
  const f=await desktopFixture(t,()=>{});f.submit();
  await assert.rejects(desktopRequest({noraHome:f.home,action:'update',confirm:true}),{code:'OPERATION_BUSY'});
  assert.equal(f.status().scope,undefined);
});
test('desktop success requires matching installed versions and a canonical operation belonging to this request',async t=>{
  const f=await desktopFixture(t,()=>{}),request=f.submit({scope:'desktop',status:'success'}),id=randomUUID();
  const installed=path.join(f.home,'tavern/tavern-updates/installed.json');fs.mkdirSync(path.dirname(installed),{recursive:true});
  fs.writeFileSync(installed,JSON.stringify({version:'2.5.6'}));
  const record=path.join(f.home,'installer/operations',id,'operation.json');fs.mkdirSync(path.dirname(record),{recursive:true});
  const operation={operationId:id,requestId:'skill-'+request.id,state:'succeeded',verification:'confirmed'};
  fs.writeFileSync(record,JSON.stringify(operation));
  const file=path.join(f.home,'installer/skill-update/request.json');
  fs.writeFileSync(file,JSON.stringify({...request,result:{updateComplete:true,version:'2.5.6',launcherVersion:'2.2.6',operationIds:[id]}}));
  assert.equal((await desktopStatus(f.home)).status,'succeeded');
  fs.writeFileSync(record,JSON.stringify({...operation,requestId:randomUUID()}));
  await assert.rejects(desktopStatus(f.home),/not confirmed/);
  fs.writeFileSync(record,JSON.stringify(operation));
  fs.writeFileSync(installed,JSON.stringify({version:'2.5.5'}));
  await assert.rejects(desktopStatus(f.home),/cannot be verified/);
});
test('completion reads a full sealed release plan without enlarging the submission envelope',async t=>{
  const f=await desktopFixture(t,()=>{}),id=randomUUID(),sequenceId=randomUUID();
  const request=f.submit({scope:'desktop',status:'success',sequenceId});
  const result={updateComplete:true,version:'2.5.6',launcherVersion:'2.2.6',sequenceId,operationIds:[id]};
  const put=(relative,value)=>{const file=path.join(f.home,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
  put('tavern/tavern-updates/installed.json',{version:result.version});
  const content={id:sequenceId,requests:{core:randomUUID(),launcher:randomUUID()},plan:{releaseManifestText:'sealed source inventory '.repeat(60000)}};
  const seal=()=>({...content,digest:require('node:crypto').createHash('sha256').update(JSON.stringify(content)).digest('hex')});
  put(`installer/update-sequences/${sequenceId}/request.json`,seal());
  put(`installer/operations/${id}/operation.json`,{operationId:id,requestId:content.requests.launcher,state:'succeeded',verification:'confirmed',target:content.plan});
  put('installer/skill-update/request.json',{...request,result});
  assert.equal((await desktopStatus(f.home)).status,'succeeded');
  const changed=seal();changed.requests.launcher=randomUUID();
  put(`installer/update-sequences/${sequenceId}/request.json`,changed);
  await assert.rejects(desktopStatus(f.home),/identity changed/);
  put(`installer/update-sequences/${sequenceId}/request.json`,seal());
  put('installer/skill-update/request.json',{...request,result,unexpected:'x'.repeat(65536)});
  await assert.rejects(desktopStatus(f.home),/Invalid skill update request/);
});
test('legacy receiver enters the same action and the UI routes content update to independent task', () => {
  const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
  assert.match(source, /handle\('nora:run', runAction\)/);
  assert.match(source, /await runAction\(\{ sender: null \}, \{ action: 'update'/);
  assert.match(source, /apps\/tavern-ops\/updater\/task.py/);
});
test('real Python skill refuses an unverified raw terminal record without a query closure', async t => {
  const f = await fixture(t, () => assert.fail('read-only query must not execute'));
  const hermes = path.join(f.home, 'hermes');
  fs.mkdirSync(hermes);
  fs.writeFileSync(path.join(hermes, 'nora-instance.json'), JSON.stringify({ schema: 1,
    noraHome: f.home, hermesHome: hermes, installRoot: path.join(f.home, 'tavern'), port: 18899 }));
  const jobId=randomUUID(),operationId=randomUUID();
  const job=path.join(f.home,'installer/update-jobs',jobId),operation=path.join(f.home,'installer/operations',operationId);
  fs.mkdirSync(job,{recursive:true});fs.mkdirSync(operation,{recursive:true});
  fs.writeFileSync(path.join(job,'operation-ref.json'),JSON.stringify({operationId}));
  fs.writeFileSync(path.join(operation,'operation.json'),JSON.stringify({state:'succeeded',result:{version:'2.5.2'}}));
  fs.rmSync(path.join(f.home,'installer/skill-update/endpoint.json'));
  const script = path.join(__dirname, '../skills/system/tavern-updater/scripts/update.py');
  const python = process.env.NORA_TEST_PYTHON || process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  let failure;
  try{await promisify(execFile)(python,['-B',script,'--status'],{env:{...process.env,HERMES_HOME:hermes},timeout:15000});}
  catch(error){failure=error;}
  assert.equal(failure?.code,1);
  const queried=JSON.parse(failure.stdout);
  assert.equal(queried.requestId,undefined,'without a verified reader the wrapper cannot claim which task it inspected');
  assert.equal(queried.status,'inspection-required');
  assert.equal(JSON.parse(fs.readFileSync(path.join(operation,'operation.json'))).state,'succeeded','read-only failure preserves the raw evidence');
  assert.equal(queried.settled,false);assert.equal(queried.operation,undefined);
});
