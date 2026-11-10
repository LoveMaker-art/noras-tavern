// Bounded ASAR reader adapted from 09b9895 final-consumer, retaining its checks.
// Frozen selector bytes are compatibility evidence; this does not execute Electron.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {digest as sha,checkedFile,json,targets as platforms} from './core-assets.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const maxAsar=64*1024*1024;
const modules=['package.json','releases.js','launcher-update.js','release-network.js','release-sources.js','release-sources.json','launcher-errors.js','telemetry-contract.json'];
export function readConsumerAsar(bytes) {
    assert.ok(bytes.length >= 16 && bytes.length <= maxAsar, 'Invalid consumer ASAR size');
    const headerSize = bytes.readUInt32LE(4), textSize = bytes.readUInt32LE(12);
    assert.equal(bytes.readUInt32LE(0), 4, 'Invalid ASAR size pickle');
    assert.ok(headerSize >= 8 && headerSize <= 8 * 1024 * 1024 && 8 + headerSize <= bytes.length);
    assert.equal(bytes.readUInt32LE(8), headerSize - 4, 'Invalid ASAR header pickle');
    assert.ok(textSize > 0 && textSize <= headerSize - 8, 'Invalid ASAR JSON bounds');
    const header = JSON.parse(bytes.subarray(16, 16 + textSize).toString('utf8'));
    const result = new Map(), base = 8 + headerSize;
    function read(node, name) {
        assert.ok(node && !node.link && !node.unpacked && !node.files, `Unsupported consumer member: ${name}`);
        assert.ok(Number.isSafeInteger(node.size) && node.size >= 0 && node.size <= 8 * 1024 * 1024);
        assert.match(node.offset, /^(?:0|[1-9][0-9]*)$/);
        const offset = Number(node.offset);
        assert.ok(Number.isSafeInteger(offset) && offset >= 0 && base + offset + node.size <= bytes.length,
            `Consumer member escapes ASAR: ${name}`);
        const content = bytes.subarray(base + offset, base + offset + node.size);
        if (node.integrity) {
            assert.equal(node.integrity.algorithm, 'SHA256');
            assert.equal(node.integrity.hash, sha(content), `Consumer member integrity differs: ${name}`);
        }
        result.set(name, content);
    }
    for (const name of modules) read(header.files?.[name], name);
    // Pre-2.2.3 APPs have no combined-update module. Keep their unchanged
    // archive reusable; modern APPs must contain it (checked after extraction).
    if(header.files?.['update-sequence.js'])read(header.files['update-sequence.js'],'update-sequence.js');
    function dependency(node, prefix) {
        assert.ok(node && !node.link && !node.unpacked, `Invalid consumer dependency: ${prefix}`);
        if (!node.files) { read(node, prefix); return; }
        for (const [name, item] of Object.entries(node.files)) {
            assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
            assert.ok(name !== '.' && name !== '..');
            dependency(item, prefix + '/' + name);
        }
    }
    dependency(header.files?.node_modules?.files?.semver, 'node_modules/semver');
    assert.ok(result.has('node_modules/semver/package.json'), 'Missing shipped semver');
    return result;
}

function packedConsumer(file) {
    // Python's ZIP reader reads just this bounded member, not the 100 MB runtime
    // or any path chosen by the archive. The publisher already verifies ZIP SHA.
    const program = `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 members=[i for i in z.infolist() if i.filename=='resources/app.asar' or i.filename.endswith('.app/Contents/Resources/app.asar')]
 assert len(members)==1, 'Expected exactly one shipped launcher app.asar'
 member=members[0]
 assert not member.is_dir() and 16 <= member.file_size <= ${maxAsar}
 assert all(p not in ('', '.', '..') for p in member.filename.split('/'))
 with z.open(member) as stream:
  data=stream.read(${maxAsar + 1})
  assert len(data)==member.file_size
  sys.stdout.buffer.write(data)
`;
    return execFileSync(process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
        ['-B', '-c', program, file], {maxBuffer:maxAsar, timeout:30000, windowsHide:true});
}


export async function verifyLegacyConsumers({plan,release},{targets=platforms}={}) {
 const objects=new Map(plan.objects.filter(o=>o.phase==='asset').map(o=>[path.basename(o.key),o]));
 const product=json(objects.get('release-manifest.json').file),report={schema:'nora-core-legacy-consumers/1',cases:[]};
 for(const target of targets){
  const descriptor=json(objects.get(`nora-launcher-${target}.json`).file),archive=objects.get(descriptor.asset);checkedFile(archive.file,descriptor);
  const packed=readConsumerAsar(packedConsumer(archive.file));assert.equal(JSON.parse(packed.get('package.json')).version,product.launcherVersion);
  const variants=[{version:product.launcherVersion,files:packed,origin:'published-app-asar',installed:'2.1.0'}];
  for(const version of ['2.1.1','2.2.8']){
   const base=path.join(root,'tests/fixtures/legacy-core-consumers',version),proof=json(path.join(base,'provenance.json')),files=new Map();
   for(const [source,hash]of Object.entries(proof.files)){
    const name=path.basename(source),relative=`tests/fixtures/legacy-core-consumers/${version}/${name}`,bytes=fs.readFileSync(path.join(base,name));
    assert.equal(sha(bytes),hash);assert.equal(product.sourceFiles[relative],hash,'Frozen consumer is outside accepted core source');files.set(name,bytes);
   }
   for(const [name,bytes]of packed)if(name.startsWith('node_modules/semver/'))files.set(name,bytes);
   variants.push({version,files,origin:proof.commit,installed:version});
  }
  for(const variant of variants){
   const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-legacy-core-consumer-')),require=createRequire(path.join(directory,'entry.cjs'));
   try{
    for(const [name,bytes]of variant.files){const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
    const consumer=require('./releases.js'),sources=require('./release-sources.js'),api=`https://api.github.com/${'repos/'+plan.repository}/releases`;
    for(const githubOnly of [false,true]){
     const physical=new Map(),catalogues=new Map(),calls=[];
     for(const [name,object]of objects)for(const c of sources.sourceCandidates(`https://github.com/${plan.repository}/releases/download/${plan.tag}/${name}`,{channel:plan.channel}))physical.set(c.url,object);
     for(const [url,list]of [[api+'/latest',false],[api+'?per_page=100&page=1',true],[api+'?per_page=10&page=1',true],[api+`/tags/${plan.tag}`,false]])
      for(const c of sources.sourceCandidates(url,{channel:plan.channel}))catalogues.set(c.url,list);
     const fetcher=async address=>{
      const url=String(address),u=new URL(url);calls.push(url);
      if((githubOnly&&u.hostname!=='api.github.com'&&u.hostname!=='github.com')||u.hostname.includes('sourceforge'))return new Response('not published here',{status:503});
      let bytes;if(catalogues.has(url))bytes=Buffer.from(JSON.stringify(catalogues.get(url)?[release]:release));
      else {const o=physical.get(url);assert.ok(o,'Legacy consumer requested unsealed metadata: '+url);assert.ok(o.size<=4*1024*1024,'Discovery must not download program archives');checkedFile(o.file,o);bytes=fs.readFileSync(o.file);}
      const response=new Response(bytes);Object.defineProperty(response,'url',{value:url});return response;
     };
     const [platform,arch]=target.split('-'),options={installRoot:path.join(directory,'installation'),platform,arch,launcherVersion:variant.installed,channel:plan.channel,fetcher,networkPolicy:{maxAttempts:1,attempts:1,totalBudgetMs:5000,attemptTimeoutMs:1000}};
     const selected=consumer.checkApp?await consumer.checkApp(options):await consumer.check(options);
     assert.equal(selected.launcherLatest,product.launcherVersion,'Core publication concealed an existing APP');
     assert.equal(selected.launcherUpdateAvailable,true);const fixed=selected.releasePlan;
     assert.equal(fixed.launcherManifest.sha256,descriptor.sha256);assert.equal(fixed.launcherManifest.commit,descriptor.commit);
     report.cases.push({target,consumerVersion:variant.version,consumerOrigin:variant.origin,route:githubOnly?'github-fallback':'primary-with-supported-fallback',appVersion:selected.launcherLatest,archiveSha256:descriptor.sha256,requests:calls});
    }
   }finally{for(const name of Object.keys(require.cache))if(name.startsWith(directory+path.sep))delete require.cache[name];fs.rmSync(directory,{recursive:true,force:true});}
  }
 }return report;
}
