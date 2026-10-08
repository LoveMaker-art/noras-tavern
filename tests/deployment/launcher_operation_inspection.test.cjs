const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {inspectExecutors,acquireInspected}=require('../installer/desktop/operation-inspection');
const session={operationId:'op',jobs:[{jobId:'one',pid:101},{jobId:'two',pid:102}]};

test('only a complete identity inspection can establish all recorded jobs are offline',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-inspection-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const script=path.join(root,'operation_control.py');fs.writeFileSync(script,'# fixture');
  const run=()=>({status:0,stdout:JSON.stringify({schema:'nora-executor-inspection/1',jobs:
    session.jobs.map(job=>({operationId:'op',jobId:job.jobId,state:'offline'}))})});
  assert.equal(inspectExecutors({sessions:[session],python:'/owned/python',script,run}).safe,true);
  const duplicate=()=>({status:0,stdout:JSON.stringify({schema:'nora-executor-inspection/1',jobs:
    [1,2].map(()=>({operationId:'op',jobId:'one',state:'offline'}))})});
  assert.equal(inspectExecutors({sessions:[session],python:'/owned/python',script,run:duplicate}).safe,false);
});

test('an inaccessible or still-present PID is preserved when no owned inspector is available',()=>{
  for(const run of [()=>({status:0,stdout:'101\n'}),()=>({status:1,stdout:'',error:new Error('denied')})])
    assert.equal(inspectExecutors({sessions:[session],platform:'darwin',run}).safe,false);
  assert.equal(inspectExecutors({sessions:[session],platform:'darwin',run:()=>({status:1,stdout:''})}).safe,true);
  assert.equal(inspectExecutors({sessions:[{operationId:'op',jobs:[{jobId:'gap'}]}],platform:'darwin',run:()=>({status:1,stdout:''})}).safe,false);
});

test('closed and failed-to-spawn actual jobs do not cause an orphan fence',()=>{
  assert.deepEqual(inspectExecutors({sessions:[{operationId:'op',jobs:[{jobId:'one',closedAt:'closed'},{jobId:'two',spawnFailedAt:'failed'}]}]}),{safe:true,jobs:[]});
});

test('an unreadable owner history releases the new lease and blocks mutation',async()=>{
  let released=0;
  const lock={acquire:async()=>({release:async()=>{released++;}}),probe:async()=>({errors:[{code:'malformed'}],sessions:[]})};
  await assert.rejects(acquireInspected({lock,directory:'/fixture',operationId:'op',ownerEpoch:2}),{code:'OPERATION_EXECUTOR_UNCONFIRMED'});
  assert.equal(released,1);
});
