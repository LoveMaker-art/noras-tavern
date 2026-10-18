const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { parse } = require('../installer/desktop/node_modules/acorn');
const { createReleaseSourceContext } = require('../installer/desktop/release-network');

const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
let selection;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'IfStatement' && source.slice(node.test.start, node.test.end) === "payload.action==='install'||isUpdate") selection = node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') walk(value);
  }
}
walk(ast);

test('readonly current-install inspection forwards fixed identity and never enters maintenance dispatch', () => {
  const argsNode=ast.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='bridgeArgs');
  const argsContext=vm.createContext({findPython:()=>({command:'python',args:[]}),bridgeScript:()=>'/bridge.py',
    noraHome:()=>'/owned',hermesHome:()=>'/owned/hermes',installRoot:()=>'/owned/tavern',installationPort:()=>8799});
  const makeArgs=vm.runInContext(`(${source.slice(argsNode.start,argsNode.end)})`,argsContext);
  const spec=makeArgs('inspect-current-update',{version:'2.5.2',commit:'a'.repeat(40),manifestSha256:'b'.repeat(64)});
  assert.equal(spec.args[spec.args.indexOf('--commit')+1],'a'.repeat(40));
  assert.equal(spec.args[spec.args.indexOf('--manifest-sha256')+1],'b'.repeat(64));
  let dispatch;
  function find(node){if(!node||typeof node!=='object')return;
    if(node.type==='AssignmentExpression'&&node.left.name==='proc'&&node.right.type==='ConditionalExpression')dispatch=node.right;
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(find);else if(value&&typeof value==='object')find(value);}}
  find(ast.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='runBridge'));
  assert.ok(dispatch);
  for(const activeOperationContext of [null,{operationId:'ended-operation'}])for(const [command,expected] of [
    ['inspect-current-update','readonly'],['verify-current-update','guarded'],['update','guarded']]){
    const context=vm.createContext({command,activeOperationContext,spec:{command:'python',args:[]},
      launcherEnv:()=>({}),installerRoot:()=>'/owned',spawn:()=> 'readonly',spawnMaintenance:()=> 'guarded'});
    assert.equal(vm.runInContext(source.slice(dispatch.start,dispatch.end),context),expected);
  }
});

test('joint update verifies only the frozen old or new installed core identity through the readonly query', async t => {
  const crypto=require('node:crypto'),os=require('node:os');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-combination-query-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'tavern'),file=path.join(root,'tavern-updates','installed-manifest.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const before={schema:'tavern-release/v2',versions:{tavern:'2.4.2'},commit:'a'.repeat(40)};
  const target={schema:'tavern-release/v2',versions:{tavern:'2.5.2'},commit:'b'.repeat(40)};
  const oldBytes=JSON.stringify(before,null,2),targetBytes=JSON.stringify(target,null,2)+'\n';
  const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
  let node;function find(value){if(!value||typeof value!=='object')return;
    if(value.type==='VariableDeclarator'&&value.id.name==='verifyCombination')node=value.init;
    for(const child of Object.values(value)){if(Array.isArray(child))child.forEach(find);else if(child&&typeof child==='object')find(child);}}
  find(ast);assert.ok(node);
  const calls=[],context=vm.createContext({registerCapabilities:async()=>{},path,fs,process,
    releases:createRequire(path.join(__dirname,'../installer/desktop/main.js'))('./releases'),
    require:name=>name==='node:crypto'?crypto:{validate:async()=>{}},installerDirectory:()=>path.join(home,'installer'),
    noraHome:()=>home,installRoot:()=>root,app:{getVersion:()=> '2.2.2'},options:{capabilities:{}},
    updateSequence:{compatible:()=>true},sequence:{before:{core:'2.4.2',coreCommit:before.commit,coreManifestSha256:digest(oldBytes)},
      plan:{commit:target.commit,releaseManifest:target,releaseManifestText:JSON.stringify(target)}},
    state:{systemReady:true,version:'2.4.2',commit:before.commit},
    runBridge:async(command,identity)=>{calls.push({command,identity});return command==='status'?context.state:{updateVerified:true,systemReady:true};}});
  const verify=vm.runInContext(`(${source.slice(node.start,node.end)})`,context);
  for(const [manifest,bytes] of [[before,oldBytes],[target,targetBytes]]){
    context.state={systemReady:true,version:manifest.versions.tavern,commit:manifest.commit};fs.writeFileSync(file,bytes);calls.length=0;
    assert.equal((await verify()).compatible,true);
    assert.equal(calls.at(-1).command,'inspect-current-update');
    assert.equal(calls.at(-1).identity.version,manifest.versions.tavern);
    assert.equal(calls.at(-1).identity.commit,manifest.commit);
    assert.equal(calls.at(-1).identity.manifestSha256,digest(bytes));
  }
  fs.writeFileSync(file,targetBytes+' ');calls.length=0;
  assert.equal((await verify()).compatible,false);assert.equal(calls.length,1,'unbound bytes never become a compatibility claim');
  fs.writeFileSync(file,targetBytes);context.state.commit='c'.repeat(40);calls.length=0;
  assert.equal((await verify()).compatible,false);assert.equal(calls.length,1);
});

test('GUI telemetry distinguishes explicit recovery from a failed update with automatic rollback',()=>{
  const node=ast.body.find(value=>value.type==='FunctionDeclaration'&&value.id.name==='finishOperationTelemetry');
  assert.ok(node);const outcomes=[],records=[],operationErrors=new Map(),primaryFailure={code:'ORIGINAL_FAILURE'};
  const context=vm.createContext({operationErrors,diagnostics:{operationId:'fixture',write:(event,fields)=>records.push({event,fields})},
    telemetry:{finish:(outcome,error)=>outcomes.push({outcome,error})}});
  const finish=vm.runInContext(`(${source.slice(node.start,node.end)})`,context);
  const original={operationId:'fixture',kind:'update',state:'rolled-back',verification:'confirmed',primaryFailure};
  operationErrors.set('fixture',primaryFailure);finish(original);
  assert.equal(outcomes.at(-1).outcome,'failed');assert.equal(outcomes.at(-1).error,primaryFailure);
  finish(original,{recover:true});assert.equal(outcomes.at(-1).outcome,'succeeded');
  finish({...original,verification:'failed'},{recover:true});assert.equal(outcomes.at(-1).outcome,'failed');
  assert.equal(original.primaryFailure,primaryFailure);assert.equal(operationErrors.has('fixture'),false);
  assert.equal(records.length,3);assert.ok(records.every(record=>record.event==='operation.result'));
  assert.equal(records.at(-1).fields.verification,'failed');
});

test('APP-only handoff clears its old installer resume target only after actual core verification and helper finalization',async()=>{
  let branch;
  function find(node){if(!node||typeof node!=='object')return;
    if(node.type==='IfStatement'&&source.slice(node.test.start,node.test.end)==='payload.launcherOnly===true')branch=node;
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(find);else if(value&&typeof value==='object')find(value);}}
  find(ast);assert.ok(branch);
  for(const outcome of ['success','core-failed','helper-failed']){
    let state={phase:'update',error:'old error',task:'old task',resumeTarget:'v2.5.5'},writes=0,finalized=0;
    const context=vm.createContext({payload:{launcherOnly:true,port:8799},prepared:{tag:'v2.5.5',manifest:{versions:{tavern:'2.5.2'}}},
      context:{snapshot:{handoffRef:'/owned/job'}},releases:{compare:(a,b)=>a===b?0:1},event:{sender:{}},
      runBridge:async()=>({version:'2.5.2',systemReady:true,updateVerified:outcome!=='core-failed'}),
      launcherError:message=>new Error(message),launcherRecoveryOptions:()=>({}),spawnMaintenance(){},app:{getVersion:()=> '2.2.3'},
      launcherUpdate:{finalize:async()=>{finalized++;if(outcome==='helper-failed')throw Error('helper not final');}},
      readInstallerState:()=>state,writeInstallerState:value=>{writes++;state=value;}});
    const run=()=>vm.runInContext('(async()=>{'+source.slice(branch.start,branch.end)+'})()',context);
    if(outcome==='success'){const result=await run();assert.equal(result.verification,'confirmed');assert.equal(writes,1);
      assert.equal(state.resumeTarget,null);assert.equal(state.error,'');assert.equal(state.task,'');assert.equal(state.phase,'ready');}
    else{await assert.rejects(run);assert.equal(writes,0,'unconfirmed handoff must retain the recovery projection');assert.equal(state.resumeTarget,'v2.5.5');}
    assert.equal(finalized,outcome==='core-failed'?0:1);
  }
});

test('actual first-install handler selects the latest complete release; local candidates stay offline', async () => {
  assert.ok(selection);
  for (const [action, local, expected] of [['install', false, 'latest'], ['install', true, 'candidate'], ['update', false, 'online']]) {
    const calls = [];
    const networkPolicy = { sourceContext: createReleaseSourceContext() };
    const context = vm.createContext({
      networkPolicy,
      require: createRequire(path.join(__dirname, '../installer/desktop/main.js')),
      payload: { action }, isUpdate: action === 'update', managedRepair:false,
      managedFacts:{needsRepair:false,missing:{python:false}}, LOCAL_TEST: local, CHANNEL: 'stable', AbortController, process,
      selectedPlan: null, fixedTarget: async plan => { context.selectedPlan = plan; },
      context: { stage: async () => {}, effect: async () => {} }, fs: { readFileSync: () => JSON.stringify({versions:{tavern:'2.4.2'},commit:'a'.repeat(40)}) },
      releaseAbort: null, selectedPayload: null, cancelled: false,
      app: { getVersion: () => '1.0.0' }, path,
      noraHome: () => '/home', payloadDirectory: () => '/payload',
      operationDirectory: '/operation/fixture-install',
      event: { sender: {} }, sendBridgeEvent() {},
      releaseNetwork: { fetch() { throw new Error('network unavailable'); } },
      updateFetch() { throw new Error('network unavailable'); },
      releases: {
        prepareBundled: async () => { calls.push('bundled'); return '/payload'; },
        prepareInstall: async options => {
          assert.equal(options.fetcher, context.updateFetch);
          assert.equal(options.operationDirectory, context.operationDirectory);
          assert.equal(options.networkPolicy, networkPolicy);
          assert.equal(typeof options.confirmBundled, 'function');
          calls.push('latest'); return '/latest';
        },
        prepareUpdate: async options => {
          assert.equal(options.networkPolicy, networkPolicy);
          calls.push('online'); return '/download';
        },
      },
      prepareTestPayload: async () => { calls.push('candidate'); return '/payload'; },
      diagnostics: { write() {} }, cleanupInstallTemps: () => [],
      ensureHermesFromNode: async (_sender, _run, root) => calls.push(root),
    });
    await vm.runInContext(`(async () => { ${source.slice(selection.start, selection.end)} })()`, context);
    assert.deepEqual(calls, action === 'install' ? [expected, local ? '/payload' : '/latest'] : [expected]);
    assert.equal(context.releaseAbort, null);
  }
});

test('automatic version check waits for completed setup and network failure remains nonblocking', async () => {
  const ui = fs.readFileSync(path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
  const start = ui.indexOf('  async function checkVersionsInBackground()');
  const end = ui.indexOf('\n  document.querySelectorAll', start);
  assert.ok(start >= 0 && end > start);
  let installed = false, requests = 0;
  const context = vm.createContext({
    complete: () => installed, autoVersionChecked: false, versionChecking: false,
    busy: false, snapshot: {}, versionInfo: null,
    api: { checkUpdate: async () => { requests++; throw new Error('offline'); } },
    textError: error => error.message, showVersionNotice() {},
  });
  const check = vm.runInContext(`(${ui.slice(start, end).trim()})`, context);
  await check();
  assert.equal(requests, 0);
  installed = true;
  await check();
  assert.equal(requests, 1);
  assert.equal(context.versionInfo.state, 'unavailable');
  assert.equal(context.busy, false);
  await check();
  assert.equal(requests, 1);
});

test('offline installation dialog names the bundled version and defaults to cancellation', async () => {
  let confirmation;
  function find(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Property' && node.key.name === 'confirmBundled') confirmation=node.value;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(find);
      else if (value && typeof value === 'object') find(value);
    }
  }
  find(selection);
  assert.ok(confirmation);
  for(const response of [0,1]) {
    let shown;
    const context=vm.createContext({diagnostics:{error(){}},telemetry:null,
      dialog:{showMessageBox:async options=>{shown=options;return {response};}}});
    const confirm=vm.runInContext(`(${source.slice(confirmation.start,confirmation.end)})`,context);
    assert.equal(await confirm({version:'2.2.4',error:new Error('offline')}),response===1);
    assert.equal(shown.defaultId,0);assert.equal(shown.cancelId,0);
    assert.match(shown.buttons[1],/包内版本 2\.2\.4/);
    assert.match(shown.detail,/未确认它是最新版/);
  }
});
