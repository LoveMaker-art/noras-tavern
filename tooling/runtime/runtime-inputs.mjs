import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkedFile,json} from '../release/core-assets.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
export async function prepareRuntime({directory=root,target=`${process.platform}-${process.arch}`,cache=path.join(directory,'.cache/runtime'),offline=false,fetcher=fetch}={}) {
 const lock=json(path.join(directory,'tooling/runtime/runtime-inputs.lock.json'));
 assert.equal(lock.schema,'nora-core-runtime-inputs/1');
 const entries=lock.platforms[target];assert.ok(entries,'Unsupported fixed runtime target');
 const destination=path.join(cache,target);fs.mkdirSync(destination,{recursive:true});
 for(const [name,entry]of Object.entries(entries)){
  assert.match(name,/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.equal(entry.url,`https://github.com/${lock.origin.repository}/releases/download/${lock.origin.tag}/${name}`);
  const relative=name.slice(target.length+1),file=path.join(destination,relative);
  if(fs.existsSync(file)){checkedFile(file,entry);continue;}
  assert.ok(!offline,'Fixed runtime is absent; explicitly fetch it first');
  const temporary=file+'.partial-'+crypto.randomUUID(),fd=fs.openSync(temporary,'wx',0o600);let open=true,size=0;
  try{
   const response=await fetcher(entry.url,{signal:AbortSignal.timeout(1200000)});
   assert.ok(response.ok&&response.body,`Runtime input download failed: ${response.status}`);
   for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=entry.size,'Runtime input exceeds its pin');let offset=0;while(offset<chunk.length)offset+=fs.writeSync(fd,chunk,offset,chunk.length-offset);}
   fs.fsyncSync(fd);fs.closeSync(fd);open=false;checkedFile(temporary,entry);
   try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;checkedFile(file,entry);}
  }finally{if(open)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
 }
 const manifest=path.join(destination,'nora-hermes-runtime.json'),metadata=json(manifest);
 assert.equal(`${metadata.platform}-${metadata.arch}`,target,'Runtime target differs');
 const archive=entries[target+'-'+metadata.archive];assert.ok(archive,'Runtime archive is outside the fixed inputs');
 assert.equal(metadata.sha256,archive.sha256);assert.equal(metadata.size,archive.size);
 return {manifest,directory:destination,origin:lock.origin};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [action,target]=process.argv.slice(2);assert.ok(['fetch','verify'].includes(action));
 console.log(JSON.stringify(await prepareRuntime({target,offline:action==='verify'})));
}
