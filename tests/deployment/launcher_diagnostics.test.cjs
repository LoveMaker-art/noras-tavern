const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDiagnostics, errorDetails } = require('../installer/desktop/diagnostics');
const { createTelemetry } = require('../installer/desktop/telemetry');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { parse } = require('../installer/desktop/node_modules/acorn');
const {captureChild, stopChild} = require('./launcher_test_lifecycle.cjs');

test('packaged code fingerprint works without build metadata and fails without blocking telemetry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-build-fingerprint-'));
  try {
    const file = path.resolve(__dirname, '../installer/desktop/main.js');
    const source = fs.readFileSync(file, 'utf8');
    const fn = parse(source, {ecmaVersion:'latest'}).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'launcherBuild');
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'packaged',version:'1.1.2'}));
    fs.writeFileSync(path.join(root,'main.js'),'shipped launcher');
    fs.writeFileSync(path.join(root,'launcher_bridge.py'),'shipped bridge');
    const context = vm.createContext({require,fs,path,__dirname:root,installerRoot:()=>root});
    const fingerprint = vm.runInContext(`(${source.slice(fn.start,fn.end)})`,context);
    const initial = fingerprint();
    assert.match(initial,/^[a-f0-9]{64}$/);
    assert.equal(fingerprint(),initial);
    fs.writeFileSync(path.join(root,'launcher_bridge.py'),'changed bridge');
    assert.notEqual(fingerprint(),initial);
    const withBridge = fingerprint();
    fs.writeFileSync(path.join(root,'update_recovery.py'),'changed recovery helper');
    assert.notEqual(fingerprint(),withBridge);
    fs.rmSync(root,{recursive:true,force:true});
    assert.equal(fingerprint(),'');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('a startup location error has readable application guidance and independent logs before the window exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-startup-diagnostics-'));
  try {
    const main = path.resolve(__dirname, '../installer/desktop/main.js');
    const script = `
      const Module = require('node:module');
      const original = Module._load;
      Module._load = function(name, ...args) {
        if (name === 'electron') return {
          app: { isPackaged: true, getPath: () => process.argv[2], getVersion: () => 'fixture', exit: code => {process.exitCode=code;} },
          BrowserWindow: {}, ipcMain: {}, shell: {},
          dialog: {showErrorBox: (title,message) => console.log(JSON.stringify({title,message}))},
        };
        if (name === './install-location') return { readLocation() {
          throw Object.assign(new Error('installation disk unavailable'), {code: 'ENOENT', syscall: 'stat', path: 'D:\\\\NoraTavern'});
        }};
        return original.call(this, name, ...args);
      };
      require(process.argv[1]);
    `;
    const child = spawnSync(process.execPath, ['-e', script, main, root], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    const records = fs.readFileSync(path.join(root, 'NoraTavern/diagnostics/install.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const message=JSON.parse(child.stdout.trim());
    assert.equal(message.title,'启动器未能打开');
    assert.match(message.message,/缺少必要的文件/);
    assert.match(message.message,/检查安装目录/);
    assert.ok(message.message.includes(path.join(root,'NoraTavern/diagnostics/install.log')));
    assert.match(message.message,/请保留现有安装和数据/);
    assert.doesNotMatch(message.message,/“更多”/);
    const failure = records.find(item => item.event === 'launcher.startup-failed');
    assert.equal(failure.error.code, 'ENOENT');
    assert.equal(failure.error.syscall, 'stat');
    assert.match(failure.error.stack, /main.js/);
    assert.equal(records.some(item => item.event === 'main.uncaught'),false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failure to show the startup dialog is logged and cannot become a second uncaught exception', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-startup-dialog-failure-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const main=path.resolve(__dirname,'../installer/desktop/main.js');
  const script=`
    const Module=require('node:module'),load=Module._load;
    Module._load=function(name,...args){
      if(name==='electron')return{app:{isPackaged:true,getPath:()=>process.argv[2],getVersion:()=> 'fixture',exit:code=>{process.exitCode=code;}},
        BrowserWindow:{},ipcMain:{},shell:{},dialog:{showErrorBox(){throw new Error('fixture native dialog unavailable');}}};
      if(name==='./install-location')return{readLocation(){throw Object.assign(new Error('fixture location missing'),{code:'ENOENT'});}};
      return load.call(this,name,...args);
    };
    require(process.argv[1]);
  `;
  const child=spawnSync(process.execPath,['-e',script,main,root],{encoding:'utf8'});
  assert.equal(child.status,1,child.stderr);
  const records=fs.readFileSync(path.join(root,'NoraTavern/diagnostics/install.log'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.some(item=>item.event==='launcher.startup-failed'&&item.error.code==='ENOENT'));
  assert.ok(records.some(item=>item.event==='launcher.startup-dialog-failed'));
  assert.equal(records.some(item=>item.event==='main.uncaught'),false);
});

function startupDialogFixture(t, {setPathError, mkdirError, prepare=()=>{}}={}) {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-startup-dialog-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const home=path.join(directory,'NoraTavern'),data=path.join(home,'tavern','world.json');
  fs.mkdirSync(path.dirname(data),{recursive:true});fs.writeFileSync(data,'preserved-story');
  const owner=path.join(home,'nora-owner.json');fs.writeFileSync(owner,JSON.stringify({schema:1,id:'fixture-owner'}));
  prepare({home,owner});
  const locations=require('../installer/desktop/install-location');
  const noraHome=()=>locations.readLocation(home,'stable');
  const diagnostics=createDiagnostics({primary:()=>path.join(noraHome(),'installer','install.log'),
    fallback:path.join(directory,'diagnostics','install.log')});
  const dialogs=[],exits=[],lifecycleFailures=[],file=path.resolve(__dirname,'../installer/desktop/main.js');
  const source=fs.readFileSync(file,'utf8');
  const declaration=parse(source,{ecmaVersion:'latest'}).body.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='initializeLauncher');
  const context=vm.createContext({fs:{...fs,mkdirSync:(file,...args)=>{
    if(mkdirError&&file===path.join(home,'cache','tmp'))throw mkdirError;
    return fs.mkdirSync(file,...args);
  }},path,os,process,CHANNEL:'stable',noraHome,diagnostics,
    uninstall:require('../installer/desktop/uninstall'),
    formatUserError:require('../installer/desktop/error-presentation').formatUserError,
    queueLifecycleFailure:(kind,error)=>{lifecycleFailures.push({kind,error});},
    app:{getVersion:()=> '2.1.2',setPath(){if(setPathError)throw setPathError;},exit:code=>exits.push(code)},
    dialog:{showErrorBox:(title,message)=>dialogs.push({title,message})}});
  const initialized=vm.runInContext(source.slice(declaration.start,declaration.end)+'\ninitializeLauncher()',context,{filename:file});
  const records=fs.readFileSync(diagnostics.lastFile,'utf8').trim().split('\n').map(JSON.parse);
  return {initialized,dialogs,exits,records,home,owner,data,log:diagnostics.lastFile,lifecycleFailures};
}

test('initialization failures enter the durable diagnostic path before the app exits',t=>{
  const error=Object.assign(new Error('fixture startup access refused'),{code:'EACCES'});
  const f=startupDialogFixture(t,{mkdirError:error});
  assert.equal(f.initialized,false);assert.deepEqual(f.exits,[1]);
  assert.equal(f.lifecycleFailures.length,1);
  assert.equal(f.lifecycleFailures[0].kind,'startup');assert.equal(f.lifecycleFailures[0].error,error);
  assert.equal(fs.readFileSync(f.data,'utf8'),'preserved-story');
});

test('startup initialization failure identifies its phase and the actual local log without guessing a service failure',t=>{
  const original=new Error('opaque initialization fixture');
  const f=startupDialogFixture(t,{setPathError:original});
  assert.equal(f.initialized,false);assert.deepEqual(f.exits,[1]);
  assert.equal(f.dialogs[0].title,'启动器未能打开');
  assert.match(f.dialogs[0].message,/启动器初始化未完成/);
  assert.match(f.dialogs[0].message,/具体原因尚未确认/);
  assert.match(f.dialogs[0].message,/复制下方本机日志/);
  assert.ok(f.dialogs[0].message.includes(f.log));
  assert.doesNotMatch(f.dialogs[0].message,/服务状态检查|网络|代理|opaque|“更多”/);
  assert.equal(f.records.find(item=>item.event==='launcher.startup-failed').error.message,original.message);
  assert.equal(fs.readFileSync(f.data,'utf8'),'preserved-story');
});

test('a real non-directory cache blocks initialization without changing it or the owner record',t=>{
  const f=startupDialogFixture(t,{prepare:({home})=>fs.writeFileSync(path.join(home,'cache'),'preserved-cache-file')});
  const failure=f.records.find(item=>item.event==='launcher.startup-failed');
  assert.equal(f.initialized,false);assert.equal(failure.error.code,'ENOTDIR');
  assert.match(f.dialogs[0].message,/启动器初始化未完成/);
  assert.match(f.dialogs[0].message,/初始化路径中的某一项不是文件夹/);
  assert.match(f.dialogs[0].message,/复制下方本机日志/);
  assert.doesNotMatch(f.dialogs[0].message,/服务状态检查|网络|代理|具体原因尚未确认/);
  assert.equal(fs.readFileSync(path.join(f.home,'cache'),'utf8'),'preserved-cache-file');
  assert.equal(fs.readFileSync(f.owner,'utf8'),JSON.stringify({schema:1,id:'fixture-owner'}));
  assert.equal(fs.readFileSync(f.data,'utf8'),'preserved-story');
});

test('a startup filesystem permission error keeps its cause and points to the actual local log',t=>{
  const original=Object.assign(new Error('fixture filesystem access denied'),{code:'EACCES',syscall:'mkdir'});
  const f=startupDialogFixture(t,{mkdirError:original});
  const failure=f.records.find(item=>item.event==='launcher.startup-failed');
  assert.equal(f.initialized,false);assert.deepEqual(f.exits,[1]);
  assert.match(f.dialogs[0].message,/启动器初始化未完成/);
  assert.match(f.dialogs[0].message,/无法访问初始化所需的文件或目录/);
  assert.match(f.dialogs[0].message,/检查目录权限/);
  assert.ok(f.dialogs[0].message.includes(f.log));
  assert.doesNotMatch(f.dialogs[0].message,/服务状态检查|网络|代理|fixture filesystem/);
  assert.equal(failure.error.message,original.message);assert.equal(failure.error.code,'EACCES');
  assert.equal(failure.error.syscall,'mkdir');assert.match(failure.error.stack,/fixture filesystem/);
  assert.equal(fs.readFileSync(f.owner,'utf8'),JSON.stringify({schema:1,id:'fixture-owner'}));
  assert.equal(fs.readFileSync(f.data,'utf8'),'preserved-story');
});

test('unparseable location and owner records remain untouched while initialization saves the real JSON error',t=>{
  for(const kind of ['location','owner']){
    const bytes='{"schema":1,';let record;
    const f=startupDialogFixture(t,{prepare:({home,owner})=>{
      record=kind==='owner'?owner:path.join(home,'installer','location.json');
      fs.mkdirSync(path.dirname(record),{recursive:true});fs.writeFileSync(record,bytes);
    }});
    const failure=f.records.find(item=>item.event==='launcher.startup-failed');
    assert.equal(f.initialized,false);assert.deepEqual(f.exits,[1]);
    assert.equal(failure.error.name,'SyntaxError');assert.match(failure.error.stack,/JSON\.parse/);
    assert.match(f.dialogs[0].message,/启动器初始化未完成/);
    assert.match(f.dialogs[0].message,/具体原因尚未确认/);
    assert.match(f.dialogs[0].message,/复制下方本机日志/);
    assert.ok(f.dialogs[0].message.includes(f.log));
    assert.doesNotMatch(f.dialogs[0].message,/服务状态检查|网络|代理|JSON|SyntaxError/);
    assert.equal(fs.readFileSync(record,'utf8'),bytes);
    assert.equal(fs.readFileSync(f.data,'utf8'),'preserved-story');
    if(kind==='location')assert.equal(path.dirname(f.log),path.join(path.dirname(f.home),'diagnostics'));
  }
});

test('normal startup still initializes with the existing owner and data',t=>{
  const f=startupDialogFixture(t);
  assert.equal(f.initialized,true);assert.deepEqual(f.exits,[]);assert.deepEqual(f.dialogs,[]);
  assert.equal(f.records.some(item=>item.event==='launcher.startup-failed'),false);
  assert.equal(fs.readFileSync(f.owner,'utf8'),JSON.stringify({schema:1,id:'fixture-owner'}));
  assert.equal(fs.readFileSync(f.data,'utf8'),'preserved-story');
});

function mainContext(root, overrides = {}, argv = []) {
  const file = path.resolve(__dirname, '../installer/desktop/main.js');
  const localRequire = createRequire(file);
  const context = vm.createContext({
    require: name => name === 'electron' ? overrides.electron || { app: { getPath: () => root, getVersion: () => 'fixture' } }
      : Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    __dirname: path.dirname(file), process: { ...process, argv, on() {} },
    setInterval, clearInterval, setTimeout, clearTimeout, setImmediate, console, root,
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  vm.runInContext(`noraHome = () => root; installerRoot = () => root;
    launcherEnv = () => process.env; diagnostics.begin('real-child', {action: 'install'});`, context);
  if (overrides.$processOutputFixture) {
    // Explicit external-process adapter for output/diagnostic boundary tests.
    // These children only touch this temporary fixture; ownership is tested by
    // the real guard matrix, rather than fabricated capabilities here.
    context.fixtureSpawn = (command, args, options) => {
      const child = localRequire('node:child_process').spawn(command, args, options);
      child.guarded = true;
      return child;
    };
    vm.runInContext('spawnMaintenance=fixtureSpawn;', context);
  }
  return context;
}

function mainCallback(context,name) {
  const source=fs.readFileSync(path.resolve(__dirname,'../installer/desktop/main.js'),'utf8');
  let callback;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type==='VariableDeclarator' && node.id.name===name) callback=node.init;
    if (node.type==='CallExpression' && node.callee.name==='handle' && node.arguments[0]?.value===name) callback=node.arguments[1];
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value==='object') visit(value);
    }
  }
  visit(parse(source,{ecmaVersion:'latest'}));
  assert.ok(callback,`main callback ${name} exists`);
  if(name==='runAction')context.executeAction=mainCallback(context,'executeAction');
  return vm.runInContext(`(${source.slice(callback.start,callback.end)})`,context);
}

async function modelRetryFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-model-retry-diagnostic-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state={status:503,requests:0,saves:0,now:Date.now(),body:null};
  const key='fixture-model-private+/credential';
  const server=require('node:http').createServer((request,response)=>{
    state.requests++;
    assert.equal(request.headers.authorization,`Bearer ${key}`);
    request.resume();
    request.on('end',async()=>{
      state.arrived?.();
      if(state.gate)await state.gate;
      response.writeHead(state.status,{'content-type':'application/json'});
      response.end(state.body??JSON.stringify(state.status===200
        ?{choices:[{message:{content:'fixture response'}}]}
        :{error:{message:`fixture provider rejected ${key} ${encodeURIComponent(key)}`}}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const payload={provider:'custom',key,model:'fixture-model',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  for(const file of ['chats/original.jsonl','characters/original.png','worlds/original.json','config/original.json']){
    const target=path.join(root,'protected',file);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,`preserved ${file}`);
  }
  function reopen(){
    const context=mainContext(root);
    context.modelFixture=state;
    const httpFixture=require(path.join(__dirname,'../installer/desktop/model-config')).testCustomModel;
    context.configureRequest=state.transportError?async()=>{throw state.transportError;}:httpFixture;
    // The production task controller, writer lock and diagnostics receive the
    // shared configure boundary. Its double uses the existing HTTP client only
    // to generate representative transport failures; this does not exercise or
    // prove the shared helper's native model validation implementation.
    vm.runInContext(`operationController=createOperationController({directory:installerDirectory,
      lock:operationLock,evidence:operationEvidence,now:()=>new Date(modelFixture.now).toISOString(),
      projectResult:result=>result.value});
      runModelConfigHelper=async value=>{
        if(value.action!=='configure')throw new Error('Unexpected model helper action: '+value.action);
        try{await configureRequest(value.baseUrl,value.key,value.model);}
        catch(error){
          const failure=launcherError(error.message,{source:'model_service',status:error.status,site:'model.save',code:error.code},error);
          failure.remoteMessage='Model configuration helper failed; see technical exit status.';
          failure.modelFailureStage='candidate';
          throw failure;
        }
        modelFixture.saves++;
        return {ok:true,provider:'custom:fixture',model:value.model};
      };
      finishModelSetup=async()=>({ok:true});
      const readModelFixtureState=readInstallerState;
      readInstallerState=()=>({...readModelFixtureState(),setupCompleted:true});`,context);
    return {context,submit:()=>mainCallback(context,'nora:model-save-test')({},payload),
      snapshot:()=>vm.runInContext('operations().snapshot()',context),
      recheck:id=>{context.fixtureOperationId=id;return vm.runInContext('operations().recheck(fixtureOperationId)',context);}};
  }
  return {root,state,key,payload,reopen,assertProtected(){
    for(const file of ['chats/original.jsonl','characters/original.png','worlds/original.json','config/original.json'])
      assert.equal(fs.readFileSync(path.join(root,'protected',file),'utf8'),`preserved ${file}`);
  }};
}

test('explicit model retry after two HTTP failures works with identical input and after reopening',async t=>{
  for(const status of [401,503])for(const restart of [false,true])await t.test(`${status}: ${restart?'reopened':'same process'}`,async t=>{
    const f=await modelRetryFixture(t);f.state.status=status;let app=f.reopen();
    for(let i=0;i<2;i++)await assert.rejects(app.submit(),error=>{
      assert.equal(f.state.requests,i+1,fs.readFileSync(path.join(f.root,'installer/install.log'),'utf8'));
      return true;
    });
    assert.equal(f.state.requests,2);assert.equal(f.state.saves,0);
    const failed=await app.snapshot();
    await app.recheck(failed.operationId);
    assert.equal(f.state.requests,2,'status inspection must not call the model');
    f.state.now+=31000;f.state.status=200;
    if(restart)app=f.reopen();
    assert.equal((await app.submit()).ok,true);
    assert.equal(f.state.requests,3);assert.equal(f.state.saves,1);
    assert.equal((await app.snapshot()).state,'succeeded');f.assertProtected();
  });
});

test('explicit model retry survives actual Node process exit and restart with retained records', {timeout:15000},async t=>{
  const f=await modelRetryFixture(t);
  const script=`(function(){
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
    const {createRequire}=require('node:module');
    const __dirname=process.env.NORA_MODEL_FIXTURE_DIRECTORY;
    const {parse}=require(path.join(__dirname,'../installer/desktop/node_modules/acorn'));
    const mainContext=${mainContext.toString()};
    const mainCallback=${mainCallback.toString()};
    process.once('message',async input=>{
      const {root,payload}=input,state={now:input.now,saves:0};
      const reopen=${f.reopen.toString()};
      try{
        const app=reopen(),outcomes=[];
        for(let i=0;i<input.count;i++){
          try{await app.submit();outcomes.push('succeeded');}
          catch(error){outcomes.push(error.operation?.state||'unexpected');}
        }
        const snapshot=await app.snapshot();
        process.send({outcomes,saves:state.saves,state:snapshot.state},()=>process.disconnect());
      }catch{process.exitCode=1;process.disconnect();}
    });
  })();`;
  async function run(count){
    const child=require('node:child_process').spawn(process.execPath,['-e',script],{
      env:{...process.env,NORA_MODEL_FIXTURE_DIRECTORY:__dirname},stdio:['ignore','pipe','pipe','ipc']});
    const tracked=captureChild(child),messages=[];t.after(()=>stopChild(child));
    child.on('message',message=>messages.push(message));
    child.send({root:f.root,payload:f.payload,now:f.state.now,count});
    assert.equal((await tracked.closed).code,0,tracked.stderr);
    assert.equal(messages.length,1);return messages[0];
  }
  const before=await run(2);assert.deepEqual(before.outcomes,['failed','failed']);
  assert.equal(before.saves,0);assert.equal(f.state.requests,2);
  f.state.now+=31000;f.state.status=200;
  const after=await run(1);assert.deepEqual(after.outcomes,['succeeded']);
  assert.equal(after.state,'succeeded');assert.equal(after.saves,1);assert.equal(f.state.requests,3);
  f.assertProtected();
});

test('concurrent model submissions issue only one HTTP request and release busy state after failure',async t=>{
  const f=await modelRetryFixture(t),app=f.reopen();let release,arrived,timer;
  f.state.gate=new Promise(resolve=>{release=resolve;});
  const requestArrived=new Promise(resolve=>{f.state.arrived=resolve;});
  const first=app.submit().catch(error=>error);
  try{
    await Promise.race([requestArrived,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture request missing')),5000);})]);
    await assert.rejects(app.submit(),/正在处理其他任务/);assert.equal(f.state.requests,1);
  }finally{clearTimeout(timer);release();await first;}
  assert.equal(vm.runInContext('modelBusy',app.context),false);
  assert.equal((await app.snapshot()).busy,false);assert.equal(f.state.saves,0);f.assertProtected();
});

test('model failure main log retains HTTP cause and keeps credentials out of diagnostics and fault packets',async t=>{
  for(const status of [401,403,503])await t.test(String(status),async t=>{
    const f=await modelRetryFixture(t);f.state.status=status;
    const app=f.reopen();let failure;
    await assert.rejects(app.submit(),error=>{failure=error;return true;});
    const {failureResult}=require('../installer/desktop/operation-result');
    assert.equal(failureResult(failure,{action:'model',operation:failure.operation}).error.technical.http_status,status);
    const logs=fs.readFileSync(path.join(f.root,'installer/install.log'),'utf8');
    const event=logs.trim().split('\n').map(JSON.parse).find(item=>item.event==='model.failed');
    assert.equal(event.error.cause?.status,status);
    assert.match(event.error.cause.message,/fixture provider rejected/);
    assert.equal(event.error.cause.source,'model_service');assert.equal(event.error.cause.site,'model.save');
    assert.equal(logs.includes(f.key),false);assert.equal(logs.includes(encodeURIComponent(f.key)),false);
    const records=JSON.stringify(await app.snapshot());assert.equal(records.includes(f.key),false);
    const packets=require('../installer/desktop/fault-packet').createFaultPackets();
    const wire=JSON.stringify(packets.packet(failure,{id:failure.operation.operationId,history:[]}));
    assert.equal(wire.includes(f.key),false);assert.equal(wire.includes('fixture provider rejected'),false);
    const evidence=require('../installer/desktop/evidence-store').createEvidenceStore({directory:path.join(f.root,'installer')})
      .read(failure.operation.operationId);
    assert.ok(evidence.primary);assert.equal(evidence.primary.message,'Model request failed; see technical status.');
    const frozen=JSON.stringify(packets.packet(failure,{id:failure.operation.operationId,action:'model'},
      {operation:failure.operation,evidence}));
    assert.equal(require('../installer/desktop/fault-packet').validFaultPacket(JSON.parse(frozen)),true);
    assert.equal(frozen.includes(f.key),false);assert.equal(frozen.includes(encodeURIComponent(f.key)),false);
    assert.equal(frozen.includes('fixture provider rejected'),false);
    assert.equal(f.state.saves,0);f.assertProtected();
  });
});

test('model log preserves parse, connection, timeout and cancellation causes without leaking credentials',async t=>{
  for(const mode of ['invalid-json','connection-refused','timeout','cancelled'])await t.test(mode,async t=>{
    const f=await modelRetryFixture(t);
    let expected;
    if(mode==='invalid-json'){f.state.status=200;f.state.body='{broken';expected='INVALID_RESPONSE';}
    else if(mode==='connection-refused'){
      f.payload.baseUrl='http://127.0.0.1:1/v1';expected='ECONNREFUSED';
    }else{
      // The transport timeout/cancel boundary is injected; HTTP status and JSON
      // scenarios above exercise real sockets. No 120-second sleep is needed.
      expected=mode==='timeout'?'TIMEOUT':'ABORT_ERR';
      f.state.transportError=Object.assign(new Error(`fixture ${mode} ${f.key}`),
        {code:expected,source:'model_service',site:'model.test',name:mode==='cancelled'?'AbortError':'Error'});
    }
    const app=f.reopen();
    let failure;await assert.rejects(app.submit(),error=>{failure=error;return true;});
    const logs=fs.readFileSync(path.join(f.root,'installer/install.log'),'utf8');
    const event=logs.trim().split('\n').map(JSON.parse).find(item=>item.event==='model.failed');
    assert.equal(event.error.cause?.code,expected);
    const {failureResult}=require('../installer/desktop/operation-result');
    const technical=failureResult(failure,{operation:failure.operation}).error.technical;
    assert.equal(technical.error_code,mode==='invalid-json'?'invalid_response':mode==='connection-refused'?'connection_refused':mode);
    assert.equal(logs.includes(f.key),false);assert.equal(f.state.saves,0);f.assertProtected();
  });
});

test('model helper keeps complete execution output through restart and failure-log delivery without storing its configuration protocol', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-model-full-output-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'hermes-agent'));
  const secret='private-model-key-canary',privateConfig='PRIVATE_MODEL_CONFIGURATION';
  const fixture=path.join(root,'helper.cjs');
  fs.writeFileSync(fixture,`process.stdin.resume();process.stdin.on('end',()=>{
    console.log('helper starting');
    process.stderr.write('Traceback (most recent call last):\\n\\n  File "model_config.py", line 42, in save\\n');
    for(let i=0;i<180;i++)process.stderr.write('output '+i+' '+ 'x'.repeat(90)+'\\n');
    process.stderr.write('PermissionError: denied ${secret}\\n');
    console.log(JSON.stringify({ok:false,error:'write denied',config:'${privateConfig}',key:'${secret}'}));
    process.exitCode=1;
  });`);
  const context=mainContext(root,{$processOutputFixture:true});
  context.spawnFixture=()=>require('node:child_process').spawn(process.execPath,[fixture],{stdio:'pipe'});
  vm.runInContext('findPython=()=>({command:"fixture",args:[]}); hermesHome=()=>root; spawnMaintenance=spawnFixture;',context);
  const id=vm.runInContext('diagnostics.operationId',context);
  await assert.rejects(vm.runInContext('runModelConfigHelper',context)({key:secret,action:'save'}),/write denied/);
  const file=vm.runInContext('diagnostics.lastFile',context);
  const read=createDiagnostics({primary:()=>file}).readOperation;
  const logs=read(id).records.map(r=>r.text).join('\n');
  assert.match(logs,/helper starting/);assert.match(logs,/Traceback \(most recent call last\):\n\n  File/);
  assert.match(logs,/output 0 /);assert.match(logs,/output 179 /);assert.match(logs,/PermissionError/);
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),new RegExp(secret+'|'+privateConfig));
  const {createOperationLogDelivery}=require('../installer/desktop/operation-log-delivery');
  const chunks=[];
  const transport=createOperationLogDelivery({file:path.join(root,'delivery.json'),read,project:text=>require('../installer/desktop/fault-packet').createFaultPackets().text(text,256*1024),
    consent:()=>({enabled:true,id:'22222222-2222-4222-8222-222222222222',installation:'33333333-3333-4333-8333-333333333333'}),
    fetcher:async(_url,options)=>{const chunk=JSON.parse(options.body);chunks.push(chunk);return {ok:true,status:200,json:async()=>({accepted:true,index:chunk.index,chunk_id:chunk.chunk_id})};}});
  t.after(()=>transport.close());transport.begin(id);transport.finish(id,'failed');
  for(let i=0;i<10&&!transport.summary(id).complete;i++)await transport.flush();
  assert.equal(transport.summary(id).complete,true);
  const remote=chunks.map(chunk=>chunk.text).join('');
  assert.match(remote,/output 0 /);assert.match(remote,/output 179 /);assert.match(remote,/Traceback/);
  assert.doesNotMatch(remote,new RegExp(secret+'|'+privateConfig));
});

test('model helper logs success, invalid protocol and timeout separately without exposing successful configuration',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-model-exit-cases-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'hermes-agent'));
  for(const mode of ['success','invalid','timeout']){
    const script=path.join(root,mode+'.cjs');
    const body=mode==='success'?"console.log(JSON.stringify({ok:true,config:'PRIVATE_SAVED_CONFIG'}));":
      mode==='invalid'?"console.log('invalid helper protocol');":"process.stderr.write('waiting for helper\\n');setInterval(()=>{},1000);";
    fs.writeFileSync(script,"process.stdin.resume();process.stdin.on('end',()=>{"+body+"});");
    const context=mainContext(root,{$processOutputFixture:true});
    context.spawnFixture=()=>require('node:child_process').spawn(process.execPath,[script],{stdio:'pipe'});
    vm.runInContext('findPython=()=>({command:"fixture",args:[]});hermesHome=()=>root;spawnMaintenance=spawnFixture;',context);
    if(mode==='timeout')context.setTimeout=fn=>setTimeout(fn,100);
    const helper=vm.runInContext('runModelConfigHelper',context);
    if(mode==='success')assert.equal((await helper({})).config,'PRIVATE_SAVED_CONFIG');
    else await assert.rejects(helper({}),error=>error.code===(mode==='timeout'?'TIMEOUT':'INVALID_RESPONSE'));
    const records=vm.runInContext('diagnostics.readOperation(diagnostics.operationId).records',context),text=records.map(r=>r.text).join('\n');
    assert.match(text,/model.helper-exit/);assert.doesNotMatch(text,/PRIVATE_SAVED_CONFIG/);
    if(mode==='timeout'){assert.match(text,/model.helper-timeout/);assert.match(text,/SIGTERM/);}
    else assert.match(text,/exitCode=0/);
  }
});

test('model inspection uses the read transport while configure owns its writer transport and longer budget',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-model-helper-transport-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'hermes-agent'));
  const script=path.join(root,'protocol.cjs');
  fs.writeFileSync(script,"let body='';process.stdin.on('data',chunk=>body+=chunk);process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,action:JSON.parse(body).action,model:'PRIVATE_SAVED_MODEL'})));");
  const transports=[],budgets=[],spawn=require('node:child_process').spawn;
  const child=transport=>()=>{transports.push(transport);return spawn(process.execPath,[script],{stdio:'pipe'});};
  const context=mainContext(root,{'node:child_process':{...require('node:child_process'),spawn:child('read')}});
  context.ownedSpawn=child('owned');context.setTimeout=(callback,delay)=>{budgets.push(delay);return setTimeout(callback,delay);};
  vm.runInContext('findPython=()=>({command:"fixture",args:[]});hermesHome=()=>root;spawnMaintenance=ownedSpawn;',context);
  const helper=vm.runInContext('runModelConfigHelper',context);
  for(const action of ['inspect','configure','sync-saved-tavern','verify-runtime'])assert.equal((await helper({action})).action,action);
  assert.deepEqual(transports,['read','owned','owned','owned']);
  assert.deepEqual(budgets,[60000,210000,60000,60000]);
  const logs=fs.readFileSync(vm.runInContext('diagnostics.lastFile',context),'utf8');
  assert.doesNotMatch(logs,/PRIVATE_SAVED_MODEL/);
});

test('shared helper failures preserve native HTTP metadata through diagnostics without logging the private protocol',async t=>{
  for(const [status,category] of [[401,'http_unauthorized'],[403,'http_forbidden'],[503,'http_error']])await t.test(String(status),async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-model-helper-http-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'hermes-agent'));
    const secret='fixture-native-private-key',script=path.join(root,'failure.cjs');
    const protocol={ok:false,error:`模型验证未通过。${secret}`,httpStatus:status,source:'model_service',code:'MODEL_NATIVE_VALIDATION_FAILED',failureStage:'candidate',
      diagnostic:{name:'ModelConfigurationFailure',message:'模型验证未通过。',code:'MODEL_NATIVE_VALIDATION_FAILED'},config:'PRIVATE_NATIVE_CONFIG'};
    fs.writeFileSync(script,`process.stdin.resume();process.stdin.on('end',()=>{console.log(${JSON.stringify(JSON.stringify(protocol))});process.exitCode=1;});`);
    const context=mainContext(root,{$processOutputFixture:true});
    context.spawnFixture=()=>require('node:child_process').spawn(process.execPath,[script],{stdio:'pipe'});
    vm.runInContext('findPython=()=>({command:"fixture",args:[]});hermesHome=()=>root;spawnMaintenance=spawnFixture;',context);
    const helper=vm.runInContext('runModelConfigHelper',context),{describeError}=require('../installer/desktop/launcher-errors');
    await assert.rejects(helper({action:'configure',key:secret}),error=>{
      assert.equal(error.source,'model_service');assert.equal(error.status,status);assert.equal(error.code,'MODEL_NATIVE_VALIDATION_FAILED');
      assert.equal(error.modelFailureStage,'candidate');
      const technical=describeError(error);assert.equal(technical.http_status,status);assert.equal(technical.error_code,category);
      assert.equal(error.cause.name,'ModelConfigurationFailure');assert.doesNotMatch(error.message,new RegExp(secret));return true;
    });
    const logs=fs.readFileSync(vm.runInContext('diagnostics.lastFile',context),'utf8');
    assert.match(logs,/model.helper-failed/);assert.doesNotMatch(logs,new RegExp(secret+'|PRIVATE_NATIVE_CONFIG'));
  });
});

function recoveryControllerFixture(context,pending) {
  const operationId='11111111-1111-4111-8111-111111111111';
  pending.operationId=operationId;
  const snapshot={operationId,snapshotSequence:1,state:'interrupted',kind:'repair',allowedActions:['recover']};
  context.fixtureOperations={snapshot:async()=>snapshot,recover:async(_id,options)=>{
    let handoffRef;
    const result=await options.prepareHandoff({operationId,snapshot,observe(){},handoff:async ref=>{handoffRef=ref;}});
    assert.equal(result.handoff,true);
    return {...snapshot,state:'awaiting-handoff',handoffRef,result:result.value};
  }};
  vm.runInContext('operations=()=>fixtureOperations;',context);
}

test('launcher recovery waits for preparation and cannot bypass busy or unknown ownership', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-launcher-recovery-main-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let pending={job:path.join(root,'job'),status:'unknown',canRecover:false,reason:'无法确认旧启动器归属。'};
  const calls=[];
  const context=mainContext(root,{'./launcher-update':{
    assessPending:async()=>pending,
    prepareRecovery:async()=>({parentCreationTime:1}),
    recover:async options=>{calls.push(options);return{job:options.job,restarting:true};},
  }});
  context.serviceCalls=[];
  vm.runInContext('app.isPackaged=true; app.quit=()=>{globalThis.didQuit=true;}; findPython=()=>({command:"python-fixture"}); runBridge=async(command,options)=>{serviceCalls.push([command,options.service]);return {running:false,gatewayRunning:false};}; activeRun=true;',context);
  await assert.rejects(vm.runInContext('recoverLauncher()',context),/当前任务/);
  vm.runInContext('activeRun=false;',context);
  await assert.rejects(vm.runInContext('recoverLauncher()',context),/归属/);
  pending={...pending,canRecover:true,busy:true,reason:'替换仍在进行。'};
  await assert.rejects(vm.runInContext('recoverLauncher()',context),/仍在进行/);
  assert.equal(calls.length,0);
  assert.deepEqual(context.serviceCalls,[],'busy or unconfirmed recovery must not stop services');
  pending={...pending,busy:false};
  recoveryControllerFixture(context,pending);
  const result=await vm.runInContext('recoverLauncher()',context);
  assert.equal(result.restarting,true);
  assert.equal(calls[0].job,pending.job);
  assert.equal(context.serviceCalls.length,1);
  assert.deepEqual(Array.from(context.serviceCalls[0]),['stop','all'],'owned recovery confirms service shutdown before APP handoff');
  assert.equal(vm.runInContext('quitReady',context),true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(context.didQuit,true);
  assert.equal(vm.runInContext('activeRun',context),true,'handoff owns the task lock until the launcher exits');
});

test('launcher backup commits only after the actual component transaction verifies its target', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-launcher-finalize-main-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const payload=path.join(root,'payload'),job=path.join(root,'job'),calls=[];
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload,'release-manifest.json'),JSON.stringify({versions:{tavern:'2.4.3'}}));
  const context=mainContext(root,{'./launcher-update':{finalize:async options=>{calls.push(options);return{status:'committed'};}}},[`--nora-self-update=${job}`]);
  context.verified={version:'2.4.3',commit:'a'.repeat(40),systemReady:true,updateVerified:false};
  context.payload=payload;
  context.ownedUpdate={target:{releasePlan:{version:'2.4.3',commit:'a'.repeat(40)}},snapshot:{handoffRef:job},observe(){}};
  vm.runInContext('activeOperationContext=ownedUpdate;',context);
  vm.runInContext('findPython=()=>({command:"python-fixture"}); hermesHome=()=>path.join(root,"hermes"); installRoot=()=>path.join(root,"tavern"); runBridge=async command=>command==="status"?{version:"2.4.2",systemReady:true}:verified;',context);
  await assert.rejects(vm.runInContext('performSystemUpdate(payload,{runId:"verify-fixture"},null)',context),/尚未通过验收/);
  assert.equal(calls.length,0);
  context.verified.updateVerified=true;
  await vm.runInContext('performSystemUpdate(payload,{runId:"verify-fixture"},null)',context);
  assert.equal(calls.length,1);
  assert.equal(calls[0].job,job);
  assert.equal(calls[0].version,'fixture');
  assert.equal(calls[0].target,'2.4.3');
  assert.equal(calls[0].systemReady,true);
  assert.equal(calls[0].updateVerified,true);
});

test('launcher recovery remains offered after failed status inspection, but handoff requires confirmed service shutdown', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-launcher-recovery-status-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const pending={job:path.join(root,'job'),canRecover:true,status:'resumed',reason:'可恢复旧启动器。'};
  let assessed=0;
  const context=mainContext(root,{'./launcher-update':{assessPending:async()=>{assessed++;return pending;},prepareRecovery:async()=>({parentCreationTime:1}),recover:async()=>({job:pending.job,restarting:true})},'./system-update':{pending:()=>false}});
  recoveryControllerFixture(context,pending);
  const sent=[];
  const client=createTelemetry({file:path.join(root,'telemetry.json'),launcherVersion:'fixture',automatic:false,
    fetcher:async (_url,options)=>{const data=JSON.parse(options.body);sent.push(...data.events);return Response.json({accepted_event_ids:data.events.map(event=>event.event_id),rejected_event_ids:[]});}});
  client.setEnabled(true);t.after(()=>client.close());context.testTelemetry=client;
  vm.runInContext('app.isPackaged=true; app.quit=()=>{}; findPython=()=>({command:"python-fixture"}); telemetry=testTelemetry; globalThis.bridgeCalls=0; runBridge=async()=>{bridgeCalls++;throw Object.assign(new Error("fixture inspection denied"),{code:"EACCES"});};',context);
  const status=mainCallback(context,'nora:status'),result=await status();
  assert.equal(result.statusUnavailable,true);
  assert.equal(result.launcherRecovery,pending);
  assert.equal(result.busy,false);
  assert.equal(Object.hasOwn(result,'running'),false);
  assert.equal(context.bridgeCalls,0,'the failed directory inspection must not invent runtime facts');
  await assert.rejects(vm.runInContext('recoverLauncher()',context),/fixture inspection denied/);
  assert.equal(context.bridgeCalls,1);
  assert.notEqual(vm.runInContext('quitReady',context),true,'failed service shutdown must not authorize APP exit');
  vm.runInContext('runBridge=async(command,options)=>{bridgeCalls++;if(command!=="stop"||options.service!=="all")throw new Error("unexpected bridge request");return {running:false,gatewayRunning:false};};',context);
  const recovery=await vm.runInContext('recoverLauncher()',context);
  assert.equal(recovery.restarting,true);
  assert.equal(assessed,3,'each explicit recovery must reassess its own identity');
  assert.equal(context.bridgeCalls,2,'retry confirms both services have stopped before the handoff');
  const busy=await status();
  assert.equal(busy.statusUnavailable,true);
  assert.equal(busy.busy,true);
  assert.equal(Object.hasOwn(busy,'running'),false);
  await client.flush();
  const finished=sent.filter(event=>event.event==='operation_finished'&&event.action==='repair');
  assert.equal(finished.at(-1).status,'handoff');
  assert.equal(finished.some(event=>event.status==='succeeded'),false,'preparation cannot claim completed restoration');
});

for(const verified of [false,true])test(`checking the current APP without an owned handoff cannot commit launcher backup (${verified?'core verified':'core verification rejected'})`, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-launcher-version-comparison-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[];
  const releases=require('../installer/desktop/releases');
  const manifest={schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.4.2'},launcherVersion:'2.0.2',
    launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},
    bootstrap:{managedComponents:1,minimumLauncherVersion:'2.0.2',sha256:'b'.repeat(64)}};
  const body=JSON.stringify(manifest),release={tag_name:'v2.4.2',assets:[{name:'release-manifest.json',size:Buffer.byteLength(body),
    browser_download_url:'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/release-manifest.json'}]};
  const selectedPlan=await releases.selectPlan({selectedRelease:release,launcherVersion:'2.0.2',fetcher:async()=>new Response(body)});
  const context=mainContext(root,{electron:{app:{getPath:()=>root,getVersion:()=> '2.0.2'}},'./test-build':{testBuild:()=>null},
    './releases':{...releases,selectPlan:async()=>selectedPlan},'./launcher-update':{
    prepare:async()=>({tag:'v2.4.2',manifest:{versions:{tavern:'2.4.2'}}}),
    finalize:async options=>calls.push(options),
  }},[`--nora-self-update=${path.join(root,'job')}`]);
  context.AbortController=AbortController;
  context.coreVerified=verified;context.bridgeRequests=[];
  vm.runInContext('hermesHome=()=>path.join(root,"hermes"); installRoot=()=>path.join(root,"tavern"); runBridge=async command=>{bridgeRequests.push(command);return {version:"2.4.2",systemReady:true,updateVerified:command==="verify-current-update"&&coreVerified};};',context);
  // This is an APP-only comparison. A startup marker no longer selects a
  // legacy core executor; the request must state its actual update scope.
  const pending=mainCallback(context,'runAction')({sender:null},{action:'update',runId:'comparison-fixture',launcherOnly:true,expectedCoreVersion:'2.4.2'});
  let operation;
  if(verified){
    const result=await pending;operation=result.operation;assert.equal(result.version,'2.4.2');
  }else await assert.rejects(pending,error=>{operation=error.operation;return error.code==='VERIFICATION_FAILED';});
  assert.equal(context.bridgeRequests.filter(command=>command==='verify-current-update').length,1);
  assert.equal(calls.length,0);
  assert.equal(operation.effectState,'untouched');
  assert.equal(operation.target.releasePlan.manifestSha256,require('node:crypto').createHash('sha256').update(body).digest('hex'));
});

test('model progress cache failure releases its task lock and preserves the provider failure', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-model-state-boundary-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stateError=Object.assign(new Error('fixture rename denied'),{code:'EPERM'});
  const original=Object.assign(new Error('fixture provider test failure'),{code:'ECONNRESET'});
  const context=mainContext(root,{'node:fs':{...fs,renameSync(from,to){if(to===path.join(root,'installer/state.json')) throw stateError;return fs.renameSync(from,to);}}});
  context.original=original;
  vm.runInContext('runModelConfigHelper=async()=>{throw original;};',context);
  const handler=mainCallback(context,'nora:model-save-test');
  await assert.rejects(handler({}, {provider:'openai-api',key:'fixture-key',model:'fixture-model'}),error=>{
    assert.equal(error.userCode,'MODEL_CONFIG_PARTIAL','a lost helper response requires inspection before another save');
    assert.equal(error.cause.code,original.code,'the original transport cause remains available');
    assert.equal(error.operation.primaryFailure.technical.system_code,original.code);
    return true;
  });
  assert.equal(vm.runInContext('modelBusy',context),false);
  const records=fs.readFileSync(path.join(root,'installer/install.log'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.some(item=>item.event==='state.cache-write-failed'&&item.error.cause.code==='EPERM'));

  const secondary=mainContext(path.join(root,'secondary'));
  secondary.original=original;secondary.stateError=stateError;
  vm.runInContext('runModelConfigHelper=async()=>{throw original;}; recordEvent=message=>{if(message.state==="error")throw stateError;};',secondary);
  await assert.rejects(mainCallback(secondary,'nora:model-save-test')({}, {provider:'openai-api',key:'fixture-key',model:'fixture-model'}),error=>{
    assert.equal(error.userCode,'MODEL_CONFIG_PARTIAL');
    assert.equal(error.cause.code,original.code);
    assert.equal(error.operation.primaryFailure.technical.system_code,original.code);
    const evidence=fs.readFileSync(path.join(error.operation.primaryFailureRef,'metadata.json'),'utf8');
    assert.match(evidence,/fixture provider test failure/);
    assert.equal(error.secondaryErrors[0].error,stateError);
    return true;
  });
  assert.equal(vm.runInContext('modelBusy',secondary),false);
});

test('shared configuration commit followed by a failed Tavern sync checkpoint preserves saved facts and original cause', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-model-saved-checkpoint-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'hermes');
  fs.mkdirSync(home,{recursive:true});
  fs.writeFileSync(path.join(home,'config.yaml'),'old model');
  const failure=Object.assign(new Error('fixture verified checkpoint denied'),{code:'EACCES'});
  const actual=require('../installer/desktop/model-config');
  const context=mainContext(root,{'./model-config':{...actual,writeVerifiedModel:()=>{throw failure;}}});
  const payload={provider:'openai-api',key:'fixture-key',model:'fixture-new-model'};
  const helperRequests=[];
  // The shared helper now commits both configuration and the initial model
  // checkpoint. The remaining JS checkpoint clears pending Tavern sync; fail
  // that real boundary after a simulated shared commit, not the removed writer.
  context.configureFixture=async value=>{
    helperRequests.push(value.action);
    if(value.action==='configure'){
      fs.writeFileSync(path.join(home,'config.yaml'),JSON.stringify({model:value.model,provider:value.provider}));
      fs.writeFileSync(path.join(home,'.env'),`${value.keyEnv}=${value.key}\n`);
      actual.writeVerifiedModel(root,{...value,tavernSyncPending:true});
    }
    return {ok:true};
  };
  vm.runInContext('runModelConfigHelper=configureFixture; runBridge=async()=>({ok:true,running:true});',context);
  await assert.rejects(mainCallback(context,'nora:model-save-test')({}, payload),error=>{
    assert.equal(error.userCode,'MODEL_SYNC_PENDING',error.message);
    const evidence=fs.readFileSync(path.join(error.operation.primaryFailureRef,'metadata.json'),'utf8');
    assert.match(evidence,/fixture verified checkpoint denied/);
    assert.match(evidence,/EACCES/);
    return true;
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'config.yaml'),'utf8')),{model:'fixture-new-model',provider:'openai-api'});
  assert.deepEqual(fs.readFileSync(path.join(home,'.env'),'utf8').split(/\r?\n/),['OPENAI_API_KEY=fixture-key','']);
  assert.deepEqual(helperRequests,['configure','sync-saved-tavern']);
  assert.equal(actual.readVerifiedModel(root).tavernSyncPending,true);
  assert.equal(vm.runInContext('modelBusy',context),false);
});

test('log events remain visible and diagnostic without rewriting installer state', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-log-state-writes-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let stateRenames=0;
  const observed=[],sent=[];
  const context=mainContext(root,{'node:fs':{...fs,renameSync(from,to){if(to===path.join(root,'installer/state.json'))stateRenames++;return fs.renameSync(from,to);}}});
  context.testTelemetry={observe:message=>observed.push(message)};
  context.sender={isDestroyed:()=>false,send:(channel,message)=>sent.push({channel,message})};
  vm.runInContext('telemetry=testTelemetry; sendBridgeEvent(sender,"log-fixture",{event:"log",line:"fixture diagnostic output"});',context);
  assert.equal(stateRenames,0);
  assert.equal(fs.existsSync(path.join(root,'installer/state.json')),false);
  assert.equal(sent[0].message.line,'fixture diagnostic output');
  assert.equal(observed[0].event,'log');
  const records=fs.readFileSync(path.join(root,'installer/install.log'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.some(item=>item.event==='log'&&item.line==='fixture diagnostic output'));
  vm.runInContext('recordEvent({event:"task",task:"fixture task"}); recordEvent({event:"progress",current:1,total:2});',context);
  assert.equal(stateRenames,2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'installer/state.json'),'utf8')).task,'fixture task');
});

test('open logs uses only a freshly assessed managed launcher log and preserves normal fallback', async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-recovery-log-opening-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const job=path.join(root,'installer/launcher-update/job-fixture'),log=path.join(job,'replace.log');
  fs.mkdirSync(job,{recursive:true});fs.writeFileSync(log,'fixture launcher recovery');
  const normal=path.join(root,'installer/install.log'),outside=path.join(root,'outside.log');
  fs.writeFileSync(outside,'fixture other log');
  let pending={job,log,canRecover:true},assessments=0;
  const opened=[];
  const context=mainContext(root,{electron:{app:{isPackaged:true,getPath:()=>root,getVersion:()=> 'fixture'},shell:{openPath:async file=>{opened.push(file);return '';}}},
    './launcher-update':{assessPending:async()=>{assessments++;return pending;}}});
  vm.runInContext('findPython=()=>({command:"python-fixture"});',context);
  const openLogs=mainCallback(context,'nora:open-logs');
  await openLogs();
  assert.equal(opened.at(-1),log);
  pending={job,log:outside,canRecover:true};
  await openLogs();
  assert.equal(opened.at(-1),normal);
  fs.rmSync(log);fs.symlinkSync(outside,log);
  pending={job,log,canRecover:true};
  await openLogs();
  assert.equal(opened.at(-1),normal);
  pending=null;
  await openLogs();
  assert.equal(opened.at(-1),normal);
  assert.equal(assessments,4,'logs must not reuse the displayed recovery snapshot');
});

function failedProgressChild(root, mode, exitCode = 0) {
  const main = path.resolve(__dirname, '../installer/desktop/main.js');
  const factory = mainContext.toString().replace("path.resolve(__dirname, '../installer/desktop/main.js')", JSON.stringify(main));
  const script = `
    const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
    const {createRequire}=require('node:module');
    const mainContext=${factory};
    const root=process.argv[1],mode=process.argv[2],exitCode=Number(process.argv[3]);
    const failure=Object.assign(new Error('fixture state rename denied'),{code:'EPERM',syscall:'rename'});
    const fileSystem={...fs,renameSync(from,to){if(to===path.join(root,'installer/state.json')) throw failure;return fs.renameSync(from,to);}};
    const context=mainContext(root,{'node:fs':fileSystem,$processOutputFixture:true});
    const marker=path.join(root,'child-completed');
    context.childScript="console.log(JSON.stringify({event:'task',task:'managed transaction'}));setTimeout(()=>{require('node:fs').writeFileSync("+JSON.stringify(marker)+",'done');console.log(JSON.stringify({event:'result',systemReady:true}));process.exitCode="+exitCode+";},120);";
    context.command=[process.execPath,['-e',context.childScript]];
    vm.runInContext('bridgeArgs=()=>({command:command[0],args:command[1]});',context);
    const task=vm.runInContext(mode==='process'?'runProcess(...command)':'runBridge('+JSON.stringify(mode)+')',context);
    const summary=(error,value)=>{
      const logs=fs.readFileSync(path.join(root,'installer/install.log'),'utf8').trim().split('\\n').map(JSON.parse);
      const warning=logs.find(item=>item.event==='state.cache-write-failed');
      return {ok:!error,value,code:error?.code,userCode:error?.userCode,exitCode:error?.exitCode,
        causeCode:error?.cause?.code,cacheCode:warning?.error?.cause?.code,completed:fs.existsSync(marker),
        processCleared:vm.runInContext('activeProcess===null',context),secondaryCodes:(error?.secondaryErrors||[]).map(item=>item.error?.code)};
    };
    task.then(value=>console.log(JSON.stringify(summary(null,value))),error=>console.log(JSON.stringify(summary(error))));
  `;
  return spawnSync(process.execPath, ['-e', script, root, mode, String(exitCode)], { encoding: 'utf8', timeout: 5000 });
}

test('progress cache failure is diagnosed without changing successful child completion', t => {
  for (const mode of ['process', 'update', 'recover-update']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-progress-boundary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const child = failedProgressChild(root, mode);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.ok, true);
    if(mode!=='process')assert.equal(result.value.systemReady,true);
    assert.equal(result.cacheCode, 'EPERM');
    assert.equal(result.completed, true, 'result is returned only after the child finishes its transaction');
    assert.equal(result.processCleared, true);
  }
});

test('child failure remains primary when progress persistence also failed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-progress-primary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = failedProgressChild(root, 'update', 7);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.exitCode, 7);
  assert.equal(result.ok, false);
  assert.equal(result.completed, true);
  assert.equal(result.cacheCode, 'EPERM');
  assert.equal(result.secondaryCodes.includes('EPERM'), false, 'presentation warnings do not become transaction failures');
});

test('runtime worker business guidance survives a real child process boundary', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'nora-worker-guidance-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const context=mainContext(root,{$processOutputFixture:true});
  const worker=path.resolve(__dirname,'../installer/desktop/runtime-worker.js');
  const childEntry=path.join(root,'runtime-worker-guidance.cjs'),payload=path.join(root,'payload'),hermes=path.join(root,'hermes');
  fs.mkdirSync(payload);fs.mkdirSync(hermes);
  fs.writeFileSync(childEntry,`
    const fs=require('node:fs'),vm=require('node:vm');
    const load=require('node:module').createRequire(${JSON.stringify(worker)});
    const error=Object.assign(new Error('both extractors unavailable'),{userCode:'RUNTIME_EXTRACTOR_UNAVAILABLE',cause:Object.assign(new Error('missing'),{code:'ENOENT'})});
    vm.runInNewContext(fs.readFileSync(${JSON.stringify(worker)},'utf8'),{process,require:name=>name==='./operation-delegate'?{connect:async()=>({context:{operationId:'11111111-1111-4111-8111-111111111111',ownerEpoch:1},assertActive(){},close(){}})}:name==='./runtime'?{installBundledHermes:()=>{throw error;}}:name==='./diagnostics'?{errorDetails:()=>({message:error.message})}:load(name)});
  `);
  // Use the production CLI shape and real remaining modules. In particular,
  // retained.inspect must see this private Nora root rather than undefined.
  context.command=[process.execPath,[childEntry,payload,root,hermes]];
  await assert.rejects(vm.runInContext('runProcess(...command)',context),error=>{
    assert.equal(error.code,'ENOENT');
    assert.equal(error.userCode,'RUNTIME_EXTRACTOR_UNAVAILABLE');
    const {formatUserError}=require('../installer/desktop/error-presentation');
    assert.match(formatUserError(error,{action:'install'}),/Windows 解压工具不可用/);
    return true;
  });
});

test('runtime phase remains in bounded fault output if the worker exits before its JavaScript catch', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-worker-phase-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const context=mainContext(root,{$processOutputFixture:true});
  context.testTelemetry={settings:()=>({enabled:true}),observe(){}};
  vm.runInContext('telemetry=testTelemetry; writeInstallerState({...readInstallerState(),phase:"installing"});',context);
  const worker=path.resolve(__dirname,'../installer/desktop/runtime-worker.js');
  const childEntry=path.join(root,'runtime-worker-phase.cjs'),payload=path.join(root,'payload'),hermes=path.join(root,'hermes');
  fs.mkdirSync(payload);fs.mkdirSync(hermes);
  fs.writeFileSync(childEntry,`
    const fs=require('node:fs'),vm=require('node:vm');
    const load=require('node:module').createRequire(${JSON.stringify(worker)});
    vm.runInNewContext(fs.readFileSync(${JSON.stringify(worker)},'utf8'),{process,require:name=>name==='./operation-delegate'?{connect:async()=>({context:{operationId:'11111111-1111-4111-8111-111111111111',ownerEpoch:1},assertActive(){},close(){}})}:name==='./runtime'?{
      installBundledHermes(options){options.onEvent({event:'task',stage_id:'runtime_init',task:'初始化 Nora：准备配置和技能'});process.exit(9);}
    }:name==='./diagnostics'?{errorDetails:()=>({})}:load(name)});
  `);
  context.command=[process.execPath,[childEntry,payload,root,hermes]];
  await assert.rejects(vm.runInContext('runProcess(...command)',context),error=>{
    assert.equal(error.exitCode,9);
    assert.ok(error.launcherEvidence.output.some(line=>line.includes('runtime_init')),'owned runtime phase is retained as reviewed technical evidence');
    assert.match(fs.readFileSync(path.join(root,'installer/install.log'),'utf8'),/Runtime phase: runtime_init/);
    return true;
  });
});

test('operation handler logs original failure even if persisting the error state fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-handler-diagnostics-'));
  try {
    const original = Object.assign(new Error('release fixture failure'), { code: 'ECONNRESET' });
    const context = mainContext(root, {
      './test-build': { testBuild: () => null },
      './releases': { prepareInstall: async () => { throw original; } },
    });
    context.AbortController = AbortController;
    const sent=[];
    const client=createTelemetry({file:path.join(root,'telemetry.json'),launcherVersion:'1.1.2',automatic:false,
      fetcher:async (_url,options)=>{const data=JSON.parse(options.body);sent.push(...data.events);return Response.json({accepted_event_ids:data.events.map(e=>e.event_id),rejected_event_ids:[]});}});
    client.setEnabled(true);context.testTelemetry=client;vm.runInContext('telemetry = testTelemetry;',context);
    const source = fs.readFileSync(path.resolve(__dirname, '../installer/desktop/main.js'), 'utf8');
    let callback;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'VariableDeclarator' && node.id.name === 'runAction') callback = node.init;
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(parse(source, { ecmaVersion: 'latest' }));
    vm.runInContext(`const persist = writeInstallerState;
      writeInstallerState = value => { if (value.phase === 'error') throw new Error('state write failed'); return persist(value); };`, context);
    context.executeAction=mainCallback(context,'executeAction');
    const handler = vm.runInContext(`(${source.slice(callback.start, callback.end)})`, context);
    await assert.rejects(handler({ sender: null }, { action: 'install', runId: 'failed-attempt' }), error => error.operation?.primaryFailure?.technical?.system_code === original.code);
    await client.flush();client.close();
    assert.equal(sent.at(-1).error_code,'network');assert.equal(sent.at(-1).system_code,'ECONNRESET');
    assert.match(JSON.stringify(sent.at(-1).fault),/release fixture failure/);
    assert.match(sent.at(-1).fault.errors[0].message,/release fixture failure/);
    assert.ok(sent.at(-1).fault.errors.some(item=>item.relation==='secondary'&&item.message==='state write failed'));
    assert.doesNotMatch(sent.at(-1).fault.errors[0].message,/state write failed/);
    assert.equal(vm.runInContext('activeRun', context), false);
    const records = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some(item => item.event === 'run.failed' && item.error.code === 'ECONNRESET'));
    assert.ok(records.some(item => item.event === 'state.write-failed' && item.error.message === 'state write failed'));
    assert.ok(records.some(item => item.event === 'run.end' && item.outcome === 'error' && item.runId === 'failed-attempt'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real main process records full child stderr, diagnostics, command, and exit without leaking pairing input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-main-diagnostics-'));
  const children = [];
  try {
    const context = mainContext(root,{$processOutputFixture:true});
    const spawnFixture = context.fixtureSpawn;
    context.fixtureSpawn = (...args) => {
      const child = spawnFixture(...args);
      captureChild(child); children.push(child);
      return child;
    };
    vm.runInContext('spawnMaintenance=fixtureSpawn;', context);
    context.command = [process.execPath, ['-e', `
      console.log(JSON.stringify({event: 'task', task: 'copy-skills'}));
      console.log(JSON.stringify({event: 'diagnostic', error: {code: 'EPERM', syscall: 'symlink', path: 'skills/apple', stack: 'fixture-stack'}}));
      process.stderr.write('START-pair-fixture-' + 'x'.repeat(14000) + '-END'); process.exitCode = 1;
    `]];
    await assert.rejects(vm.runInContext(`diagnostics.addSecret('pair-fixture'); runProcess(...command)`, context));
    const raw = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8');
    assert.ok(!raw.includes('pair-fixture'));
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(item => item.event === 'process.start' && item.command[0] === process.execPath));
    assert.ok(records.some(item => item.event === 'diagnostic' && item.error.syscall === 'symlink'));
    const stderr = records.find(item => item.stream === 'stderr');
    assert.ok(stderr.line.startsWith('START-') && stderr.line.endsWith('-END') && stderr.line.length > 14000);
    assert.equal(stderr.stage, 'copy-skills');
    const exit = records.find(item => item.event === 'process.exit');
    assert.equal(exit.exitCode, 1);
    assert.equal(exit.signal, null);
    assert.equal(exit.timedOut, false);
    assert.ok(exit.durationMs >= 0);
    context.command = [path.join(root, 'missing-executable'), []];
    await assert.rejects(vm.runInContext('runProcess(...command)', context));
    await captureChild(children.at(-1)).closed;
    const updated = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(updated.some(item => item.event === 'process.error' && item.error.code === 'ENOENT' && item.error.syscall.startsWith('spawn')));
  } finally {
    for (const child of children) await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bridge records errors without a window and does not redact functional result URLs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-bridge-diagnostics-'));
  try {
    const context = mainContext(root,{$processOutputFixture:true});
    context.childScript = `process.stderr.write('traceback-head\\n' + 'x'.repeat(9000) + '\\ntraceback-tail'); process.exitCode = 1;`;
    vm.runInContext('bridgeArgs = () => ({command: process.execPath, args: ["-e", childScript]});', context);
    await assert.rejects(vm.runInContext('runBridge("install")', context));
    const log = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8');
    assert.match(log, /traceback-head/);
    assert.match(log, /traceback-tail/);
    context.childScript = `console.log(JSON.stringify({event: 'result', url: 'https://example.test/?token=functional-result', ok: true}));`;
    const result = await vm.runInContext('runBridge("install")', context);
    assert.equal(result.url, 'https://example.test/?token=functional-result');
    assert.ok(!fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').includes('functional-result'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('gateway identity explanation reaches the UI even when traceback arrives after its error event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-gateway-identity-ui-'));
  try {
    const context = mainContext(root,{$processOutputFixture:true});
    const explanation = '无法确认安装记录中的后台进程是否属于诺拉：系统拒绝读取进程信息。请重启电脑后再试。';
    context.childScript = `console.log(JSON.stringify({event:'error',code:'EACCES',message:${JSON.stringify(explanation)}}));
      setTimeout(() => {process.stderr.write('Traceback: psutil.AccessDenied: (pid=5560)');process.exitCode=1;},30);`;
    vm.runInContext('bridgeArgs = () => ({command: process.execPath, args: ["-e", childScript]});', context);
    await assert.rejects(vm.runInContext('runBridge("start")', context), error => {
      assert.equal(error.message,explanation);assert.equal(error.code,'EACCES');return true;
    });
    assert.match(fs.readFileSync(path.join(root,'installer/install.log'),'utf8'),/psutil.AccessDenied/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('secrets are removed before the UI error summary is truncated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-long-secret-'));
  try {
    const context = mainContext(root,{$processOutputFixture:true});
    context.secret = 'private-value-' + 'a'.repeat(5000);
    vm.runInContext('diagnostics.addSecret(secret);', context);
    context.args = ['-e', `process.stderr.write(${JSON.stringify(context.secret)}); process.exitCode = 1;`];
    await assert.rejects(vm.runInContext('runProcess(process.execPath, args)', context), error => {
      assert.ok(!error.message.includes('a'.repeat(20)));
      assert.match(error.message, /REDACTED/);
      return true;
    });
    assert.ok(!fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').includes('a'.repeat(20)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('main records timeout and termination separately from an ordinary nonzero exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-timeout-diagnostics-'));
  try {
    const context = mainContext(root,{$processOutputFixture:true});
    context.setTimeout = (callback, delay) => setTimeout(callback, delay === 1800000 ? 80 : delay);
    await assert.rejects(vm.runInContext('runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"])', context));
    const records = fs.readFileSync(path.join(root, 'installer/install.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some(item => item.event === 'process.timeout' && item.timeoutMs === 1800000));
    assert.ok(records.some(item => item.event === 'process.exit' && item.timedOut));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('diagnostics retain full errors, nested causes, and separate attempts without secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-diagnostics-'));
  try {
    const log = path.join(root, 'install.log');
    const diagnostics = createDiagnostics({ primary: () => log, fallback: path.join(root, 'fallback.log') });
    diagnostics.addSecret('pair-code-fixture');
    const error = Object.assign(new Error('copy failed pair-code-fixture'), {
      code: 'EPERM', errno: -4048, syscall: 'symlink', path: 'D:\\诺拉 agent\\hermes\\skills\\apple',
      cause: new Error('original cause'), secondaryErrors: [{ operation: 'rollback', error: new Error('cleanup failed') }],
    });
    diagnostics.begin('attempt-one', { action: 'install', platform: 'win32', version: 'test' });
    diagnostics.event({ event: 'task', task: 'initialize', current: 2, total: 3 });
    diagnostics.event({ event: 'log', stream: 'stderr', line: 'long-output-' + 'x'.repeat(12000) + '-tail' });
    diagnostics.error('install.failed', error);
    diagnostics.finish('error');
    diagnostics.begin('attempt-two', { action: 'pair' });
    diagnostics.event({ event: 'log', line: 'API_KEY="fixture-secret with spaces" Authorization: Bearer token-fixture' });
    diagnostics.event({ event: 'command', command: ['python', '--token', 'secret-arg', 'https://host/path?token=url-secret'] });
    diagnostics.finish('ready');
    const raw = fs.readFileSync(log, 'utf8');
    for (const secret of ['pair-code-fixture', 'fixture-secret', 'token-fixture', 'secret-arg', 'url-secret']) assert.ok(!raw.includes(secret), secret);
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    const failure = records.find(item => item.event === 'install.failed');
    assert.equal(failure.runId, 'attempt-one');
    assert.equal(failure.stage, 'initialize');
    assert.equal(failure.error.syscall, 'symlink');
    assert.equal(failure.error.path, error.path);
    assert.match(failure.error.stack, /launcher_diagnostics.test.cjs/);
    assert.equal(failure.error.cause.message, 'original cause');
    assert.equal(failure.error.secondaryErrors[0].error.message, 'cleanup failed');
    assert.ok(records.some(item => item.line?.endsWith('-tail') && item.line.length > 12000));
    assert.ok(records.some(item => item.runId === 'attempt-two' && item.event === 'run.end' && item.durationMs >= 0));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an inaccessible install directory still writes the failure to the fallback log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-diagnostics-fallback-'));
  try {
    const fallback = path.join(root, 'fallback', 'install.log');
    const diagnostics = createDiagnostics({ primary: () => { throw new Error('location missing'); }, fallback });
    diagnostics.error('startup.failed', new Error('cannot load installation'));
    const record = JSON.parse(fs.readFileSync(fallback, 'utf8'));
    assert.equal(record.error.message, 'cannot load installation');
    assert.equal(record.logWriteError.message, 'location missing');
    assert.equal(diagnostics.lastFile, fallback);
    const cycle = new Error('cycle'); cycle.cause = cycle;
    assert.doesNotThrow(() => JSON.stringify(errorDetails(cycle)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const maxLogBytes = 10 * 1024 * 1024;
function retainedRecords(file) {
  return [ `${file}.2`, `${file}.1`, file ].filter(name => fs.existsSync(name)).flatMap(name => {
    assert.ok(fs.statSync(name).size <= maxLogBytes, name);
    return fs.readFileSync(name, 'utf8').trim().split('\n').map(JSON.parse);
  });
}

for (const useFallback of [false, true]) {
  test(`logs retain three bounded files across restarts (${useFallback ? 'fallback' : 'primary'})`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-log-rotation-'));
    try {
      const file = path.join(root, 'install.log');
      const options = { primary: () => {
        if (useFallback) throw new Error('disk missing');
        return file;
      }, fallback: file };
      const line = '诺'.repeat(1024 * 1024);
      for (let sequence = 0; sequence < 11; sequence++) {
        const diagnostics = createDiagnostics(options);
        diagnostics.write('fixture', { sequence, line });
        assert.equal(diagnostics.lastFile, file);
      }
      assert.deepEqual(fs.readdirSync(root).sort(), ['install.log', 'install.log.1', 'install.log.2']);
      const records = retainedRecords(file);
      assert.deepEqual(records.map(record => record.sequence), [3, 4, 5, 6, 7, 8, 9, 10]);
      assert.ok(records.every(record => record.line === line));
      if (useFallback) assert.ok(records.every(record => record.logWriteError.message === 'disk missing'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('oversized records are bounded, redacted, and reconstructable without losing unicode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-log-fragments-'));
  try {
    const file = path.join(root, 'install.log');
    const diagnostics = createDiagnostics({ primary: () => file, fallback: path.join(root, 'fallback.log') });
    diagnostics.addSecret('fixture-private-value');
    const line = '世界'.repeat(2 * 1024 * 1024) + 'fixture-private-value-tail';
    diagnostics.write('fixture.large', { line });
    const fragments = retainedRecords(file);
    assert.ok(fragments.length > 1);
    assert.ok(fragments.every((part, index) => part.event === 'log.fragment' && part.id === fragments[0].id
      && part.total === fragments.length && part.index === index && part.encoding === 'base64-json'));
    const record = JSON.parse(Buffer.from(fragments.map(part => part.data).join(''), 'base64').toString('utf8'));
    assert.equal(record.event, 'fixture.large');
    assert.equal(record.line, line.replace('fixture-private-value', '[REDACTED]'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy oversized logs keep bounded recent complete lines and mark history removal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-log-legacy-'));
  try {
    const file = path.join(root, 'install.log');
    const old = `${JSON.stringify({ event: 'old', line: 'x'.repeat(1024 * 1024) })}\n`;
    fs.writeFileSync(file, old.repeat(11) + `${JSON.stringify({ event: 'recent' })}\n`);
    createDiagnostics({ primary: () => file, fallback: path.join(root, 'fallback.log') }).write('new');
    const records = retainedRecords(file);
    assert.equal(records[0].event, 'log.history-trimmed');
    assert.ok(records[0].originalBytes > maxLogBytes);
    assert.deepEqual(records.slice(-2).map(record => record.event), ['recent', 'new']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rotation errors use the fallback and preserve the original operation error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-log-rotate-error-'));
  try {
    const file = path.join(root, 'install.log');
    const fallback = path.join(root, 'fallback', 'install.log');
    fs.writeFileSync(file, 'x'.repeat(maxLogBytes));
    fs.mkdirSync(`${file}.2`);
    const diagnostics = createDiagnostics({ primary: () => file, fallback });
    assert.doesNotThrow(() => diagnostics.error('install.failed', new Error('original operation failure')));
    const [record] = retainedRecords(fallback);
    assert.equal(record.error.message, 'original operation failure');
    assert.ok(record.logWriteError.code);
    assert.equal(diagnostics.lastFile, fallback);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual runtime extraction failure automatically produces an authorized bounded fault packet',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-real-fault-'));
  let client;
  try {
    const context=mainContext(root,{$processOutputFixture:true});const sent=[];
    client=createTelemetry({file:path.join(root,'telemetry.json'),launcherVersion:'1.1.2',automatic:false,
      clean:value=>String(value).replaceAll('fixture-secret','[REDACTED]'),roots:()=>[root],
      fetcher:async(_url,options)=>{const data=JSON.parse(options.body);sent.push(...data.events);return Response.json({accepted_event_ids:data.events.map(e=>e.event_id),rejected_event_ids:[]});}});
    client.setEnabled(true);client.begin('install');client.stage('runtime_extract');context.testTelemetry=client;
    vm.runInContext("telemetry=testTelemetry;writeInstallerState({...readInstallerState(),phase:'installing'});diagnostics.addSecret('fixture-secret');",context);
    context.command=[process.execPath,['-e',`
      console.log(JSON.stringify({event:'diagnostic',component:'runtime',error:{name:'Error',message:'symlink denied',code:'EPERM',syscall:'symlink',path:'/Users/private/skills',stack:'Error: symlink denied\\n at extract (/Users/private/runtime.js:42:8)'}}));
      process.stderr.write('installer tool: token=fixture-secret failed');process.exitCode=2;
    `]];
    try {await vm.runInContext('runProcess(...command)',context);assert.fail('expected child failure');}
    catch(error){client.finish('failed',error);}
    await client.flush();const last=sent.find(e=>e.event==='operation_finished');
    assert.equal(last.exit_code,2);assert.equal(last.system_code,'');assert.ok(last.fault.errors.some(e=>e.relation==='child'&&e.syscall==='symlink'));
    assert.equal(last.fault.output.some(line=>line.includes('installer tool')),true,'owned installer stderr is reviewed and retained after redaction');assert.doesNotMatch(JSON.stringify(last.fault),/fixture-secret|Users\/private/);
  } finally {client?.close();fs.rmSync(root,{recursive:true,force:true});}
});
