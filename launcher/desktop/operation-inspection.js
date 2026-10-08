const fs=require('node:fs');
const {spawnSync}=require('node:child_process');

// Read-only admission proof. A free lock does not prove an orphaned maintenance
// process stopped; a PID in an old ledger does not prove it is still that process.
function inspectExecutors({sessions=[],python,script,env,run=spawnSync,platform=process.platform}={}) {
  const outstanding=sessions.flatMap(session=>(session.jobs||[]).filter(job=>!job.closedAt&&!job.spawnFailedAt)
    .map(job=>({operationId:session.operationId,jobId:job.jobId,pid:job.pid})));
  if(!outstanding.length)return {safe:true,jobs:[]};
  if(python&&script&&fs.existsSync(script)) {
    const result=run(python,[ '-B',script,'--inspect'],{env,encoding:'utf8',windowsHide:true,timeout:15000,
      maxBuffer:256*1024,input:JSON.stringify({sessions})});
    if(result.status===0&&!result.error){
      try{
        const value=JSON.parse(result.stdout);
        const expectedKeys=new Set(outstanding.map(job=>`${job.operationId}:${job.jobId}`));
        const returnedKeys=new Set(Array.isArray(value.jobs)?value.jobs.map(job=>`${job.operationId}:${job.jobId}`):[]);
        if(value.schema==='nora-executor-inspection/1'&&Array.isArray(value.jobs)&&value.jobs.length===outstanding.length
          &&returnedKeys.size===expectedKeys.size
          &&value.jobs.every(job=>outstanding.some(expected=>expected.jobId===job.jobId&&expected.operationId===job.operationId)
            &&['offline','active-verified','active-unverified','unknown'].includes(job.state)))
          return {safe:value.jobs.every(job=>job.state==='offline'),jobs:value.jobs};
      }catch{}
    }
  }
  const jobs=outstanding.map(job=>{
    if(!Number.isSafeInteger(job.pid)||job.pid<1)return {...job,state:'unknown'};
    let result;
    if(platform==='darwin')result=run('/bin/ps',['-p',String(job.pid),'-o','pid='],{encoding:'utf8',timeout:10000});
    else if(platform==='win32')result=run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      `$p=Get-Process -Id ${job.pid} -ErrorAction SilentlyContinue; if($null -eq $p){'absent'}else{'present'}`],
      {encoding:'utf8',windowsHide:true,timeout:10000});
    const offline=result&&!result.error&&(platform==='darwin'?result.status===1&&!result.stdout.trim():result.status===0&&result.stdout.trim()==='absent');
    return {...job,state:offline?'offline':'unknown'};
  });
  return {safe:jobs.every(job=>job.state==='offline'),jobs};
}

async function acquireInspected({lock,directory,operationId,ownerEpoch,python,script,env}) {
  const lease=await lock.acquire({directory,operationId,ownerEpoch});
  try{
    const history=await lock.probe({directory});
    if(history.errors?.length)throw Object.assign(new Error('执行记录无法核验，请保留现场并查看日志。'),{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
    const facts=inspectExecutors({sessions:history.sessions,python,script,env});
    if(!facts.safe)throw Object.assign(new Error('尚未确认上次维护进程已结束。现有文件已保留，请检查执行状态后再继续。'),
      {code:'OPERATION_EXECUTOR_UNCONFIRMED',executorFacts:facts});
    return lease;
  }catch(error){await lease.release();throw error;}
}
module.exports={inspectExecutors,acquireInspected};
