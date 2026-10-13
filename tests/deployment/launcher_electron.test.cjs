const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const {captureChild,stopChild}=require('./launcher_test_lifecycle.cjs');
const {bounded}=require('./launcher_owned_test_actor.cjs');

async function closeElectronFixture(app,{timeoutMs=10000,forceTimeoutMs=5000}={}) {
  const child=app.process(),held=captureChild(child),deadline=Date.now()+timeoutMs;
  let primary;
  try {
    // Return from CDP before managed quit disconnects it; the actual close still
    // has to arrive. A successful evaluate or process exit alone is insufficient.
    await bounded(app.evaluate(({app})=>{setImmediate(()=>app.quit());}),deadline,'FIXTURE_QUIT_TIMEOUT');
    await bounded(held.closed,deadline,'FIXTURE_QUIT_CLOSE_TIMEOUT');
    await bounded(app.close(),deadline,'FIXTURE_APP_CLOSE_TIMEOUT');
  } catch(error) {
    primary=error;
    try {
      const cleanupDeadline=Date.now()+forceTimeoutMs;
      try {await bounded(app.close(),cleanupDeadline,'FIXTURE_APP_CLOSE_TIMEOUT');}
      finally {await stopChild(child,{timeoutMs:Math.max(1,cleanupDeadline-Date.now()),graceMs:250});}
    } catch(cleanupFailure) {primary.cleanupFailure=cleanupFailure;}
  }
  if(primary){primary.fixtureClosureConfirmed=held.didClose;throw primary;}
  assert.equal(held.didClose,true,'Managed quit must observe actual child close');
  return {closed:true};
}

test('Electron fixture cleanup does not accept process exit without actual close',async()=>{
  const child=new EventEmitter();Object.assign(child,{pid:123,exitCode:0,signalCode:null});
  let killCount=0;child.kill=()=>{killCount++;return true;};
  const app={process:()=>child,evaluate:async()=>{},close:async()=>{child.emit('exit',0,null);}};
  await assert.rejects(closeElectronFixture(app,{timeoutMs:20,forceTimeoutMs:30}),error=>
    error.code==='FIXTURE_QUIT_CLOSE_TIMEOUT'&&error.fixtureClosureConfirmed===false&&error.cleanupFailure.code==='FIXTURE_CLOSE_TIMEOUT');
  assert.equal(killCount,0,'An exited process must not be replaced by an arbitrary PID kill');
});

test('Electron fixture cleanup preserves the quit error after a held forced close',async()=>{
  const child=new EventEmitter();Object.assign(child,{pid:123,exitCode:null,signalCode:null});
  child.kill=signal=>{child.signalCode=signal;child.emit('close',null,signal);return true;};
  const original=new Error('actual managed quit failed');
  const app={process:()=>child,evaluate:async()=>{throw original;},close:async()=>{}};
  await assert.rejects(closeElectronFixture(app,{timeoutMs:20,forceTimeoutMs:100}),error=>error===original&&error.fixtureClosureConfirmed===true);
});

test('sandboxed Electron loads the real bridge and completes quit in a fresh isolated home', {timeout:45000}, async () => {
  const { _electron } = require(process.env.NORA_PLAYWRIGHT || 'playwright');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-electron-contract-'));
  const env = { ...process.env, NORA_TAVERN_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NORA_HERMES_HOME;
  delete env.NORA_TAVERN_INSTALL_ROOT;
  let app,held,primary;
  try {
    app = await _electron.launch({ executablePath: process.env.NORA_ELECTRON || undefined,
      args: [path.resolve(__dirname, '../installer/desktop'), '--nora-test-hidden'], env });
    held=captureChild(app.process());
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('copy')?.textContent === '我是诺拉。欢迎来到酒馆。');
    const result = await page.evaluate(async () => {
      const api = window.NoraLauncherBridge;
      return { status: await api.status(), nodeVisible: typeof require !== 'undefined',
        methods: ['install', 'start', 'stop', 'pair', 'checkUpdate', 'saveAndTestModel'].every(name => typeof api[name] === 'function') };
    });
    assert.equal(result.nodeVisible, false);
    assert.equal(result.methods, true);
    assert.equal(result.status.installed, false);
    assert.equal(result.status.hermesInstalled, false);
    assert.equal(fs.realpathSync(result.status.noraHome), fs.realpathSync(home));
    const rejected = await page.evaluate(async () => {
      try { await window.NoraLauncherBridge.openExternal('file:///etc/passwd'); return false; } catch { return true; }
    });
    assert.equal(rejected, true);
  } catch(error) {primary=error;}
  finally {
    if(app)try {await closeElectronFixture(app);}
    catch(error){if(primary)primary.cleanupFailure=error;else primary=error;}
    if(held?.didClose)fs.rmSync(home, { recursive: true, force: true });
    else if(fs.existsSync(home))console.error('Retaining Electron fixture without confirmed child close:',home);
  }
  if(primary)throw primary;
});

// Model UI acceptance requires a complete verified installation. Its real
// packaged APP workflow is recorded in README-nora-acceptance.md; an empty
// native-runtime descriptor cannot stand in for a healthy installation.
