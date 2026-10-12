const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const policy=require('../installer/desktop/operation-policy');
const transaction=require('../installer/desktop/runtime-transaction');
const {treeSeal}=require('../installer/desktop/tree-integrity');
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-partial-managed-'))),home=path.join(root,'hermes'),tavern=path.join(root,'tavern');
 const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 write('hermes/nora-instance.json',{schema:1,noraHome:root,hermesHome:home,installRoot:tavern,port:18899});
 const version='2.4.5',commit='a'.repeat(40);
 write('tavern/tavern-updates/installed.json',{schema:2,version,commit});
 write('tavern/tavern-updates/installed-manifest.json',{schema:'tavern-release/v2',commit,versions:{tavern:version}});
 write('tavern/tavern-updates/nora-system.json',{schema:1,version,commit,proof:Object.fromEntries(['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'].map(key=>[key,true]))});
 write('hermes/hermes-agent/.hermes-bootstrap-complete',{schema:1,source:'nora-integrated-runtime',sha256:'c'.repeat(64),platform:process.platform,arch:process.arch});
 write('hermes/config.yaml','existing config bytes\n');write('hermes/.env','existing credential\n');
 write('tavern/tavern-state/chats/story.json','retained story\n');
 const args={noraHome:root,hermesHome:home,installRoot:tavern,port:18899};
 const facts=()=>policy.inspectManagedInstallation(args);
 const snapshot=()=>({schema:'nora-managed-partial-installation/1',version,commit,bindings:facts().bindings,missing:facts().missing,programs:{app:null,ops:null,'nora-mcp':null}});
 return {root,home,tavern,write,args,facts,snapshot};
}
function releaseFixture(version='2.4.6'){
 const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),commit='b'.repeat(40),platform=process.platform,arch=process.arch;
 const launcherCapabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
 const manifest={schema:'tavern-release/v2',candidate:false,commit,versions:{tavern:version},launcherVersion:'2.1.3',launcherCapabilities,
  bootstrap:{managedComponents:1,minimumLauncherVersion:'2.1.3',sha256:hash('bootstrap')},
  archives:Object.fromEntries([['app','nora-tavern-app.tar.gz','app'],['ops','nora-tavern-ops.tar.gz','ops'],['nora-mcp','nora-tavern-nora-mcp.tar.gz','mcp']]
   .map(([part,name,bytes])=>[part,{name,sha256:hash(bytes),size:Buffer.byteLength(bytes)}])),hermesRuntime:{sha256:hash('runtime')},dependencies:{sha256:hash('deps')}};
 const bytes={'release-manifest.json':JSON.stringify(manifest),'nora-tavern-app.tar.gz':'app','nora-tavern-ops.tar.gz':'ops',
  'nora-tavern-nora-mcp.tar.gz':'mcp','nora-tavern-first-install-bootstrap.py':'install','first-install-manifest.json':'{}',
  'runtime.tar.gz':'runtime','deps.tar.gz':'deps','nora-hermes-runtime.json':JSON.stringify({platform,arch,archive:'runtime.tar.gz',sha256:hash('runtime')}),
  'nora-tavern-dependencies.json':JSON.stringify({platform,arch,archive:'deps.tar.gz',sha256:hash('deps')})};
 bytes.SHA256SUMS=Object.entries(bytes).map(([name,value])=>`${hash(value)}  ${name}`).join('\n');
 const system={schema:'nora-system/v1',candidate:false,version,commit,platform,arch,minimumLauncherVersion:'2.1.3',launcherCapabilities,
  files:Object.fromEntries(Object.entries(bytes).map(([name,value])=>[name,{asset:name,size:Buffer.byteLength(value),sha256:hash(value)}]))};
 bytes[`nora-system-${platform}-${arch}.json`]=JSON.stringify(system);
 const release={tag_name:`v${version}`,draft:false,prerelease:false,assets:Object.entries(bytes).map(([name,value])=>({name,state:'uploaded',size:Buffer.byteLength(value),
  digest:`sha256:${hash(value)}`,browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v${version}/${name}`}))};
 const fetcher=async url=>{if(url==='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest')return Response.json(release);
  const asset=release.assets.find(item=>item.browser_download_url===url);assert.ok(asset,'Only the selected fixture release may be fetched');
  return new Response(bytes[asset.name],{headers:{'Content-Length':String(asset.size)}});};
 return {version,commit,manifest,fetcher};
}
test('managed missing programs keep their receipt; conflicting records cannot become fresh install',()=>{
 const f=fixture();try{assert.equal(f.facts().managedInstallation,true);assert.equal(f.facts().needsRepair,true);assert.equal(f.facts().version,'2.4.5');
  f.write('tavern/tavern-updates/installed.json',{schema:2,version:'2.0.1',commit:'a'.repeat(40)});
  assert.throws(f.facts,{code:'MANAGED_INSTALLATION_UNCONFIRMED'});assert.equal(fs.readFileSync(path.join(f.home,'.env'),'utf8'),'existing credential\n');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('canonical partial restoration checks exact bindings and missing set instead of a confirmed label',()=>{
 const f=fixture();try{const original=f.snapshot();assert.equal(transaction.partialStateMatches(original,f.args),true);
  f.write('hermes/hermes-agent/venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'),'new Python');
  assert.equal(transaction.partialStateMatches(original,f.args),false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('partial runtime preflight happens before the original tree can move; rejection preserves full seal',async()=>{
 const f=fixture();try{
  const operationId=crypto.randomUUID(),ownerEpoch=1,delegate={context:{operationId,ownerEpoch},active:true,assertActive(){}};
  const payload=path.join(f.root,'payload');fs.mkdirSync(payload);fs.writeFileSync(path.join(payload,'manifest.json'),'fixture');
  let preflight=0;const manifest={sha256:'b'.repeat(64),platform:process.platform,arch:process.arch};
  const tools={findBundledRuntime:()=>({archive:'fixture',manifest,manifestPath:path.join(payload,'manifest.json')}),sha256File:()=>manifest.sha256,
   extractArchiveAsync:async(_,directory)=>{f.write(path.relative(f.root,path.join(directory,'hermes-runtime/hermes-agent/program')),'new program');},
   validateRuntimeLinks(){},initializeHome(){},repairRuntimeAsync:async()=>{},validateRuntimeAsync:async()=> 'fixture',relocateTextFiles(){}};
  const original=treeSeal(f.home);
  await assert.rejects(transaction.install({payloadRoot:payload,...f.args,operationId,ownerEpoch,delegate,tools,
   partialRepair:{...f.facts()},preflightPartial:async()=>{preflight++;throw Object.assign(new Error('service still running'),{code:'OFFLINE_UNCONFIRMED'});}}),{code:'OFFLINE_UNCONFIRMED'});
  assert.equal(preflight,1);assert.deepEqual(treeSeal(f.home),original);assert.equal(transaction.inspect({...f.args,operationId}).effectState,'untouched');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a rejected partial preflight can preserve its owned stage in history before the next readonly inspection',async()=>{
 const f=fixture();try{
  const operationId=crypto.randomUUID(),ownerEpoch=1,delegate={context:{operationId,ownerEpoch},active:true,assertActive(){}};
  const payload=path.join(f.root,'payload');fs.mkdirSync(payload);fs.writeFileSync(path.join(payload,'manifest.json'),'same fixed manifest');
  const manifest={sha256:'b'.repeat(64),platform:process.platform,arch:process.arch},bundle={archive:'fixture',manifest,manifestPath:path.join(payload,'manifest.json')};
  const tools={findBundledRuntime:()=>bundle,sha256File:()=>manifest.sha256,extractArchiveAsync:async(_,directory)=>{
   f.write(path.relative(f.root,path.join(directory,'hermes-runtime/hermes-agent/program')),'retained failed stage');},
   validateRuntimeLinks(){},initializeHome(){},repairRuntimeAsync:async()=>{},validateRuntimeAsync:async()=> 'fixture',relocateTextFiles(){}};
  const options={...f.args,operationId,ownerEpoch,delegate},original=treeSeal(f.home);
  await assert.rejects(transaction.install({...options,payloadRoot:payload,tools,partialRepair:f.facts(),
   preflightPartial:async()=>{throw Object.assign(new Error('still running'),{code:'OFFLINE_UNCONFIRMED'});}}),{code:'OFFLINE_UNCONFIRMED'});
  const stage=path.join(f.root,'installer/operations',operationId,'runtime/hermes-runtime');assert.equal(fs.existsSync(stage),true);
  assert.throws(()=>transaction.archiveAttempt({...options,bundle:{...bundle,manifest:{...manifest,sha256:'e'.repeat(64)}}}),{code:'RUNTIME_RECOVERY_REQUIRED'});
  assert.equal(fs.existsSync(stage),true,'a different release cannot archive the prior attempt');
  const history=path.join(f.root,'installer/operations',operationId,'runtime-history'),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,history,'dir');
  assert.throws(()=>transaction.archiveAttempt({...options,bundle}),{code:'RUNTIME_JOURNAL_INVALID'});
  assert.equal(fs.existsSync(stage),true);assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(history);
  const archived=transaction.archiveAttempt({...options,bundle});assert.equal(archived.attempt,2);assert.equal(fs.existsSync(stage),false);
  assert.equal(fs.readFileSync(path.join(path.dirname(archived.evidenceReference),'tree/hermes-runtime/hermes-agent/program'),'utf8'),'retained failed stage');
  assert.deepEqual(treeSeal(f.home),original);assert.equal(transaction.inspect(options).effectState,'untouched');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a rejected private readonly inspection cleans only its new stage so stopped-service retry can proceed',async()=>{
 const f=fixture();try{
  const vm=require('node:vm'),{Readable}=require('node:stream'),operationId=crypto.randomUUID(),stage=path.join(f.root,'installer/operations',operationId,'runtime/hermes-runtime');
  const app=path.join(f.root,'app');fs.mkdirSync(app);fs.writeFileSync(path.join(app,'launcher_bridge.py'),'fixture');
  const original=treeSeal(f.home),snapshot=f.snapshot();let extractions=0,helpers=0;
  const invoke=async stopped=>{
   let closed,output='';const done=new Promise(resolve=>{closed=resolve;});
   const delegate={context:{operationId,ownerEpoch:1},assertActive(){},close(){closed();},run:async(_,args,options)=>{
    helpers++;assert.equal(options.timeoutMs,300000);
    if(!stopped)return {status:1,stderr:'service still running'};
    return {status:0,stdout:JSON.stringify({event:'result',partialRepair:snapshot,offline:true,running:false,gatewayRunning:false,clawchatConnected:false,
     effects:{effectState:'untouched',recoveryOutcome:'not-required'}})+'\n'};
   }};
   const runtime={findBundledRuntime:()=>({archive:'fixture',manifest:{sha256:'b'.repeat(64),venvPython:'hermes-agent/venv/bin/python'}}),sha256File:()=> 'b'.repeat(64),
    extractArchiveAsync:async()=>{extractions++;fs.writeFileSync(path.join(stage,'inspector-owned-program'),'fixture');},repairRuntimeAsync:async()=>{},validateRuntimeAsync:async()=>{},installBundledHermes:async()=>{}};
   const proc={argv:['node','runtime-worker.js','fixture-payload',f.root,f.home,'--inspect-managed','--repair-managed'],env:process.env,
    stdin:Readable.from([Buffer.from(JSON.stringify(f.facts()))]),cwd:()=>app,stdout:{write:text=>{output+=text;}},stderr:{write(){}},exitCode:0};
   const context=vm.createContext({require:id=>id==='./runtime'?runtime:id==='./operation-delegate'?{connect:async()=>delegate}:
    id==='./diagnostics'?{errorDetails:error=>({message:error.message})}:id==='./runtime-transaction'?transaction:require(id),process:proc,Buffer});
   vm.runInContext(fs.readFileSync(path.join(__dirname,'../installer/desktop/runtime-worker.js'),'utf8'),context);await done;return {code:proc.exitCode,output};
  };
  const refused=await invoke(false);assert.equal(refused.code,1);assert.ok(refused.output.includes('service still running'));assert.equal(fs.existsSync(stage),false);
  const accepted=await invoke(true);assert.equal(accepted.code,0);assert.ok(accepted.output.includes('"event":"result"'));assert.equal(fs.existsSync(stage),false);
  assert.equal(extractions,2);assert.equal(helpers,3);assert.deepEqual(treeSeal(f.home),original);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('actual private inspector and recovery reject redirected stage ancestors before extracting or executing',async()=>{
 for(const mode of ['--inspect-managed','--recover-runtime']){
  const f=fixture();try{
   const vm=require('node:vm'),{Readable}=require('node:stream'),operationId=crypto.randomUUID(),op=path.join(f.root,'installer/operations',operationId),outside=path.join(f.root,'outside');
   fs.mkdirSync(op,{recursive:true});fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(op,'runtime'),'dir');
   const app=path.join(f.root,'app');fs.mkdirSync(app);fs.writeFileSync(path.join(app,'launcher_bridge.py'),'fixture');
   let extractions=0,helpers=0,output='',closed;
   const done=new Promise(resolve=>{closed=resolve;}),delegate={context:{operationId,ownerEpoch:1},assertActive(){},close(){closed();},
    run:async()=>{helpers++;throw Error('redirected stage must never execute');}};
   const runtime={findBundledRuntime:()=>({archive:'fixture',manifest:{sha256:'b'.repeat(64),venvPython:'hermes-agent/venv/bin/python'}}),sha256File:()=> 'b'.repeat(64),
    extractArchiveAsync:async()=>{extractions++;},repairRuntimeAsync:async()=>{},validateRuntimeAsync:async()=>{},installBundledHermes:async()=>{}};
   const proc={argv:['node','runtime-worker.js','fixture-payload',f.root,f.home,mode,'--repair-managed'],env:process.env,
    stdin:Readable.from([Buffer.from(JSON.stringify(f.facts()))]),cwd:()=>app,stdout:{write:text=>{output+=text;}},stderr:{write(){}},exitCode:0};
   const context=vm.createContext({require:id=>id==='./runtime'?runtime:id==='./operation-delegate'?{connect:async()=>delegate}:
    id==='./diagnostics'?{errorDetails:error=>({message:error.message})}:id==='./runtime-transaction'?transaction:require(id),process:proc,Buffer});
   vm.runInContext(fs.readFileSync(path.join(__dirname,'../installer/desktop/runtime-worker.js'),'utf8'),context);await done;
   assert.equal(proc.exitCode,1);assert.equal(extractions,0);assert.equal(helpers,0);assert.ok(!output.includes('"event":"result"'));
   assert.deepEqual(fs.readdirSync(outside),[],'redirected target remains untouched');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 }
});

test('a failed new runtime restores exact original missing programs and bytes; live service proof refuses rollback',async()=>{
 const f=fixture();try{
  const operationId=crypto.randomUUID(),ownerEpoch=1,delegate={context:{operationId,ownerEpoch},active:true,assertActive(){}};
  const payload=path.join(f.root,'payload');fs.mkdirSync(payload);fs.writeFileSync(path.join(payload,'manifest.json'),'fixture');
  const manifest={sha256:'b'.repeat(64),platform:process.platform,arch:process.arch};let checks=0;
  const tools={findBundledRuntime:()=>({archive:'fixture',manifest,manifestPath:path.join(payload,'manifest.json')}),sha256File:()=>manifest.sha256,
   extractArchiveAsync:async(_,directory)=>{f.write(path.relative(f.root,path.join(directory,'hermes-runtime/hermes-agent/program')),'new program');},
   validateRuntimeLinks(){},initializeHome(){},repairRuntimeAsync:async()=>{},
   validateRuntimeAsync:async root=>{checks++;if(!fs.existsSync(path.join(root,'hermes-agent/program')))throw new Error('old Python intentionally missing');return 'fixture';},relocateTextFiles(){}};
  const original=treeSeal(f.home),snapshot=f.snapshot();
  await transaction.install({payloadRoot:payload,...f.args,operationId,ownerEpoch,delegate,tools,partialRepair:f.facts(),
    preflightPartial:async()=>({partialRepair:snapshot,offline:true,running:false,gatewayRunning:false}),verifyOffline:async()=>({offline:true,running:false,gatewayRunning:false})});
  const before=treeSeal(f.home);
  await assert.rejects(transaction.recover({...f.args,operationId,ownerEpoch,delegate,tools,allowCommitted:true,
    verifyOffline:async()=>({offline:false,running:true,gatewayRunning:false})}),{code:'RUNTIME_OFFLINE_UNCONFIRMED'});
  assert.deepEqual(treeSeal(f.home),before);
  const restored=await transaction.recover({...f.args,operationId,ownerEpoch,delegate,tools,allowCommitted:true,
    verifyOffline:async()=>({offline:true,running:false,gatewayRunning:false})});
  assert.equal(checks,2,'only staged and new runtime are executable');assert.deepEqual(treeSeal(f.home),original);
  assert.equal(restored.originalState,'partial');assert.equal(restored.runtimeReady,false);assert.equal(restored.restorationVerification,'confirmed');
  f.write('hermes/.env','edited credential');
  assert.notEqual(transaction.inspect({...f.args,operationId}).restorationVerification,'confirmed');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('actual no-Python status and existing UI route retain repair action; corrupt history cannot show fresh install',async()=>{
 const f=fixture();try{
  const vm=require('node:vm'),desktop=path.join(__dirname,'../installer/desktop'),{parse}=require(path.join(desktop,'node_modules/acorn'));
  const main=fs.readFileSync(path.join(desktop,'main.js'),'utf8'),ast=parse(main,{ecmaVersion:'latest'});
  const definition=name=>{const node=ast.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);return main.slice(node.start,node.end);};
  let callback;const walk=node=>{if(!node||typeof node!=='object')return;if(node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value==='nora:status')callback=node.arguments[1];for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}};walk(ast);
  let bridgeCalls=0;const context=vm.createContext({fs,path,require:id=>id==='./operation-policy'?policy:require(id),DEFAULT_PORT:18899,
   installRoot:()=>f.tavern,noraHome:()=>f.root,hermesHome:()=>f.home,readVerifiedModel:()=>null,findHermes:()=>null,
   readInstallerState:()=>({phase:'idle',port:18899}),locationStatus:()=>({noraHome:f.root}),quitting:false,uninstalling:false,selectingLocation:false,
   modelBusy:false,activeRun:false,statusRequest:null,activeOperationContext:null,releaseAbort:null,cancelled:false,updatingSystem:false,activeProcess:null,
   readLauncherRecovery:async()=>null,operations:()=>({snapshot:async()=>null}),systemUpdate:{inspect:()=>null},findPython:()=>null,
   runBridge:async()=>{bridgeCalls++;throw Error('no old Python should execute');},statusErrorMessage:error=>error.message,LOCAL_TEST:null});
  vm.runInContext(definition('nodeStatus')+'\n'+definition('taskCancellation'),context);
  const query=vm.runInContext('('+main.slice(callback.start,callback.end)+')',context),status=await query();
  assert.equal(status.installed,false);assert.equal(status.managedInstallation,true);assert.equal(status.version,'2.4.5');assert.equal(status.running,null);assert.equal(bridgeCalls,0);
  const source=fs.readFileSync(path.join(desktop,'../launcher-controller.js'),'utf8'),html=fs.readFileSync(path.join(desktop,'../launcher-conversation-prototype.html'),'utf8');
  const statements=parse(source,{ecmaVersion:'latest'}).body[0].expression.callee.body.body;
  const harness=fs.readFileSync(path.join(__dirname,'launcher_guidance_flow.test.cjs'),'utf8'),helper=harness.slice(harness.indexOf('function descendants('),harness.indexOf('\nconst ready='));
  const ui=vm.createContext({statements,source,html,vm,assert,Map,formatUserError:require(path.join(desktop,'error-presentation')).formatUserError});
  vm.runInContext(helper,ui);const page=ui.fixture({snapshot:status});await page.invoke('route()');
  assert.equal(page.output().view,'recovery');assert.ok(page.output().buttons.some(button=>button.text==='修复当前安装'&&!button.disabled));
  assert.ok(!page.output().buttons.some(button=>button.text.includes('安装酒馆')||button.text==='继续安装'));
  f.write('tavern/tavern-updates/installed.json',{schema:2,version:'2.0.1',commit:'a'.repeat(40)});
  const unavailable=await query();assert.equal(unavailable.statusUnavailable,true);assert.equal(unavailable.installed,undefined);assert.equal(bridgeCalls,0);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('complete legacy programs retain receipt-recovery upgrade path while first-install history guard remains closed',()=>{
 const f=fixture();try{
  f.write('tavern/apps/tavern-runtime/native-runtime.json','{}');f.write('tavern/apps/tavern-runtime/native_lifecycle.py','pass');
  const python='hermes/hermes-agent/venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python');f.write(python,'old Python');
  fs.unlinkSync(path.join(f.tavern,'tavern-updates/nora-system.json'));
  assert.equal(f.facts(),null,'full old programs are authenticated by existing bridge receiptRecovery');
  assert.equal(policy.hasManagedRecords(f.args),true,'history still prevents fresh installation');
  fs.unlinkSync(path.join(f.root,python));assert.throws(f.facts,'partial programs cannot use missing-receipt full upgrade contract');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('actual independent CLI repairs with a real sealed plan that has no inline release manifest',async t=>{
 for(const entry of ['bootstrap-update','bridge-repair'])await t.test(entry,async()=>{
  const f=fixture();try{
   const cli=require('../installer/desktop/operation-cli'),releases=require('../installer/desktop/releases'),release=releaseFixture(),
    bridge=path.join(f.root,'app/launcher_bridge.py'),updater=path.join(f.tavern,'apps/tavern-ops/updater/bootstrap.py'),viaBridge=entry==='bridge-repair';
   if(!viaBridge)f.write('hermes/hermes-agent/venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'),'existing Python');
   const snapshot=f.snapshot(),protectedBytes=Object.fromEntries(['hermes/config.yaml','hermes/.env','tavern/tavern-state/chats/story.json'].map(name=>[name,fs.readFileSync(path.join(f.root,name))]));
   const receipt={...f.args,installerDirectory:path.join(f.root,'installer'),resourcesRoot:path.join(f.root,'app'),platform:process.platform,arch:process.arch,
    channel:'stable',launcherVersion:'2.1.3',resources:{'launcher_bridge.py':{path:bridge},'first_install.py':{path:path.join(f.root,'app/first_install.py')},
    'bootstrap.py':{path:path.join(f.root,'app/bootstrap.py')}},managed:{'ops/updater/bootstrap.py':{path:updater}}};
   let lifecycle,applied=false,runtime=0;
   const completed={version:release.version,commit:release.commit,systemReady:true,running:false,gatewayRunning:false,
    clawchatConnected:false,port:receipt.port,noraHome:receipt.noraHome,hermesHome:receipt.hermesHome,installRoot:receipt.installRoot};
   const result=await cli.execute({receiptPath:'fixture',request:{schema:'nora-cli-request/1',kind:viaBridge?'repair':'update',
    argv:viaBridge?[bridge,'--nora-home',f.root,'repair']:[updater,'--apply','--confirm','--managed-home',f.root,'--hermes-home',f.home,'--install-root',f.tavern],stdin:''}},
    {validate:async()=>receipt,fetcher:release.fetcher,lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),telemetry:false,
     policy:{observe:async()=>applied?{effectState:'changed',recoveryOutcome:'not-required',canResume:true}:{effectState:'untouched'}},run:async(context,target,args,options)=>{
      if(options.node){assert.equal(viaBridge,true);assert.ok(args.includes('--repair-managed'));runtime++;
       f.write('hermes/hermes-agent/venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'),'repaired Python');return {};}
      if(options.readonly)return args.includes('repair-preflight')?{partialRepair:snapshot,offline:true,version:'2.4.5',
       running:false,gatewayRunning:false,clawchatConnected:false,systemReady:false}:completed;
      assert.equal(target,viaBridge?bridge:updater);const payload=args[args.indexOf('--release-dir')+1];
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(payload,'release-manifest.json'),'utf8')),release.manifest);
      lifecycle=options.lifecycle;applied=true;return {...completed,updateVerified:true};
     }});
   const sealed=result.target.releasePlan;assert.equal(sealed.releaseManifest,undefined);assert.equal(sealed.releaseManifestText,undefined);
   assert.equal(sealed.version,'2.4.6');assert.equal(sealed.manifestRef.schema,'nora-operation-manifest/1');assert.equal(sealed.manifestRef.operationId,result.operationId);
   assert.equal(result.state,'succeeded',JSON.stringify(result.currentFailure||result.primaryFailure));assert.equal(runtime,viaBridge?1:0);
   const validated=releases.validatePlan(sealed,{...receipt,operationDirectory:path.join(receipt.installerDirectory,'operations',result.operationId)});
   assert.deepEqual(validated.releaseManifest,release.manifest);
   if(!viaBridge){assert.deepEqual(lifecycle.partialRepair,snapshot);assert.deepEqual(lifecycle.before.partialRepair,snapshot);}
   for(const [name,bytes]of Object.entries(protectedBytes))assert.deepEqual(fs.readFileSync(path.join(f.root,name)),bytes,name);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
});

test('a real sealed partial-repair downgrade never executes runtime or maintenance and preserves existing data',async()=>{
 const f=fixture();try{
  const cli=require('../installer/desktop/operation-cli'),release=releaseFixture('2.4.4'),bridge=path.join(f.root,'app/launcher_bridge.py');
  const receipt={...f.args,installerDirectory:path.join(f.root,'installer'),resourcesRoot:path.join(f.root,'app'),platform:process.platform,arch:process.arch,
   channel:'stable',launcherVersion:'2.1.3',resources:{'launcher_bridge.py':{path:bridge},'first_install.py':{path:path.join(f.root,'app/first_install.py')},
   'bootstrap.py':{path:path.join(f.root,'app/bootstrap.py')}},managed:{}};
  const original=treeSeal(f.home),story=fs.readFileSync(path.join(f.tavern,'tavern-state/chats/story.json'));let runs=0;
  const result=await cli.execute({receiptPath:'fixture',request:{schema:'nora-cli-request/1',kind:'repair',argv:[bridge,'--nora-home',f.root,'repair'],stdin:''}},
   {validate:async()=>receipt,fetcher:release.fetcher,lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),telemetry:false,
    policy:{observe:async()=>({effectState:'untouched'})},run:async()=>{runs++;throw Error('a lower sealed target must not execute');}});
  assert.equal(result.state,'failed');assert.equal(result.currentFailure.code,'RELEASE_COMPATIBILITY');assert.equal(result.target.releasePlan.version,'2.4.4');
  assert.equal(result.target.releasePlan.releaseManifest,undefined);assert.equal(runs,0);assert.deepEqual(treeSeal(f.home),original);
  assert.deepEqual(fs.readFileSync(path.join(f.tavern,'tavern-state/chats/story.json')),story);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('CLI partial runtime failure reaches shared recovery before reporting the fixed operation outcome',async t=>{
 for(const scenario of ['restored','unknown-system-effects','recovery-failed','prepare-failed'])await t.test(scenario,async()=>{
  const f=fixture();try{
   const cli=require('../installer/desktop/operation-cli'),releases=require('../installer/desktop/releases'),release=releaseFixture(),
    bridge=path.join(f.root,'app/launcher_bridge.py'),native=path.join(f.tavern,'apps/tavern-runtime');
   f.write('app/launcher_bridge.py','fixture bridge execution boundary');
   f.write('tavern/apps/tavern-runtime/native-runtime.json','{}');f.write('tavern/apps/tavern-runtime/native_lifecycle.py','fixture native lifecycle');
   f.write('tavern/tavern-state/native-runtime/config.yaml','retained native config\n');
   f.write('tavern/tavern-updates/transaction.json',{schema:1,operationId:crypto.randomUUID(),status:'committed'});
   const stat=fs.lstatSync(native,{bigint:true}),snapshot={...f.snapshot(),programs:{
    app:{identity:[String(stat.dev),String(stat.ino)],digest:transaction.programDigest(native)},ops:null,'nora-mcp':null}};
   assert.deepEqual(snapshot.missing,{nativeRuntime:false,nativeLifecycle:false,python:true});
   const original=treeSeal(f.home),systemBefore=fs.readFileSync(path.join(f.tavern,'tavern-updates/transaction.json')),
    protectedBytes=Object.fromEntries(['hermes/config.yaml','hermes/.env','tavern/tavern-state/chats/story.json',
     'tavern/tavern-state/native-runtime/config.yaml'].map(name=>[name,fs.readFileSync(path.join(f.root,name))]));
   const receipt={...f.args,installerDirectory:path.join(f.root,'installer'),resourcesRoot:path.join(f.root,'app'),platform:process.platform,arch:process.arch,
    channel:'stable',launcherVersion:'2.1.3',resources:{'launcher_bridge.py':{path:bridge},'first_install.py':{path:path.join(f.root,'app/first_install.py')},
     'bootstrap.py':{path:path.join(f.root,'app/bootstrap.py')}},managed:{}};
   let runtimeCalls=0,recoveryCalls=0,inspectionCalls=0,maintenanceCalls=0,activated=false,effectAtRuntime;
   const unchangedSystem={effectState:'untouched',recoveryOutcome:'not-required',canRecover:false,reason:'other_operation'};
   const offline=()=>({offline:true,running:false,gatewayRunning:false,clawchatConnected:false});
   const proof=effects=>({partialRepair:snapshot,...offline(),effects});
   const result=await cli.execute({receiptPath:'fixture',request:{schema:'nora-cli-request/1',kind:'repair',
    argv:[bridge,'--nora-home',f.root,'repair'],stdin:''}},
    {validate:async()=>receipt,lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),telemetry:false,
     fetcher:async url=>scenario==='prepare-failed'&&url.endsWith('/nora-tavern-app.tar.gz')
      ?new Response('bad',{headers:{'Content-Length':'3'}}):release.fetcher(url),
     // Execute the real CLI, release sealing, controller, shared policy and
     // filesystem transaction. Only runtime/bridge execution is a fixture;
     // this does not certify a packaged APP, Python reader or native OS lease.
     run:async(context,target,args,options)=>{
      if(!options.node){
       if(options.readonly&&args.includes('operation-effects'))return {effects:unchangedSystem};
       maintenanceCalls++;throw Error('runtime failure must not run the system updater or old Python');
      }
      assert.match(target,/runtime-worker\.js$/);assert.equal(args[1],f.root);assert.equal(args[2],f.home);
      const request=JSON.parse(options.stdin.toString('utf8'));assert.equal(request.missing.python,true);assert.deepEqual(request.bindings,snapshot.bindings);
      if(args.includes('--inspect-managed')){
       inspectionCalls++;
       return proof(runtimeCalls&&scenario==='unknown-system-effects'
        ?{effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false}:unchangedSystem);
      }
      const delegate={context:{operationId:context.operationId,ownerEpoch:context.ownerEpoch},active:true,assertActive:()=>context.check()};
      const transactionOptions={...f.args,operationId:context.operationId,ownerEpoch:context.ownerEpoch,delegate};
      if(args.includes('--recover-runtime')){
       recoveryCalls++;assert.equal(args.includes('--allow-committed'),true);
       if(scenario==='recovery-failed')throw Object.assign(new Error('fixture runtime recovery reader failed'),{code:'RUNTIME_RECOVERY_FAILED'});
       await transaction.recover({...transactionOptions,allowCommitted:true,verifyOffline:async()=>offline()});
       transaction.confirmPartialSystemProof(transactionOptions,unchangedSystem);
       const facts=transaction.inspect(transactionOptions);assert.equal(facts.restorationVerification,'confirmed');
       return {...facts,offlineProof:{...offline(),operationId:context.operationId,ownerEpoch:context.ownerEpoch}};
      }
      runtimeCalls++;effectAtRuntime=context.snapshot.effectState;
      assert.equal(args.includes('--repair-managed'),true);const payload=args[0];
      const descriptor=JSON.parse(fs.readFileSync(path.join(payload,'nora-hermes-runtime.json'),'utf8')),
       manifest={...descriptor,venvPython:process.platform==='win32'?'hermes-agent/venv/Scripts/python.exe':'hermes-agent/venv/bin/python'};
      const tools={findBundledRuntime:()=>({archive:path.join(payload,descriptor.archive),manifest,manifestPath:path.join(payload,'nora-hermes-runtime.json')}),
       sha256File:file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
       extractArchiveAsync:async(_,directory)=>{
        f.write(path.relative(f.root,path.join(directory,'hermes-runtime',manifest.venvPython)),'non-executable new Python fixture');
        f.write(path.relative(f.root,path.join(directory,'hermes-runtime/hermes-agent/program')),'new program fixture');
       },validateRuntimeLinks(){},initializeHome(){},repairRuntimeAsync:async()=>{},relocateTextFiles(){},
       validateRuntimeAsync:async root=>{
        assert.equal(fs.existsSync(path.join(root,manifest.venvPython)),true);
        if(root===f.home){activated=true;throw Object.assign(new Error('fixture fault after activated runtime validation'),{code:'RUNTIME_AFTER_ACTIVATION'});}
        return 'fixture';
       }};
      return transaction.install({...transactionOptions,payloadRoot:payload,tools,partialRepair:request,
       preflightPartial:async()=>proof(unchangedSystem),verifyOffline:async()=>offline()});
     }});
   const sealed=result.target.releasePlan;assert.equal(sealed.releaseManifest,undefined);assert.equal(sealed.version,'2.4.6');
   const opDirectory=path.join(receipt.installerDirectory,'operations',result.operationId),
    validated=releases.validatePlan(sealed,{...receipt,operationDirectory:opDirectory}),
    persisted=JSON.parse(fs.readFileSync(path.join(opDirectory,'operation.json'),'utf8'));
   assert.deepEqual(validated.releaseManifest,release.manifest);assert.equal(persisted.target.releasePlan.planId,sealed.planId);
   assert.equal(persisted.operationId,result.operationId);assert.equal(maintenanceCalls,0);
   assert.deepEqual(treeSeal(f.home),original);assert.deepEqual(transaction.partialStateMatches(snapshot,f.args),true);
   assert.deepEqual(fs.readFileSync(path.join(f.tavern,'tavern-updates/transaction.json')),systemBefore);
   for(const [name,bytes]of Object.entries(protectedBytes))assert.deepEqual(fs.readFileSync(path.join(f.root,name)),bytes,name);
   if(scenario==='prepare-failed'){
    assert.equal(runtimeCalls,0);assert.equal(recoveryCalls,0);assert.equal(activated,false);assert.equal(inspectionCalls,1);
    assert.equal(result.state,'failed');assert.equal(result.effectState,'untouched');assert.equal(result.recoveryOutcome,'not-required');
    assert.equal(result.verification,'unconfirmed');assert.equal(fs.existsSync(path.join(opDirectory,'runtime-bootstrap.json')),false);
    return;
   }
   assert.equal(runtimeCalls,1);assert.equal(activated,true);assert.equal(result.primaryFailure.code,'RUNTIME_AFTER_ACTIVATION');
   const journal=JSON.parse(fs.readFileSync(path.join(opDirectory,'runtime-bootstrap.json'),'utf8'));
   assert.equal(journal.status,'rolled-back');assert.equal(journal.nextActivated,true);assert.equal(journal.previousRestored,true);
   assert.equal(journal.operationId,result.operationId);assert.deepEqual(journal.originalPartial,snapshot);
   assert.equal(fs.existsSync(transaction.paths({...f.args,operationId:result.operationId}).failed),true,'failed new runtime remains owned evidence');
   if(scenario==='restored'){
    assert.equal(result.state,'rolled-back');assert.equal(result.effectState,'restored');assert.equal(result.recoveryOutcome,'restored-and-verified');
    assert.equal(result.verification,'confirmed');assert.equal(recoveryCalls,1);assert.equal(inspectionCalls,2);
    assert.equal(result.result.originalState,'partial');assert.equal(result.result.runtimeReady,false);assert.equal(result.result.systemReady,false);
    assert.equal(result.result.running,false);assert.equal(result.result.gatewayRunning,false);
    assert.equal(journal.partialSystemProof.journalSeal.sha256,crypto.createHash('sha256').update(systemBefore).digest('hex'));
    assert.equal(journal.partialSystemProof.stateDigest,transaction.programDigest(path.join(f.tavern,'tavern-state')));
   }else{
    assert.equal(result.state,'failed');assert.equal(result.effectState,'unknown');assert.equal(result.recoveryOutcome,'recovery-required');
    assert.notEqual(result.verification,'confirmed');assert.equal(journal.partialSystemProof,undefined);
    assert.equal(recoveryCalls,scenario==='recovery-failed'?1:0);assert.equal(inspectionCalls,2);
    assert.ok(result.secondaryFailures.some(item=>item.operation==='recover'&&item.code===
     (scenario==='recovery-failed'?'RUNTIME_RECOVERY_FAILED':'UPDATE_RECOVERY_REQUIRED')));
   }
   assert.equal(effectAtRuntime,'unknown','runtime may change directories before the system updater begins');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
});

test('CLI resumption rejects a changed real sealed manifest before reselecting or executing a partial repair',async()=>{
 const f=fixture();try{
  const cli=require('../installer/desktop/operation-cli'),releases=require('../installer/desktop/releases'),{createOperationController}=require('../installer/desktop/operation-state'),
   release=releaseFixture(),bridge=path.join(f.root,'app/launcher_bridge.py'),lock=require('./launcher_operation_test_lock.cjs').createTestOperationLock();
  const receipt={...f.args,installerDirectory:path.join(f.root,'installer'),resourcesRoot:path.join(f.root,'app'),platform:process.platform,arch:process.arch,
   channel:'stable',launcherVersion:'2.1.3',resources:{'launcher_bridge.py':{path:bridge},'first_install.py':{path:path.join(f.root,'app/first_install.py')},
   'bootstrap.py':{path:path.join(f.root,'app/bootstrap.py')}},managed:{}};
  const controller=createOperationController({directory:receipt.installerDirectory,lock,observeEffects:async()=>({effectState:'untouched'})});
  const paused=await controller.start('repair',{target:{request:{action:'repair',port:receipt.port}},execute:async context=>{
   const options={...receipt,mode:'install',fetcher:release.fetcher,operationDirectory:path.join(receipt.installerDirectory,'operations',context.operationId)};
   const selected=await releases.selectPlan(options),sealed=releases.sealPlan(selected,{...options,assertOwner:()=>context.check()});
   await context.plan({request:{action:'repair',port:receipt.port},releasePlan:sealed,currentVersion:'2.4.5'});
   throw Error('pause after actual release sealing');
  }},crypto.randomUUID());
  const sealed=paused.target.releasePlan;assert.equal(sealed.releaseManifest,undefined);assert.equal(sealed.version,'2.4.6');
  const artifact=path.join(receipt.installerDirectory,'operations',paused.operationId,sealed.manifestRef.file);fs.appendFileSync(artifact,' ');
  const original=treeSeal(f.home),story=fs.readFileSync(path.join(f.tavern,'tavern-state/chats/story.json'));let reads=0,runs=0;
  const result=await cli.execute({receiptPath:'fixture',request:{schema:'nora-cli-request/1',kind:'repair',operationId:paused.operationId,snapshotSequence:paused.snapshotSequence,
   argv:[bridge,'--nora-home',f.root,'repair'],stdin:''}},
   {validate:async()=>receipt,fetcher:async()=>{reads++;throw Error('fixed corrupt plan must not reselect');},lock,telemetry:false,
    policy:{observe:async()=>({effectState:'untouched'})},run:async()=>{runs++;throw Error('corrupt fixed plan must not execute');}});
  assert.equal(result.operationId,paused.operationId);assert.equal(result.state,'failed');assert.equal(result.currentFailure.code,'RELEASE_COMPATIBILITY');
  assert.equal(result.target.releasePlan.planId,sealed.planId);assert.equal(reads,0);assert.equal(runs,0);assert.deepEqual(treeSeal(f.home),original);
  assert.deepEqual(fs.readFileSync(path.join(f.tavern,'tavern-state/chats/story.json')),story);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('missing Python recovery uses staged canonical effects and refuses unknown history before runtime recovery',async()=>{
 const f=fixture();try{
  f.write('tavern/tavern-updates/transaction.json',{status:'restored',untrustedFixtureLabel:true});
  const operationId=crypto.randomUUID(),record={operationId,kind:'update',target:{request:{port:18899}}},calls=[];
  const context={operationId,ownerEpoch:1,snapshot:record,check(){},stage:async()=>{}};
  const runtimeFacts={effectState:'restored',recoveryOutcome:'recovery-required',canRecover:true};
  const shared=policy.create({home:f.root,hermesHome:f.home,installRoot:f.tavern,inspectLegacy:()=>null,inspectRuntime:()=>runtimeFacts,
   bridge:async()=>{throw Error('missing original Python must not run');},
   runRuntime:async(_,request)=>{calls.push(request);assert.equal(request.inspectPartial,true);return {partialRepair:f.snapshot(),offline:true,
    running:false,gatewayRunning:false,clawchatConnected:false,effects:{effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:false}};}});
  const observation=await shared.observe(record);
  assert.deepEqual(observation,{effectState:'unknown',recoveryOutcome:'recovery-required',canRecover:true});
  const seal=treeSeal(f.home);
  await assert.rejects(shared.recover(context),{code:'UPDATE_RECOVERY_REQUIRED'});
  assert.equal(calls.length,1);assert.equal(calls[0].partialRepair.version,'2.4.5');
  assert.deepEqual(treeSeal(f.home),seal,'unknown physical history has not moved the original runtime');
  const unowned=policy.create({home:f.root,hermesHome:f.home,installRoot:f.tavern,inspectLegacy:()=>null,
   inspectRuntime:()=>({effectState:'unknown',canRecover:false}),bridge:async()=>({effects:{effectState:'unknown',canRecover:false}}),runRuntime:async()=>{throw Error('unowned runtime cannot recover');}});
  assert.equal((await unowned.observe(record)).canRecover,false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('default native CLI admission reaches managed Python repair only after orphan executor absence is proved',async()=>{
 const Module=require('node:module'),realLoad=Module._load,desktop=path.join(__dirname,'../installer/desktop'),
  cli=require('../installer/desktop/operation-cli'),native=require('../installer/desktop/operation-lock');
 try{
  for(const action of ['update','repair']){
   const f=fixture();try{
    const targetVersion='2.4.6',bridge=path.join(f.root,'app/launcher_bridge.py');
    f.write('payload/release-manifest.json',{versions:{tavern:targetVersion}});
    const dead=require('node:child_process').spawnSync(process.execPath,['-e',''],{encoding:'utf8'});
    assert.equal(dead.status,0);assert.ok(dead.pid>0);
    f.write('installer/operations/.guards/orphan.json',{schema:'nora-operation-guard/1',operationId:crypto.randomUUID(),
     jobs:[{jobId:crypto.randomUUID(),pid:dead.pid}]});
    const plan={schema:'nora-release-plan/1',mode:'install',version:targetVersion,commit:'b'.repeat(40),releaseManifest:{versions:{tavern:targetVersion}}};
    const releases={selectPlan:async options=>{assert.equal(options.mode,'install');return plan;},sealPlan:value=>value,validatePlan:value=>value,
     prepareInstall:async()=>path.join(f.root,'payload'),hash:async()=> 'b'.repeat(64),compare:(a,b)=>a===b?0:a<b?-1:1};
    Module._load=function(id,parent,...rest){if(id==='./releases'&&parent?.filename?.startsWith(desktop))return releases;return realLoad.call(this,id,parent,...rest);};
    const receipt={...f.args,installerDirectory:path.join(f.root,'installer'),resourcesRoot:path.join(f.root,'app'),platform:process.platform,arch:process.arch,
     channel:'stable',launcherVersion:targetVersion,resources:{'launcher_bridge.py':{path:bridge},'operation_control.py':{path:path.join(f.root,'app/operation_control.py')},
      'first_install.py':{path:path.join(f.root,'app/first_install.py')},'bootstrap.py':{path:path.join(f.root,'app/bootstrap.py')}},managed:{}};
    let checked=0,runtime=0,applied=0;
    const result=await cli.execute({receiptPath:'fixture',request:{schema:'nora-cli-request/1',kind:action,
     argv:[bridge,'--nora-home',f.root,action],stdin:''}},
     {validate:async()=>{checked++;return receipt;},telemetry:false,policy:{observe:async()=>applied?{effectState:'changed',recoveryOutcome:'not-required',canResume:true}:{effectState:'untouched'}},
      run:async(context,target,args,options)=>{
       assert.equal((await native.probe({directory:receipt.installerDirectory})).busy,true,'default OS lease remains held');
       if(options.node){
        assert.match(target,/runtime-worker\.js$/);assert.ok(args.includes('--repair-managed'));runtime++;
        assert.equal(JSON.parse(options.stdin.toString('utf8')).missing.python,true);
        f.write('hermes/hermes-agent/venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'),'repaired Python');return {};
       }
       if(options.readonly&&args.includes('repair-preflight'))return {partialRepair:f.snapshot(),offline:true,version:'2.4.5',
        running:false,gatewayRunning:false,clawchatConnected:false,systemReady:false};
       const completed={version:targetVersion,commit:plan.commit,systemReady:true,running:false,gatewayRunning:false,clawchatConnected:false,
        port:receipt.port,noraHome:receipt.noraHome,hermesHome:receipt.hermesHome,installRoot:receipt.installRoot};
       if(options.readonly)return completed;
       assert.equal(target,bridge);assert.ok(args.includes('update'));applied++;
       return {...completed,updateVerified:true};
      }});
    assert.equal(result.state,'succeeded');assert.equal(checked,2);assert.equal(runtime,1);assert.equal(applied,1);
    assert.equal((await native.probe({directory:receipt.installerDirectory})).busy,false,'native lease released after the actual operation commit');
    assert.equal(fs.readFileSync(path.join(f.tavern,'tavern-state/chats/story.json'),'utf8'),'retained story\n');
   }finally{Module._load=realLoad;fs.rmSync(f.root,{recursive:true,force:true});}
  }
 }finally{Module._load=realLoad;}
});

test('default native CLI missing-Python admission refuses conflicting ownership, unsupported action and an unconfirmed live executor',async()=>{
 const cli=require('../installer/desktop/operation-cli'),native=require('../installer/desktop/operation-lock');
 for(const scenario of ['conflicting-records','no-owned-records','start','live-executor']){
  const f=fixture();try{
   const bridge=path.join(f.root,'app/launcher_bridge.py'),receipt={...f.args,installerDirectory:path.join(f.root,'installer'),
    resourcesRoot:path.join(f.root,'app'),platform:process.platform,arch:process.arch,channel:'stable',launcherVersion:'2.1.2',
    resources:{'launcher_bridge.py':{path:bridge},'operation_control.py':{path:path.join(f.root,'app/operation_control.py')},
     'first_install.py':{path:path.join(f.root,'app/first_install.py')},'bootstrap.py':{path:path.join(f.root,'app/bootstrap.py')}},managed:{}};
   if(scenario==='conflicting-records')f.write('tavern/tavern-updates/installed.json',{schema:2,version:'2.0.1',commit:'a'.repeat(40)});
   if(scenario==='no-owned-records'){
    fs.unlinkSync(path.join(f.home,'nora-instance.json'));for(const name of ['nora-system.json','installed.json','installed-manifest.json'])fs.unlinkSync(path.join(f.tavern,'tavern-updates',name));
   }
   if(scenario==='live-executor')f.write('installer/operations/.guards/orphan.json',{schema:'nora-operation-guard/1',operationId:crypto.randomUUID(),
    jobs:[{jobId:crypto.randomUUID(),pid:process.pid}]});
   const before=treeSeal(f.home),data=fs.readFileSync(path.join(f.tavern,'tavern-state/chats/story.json')),action=scenario==='start'?'start':'repair';let calls=0;
   const code=scenario==='conflicting-records'?'MANAGED_INSTALLATION_UNCONFIRMED':scenario==='live-executor'?'OPERATION_EXECUTOR_UNCONFIRMED':'RESOURCE_INCOMPLETE';
   await assert.rejects(cli.execute({receiptPath:'fixture',request:{schema:'nora-cli-request/1',kind:action,
    argv:[bridge,'--nora-home',f.root,action],stdin:''}},
    {validate:async()=>receipt,telemetry:false,policy:{observe:async()=>({effectState:'untouched'})},
     fetcher:async()=>{calls++;throw Error('rejected admission must not download');},run:async()=>{calls++;throw Error('rejected admission must not execute');}}),{code});
   assert.equal(calls,0);assert.deepEqual(treeSeal(f.home),before);assert.deepEqual(fs.readFileSync(path.join(f.tavern,'tavern-state/chats/story.json')),data);
   assert.equal((await native.probe({directory:receipt.installerDirectory})).busy,false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 }
});

test('default CLI capability validation still binds the executable before optional Python admission',async()=>{
 const f=fixture(),capability=require('../installer/desktop/launcher-capability'),cli=require('../installer/desktop/operation-cli');
 try{
  const executable=process.platform==='darwin'?path.join(f.root,'app/Contents/MacOS/Nora'):path.join(f.root,'app/Nora.exe'),
   resourcesRoot=process.platform==='darwin'?path.join(f.root,'app/Contents/Resources'):path.join(f.root,'app/resources');
  f.write(path.relative(f.root,executable),'fixture executable');f.write(path.relative(f.root,path.join(resourcesRoot,'app.asar')),'fixture ASAR');
  f.write(path.relative(f.root,path.join(resourcesRoot,`app.asar.unpacked/node_modules/fs-native-extensions/prebuilds/${process.platform}-${process.arch}/fs-native-extensions.node`)),'fixture native');
  for(const name of capability.RESOURCE_NAMES)f.write(path.relative(f.root,path.join(resourcesRoot,name)),'fixture resource');
  const receipt=await capability.register({...f.args,executable,resourcesRoot,isPackaged:true,launcherVersion:'2.1.2',port:18899});
  let executed=0;
  await assert.rejects(cli.execute({receiptPath:capability.receiptPath(f.root),request:{schema:'nora-cli-request/1',kind:'repair',
   argv:[receipt.resources['launcher_bridge.py'].path,'--nora-home',f.root,'repair'],stdin:''}},
   {telemetry:false,run:async()=>{executed++;}}),{code:'OPERATION_CAPABILITY_INVALID'});
  assert.equal(executed,0);assert.equal(f.facts().missing.python,true);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('default native CLI partial recovery keeps the original operation and does not require the missing interpreter',async()=>{
 const f=fixture(),cli=require('../installer/desktop/operation-cli'),native=require('../installer/desktop/operation-lock'),
  {createOperationController}=require('../installer/desktop/operation-state');
 try{
  const bridge=path.join(f.root,'app/launcher_bridge.py'),receipt={...f.args,installerDirectory:path.join(f.root,'installer'),
   resourcesRoot:path.join(f.root,'app'),platform:process.platform,arch:process.arch,channel:'stable',launcherVersion:'2.1.2',
   resources:{'launcher_bridge.py':{path:bridge},'operation_control.py':{path:path.join(f.root,'app/operation_control.py')},
    'first_install.py':{path:path.join(f.root,'app/first_install.py')},'bootstrap.py':{path:path.join(f.root,'app/bootstrap.py')}},managed:{}};
  const controller=createOperationController({directory:receipt.installerDirectory,lock:native});
  const failed=await controller.start('update',{target:{request:{action:'update',port:18899}},execute:async context=>{
   await context.effect('changed');throw Object.assign(new Error('original partial failure'),{code:'EPIPE'});
  }},crypto.randomUUID());
  const original=treeSeal(f.home);let recovered=0;
  const result=await cli.execute({receiptPath:'fixture',request:{schema:'nora-cli-request/1',kind:'recover',
   argv:[bridge,'--nora-home',f.root,'recover-update','--operation-id',failed.operationId],stdin:''}},
   {validate:async()=>receipt,telemetry:false,run:async()=>{throw Error('the missing interpreter must not execute');},
    policy:{observe:async()=>({effectState:'changed',canRecover:true}),recover:async context=>{
     recovered++;assert.equal(context.operationId,failed.operationId);assert.equal((await native.probe({directory:receipt.installerDirectory})).busy,true);
     return {verification:'confirmed',value:{updateRecovered:true,originalState:'partial',runtimeReady:false,systemReady:false,
      running:false,gatewayRunning:false,clawchatConnected:false}};
    }}});
  assert.equal(recovered,1);assert.equal(result.operationId,failed.operationId);assert.equal(result.kind,'update');assert.equal(result.state,'rolled-back');
  assert.equal(result.primaryFailure.code,'EPIPE');assert.equal(result.result.systemReady,false);assert.equal(result.result.runtimeReady,false);
  assert.deepEqual(treeSeal(f.home),original);assert.equal((await native.probe({directory:receipt.installerDirectory})).busy,false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
