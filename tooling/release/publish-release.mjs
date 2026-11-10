// Core publication only. Sealing is offline; prepare/promote are explicit writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyBatch} from './assemble-core.mjs';
import {fileDigest,sealPublication,loadPublication,executePublication} from './publication-state.mjs';
import {githubProvider,command} from './publication-providers.mjs';
import {jihulabProvider} from './jihulab-provider.mjs';
import {createJihuTransport} from './jihulab-transport.mjs';
import {buildOwnedJihuSource} from './release-policy.mjs';
import {releasePublicationTag} from './system-release.mjs';
import {assertLegacyAppHead} from './legacy-app-delivery.mjs';

export {buildOwnedJihuSource} from './release-policy.mjs';
const repository='LoveMaker-art/noras-tavern';
const destinations=['github','jihulab'];
export async function prepareDistribution({root,output,tag,commit,body='',publishedAt=new Date().toISOString()}={}) {
 root=path.resolve(root);output=path.resolve(output);const relative=path.relative(root,output);
 assert.ok(relative&&relative.startsWith('..'+path.sep),'Catalogue must be outside accepted assets');
 assert.ok(!fs.existsSync(output),'Preserve an existing sealed publication');
 const {product}=verifyBatch(root,{commit});assert.equal(product.commit,commit);
 assert.equal(tag,releasePublicationTag(product),'Publication tag differs from accepted core');
 assert.match(tag,/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
 assert.equal(tag,`v${product.versions.tavern}`,'Core tag must identify its actual version');
 assert.ok(Number.isFinite(Date.parse(publishedAt)));assert.equal(typeof body,'string');
 const channel=tag.includes('-beta.')?'beta':'stable',objects=[];
 for(const name of fs.readdirSync(root).sort()){
  assert.match(name,/^[A-Za-z0-9][A-Za-z0-9._-]*$/);assert.notEqual(name,'release.json');
  const file=path.join(root,name);objects.push({file,key:`releases/${tag}/${name}`,phase:'asset',...await fileDigest(file)});
 }
 const release={tag_name:tag,draft:false,prerelease:channel==='beta',body,published_at:publishedAt,assets:objects.map(o=>({name:path.basename(o.file),state:'uploaded',size:o.size,digest:`sha256:${o.sha256}`,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/${path.basename(o.file)}`}))};
 fs.mkdirSync(path.join(output,'releases',tag),{recursive:true});fs.mkdirSync(path.join(output,'channels'));
 for(const [key,value,phase]of [[`releases/${tag}/release.json`,release,'catalogue'],[`channels/${channel}.json`,channel==='beta'?[release]:release,'channel']]){
  const file=path.join(output,key);fs.writeFileSync(file,JSON.stringify(value)+'\n',{flag:'wx'});objects.push({file,key,phase,...await fileDigest(file)});
 }
 // This repository owns the core pointer; it never promotes launcher-stable.
 return {release,plan:{tag,commit,mode:'full',channel,objects}};
}
export async function assertRemoteTag(tag,commit,{execute=command}={}) {
 let object=JSON.parse(await execute('gh',['api',`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`],{capture:true,timeout:120000})).object;
 for(let hop=0;object?.type==='tag'&&hop<5;hop++){
  assert.match(object.sha,/^[a-f0-9]{40}$/);object=JSON.parse(await execute('gh',['api',`repos/${repository}/git/tags/${object.sha}`],{capture:true,timeout:120000})).object;
 }
 assert.ok(object?.type==='commit'&&object.sha===commit,'Remote tag differs from accepted core; no upload started');
}
export async function publishCore(options) {
 const {root,stateDir,tag,commit,sourceRun,stage='seal',resume=false,body=''}=options;
 assert.ok(['seal','prepare','promote','all'].includes(stage));verifyBatch(root,{commit});
 const publication=resume
  ?await loadPublication({root,stateDir,repository,tag,commit,sourceRun,destinations,expectedPlanId:options.planId})
  :await sealPublication(await prepareDistribution({root,output:path.join(stateDir,'discovery'),tag,commit,body}),{root,stateDir,repository,sourceRun,destinations});
 assert.deepEqual(publication.plan.destinations,destinations);
 assert.ok(!publication.plan.coreAnchor&&publication.plan.objects.filter(o=>o.phase==='channel').every(o=>o.key===`channels/${publication.plan.channel}.json`),'Core cannot write desktop channels');
 buildOwnedJihuSource(); // Fixed policy and publishing destinations must agree before any write.
 let providers;
 if(stage!=='seal'){
  await assertRemoteTag(tag,commit);
  await assertLegacyAppHead(verifyBatch(root,{commit}).product);
  const transport=createJihuTransport(process.env.NORA_JIHULAB_UPLOAD_CONFIG,{source:buildOwnedJihuSource()});
  providers={github:githubProvider({repository}),jihulab:jihulabProvider({...transport})};
  for(const provider of Object.values(providers)){
   const promote=provider.promote;
   provider.promote=async publication=>{await assertLegacyAppHead(verifyBatch(root,{commit}).product);return promote.call(provider,publication);};
  }
 }
 await executePublication(publication,{stage,providers});
 return publication;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const values={},flags=new Set();const argv=process.argv.slice(2);
 while(argv.length){const key=argv.shift();assert.ok(['--root','--state','--tag','--commit','--run','--stage','--notes','--plan-id','--resume'].includes(key)&&!Object.hasOwn(values,key)&&!flags.has(key),'Unknown/duplicate publication option');
  if(key==='--resume'){flags.add(key);continue;}const value=argv.shift();assert.ok(value&&!value.startsWith('--'));values[key]=value;
 }
 for(const key of ['--root','--state','--tag','--commit','--run'])assert.ok(values[key],'Missing '+key);
 const p=await publishCore({root:path.resolve(values['--root']),stateDir:path.resolve(values['--state']),tag:values['--tag'],commit:values['--commit'],sourceRun:values['--run'],stage:values['--stage']||'seal',resume:flags.has('--resume'),planId:values['--plan-id'],body:values['--notes']?fs.readFileSync(values['--notes'],'utf8'):''});
 console.log(JSON.stringify({planId:p.state.planId,status:p.state.status,commit:p.plan.commit,tag:p.plan.tag}));
}
