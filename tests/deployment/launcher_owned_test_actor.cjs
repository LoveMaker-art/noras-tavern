// Test-only bridge into the real native lease. All fixture writers must ACK and
// actually close; this does not replace OperationController workflow acceptance.
const path=require('node:path');
const {randomUUID}=require('node:crypto');
// The smallest existing subprocess caller has a 20 s budget. Admission and
// execution share 14 s; owned cancellation, close and release share another 4 s.
const EXECUTION_BUDGET_MS=14000,CLEANUP_BUDGET_MS=4000;
const CLOSURE_PREFIX='NORA_FIXTURE_CLOSURE ';
async function bounded(promise,deadline,code){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Object.assign(new Error(code),{code})),Math.max(1,deadline-Date.now()));
  })]);}finally{clearTimeout(timer);}
}
async function runOwnedActor({entry,root,python,script,args=[],lock,streams=process,
  executionMs=EXECUTION_BUDGET_MS,cleanupMs=CLEANUP_BUDGET_MS}){
  if(![entry,root,python,script].every(value=>value&&path.isAbsolute(value)))throw new Error('Pass absolute fixture actor paths');
  if(![executionMs,cleanupMs].every(value=>Number.isFinite(value)&&value>0))throw new TypeError('Finite positive fixture budgets are required');
  const directory=path.join(root,'installer'),deadline=Date.now()+executionMs;
  lock ||= require(entry);
  let lease,child,closed,primary,closureConfirmed=false;
  const admission=lock.acquire({directory,operationId:randomUUID(),ownerEpoch:1});
  try{
    lease=await bounded(admission,deadline,'FIXTURE_ACTOR_ADMISSION_TIMEOUT');
    child=lease.spawn(python,['-B',script,...args],{kind:'python-maintenance',managedPythonRoot:process.env.NORA_TEST_MANAGED_PYTHON_ROOT,venvHome:process.env.NORA_TEST_VENV_HOME,env:process.env});
    // A delegate error is not a close event. Retain the close independently so
    // the error path still cancels its held lease and waits for actual closure.
    closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    const failed=new Promise((_,reject)=>{child.once('error',reject);child.once('guard-lost',reject);});
    streams.stdin.pipe(child.stdin);child.stdout.pipe(streams.stdout,{end:false});child.stderr.pipe(streams.stderr,{end:false});
    const result=await bounded(Promise.race([closed,failed]),deadline,'FIXTURE_ACTOR_TIMEOUT');
    const jobs=(await bounded(lease.snapshot(),deadline,'FIXTURE_ACTOR_SNAPSHOT_TIMEOUT')).jobs;
    if(!jobs.length||!jobs.every(job=>job.closedAt&&job.delegation?.identityStatus==='reported'))throw new Error('Fixture writer was not acknowledged and closed');
    if(result.code!==0||result.signal!==null)throw Object.assign(new Error('Fixture actor failed'),{code:'FIXTURE_ACTOR_FAILED',exitCode:result.code,signal:result.signal});
  }catch(error){primary=error;}
  finally{
    if(child)streams.stdin.unpipe(child.stdin);
    const cleanupDeadline=Date.now()+cleanupMs;
    try{
      // A late admission must not leave a fresh empty guard behind. No arbitrary
      // PID/tree is killed; cancellation always uses this fixture's real lease.
      lease ||= await bounded(admission,cleanupDeadline,'FIXTURE_ACTOR_ADMISSION_UNCONFIRMED');
      if(child)await bounded(lease.cancel({signal:'SIGKILL'}),cleanupDeadline,'FIXTURE_ACTOR_CANCEL_UNCONFIRMED');
      const facts=await bounded(lease.snapshot(),cleanupDeadline,'FIXTURE_ACTOR_CLOSURE_UNCONFIRMED');
      // A guard refusal without a native PID cannot emit child close. Its
      // persisted spawnFailedAt proves no process was admitted; never substitute
      // an error event for closure of a child which actually started.
      const rejectedBeforeSpawn=child?.pid===undefined&&facts.jobs.some(job=>job.jobId===child.jobId&&job.spawnFailedAt);
      if(child&&!rejectedBeforeSpawn)await bounded(closed,cleanupDeadline,'FIXTURE_ACTOR_CLOSE_UNCONFIRMED');
      if(facts.jobs.some(job=>!job.closedAt&&!job.spawnFailedAt))throw new Error('Fixture actor closure remains unconfirmed');
      await bounded(lease.release(),cleanupDeadline,'FIXTURE_ACTOR_RELEASE_UNCONFIRMED');
      const probe=await bounded(lock.probe({directory}),cleanupDeadline,'FIXTURE_ACTOR_GUARD_UNCONFIRMED');
      if(probe.busy)throw new Error('Fixture native guard remains active');
      closureConfirmed=true;
    }catch(error){
      if(primary)primary.cleanupFailure=error;else primary=error;
    }
  }
  if(primary){primary.fixtureRoot=root;primary.fixtureClosureConfirmed=closureConfirmed;throw primary;}
  return {closed:true,released:true};
}
module.exports={runOwnedActor,bounded,EXECUTION_BUDGET_MS,CLEANUP_BUDGET_MS,CLOSURE_PREFIX};
if(require.main===module){
  const [entry,root,python,script,...args]=process.argv.slice(2);
  const receipt=closed=>console.error(CLOSURE_PREFIX+JSON.stringify({schema:'nora-fixture-closure/1',root,closed}));
  runOwnedActor({entry,root,python,script,args}).then(()=>receipt(true)).catch(error=>{
    console.error(error);
    receipt(error.fixtureClosureConfirmed===true);
    // On an unconfirmed close the original root is never removed by this helper.
    // Return a finite failure even if a disconnected native guard needs inspection.
    if(error.fixtureClosureConfirmed===false)process.exit(1);else process.exitCode=1;
  });
}
