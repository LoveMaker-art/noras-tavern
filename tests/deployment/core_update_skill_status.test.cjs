const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');

test('real Python skill refuses an unverified raw terminal record without a query closure', async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'core-skill-status-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const f={home};
  const hermes = path.join(f.home, 'hermes');
  fs.mkdirSync(hermes);
  fs.writeFileSync(path.join(hermes, 'nora-instance.json'), JSON.stringify({ schema: 1,
    noraHome: f.home, hermesHome: hermes, installRoot: path.join(f.home, 'tavern'), port: 18899 }));
  const jobId=randomUUID(),operationId=randomUUID();
  const job=path.join(f.home,'installer/update-jobs',jobId),operation=path.join(f.home,'installer/operations',operationId);
  fs.mkdirSync(job,{recursive:true});fs.mkdirSync(operation,{recursive:true});
  fs.writeFileSync(path.join(job,'operation-ref.json'),JSON.stringify({operationId}));
  fs.writeFileSync(path.join(operation,'operation.json'),JSON.stringify({state:'succeeded',result:{version:'2.5.2'}}));
  const script = path.join(__dirname, '../skills/system/tavern-updater/scripts/update.py');
  const python = process.env.NORA_TEST_PYTHON || process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  let failure;
  try{await promisify(execFile)(python,['-B',script,'--status'],{env:{...process.env,HERMES_HOME:hermes},timeout:15000});}
  catch(error){failure=error;}
  assert.equal(failure?.code,1);
  const queried=JSON.parse(failure.stdout);
  assert.equal(queried.requestId,undefined,'without a verified reader the wrapper cannot claim which task it inspected');
  assert.equal(queried.status,'inspection-required');
  assert.equal(JSON.parse(fs.readFileSync(path.join(operation,'operation.json'))).state,'succeeded','read-only failure preserves the raw evidence');
  assert.equal(queried.settled,false);assert.equal(queried.operation,undefined);
});
