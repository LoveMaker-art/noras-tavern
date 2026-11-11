// Execute the updater actually shipped in the core archive against sealed metadata.
// No desktop executable and no remote request is involved in this gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {targets,digest,checkedFile,json} from './core-assets.mjs';
import {buildCommand} from './build-commands.mjs';
import {verifyLegacyConsumers} from './legacy-core-consumer.mjs';

async function consume({plan,release}) {
 assert.ok(plan?.objects&&release,'Final consumer requires a sealed core distribution');
 assert.ok(!plan.coreAnchor,'Final consumer rejects desktop-only publications');
 const assets=new Map(plan.objects.filter(o=>o.phase==='asset').map(o=>[path.basename(o.key),o]));
 const productObject=assets.get('release-manifest.json');assert.ok(productObject,'Final consumer requires core acceptance artifacts');
 checkedFile(productObject.file,productObject);const product=json(productObject.file);
 assert.equal(product.commit,plan.commit);assert.equal(product.candidate,false);assert.equal(product.dirty,false);
 const archive=assets.get(product.archives.ops.name);assert.ok(archive,'Final consumer requires the shipped core updater');checkedFile(archive.file,product.archives.ops);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-core-consumer-'));
 const require=createRequire(import.meta.url);
 try {
  const tar=args=>{const invocation=buildCommand('tar',args);return execFileSync(invocation.command,invocation.args,{encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});};
  const members=tar(['-tzf',archive.file]).trimEnd().split(/\r?\n/),types=tar(['-tvzf',archive.file]).trimEnd().split(/\r?\n/);
  assert.equal(members.length,types.length);assert.ok(types.every(line=>line.startsWith('-')),'Core archive has nonregular members');
  assert.equal(new Set(members).size,members.length);
  for(const name of members)assert.ok(name.startsWith('ops/')&&!/[\\:\0\r\n]/.test(name)&&!name.split('/').some(p=>!p||p==='..'||p==='.')&&product.artifacts[name],'Unsafe/undeclared core archive member');
  tar(['-xzf',archive.file,'-C',directory]);
  for(const name of members)assert.equal(digest(fs.readFileSync(path.join(directory,name))),product.artifacts[name],'Shipped updater bytes differ');
  const desktop=path.join(directory,'ops/installer/desktop');
  fs.symlinkSync(path.join(directory,'ops/updater/actor-dependencies/node_modules'),path.join(desktop,'node_modules'),process.platform==='win32'?'junction':'dir');
  const consumer=require(path.join(desktop,'releases.js')),sources=require(path.join(desktop,'release-sources.js'));
  const api=`https://api.github.com/repos/${plan.repository}/releases`,betaUrl=sources.releaseListUrl();
  const primary=sources.sourceCandidates(plan.channel==='stable'?api+'/latest':betaUrl,{channel:plan.channel})[0];
  assert.ok(plan.destinations.includes(primary.provider||primary.id),'Shipped primary is absent from publication destinations');
  const physical=new Map(),catalogues=new Map();
  for(const [name,object]of assets)for(const candidate of sources.sourceCandidates(`https://github.com/${plan.repository}/releases/download/${plan.tag}/${name}`,{channel:plan.channel})){
   assert.ok(!physical.has(candidate.url)||physical.get(candidate.url)===object,'Conflicting core mapping');physical.set(candidate.url,object);
  }
  for(const [logical,list]of [[api+`/tags/${plan.tag}`,false],...(plan.channel==='stable'?[[api+'/latest',false]]:[[betaUrl,true]])])
   for(const candidate of sources.sourceCandidates(logical,{channel:plan.channel}))catalogues.set(candidate.url,list);
  const calls=[];
  const fetcher=async address=>{
   const url=String(address);let bytes;
   if(catalogues.has(url))bytes=Buffer.from(JSON.stringify(catalogues.get(url)?[release]:release));
   else{const object=physical.get(url);assert.ok(object,'Final consumer requested an unsealed resource: '+url);checkedFile(object.file,object);bytes=fs.readFileSync(object.file);}
   calls.push({url,sha256:digest(bytes)});const response=new Response(bytes);Object.defineProperty(response,'url',{value:url});return response;
  };
  const componentOnly=plan.mode==='components';
  const report={schema:'nora-core-final-consumer/1',commit:plan.commit,tag:plan.tag,scope:componentOnly?'actual-shipped-core-update-selector-sealed-metadata':'actual-shipped-core-selector-sealed-metadata',platforms:{}};
  for(const target of targets){const [platform,arch]=target.split('-'),modes={};
   for(const mode of componentOnly?['update']:['install','update']){
    const options={mode,tag:plan.tag,platform,arch,channel:plan.channel,client:'updater',updaterCapabilities:consumer.UPDATER_CAPABILITIES};
    const selected=await consumer.selectPlan({...options,fetcher,networkPolicy:{attempts:1,maxAttempts:1,totalBudgetMs:5000,attemptTimeoutMs:2000}});
    assert.equal(selected.commit,plan.commit);consumer.validatePlan(selected,options);
    const expected=assets.get(mode==='install'?selected.systemManifest.files['release-manifest.json'].asset:'release-manifest.json');
    assert.ok(expected);assert.equal(digest(Buffer.from(selected.releaseManifestText)),expected.sha256,'Core selected different metadata');
    modes[mode]={planValidated:true,manifestSha256:expected.sha256};
   }report.platforms[target]=modes;
  }return {...report,requests:calls,legacyApp:await verifyLegacyConsumers({plan,release})};
 } finally {for(const name of Object.keys(require.cache))if(name.startsWith(directory+path.sep))delete require.cache[name];fs.rmSync(directory,{recursive:true,force:true});}
}
export async function verifyFinalConsumers(publication) {
 try{return JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--consume'],{input:JSON.stringify({plan:publication.plan,release:publication.release}),encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['pipe','pipe','pipe']}));}
 catch(error){throw new Error('Final consumer acceptance failed: '+(error.stderr?.trim()||error.message),{cause:error});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.deepEqual(process.argv.slice(2),['--consume']);try{console.log(JSON.stringify(await consume(JSON.parse(fs.readFileSync(0,'utf8')))));}catch(error){process.stderr.write(error.message);process.exitCode=1;}
}
