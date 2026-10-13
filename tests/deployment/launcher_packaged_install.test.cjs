const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { test } = require('node:test');
const {EventEmitter}=require('node:events');
const {captureChild,stopChild}=require('./launcher_test_lifecycle.cjs');
const {bounded}=require('./launcher_owned_test_actor.cjs');
const terminal=new Set(['succeeded','failed','cancelled','rolled-back','blocked']);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function candidatePortOffline(port) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});let timer;
    const finish=(error,offline)=>{clearTimeout(timer);socket.destroy();error?reject(error):resolve(offline);};
    socket.once('connect',()=>finish(null,false));
    socket.once('error',error=>error.code==='ECONNREFUSED'?finish(null,true):finish(error));
    timer=setTimeout(()=>finish(new Error('Candidate port inspection timed out')),1000);
  });
}
async function confirmCandidateOffline(app,home,{timeoutMs=25000,nativeProbe,portProbe=candidatePortOffline}={}) {
  const deadline=Date.now()+timeoutMs;
  const page=await bounded(app.firstWindow(),deadline,'CANDIDATE_WINDOW_UNCONFIRMED');
  const invoke=(method,...args)=>bounded(page.evaluate(({method,args})=>window.NoraLauncherBridge[method](...args),
    {method,args}),deadline,'CANDIDATE_INSPECTION_TIMEOUT');
  const inspect=async()=>{
    const status=await invoke('status'),snapshot=await invoke('operationSnapshot');
    assert.notEqual(status?.statusUnavailable,true,'Unavailable status cannot prove a partial installation offline');
    assert.equal(status?.noraHome,home);assert.equal(status.port,18999);
    const pending=Boolean(status.busy||snapshot?.busy||snapshot&&!terminal.has(snapshot.state));
    return {status,snapshot,pending};
  };
  let facts=await inspect();
  if(facts.pending) {
    assert.equal(facts.status.canCancel,true,'Retain the partial installation when its actual pending operation cannot safely cancel');
    const cancelled=await invoke('cancel');assert.equal(cancelled?.ok,true,'Cancellation must be accepted by the real bridge');
    do {
      facts=await inspect();
      if(facts.pending)await bounded(delay(25),deadline,'CANDIDATE_CANCEL_CLOSE_UNCONFIRMED');
    } while(facts.pending);
  }
  assert.ok([true,false].includes(facts.status.running)&&[true,false].includes(facts.status.gatewayRunning),
    'Unknown service facts must preserve the candidate home');
  if(facts.status.running||facts.status.gatewayRunning) {
    await invoke('stop');facts=await inspect();
  }
  assert.equal(facts.pending,false,'No pending operation may be discarded');
  assert.equal(facts.status.running,false);assert.equal(facts.status.gatewayRunning,false);
  nativeProbe ||= options=>require(path.resolve(__dirname,'../installer/desktop/operation-lock.js')).probe(options);
  const guard=await bounded(nativeProbe({directory:path.join(home,'installer')}),deadline,'CANDIDATE_NATIVE_CLOSE_UNCONFIRMED');
  assert.equal(guard.busy,false);assert.equal(guard.inspectionRequired,false,'Unresolved native job facts require keeping the fixture');
  assert.ok(Array.isArray(guard.sessions)&&guard.sessions.every(session=>Array.isArray(session.jobs)
    &&session.jobs.every(job=>job.closedAt||job.spawnFailedAt)), 'Each native fixture job needs actual close or rejected-before-spawn evidence');
  assert.equal(await bounded(portProbe(18999),deadline,'CANDIDATE_PORT_UNCONFIRMED'),true,
    'The candidate Tavern port must actually be offline');
  return {offline:true,snapshot:facts.snapshot};
}
async function closeCandidateApp(app,held,{timeoutMs=8000,forceTimeoutMs=3000}={}) {
  const deadline=Date.now()+timeoutMs;let primary;
  try {await bounded(app.close(),deadline,'CANDIDATE_APP_CLOSE_UNCONFIRMED');
    await bounded(held.closed,deadline,'CANDIDATE_CHILD_CLOSE_UNCONFIRMED');}
  catch(error){primary=error;try {await stopChild(held.child,{timeoutMs:forceTimeoutMs,graceMs:250});}
    catch(cleanupFailure){primary.cleanupFailure=cleanupFailure;}}
  if(primary){primary.fixtureClosureConfirmed=held.didClose;throw primary;}
  assert.equal(held.didClose,true);return {closed:true};
}

test('partial candidate installation cannot be declared offline merely because its venv is absent',async()=>{
  const home=path.resolve(os.tmpdir(),'nora-pure-partial-candidate');let cancelCount=0,probeCount=0;
  const page={evaluate:async(_fn,payload)=>{
    if(payload.method==='status')return {noraHome:home,port:18999,busy:true,canCancel:false,running:false,gatewayRunning:false};
    if(payload.method==='operationSnapshot')return {state:'downloading',busy:true};
    if(payload.method==='cancel')cancelCount++;
  }};
  await assert.rejects(confirmCandidateOffline({firstWindow:async()=>page},home,
    {nativeProbe:async()=>{probeCount++;},portProbe:async()=>true}),/cannot safely cancel/);
  assert.equal(cancelCount,0);assert.equal(probeCount,0);
});

test('partial candidate cleanup needs cancellation ACK, terminal snapshot and native offline proof',async()=>{
  const home=path.resolve(os.tmpdir(),'nora-pure-cancellable-candidate');let cancelled=false,inspections=0,probed=false;
  const page={evaluate:async(_fn,{method})=>{
    if(method==='cancel'){cancelled=true;return {ok:true};}
    if(method==='status')return {noraHome:home,port:18999,busy:!cancelled,canCancel:!cancelled,running:false,gatewayRunning:false};
    if(method==='operationSnapshot'){inspections++;return {state:cancelled?'cancelled':'downloading',busy:!cancelled};}
  }};
  const nativeProbe=async({directory})=>{assert.equal(directory,path.join(home,'installer'));probed=true;return {busy:false,inspectionRequired:false,sessions:[{jobs:[{closedAt:'actual close'}]}]};};
  assert.equal((await confirmCandidateOffline({firstWindow:async()=>page},home,{nativeProbe,portProbe:async()=>true})).offline,true);
  assert.equal(cancelled,true);assert.ok(inspections>=2);assert.equal(probed,true);
  await assert.rejects(confirmCandidateOffline({firstWindow:async()=>page},home,
    {nativeProbe:async()=>({busy:false,inspectionRequired:true,sessions:[]}),portProbe:async()=>true}),/Unresolved native job/);
});

test('partial candidate cleanup has a finite deadline when cancellation never settles',async()=>{
  const home=path.resolve(os.tmpdir(),'nora-pure-hung-candidate');let probed=false;
  const page={evaluate:async(_fn,{method})=>{
    if(method==='status')return {noraHome:home,port:18999,busy:true,canCancel:true,running:false,gatewayRunning:false};
    if(method==='operationSnapshot')return {state:'downloading',busy:true};
    if(method==='cancel')return new Promise(()=>{});
  }};
  await assert.rejects(confirmCandidateOffline({firstWindow:async()=>page},home,
    {timeoutMs:25,nativeProbe:async()=>{probed=true;},portProbe:async()=>true}),error=>error.code==='CANDIDATE_INSPECTION_TIMEOUT');
  assert.equal(probed,false);
});

test('candidate app closure cannot substitute process exit for actual child close',async()=>{
  const child=new EventEmitter();Object.assign(child,{pid:123,exitCode:0,signalCode:null});
  child.kill=()=>{throw new Error('Do not kill an exited process');};
  const held=captureChild(child),app={close:async()=>{child.emit('exit',0,null);}};
  await assert.rejects(closeCandidateApp(app,held,{timeoutMs:20,forceTimeoutMs:30}),error=>
    error.code==='CANDIDATE_CHILD_CLOSE_UNCONFIRMED'&&error.fixtureClosureConfirmed===false);
  assert.equal(held.didClose,false);
});

test('packaged candidate really installs through the visible UI and survives reopen', { timeout: 240000, skip: !process.env.NORA_PACKAGED_APP || !process.env.NORA_TEST_BUILD_ID }, async () => {
  const { _electron } = require(process.env.NORA_PLAYWRIGHT || 'playwright');
  assert.equal(process.platform,'darwin','This existing Library-path candidate acceptance requires macOS');
  const executablePath = process.env.NORA_PACKAGED_APP;
  const buildId = process.env.NORA_TEST_BUILD_ID;
  assert.ok(executablePath && /^[a-zA-Z0-9-]+$/.test(buildId || ''), 'Pass the packaged binary and build ID');
  const home = path.join(os.homedir(), 'Library/NoraTavern-Tests', `launcher-${buildId}`);
  assert.equal(fs.existsSync(home), false, 'Never clean or reuse an existing user test home');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app,held,primary;
  let bodyPassed = false;
  const launch = async () => {
    app = await _electron.launch({ executablePath, args: [], env, timeout: 60000 });
    held=captureChild(app.process());
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => Boolean(window.NoraLauncherBridge), { timeout: 30000 });
    return page;
  };
  try {
    let page = await launch();
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    let status = await page.evaluate(() => window.NoraLauncherBridge.status());
    assert.equal(status.noraHome, home);
    assert.equal(status.installed, false);
    assert.equal(status.port, 18999);
    console.log('Initial UI:', (await page.locator('body').innerText()).slice(-2000));
    await page.evaluate(() => {
      window.sawIndependentNoraStage = false;
      new MutationObserver(() => {
        const steps = document.querySelectorAll('#steps .step');
        if (steps[0]?.classList.contains('done') && steps[1]?.classList.contains('active') && !steps[1]?.classList.contains('done')) {
          window.sawIndependentNoraStage = true;
        }
      }).observe(document.getElementById('steps'), { childList: true, subtree: true, attributes: true });
    });
    await page.getByRole('button', { name: '安装酒馆', exact: true }).click();
    console.log('Clicked install in the packaged app');
    await page.locator('#provider').waitFor({ state: 'visible', timeout: 180000 });
    status = await page.evaluate(() => window.NoraLauncherBridge.status());
    assert.equal(status.systemReady, true, JSON.stringify(status.systemProblems));
    assert.equal(status.noraInstalled, true);
    assert.equal(await page.evaluate(() => window.sawIndependentNoraStage), true, 'The real UI must show Nora done while Tavern installs');
    assert.equal(status.setupCompleted, false);
    assert.equal(status.modelConfigured, false);
    assert.equal(status.clawchatPaired, false);
    const system = JSON.parse(fs.readFileSync(path.join(home, 'tavern/tavern-updates/nora-system.json')));
    assert.equal(system.proof.managedConfiguration, true);
    assert.equal(system.proof.mcpInstanceRead, true);
    console.log('Real installation reached model configuration; Nora integrity and MCP passed');
    if (process.env.NORA_SCREENSHOT) await page.screenshot({ path: process.env.NORA_SCREENSHOT });
    await page.evaluate(() => window.NoraLauncherBridge.stop());
    await confirmCandidateOffline(app,home);
    await closeCandidateApp(app,held); app = null;held=null;
    page = await launch();
    await page.locator('#provider').waitFor({ state: 'visible', timeout: 30000 });
    status = await page.evaluate(() => window.NoraLauncherBridge.status());
    assert.equal(status.systemReady, true);
    assert.equal(status.setupCompleted, false);
    assert.equal(status.running, false);
    console.log('Reopen correctly resumes model configuration, without reinstalling');
    bodyPassed=true;
  } catch(error) {primary=error;}
  finally {
    let offline=false,closed=false;
    if (app) {
      try {
        await confirmCandidateOffline(app,home);offline=true;
        await closeCandidateApp(app,held);closed=true;
      } catch (error) {
        if(primary)primary.cleanupFailure=error;else primary=error;
        console.error('Retaining candidate without complete offline/close evidence:',home,error.message);
      }
    }
    if(bodyPassed&&offline&&closed&&!primary)fs.rmSync(home, { recursive: true, force: true });
    else if(fs.existsSync(home))console.error('Candidate evidence retained:',home);
  }
  if(primary)throw primary;
});
