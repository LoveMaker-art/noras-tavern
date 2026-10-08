// Final acceptance is shared by GUI and CLI. A committed file transaction may
// finish its original service plan; it must never be applied a second time.
const failure=(message)=>Object.assign(new Error(message),{code:'VERIFICATION_FAILED'});
function create({bridge,compare,finalizeLauncher=async()=>{}}){
  if(typeof bridge!=='function'||typeof compare!=='function')throw new TypeError('Owned update backend is required');
  async function accept(context,result,target){
    if(result?.updateVerified!==true||result.systemReady!==true||compare(result.version,target)!==0)
      throw failure('更新后的版本、文件或服务尚未通过验收，旧版本备份继续保留。');
    const job=context.snapshot.handoffRef;
    if(job)await finalizeLauncher(job,result,context);
    return result;
  }
  async function resumeCommitted(context,{hasTransaction,port}={}){
    if(!hasTransaction)return null;
    const result=await bridge('operation-effects',{operationId:context.operationId,kind:'update'},context);
    const facts=result?.effects;
    if(facts?.operationId!==context.operationId||facts.status!=='committed')return null;
    const plan=context.target.releasePlan,target=plan?.version||plan?.releaseManifest?.versions?.tavern;
    if(!target||facts.canResume!==true)throw failure('已提交的更新缺少可核验的固定版本计划，未重复替换文件。');
    await context.stage('verifying');
    const verified=await bridge('resume-committed-update',{operationId:context.operationId,port},context);
    if(verified?.operationVerified!==true)throw failure('原更新事务尚未完成服务验收，未重复替换文件。');
    return accept(context,verified,target);
  }
  async function apply(context,{releaseDir,target,port}={}){
    if(!releaseDir||!target)throw failure('更新缺少固定版本文件，未修改当前安装。');
    const verified=await bridge('update',{port,releaseDir},context);
    return accept(context,verified,target);
  }
  async function resumeInstallation(context,{hasTransaction,port}={}){
    if(!hasTransaction)return null;
    const effects=(await bridge('operation-effects',{operationId:context.operationId,kind:'install'},context))?.effects;
    if(effects?.operationId!==context.operationId||effects.status!=='committed')return null;
    const plan=context.target.releasePlan,target=plan?.releaseManifest?.versions?.tavern||plan?.version||plan?.tag?.replace(/^v/,'');
    if(!target||effects.canResume!==true||compare(effects.version,target)!==0)
      throw failure('已提交的安装缺少可核验的固定版本，未重复安装文件。');
    await context.stage('verifying');
    const result=await bridge('resume-committed-install',{operationId:context.operationId,port},context);
    if(result?.operationVerified!==true||result.firstInstallVerified!==true||result.systemReady!==true||compare(result.version,target)!==0)
      throw failure('首装文件已提交，但程序和连接尚未通过实际验收；未重复安装。');
    return result;
  }
  return {resumeCommitted,resumeInstallation,apply};
}
module.exports={create};
