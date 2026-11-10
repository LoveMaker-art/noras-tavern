import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
export const targets=Object.freeze(['darwin-arm64','darwin-x64','win32-x64']);
export const qualificationChecks=Object.freeze(['backup-safety','repository-and-delivery','core-consumers','tavern-workflows']);
export const nativeChecks=Object.freeze({outcome:'passed',runtime:'verified',coldInitialization:'verified-real-sealed-offline',firstInstall:'verified',http:'verified',hermesSkills:'verified',mcp:'verified',modelConfiguration:'verified-local-A-to-B-model-requests',committedFirstInstall:'verified-real-resume-without-reinstall',executorHandles:'verified-closed',stop:'verified'});
export const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export function files(directory,prefix='') {
 assert.ok(fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink(),'Invalid asset directory');
 return Object.fromEntries(fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(entry=>{
  assert.ok(!entry.isSymbolicLink()&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name),'Unsafe core asset');
  const key=prefix+entry.name,file=path.join(directory,entry.name);
  if(entry.isDirectory())return Object.entries(files(file,key+'/'));
  assert.ok(entry.isFile(),'Nonregular core asset');
  return [[key,{size:fs.statSync(file).size,sha256:hashFile(file)}]];
 }));
}
export function hashFile(file) {
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);
 try{assert.ok(fs.fstatSync(fd).isFile(),'Nonregular core asset');let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}
}
export function checkedFile(file,expected){
    if(!expected||!Number.isSafeInteger(expected.size)||expected.size<1||!/^[a-f0-9]{64}$/.test(expected.sha256||''))
        throw new Error('Input descriptor requires exact size and digest');
    const before=fs.lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink())throw new Error(`Input is not a regular file: ${path.basename(file)}`);
    if(before.size!==expected.size)throw new Error(`Input size differs: ${path.basename(file)}`);
    const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),chunk=Buffer.alloc(1024*1024);
    try{let n;while((n=fs.readSync(fd,chunk,0,chunk.length,null)))hash.update(chunk.subarray(0,n));}
    finally{fs.closeSync(fd);}
    const after=fs.lstatSync(file);
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)
        throw new Error('Input changed while checking its digest');
    if(hash.digest('hex')!==expected.sha256)throw new Error(`Input checksum differs: ${path.basename(file)}`);
    return file;
}

export function verifyCoreDirectory(root,{commit,target,allowCandidate=false}={}) {
 const product=json(path.join(root,'release-manifest.json'));
 assert.equal(product.schema,'tavern-release/v2');assert.match(product.commit,/^[a-f0-9]{40}$/);
 if(commit)assert.equal(product.commit,commit,'Different core source');
 if(!allowCandidate){assert.equal(product.candidate,false,'Candidate core cannot publish');assert.equal(product.dirty,false,'Dirty core cannot publish');}
 assert.ok(!product.coreRelease,'Core publication cannot be APP-only');
 assert.ok(!Object.keys(product.sourceFiles||{}).some(name=>name.startsWith('launcher/')),'Core contains desktop author source');
 for(const part of ['app','ops','nora-mcp']){const entry=product.archives[part];checkedFile(path.join(root,entry.name),entry);}
 for(const entry of Object.values(product.modules||{}))checkedFile(path.join(root,entry.name),entry);
 const selected=target?[target]:targets;
 const systemRoot=fs.existsSync(path.join(root,'system-assets'))?path.join(root,'system-assets'):root;
 for(const id of selected){
  const system=json(path.join(systemRoot,`nora-system-${id}.json`));
  assert.equal(system.schema,'nora-system/v1');assert.equal(`${system.platform}-${system.arch}`,id);
  assert.equal(system.commit,product.commit);assert.equal(system.version,product.versions.tavern);
  if(!allowCandidate)assert.equal(system.candidate,false);
  for(const entry of Object.values(system.files))checkedFile(path.join(systemRoot,entry.asset),entry);
  const metadata=system.files['release-manifest.json'];const platformProduct=json(path.join(systemRoot,metadata.asset));
  assert.equal(platformProduct.commit,product.commit);assert.deepEqual(platformProduct.sourceFiles,product.sourceFiles,'Platform source differs');
  assert.deepEqual(platformProduct.externalInputs,product.externalInputs,'Platform shared input differs');
 }
 const all=files(root);assert.ok(!Object.keys(all).some(name=>/Nora-Tavern-Launcher|nora-launcher-|\.(?:exe|dmg|asar)$/.test(name)),'Desktop asset in core publication');
 return {product,files:all};
}
