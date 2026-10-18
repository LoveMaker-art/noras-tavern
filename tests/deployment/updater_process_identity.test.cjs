const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');

test('Linux birth parsing binds kernel start ticks and handles spaces and parentheses in process names',()=>{
  const {linuxCreationTime}=require('../installer/desktop/operation-delegate');
  const stat='123 (node ) worker) S '+Array(18).fill('0').join(' ')+' 12345 0 0';
  const boot='cpu 1 2 3\nbtime 1700000000\n';
  assert.equal(linuxCreationTime(123,stat,boot,100),1700000123.45);
  for(const [pid,processStat,bootStat,ticks] of [[124,stat,boot,100],[123,stat,'cpu 1 2 3',100],
    [123,stat,boot,0],[123,stat.replace('12345','NaN'),boot,100]])
    assert.throws(()=>linuxCreationTime(pid,processStat,bootStat,ticks),{code:'DELEGATION_IDENTITY_UNKNOWN'});
});

test('native executor birth identity agrees with the target OS process birth',async()=>{
  const identity=await require('../installer/desktop/operation-delegate').creationIdentity();
  const python=process.env.NORA_TEST_PYTHON||process.env.NORA_PYTHON||(process.platform==='win32'?'python':'python3');
  const actual=spawnSync(python,['-B','-c','import psutil,sys;print(psutil.Process(int(sys.argv[1])).create_time())',String(process.pid)],
    {encoding:'utf8',timeout:10000});
  assert.equal(actual.status,0,actual.stderr);assert.equal(identity.pid,process.pid);
  assert.ok(Math.abs(identity.creationTime-Number(actual.stdout.trim()))<=Math.max(identity.precisionSeconds,.001),JSON.stringify(identity));
});

test('real plain Node executor authenticates its OS birth with the native writer on every supported platform',{timeout:45000},async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-updater-birth-'))),directory=path.join(root,'installer');
  const delegate=path.resolve(__dirname,'../installer/desktop/operation-delegate.js'),script=path.join(root,'node-executor.cjs');
  fs.writeFileSync(script,"const gate=require("+JSON.stringify(delegate)+");(async()=>{const g=await gate.connect();g.assertActive();process.stdout.write(JSON.stringify({pid:process.pid,authenticated:g.active}));g.close();})().catch(e=>{console.error(e);process.exitCode=1;});");
  const lock=require('../installer/desktop/operation-lock'),lease=await lock.acquire({directory,operationId:randomUUID(),ownerEpoch:1});let child;
  try{
    child=lease.spawn(process.execPath,[script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},cwd:root,kind:'maintenance'});
    let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
    const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    child.stdin.end();const end=await closed;
    assert.equal(end.code,0,errors);assert.equal(end.signal,null,errors);
    const report=JSON.parse(output),saved=(await lease.snapshot()).jobs.find(job=>job.jobId===child.jobId);
    assert.equal(report.authenticated,true);assert.equal(saved.pid,report.pid);
    assert.equal(saved.delegation.identityStatus,'reported');assert.ok(saved.creationIdentity.creationTime>0);assert.ok(saved.closedAt);
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null)await lease.cancel({signal:'SIGKILL'});
    await lease.release();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
