const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const lock=require('../installer/desktop/operation-lock');
const run=promisify(execFile);
const script=path.resolve(__dirname,'../scripts/restore-launcher-runtime.cjs');
function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-ci-runtime-')));
  const artifacts=path.join(root,'artifacts'),home=path.join(root,'home');fs.mkdirSync(artifacts);fs.mkdirSync(home);
  fs.writeFileSync(path.join(artifacts,'runtime.tar.gz'),'corrupt archive');
  fs.writeFileSync(path.join(artifacts,'nora-hermes-runtime.json'),JSON.stringify({schema:1,platform:process.platform,arch:process.arch,
    archive:'runtime.tar.gz',format:'tar.gz',sha256:'0'.repeat(64),componentProbe:'nora-clawchat-check.py',
    components:{clawchat:{revision:'a'.repeat(40)},liveware:{sha256:'b'.repeat(64)},files:{}}}));
  return {root,artifacts,home};
}
test('baseline restoration uses a real authorized actor and does not print success before digest verification',{timeout:20000},async()=>{
  const f=fixture();
  try{
    await assert.rejects(run(process.execPath,[script,f.artifacts,f.home]),error=>{
      assert.equal(error.code,1);
      assert.doesNotMatch(error.stdout,/Restored verified/);
      assert.doesNotMatch(error.stdout+error.stderr,/DELEGATION_REQUIRED/);
      assert.match(error.stdout+error.stderr,/VERIFICATION_FAILED/);
      return true;
    });
    const operations=path.join(f.home,'installer/operations');
    const name=fs.readdirSync(operations).find(name=>/^[0-9a-f-]{36}$/.test(name));assert.ok(name);
    const operation=JSON.parse(fs.readFileSync(path.join(operations,name,'operation.json')));
    assert.equal(operation.state,'failed');
    const facts=await lock.probe({directory:path.join(f.home,'installer')});assert.equal(facts.busy,false);
    assert.equal(fs.existsSync(path.join(f.home,'hermes')),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('baseline restoration refuses a concurrent native writer without reporting success',{timeout:20000},async()=>{
  const f=fixture();let lease;
  try{
    lease=await lock.acquire({directory:path.join(f.home,'installer'),operationId:require('node:crypto').randomUUID(),ownerEpoch:1});
    await assert.rejects(run(process.execPath,[script,f.artifacts,f.home]),error=>{
      assert.equal(error.code,1);assert.doesNotMatch(error.stdout,/Restored verified/);
      assert.match(error.stderr,/Another operation/);return true;
    });
    assert.equal(fs.existsSync(path.join(f.home,'hermes')),false);
  }finally{await lease?.release();fs.rmSync(f.root,{recursive:true,force:true});}
});
