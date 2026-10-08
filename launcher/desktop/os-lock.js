// One native primitive shared by the short-lived guard and synchronous uninstall.
// The lock file is stable for the installation lifetime, including reinstallation.
const fs=require('node:fs');
const path=require('node:path');
const native=require('fs-native-extensions');
const failure=(code,message)=>Object.assign(new Error(message),{code});
function acquire({directory,probe=false}={}) {
  if(!['darwin','win32'].includes(process.platform))throw failure('LOCK_UNSUPPORTED','Unsupported operation lock platform');
  if(!path.isAbsolute(directory||''))throw new TypeError('An absolute installer directory is required');
  const operations=path.join(directory,'operations'),file=path.join(operations,'.writer.lock');
  for(const candidate of [directory,operations,file]){
    if(fs.existsSync(candidate)&&fs.lstatSync(candidate).isSymbolicLink())throw failure('LOCK_IDENTITY','Operation lock path cannot be redirected');
  }
  if(probe&&!fs.existsSync(file))return {busy:false,release(){}};
  if(!probe)fs.mkdirSync(operations,{recursive:true,mode:0o700});
  const fd=fs.openSync(file,probe?'r+':'a+',0o600),length=process.platform==='win32'?1:0;
  let held=false,closed=false;
  const release=()=>{if(closed)return;closed=true;try{if(held)native.unlock(fd,0,length);}finally{fs.closeSync(fd);}};
  try{
    held=native.tryLock(fd,0,length);
    if(!held){release();if(probe)return {busy:true,release(){}};throw failure('OPERATION_BUSY','Another operation still owns this installation');}
    const opened=fs.fstatSync(fd),current=fs.statSync(file);
    if(opened.dev!==current.dev||opened.ino!==current.ino)throw failure('LOCK_IDENTITY','Operation lock changed identity');
    if(!probe&&opened.size===0)fs.writeSync(fd,Buffer.from([0]));
    if(probe){release();return {busy:false,release(){}};}
    return {busy:false,release};
  }catch(error){release();throw error;}
}
module.exports={acquire};
