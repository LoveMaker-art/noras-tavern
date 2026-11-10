import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {targets,files,digest,json,nativeChecks,qualificationChecks,verifyCoreDirectory} from '../tooling/release/core-assets.mjs';
import {assembleCore,verifyBatch} from '../tooling/release/assemble-core.mjs';
import {prepareDistribution,assertRemoteTag} from '../tooling/release/publish-release.mjs';
import {deliveryAsset,pinPath,declareLegacyApp,assertLegacyAppHead,verifyLegacyDelivery} from '../tooling/release/legacy-app-delivery.mjs';
import {prepareRuntime} from '../tooling/runtime/runtime-inputs.mjs';

// Synthetic byte-closure fixtures. These do not establish native installation acceptance.
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'core-publication-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const incoming=path.join(root,'incoming'),output=path.join(root,'batch'),commit='a'.repeat(40);fs.mkdirSync(incoming);
 const legacyCache=path.join(root,'legacy-cache');fs.mkdirSync(legacyCache);
 const original=Buffer.from(JSON.stringify({commit:'b'.repeat(40),launcherVersion:'0.1.1',candidate:false,dirty:false}));
 const contents={'release-manifest.json':original};
 for(const target of targets){const name=`Nora-Tavern-Launcher-0.1.1-${target}-update.zip`,bytes=Buffer.from('synthetic unchanged APP '+target),[platform,arch]=target.split('-');contents[name]=bytes;contents[`nora-launcher-${target}.json`]=Buffer.from(JSON.stringify({schema:'nora-launcher/v1',version:'0.1.1',commit:'b'.repeat(40),candidate:false,platform,arch,asset:name,size:bytes.length,sha256:digest(bytes)}));}
 const pin={schema:'nora-legacy-app-delivery/1',origin:{repository:'LoveMaker-art/noras-tavern',tag:'v2.6.5',commit:'b'.repeat(40)},version:'0.1.1',assets:Object.fromEntries(Object.entries(contents).map(([name,bytes])=>[name,{size:bytes.length,sha256:digest(bytes),url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.6.5/${name}`}]))};
 const pinBytes=Buffer.from(JSON.stringify(pin)+'\n');for(const [name,bytes]of Object.entries(contents))fs.writeFileSync(path.join(legacyCache,name),bytes);
 fs.mkdirSync(path.join(root,'tooling/release'),{recursive:true});fs.writeFileSync(path.join(root,pinPath),pinBytes);
 for(const target of targets){const directory=path.join(incoming,'core-'+target),assets=path.join(directory,'assets'),systemAssets=path.join(assets,'system-assets');fs.mkdirSync(systemAssets,{recursive:true});
  const archives={};for(const part of ['app','ops','nora-mcp']){const name=`nora-tavern-${part}.tar.gz`,bytes=Buffer.from('synthetic '+part);fs.writeFileSync(path.join(assets,name),bytes);archives[part]={name,size:bytes.length,sha256:digest(bytes)};}
  const product={schema:'tavern-release/v2',commit,candidate:false,dirty:false,versions:{tavern:'2.7.0'},launcherVersion:pin.version,legacyAppDelivery:{asset:deliveryAsset,size:pinBytes.length,sha256:digest(pinBytes),version:pin.version,origin:pin.origin},updateCompatibility:{launcherVersions:[pin.version]},sourceFiles:{'core.js':'f'.repeat(64),[pinPath]:digest(pinBytes)},externalInputs:{maintenance:{sha256:'b'.repeat(64)}},artifacts:{},archives,modules:{}};
  fs.writeFileSync(path.join(assets,deliveryAsset),pinBytes);
  const bytes=Buffer.from(JSON.stringify(product)+'\n');fs.writeFileSync(path.join(assets,'release-manifest.json'),bytes);
  const name=`${target}-release-manifest.json`;fs.writeFileSync(path.join(systemAssets,name),bytes);
  const [platform,arch]=target.split('-');fs.writeFileSync(path.join(systemAssets,`nora-system-${target}.json`),JSON.stringify({schema:'nora-system/v1',platform,arch,commit,launcherVersion:pin.version,version:'2.7.0',candidate:false,files:{'release-manifest.json':{asset:name,size:bytes.length,sha256:digest(bytes)}}}));
  const receipt={schema:'nora-core-platform-acceptance/1',commit,target,qualified:true,sourceGate:{checks:qualificationChecks.map(name=>({name,status:0,signal:null,error:null})),sourceDigest:'c'.repeat(64)},inputs:{maintenance:'d'.repeat(64),runtime:'e'.repeat(64)},native:{checks:nativeChecks,actorGatePassed:true,manifestSha256:digest(bytes)},files:files(assets)};
  fs.writeFileSync(path.join(directory,'acceptance.json'),JSON.stringify(receipt));
 }
 return {root,incoming,output,commit,legacyCache,pin,assemble:()=>assembleCore({incoming,output,commit,legacyCache})};
}
test('core batch assembles accepted bytes and advertises only its core stable channel',async t=>{
 const f=fixture(t);f.assemble();const before=files(f.output);verifyBatch(f.output,{commit:f.commit});
 const distribution=await prepareDistribution({root:f.output,output:path.join(f.root,'state/discovery'),tag:'v2.7.0',commit:f.commit});
 assert.deepEqual(distribution.plan.objects.filter(o=>o.phase==='channel').map(o=>o.key),['channels/stable.json']);
 assert.equal(distribution.release.assets.filter(a=>a.name.includes('Launcher')).length,3);assert.equal(distribution.release.assets.some(a=>/\.(exe|dmg|asar)$/.test(a.name)),false);assert.deepEqual(files(f.output),before,'Sealing must not rewrite accepted assets');
});
test('missing platform, failed native outcome, missing backup gate or changed fixed input cannot assemble',async t=>{
 for(const kind of ['missing','native','backup','input','bytes','source'])await t.test(kind,child=>{
  const f=fixture(child),directory=path.join(f.incoming,'core-win32-x64'),file=path.join(directory,'acceptance.json'),proof=json(file);
  if(kind==='missing')fs.rmSync(directory,{recursive:true});
  if(kind==='native')proof.native.checks.stop='unknown';
  if(kind==='backup')proof.sourceGate.checks.shift();
  if(kind==='input')proof.inputs.maintenance='1'.repeat(64);
  if(kind==='bytes')fs.appendFileSync(path.join(directory,'assets/nora-tavern-ops.tar.gz'),'changed');
  if(kind==='source')proof.commit='1'.repeat(40);
  if(kind!=='missing')fs.writeFileSync(file,JSON.stringify(proof));
  assert.throws(f.assemble);assert.equal(fs.existsSync(f.output),false);
 });
});
test('tampered sealed bytes, platform metadata, receipt or publication identity are refused',async t=>{
 for(const kind of ['bytes','receipt','metadata','commit','tag'])await t.test(kind,async child=>{
  const f=fixture(child);f.assemble();
  if(kind==='bytes')fs.appendFileSync(path.join(f.output,'nora-tavern-app.tar.gz'),'changed');
  if(kind==='metadata')fs.appendFileSync(path.join(f.output,'nora-system-win32-x64.json'),'changed');
  if(kind==='receipt'){const file=path.join(f.output,'core-batch-acceptance.json'),proof=json(file);proof.targets['win32-x64'].native.checks.stop='unknown';fs.writeFileSync(file,JSON.stringify(proof));}
  await assert.rejects(prepareDistribution({root:f.output,output:path.join(f.root,'discovery'),commit:kind==='commit'?'f'.repeat(40):f.commit,tag:kind==='tag'?'v2.8.0':'v2.7.0'}));
 });
});
test('remote tag resolution peels annotated tags and refuses mismatched source before upload',async()=>{
 const calls=[],commit='a'.repeat(40),execute=async(_program,args)=>{calls.push(args);return JSON.stringify({object:calls.length===1?{type:'tag',sha:'b'.repeat(40)}:{type:'commit',sha:commit}});};
 await assertRemoteTag('v2.7.0',commit,{execute});assert.equal(calls.length,2);assert.ok(calls.every(args=>args[0]==='api'&&!args.includes('POST')));
 await assert.rejects(assertRemoteTag('v2.7.0','c'.repeat(40),{execute:async()=>JSON.stringify({object:{type:'commit',sha:commit}})}),/no upload/);
});
test('runtime fetch is pinned, bounded and has no latest or adjacent-source fallback',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'core-runtime-pin-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));fs.mkdirSync(path.join(directory,'tooling/runtime'),{recursive:true});
 const target='win32-x64',origin={repository:'owner/core',tag:'v1.0.0',commit:'a'.repeat(40)},archive=Buffer.from('synthetic runtime'),manifest=Buffer.from(JSON.stringify({platform:'win32',arch:'x64',archive:'runtime.zip',sha256:digest(archive),size:archive.length}));
 const entries=Object.fromEntries([['nora-hermes-runtime.json',manifest],['runtime.zip',archive]].map(([name,bytes])=>[target+'-'+name,{size:bytes.length,sha256:digest(bytes),url:`https://github.com/owner/core/releases/download/v1.0.0/${target}-${name}`} ]));
 fs.writeFileSync(path.join(directory,'tooling/runtime/runtime-inputs.lock.json'),JSON.stringify({schema:'nora-core-runtime-inputs/1',origin,platforms:{[target]:entries}}));
 await assert.rejects(prepareRuntime({directory,target,offline:true}),/absent/);
 const calls=[];const value=await prepareRuntime({directory,target,fetcher:async url=>{calls.push(url);return new Response(url.endsWith('.json')?manifest:archive);}});
 assert.equal(calls.length,2);assert.ok(calls.every(url=>url.includes('/v1.0.0/')));assert.equal(value.origin.commit,origin.commit);
 fs.appendFileSync(path.join(value.directory,'runtime.zip'),'changed');await assert.rejects(prepareRuntime({directory,target,offline:true}),/size|checksum/);
});

test('legacy delivery rejects each specific identity and compatibility mismatch',async t=>{
 const cases=[
  ['version',p=>{p.launcherVersion='0.0.1';},(e,pin)=>e.actual==='0.0.1'&&e.expected===pin.version],
  ['source pin',p=>{p.sourceFiles[pinPath]='0'.repeat(64);},e=>e.message.includes('Legacy pin is outside accepted source')],
  ['origin',p=>{p.legacyAppDelivery.origin.commit='f'.repeat(40);},(e,pin)=>e.actual?.commit==='f'.repeat(40)&&e.expected?.commit===pin.origin.commit],
  ['compatibility',p=>{p.updateCompatibility.launcherVersions=['0.0.1'];},e=>e.message.includes('Published APP is outside reviewed core compatibility')],
 ];
 for(const [name,change,reason]of cases)await t.test(name,child=>{
  const f=fixture(child);f.assemble();const product=json(path.join(f.output,'release-manifest.json'));
  assert.deepEqual(verifyLegacyDelivery(f.output,product,{complete:true}),f.pin);
  const changed=structuredClone(product);change(changed);
  assert.throws(()=>verifyLegacyDelivery(f.output,changed,{complete:true}),error=>reason(error,f.pin));
  assert.deepEqual(verifyLegacyDelivery(f.output,product,{complete:true}),f.pin,'Unchanged complete fixture remains valid');
 });
});
test('assembly refuses altered original ZIP bytes and the core validator rejects unpinned desktop assets',async t=>{
 await t.test('zip',child=>{
  const f=fixture(child);fs.appendFileSync(path.join(f.legacyCache,'Nora-Tavern-Launcher-0.1.1-win32-x64-update.zip'),'tampered');
  assert.throws(f.assemble,{message:'Input size differs: Nora-Tavern-Launcher-0.1.1-win32-x64-update.zip'});
  assert.equal(fs.existsSync(f.output),false);
 });
 await t.test('extra',child=>{
  const f=fixture(child);f.assemble();verifyCoreDirectory(f.output,{commit:f.commit});
  fs.writeFileSync(path.join(f.output,'Nora-Tavern-Launcher-extra.exe'),'forbidden');
  assert.throws(()=>verifyCoreDirectory(f.output,{commit:f.commit}),/Unpinned desktop asset in core publication/);
 });
});
test('APP metadata uses its own pinned version and source, independently from the maintenance minimum',t=>{
 const f=fixture(t),sourceFiles={[pinPath]:digest(fs.readFileSync(path.join(f.root,pinPath)))};
 const value=declareLegacyApp({commit:f.commit,sourceFiles,bootstrap:{minimumLauncherVersion:'0.1.0'}},f.root);
 assert.equal(value.identity.launcherVersion,'0.1.1');assert.equal(value.identity.legacyAppDelivery.origin.commit,'b'.repeat(40));assert.equal(value.identity.commit,f.commit);
 assert.throws(()=>declareLegacyApp({sourceFiles:{[pinPath]:'0'.repeat(64)}},f.root),/captured source/);
});
test('publication refuses a stale APP pin from either catalogue without performing writes',async t=>{
 for(const newer of ['none','primary','github','unavailable'])await t.test(newer,async child=>{
  const f=fixture(child);f.assemble();const product=json(path.join(f.output,'release-manifest.json')),api='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases',primary='https://example.invalid/channels/launcher-stable.json',calls=[];
  const manifests={old:JSON.stringify({schema:'tavern-release/v2',candidate:false,dirty:false,launcherVersion:'0.1.1'}),new:JSON.stringify({schema:'tavern-release/v2',candidate:false,dirty:false,launcherVersion:'0.1.2'})};
  const release=(kind)=>({tag_name:kind==='old'?'v2.6.5':'v2.6.6',draft:false,prerelease:false,assets:[{name:'nora-launcher-win32-x64.json'},{name:'release-manifest.json',size:Buffer.byteLength(manifests[kind]),digest:'sha256:'+digest(manifests[kind]),browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${kind==='old'?'v2.6.5':'v2.6.6'}/release-manifest.json`}]});
  const options={policy:{reader:{sourceCandidates:()=>[{id:'jihulab',url:primary}]}},fetcher:async(url,init)=>{calls.push(url);assert.equal(init.method,undefined);if(newer==='unavailable')return new Response('',{status:503});if(url===primary)return Response.json([release(newer==='primary'?'new':'old')]);if(url.startsWith(api))return Response.json([release(newer==='github'?'new':'old')]);return new Response(url.includes('/v2.6.6/')?manifests.new:manifests.old);}};
  if(newer==='none')assert.equal((await assertLegacyAppHead(product,options)).verified,true);else await assert.rejects(assertLegacyAppHead(product,options),/stale|Cannot verify/);
  assert.ok(calls.length>0);
 });
});
