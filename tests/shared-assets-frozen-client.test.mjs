import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const frozenCommit='2b2e34c10348527fc8b30d2e73bd496106a7415c';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
function client(directory,commit) {
  fs.mkdirSync(directory,{recursive:true});
  const modules=process.env.NORA_TEST_DESKTOP_NODE_MODULES;
  const semver=modules?path.join(modules,'semver'):path.dirname(require.resolve('semver/package.json',{paths:[path.join(root,'app/engine/sillytavern')]}));
  fs.cpSync(semver,path.join(directory,'node_modules/semver'),{recursive:true});
  for(const source of ['deployment/update/releases.js',...['launcher-errors.js','telemetry-contract.json','release-network.js',
    'release-sources.js','release-sources.json','launcher-update.js'].map(name=>'launcher/desktop/'+name)]) {
    const bytes=commit?execFileSync('git',['show',`${commit}:${source}`],{cwd:root}):fs.readFileSync(path.join(root,source));
    fs.writeFileSync(path.join(directory,path.basename(source)),bytes);
  }
  if(commit) assert.equal(sha(fs.readFileSync(path.join(directory,'releases.js'))),'676e4c99ad76555355f324b2ccbc304baa52d00ebf922e28e3890c912b38f0c7');
  return {releases:require(path.join(directory,'releases.js')),launcher:require(path.join(directory,'launcher-update.js')),
    sourceCandidates:require(path.join(directory,'release-sources.js')).sourceCandidates};
}
function fixture(t) {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nora-frozen-211-shared-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const old=client(path.join(temporary,'old'),frozenCommit),current=client(path.join(temporary,'current'));
  const tag='v2.4.6',baseline='v2.4.5',commit='b'.repeat(40),zip='Nora-Tavern-Launcher-2.1.2-win32-x64-update.zip';
  const url=(name,version=tag)=>`https://github.com/LoveMaker-art/noras-tavern/releases/download/${version}/${name}`;
  const shared={'nora-tavern-module-changed.tar.gz':'sealed shared business bytes','hermes.tar.gz':'runtime','deps.tar.gz':'dependencies'};
  const files={'nora-tavern-app.tar.gz':'app','nora-tavern-ops.tar.gz':'ops','nora-tavern-nora-mcp.tar.gz':'mcp',
    'nora-tavern-first-install-bootstrap.py':'first bootstrap','first-install-manifest.json':'{}',
    'tavern-updater-bootstrap.py':'bootstrap','nora-hermes-runtime.json':'{}','nora-tavern-dependencies.json':'{}',[zip]:'actual downloaded ZIP fixture bytes'};
  const module={name:'nora-tavern-module-changed.tar.gz',sha256:sha(shared['nora-tavern-module-changed.tar.gz']),size:Buffer.byteLength(shared['nora-tavern-module-changed.tar.gz'])};
  const manifest={schema:'tavern-release/v2',candidate:false,commit,versions:{tavern:tag.slice(1)},launcherVersion:'2.1.2',
    launcherCapabilities:capabilities,bootstrap:{managedComponents:1,minimumLauncherVersion:'2.1.2',sha256:sha(files['tavern-updater-bootstrap.py'])},
    modules:{changed:module},archives:{}};
  files['release-manifest.json']=JSON.stringify(manifest);
  files.SHA256SUMS=Object.entries({...files,...shared}).map(([name,bytes])=>`${sha(bytes)}  ${name}\n`).join('');
  const system={schema:'nora-system/v1',candidate:false,channel:'stable',platform:'win32',arch:'x64',commit,
    version:tag.slice(1),launcherVersion:'2.1.2',minimumLauncherVersion:'2.1.2',launcherCapabilities:capabilities,
    files:Object.fromEntries(Object.entries({...files,'hermes.tar.gz':shared['hermes.tar.gz'],'deps.tar.gz':shared['deps.tar.gz']})
      .map(([name,bytes])=>[name,{asset:name,sha256:sha(bytes),size:Buffer.byteLength(bytes)}]))};
  files['nora-system-win32-x64.json']=JSON.stringify(system);
  files['nora-launcher-win32-x64.json']=JSON.stringify({schema:'nora-launcher/v1',candidate:false,platform:'win32',arch:'x64',version:'2.1.2',
    asset:zip,sha256:sha(files[zip]),size:Buffer.byteLength(files[zip])});
  const index={schema:'nora-release-assets/1',repository:'LoveMaker-art/noras-tavern',tag,commit,minimumLauncherVersion:'2.1.2',
    assets:Object.entries(shared).map(([name,bytes])=>({name,asset_release_tag:baseline,sha256:sha(bytes),size:Buffer.byteLength(bytes)}))};
  const release={tag_name:tag,draft:false,prerelease:false,assets:[]},requests=[],routes=new Map();
  const addRoute=(canonical,resource)=>{
    for(const reader of [old,current])for(const source of reader.sourceCandidates(canonical)) {
      if(routes.has(source.url))assert.deepEqual(routes.get(source.url),resource,'A physical fixture URL cannot alias two logical resources');
      routes.set(source.url,resource);
    }
  };
  const reseal=()=>{
    files['release-assets.json']=JSON.stringify(index);release.assets=Object.entries(files).map(([name,bytes])=>
      ({name,state:'uploaded',size:Buffer.byteLength(bytes),digest:`sha256:${sha(bytes)}`,browser_download_url:url(name)}));
    routes.clear();
    const api='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/';
    addRoute(api+'latest',{kind:'catalogue'});addRoute(api+'tags/'+tag,{kind:'catalogue'});
    for(const name of Object.keys(files))addRoute(url(name),{kind:'asset',tag,name});
    for(const name of Object.keys(shared))addRoute(url(name,baseline),{kind:'asset',tag:baseline,name});
  };
  reseal();
  const fetcher=async value=>{
    const address=String(value);requests.push(address);
    const resource=routes.get(address);assert.ok(resource,`Unplanned fixture resource ${address}`);
    const bytes=resource.kind==='catalogue'?JSON.stringify(release)
      :resource.tag===baseline?shared[resource.name]:files[resource.name];assert.notEqual(bytes,undefined);
    const response=new Response(bytes);Object.defineProperty(response,'url',{value:address});return response;
  };
  const operationDirectory=path.join(temporary,'installer','operations','65b02921-823c-48cd-bd57-3c5b55406bf8');fs.mkdirSync(operationDirectory,{recursive:true});
  const options={cacheRoot:path.join(temporary,'cache'),fetcher,platform:'win32',arch:'x64',channel:'stable',operationDirectory};
  return {temporary,old,current,tag,baseline,commit,zip,url,shared,files,manifest,module,index,release,requests,routes,reseal,options};
}

test('actual frozen 2.1.1 selects and downloads current bridge ZIP; new client resumes the identical sealed operation using refs',async t=>{
  const f=fixture(t),oldOptions={...f.options,launcherVersion:'2.1.1'};
  const plan=await f.old.releases.selectPlan(oldOptions);
  assert.equal(plan.release.assetIndexText,undefined);
  assert.ok(!plan.release.assets.some(item=>item.name===f.module.name));
  const sealed=f.old.releases.sealPlan(plan,{...oldOptions,assertOwner(){}});
  const original=JSON.stringify(sealed),operationDigest=sha(JSON.stringify({releasePlan:sealed}));
  const prepared=await f.old.launcher.prepare({...oldOptions,selectedPlan:sealed});
  assert.equal(fs.readFileSync(prepared.launcher.archive,'utf8'),f.files[f.zip]);
  assert.equal(prepared.releasePlan.planId,sealed.planId);
  const handoffRequests=f.requests.length,events=[];
  const newRoot=await f.current.releases.prepareUpdate({...f.options,launcherVersion:'2.1.2',selectedPlan:sealed,
    onEvent:event=>events.push(event),plan:async()=>({version:f.tag,archives:[f.module]})});
  assert.equal(fs.readFileSync(path.join(newRoot,f.module.name),'utf8'),f.shared[f.module.name]);
  assert.equal(fs.readFileSync(path.join(newRoot,'release-manifest.json'),'utf8'),plan.releaseManifestText);
  assert.equal(JSON.stringify(sealed),original);
  assert.equal(sha(JSON.stringify({releasePlan:sealed})),operationDigest);
  const primary=f.current.sourceCandidates(`https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/${f.tag}`)[0];
  assert.equal(primary.provider,'jihulab');
  const resumedRequests=f.requests.slice(handoffRequests);
  assert.deepEqual(resumedRequests.filter(url=>f.routes.get(url).kind==='catalogue'),[primary.url]);
  assert.equal(resumedRequests[0],primary.url);
  assert.ok(resumedRequests.every(url=>new URL(url).origin===new URL(primary.url).origin),'A healthy current primary must serve the fixed handoff');
  assert.ok(events.some(event=>event.event==='log'&&event.line.includes(sealed.planId)&&event.line.includes(sha(f.files['release-assets.json']))));
});

test('actual frozen 2.1.1 rejects old-tag URL and cannot cold-install a shared environment',async t=>{
  const f=fixture(t);
  assert.throws(()=>f.old.releases.assetUrl({tag_name:f.tag,assets:[{name:'hermes.tar.gz',browser_download_url:f.url('hermes.tar.gz',f.baseline)}]},'hermes.tar.gz'),/缺少完整组件/);
  await assert.rejects(f.old.releases.selectPlan({...f.options,mode:'install',launcherVersion:'2.1.1'}),/缺少完整组件/);
  assert.ok(!f.requests.some(url=>url.endsWith('/hermes.tar.gz')));
});

test('old sealed handoff cannot change physical catalogue, original commit, minimum or consumed ref byte contract',async t=>{
  const rejected=[],expected=[];
  for(const [name,change,reason] of [
    ['physical catalogue',f=>{f.files['unexpected.json']='{}';f.reseal();},'原固定发布的物理资产集合已变化，未重新选择目标。'],
    ['original commit',f=>{f.index.commit='c'.repeat(40);f.reseal();},'共享索引与原固定发布的提交或兼容门槛不符。'],
    ['minimum launcher',f=>{f.index.minimumLauncherVersion='2.1.3';f.reseal();},'共享索引与原固定发布的提交或兼容门槛不符。'],
    ['reference size',f=>{f.index.assets[0].size++;f.reseal();},'共享资产引用与组件校验信息不一致。'],
    ['reference SHA',f=>{f.index.assets[0].sha256='c'.repeat(64);f.reseal();},'共享资产引用与组件校验信息不一致。']]) {
    const f=fixture(t),plan=await f.old.releases.selectPlan({...f.options,launcherVersion:'2.1.1'});
    const sealed=f.old.releases.sealPlan(plan,{...f.options,launcherVersion:'2.1.1',assertOwner(){}}),original=JSON.stringify(sealed);
    const operationDigest=sha(JSON.stringify({releasePlan:sealed}));
    change(f);f.requests.length=0;
    await assert.rejects(f.current.releases.prepareUpdate({...f.options,launcherVersion:'2.1.2',selectedPlan:sealed,
      plan:async()=>{assert.fail('Invalid hydration must stop before updater execution');}}),error=>{
      const failure={case:name,reason:error.message,requests:[...f.requests]};
      t.diagnostic(JSON.stringify({...failure,code:error.code||null}));rejected.push(failure);return true;
    });
    expected.push({case:name,reason,requests:[
      f.current.sourceCandidates(`https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/${f.tag}`)[0].url,
      f.current.sourceCandidates(f.url('release-assets.json'))[0].url]});
    assert.equal(JSON.stringify(sealed),original);
    assert.equal(sha(JSON.stringify({releasePlan:sealed})),operationDigest);
    assert.ok(!f.requests.some(url=>url.endsWith('.tar.gz')));
  }
  assert.deepEqual(rejected,expected,'Every refusal must reach its fixed-tag hydration check after reading the catalogue and verified index');
});
