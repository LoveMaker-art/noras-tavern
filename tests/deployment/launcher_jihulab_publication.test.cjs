const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {snapshotBeforeTransfer}=require('../../tooling/release/publication-source.cjs');
const stateModule = () => import(pathToFileURL(path.resolve(__dirname, '../../tooling/release/publication-state.mjs')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function sealed(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-domestic-publication-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const root = path.join(directory, 'assets'), stateDir = path.join(directory, 'state');
  fs.mkdirSync(root); fs.mkdirSync(stateDir);
  const tag = 'v2.4.6', commit = 'a'.repeat(40), repository = 'LoveMaker-art/noras-tavern';
  const asset = Buffer.from('immutable distribution bytes');
  const release = {tag_name:tag, draft:false, prerelease:false, body:'Authored summary',
    published_at:'2026-10-13T00:00:00.000Z', assets:[{name:'asset.zip', state:'uploaded', size:asset.length,
      digest:'sha256:' + sha(asset), browser_download_url:`https://github.com/${repository}/releases/download/${tag}/asset.zip`}]};
  const objects = [
    ['asset', `releases/${tag}/asset.zip`, path.join(root, 'asset.zip'), asset],
    ['catalogue', `releases/${tag}/release.json`, path.join(stateDir, 'release.json'), Buffer.from(JSON.stringify(release))],
    ['channel', 'channels/stable.json', path.join(stateDir, 'stable.json'), Buffer.from(JSON.stringify(release))],
  ].map(([phase, key, file, bytes]) => {
    fs.writeFileSync(file, bytes); return {phase, key, file, size:bytes.length, sha256:sha(bytes)};
  });
  return (await stateModule()).sealPublication({release, plan:{tag, commit, mode:'components', channel:'stable', objects}},
    {root, stateDir, repository, destinations:['github', 'jihulab']});
}

test('domestic publication prepares immutable objects before promoting its channel after GitHub', async t => {
  const publication = await sealed(t), events = [];
  const provider = id => ({
    async begin() {},
    async inspect() { return 'missing'; },
    async upload(object) { assert.notEqual(object.phase, 'channel'); events.push(`${id}:upload:${object.phase}`); },
    async verify(object) { events.push(`${id}:verify:${object.phase}`); },
    async assertReady(p) {
      const expected = id === 'github' ? 1 : 2;
      assert.equal(Object.keys(p.state.sources[id].objects).length, expected);
    },
    async checkPromotion(p) { assert.ok(p.state.sources.github.ready && p.state.sources.jihulab.ready); },
    async promote() { events.push(`${id}:promote`); },
    async verifyPromotion() { events.push(`${id}:public-verify`); },
  });
  const result = await (await stateModule()).executePublication(publication, {stage:'all', log() {},
    providers:{github:provider('github'), jihulab:provider('jihulab')}, verifyConsumers:async () => ({scope:'state-machine-fixture'})});
  assert.equal(result.status, 'published');
  assert.ok(events.indexOf('jihulab:promote') > events.indexOf('github:public-verify'));
  assert.ok(events.indexOf('jihulab:promote') > events.indexOf('jihulab:verify:catalogue'));
});

test('a domestic preparation failure never promotes either source and keeps the sealed resume identity', async t => {
  const publication = await sealed(t), promoted = [];
  const provider = id => ({async begin() {}, async inspect() { return 'missing'; }, async upload() {},
    async verify() { if (id === 'jihulab') throw Error('public bytes differ'); }, async assertReady() {},
    async checkPromotion() {}, async promote() { promoted.push(id); }, async verifyPromotion() {}});
  const before = publication.state.planId;
  await assert.rejects((await stateModule()).executePublication(publication, {stage:'all', log() {},
    providers:{github:provider('github'), jihulab:provider('jihulab')}, verifyConsumers:async () => ({scope:'state-machine-fixture'})}),
    /preparation failed/);
  assert.deepEqual(promoted, []);
  assert.equal(publication.state.planId, before);
  const resumed = await (await stateModule()).loadPublication({root:publication.root, stateDir:publication.stateDir,
    expectedPlanId:before, destinations:['github', 'jihulab']});
  assert.equal(resumed.state.status, 'failed');
});

function inertProvider(overrides = {}) {
  return {async begin() {}, async inspect() {return 'matching';}, async upload() {}, async verify() {},
    async assertReady() {}, async checkPromotion() {}, async promote() {}, async verifyPromotion() {}, ...overrides};
}
const execute = async (publication, jihulab) => (await stateModule()).executePublication(publication,
  {stage:'prepare', log() {}, providers:{github:inertProvider(), jihulab}, verifyConsumers:async()=>({scope:'persistent-intent-fixture'})});

test('an extracted pre-transfer Jihu snapshot cannot write through the publication entry point',async t=>{
  const live=await sealed(t),snapshot=path.join(path.dirname(live.stateDir),'before-transfer');
  snapshotBeforeTransfer(live.stateDir,snapshot);
  const {loadPublication,executePublication}=await stateModule();let began=0;
  const providers={github:inertProvider({async begin(){began++;}}),jihulab:inertProvider({async begin(){began++;}})};
  for(const stage of ['prepare','promote','all']) {
    const restored=await loadPublication({root:live.root,stateDir:snapshot});
    await assert.rejects(executePublication(restored,{stage,providers,log(){},verifyConsumers:async()=>({scope:'checkpoint-fixture'})}),/pre-transfer.*Jihu|Jihu.*pre-transfer/i);
  }
  assert.equal(began,0,'reject before any provider can begin');
  const inspectable=await loadPublication({root:live.root,stateDir:snapshot});
  await executePublication(inspectable,{stage:'seal',log(){},verifyConsumers:async()=>({scope:'checkpoint-fixture'})});
  assert.equal(inspectable.state.checkpointKind,'before-transfer','a local seal cannot clear recovery uncertainty');
  const current=await loadPublication({root:live.root,stateDir:live.stateDir});
  await execute(current,inertProvider());assert.equal(current.state.status,'prepared');
});

test('an unknown Jihu PUT intent survives repeated state reloads and prevents a second upload', async t => {
  const publication=await sealed(t),asset=publication.plan.objects[0];let uploads=0;
  await assert.rejects(execute(publication,inertProvider({async inspect(){return 'missing';},async upload(object,p){
    p.recordJihuUploadIntent(object);uploads++;
    const saved=JSON.parse(fs.readFileSync(path.join(p.stateDir,'publication-state.json')));
    assert.deepEqual(saved.sources.jihulab.uploadIntents[object.key],{sha256:object.sha256,size:object.size,
      attemptedAt:saved.sources.jihulab.uploadIntents[object.key].attemptedAt});
    throw Error('PUT response lost');
  }})),/preparation failed/);
  const original=JSON.parse(fs.readFileSync(path.join(publication.stateDir,'publication-state.json'))).sources.jihulab.uploadIntents[asset.key];
  for(let attempt=0;attempt<2;attempt++) {
    const resumed=await (await stateModule()).loadPublication({root:publication.root,stateDir:publication.stateDir});
    await assert.rejects(execute(resumed,inertProvider({async inspect(){return 'missing';},async upload(){uploads++;}})),error=>
      error.errors?.some(failure=>/unresolved.*upload|upload.*intent/i.test(failure.message)));
    assert.deepEqual(resumed.state.sources.jihulab.uploadIntents[asset.key],original,'later failures must preserve the original unknown attempt');
  }
  assert.equal(uploads,1);
  const resumed=await (await stateModule()).loadPublication({root:publication.root,stateDir:publication.stateDir});
  await execute(resumed,inertProvider());
  assert.equal(resumed.state.sources.jihulab.uploadIntents[asset.key],undefined);
  assert.equal(resumed.state.sources.jihulab.objects[asset.key].sha256,asset.sha256);
});

test('a killed publisher leaves its pre-PUT intent durable and resume cannot re-PUT the missing key', async t => {
  const publication=await sealed(t),asset=publication.plan.objects[0];
  const moduleUrl=pathToFileURL(path.resolve(__dirname,'../../tooling/release/publication-state.mjs')).href;
  const code=`import {loadPublication,executePublication} from ${JSON.stringify(moduleUrl)};
    const p=await loadPublication(${JSON.stringify({root:publication.root,stateDir:publication.stateDir})});
    const noop={async begin(){},async inspect(){return 'matching';},async upload(){},async verify(){},async assertReady(){},async checkPromotion(){},async promote(){},async verifyPromotion(){}};
    await executePublication(p,{stage:'prepare',log(){},verifyConsumers:async()=>({scope:'killed-intent-fixture'}),providers:{github:noop,jihulab:{...noop,async inspect(){return 'missing';},async upload(object,p){p.recordJihuUploadIntent(object);process.stdout.write('intent durable\\n');await new Promise(()=>{setInterval(()=>{},1000);});}}}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));let output='',errors='';child.stderr.on('data',bytes=>{errors+=bytes;});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('child did not persist intent: '+errors));},3000);
    child.stdout.on('data',bytes=>{output+=bytes;if(output.includes('intent durable')){clearTimeout(timeout);resolve();}});
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',code=>{clearTimeout(timeout);if(!output.includes('intent durable'))reject(Error('child exited '+code+': '+errors));});
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  const resumed=await (await stateModule()).loadPublication({root:publication.root,stateDir:publication.stateDir});
  assert.ok(resumed.state.sources.jihulab.uploadIntents[asset.key]);let uploads=0;
  await assert.rejects(execute(resumed,inertProvider({async inspect(){return 'missing';},async upload(){uploads++;}})),/preparation failed/);
  assert.equal(uploads,0);
});

test('tampered Jihu upload intent identity is rejected before remote inspection',async t=>{
  for(const changes of [{sha256:'f'.repeat(64)},{size:1},{attemptedAt:'unknown'}])await t.test(JSON.stringify(changes),async child=>{
    const publication=await sealed(child),asset=publication.plan.objects[0],file=path.join(publication.stateDir,'publication-state.json');
    const saved=JSON.parse(fs.readFileSync(file));saved.sources.jihulab.uploadIntents={[asset.key]:{
      sha256:asset.sha256,size:asset.size,attemptedAt:'2026-10-13T00:00:00.000Z',...changes}};
    fs.writeFileSync(file,JSON.stringify(saved));
    await assert.rejects((await stateModule()).loadPublication({root:publication.root,stateDir:publication.stateDir}),/intent/i);
  });
});
