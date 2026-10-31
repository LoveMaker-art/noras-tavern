const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const runtime=require('../installer/desktop/releases');

test('core reference producer and consumer accept an explicitly bound target without a desktop OS whitelist',async()=>{
  const publisher=await import(pathToFileURL(path.resolve(__dirname,'../scripts/system-release.mjs')).href);
  for(const target of ['linux-x64','linux-arm64','freebsd-x64']){
    const product={publication:{schema:'nora-component-publication/1',tag:'v2.5.8'},versions:{tavern:'2.5.7'},
      coreRelease:{schema:'nora-core-reference/1',tag:'v2.5.7',commit:'a'.repeat(40),manifests:{
        [target]:{asset:target+'-release-manifest.json',sha256:'b'.repeat(64),size:123}}}};
    assert.equal(publisher.coreReleaseIdentity(product,target).manifests[target].sha256,'b'.repeat(64));
    const [platform,arch]=target.split('-');
    assert.equal(runtime.coreReference(product,platform,arch).sha256,'b'.repeat(64));
    assert.throws(()=>runtime.coreReference(product,'linux','missing'),/缺少/);
    const invalid=structuredClone(product);
    invalid.coreRelease.manifests['../outside']=invalid.coreRelease.manifests[target];
    assert.throws(()=>publisher.coreReleaseIdentity(invalid));
    assert.throws(()=>runtime.coreReference(invalid));
  }
});

test('headless fallback to an APP-only latest release downloads the original shared core without desktop resources',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-core-resource-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'tavern-updates'));
  fs.writeFileSync(path.join(directory,'tavern-updates/installed.json'),JSON.stringify({version:'2.4.2'}));
  const sentinel=path.join(directory,'chat.txt');fs.writeFileSync(sentinel,'original chat');
  const sha=body=>crypto.createHash('sha256').update(body).digest('hex');
  const core={schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.5.7'},
    updaterCapabilities:runtime.UPDATER_CAPABILITIES,bootstrap:{managedComponents:1,sha256:sha('updater'),minimumLauncherVersion:'99.0.0'},
    archives:{app:{name:'nora-tavern-app.tar.gz',sha256:sha('app'),size:3}}};
  const original={'release-manifest.json':JSON.stringify(core),'tavern-updater-bootstrap.py':'updater','nora-tavern-app.tar.gz':'app'};
  original.SHA256SUMS=Object.entries(original).map(([name,body])=>sha(body)+'  '+name).join('\n');
  const product={...core,commit:'b'.repeat(40),publication:{schema:'nora-component-publication/1',tag:'v2.5.8'},
    coreRelease:{schema:'nora-core-reference/1',tag:'v2.5.7',commit:core.commit,manifests:{
      'darwin-arm64':{asset:'darwin-arm64-release-manifest.json',sha256:sha(original['release-manifest.json']),size:Buffer.byteLength(original['release-manifest.json'])}}}};
  const published={'release-manifest.json':JSON.stringify(product)};
  const repo='LoveMaker-art/noras-tavern';
  const release=(tag,files)=>({tag_name:tag,draft:false,prerelease:false,assets:Object.entries(files).map(([name,body])=>({
    name,state:'uploaded',size:Buffer.byteLength(body),digest:'sha256:'+sha(body),browser_download_url:`https://github.com/${repo}/releases/download/${tag}/${name}`}))});
  const current=release('v2.5.8',published),anchor=release('v2.5.7',original),requests=[];
  const fetcher=async address=>{
    const url=String(address);requests.push(url);
    let body;
    if(url===`https://api.github.com/repos/${repo}/releases/latest`)body=JSON.stringify(current);
    else if(url===`https://api.github.com/repos/${repo}/releases/tags/v2.5.7`)body=JSON.stringify(anchor);
    else if(url.startsWith(`https://github.com/${repo}/releases/download/v2.5.8/`))body=published[url.split('/').at(-1)];
    else if(url.startsWith(`https://github.com/${repo}/releases/download/v2.5.7/`))body=original[url.split('/').at(-1)];
    assert.equal(typeof body,'string','unexpected resource '+url);
    const response=new Response(body);Object.defineProperty(response,'url',{value:url});return response;
  };
  const options={installRoot:directory,cacheRoot:path.join(directory,'cache'),client:'updater',
    updaterCapabilities:runtime.UPDATER_CAPABILITIES,platform:'linux',arch:'x64',fetcher,
    networkPolicy:{sources:{schema:1,primary:'github',mirrors:[]},maxAttempts:1,totalBudgetMs:3000}};
  const result=await runtime.check(options);
  assert.equal(result.state,'available');assert.equal(result.releasePlan.tag,'v2.5.7');
  const payload=await runtime.prepareUpdate({...options,selectedPlan:result.releasePlan,
    plan:async()=>({version:'2.5.7',archives:[{name:'nora-tavern-app.tar.gz',sha256:sha('app')}]})});
  assert.equal(fs.readFileSync(path.join(payload,'nora-tavern-app.tar.gz'),'utf8'),'app');
  assert.equal(requests.some(url=>/nora-system-|nora-launcher-|hermes-runtime/.test(url)),false);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'original chat');
  for(const invalid of [{...core,commit:'c'.repeat(40)},{...core,coreRelease:product.coreRelease}]){
    original['release-manifest.json']=JSON.stringify(invalid);
    Object.assign(anchor,release('v2.5.7',original));
    const rejected=await runtime.check(options);
    assert.equal(rejected.available,false,'an inconsistent/recursive core anchor must never be installable');
    assert.equal(rejected.installable,false);
    assert.equal(rejected.releasePlan,undefined);
    assert.equal(fs.readFileSync(sentinel,'utf8'),'original chat');
  }
});
