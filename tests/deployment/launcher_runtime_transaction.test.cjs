const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {acquire}=require('../installer/desktop/operation-lock');
const transaction=require('../installer/desktop/runtime-transaction');
const desktop=path.resolve(__dirname,'../installer/desktop');

// These fixtures verify physical swap/recovery effects and real extraction
// process ownership. They deliberately do not claim a complete Hermes build.
function fixture(){
  // Windows TEMP may be a DOS 8.3 alias. The real Python journal resolves it
  // to its native long path, so bind every fixture actor to that same root.
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-transaction-')));
  const payload=path.join(root,'payload'),home=path.join(root,'home'),hermes=path.join(home,'hermes');
  const source=path.join(root,'source/hermes-runtime');fs.mkdirSync(path.join(source,'hermes-agent'),{recursive:true});
  fs.mkdirSync(path.join(source,'logs'));fs.writeFileSync(path.join(source,'logs/new-stage.log'),'new failure evidence');
  fs.writeFileSync(path.join(source,'hermes-agent/program.txt'),'new-program');fs.mkdirSync(payload);
  const archive=path.join(payload,'runtime.tar.gz');
  const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'):'/usr/bin/tar';
  const packed=spawnSync(tar,['-czf',archive,'-C',path.dirname(source),'hermes-runtime']);assert.equal(packed.status,0,String(packed.stderr));
  const manifest={schema:1,platform:process.platform,arch:process.arch,archive:path.basename(archive),format:'tar.gz',
    sha256:crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),nodeLinks:{},relocatableFiles:[],
    componentProbe:'nora-clawchat-check.py',components:{clawchat:{revision:'a'.repeat(40)},liveware:{sha256:'b'.repeat(64)},files:{}}};
  fs.writeFileSync(path.join(payload,'nora-hermes-runtime.json'),JSON.stringify(manifest));
  fs.mkdirSync(path.join(hermes,'hermes-agent'),{recursive:true});
  fs.writeFileSync(path.join(hermes,'hermes-agent/.hermes-bootstrap-complete'),JSON.stringify({schema:1,source:'nora-integrated-runtime',
    sha256:'c'.repeat(64),platform:process.platform,arch:process.arch}));
  fs.writeFileSync(path.join(hermes,'hermes-agent/program.txt'),'old-program');fs.writeFileSync(path.join(hermes,'.env'),'DUMMY_SETTING=preserved\n');
  fs.mkdirSync(path.join(hermes,'logs'));fs.writeFileSync(path.join(hermes,'logs/old-record.log'),'old evidence');
  const tools=path.join(root,'fixture-tools.cjs');
  fs.writeFileSync(tools,`const runtime=require(${JSON.stringify(path.join(desktop,'runtime.js'))});module.exports={...runtime,
    initializeHome(home,manifest){if(process.env.NORA_FIXTURE_PREPARE_FAILURE==='1')throw Object.assign(new Error('copy fixture denied'),{code:'EPERM'});runtime.initializeHome(home,manifest);},
    async repairRuntimeAsync(){},async validateRuntimeAsync(home){if(process.env.NORA_FIXTURE_VERIFY_FAILURE==='1')throw Object.assign(new Error('restored runtime probe failed'),{code:'VERIFICATION_FAILED'});if(!require('node:fs').existsSync(require('node:path').join(home,'hermes-agent/program.txt')))throw new Error('fixture program missing');return 'runtime-fixture';}};`);
  const worker=path.join(root,'runtime-worker.js');
  fs.writeFileSync(worker,`const [payloadRoot,noraHome,hermesHome,mode,killAt]=process.argv.slice(2);
    const {connect}=require(${JSON.stringify(path.join(desktop,'operation-delegate.js'))});
    const transaction=require(${JSON.stringify(path.join(desktop,'runtime-transaction.js'))});
    (async()=>{const delegate=await connect();const {operationId,ownerEpoch}=delegate.context;
      const onEvent=event=>{process.stdout.write(JSON.stringify(event)+'\\n');if(event.phase===killAt)process.kill(process.pid,'SIGKILL');};
      const verifyOffline=async()=>{const retained=require(${JSON.stringify(path.join(desktop,'retained-installation.js'))}).inspect(noraHome,{operationId});
        const offline=require(${JSON.stringify(path.join(desktop,'uninstall-offline-check.js'))});await offline.portOffline(retained.port);
        offline.nativeOffline({root:transaction.paths({noraHome,hermesHome,operationId}).noraHome});await offline.portOffline(retained.port);
        return {offline:true,running:false,gatewayRunning:false};};
      if(require(${JSON.stringify(path.join(desktop,'retained-installation.js'))}).inspect(noraHome,{operationId})){
        const os=require('node:os'),uninstall=require(${JSON.stringify(path.join(desktop,'uninstall.js'))});
        if(!os.homedir().startsWith(transaction.paths({noraHome,hermesHome,operationId}).noraHome+require('node:path').sep))throw Error('bootstrap profile was not isolated');
        for(const forbidden of [os.userInfo().homedir,require('node:path').dirname(os.userInfo().homedir),require('node:path').parse(os.userInfo().homedir).root]){
          let rejected=false;try{uninstall.safeRoot(forbidden);}catch{rejected=true;}if(!rejected)throw Error('OS account deletion boundary was bypassed');
        }
      }
      try{if(mode==='recover')await transaction.recover({noraHome,hermesHome,operationId,ownerEpoch,delegate,allowCommitted:true,onEvent,verifyOffline,tools:require(${JSON.stringify(tools)})});
      else await transaction.install({payloadRoot,noraHome,hermesHome,operationId,ownerEpoch,delegate,onEvent,verifyOffline,tools:require(${JSON.stringify(tools)})});}
      finally{delegate.close();}
    })().catch(error=>{process.stdout.write(JSON.stringify({error:error.code,message:error.message,stack:error.stack,cause:error.cause?.stack})+'\\n');process.exitCode=2;});`);
  return {root,payload,home,hermes,worker,operationId:crypto.randomUUID()};
}
async function run(value,epoch,mode='install',killAt='',extraEnv={}){
  const lease=await acquire({directory:path.join(value.home,'installer'),operationId:value.operationId,ownerEpoch:epoch});
  try{
    const child=lease.spawn(process.execPath,[value.worker,value.payload,value.home,value.hermes,mode,killAt],
      {kind:'runtime-bootstrap',env:{...process.env,...extraEnv}});
    let text='';child.stdout.on('data',data=>text+=data);let errors='';child.stderr.on('data',data=>errors+=data);
    const [code,signal]=await once(child,'close');
    const snapshot=await lease.snapshot();
    return {code,signal,text,errors,snapshot};
  }finally{await lease.release();}
}
const inspect=value=>transaction.inspect({noraHome:value.home,hermesHome:value.hermes,operationId:value.operationId});
// Mutating one fixture field must not silently round unrelated Python NTFS
// identities and make the rejection pass for a different reason.
const mutableJson=bytes=>JSON.parse(bytes.toString('utf8'),(_key,value,context)=>
  typeof value==='number'&&!Number.isSafeInteger(value)&&Number.isInteger(value)?JSON.rawJSON(context.source):value);

function committedMetadataFixture(f,operationId,port,{beforeCommit}={}){
  const script=path.join(f.root,'commit-first-install-metadata.py');
  fs.writeFileSync(script,`import importlib.util,json,sys,os
from pathlib import Path
source,home,operation_id,port,phase=sys.argv[1:];home=Path(home).resolve();hermes=home/'hermes';tavern=home/'tavern'
os.environ['NORA_INSTALLER_DIRECTORY']=str(home/'installer')
spec=importlib.util.spec_from_file_location('retained_first_fixture',source);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
manifest={'schema':'tavern-release/v2','commit':'a'*40,'sourceDigest':'b'*64,'versions':{'tavern':'2.4.6'},'hermesRuntime':{'schema':1,'sha256':json.loads((hermes/'hermes-agent/.hermes-bootstrap-complete').read_text())['sha256']}}
instance={'schema':1,'noraHome':str(home),'hermesHome':str(hermes),'installRoot':str(tavern),'port':int(port)}
system={'schema':1,'version':'2.4.6','commit':'a'*40,'proof':{name:True for name in ('hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration')},'setupCompleted':False}
app=tavern/'apps/tavern-runtime'
metadata=[tavern/'tavern-updates'/name for name in ('installed.json','installed-manifest.json','nora-system.json')]
if phase=='commit':journal=m.FirstInstallJournal.load(home/'installer/operations'/operation_id/'first-install/transaction.json')
else:
 journal=m.FirstInstallJournal.create(home,hermes,tavern,operation_id=operation_id)
 journal.prepare({'hermes':[hermes/'nora-instance.json'],'tavern':[app,*metadata]},manifest=manifest)
 journal.checkpoint('apply','intent')
 prepared=home/'prepared-app'/operation_id;prepared.mkdir(parents=True);(prepared/'native-runtime.json').write_text('{}');(prepared/'native_lifecycle.py').write_text('pass\\n')
 journal.apply(prepared,app)
 journal.apply_bytes(hermes/'nora-instance.json',json.dumps(instance).encode())
 journal.apply_bytes(metadata[2],json.dumps(system).encode())
 m.write_install_receipt(tavern,manifest,journal)
if phase=='partial':print(json.dumps(m.inspect_first_install(journal.file)));sys.exit(0)
for index,item in enumerate(journal.record['targets']):journal.archive_exchanges(item,index)
journal.checkpoint('commit','result');journal.record['status']='installed';journal.checkpoint('apply','result')
print(json.dumps(m.inspect_first_install(journal.file)))
`);
  const python=process.env.NORA_TEST_PYTHON||process.env.NORA_PYTHON;assert.ok(python,'A real Python journal writer is required');
  const apply=phase=>{
    const result=spawnSync(python,['-B',script,path.join(desktop,'../first_install.py'),f.home,operationId,String(port),phase],
      {env:process.env,encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,result.stderr);return {facts:JSON.parse(result.stdout),output:result.stdout};
  };
  if(beforeCommit){const partial=apply('partial');assert.equal(partial.facts.effectState,'changed',partial.output);
    assert.equal(partial.facts.canRecover,true,partial.output);beforeCommit();}
  const result=apply(beforeCommit?'commit':'install');assert.equal(result.facts.canResume,true,result.output);
  return {installed:true,systemReady:true,version:'2.4.6',commit:'a'.repeat(40),port,
    noraHome:fs.realpathSync(f.home),hermesHome:path.join(fs.realpathSync(f.home),'hermes'),installRoot:path.join(fs.realpathSync(f.home),'tavern'),
    running:false,gatewayRunning:false,setupCompleted:false};
}

async function keepCommittedFixture(f,port){
  const file=path.join(desktop,'uninstall.js'),localRequire=require('node:module').createRequire(file);
  const python=process.env.NORA_TEST_PYTHON||process.env.NORA_PYTHON;
  const resources=Object.fromEntries(['update_recovery.py','first_install.py','replace-launcher.py'].map(name=>
    [name,{path:path.join(desktop,'..',name)}]));
  // As in the native uninstall contract tests, only the packaged capability
  // and Python location are fixture adapters. The production inspector reads
  // the real committed journal and bytes before native-writer deletion runs.
  const context=require('node:vm').createContext({require:name=>name==='./launcher-capability'?{validate:async()=>({
    noraHome:f.home,hermesHome:f.hermes,installRoot:path.join(f.home,'tavern'),launcherVersion:'2.1.3',
    platform:process.platform,arch:process.arch,channel:'stable',port,resources})}:name==='./managed-python'?{
      resolveExecution:()=>({command:python,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})}:localRequire(name),
    __filename:file,__dirname:desktop,module:{exports:{}},process,console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  require('node:vm').runInContext(fs.readFileSync(file,'utf8'),context);
  const plan=localRequire('./uninstall').makePlan({home:f.home,hermesHome:f.hermes,installRoot:path.join(f.home,'tavern'),mode:'keep',port});
  await context.inspectExecutorHistory(plan);await context.inspectSealedTransactions(plan);
  context.readOnlyNodeCheck=method=>assert.ok(['inspectExecutorHistory','inspectSealedTransactions'].includes(method));
  context.cleanup(plan);
}

test('a verified KEEP reinstall survives receipt archive I/O failure, reopens readonly and retries only under a writer',{timeout:40000},async t=>{
  for(const mode of ['EACCES','ENOSPC','resume EACCES','resume unknown EACCES'])await t.test(mode,async t=>{
    const resumed=mode.startsWith('resume'),unknown=mode==='resume unknown EACCES',code=resumed?'EACCES':mode;
    const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));f.home=fs.realpathSync(f.home);f.hermes=path.join(f.home,'hermes');
    const retained=require('../installer/desktop/retained-installation');
    const server=require('node:net').createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
    // Start from a physically committed installation, so KEEP retires all three
    // old receipts before the same paths are recreated by the next installation.
    const previousController=require('../installer/desktop/operation-state').createOperationController({directory:path.join(f.home,'installer'),
      lock:require('../installer/desktop/operation-lock'),projectResult:value=>value.value});
    const previous=await previousController.start('install',{target:{request:{action:'install',port},
      releasePlan:{schema:'nora-bundled-plan/1',mode:'install',tag:'v2.4.6',commit:'a'.repeat(40)}},execute:async operation=>{
        await operation.plan(operation.target);await operation.effect('changed');await operation.stage('applying');
        const value=committedMetadataFixture(f,operation.operationId,port);await operation.stage('verifying');
        return {verification:'confirmed',value};
      }},crypto.randomUUID());
    assert.equal(previous.state,'succeeded',JSON.stringify(previous));
    const oldReceipts=new Map(['installed.json','installed-manifest.json','nora-system.json'].map(name=>{
      const relative='tavern/tavern-updates/'+name;return [relative,fs.readFileSync(path.join(f.home,relative))];
    }));
    const before=fs.readFileSync(path.join(f.hermes,'.env'));await keepCommittedFixture(f,port);
    const keep=retained.inspect(f.home),writer=fs.statSync(path.join(f.home,'installer/operations/.writer.lock'),{bigint:true});let recoveries=0;
    for(const [relative,bytes]of oldReceipts){const entry=keep.entries.find(entry=>entry.from===relative);assert.ok(entry,relative);
      assert.equal(fs.existsSync(path.join(f.home,relative)),false);assert.deepEqual(fs.readFileSync(path.join(f.home,entry.to)),bytes);}
    const readFirstEffects=async(command,options)=>{
        assert.equal(command,'operation-effects');const python=process.env.NORA_TEST_PYTHON||process.env.NORA_PYTHON;
        const read=spawnSync(python,['-B',path.join(desktop,'../launcher_bridge.py'),'--nora-home',f.home,'--hermes-home',f.hermes,
          '--install-root',path.join(f.home,'tavern'),'--port',String(port),command,'--operation-id',options.operationId,'--kind','install'],{encoding:'utf8',env:process.env,timeout:10000});
        assert.equal(read.status,0,read.stderr);return read.stdout.trim().split('\n').map(line=>JSON.parse(line)).find(value=>value.event==='result');
      };
    const policyForResume=require('../installer/desktop/operation-policy').create({home:f.home,hermesHome:f.hermes,installRoot:path.join(f.home,'tavern'),
      bridge:readFirstEffects,runRuntime:async()=>{throw Error('committed resume must not reapply its runtime');}});
    const controller=require('../installer/desktop/operation-state').createOperationController({directory:path.join(f.home,'installer'),lock:require('../installer/desktop/operation-lock'),
      projectResult:value=>value.value,...(resumed?{observeEffects:record=>policyForResume.observe(record)}:
        {recoverers:{install:async()=>{recoveries++;throw Error('a healthy install must not be rolled back for receipt cleanup');}}})});
    const main=fs.readFileSync(path.join(desktop,'main.js'),'utf8'),{parse}=require(path.join(desktop,'node_modules/acorn')),ast=parse(main,{ecmaVersion:'latest'});
    const helper=ast.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='finishRetainedInstallation');
    const vm=require('node:vm'),context=vm.createContext({require:require('node:module').createRequire(path.join(desktop,'main.js')),noraHome:()=>f.home,
      diagnostics:{write(){}},logs:[]});
    // The production verified-success helper is executed with real receipt and
    // journal owners. Tiny program probes do not establish packaged GUI fit.
    assert.ok(helper,'the production verified-success helper must exist');
    const finish=vm.runInContext(main.slice(helper.start,helper.end)+'\nfinishRetainedInstallation',context);
    const calls=[];function walk(node){if(!node||typeof node!=='object')return;
      if(node.type==='CallExpression'&&node.callee.name==='finishRetainedInstallation')calls.push(node);
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
    }walk(ast);assert.equal(calls.length,2,'normal and committed-resume success paths must use the same owner-bound completion');
    let observedId,result;
    const rename=fs.renameSync;let injected=0;
    fs.renameSync=function(from,to){if(path.resolve(String(from))===path.join(f.home,'nora-retained.json')
      &&path.resolve(String(to))===path.join(f.home,keep.archive,'reinstalled-'+observedId+'.json')){
      injected++;throw Object.assign(Error('controlled receipt archive denied'),{code});}return rename.call(this,from,to);};
    let committed;
    const execute=async operation=>{
      observedId=operation.operationId;await operation.plan(operation.target);
      if(!committed){
        await operation.effect('changed');retained.claim(f.home,operation.operationId);await operation.stage('applying');
        const actor=operation.lease.spawn(process.execPath,[f.worker,f.payload,f.home,f.hermes,'install',''],{kind:'runtime-bootstrap',env:process.env});
        let output='';actor.stdout.on('data',value=>output+=value);actor.stderr.on('data',value=>output+=value);const [exit]=await once(actor,'close');assert.equal(exit,0,output);
        committed=committedMetadataFixture(f,operation.operationId,port,{beforeCommit:()=>{
          assert.equal(retained.inspect(f.home,{operationId:operation.operationId}).id,keep.id,
            'actual partial applying receipts belong to this same install operation');
          assert.throws(()=>retained.inspect(f.home),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
          assert.throws(()=>retained.inspect(f.home,{operationId:crypto.randomUUID()}),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
          assert.throws(()=>retained.consume(f.home,operation.operationId,{result:{systemReady:true}}),
            error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED','a readable partial claim is not a completed installation');
          const file=path.join(f.home,'tavern/tavern-updates/nora-system.json'),original=file+'.original',prepared=file+'.setup';
          const before=fs.readFileSync(file);fs.writeFileSync(prepared,JSON.stringify({...JSON.parse(before),setupCompleted:true}));fs.renameSync(file,original);
          try{fs.renameSync(prepared,file);assert.throws(()=>retained.inspect(f.home,{operationId:operation.operationId}),
            error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED','in-flight system replacement has no first-install physical proof');
          }finally{fs.rmSync(file,{force:true});fs.renameSync(original,file);fs.rmSync(prepared,{force:true});}
        }});
        await operation.stage('verifying');
        if(resumed){if(unknown)await operation.effect('unknown');throw Object.assign(Error('controlled interrupted final acceptance'),{code:'EPERM'});}
      }else{
        const executor=require('../installer/desktop/system-update-executor').create({compare:require('../installer/desktop/releases').compare,
          bridge:async(command,options)=>{
            if(command==='operation-effects')return readFirstEffects(command,options);
            assert.equal(command,'resume-committed-install');assert.equal((await readFirstEffects('operation-effects',options)).effects.canResume,true);
            // This fixture acceptance is backed by actual tiny code/journal
            // effects; external services and complete Hermes remain out of scope.
            return {...committed,operationVerified:true,firstInstallVerified:true};
          }});
        committed=await executor.resumeInstallation(operation,{hasTransaction:true,port});
      }
      return {verification:'confirmed',value:finish(operation,committed)};
    };
    try{
      result=await controller.start('install',{target:{request:{action:'install',port},releasePlan:{schema:'nora-bundled-plan/1',mode:'install',tag:'v2.4.6',commit:'a'.repeat(40)}},execute},crypto.randomUUID());
      if(resumed){assert.equal(result.state,'failed');assert.equal(result.primaryFailure.code,'EPERM');assert.equal(result.effectState,unknown?'unknown':'changed');
        assert.equal(retained.inspect(f.home,{operationId:result.operationId}).id,keep.id,
          'a failed same-operation install must still admit owner-bound inspection for resume');
        assert.throws(()=>retained.inspect(f.home),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
        const rechecked=await controller.snapshot(result.operationId);assert.equal(rechecked.canResume,undefined);assert.ok(rechecked.allowedActions.includes('resume'),JSON.stringify(rechecked));
        result=await controller.resume(result.operationId,{execute});assert.equal(result.operationId,observedId);assert.equal(result.primaryFailure.code,'EPERM');assert.equal(result.currentFailure,null);
      }
    }finally{fs.renameSync=rename;}
    assert.equal(result.state,'succeeded',JSON.stringify(result));assert.equal(recoveries,0);assert.equal(injected,1);
    assert.equal(result.result.retainedCompletionPending,true);assert.match(result.result.warning,/收尾/);
    assert.equal(transaction.inspect({noraHome:f.home,hermesHome:f.hermes,operationId:observedId}).canResume,true);
    const receipt=fs.readFileSync(path.join(f.home,'nora-retained.json')),operationFile=path.join(f.home,'installer/operations',observedId,'operation.json'),operationBytes=fs.readFileSync(operationFile);
    const pending=retained.inspect(f.home);assert.equal(pending.reinstalled,true);assert.equal(pending.cleanupPending,true);
    assert.equal(result.recoveryOutcome,'not-required');
    assert.deepEqual(fs.readFileSync(path.join(f.home,'nora-retained.json')),receipt);assert.deepEqual(fs.readFileSync(operationFile),operationBytes);
    const policy=require('../installer/desktop/operation-policy'),roots={noraHome:f.home,hermesHome:f.hermes,installRoot:path.join(f.home,'tavern'),port};
    assert.equal(policy.hasManagedRecords(roots),true,'a healthy reinstalled tree must not admit another first install');
    const systemFile=path.join(f.home,'tavern/tavern-updates/nora-system.json'),system=fs.readFileSync(systemFile);
    const setup={...JSON.parse(system),setupCompleted:true},originalSystem=systemFile+'.original',preparedSystem=systemFile+'.setup';
    const systemIdentity=fs.statSync(systemFile,{bigint:true});fs.writeFileSync(preparedSystem,JSON.stringify(setup));fs.renameSync(systemFile,originalSystem);
    try{fs.renameSync(preparedSystem,systemFile);assert.notEqual(fs.statSync(systemFile,{bigint:true}).ino,systemIdentity.ino);
      assert.equal(retained.inspect(f.home).reinstalled,true,'actual atomic setup replacement cannot invalidate immutable install ownership');
    }finally{fs.rmSync(systemFile,{force:true});fs.renameSync(originalSystem,systemFile);fs.rmSync(preparedSystem,{force:true});}
    const priorFailure={...JSON.parse(operationBytes),primaryFailure:{code:'EPERM'},totalAttempts:2};fs.writeFileSync(operationFile,JSON.stringify(priorFailure));
    assert.equal(retained.inspect(f.home).reinstalled,true,'the controller preserves the prior first cause after a confirmed successful retry');fs.writeFileSync(operationFile,operationBytes);
    for(const [name,relative,change]of [
      ['nonterminal','installer/operations/'+observedId+'/operation.json',value=>{value.state='verifying';}],
      ['unconfirmed','installer/operations/'+observedId+'/operation.json',value=>{value.verification='unconfirmed';}],
      ['current-failure','installer/operations/'+observedId+'/operation.json',value=>{value.currentFailure={code:'EPERM'};}],
      ['plan-unselected','installer/operations/'+observedId+'/operation.json',value=>{value.planSelected=false;}],
      ['plan-digest','installer/operations/'+observedId+'/operation.json',value=>{value.planDigest='0'.repeat(64);}],
      ['plan-missing','installer/operations/'+observedId+'/operation.json',value=>{delete value.target.releasePlan;
        value.planDigest=crypto.createHash('sha256').update(JSON.stringify(value.target)).digest('hex');}],
      ['foreign-root','installer/operations/'+observedId+'/operation.json',value=>{value.result.noraHome=f.root;}],
      ['unhealthy-result','installer/operations/'+observedId+'/operation.json',value=>{value.result.systemReady=false;}],
      ['first-commit-incomplete','installer/operations/'+observedId+'/first-install/transaction.json',value=>{value.checkpoints.commit.state='intent';}],
      ['first-restoring','installer/operations/'+observedId+'/first-install/transaction.json',value=>{value.checkpoints.restore={state:'intent'};}],
      ['first-operation','installer/operations/'+observedId+'/first-install/transaction.json',value=>{value.operationId=crypto.randomUUID();}],
      ['first-root','installer/operations/'+observedId+'/first-install/transaction.json',value=>{value.roots.tavern=f.root;}],
      ['first-root-identity','installer/operations/'+observedId+'/first-install/transaction.json',value=>{value.rootIdentities.tavern=[0,0];}],
      ['live-identity','installer/operations/'+observedId+'/first-install/transaction.json',value=>{
        value.targets.find(item=>item.namespace==='tavern'&&item.path==='tavern-updates/installed.json').newIdentity=[0,0];}],
      ['live-digest','installer/operations/'+observedId+'/first-install/transaction.json',value=>{
        value.targets.find(item=>item.namespace==='tavern'&&item.path==='tavern-updates/installed.json').newDigest='0'.repeat(64);}],
      ['receipt-bytes','tavern/tavern-updates/installed.json',value=>{value.version='2.0.1';}],
      ['manifest-bytes','tavern/tavern-updates/installed-manifest.json',value=>{value.commit='b'.repeat(40);}],
      ['system-proof','tavern/tavern-updates/nora-system.json',value=>{value.proof.hermesContext=false;}],
      ['instance-binding','hermes/nora-instance.json',value=>{value.port++;}],
      ['runtime-identity','hermes/hermes-agent/.hermes-bootstrap-complete',value=>{value.operationId=crypto.randomUUID();}],
      ['owner','nora-owner.json',value=>{value.id='foreign-owned-root';}],
    ]){
      const file=path.join(f.home,relative),bytes=fs.readFileSync(file),value=mutableJson(bytes);change(value);fs.writeFileSync(file,JSON.stringify(value));
      try{assert.throws(()=>retained.inspect(f.home),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED',name);
        if(name!=='nonterminal')assert.throws(()=>retained.consume(f.home,observedId,{result:result.result}),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED',name);
      }finally{fs.writeFileSync(file,bytes);}
    }
    const rejectCurrent=label=>{
      assert.throws(()=>retained.inspect(f.home),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED',label);
      assert.throws(()=>retained.consume(f.home,observedId,{result:result.result}),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED',label);
      assert.deepEqual(fs.readFileSync(path.join(f.home,'nora-retained.json')),receipt,label+' retains the claim');
      assert.deepEqual(fs.readFileSync(path.join(f.hermes,'.env')),before,label+' retains user data');
    };
    // Same bytes at a different inode and semantically identical JSON at the
    // same inode must both fail immutable installation ownership checks.
    const immutableEntry=keep.entries.find(entry=>entry.from==='tavern/tavern-updates/installed.json');assert.ok(immutableEntry);
    for(const [label,file]of [['live',path.join(f.home,immutableEntry.from)],['archive',path.join(f.home,immutableEntry.to)]]){
      const original=file+'.original',bytes=fs.readFileSync(file),identity=fs.statSync(file,{bigint:true});fs.renameSync(file,original);
      try{fs.copyFileSync(original,file);assert.notEqual(fs.statSync(file,{bigint:true}).ino,identity.ino);rejectCurrent(label+' replaced inode');
      }finally{fs.rmSync(file,{force:true});fs.renameSync(original,file);}
      fs.writeFileSync(file,Buffer.concat([bytes,Buffer.from('\n')]));
      try{rejectCurrent(label+' changed sealed bytes');}finally{fs.writeFileSync(file,bytes);}
    }
    const oldOperation=keep.entries.find(entry=>entry.from==='installer/operations/'+previous.operationId);assert.ok(oldOperation);
    const resurrected=path.join(f.home,oldOperation.from);fs.cpSync(path.join(f.home,oldOperation.to),resurrected,{recursive:true});
    try{rejectCurrent('an archived old operation must not reappear in the active reader set');}
    finally{fs.rmSync(resurrected,{recursive:true});}
    // An unbound archived file never authorizes overwriting its evidence.
    const destination=path.join(f.home,keep.archive,'reinstalled-'+observedId+'.json');fs.writeFileSync(destination,'foreign archive bytes');
    assert.throws(()=>retained.consume(f.home,observedId,{result:result.result}),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');assert.equal(fs.readFileSync(destination,'utf8'),'foreign archive bytes');fs.unlinkSync(destination);
    let statusCallback;function findStatus(node){if(!node||typeof node!=='object')return;
      if(node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value==='nora:status')statusCallback=node.arguments[1];
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(findStatus);else if(value&&typeof value==='object')findStatus(value);
    }findStatus(ast);const cancellation=ast.body.find(node=>node.id?.name==='taskCancellation');
    let writes=0,reads=0;const readonly=vm.createContext({require:require('node:module').createRequire(path.join(desktop,'main.js')),
      quitting:false,uninstalling:false,selectingLocation:false,modelBusy:false,statusRequest:null,activeRun:false,activeOperationContext:null,
      activeProcess:null,releaseAbort:null,cancelled:false,updatingSystem:false,noraHome:()=>f.home,
      operations:()=>({snapshot:async()=>({...result,kind:'stop'})}),readLauncherRecovery:async()=>null,systemUpdate:{inspect:()=>null},findPython:()=>true,
      runBridge:async()=>{reads++;return {...result.result,running:true,gatewayRunning:true};},readInstallerState:()=>({phase:'ready'}),writeInstallerState:()=>{writes++;},
      releases:{bundledUpgradeTarget:()=>null},payloadDirectory:()=>f.payload,app:{getVersion:()=> '2.1.3'},CHANNEL:'stable',LOCAL_TEST:null,
      telemetry:null,locationStatus:()=>roots,lastStatusError:'',statusErrorMessage:error=>error.message});
    vm.runInContext(main.slice(cancellation.start,cancellation.end),readonly);
    const query=vm.runInContext('('+main.slice(statusCallback.start,statusCallback.end)+')',readonly);
    const status=await query();assert.equal(status.systemReady,true);assert.equal(status.installed,true);assert.equal(status.running,true);assert.equal(status.retainedCompletionPending,true);
    assert.equal(status.statusUnavailable,undefined);assert.equal(writes,0);assert.equal(reads,1);assert.deepEqual(fs.readFileSync(path.join(f.home,'nora-retained.json')),receipt);
    assert.throws(()=>retained.retryCompletion(f.home,{}),error=>error.code==='RETAINED_INSTALLATION_UNCONFIRMED');
    await controller.start('stop',{target:{request:{action:'stop'}},execute:async operation=>{
      const check=operation.check;let checks=0;operation.check=()=>{checks++;check();};const rename=fs.renameSync;
      fs.renameSync=function(from,to){if(path.resolve(String(from))===path.join(f.home,'nora-retained.json'))throw Object.assign(Error('controlled retry denied'),{code});return rename.call(this,from,to);};
      try{assert.equal(retained.retryCompletion(f.home,operation).pending,true);assert.equal(checks,2);}
      finally{fs.renameSync=rename;operation.check=check;}
      assert.equal(retained.retryCompletion(f.home,operation),null);return {verification:'confirmed',value:{running:false,gatewayRunning:false}};
    }},crypto.randomUUID());
    assert.equal(retained.inspect(f.home),null);assert.deepEqual(fs.readFileSync(path.join(f.home,keep.archive,'reinstalled-'+observedId+'.json')),receipt);
    if(resumed){const next=await controller.start('model',{target:{request:{action:'model'}},execute:async()=>({verification:'confirmed',value:{modelConfigured:true}})},crypto.randomUUID());
      assert.equal(next.state,'succeeded','a successful resumed installation must not retain a stale recovery admission block');}
    assert.deepEqual(fs.readFileSync(path.join(f.hermes,'.env')),before);assert.equal(fs.statSync(path.join(f.home,'installer/operations/.writer.lock'),{bigint:true}).ino,writer.ino);
  });
});

test('KEEP data survives real reinstall preparation failure and committed runtime rollback before another reinstall',{timeout:40000},async t=>{
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const home=fs.realpathSync(f.home),hermes=path.join(home,'hermes'),tavern=path.join(home,'tavern');
  const uninstall=require('../installer/desktop/uninstall'),retained=require('../installer/desktop/retained-installation');
  const server=require('node:net').createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const data=fs.readFileSync(path.join(hermes,'.env'));uninstall.cleanup(uninstall.makePlan({home,hermesHome:hermes,installRoot:tavern,mode:'keep',port}));
  const keep=retained.inspect(home),writer=fs.statSync(path.join(home,'installer/operations/.writer.lock'),{bigint:true});
  async function child(context,mode,environment={}){
    const actor=context.lease.spawn(process.execPath,[f.worker,f.payload,home,hermes,mode,''],{kind:'runtime-bootstrap',env:{...process.env,...environment}});
    let output='';actor.stdout.on('data',value=>output+=value);actor.stderr.on('data',value=>output+=value);
    const [code,signal]=await once(actor,'close');return {code,signal,output};
  }
  const policy=require('../installer/desktop/operation-policy').create({home,hermesHome:hermes,installRoot:tavern,
    bridge:async command=>{assert.equal(command,'recovery-stop','removed programs cannot be used for status');
      const offline=require('../installer/desktop/uninstall-offline-check');await offline.portOffline(port);offline.nativeOffline({root:home});await offline.portOffline(port);
      return {offline:true,running:false,gatewayRunning:false};},
    runRuntime:async context=>{const result=await child(context,'recover');assert.equal(result.code,0,result.output);return transaction.inspect({noraHome:home,hermesHome:hermes,operationId:context.operationId});}});
  const controller=require('../installer/desktop/operation-state').createOperationController({directory:path.join(home,'installer'),
    lock:require('../installer/desktop/operation-lock'),recoverers:{install:(context,options)=>policy.recover(context,options)},observeEffects:record=>policy.observe(record)});
  const target=()=>({request:{action:'install',port},releasePlan:{schema:'nora-bundled-plan/1',mode:'install',tag:'v2.4.6',commit:'a'.repeat(40),
    // The retry owner compares its selected manifest, rather than unrelated
    // top-level fixture labels. These are actual tiny-runtime descriptor bytes.
    systemManifestSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(f.payload,'nora-hermes-runtime.json'))).digest('hex')}});
  for(const failure of ['preparation','system']){
    let actor;
    const result=await controller.start('install',{target:target(),execute:async context=>{
      await context.plan(context.target);await context.effect('changed');retained.claim(home,context.operationId);await context.stage('applying');
      actor=await child(context,'install',failure==='preparation'?{NORA_FIXTURE_PREPARE_FAILURE:'1'}:{});
      assert.equal(actor.code,failure==='preparation'?2:0,actor.output);
      throw Object.assign(Error('controlled '+failure+' failure'),{code:'EPERM'});
    }},crypto.randomUUID());
    assert.equal(result.primaryFailure?.code,'EPERM',JSON.stringify(actor)+'\n'+JSON.stringify(result));
    assert.equal(result.recoveryOutcome,'restored-and-verified',JSON.stringify(result));
    assert.deepEqual(fs.readFileSync(path.join(hermes,'.env')),data);assert.equal(retained.inspect(home).id,keep.id);
    assert.equal(retained.inspect(home).reinstallOperationId,undefined);assert.equal(fs.existsSync(path.join(hermes,'hermes-agent')),false);
    if(failure==='system'){
      const journal=JSON.parse(fs.readFileSync(path.join(home,'installer/operations',result.operationId,'runtime-bootstrap.json')));
      assert.equal(journal.recoveryVerification,'retained-data-confirmed');
      assert.equal(fs.readFileSync(path.join(journal.paths.failed,'logs/new-stage.log'),'utf8'),'new failure evidence');
    }
  }
  const blocked=await controller.start('install',{target:target(),execute:async context=>{await context.plan(context.target);throw Error('unchanged third attempt must not execute');}},crypto.randomUUID());
  assert.equal(blocked.state,'blocked');assert.deepEqual(fs.readFileSync(path.join(hermes,'.env')),data);
  // A genuinely different fixture archive changes the fixed target; do not
  // reset the user's unchanged-condition retry budget to force a success.
  fs.writeFileSync(path.join(f.root,'source/hermes-runtime/hermes-agent/program.txt'),'new-program-after-repair');
  const manifestFile=path.join(f.payload,'nora-hermes-runtime.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));
  const archive=path.join(f.payload,manifest.archive),tar=process.platform==='win32'?path.join(process.env.SystemRoot,'System32/tar.exe'):'/usr/bin/tar';
  const packed=spawnSync(tar,['-czf',archive,'-C',path.join(f.root,'source'),'hermes-runtime']);assert.equal(packed.status,0,String(packed.stderr));
  manifest.sha256=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const final=await controller.start('install',{target:target(),execute:async context=>{
    await context.plan(context.target);await context.effect('changed');retained.claim(home,context.operationId);await context.stage('applying');
    const actor=await child(context,'install');assert.equal(actor.code,0,actor.output);
    const verified=committedMetadataFixture(f,context.operationId,port);await context.stage('verifying');
    retained.consume(home,context.operationId,{result:verified});return {verification:'confirmed',value:verified};
  }},crypto.randomUUID());
  assert.equal(final.state,'succeeded');assert.deepEqual(fs.readFileSync(path.join(hermes,'.env')),data);assert.equal(retained.inspect(home),null);
  assert.ok(fs.existsSync(path.join(home,keep.archive,'reinstalled-'+final.operationId+'.json')));
  assert.equal(fs.statSync(path.join(home,'installer/operations/.writer.lock'),{bigint:true}).ino,writer.ino);
  // This proves transaction/data lifetime with a tiny program probe, not a
  // complete system install or the final packaged GUI acceptance.
});

test('a preparation failure preserves the old runtime, its data and its original failure evidence',{timeout:20000},async()=>{
  const value=fixture();
  try{
    const result=await run(value,1,'install','',{NORA_FIXTURE_PREPARE_FAILURE:'1'});assert.equal(result.code,2,result.errors);
    assert.equal(inspect(value).effectState,'untouched');
    assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'old-program');
    const journal=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));assert.equal(journal.primaryFailure.code,'EPERM');
    assert.equal(fs.readFileSync(path.join(journal.paths.stage,'logs/new-stage.log'),'utf8'),'new failure evidence');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('hard interruption after backing up the old tree is recovered using actual directory identity',{timeout:20000},async()=>{
  const value=fixture();
  try{
    const interrupted=await run(value,1,'install','runtime.previous-backed-up');assert.notEqual(interrupted.code,0);
    assert.equal(inspect(value).canRecover,true);assert.equal(inspect(value).effectState,'changed');assert.equal(fs.existsSync(value.hermes),false);
    const restored=await run(value,2,'recover');assert.equal(restored.code,0,restored.errors);
    assert.equal(inspect(value).effectState,'restored');assert.equal(inspect(value).canRecover,false);
    assert.equal(fs.readFileSync(path.join(value.hermes,'.env'),'utf8'),'DUMMY_SETTING=preserved\n');
    assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'old-program');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('recovery can itself be interrupted without deleting either the old data or the failed new tree',{timeout:25000},async()=>{
  const value=fixture();
  try{
    assert.notEqual((await run(value,1,'install','runtime.next-activated')).code,0);assert.equal(inspect(value).canRecover,true);
    assert.notEqual((await run(value,2,'recover','runtime.failed-tree-preserved')).code,0);
    const halfway=inspect(value);assert.equal(halfway.effectState,'changed');assert.equal(halfway.canRecover,true);
    assert.equal((await run(value,3,'recover')).code,0);assert.equal(inspect(value).effectState,'restored');
    const journal=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));
    assert.equal(fs.readFileSync(path.join(journal.paths.failed,'logs/new-stage.log'),'utf8'),'new failure evidence');
    assert.equal(fs.readFileSync(path.join(value.hermes,'logs/old-record.log'),'utf8'),'old evidence');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('a validated component retains its previous tree for explicit whole-operation rollback',{timeout:20000},async()=>{
  const value=fixture();
  try{
    const installed=await run(value,1);assert.equal(installed.code,0,installed.errors);
    assert.equal(inspect(value).reason,'committed');assert.equal(inspect(value).hasChanges,true);assert.equal(inspect(value).canResume,true);assert.equal(inspect(value).canRecover,true);
    assert.equal(fs.readFileSync(path.join(value.hermes,'.env'),'utf8'),'DUMMY_SETTING=preserved\n');
    assert.equal((await run(value,2,'recover')).code,0);assert.equal(inspect(value).effectState,'restored');
    assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'old-program');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('a missing or modified old backup blocks committed rollback before moving the working new version',{timeout:25000},async()=>{
  for(const scenario of ['missing','modified']){
    const value=fixture();
    try{
      assert.equal((await run(value,1)).code,0);
      const journal=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));
      if(scenario==='missing')fs.renameSync(journal.paths.backup,path.join(value.root,'kept-old-backup'));
      else fs.writeFileSync(path.join(journal.paths.backup,'.env'),'DUMMY_SETTING=changed\n');
      if(scenario==='missing')assert.equal(inspect(value).canRecover,false);
      const refused=await run(value,2,'recover');assert.equal(refused.code,2);assert.match(refused.text,/RUNTIME_BACKUP_CHANGED/);
      assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'new-program');
      assert.equal(fs.existsSync(journal.paths.failed),false);
    }finally{fs.rmSync(value.root,{recursive:true,force:true});}
  }
});
test('restoring files does not claim runtime verification when the restored component probe fails',{timeout:25000},async()=>{
  const value=fixture();
  try{
    assert.equal((await run(value,1)).code,0);
    assert.equal((await run(value,2,'recover','',{NORA_FIXTURE_VERIFY_FAILURE:'1'})).code,2);
    assert.equal(inspect(value).effectState,'restored');assert.equal(inspect(value).recoveryOutcome,'recovery-required');
    assert.equal(inspect(value).canRecover,true);assert.equal(inspect(value).reason,'runtime-verification-required');
    assert.equal(fs.readFileSync(path.join(value.hermes,'hermes-agent/program.txt'),'utf8'),'old-program');
    assert.equal((await run(value,3,'recover')).code,0);assert.equal(inspect(value).recoveryOutcome,'restored');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('a retry archives the preceding failed attempt instead of deleting its journal or files',{timeout:25000},async()=>{
  const value=fixture();
  try{
    assert.equal((await run(value,1,'install','',{NORA_FIXTURE_PREPARE_FAILURE:'1'})).code,2);
    assert.equal((await run(value,2)).code,0);
    const current=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));assert.equal(current.attempt,2);
    const previous=JSON.parse(fs.readFileSync(current.precedingEvidence,'utf8'));assert.equal(previous.journal.primaryFailure.code,'EPERM');
    assert.equal(fs.readFileSync(path.join(path.dirname(current.precedingEvidence),'tree/hermes-runtime/logs/new-stage.log'),'utf8'),'new failure evidence');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('an unowned partial tree is not overwritten',{timeout:20000},async()=>{
  const value=fixture();
  try{
    fs.rmSync(path.join(value.hermes,'hermes-agent/.hermes-bootstrap-complete'));
    const refused=await run(value,1);assert.equal(refused.code,2);assert.match(refused.text,/RUNTIME_PARTIAL_UNCONFIRMED/);
    assert.equal(fs.readFileSync(path.join(value.hermes,'.env'),'utf8'),'DUMMY_SETTING=preserved\n');
    assert.equal(inspect(value).reason,'no_journal');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
test('an unfamiliar live directory blocks recovery without overwriting the old backup or new evidence',{timeout:25000},async()=>{
  const value=fixture();
  try{
    assert.notEqual((await run(value,1,'install','runtime.next-activated')).code,0);
    const journal=JSON.parse(fs.readFileSync(inspect(value).journalReference,'utf8'));
    const retained=path.join(value.root,'retained-new-tree');fs.renameSync(value.hermes,retained);
    fs.mkdirSync(value.hermes);fs.writeFileSync(path.join(value.hermes,'unfamiliar-user-file'),'do not overwrite');
    assert.equal(inspect(value).effectState,'unknown');assert.equal(inspect(value).canRecover,false);
    const refused=await run(value,2,'recover');assert.equal(refused.code,2);assert.match(refused.text,/RUNTIME_IDENTITY_UNKNOWN/);
    assert.equal(fs.readFileSync(path.join(value.hermes,'unfamiliar-user-file'),'utf8'),'do not overwrite');
    assert.equal(fs.readFileSync(path.join(journal.paths.backup,'.env'),'utf8'),'DUMMY_SETTING=preserved\n');
    assert.equal(fs.readFileSync(path.join(retained,'logs/new-stage.log'),'utf8'),'new failure evidence');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});


test('runtime tools receive the verified canonical directory rather than an ancestor alias',{timeout:20000},async()=>{
  const value=fixture();
  try{
    const source=fs.readFileSync(path.join(value.root,'fixture-tools.cjs'),'utf8');
    fs.writeFileSync(path.join(value.root,'fixture-tools.cjs'),source.replace('async validateRuntimeAsync(home){',
      'async validateRuntimeAsync(home){if(require("node:fs").realpathSync(home)!==home)throw new Error("runtime directory was not canonical");'));
    const result=await run(value,1);assert.equal(result.code,0,result.text+result.errors);
    assert.equal(inspect(value).reason,'committed');
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});

// Windows PowerShell initializes special folders beneath USERPROFILE even when
// -NoProfile is used. The pre-transaction ACK must never point that at Hermes.
test('fresh bootstrap profile initialization cannot create the managed target before its journal',{timeout:25000},async()=>{
  const value=fixture();
  try{
    fs.rmSync(value.hermes,{recursive:true});
    const worker=fs.readFileSync(value.worker,'utf8').replace('const delegate=await connect();',
      `const delegate=await connect();process.stdout.write(JSON.stringify({bootstrapFacts:{home:process.env.HOME,userprofile:process.env.USERPROFILE,targetExists:require('node:fs').existsSync(hermesHome)}})+'\\n');`);
    fs.writeFileSync(value.worker,worker);
    const installed=await run(value,1,'install','',{HOME:value.hermes,USERPROFILE:value.hermes,
      APPDATA:path.join(value.home,'appdata/roaming'),LOCALAPPDATA:path.join(value.home,'appdata/local')});
    assert.equal(installed.code,0,installed.text+installed.errors);
    const facts=installed.text.trim().split('\n').map(JSON.parse).find(value=>value.bootstrapFacts).bootstrapFacts;
    assert.equal(facts.targetExists,false,'process-identity initialization must not create Hermes before the component journal');
    const profile=path.join(fs.realpathSync(value.home),'installer','operations',value.operationId,'bootstrap-profile');
    assert.equal(facts.home,profile);assert.equal(facts.userprofile,profile);
    assert.equal(inspect(value).canResume,true);
  }finally{fs.rmSync(value.root,{recursive:true,force:true});}
});
