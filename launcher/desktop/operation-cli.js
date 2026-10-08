// Headless actor for the existing durable Operation controller. It does not
// import Electron's GUI main, create a service, or own another journal.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const capability=require('./launcher-capability');
const {createOperationController}=require('./operation-state');
const {createEvidenceStore}=require('./evidence-store');
const {createDiagnostics}=require('./diagnostics');
const {createFaultPackets}=require('./fault-packet');
const {createTelemetry}=require('./telemetry');
const {consumeLines}=require('./process-output');
const {acquireInspected}=require('./operation-inspection');
const {verifyWorkflowResult}=require('./operation-result');

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,message='命令不支持独立维护。请保留数据，通过新版启动器完成该操作。')=>Object.assign(new Error(message),{code});
const valueFlags=new Set(['--nora-home','--managed-home','--hermes-home','--data-root','--install-root','--port',
  '--service','--release-dir','--manifest-sha256','--tag','--target-commit','--operation-id']);
const boolFlags=new Set(['--apply','--confirm','--repair','--allow-candidate','--force-first-install','--replace-soul','--dedicated-nora','--skip-liveware']);
const actions=new Set(['install','update','repair','start','stop','restart','pair','recover-update','recover-install']);
const same=(left,right,platform)=>platform==='win32'?path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase():path.resolve(left)===path.resolve(right);
function rejectAppHandoff(record){
  if(record?.handoffRef)throw fail('LAUNCHER_RECOVERY_REQUIRED',
    '此操作涉及启动器程序替换，请打开新版启动器继续或恢复。原安装、数据和程序备份已保留。');
}

function routeRequest(receipt,input){
  if(input?.schema!=='nora-cli-request/1'||!Array.isArray(input.argv)||!input.argv.length||input.argv.length>128
    ||input.argv.some(arg=>typeof arg!=='string'||arg.length>8192)||typeof input.stdin!=='string'||input.stdin.length>1400000
    ||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.stdin))throw fail('OPERATION_ENTRY_UNSUPPORTED');
  const target=capability.authorizeTarget(receipt,input.argv[0]),flags={},positionals=[];
  for(let index=1;index<input.argv.length;index++){
    const arg=input.argv[index];
    if(valueFlags.has(arg)){
      if(flags[arg]!==undefined||index+1>=input.argv.length||input.argv[index+1].startsWith('--'))throw fail('OPERATION_ENTRY_UNSUPPORTED');
      flags[arg]=input.argv[++index];
    }else if(boolFlags.has(arg)){
      if(flags[arg]!==undefined)throw fail('OPERATION_ENTRY_UNSUPPORTED');flags[arg]=true;
    }else if(arg.startsWith('-'))throw fail('OPERATION_ENTRY_UNSUPPORTED');
    else positionals.push(arg);
  }
  let action;
  if(target.type==='bridge'){
    action=positionals[0];if(positionals.length!==1||!actions.has(action))throw fail('OPERATION_ENTRY_UNSUPPORTED');
  }else if(['install','install-bootstrap','bootstrap','update'].includes(target.type)){
    if(positionals.length!==(target.type==='update'?1:0)||target.type==='update'&&positionals[0]!=='install')throw fail('OPERATION_ENTRY_UNSUPPORTED');
    if(!flags['--confirm']||target.type!=='update'&&!flags['--apply'])throw fail('OPERATION_ENTRY_UNSUPPORTED');
    action=['install','install-bootstrap'].includes(target.type)?'install':flags['--repair']?'repair':'update';
  }else throw fail('OPERATION_ENTRY_UNSUPPORTED');
  const kind=action.startsWith('recover-')?'recover':action;
  if(input.kind!==kind&&!(kind==='recover'&&input.kind===action.replace('recover-','')))throw fail('OPERATION_ENTRY_UNSUPPORTED');
  for(const [name,expected] of [['--nora-home',receipt.noraHome],['--managed-home',receipt.noraHome],
    ['--hermes-home',receipt.hermesHome],['--install-root',receipt.installRoot]]){
    if(flags[name]!==undefined&&!same(flags[name],expected,receipt.platform))throw fail('CONDITIONS_CHANGED','命令目标与启动器安装实例不一致，未修改文件。');
  }
  if(flags['--data-root']!==undefined&&!same(flags['--data-root'],receipt.installRoot,receipt.platform))throw fail('CONDITIONS_CHANGED');
  const port=flags['--port']===undefined?receipt.port:Number(flags['--port']);
  if(!Number.isInteger(port)||port!==receipt.port)throw fail('CONDITIONS_CHANGED');
  const request={action:kind,port};
  if(flags['--service']!==undefined){
    if(!['start','stop','restart'].includes(action)||!['all','nora','tavern'].includes(flags['--service']))throw fail('OPERATION_ENTRY_UNSUPPORTED');
    request.service=flags['--service'];
  }
  if(flags['--tag']!==undefined){if(!/^[\w.-]{1,100}$/.test(flags['--tag']))throw fail('OPERATION_ENTRY_UNSUPPORTED');request.tag=flags['--tag'];}
  for(const [flag,field] of [['--force-first-install','forceFirstInstall'],['--replace-soul','replaceSoul'],['--dedicated-nora','dedicatedNora'],['--skip-liveware','skipLiveware']]){
    if(flags[flag]!==undefined){if(target.type==='bridge'||action!=='install')throw fail('OPERATION_ENTRY_UNSUPPORTED');request[field]=true;}
  }
  if(flags['--operation-id']!==undefined&&!UUID.test(flags['--operation-id']))throw fail('OPERATION_ENTRY_UNSUPPORTED');
  if(input.operationId!==undefined&&(!UUID.test(input.operationId)||!Number.isSafeInteger(input.snapshotSequence)||input.snapshotSequence<1))throw fail('OPERATION_ENTRY_UNSUPPORTED');
  if(flags['--operation-id']&&input.operationId&&flags['--operation-id']!==input.operationId)throw fail('OPERATION_REQUEST_CONFLICT');
  return {kind,action,target,flags,request,argv:input.argv.slice(1),stdin:Buffer.from(input.stdin,'base64'),operationId:input.operationId,snapshotSequence:input.snapshotSequence};
}

function pythonFor(receipt){
  const base=path.join(receipt.hermesHome,'hermes-agent','venv');
  const candidate=receipt.platform==='win32'?path.join(base,'Scripts/python.exe')
    :[path.join(base,'bin/python3'),path.join(base,'bin/python')].find(file=>fs.existsSync(file));
  if(!candidate||!fs.existsSync(candidate))throw fail('RESOURCE_INCOMPLETE','诺拉运行环境尚未就绪，请使用完整启动器完成安装，现有数据已保留。');
  return candidate;
}
function environment(receipt){
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('NORA_OPERATION_')||['NODE_OPTIONS','NODE_PATH','PYTHONSTARTUP','NORA_UPDATE_LIFECYCLE'].includes(key))delete env[key];
  Object.assign(env,{NORA_TAVERN_HOME:receipt.noraHome,NORA_HERMES_HOME:receipt.hermesHome,HERMES_HOME:receipt.hermesHome,
    HERMES_INSTALL_DIR:path.join(receipt.hermesHome,'hermes-agent'),TAVERN_DATA_ROOT:receipt.installRoot,NORA_RELEASE_CHANNEL:receipt.channel,
    PYTHONPATH:path.join(receipt.hermesHome,'hermes-agent'),PYTHONNOUSERSITE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',
    TAVERN_NODE_EXECUTABLE:path.join(receipt.hermesHome,'node',receipt.platform==='win32'?'node.exe':'bin/node')});
  return env;
}
function bridgeArgs(receipt,command,options={}){
  const args=['--nora-home',receipt.noraHome,'--hermes-home',receipt.hermesHome,'--install-root',receipt.installRoot,'--port',String(receipt.port),command];
  for(const [name,flag] of [['service','--service'],['releaseDir','--release-dir'],['tag','--tag'],['operationId','--operation-id'],['kind','--kind'],['version','--version']])
    if(options[name]!==undefined)args.push(flag,String(options[name]));
  return args;
}
function guardedRunner(receipt,{diagnostics,onEvent=()=>{}}={}){
  const packets=createFaultPackets({clean:diagnostics.clean,roots:()=>[receipt.noraHome,receipt.resourcesRoot,os.homedir()]});
  return (context,target,args,{readonly=false,stdin=Buffer.alloc(0),lifecycle,node=false}={})=>new Promise((resolve,reject)=>{
    let child;
    const legacy=node&&target===path.join(__dirname,'legacy-recovery-worker.js');
    try{
      const env=environment(receipt);if(lifecycle)env.NORA_UPDATE_LIFECYCLE=JSON.stringify(lifecycle);
      if(readonly){
        if(target!==receipt.resources['launcher_bridge.py'].path||!['status','operation-effects','plan-update','verify-model'].some(name=>args.includes(name)))throw fail('OPERATION_ENTRY_UNSUPPORTED');
        child=spawn(pythonFor(receipt),['-B','-u',target,...args],{env,cwd:receipt.resourcesRoot,windowsHide:true});
      }else{
        context.check();
        child=node?context.lease.spawn(process.execPath,[target,...args],{env:{...env,ELECTRON_RUN_AS_NODE:'1'},cwd:receipt.resourcesRoot,kind:legacy?'legacy-recovery':'runtime-bootstrap'})
          :context.lease.spawn(pythonFor(receipt),['-B','-u',receipt.resources['operation_control.py'].path,'--delegate-exec','-B','-u',target,...args],
            {env,cwd:receipt.resourcesRoot,kind:'python-maintenance',managedPythonRoot:path.join(receipt.hermesHome,'python'),venvHome:path.join(receipt.hermesHome,'hermes-agent/venv')});
      }
    }catch(error){reject(error);return;}
    let result=null,primary=null,outputError=null;
    const installer=target===receipt.resources['first_install.py'].path||target===receipt.resources['bootstrap.py']?.path
      ||Object.entries(receipt.managed||{}).some(([name,item])=>name!=='ops/installer/nora_system.py'&&item.path===target)
      ||target===receipt.resources['launcher_bridge.py'].path&&['install','update','repair','plan-update','recover-update','recover-install','resume-committed-update','resume-committed-install'].includes(args[8]);
    const evidence=packets.collector(true,{output:node||installer,components:node?(legacy?['updater']:['runtime']):installer?['bridge','installer','updater','native']:['bridge']});
    const observe=(line,stream)=>{
      let message;try{message=JSON.parse(line);}catch{message={event:'log',line,stream};}
      if(message.event==='result')result=message;
      else{
        const reviewed=diagnostics.clean(message);evidence.observe(reviewed.event==='log'?{...reviewed,stream:reviewed.stream||stream}:reviewed);
        diagnostics.event(reviewed.event==='log'?{...reviewed,uploadScope:node||installer?'maintenance':undefined}:reviewed);context?.observe(reviewed);onEvent(reviewed);
        if(message.event==='error')primary=fail(message.userCode||message.code||'OPERATION_CHILD_FAILED',message.message||'维护进程执行失败，请查看诊断记录。');
      }
    };
    const badOutput=error=>{outputError ||= error;};
    consumeLines(child.stdout,line=>observe(line,'stdout'),badOutput,{preserveBlankLines:true});
    consumeLines(child.stderr,line=>observe(line,'stderr'),badOutput,{preserveBlankLines:true});
    const timer=setTimeout(()=>child.kill('SIGTERM'),readonly?90000:30*60*1000);timer.unref?.();
    child.once('error',error=>{clearTimeout(timer);reject(evidence.attach(error));});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);
      diagnostics.write('process.exit',{exitCode:code,signal});
      if(code!==0||primary||outputError)reject(evidence.attach(Object.assign(primary||outputError||fail('OPERATION_CHILD_FAILED','维护进程未完成。现有安装和诊断记录已保留。'),{exitCode:code,signal})));
      else resolve(result||{});
    });
    child.stdin.end(stdin);
  });
}
function workflowVerified(route,result,status,before,target){
  return verifyWorkflowResult({action:route.kind,service:route.request.service||'all',
    targetVersion:target?.releaseManifest?.versions?.tavern||target?.version,result,status,before});
}
function detailedConsent(home){
  try{
    const file=path.join(home,'installer/telemetry.json');
    if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>2*1024*1024)return {enabled:false,consentId:''};
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    const enabled=value.schema===1&&value.consentVersion===3&&value.enabled===true&&UUID.test(value.diagnosticConsentId||'');
    return {enabled,consentId:enabled?value.diagnosticConsentId:''};
  }catch{return {enabled:false,consentId:''};}
}
function operationTelemetry(receipt,operationId,{evidence,diagnostics,fetcher,context}={}){
  const telemetry=createTelemetry({file:path.join(receipt.installerDirectory,'operations',operationId,'telemetry.json'),launcherVersion:receipt.launcherVersion,
    platform:receipt.platform,arch:receipt.arch,enabled:true,diagnosticDefault:false,automatic:false,
    clean:diagnostics.clean,roots:()=>[receipt.noraHome,receipt.resourcesRoot,os.homedir()],fetcher,
    operationLogs:(id,cursor)=>diagnostics.readOperation(id,cursor),
    logScope:(task,work)=>diagnostics.scope(task.id,{action:task.action,version:receipt.launcherVersion,node:process.versions.node},work),
    operationContext:()=>({...context?.snapshot,evidence:evidence.read(operationId)}),
    onDelivery:({operationId:id,summary})=>evidence.updateDelivery(id,summary)});
  // The current explicit GUI choice controls deferred details too.
  telemetry.syncDiagnosticConsent(detailedConsent(receipt.noraHome));
  return telemetry;
}

async function execute({receiptPath,request},{validate=capability.validate,lock,run,policy,telemetry:telemetryEnabled=true,fetcher=globalThis.fetch,onEvent=()=>{},requestId=randomUUID()}={}){
  const validation={receiptPath,noraHome:path.dirname(path.dirname(receiptPath)),currentExecutable:process.execPath};
  const receipt=await validate(validation);
  const route=routeRequest(receipt,request);
  const diagnostics=createDiagnostics({primary:()=>path.join(receipt.installerDirectory,'install.log')});
  if(route.kind==='pair'){try{diagnostics.addSecret(JSON.parse(route.stdin.toString('utf8')).code);}catch{throw fail('OPERATION_ENTRY_UNSUPPORTED');}}
  const evidence=createEvidenceStore({directory:receipt.installerDirectory,clean:diagnostics.clean});
  const runner=run||guardedRunner(receipt,{diagnostics,onEvent});
  const bridge=(command,options={},context=null)=>runner(context,receipt.resources['launcher_bridge.py'].path,bridgeArgs(receipt,command,options),
    {readonly:context===null,stdin:options.stdin||Buffer.alloc(0)});
  const native=lock||require('./operation-lock');
  const guard={probe:options=>native.probe(options),acquire:async options=>{
    const lease=await native.acquire(options);
    try{
      let current;
      try{current=await validate(validation);}
      catch(cause){throw Object.assign(fail('CONDITIONS_CHANGED','启动器或安装记录在准入期间已变化，未执行维护。请打开启动器重新检查状态。'),{cause});}
      const {registeredAt:priorRegistration,...priorIdentity}=receipt;
      const {registeredAt:currentRegistration,...currentIdentity}=current;
      if(!isDeepStrictEqual(priorIdentity,currentIdentity)||!isDeepStrictEqual(route.target,capability.authorizeTarget(current,route.target.path)))
        throw fail('CONDITIONS_CHANGED','启动器、安装实例或维护程序身份已变化，未执行维护。请打开启动器重新检查状态。');
      // Executor inspection must consume the revalidated APP resources, after
      // the native lease closes the admission window. Injected guards own their
      // inspection contract in isolated tests.
      if(lock)return lease;
      return await acquireInspected({...options,lock:{acquire:async()=>lease,probe:params=>native.probe(params)},
        python:pythonFor(current),script:current.resources['operation_control.py'].path,env:environment(current)});
    }catch(error){
      try{await lease.release();}catch(secondary){error.secondaryErrors=[...(error.secondaryErrors||[]),{operation:'release-admission',error:secondary}];}
      throw error;
    }
  }};
  const sharedPolicy=policy||require('./operation-policy').create({home:receipt.noraHome,hermesHome:receipt.hermesHome,installRoot:receipt.installRoot,bridge,
    networkFetch:fetcher,launcherVersion:receipt.launcherVersion,channel:receipt.channel,platform:receipt.platform,arch:receipt.arch,
    runRuntime:(context,{recover,allowCommitted})=>runner(context,path.join(__dirname,'runtime-worker.js'),
      [path.join(receipt.resourcesRoot,'payload'),receipt.noraHome,receipt.hermesHome,...(recover?['--recover-runtime']:[]),...(allowCommitted?['--allow-committed']:[])],{node:true}),
    runLegacy:(context,request)=>runner(context,path.join(__dirname,'legacy-recovery-worker.js'),[receipt.noraHome],
      {node:true,stdin:Buffer.from(JSON.stringify(request))})});
  let telemetry,operationError;
  const beginTelemetry=context=>{
    diagnostics.begin(requestId,{operationId:context.operationId,action:route.kind,version:receipt.launcherVersion,
      platform:receipt.platform,arch:receipt.arch,node:process.versions.node});
    if(telemetryEnabled&&!telemetry){telemetry=operationTelemetry(receipt,context.operationId,{evidence,diagnostics,fetcher,context});telemetry.begin(route.kind==='recover'?'repair':route.kind,{operationId:context.operationId});}
  };
  const finishTelemetry=async(context,outcome,error)=>{
    telemetry?.finish(outcome,error);telemetry?.syncDiagnosticConsent(detailedConsent(receipt.noraHome));await telemetry?.flush();
    if(telemetry)context.delivery(telemetry.deliverySummary(context.operationId));
  };
  const rememberFailure=(error,context)=>{
    operationError=error;diagnostics.error('cli.operation-failed',error);
    telemetry?.report(error,{source:'launcher_process',site:'process.run'});
  };
  const recover=async(context,options)=>{
    rejectAppHandoff(context.snapshot);
    if(route.kind!=='recover')return sharedPolicy.recover(context,options);
    beginTelemetry(context);
    const perform=async()=>{
      const result=await sharedPolicy.recover(context,options);
      if(result.filesRestored===true&&result.verification!=='confirmed')operationError=fail('RESTORED_START_FAILED','旧版本文件已恢复，但服务未通过启动验收。');
      return result;
    };
    return telemetry?telemetry.scope(perform):perform();
  };
  const recoverers={},recheckers={};for(const kind of ['install','update','repair','recover']){recoverers[kind]=recover;recheckers[kind]=sharedPolicy.recheck;}
  const updateExecutor=require('./system-update-executor').create({bridge,compare:require('./releases').compare,
    finalizeLauncher:async()=>{throw fail('LAUNCHER_RECOVERY_REQUIRED','此操作涉及启动器程序替换，请打开新版启动器完成验收。原安装和程序备份已保留。');}});
  const controller=createOperationController({directory:receipt.installerDirectory,lock:guard,evidence,observeEffects:sharedPolicy.observe,recoverers,recheckers,
    captureConditions:(record,context)=>sharedPolicy.initialConditions?.(record,context),
    identifyFailureCondition:(error,record)=>sharedPolicy.identifyFailureCondition?.(error,record),
    projectResult:value=>value?.value??value});
  const work=async context=>{
    rejectAppHandoff(context.snapshot);
    beginTelemetry(context);
    const perform=async()=>{
      const original=context.target.releasePlan;
      const facts=await sharedPolicy.observe(context.snapshot);
      let runtimeContinuation=false;
      if(facts.canResume===true){
        if(route.kind==='install'){
          const hasTransaction=fs.existsSync(path.join(receipt.installerDirectory,'operations',context.operationId,'first-install/transaction.json'));
          const continued=await updateExecutor.resumeInstallation(context,{hasTransaction,port:receipt.port});
          if(continued)return {verification:'confirmed',value:continued};
          if(hasTransaction)throw fail('VERIFICATION_FAILED');
          // A committed runtime alone does not prove that system installation
          // committed. Continue the same fixed plan through guarded first install.
          runtimeContinuation=facts.effectState==='changed';
        }else if(['update','repair'].includes(route.kind)){
          const continued=await updateExecutor.resumeCommitted(context,{hasTransaction:true,port:receipt.port});
          if(!continued)throw fail('VERIFICATION_FAILED');
          return {verification:'confirmed',value:continued};
        }
      }
      if(original&&original.schema!=='nora-release-plan/1')throw fail('OPERATION_ENTRY_UNSUPPORTED','此固定安装计划需要在启动器中继续。请保留原数据与操作记录，不要重新选择更新目标。');
      if(!['untouched','restored'].includes(facts.effectState)&&!runtimeContinuation)throw fail('UPDATE_RECOVERY_REQUIRED');
      const before=await bridge('status');
      let args=route.argv.slice(),fixedTarget=original;
      if(['install','update','repair'].includes(route.kind)){
        const releases=require('./releases');
        const local=route.flags['--release-dir'];
        const transport=local?require('./local-release').createLocalRelease(path.resolve(local)):fetcher;
        const options={launcherVersion:receipt.launcherVersion,platform:receipt.platform,arch:receipt.arch,channel:receipt.channel,
          operationDirectory:path.join(receipt.installerDirectory,'operations',context.operationId),
          fetcher:transport,networkPolicy:{diagnostics},cacheRoot:path.join(receipt.noraHome,'cache/releases'),tag:route.flags['--tag'],
          onEvent:message=>{const reviewed=diagnostics.clean(message);diagnostics.event(reviewed);context.observe(reviewed);telemetry?.observe(reviewed);onEvent(reviewed);}};
        let payload;
        if(original?.schema==='nora-release-plan/1'){
          fixedTarget=releases.validatePlan(original,options);
        }else{
          const selected=await releases.selectPlan({...options,mode:route.kind==='install'?'install':'update'});
          fixedTarget=releases.sealPlan(selected,{...options,assertOwner:()=>context.check()});
          await context.plan({request:route.request,releasePlan:fixedTarget,currentVersion:typeof before.version==='string'?before.version:null});
        }
        // A CLI cannot safely replace its own APP without the GUI handoff path.
        if(fixedTarget.launcherManifest)throw fail('RELEASE_COMPATIBILITY','目标版本需要先更新启动器。请保留数据，在启动器中检查更新后继续。');
        await context.stage('downloading');
        payload=route.kind==='install'?await releases.prepareInstall({...options,selectedPlan:fixedTarget})
          :await releases.prepareUpdate({...options,selectedPlan:fixedTarget,plan:releaseDir=>bridge('plan-update',{releaseDir})});
        await context.stage('prepared');
        const manifestSha=await releases.hash(path.join(payload,'release-manifest.json'));
        if(route.flags['--manifest-sha256']!==undefined&&route.flags['--manifest-sha256']!==manifestSha
          ||route.flags['--target-commit']!==undefined&&route.flags['--target-commit']!==fixedTarget.commit)throw fail('CONDITIONS_CHANGED','指定发布身份与固定更新计划不一致，未修改当前安装。');
        const index=args.indexOf('--release-dir');if(index>=0)args[index+1]=payload;else args.push('--release-dir',payload);
        if(route.target.type!=='bridge'){
          for(const [flag,value] of [['--manifest-sha256',manifestSha],['--managed-home',receipt.noraHome]]){
            if(flag==='--managed-home'&&route.kind==='install')continue;
            const at=args.indexOf(flag);if(at>=0)args[at+1]=value;else args.push(flag,value);
          }
        }
      }
      await context.stage('applying');
      // The journal observer proves actual effects; setting unknown first avoids
      // pretending a command that crashed before returning changed no files.
      if(['install','update','repair'].includes(route.kind))await context.effect('unknown');
      const result=route.target.type==='bridge'&&['update','repair'].includes(route.kind)
        ?await updateExecutor.apply(context,{releaseDir:args[args.indexOf('--release-dir')+1],target:fixedTarget.version||fixedTarget.releaseManifest?.versions?.tavern,port:receipt.port})
        :await runner(context,route.target.path,args,{stdin:route.stdin,
        ...(['update','repair'].includes(route.kind)&&route.target.type!=='bridge'?{lifecycle:{bridge:receipt.resources['launcher_bridge.py'].path,
          noraHome:receipt.noraHome,hermesHome:receipt.hermesHome,installRoot:receipt.installRoot,port:receipt.port,before}}:{})});
      await context.stage('verifying');
      const status=await bridge('status');
      if(!workflowVerified(route,result,status,before,fixedTarget))throw fail('VERIFICATION_FAILED','未取得明确的安装、版本或服务验收结果。请检查状态，保留安装和日志。');
      return {verification:'confirmed',value:status};
    };
    return telemetry?telemetry.scope(perform):perform();
  };
  let operation;
  try{
    if(route.kind==='recover'){
      const old=await controller.snapshot(route.operationId||route.flags['--operation-id']);
      if(!old)throw fail('UPDATE_RECOVERY_REQUIRED');
      if(route.operationId&&old.snapshotSequence!==route.snapshotSequence)throw fail('OPERATION_SNAPSHOT_CHANGED');
      if(route.action==='recover-install'?old.kind!=='install':!['update','repair'].includes(old.kind))throw fail('OPERATION_REQUEST_CONFLICT');
      rejectAppHandoff(old);
      operation=await controller.recover(old.operationId,{snapshotSequence:old.snapshotSequence,onFailure:rememberFailure});
    }else {
      const options={target:{request:route.request},execute:work,onFailure:rememberFailure};
      if(route.operationId){
        const old=await controller.snapshot(route.operationId);
        if(!old)throw fail('UPDATE_RECOVERY_REQUIRED');
        if(old.kind!==route.kind||old.snapshotSequence!==route.snapshotSequence)throw fail('OPERATION_SNAPSHOT_CHANGED');
        if(JSON.stringify(old.target.request)!==JSON.stringify(route.request))throw fail('OPERATION_REQUEST_CONFLICT');
        rejectAppHandoff(old);
        operation=await controller.resume(old.operationId,{...options,snapshotSequence:old.snapshotSequence});
      }else operation=await controller.start(route.kind,options,requestId);
    }
    // Close the log only after recovery and lease release have returned their
    // actual outcome. Automatic rollback does not make the update successful.
    const outcome=terminalResult({...operation,requestedAction:route.kind}).ok?'succeeded':operation.state==='cancelled'?'cancelled':'failed';
    diagnostics.write('operation.result',{state:operation.state,effectState:operation.effectState,
      verification:operation.verification,recoveryOutcome:operation.recoveryOutcome,evidenceStatus:operation.evidenceStatus});
    diagnostics.finish(outcome);
    await finishTelemetry({operationId:operation.operationId,delivery:summary=>evidence.updateDelivery(operation.operationId,summary)},outcome,operationError);
    if(telemetry){
      evidence.updateDelivery(operation.operationId,telemetry.deliverySummary(operation.operationId));
    }
    if(['succeeded','rolled-back'].includes(operation.state)){
      try{await capability.register({...receipt,executable:receipt.executable.path,isPackaged:true});}
      catch(error){diagnostics.error('cli.capability-refresh',error);}
    }
    // Recovery keeps the original operation's kind and first failure. Its
    // result must describe this validated request, rather than relabel history.
    return {...operation,requestedAction:route.kind};
  }catch(error){diagnostics.error('cli.operation-exit',error);diagnostics.finish('failed');
    telemetry?.finish('failed',error);await telemetry?.flush();throw error;
  }finally{telemetry?.close();}
}

async function drainOperationOutboxes({noraHome,launcherVersion,platform=process.platform,arch=process.arch,fetcher=globalThis.fetch,
  maximum=4,deadlineMs=10000,probe,lock}={}){
  const directory=path.join(path.resolve(noraHome),'installer'),root=path.join(directory,'operations');
  const evidence=createEvidenceStore({directory});
  const diagnostics=createDiagnostics({primary:()=>path.join(directory,'install.log')});
  const receipt={noraHome,installerDirectory:directory,resourcesRoot:'',launcherVersion,platform,arch};
  const results=[],deadline=Date.now()+Math.min(10000,Math.max(1,deadlineMs));
  for(const file of [noraHome,directory,root])if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw fail('OPERATION_CAPABILITY_INVALID');
  const guard=lock||require('./operation-lock');
  const held=await (probe||guard.probe)({directory});
  if(held.busy||held.errors?.length)return results;
  const limit=Number.isInteger(maximum)?Math.min(8,Math.max(1,maximum)):4;
  if(!fs.existsSync(root))return results;
  let lease;
  try{lease=await guard.acquire({directory,operationId:randomUUID(),ownerEpoch:Date.now()});}
  catch(error){if(error.code==='OPERATION_BUSY')return results;throw error;}
  const cursorFile=path.join(directory,'.outbox-cursor.json');let last='';
  try {
  const entries=fs.readdirSync(root).filter(name=>UUID.test(name)).sort();
  if(entries.length>4100)throw fail('OPERATION_HISTORY_CAPACITY','待确认诊断记录超过保留预算，请查看日志并联系维护者。');
  const cursorStat=fs.lstatSync(cursorFile,{throwIfNoEntry:false});
  if(cursorStat?.isSymbolicLink()||cursorStat&&!cursorStat.isFile())throw fail('OPERATION_CAPABILITY_INVALID');
  if(cursorStat?.size<=256)try{const saved=JSON.parse(fs.readFileSync(cursorFile,'utf8'));if(saved.schema===1&&UUID.test(saved.last))last=saved.last;}catch{}
  const start=entries.findIndex(id=>id>last),ordered=start<0?entries:entries.slice(start).concat(entries.slice(0,start));
  for(const id of ordered.slice(0,512)){
    if(results.length>=limit||Date.now()>=deadline)break;
    last=id;
    const file=path.join(root,id,'telemetry.json');
    try{
      const operationStat=fs.lstatSync(path.join(root,id),{throwIfNoEntry:false});
      if(!operationStat?.isDirectory()||operationStat.isSymbolicLink())continue;
      const outboxStat=fs.lstatSync(file,{throwIfNoEntry:false});
      if(!outboxStat?.isFile()||outboxStat.isSymbolicLink()||outboxStat.size>2*1024*1024)continue;
      const state=JSON.parse(fs.readFileSync(file,'utf8'));
      if(state.schema!==1||!Array.isArray(state.queue)||state.queue.some(event=>event.operation_id&&event.operation_id!==id))continue;
      let pendingLogs=false;
      const rawFile=file+'.logs',rawStat=fs.lstatSync(rawFile,{throwIfNoEntry:false});
      if(rawStat){
        if(!rawStat.isFile()||rawStat.isSymbolicLink()||rawStat.size>2*1024*1024)continue;
        const raw=JSON.parse(fs.readFileSync(rawFile,'utf8'));
        if(raw.schema!==1||!Array.isArray(raw.jobs)||raw.jobs.length>64||raw.jobs.some(job=>job.id!==id))continue;
        pendingLogs=raw.jobs.some(job=>job.closed&&!job.done&&!job.blocked);
      }
      if(!state.queue.length&&!state.active&&!pendingLogs)continue;
      const boundedFetch=(url,options)=>fetcher(url,{...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(Math.max(1,deadline-Date.now()))])});
      const telemetry=operationTelemetry(receipt,id,{evidence,diagnostics,fetcher:boundedFetch});
      try{await telemetry.flush();const summary=telemetry.deliverySummary(id);evidence.updateDelivery(id,summary);results.push({operationId:id,summary});}
      finally{telemetry.close();}
    }catch(error){diagnostics.error('cli.outbox-deferred',error);}
  }
  if(last){const temporary=cursorFile+'.'+randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify({schema:1,last}),{mode:0o600});fs.renameSync(temporary,cursorFile);}
    finally{fs.rmSync(temporary,{force:true});}}
  }finally{await lease.release();}
  return results;
}

function terminalResult(operation){
  const recovery=operation?.requestedAction==='recover'
    ||operation?.requestedAction===undefined&&operation?.kind==='recover'&&!operation?.primaryFailure;
  const ok=operation?.state==='succeeded'||recovery&&operation.state==='rolled-back'
    &&operation.verification==='confirmed';
  return {event:'result',ok,operation};
}

async function main(){
  const index=process.argv.indexOf('--receipt'),receiptPath=index>=0?process.argv[index+1]:undefined;
  if(!process.versions.electron||!receiptPath||process.env.ELECTRON_RUN_AS_NODE!=='1')throw fail('OPERATION_CAPABILITY_REQUIRED');
  let chunks=[],size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>2*1024*1024)throw fail('OPERATION_ENTRY_UNSUPPORTED');chunks.push(chunk);}
  const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const operation=await execute({receiptPath,request},{onEvent:message=>{if(['task','milestone','progress','diagnostic','error'].includes(message.event))process.stdout.write(JSON.stringify(message)+'\n');}});
  const result=terminalResult(operation);
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.ok?0:1;
}
if(require.main===module)main().catch(error=>{process.stderr.write(JSON.stringify({event:'error',code:error.code||'OPERATION_CHILD_FAILED',message:error.message})+'\n');process.exitCode=1;});
module.exports={execute,routeRequest,drainOperationOutboxes,terminalResult};
