// Copy retained content as physical files, independently of Electron's ASAR
// namespace. The caller still owns staging, directory swap and rollback.
const fs=process.versions.electron?require('original-fs'):require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const PROGRAMS=['hermes-agent','python','node','bin','.local/bin','plugins/clawchat','clawchat/liveware',
  'nora-components.json','nora-clawchat-check.py','gateway.pid','gateway.lock','gateway_state.json'];
const CACHE_TREES=['AppData/Local/Microsoft/Windows/INetCache',
  'AppData/Local/Microsoft/Windows/INetCookies','AppData/Local/Microsoft/Windows/WebCache',
  'AppData/Local/Temp'];
const fail=(code,message,file,cause)=>Object.assign(new Error(message,cause?{cause}:undefined),
  {code,file,context:{operation:'copy-retained-data',file}});
const within=(base,file)=>{
  const relative=path.relative(base,file);
  return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
};
function stat(file){try{return fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function digest(file){
  const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);
  try{let size;while((size=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,size));}
  finally{fs.closeSync(fd);}
  return hash.digest('hex');
}
function copyUserData(previous,stage){
  previous=path.resolve(previous);stage=path.resolve(stage);
  if(within(previous,stage)||within(stage,previous))throw fail('RUNTIME_RETAINED_PATH_INVALID','保留数据与暂存目录不能互相包含。');
  for(const root of [previous,stage]){const entry=stat(root);if(!entry?.isDirectory()||entry.isSymbolicLink())
    throw fail('RUNTIME_RETAINED_PATH_INVALID','保留数据或暂存根目录无法核验。');}
  const result={schema:'nora-retained-copy/1',files:0,bytes:0,retainedCacheLinks:[]};
  function visit(relative){
    const portable=relative.split(path.sep).join('/');
    const key=process.platform==='win32'?portable.toLowerCase():portable;
    if(PROGRAMS.some(name=>key===(process.platform==='win32'?name.toLowerCase():name)
      ||key.startsWith((process.platform==='win32'?name.toLowerCase():name)+'/')))return;
    const source=path.join(previous,relative),target=path.join(stage,relative),before=stat(source);
    if(!before)throw fail('RUNTIME_RETAINED_CHANGED','复制期间原保留文件消失，未替换原目录。',portable);
    const existing=stat(target);
    if(existing?.isSymbolicLink())throw fail('RUNTIME_RETAINED_PATH_INVALID','暂存目标被链接重定向，未替换原目录。',portable);
    if(before.isSymbolicLink()){
      const link=fs.readlinkSync(source),resolved=path.resolve(path.dirname(source),link);
      const cache=process.platform==='win32'&&CACHE_TREES.find(name=>{
        const root=path.join(previous,name);return within(root,source)&&within(root,resolved);
      });
      if(cache){
        // These are Windows cache compatibility links, not user content. Never
        // follow or recreate them. Their originals survive in the caller's
        // verified previous directory; regular cache files are still copied.
        result.retainedCacheLinks.push({file:portable,target:link,reason:'windows-cache-link-kept-in-previous'});
        return;
      }
      if(!within(previous,resolved))throw fail('RUNTIME_RETAINED_LINK_UNSUPPORTED','保留链接指向实例外部；原链接已保留，未替换原目录。',portable);
      if(existing)throw fail('RUNTIME_RETAINED_PATH_INVALID','保留链接的暂存位置已有文件，未覆盖。',portable);
      const mapped=path.relative(path.dirname(source),resolved);
      try{fs.symlinkSync(mapped,target,fs.statSync(source).isDirectory()?'dir':'file');}
      catch(cause){throw fail('RUNTIME_RETAINED_LINK_UNSUPPORTED','无法保留此用户链接；原链接已保留，未替换原目录。',portable,cause);}
    }else if(before.isDirectory()){
      if(existing&&!existing.isDirectory())throw fail('RUNTIME_RETAINED_PATH_INVALID','保留目录与暂存文件冲突，未替换原目录。',portable);
      fs.mkdirSync(target,{recursive:true});
      for(const name of fs.readdirSync(source).sort())visit(path.join(relative,name));
    }else if(before.isFile()){
      if(existing&&!existing.isFile())throw fail('RUNTIME_RETAINED_PATH_INVALID','保留文件与暂存目录冲突，未替换原目录。',portable);
      fs.copyFileSync(source,target);
      const original=digest(source),copied=digest(target),after=stat(source);
      if(!after||['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key])||original!==copied)
        throw fail('RUNTIME_RETAINED_CHANGED','原保留文件发生变化或副本校验失败，未替换原目录。',portable);
      result.files++;result.bytes+=Number(before.size);
    }else throw fail('RUNTIME_RETAINED_FILE_UNSUPPORTED','保留内容包含无法安全复制的特殊文件，未替换原目录。',portable);
  }
  for(const name of fs.readdirSync(previous).sort())visit(name);
  return result;
}
module.exports={copyUserData};
