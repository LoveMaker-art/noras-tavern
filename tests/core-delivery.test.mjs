import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {targets,files,digest,json,nativeChecks,qualificationChecks} from '../tooling/release/core-assets.mjs';
import {assembleCore,verifyBatch} from '../tooling/release/assemble-core.mjs';
import {prepareDistribution,assertRemoteTag} from '../tooling/release/publish-release.mjs';
import {prepareRuntime} from '../tooling/runtime/runtime-inputs.mjs';

// Synthetic byte-closure fixtures. These do not establish native installation acceptance.
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'core-publication-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const incoming=path.join(root,'incoming'),output=path.join(root,'batch'),commit='a'.repeat(40);fs.mkdirSync(incoming);
 for(const target of targets){const directory=path.join(incoming,'core-'+target),assets=path.join(directory,'assets'),systemAssets=path.join(assets,'system-assets');fs.mkdirSync(systemAssets,{recursive:true});
  const archives={};for(const part of ['app','ops','nora-mcp']){const name=`nora-tavern-${part}.tar.gz`,bytes=Buffer.from('synthetic '+part);fs.writeFileSync(path.join(assets,name),bytes);archives[part]={name,size:bytes.length,sha256:digest(bytes)};}
  const product={schema:'tavern-release/v2',commit,candidate:false,dirty:false,versions:{tavern:'2.7.0'},sourceFiles:{'core.js':'f'.repeat(64)},externalInputs:{maintenance:{sha256:'b'.repeat(64)}},artifacts:{},archives,modules:{}};
  const bytes=Buffer.from(JSON.stringify(product)+'\n');fs.writeFileSync(path.join(assets,'release-manifest.json'),bytes);
  const name=`${target}-release-manifest.json`;fs.writeFileSync(path.join(systemAssets,name),bytes);
  const [platform,arch]=target.split('-');fs.writeFileSync(path.join(systemAssets,`nora-system-${target}.json`),JSON.stringify({schema:'nora-system/v1',platform,arch,commit,version:'2.7.0',candidate:false,files:{'release-manifest.json':{asset:name,size:bytes.length,sha256:digest(bytes)}}}));
  const receipt={schema:'nora-core-platform-acceptance/1',commit,target,qualified:true,sourceGate:{checks:qualificationChecks.map(name=>({name,status:0,signal:null,error:null})),sourceDigest:'c'.repeat(64)},inputs:{maintenance:'d'.repeat(64),runtime:'e'.repeat(64)},native:{checks:nativeChecks,actorGatePassed:true,manifestSha256:digest(bytes)},files:files(assets)};
  fs.writeFileSync(path.join(directory,'acceptance.json'),JSON.stringify(receipt));
 }
 return {root,incoming,output,commit,assemble:()=>assembleCore({incoming,output,commit})};
}
test('core batch assembles accepted bytes and advertises only its core stable channel',async t=>{
 const f=fixture(t);f.assemble();const before=files(f.output);verifyBatch(f.output,{commit:f.commit});
 const distribution=await prepareDistribution({root:f.output,output:path.join(f.root,'state/discovery'),tag:'v2.7.0',commit:f.commit});
 assert.deepEqual(distribution.plan.objects.filter(o=>o.phase==='channel').map(o=>o.key),['channels/stable.json']);
 assert.ok(distribution.release.assets.every(a=>!a.name.includes('Launcher')));assert.deepEqual(files(f.output),before,'Sealing must not rewrite accepted assets');
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
