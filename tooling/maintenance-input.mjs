import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const safe=name=>typeof name==='string'&&name&&!/[\\:\0\r\n]/.test(name)&&!path.posix.isAbsolute(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
export function readMaintenancePin(directory=root){
 const pin=JSON.parse(fs.readFileSync(path.join(directory,'tooling/maintenance-input.lock.json')));
 if(pin.schema!=='nora-maintenance-input/1'||!safe(pin.archive.name)||!/^[a-f0-9]{64}$/.test(pin.archive.sha256)||!Number.isSafeInteger(pin.archive.size)||pin.archive.size<1)throw Error('Invalid maintenance input pin');
 if(pin.archive.url!==`https://github.com/${pin.origin.repository}/releases/download/${pin.origin.tag}/${pin.archive.name}`)throw Error('Maintenance input source differs from its fixed origin');
 for(const [name,entry] of Object.entries(pin.files))if(!safe(name)||!name.startsWith('ops/')||!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256)||/^ops\/installer\/desktop\/(?:main\.js|preload\.js|package\.json)$/.test(name)||/\.(?:html|css|woff2?|ttf|png)$/.test(name))throw Error('Invalid maintenance input member');
 return pin;
}
function checked(file,entry){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size!==entry.size)throw Error('Maintenance input size/type differs: '+file);const bytes=fs.readFileSync(file);if(sha(bytes)!==entry.sha256)throw Error('Maintenance input checksum differs: '+file);return bytes;}
function selectedCache(directory,cache){return path.resolve(cache||process.env.NORA_MAINTENANCE_CACHE||path.join(directory,'.cache/maintenance-input'));}
export async function prepareMaintenance({directory=root,cache,offline=false,fetcher=fetch}={}){
 const pin=readMaintenancePin(directory);cache=selectedCache(directory,cache);const archive=path.join(cache,pin.archive.name);
 if(fs.existsSync(archive)){checked(archive,pin.archive);return {cache,pin};}
 if(offline)throw Error('Fixed maintenance input is missing; run node tooling/maintenance-input.mjs fetch');
 fs.mkdirSync(cache,{recursive:true});const tmp=archive+'.partial-'+crypto.randomUUID();const fd=fs.openSync(tmp,'wx',0o600);let open=true;
 try{const response=await fetcher(pin.archive.url,{signal:AbortSignal.timeout(120000)});if(!response.ok||!response.body)throw Error('Fixed maintenance input download failed: '+response.status);let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>pin.archive.size)throw Error('Maintenance input exceeds its declared size');let offset=0;while(offset<chunk.length)offset+=fs.writeSync(fd,chunk,offset,chunk.length-offset);}
  fs.fsyncSync(fd);fs.closeSync(fd);open=false;checked(tmp,pin.archive);try{fs.linkSync(tmp,archive);}catch(e){if(e.code!=='EEXIST')throw e;checked(archive,pin.archive);}
 }finally{if(open)fs.closeSync(fd);fs.rmSync(tmp,{force:true});}
 return {cache,pin};
}
export function materializeMaintenance({directory=root,cache,stage}={}){
 const pin=readMaintenancePin(directory);cache=selectedCache(directory,cache);const bytes=checked(path.join(cache,pin.archive.name),pin.archive);
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'nora-maintenance-input-')),archive=path.join(scratch,'verified-input.tar.gz');
 try{
 fs.writeFileSync(archive,bytes,{flag:'wx',mode:0o600});
 const options={encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true};const names=execFileSync('tar',['-tzf',archive],options).trimEnd().split(/\r?\n/);const types=execFileSync('tar',['-tvzf',archive],options).trimEnd().split(/\r?\n/);
 if(types.length!==names.length||types.some(line=>!line.startsWith('-'))||names.some(name=>!safe(name))||new Set(names).size!==names.length)throw Error('Maintenance archive has unsafe members');
 for(const name of Object.keys(pin.files))if(!names.includes(name))throw Error('Maintenance archive is missing: '+name);
  const list=path.join(scratch,'members.txt');fs.writeFileSync(list,Object.keys(pin.files).join('\n')+'\n');execFileSync('tar',['-xzf',archive,'-C',scratch,'-T',list],{stdio:'pipe',windowsHide:true});
  for(const [name,entry]of Object.entries(pin.files))checked(path.join(scratch,name),entry);
  // Verify the complete input before creating or changing the caller's view.
  for(const name of Object.keys(pin.files))if(fs.existsSync(path.join(stage,name)))throw Error('Core source overlaps external maintenance ownership: '+name);
  for(const [name,entry]of Object.entries(pin.files)){const to=path.join(stage,name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,fs.readFileSync(path.join(scratch,name)),{mode:entry.mode&0o777});}
  const identity={schema:pin.schema,author:pin.author,origin:pin.origin,sha256:pin.archive.sha256,pinSha256:sha(fs.readFileSync(path.join(directory,'tooling/maintenance-input.lock.json'))),files:Object.fromEntries(Object.entries(pin.files).map(([name,entry])=>[name,entry.sha256]))};
  return {files:Object.keys(pin.files),identity};
 }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(!['fetch','verify'].includes(args[0])||args.length!==1)throw Error('Use maintenance-input.mjs fetch|verify');
 const result=await prepareMaintenance({offline:args[0]==='verify'});console.log(JSON.stringify({verified:true,source:result.pin.origin,sha256:result.pin.archive.sha256}));
}
