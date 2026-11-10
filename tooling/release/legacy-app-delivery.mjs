// Immutable delivery adapter for installed clients. No APP source is built here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkedFile,digest,json,targets} from './core-assets.mjs';

export const pinPath='tooling/release/legacy-app-input.lock.json';
export const deliveryAsset='legacy-app-delivery.json';
const root=fileURLToPath(new URL('../../',import.meta.url));
const version=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function validateLegacyPin(pin) {
 assert.equal(pin.schema,'nora-legacy-app-delivery/1');assert.match(pin.version,version);
 assert.equal(pin.origin.repository,'LoveMaker-art/noras-tavern');assert.match(pin.origin.tag,/^v\d+\.\d+\.\d+$/);assert.match(pin.origin.commit,/^[a-f0-9]{40}$/);
 const names=['release-manifest.json',...targets.flatMap(t=>[`nora-launcher-${t}.json`,`Nora-Tavern-Launcher-${pin.version}-${t}-update.zip`])];
 assert.deepEqual(Object.keys(pin.assets).sort(),names.sort(),'Unexpected legacy delivery assets');
 for(const [name,entry]of Object.entries(pin.assets)){
  assert.equal(entry.url,`https://github.com/${pin.origin.repository}/releases/download/${pin.origin.tag}/${name}`);
  assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(entry.size)&&entry.size>0&&entry.size<=512*1024*1024);
  if(name.endsWith('.json'))assert.ok(entry.size<=4*1024*1024);
 }return pin;
}
export function readLegacyPin(directory=root) {
 const bytes=fs.readFileSync(path.join(directory,pinPath)),pin=validateLegacyPin(JSON.parse(bytes));
 return {pin,bytes,descriptor:{asset:deliveryAsset,size:bytes.length,sha256:digest(bytes),version:pin.version,origin:pin.origin}};
}
export function declareLegacyApp(identity,directory) {
 const input=readLegacyPin(directory);assert.equal(identity.sourceFiles[pinPath],input.descriptor.sha256,'APP pin differs from captured source');
 return {...input,identity:{...identity,launcherVersion:input.pin.version,legacyAppDelivery:input.descriptor}};
}
export function verifyLegacyDelivery(directory,product,{complete=false}={}) {
 const descriptor=product.legacyAppDelivery;assert.equal(descriptor?.asset,deliveryAsset,'Missing installed-client delivery adapter');
 checkedFile(path.join(directory,deliveryAsset),descriptor);const pin=validateLegacyPin(json(path.join(directory,deliveryAsset)));
 assert.equal(product.sourceFiles[pinPath],descriptor.sha256,'Legacy pin is outside accepted source');
 assert.equal(product.launcherVersion,pin.version);assert.equal(descriptor.version,pin.version);assert.deepEqual(descriptor.origin,pin.origin);
 assert.ok(product.updateCompatibility?.launcherVersions.includes(pin.version),'Published APP is outside reviewed core compatibility');
 if(complete)for(const target of targets){
  const name=`nora-launcher-${target}.json`,entry=pin.assets[name];checkedFile(path.join(directory,name),entry);
  const app=json(path.join(directory,name)),[platform,arch]=target.split('-');
  assert.equal(app.schema,'nora-launcher/v1');assert.equal(app.version,pin.version);assert.equal(app.commit,pin.origin.commit);
  assert.equal(app.platform,platform);assert.equal(app.arch,arch);assert.equal(app.candidate,false);
  const archive=`Nora-Tavern-Launcher-${pin.version}-${target}-update.zip`;assert.equal(app.asset,archive);
  assert.equal(app.size,pin.assets[archive].size);assert.equal(app.sha256,pin.assets[archive].sha256);checkedFile(path.join(directory,archive),app);
 }return pin;
}
export function copyLegacyDelivery(directory,product,cache) {
 const pin=verifyLegacyDelivery(directory,product);
 const original=json(checkedFile(path.join(cache,'release-manifest.json'),pin.assets['release-manifest.json']));
 assert.equal(original.commit,pin.origin.commit);assert.equal(original.launcherVersion,pin.version);assert.equal(original.candidate,false);assert.equal(original.dirty,false);
 for(const [name,entry]of Object.entries(pin.assets))if(name!=='release-manifest.json')fs.copyFileSync(checkedFile(path.join(cache,name),entry),path.join(directory,name),fs.constants.COPYFILE_EXCL);
 verifyLegacyDelivery(directory,product,{complete:true});
}
export async function prepareLegacyInputs({directory=root,cache=path.join(directory,'.cache/legacy-app'),offline=false,fetcher=fetch}={}) {
 const {pin}=readLegacyPin(directory);fs.mkdirSync(cache,{recursive:true});
 for(const [name,entry]of Object.entries(pin.assets)){
  const file=path.join(cache,name);if(fs.existsSync(file)){checkedFile(file,entry);continue;}
  assert.ok(!offline,'Fixed legacy APP input is absent; fetch reviewed bytes first');
  const temporary=file+'.partial-'+crypto.randomUUID(),fd=fs.openSync(temporary,'wx',0o600);let open=true,size=0;
  try{
   const response=await fetcher(entry.url,{signal:AbortSignal.timeout(1200000)});assert.ok(response.ok&&response.body,'Legacy input download failed: '+response.status);
   for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=entry.size,'Legacy input exceeds its pin');let offset=0;while(offset<chunk.length)offset+=fs.writeSync(fd,chunk,offset,chunk.length-offset);}
   fs.fsyncSync(fd);fs.closeSync(fd);open=false;checkedFile(temporary,entry);
   try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;checkedFile(file,entry);}
  }finally{if(open)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
 }return cache;
}

// A core must not conceal an APP published after this reviewed input was pinned.
// Check both independent discovery sources before any remote write; failure is closed.
export async function assertLegacyAppHead(product,{fetcher=fetch,policy}={}) {
 policy||=(await import('./release-policy.mjs')).readReleasePolicy();
 const pinVersion=product.launcherVersion,calls=[],seen=new Map();assert.match(pinVersion,version);
 const read=async url=>{
  const response=await fetcher(url,{signal:AbortSignal.timeout(30000),headers:{Accept:'application/vnd.github+json'}});assert.ok(response.ok,'Cannot verify current APP catalogue: '+response.status);
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=8*1024*1024,'APP catalogue exceeds budget');chunks.push(Buffer.from(chunk));}
  const body=Buffer.concat(chunks);calls.push(url);return {body,value:JSON.parse(body)};
 };
 const api=`https://api.github.com/repos/${product.legacyAppDelivery.origin.repository}/releases`;
 const primary=policy.reader.sourceCandidates(api+'?per_page=100&page=1',{discovery:'launcher'}).find(s=>s.provider==='jihulab'||s.id==='jihulab');
 // Use the frozen policy's APP-only endpoint, separate from ordinary core discovery.
 const appPrimary=policy.reader.sourceCandidates(api+'?per_page=100&page=1',{discovery:'launcher',channel:'stable'}).find(s=>s.url.includes('/channels/launcher-stable.json'));
 assert.ok(appPrimary||primary?.url.includes('/channels/launcher-stable.json'),'Missing APP channel policy');
 const appRows=(await read((appPrimary||primary).url)).value;assert.ok(Array.isArray(appRows),'Invalid APP channel');
 const rows=[...appRows];let complete=false;
 for(let page=1;page<=5;page++){const pageRows=(await read(api+`?per_page=100&page=${page}`)).value;assert.ok(Array.isArray(pageRows)&&pageRows.length<=100);rows.push(...pageRows);if(pageRows.length<100){complete=true;break;}}
 assert.ok(complete,'APP catalogue is incomplete');
 for(const release of rows){
  if(release.draft||release.prerelease||!/^v\d+\.\d+\.\d+$/.test(release.tag_name||''))continue;
  if(!release.assets?.some(a=>/^nora-launcher-/.test(a.name)))continue;
  const entries=release.assets.filter(a=>a.name==='release-manifest.json');assert.equal(entries.length,1,'Missing current APP metadata');
  const entry=entries[0],logical=`https://github.com/${product.legacyAppDelivery.origin.repository}/releases/download/${release.tag_name}/release-manifest.json`;
  assert.equal(entry.browser_download_url,logical);assert.match(entry.digest,/^sha256:[a-f0-9]{64}$/);assert.ok(entry.size>0&&entry.size<=4*1024*1024);
  if(seen.has(logical)){assert.deepEqual(seen.get(logical),{size:entry.size,digest:entry.digest},'APP sources disagree');continue;}
  seen.set(logical,{size:entry.size,digest:entry.digest});
  const {body,value}=await read(logical);assert.equal(Buffer.byteLength(body),entry.size);assert.equal(digest(body),entry.digest.slice(7));
  assert.equal(value.schema,'tavern-release/v2');assert.equal(value.candidate,false);assert.equal(value.dirty,false);assert.match(value.launcherVersion,version);
  const a=value.launcherVersion.split('.').map(Number),b=pinVersion.split('.').map(Number),i=a.findIndex((n,i)=>n!==b[i]);
  assert.ok(i<0||a[i]<b[i],'Reviewed APP input is stale; preserve the newer published APP before core publication');
 }return {verified:true,requests:calls};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.ok(['fetch','verify'].includes(process.argv[2]));console.log(await prepareLegacyInputs({offline:process.argv[2]==='verify'}));
}
