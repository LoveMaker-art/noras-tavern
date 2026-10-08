// Test-only bridge into the real native lease. All fixture writers must ACK and
// actually close; this does not replace OperationController workflow acceptance.
const path=require('node:path');
const {once}=require('node:events');
const {randomUUID}=require('node:crypto');
const [entry,root,python,script,...args]=process.argv.slice(2);
(async()=>{
  if(![entry,root,python,script].every(value=>value&&path.isAbsolute(value)))throw new Error('Pass absolute fixture actor paths');
  const lease=await require(entry).acquire({directory:path.join(root,'installer'),operationId:randomUUID(),ownerEpoch:1});
  try{
    const child=lease.spawn(python,['-B',script,...args],{kind:'python-maintenance',venvHome:process.env.NORA_TEST_VENV_HOME,env:process.env});
    process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
    const [code]=await once(child,'close');
    const jobs=(await lease.snapshot()).jobs;
    if(!jobs.length||!jobs.every(job=>job.closedAt&&job.delegation?.identityStatus==='reported'))throw new Error('Fixture writer was not acknowledged and closed');
    process.exitCode=code===0?0:1;
  }finally{await lease.release();}
})().catch(error=>{console.error(error);process.exitCode=1;});
