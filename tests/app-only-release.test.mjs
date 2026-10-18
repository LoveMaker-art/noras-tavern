import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as systemRelease from '../tooling/release/system-release.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-only-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const payload=path.join(root,'payload');fs.mkdirSync(payload);
 const core={schema:'tavern-release/v2',candidate:false,dirty:false,commit:'a'.repeat(40),versions:{tavern:'2.5.2'},artifacts:{'app/index.js':'c'.repeat(64)}};
 const bytes=Buffer.from(JSON.stringify(core)+'\n');fs.writeFileSync(path.join(payload,'release-manifest.json'),bytes);
 const checksums=Buffer.from('retained original core checksums\n');fs.writeFileSync(path.join(payload,'SHA256SUMS'),checksums);
 const entry={asset:'win32-x64-release-manifest.json',sha256:hash(bytes),size:bytes.length};
 const reference={schema:'nora-core-reference/1',tag:'v2.5.2',commit:core.commit,manifests:{'win32-x64':entry}};
 const product={schema:'tavern-release/v2',commit:'b'.repeat(40),candidate:false,dirty:false,versions:{tavern:'2.5.2'},
  publication:{schema:'nora-component-publication/1',tag:'v2.5.3'},coreRelease:reference,
  bootstrap:{minimumLauncherVersion:'2.2.3'},hermesRuntime:{platform:'win32',arch:'x64'}};
 return {root,payload,core,bytes,checksums,entry,reference,product};
}
test('APP-only platform delivery preserves original core manifest/checksum bytes and explicitly binds them to the new product',t=>{
 const f=fixture(t);systemRelease.writeSystemRelease({release:path.join(f.root,'release'),payload:f.payload,identity:f.product,launcherVersion:'2.2.3'});
 const system=JSON.parse(fs.readFileSync(path.join(f.payload,'nora-system.json')));
 assert.equal(system.commit,'b'.repeat(40));assert.equal(system.version,'2.5.2');assert.deepEqual(system.coreRelease,f.reference);
 assert.deepEqual(system.files['release-manifest.json'],f.entry);
 assert.equal(system.files.SHA256SUMS.sha256,hash(f.checksums));
 assert.deepEqual(fs.readFileSync(path.join(f.payload,'release-manifest.json')),f.bytes);
 assert.deepEqual(fs.readFileSync(path.join(f.payload,'SHA256SUMS')),f.checksums);
});

test('APP-only payload overlay consumes all verified original system files, never current runner files',async t=>{
 const f=fixture(t),{overlayCorePayload}=await import('../tooling/release/app-only-release.mjs');
 const baseline=path.join(f.root,'baseline');fs.mkdirSync(baseline);
 const original=Buffer.from('original core ops archive');fs.writeFileSync(path.join(baseline,'ops.tar.gz'),original);
 fs.writeFileSync(path.join(baseline,'release-manifest.json'),f.bytes);fs.writeFileSync(path.join(baseline,'SHA256SUMS'),f.checksums);
 const system={files:Object.fromEntries(['ops.tar.gz','release-manifest.json','SHA256SUMS'].map(name=>{const bytes=fs.readFileSync(path.join(baseline,name));return [name,{asset:'win32-x64-'+name,sha256:hash(bytes),size:bytes.length}]}))};
 fs.writeFileSync(path.join(f.payload,'new-runner.py'),'must not be installed as core');
 overlayCorePayload({directory:baseline,system,identity:f.core},f.payload,f.product,'win32-x64');
 assert.deepEqual(fs.readdirSync(f.payload).sort(),Object.keys(system.files).sort());assert.deepEqual(fs.readFileSync(path.join(f.payload,'ops.tar.gz')),original);
 fs.writeFileSync(path.join(baseline,'ops.tar.gz'),'corrupt');
 assert.throws(()=>overlayCorePayload({directory:baseline,system,identity:f.core},f.payload,f.product,'win32-x64'),/checksum|differs|size/i);
});

test('lightweight APP descriptor takes the current product source, not retained core source',async t=>{
 const f=fixture(t),{createRequire}=await import('node:module'),require=createRequire(import.meta.url);
 const {configuration}=require('../tooling/release/package-launcher-update.cjs');
 const starter=path.join(f.root,'release/nora-tavern-launcher'),desktop=path.join(starter,'desktop');fs.mkdirSync(desktop,{recursive:true});fs.mkdirSync(path.join(starter,'payload'));
 fs.writeFileSync(path.join(starter,'payload/release-manifest.json'),f.bytes);
 fs.writeFileSync(path.join(starter,'payload/nora-system.json'),JSON.stringify({commit:f.product.commit,coreRelease:f.reference}));
 fs.writeFileSync(path.join(f.root,'release/release-manifest.json'),JSON.stringify(f.product));
 fs.writeFileSync(path.join(desktop,'package.json'),JSON.stringify({version:'2.2.3',build:{extraResources:[],mac:{},win:{}}}));
 assert.equal(configuration(desktop,'win32','x64').identity.commit,f.product.commit);
});
