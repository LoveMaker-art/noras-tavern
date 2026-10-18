// APP-only packaging keeps actual core payload bytes separate from the current
// product/APP/maintenance runner. This module never grants native acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {assertCoreReleasePayload,coreReleaseIdentity,fileDigest,releasePublicationTag} from './system-release.mjs';
import {downloadCatalogueAsset,assertBaselineCatalogue} from './asset-catalogue.mjs';
export const APP_PLATFORMS=['darwin-arm64','darwin-x64','win32-x64'];
export function materializeCoreReference(catalogue,directory,{execute}={}) {
 const current=catalogue.release.tag_name,source=catalogue.sourceManifests[current];
 const reference={schema:'nora-core-reference/1',tag:source.coreRelease?.tag||current,commit:source.coreRelease?.commit||catalogue.commit,manifests:{}};
 for(const platform of APP_PLATFORMS){
  const systemName=`nora-system-${platform}.json`,systemFile=downloadCatalogueAsset(catalogue,systemName,directory,{execute,targetName:`reference-${systemName}`});
  const system=JSON.parse(fs.readFileSync(systemFile));assertBaselineCatalogue(catalogue,system);
  assert.deepEqual(system.coreRelease,source.coreRelease,'System core reference differs from authenticated product');
  const entry=system.files?.['release-manifest.json'];assert.equal(entry?.asset,`${platform}-release-manifest.json`);
  assert.ok(entry.size>0&&entry.size<=4*1024*1024,'Core manifest exceeds metadata budget');
  const file=downloadCatalogueAsset(catalogue,entry.asset,directory,{execute,targetName:entry.asset,expected:entry}),bytes=fs.readFileSync(file),core=JSON.parse(bytes);
  if(source.coreRelease)assertCoreReleasePayload(system,bytes,platform,entry);else assertBaselineCatalogue(catalogue,core);
  assert.equal(core.commit,reference.commit);assert.equal(releasePublicationTag(core),reference.tag);
  assert.equal(core.versions.tavern,source.version);reference.manifests[platform]={...entry};
 }
 fs.writeFileSync(path.join(directory,'baseline-core-reference.json'),JSON.stringify(reference,null,2)+'\n',{flag:'wx',mode:0o600});return reference;
}
export function overlayCorePayload(baseline,payload,product,platform) {
 const reference=coreReleaseIdentity(product,platform);assert.ok(reference,'Explicit APP-only core identity required');
 const bytes=fs.readFileSync(path.join(baseline.directory,'release-manifest.json'));
 assertCoreReleasePayload(product,bytes,platform,baseline.system.files['release-manifest.json']);
 // Verify the entire closure before replacing the private staging payload.
 const files=Object.entries(baseline.system.files);
 for(const [name,entry] of files){assert.match(name,/^[A-Za-z0-9][A-Za-z0-9._-]*$/);const file=path.join(baseline.directory,name);
  assert.ok(fs.lstatSync(file).isFile());assert.equal(fs.statSync(file).size,entry.size,'Core payload size differs');assert.equal(fileDigest(file),entry.sha256,'Core payload checksum differs');}
 fs.rmSync(payload,{recursive:true,force:true});fs.mkdirSync(payload,{recursive:true,mode:0o700});
 for(const [name] of files)fs.copyFileSync(path.join(baseline.directory,name),path.join(payload,name));
}
