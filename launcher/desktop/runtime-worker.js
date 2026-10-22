const { installBundledHermes } = require('./runtime');
const { errorDetails } = require('./diagnostics');
const {connect} = require('./operation-delegate');
const fs=require('node:fs');
const path=require('node:path');
const runtime=require('./runtime');
const {isDeepStrictEqual}=require('node:util');
const [payloadRoot, noraHome, hermesHome,...options] = process.argv.slice(2);
async function main(){
let delegate,privateStage;
const cleanupPrivateStage=()=>{
  if(!privateStage)return;
  const {operationId}=delegate.context,owned=require('./runtime-transaction').paths({noraHome,hermesHome,operationId});
  const current=fs.lstatSync(owned.stage,{bigint:true});
  if(owned.stage!==privateStage.path||current.dev!==privateStage.identity.dev||current.ino!==privateStage.identity.ino||current.isSymbolicLink())
    throw new Error('只读检查暂存目录身份发生变化，保留现场。');
  fs.rmSync(owned.stage,{recursive:true});privateStage=undefined;
};
try {
  delegate=await connect();delegate.assertActive();
  const onEvent=message => {
      delegate.assertActive();
      // Fixed program stages survive native termination without disclosing a path.
      if (message.event === 'task') process.stderr.write(`Runtime phase: ${message.stage_id}; ${message.task}\n`);
      process.stdout.write(`${JSON.stringify(message)}\n`);
    };
  const {operationId,ownerEpoch}=delegate.context;
  let request={};
  if(options.includes('--repair-managed')){
    let bytes=0,parts=[];for await(const part of process.stdin){bytes+=part.length;if(bytes>64*1024)throw new Error('修复输入过大');parts.push(part);}
    request=JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  const retained=require('./retained-installation').inspect(noraHome,{operationId});
  if(retained?.reinstallOperationId===operationId)request.port??=retained.port;
  const bridge=path.join(process.cwd(),'launcher_bridge.py');
  const preflight=async(root,manifest,offlineOnly=false,effects=false)=>{
    const stat=fs.lstatSync(bridge);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('无法核验受管修复检查组件。');
    const python=path.join(root,manifest.venvPython),args=['-B',bridge,'--nora-home',noraHome,'--hermes-home',hermesHome,
      '--install-root',path.join(noraHome,'tavern'),'--port',String(request.port),
      ...(effects?['operation-effects','--operation-id',operationId,'--kind','update']:['repair-preflight',...(offlineOnly?['--offline-only']:[])])];
    const result=await delegate.run(python,args,{kind:'runtime-helper',purpose:'python',runtimeRoot:root,
      managedPythonRoot:path.join(root,'python'),venvHome:path.dirname(path.dirname(python)),timeoutMs:300000,
      env:{...process.env,PYTHONPATH:path.join(root,'hermes-agent'),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
    delegate.assertActive();
    if(result.error||result.status!==0)throw Object.assign(new Error('缺失程序修复检查未通过：'+(result.stderr||result.stdout||result.error?.message||'')),{code:'RUNTIME_PARTIAL_UNCONFIRMED'});
    const value=(result.stdout||'').split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}}).findLast(value=>value?.event==='result');
    if(!value)throw new Error('修复检查未返回实际状态');delete value.event;return value;
  };
  let inspector;
  const verifyOffline=async()=>{
    if(inspector&&fs.existsSync(inspector.root))return preflight(inspector.root,inspector.manifest,true);
    const saved=require('./retained-installation').inspect(noraHome,{operationId});
    if(saved?.reinstallOperationId===operationId&&require('./retained-installation').absentPrograms(noraHome,saved)){
      const offline=require('./uninstall-offline-check');await offline.portOffline(saved.port);offline.nativeOffline({root:noraHome});await offline.portOffline(saved.port);
      return {offline:true,running:false,gatewayRunning:false,clawchatConnected:false};
    }
    const bundle=runtime.findBundledRuntime(payloadRoot);return preflight(hermesHome,bundle.manifest,true);
  };
  const transaction=require('./runtime-transaction');let result;
  if(options.includes('--inspect-managed')){
    const bundle=runtime.findBundledRuntime(payloadRoot);
    if(!bundle||runtime.sha256File(bundle.archive)!==bundle.manifest.sha256)throw new Error('只读检查运行时校验失败');
    const owned=transaction.paths({noraHome,hermesHome,operationId}),{directory,stage}=owned;
    if(fs.existsSync(stage)){
      // Preserve a preceding failed attempt through the same authenticated
      // archive used by installation retry. Never execute or delete its stage.
      const archived=transaction.archiveAttempt({noraHome,hermesHome,operationId,ownerEpoch,delegate,bundle});
      if(!archived||fs.existsSync(stage))throw new Error('原暂存程序无法归属，保留现场，不覆盖检查目录。');
    }
    fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(stage);privateStage={path:stage,identity:fs.lstatSync(stage,{bigint:true})};
    await runtime.extractArchiveAsync(bundle,directory,delegate,onEvent);
    const before=fs.lstatSync(stage,{bigint:true});
    await runtime.repairRuntimeAsync(stage,bundle.manifest,delegate);await runtime.validateRuntimeAsync(stage,bundle.manifest,delegate);
    const checked=await preflight(stage,bundle.manifest),system=await preflight(stage,bundle.manifest,false,true);
    if(checked.partialRepair?.version!==request.version||checked.partialRepair?.commit!==request.commit
      ||!isDeepStrictEqual(checked.partialRepair.bindings,request.bindings))throw new Error('只读检查期间原安装已变化');
    const after=fs.lstatSync(stage,{bigint:true});if(before.dev!==after.dev||before.ino!==after.ino||after.isSymbolicLink())throw new Error('检查目录身份发生变化');
    cleanupPrivateStage();result={...checked,effects:system.effects};
  }else if(options.includes('--recover-runtime')){
    let originalPartialCandidate;
    if(options.includes('--repair-managed')){
      const prior=transaction.inspect({noraHome,hermesHome,operationId});
      if(prior.effectState==='unknown')throw new Error('原恢复记录或目录归属无法核验，保留现场。');
      const bundle=runtime.findBundledRuntime(payloadRoot);
      if(!bundle||runtime.sha256File(bundle.archive)!==bundle.manifest.sha256)throw new Error('只读修复检查运行时校验失败');
      const owned=transaction.paths({noraHome,hermesHome,operationId}),{directory,stage}=owned;
      if(fs.existsSync(stage))throw new Error('历史暂存程序仍存在，保留现场，不覆盖检查目录。');
      fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(stage);privateStage={path:stage,identity:fs.lstatSync(stage,{bigint:true})};
      await runtime.extractArchiveAsync(bundle,directory,delegate,onEvent);
      const stageIdentity=fs.lstatSync(stage,{bigint:true});
      await runtime.repairRuntimeAsync(stage,bundle.manifest,delegate);await runtime.validateRuntimeAsync(stage,bundle.manifest,delegate);
      inspector={root:stage,manifest:bundle.manifest};
      const proof=await preflight(stage,bundle.manifest,prior.partialOrigin===true);originalPartialCandidate=proof.partialRepair;
      if(!prior.partialOrigin&&(originalPartialCandidate?.version!==request.version||originalPartialCandidate?.commit!==request.commit
        ||!isDeepStrictEqual(originalPartialCandidate.bindings,request.bindings)))throw new Error('原损坏安装已变化，保留现场');
      result=await transaction.recover({noraHome,hermesHome,operationId,ownerEpoch,delegate,
        allowCommitted:options.includes('--allow-committed'),onEvent,verifyOffline,originalPartialCandidate,partialPort:request.port});
      const restored=await preflight(stage,bundle.manifest);
      const expected=prior.originalPartial||originalPartialCandidate;
      if(!isDeepStrictEqual(restored.partialRepair,expected))throw new Error('原损坏状态未精确恢复，保留检查程序和现场');
      const system=await preflight(stage,bundle.manifest,false,true);
      transaction.confirmPartialSystemProof({noraHome,hermesHome,operationId,ownerEpoch,delegate},system.effects);
      const current=fs.lstatSync(stage,{bigint:true});
      if(current.dev!==stageIdentity.dev||current.ino!==stageIdentity.ino||current.isSymbolicLink())throw new Error('只读检查暂存目录身份发生变化');
      cleanupPrivateStage();
      result=transaction.inspect({noraHome,hermesHome,operationId});
      result={...result,offlineProof:{offline:true,running:false,gatewayRunning:false,clawchatConnected:false,
        operationId,ownerEpoch}};
    }else result=await transaction.recover({noraHome,hermesHome,operationId,ownerEpoch,delegate,
      allowCommitted:options.includes('--allow-committed'),onEvent,verifyOffline});
  }else result=await installBundledHermes({payloadRoot,noraHome,hermesHome,operationId,ownerEpoch,delegate,onEvent,
    ...(retained?.reinstallOperationId===operationId?{verifyOffline}:{}),
    ...(options.includes('--repair-managed')?{partialRepair:request,
      preflightPartial:async(root,manifest)=>{inspector={root,manifest};return preflight(root,manifest);},verifyOffline}:{} )});
  const summary={...(result||{})};
  if(result?.components?.files){
    // Verification still consumes the complete on-disk inventory. Returning
    // its thousands of hashes exceeds both native and desktop IPC readers.
    const {files,...components}=result.components;
    summary.components={...components,fileCount:Object.keys(files).length};
  }
  process.stdout.write(JSON.stringify({event:'result',...summary})+'\n');
} catch (error) {
  try{cleanupPrivateStage();}catch(secondary){error.secondaryErrors=[...(error.secondaryErrors||[]),{operation:'cleanup-readonly-stage',error:secondary}];}
  if (error.context?.operation === 'copy-skill') {
    const {sourceType,destinationType,failingPathType,sourcePathLength,destinationPathLength,failingPathLength}=error.context;
    process.stderr.write(`Runtime skill copy failed: ${JSON.stringify({sourceType,destinationType,failingPathType,sourcePathLength,destinationPathLength,failingPathLength})}\n`);
  }
  process.stdout.write(`${JSON.stringify({ event: 'diagnostic', component: 'runtime', error: errorDetails(error) })}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'error', code: error.code || error.cause?.code, userCode: error.userCode, message: error.message })}\n`);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}finally{delegate?.close();}
}
main();
