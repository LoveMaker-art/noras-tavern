const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const sequence=require('../installer/desktop/update-sequence');
const capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
function fixture(t,{appFirst=false}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-update-sequence-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const compatibility={schema:'nora-core-launcher-compatibility/1',coreVersion:'2.5.2',launcherVersions:['2.2.3',...(appFirst?[]:['2.2.2'])],
    ...(appFirst?{previousCoreVersions:['2.4.2']} : {}),capabilities};
  const plan={planId:'validated-plan',mode:'update',tag:'v2.5.3',commit:'a'.repeat(40),
    releaseManifest:{versions:{tavern:'2.5.2'},launcherVersion:'2.2.3',updateCompatibility:compatibility},launcherManifest:{version:'2.2.3'}};
  const validatePlan=value=>{assert.equal(value.planId,plan.planId);return value;};
  const options={plan,before:{core:'2.4.2',launcher:'2.2.2',coreCommit:'b'.repeat(40),coreManifestSha256:'c'.repeat(64)},validatePlan,capabilities};
  return {home,plan,options,create:()=>sequence.create(home,options),load:()=>sequence.load(home,options)};
}
test('immutable request is flushed through its exclusive write handle before the pointer is published',t=>{
  const f=fixture(t),handles=new Map(),flushed=[];
  const adapter=Object.create(fs);
  adapter.openSync=(file,flags,...args)=>{const fd=fs.openSync(file,flags,...args);handles.set(fd,flags);return fd;};
  adapter.closeSync=fd=>{handles.delete(fd);return fs.closeSync(fd);};
  adapter.fsyncSync=fd=>{
    if(fs.fstatSync(fd).isFile()){
      const flags=handles.get(fd);
      if(flags==='r')throw Object.assign(new Error('Windows FlushFileBuffers requires write access'),{code:'EPERM'});
      assert.equal(flags,'wx');flushed.push(flags);
    }
    return fs.fsyncSync(fd);
  };
  const file=require.resolve('../installer/desktop/update-sequence'),nativeRequire=require('node:module').createRequire(file);
  const context={module:{exports:{}},process,require:name=>name==='node:fs'?adapter:nativeRequire(name)};
  require('node:vm').runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  const value=context.module.exports.create(f.home,f.options);
  assert.equal(flushed.length,2,'request and pointer were both flushed with write access');
  assert.equal(f.load().id,value.id);
});
function adapters(value,{failStep,unconfirmed=false}={}){
  const records={},calls=[],versions={core:value.before.core,launcher:value.before.launcher};
  const api={
    observe:async step=>records[step]||null,
    verifyStep:async(step,_value,record)=>{assert.equal(record.operation.state,'succeeded');},
    verifyCombination:async()=>({compatible:sequence.compatible(value.plan.releaseManifest,versions.core,versions.launcher,capabilities),
      current:{version:versions.core,launcherVersion:versions.launcher,systemReady:true}}),
    execute:async step=>{
      calls.push(step);
      const operation={operationId:randomUUID(),requestId:value.requests[step],state:failStep===step?'rolled-back':'succeeded'};
      if(failStep===step){
        records[step]={failed:true,settled:!unconfirmed,safe:!unconfirmed,operation,error:new Error('injected phase failure')};
        throw records[step].error;
      }
      versions[step]=step==='core'?value.plan.releaseManifest.versions.tavern:value.plan.launcherManifest.version;
      records[step]={succeeded:true,settled:true,safe:true,operation};
      return {systemReady:true};
    },
  };
  return {api,calls,records,versions,repair:()=>{failStep=null;unconfirmed=false;}};
}
for(const appFirst of [false,true])test(`one invocation completes both compatible phases (${appFirst?'APP':'core'} first)`,async t=>{
  const f=fixture(t,{appFirst}),value=f.create(),a=adapters(value);
  assert.deepEqual(value.order,appFirst?['launcher','core']:['core','launcher']);
  const result=await sequence.run(value,a.api);
  assert.equal(result.status,'succeeded');assert.deepEqual(a.calls,value.order);
  assert.equal(result.current.version,'2.5.2');assert.equal(result.current.launcherVersion,'2.2.3');
  assert.equal(fs.existsSync(path.join(f.home,'installer/update-sequences',value.id,'request.json')),true);
  assert.equal(fs.existsSync(path.join(f.home,'installer/update-sequences',value.id,'result.json')),false,'no duplicate canonical outcome');
  sequence.clear(f.home,value);assert.equal(f.load(),null);
});
for(const appFirst of [false,true])test(`compatible partial completion retries only the failed ${appFirst?'core':'APP'}`,async t=>{
  const f=fixture(t,{appFirst}),value=f.create(),failed=appFirst?'core':'launcher',a=adapters(value,{failStep:failed});
  const result=await sequence.run(value,a.api);
  assert.equal(result.status,'partial');assert.equal(result.failed,failed);assert.deepEqual(result.completed,[value.order[0]]);
  assert.equal(f.load().plan.tag,'v2.5.3');
  a.repair();const retry=await sequence.run(f.load(),a.api,{retry:true});
  assert.equal(retry.status,'succeeded');assert.deepEqual(a.calls,[value.order[0],failed,failed]);
});
test('reopen reads canonical partial failure without silently replaying it',async t=>{
  const f=fixture(t),value=f.create(),a=adapters(value,{failStep:'launcher'});
  await sequence.run(value,a.api);const before=a.calls.slice();
  const reopened=await sequence.run(f.load(),a.api);
  assert.equal(reopened.status,'partial');assert.deepEqual(a.calls,before);
});
test('an unfinished restore cannot become compatible partial success',async t=>{
  const f=fixture(t),value=f.create(),a=adapters(value,{failStep:'launcher',unconfirmed:true});
  await assert.rejects(sequence.run(value,a.api),{code:'UPDATE_RECOVERY_REQUIRED'});
  assert.ok(f.load());
});
test('unknown intermediate compatibility is rejected before publishing a request',t=>{
  const f=fixture(t);f.plan.releaseManifest.updateCompatibility.launcherVersions=['2.2.3'];
  assert.throws(f.create,{code:'RELEASE_COMPATIBILITY'});
  assert.equal(fs.existsSync(path.join(f.home,'installer/current-update-sequence.json')),false);
});
for(const change of ['protocol','core','new-app','duplicate','unknown-field'])test(`invalid compatibility ${change} cannot prepare two updates`,t=>{
  const f=fixture(t),value=f.plan.releaseManifest.updateCompatibility;
  if(change==='protocol')value.capabilities={...capabilities,executorProtocol:'unknown'};
  if(change==='core')value.coreVersion='2.5.3';
  if(change==='new-app')value.launcherVersions=['2.2.2'];
  if(change==='duplicate')value.launcherVersions.push('2.2.2');
  if(change==='unknown-field')value.force=true;
  assert.throws(f.create,{code:'RELEASE_COMPATIBILITY'});
});
test('interruption after a successful core phase resumes the fixed APP target',async t=>{
  const f=fixture(t),value=f.create(),a=adapters(value);
  await a.api.execute('core');
  const result=await sequence.run(f.load(),a.api);
  assert.equal(result.status,'succeeded');assert.deepEqual(a.calls,['core','launcher']);
});
test('APP handoff returns restarting without premature full success',async t=>{
  const f=fixture(t),value=f.create(),a=adapters(value),execute=a.api.execute;
  a.api.execute=async(step,...args)=>step==='launcher'?{restarting:true}:execute(step,...args);
  const result=await sequence.run(value,a.api);
  assert.deepEqual(result,{restarting:true});assert.ok(f.load());
});
test('a pending sequence cannot silently move to another publication',t=>{
  const f=fixture(t);f.create();
  assert.throws(()=>sequence.create(f.home,{...f.options,plan:{...f.plan,planId:'other-target'}}),{code:'UPDATE_SEQUENCE_PENDING'});
});
test('tampered stored requests and symlinked directories are preserved and refused',t=>{
  const f=fixture(t),value=f.create(),file=path.join(f.home,'installer/update-sequences',value.id,'request.json');
  const record=JSON.parse(fs.readFileSync(file));record.before.core='9.9.9';fs.writeFileSync(file,JSON.stringify(record));
  assert.throws(f.load,{code:'UPDATE_SEQUENCE_INVALID'});assert.equal(fs.existsSync(file),true);
});
test('a symlinked sequence parent is refused before writing through it',t=>{
  const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'nora-outside-sequence-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.mkdirSync(path.join(f.home,'installer'));fs.symlinkSync(outside,path.join(f.home,'installer/update-sequences'),process.platform==='win32'?'junction':'dir');
  assert.throws(f.create,{code:'UPDATE_SEQUENCE_INVALID'});assert.deepEqual(fs.readdirSync(outside),[]);
});
test('APP-first keeps a verified core entry available after the APP payload is removed',async t=>{
  const f=fixture(t,{appFirst:true}),bytes=Buffer.from('print("isolated fixed bootstrap")\n');
  const base='https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.5.3/';
  f.plan.release={tag_name:'v2.5.3',assets:['release-manifest.json','tavern-updater-bootstrap.py'].map(name=>({name,browser_download_url:base+name}))};
  f.plan.releaseManifest.bootstrap={sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')};
  f.plan.releaseManifestText=JSON.stringify(f.plan.releaseManifest);
  const value=f.create();let reads=0;
  const file=await sequence.prepareBootstrap(f.home,value,{fetcher:async url=>{
    assert.match(String(url),/\/v2\.5\.3\/tavern-updater-bootstrap\.py$/);reads++;
    const response=new Response(bytes);Object.defineProperty(response,'url',{value:String(url)});return response;
  }});
  assert.equal(fs.readFileSync(sequence.bootstrap(f.home,f.load()),'utf8'),bytes.toString());
  assert.equal(await sequence.prepareBootstrap(f.home,f.load(),{fetcher:()=>assert.fail('verified cache must be reused')}),file);
  assert.equal(reads,1);
  fs.appendFileSync(file,'# changed\n');assert.throws(()=>sequence.bootstrap(f.home,f.load()),{code:'UPDATE_SEQUENCE_INVALID'});
});
