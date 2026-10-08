// Read-only full-tree integrity facts, shared by component and legacy recovery.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const fail=(code,message)=>Object.assign(new Error(message),{code});
function treeSeal(root){
  const hash=crypto.createHash('sha256');let files=0,bytes=0;
  const buffer=Buffer.allocUnsafe(1024*1024);
  function visit(relative){
    const file=path.join(root,relative),before=fs.lstatSync(file,{bigint:true});
    const name=relative.split(path.sep).join('/');
    if(before.isSymbolicLink())hash.update(JSON.stringify([name,'link',fs.readlinkSync(file)]));
    else if(before.isDirectory()){
      hash.update(JSON.stringify([name,'directory']));
      for(const child of fs.readdirSync(file).sort())visit(path.join(relative,child));
      const after=fs.lstatSync(file,{bigint:true});
      if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)
        throw fail('RUNTIME_BACKUP_CHANGED','备份核验期间目录发生变化，未覆盖现有安装。');
    }else if(before.isFile()){
      const content=crypto.createHash('sha256'),fd=fs.openSync(file,'r');
      try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)content.update(buffer.subarray(0,count));}finally{fs.closeSync(fd);}
      const after=fs.lstatSync(file,{bigint:true});
      if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)
        throw fail('RUNTIME_BACKUP_CHANGED','备份核验期间文件发生变化，未覆盖现有安装。');
      hash.update(JSON.stringify([name,'file',String(before.size),content.digest('hex')]));files++;bytes+=Number(before.size);
    }else throw fail('RUNTIME_BACKUP_CHANGED','备份包含无法核验的文件，未覆盖现有安装。');
  }
  visit('');return {schema:'nora-runtime-tree-seal/1',sha256:hash.digest('hex'),files,bytes};
}
const sameSeal=(a,b)=>a?.schema==='nora-runtime-tree-seal/1'&&b?.schema===a.schema&&a.sha256===b.sha256&&a.files===b.files&&a.bytes===b.bytes;

module.exports={treeSeal,sameSeal};
