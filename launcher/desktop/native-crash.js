const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');

const MAX_DUMP=64*1024*1024,MAX_DUMPS=10,MAX_RETAINED=128*1024*1024;
// Read only the exception and module table. Stack memory, process annotations,
// environment and command line in the minidump never enter automatic uploads.
function crashLocation(buffer){
  const range=(offset,size)=>{
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset+size>buffer.length)throw Error('incomplete minidump');
  };
  range(0,32);
  if(buffer.toString('ascii',0,4)!=='MDMP'||(buffer.readUInt32LE(4)&0xffff)!==0xa793)throw Error('invalid minidump');
  const count=buffer.readUInt32LE(8),directory=buffer.readUInt32LE(12);
  if(count>128)throw Error('invalid stream count');range(directory,count*12);
  const streams=new Map();
  for(let index=0;index<count;index++){
    const entry=directory+index*12,type=buffer.readUInt32LE(entry),size=buffer.readUInt32LE(entry+4),offset=buffer.readUInt32LE(entry+8);
    range(offset,size);streams.set(type,{offset,size});
  }
  const exception=streams.get(6);
  if(!exception)return {evidenceStatus:'dump_collected',stackStatus:'unavailable',missingReason:'exception unavailable',
    crashTime:new Date(buffer.readUInt32LE(20)*1000).toISOString()};
  if(exception.size<168)throw Error('incomplete exception');
  const offset=exception.offset;
  let address=buffer.readBigUInt64LE(offset+24);
  // Crashpad on macOS may report an exception address of zero. Use only the
  // instruction pointer from the reviewed ARM64 / AMD64 context layouts:
  // google/breakpad common/minidump_cpu_{arm64,amd64}.h. Never read stack memory.
  const system=streams.get(7),contextSize=buffer.readUInt32LE(offset+160),context=buffer.readUInt32LE(offset+164);
  if(system?.size>=2&&contextSize){
    range(context,contextSize);const arch=buffer.readUInt16LE(system.offset);
    if(arch===12&&contextSize>=272&&(buffer.readUInt32LE(context)&0x00400001)===0x00400001)address=buffer.readBigUInt64LE(context+264);
    else if(arch===9&&contextSize>=256&&(buffer.readUInt32LE(context+48)&0x00100001)===0x00100001)address=buffer.readBigUInt64LE(context+248);
  }
  const result={evidenceStatus:'dump_collected',exceptionCode:'0x'+buffer.readUInt32LE(offset+8).toString(16),
    threadId:buffer.readUInt32LE(offset),crashTime:new Date(buffer.readUInt32LE(20)*1000).toISOString(),
    location:'0x'+address.toString(16),stackStatus:'symbolication_required'};
  const modules=streams.get(4);
  if(modules){
    range(modules.offset,4);const count=buffer.readUInt32LE(modules.offset);
    if(count>4096||4+count*108>modules.size)throw Error('invalid module table');
    for(let index=0;index<count;index++){
      const item=modules.offset+4+index*108,base=buffer.readBigUInt64LE(item),size=buffer.readUInt32LE(item+8);
      if(address<base||address>=base+BigInt(size))continue;
      const nameOffset=buffer.readUInt32LE(item+20);range(nameOffset,4);
      const nameSize=buffer.readUInt32LE(nameOffset);if(nameSize>4096||nameSize%2)throw Error('invalid module name');range(nameOffset+4,nameSize);
      const name=buffer.toString('utf16le',nameOffset+4,nameOffset+4+nameSize).replaceAll('\\','/').split('/').pop();
      if(name&&/^[\w .+()-]{1,120}$/.test(name))result.location=name+'+0x'+(address-base).toString(16);
      break;
    }
  }
  return result;
}

function createNativeCrashDiagnostics({directory,onEvidence,diagnostic=()=>{}}){
  const checkpoint=path.join(directory,'nora-collected.json');
  let collecting=false;
  function safeDirectory(){
    // A linked ancestor could redirect collection outside our private directory.
    let parent=path.resolve(directory);
    while(true){if(fs.lstatSync(parent,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('linked crash directory');
      const next=path.dirname(parent);if(next===parent)break;parent=next;}
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
  }
  function start({app,crashReporter}){
    if(!crashReporter?.start)return false;
    try{
      safeDirectory();app.setPath('crashDumps',directory);
      crashReporter.start({uploadToServer:false,productName:'Nora Tavern Launcher'});
      return true;
    }catch{diagnostic('native_crash_collection_unavailable');return false;}
  }
  async function collect(){
    if(collecting)return;collecting=true;
    try{
      safeDirectory();let seen=[];
      if(fs.existsSync(checkpoint)){
        if(fs.lstatSync(checkpoint).isSymbolicLink()||fs.statSync(checkpoint).size>16384)throw Error('invalid crash checkpoint');
        seen=JSON.parse(fs.readFileSync(checkpoint,'utf8'));
        if(!Array.isArray(seen)||seen.length>200||seen.some(value=>!/^[a-f0-9]{64}$/.test(value)))throw Error('invalid crash checkpoint');
      }
      const dumps=[];let entries=0;
      function walk(folder,depth){
        for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
          if(++entries>1000)throw Error('crash directory capacity');
          const file=path.join(folder,entry.name);
          if(entry.isSymbolicLink())continue;
          if(entry.isDirectory()&&depth<3)walk(file,depth+1);
          else if(entry.isFile()&&entry.name.endsWith('.dmp')){const stat=fs.statSync(file);dumps.push({file,mtime:stat.mtimeMs,size:stat.size});}
        }
      }
      walk(directory,0);dumps.sort((a,b)=>b.mtime-a.mtime);
      for(const dump of dumps.slice(0,MAX_DUMPS).reverse()){
        // Crashpad writes uniquely named artifacts. Metadata avoids rereading
        // already collected memory dumps on every idle poll.
        const id=createHash('sha256').update(path.relative(directory,dump.file)+':'+dump.size+':'+dump.mtime).digest('hex');
        if(seen.includes(id))continue;
        const fd=fs.openSync(dump.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
        let evidence;
        try{
          const stat=fs.fstatSync(fd);if(!stat.isFile())continue;
          if(stat.size!==dump.size||stat.mtimeMs!==dump.mtime)throw Error('dump changed');
          if(stat.size>MAX_DUMP){
            evidence={evidenceStatus:'dump_too_large',stackStatus:'unavailable'};
          }else{
            const data=Buffer.alloc(stat.size);let read=0;
            while(read<data.length){const size=fs.readSync(fd,data,read,data.length-read,read);if(!size)throw Error('dump changed');read+=size;}
            try{evidence=crashLocation(data);}catch(error){evidence={evidenceStatus:'dump_unreadable',stackStatus:'unavailable',missingReason:error.message};}
          }
        }finally{fs.closeSync(fd);}
        await onEvidence({...evidence,dumpUpload:false});
        seen.push(id);seen=seen.slice(-200);
        const temporary=checkpoint+'.'+randomUUID()+'.tmp';
        try{fs.writeFileSync(temporary,JSON.stringify(seen),{mode:0o600,flag:'wx'});fs.renameSync(temporary,checkpoint);}
        finally{fs.rmSync(temporary,{force:true});}
      }
      // Only local Crashpad dumps in this dedicated directory are pruned.
      // Database files, installation files and service logs are never touched.
      let retained=0,count=0;
      for(const dump of dumps){
        if(dump.size>MAX_DUMP||count>=MAX_DUMPS||retained+dump.size>MAX_RETAINED)fs.unlinkSync(dump.file);
        else{count++;retained+=dump.size;}
      }
    }catch{diagnostic('native_crash_evidence_unavailable');}
    finally{collecting=false;}
  }
  return {start,collect};
}
module.exports={createNativeCrashDiagnostics};
