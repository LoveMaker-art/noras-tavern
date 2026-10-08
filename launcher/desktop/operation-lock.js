// Lifetime protection, not permission to overwrite unknown transactions.
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const {restoreDiagnostic}=require('./operation-delegate');

function failure(fields) {return restoreDiagnostic(fields);}
async function connect(options, probe=false) {
  if (!path.isAbsolute(options.directory || '')) throw new TypeError('Operation directory must be absolute');
  if (!probe && (!/^[\w-]{1,120}$/.test(options.operationId || '') || !Number.isSafeInteger(options.ownerEpoch) || options.ownerEpoch<1)) throw new TypeError('Operation identity is required');
  const token=crypto.randomBytes(32).toString('hex');
  const worker=spawn(process.execPath,[path.join(__dirname,'operation-lock-worker.js')],{
    detached:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  const jobs=new Map(),pending=new Map(),lease=new EventEmitter();let sequence=0,closed=false,cancelling=false,releasing=false,stderr='';
  const exited=new Promise((resolve,reject)=>{
    worker.once('error',reject);
    worker.once('exit',(code,signal)=>{
      closed=true;
      for(const task of pending.values())task.reject(failure({code:'LOCK_GUARD_EXITED',message:'Operation guard exited'}));
      pending.clear();resolve({code,signal});
      if(jobs.size) {
        const error=failure({code:'LOCK_GUARD_LOST',message:'Operation guard exited before maintenance child closure; inspect saved effects before takeover'});
        lease.emit('guard-lost',error);
        for(const child of jobs.values()){child.stdout.end();child.stderr.end();child.emit('guard-lost',error);if(child.listenerCount('error'))child.emit('error',error);}
      }
    });
  });
  exited.catch(()=>{}); // Initialization failure must not leave an unobserved exit promise.
  worker.stderr.on('data',value=>{stderr=(stderr+value.toString()).slice(-2000);});
  const send=value=>{
    if(closed || !worker.connected) throw failure({code:'LOCK_GUARD_EXITED',message:'Operation guard is no longer connected'});
    worker.send({operationId:options.operationId,ownerEpoch:options.ownerEpoch,token,...value},()=>{});
  };
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(failure({code:'LOCK_GUARD_TIMEOUT',message:'Operation guard did not initialize in time'}));},10000);
    timer.unref();
    worker.once('error',reject);
    worker.once('exit',code=>reject(failure({code:'LOCK_GUARD_EXITED',message:stderr || `Operation guard exited ${code}`})));
    worker.on('message',message=>{
      if(message.type==='ready') {clearTimeout(timer);if(message.error)reject(failure(message.error));else resolve(message);return;}
      if(message.type==='reply') {const task=pending.get(message.id);pending.delete(message.id);if(task)message.error?task.reject(failure(message.error)):task.resolve(message.result);return;}
      if(message.type==='failure') {
        const error=failure(message.error),child=jobs.get(message.jobId);
        lease.emit('guard-failure',error);if(child?.listenerCount('error'))child.emit('error',error);
        return;
      }
      if(message.type!=='child')return;
      const child=jobs.get(message.jobId);if(!child)return;
      if(message.event==='spawn') {child.pid=message.pid;child.emit('spawn');}
      else if(['stdout','stderr'].includes(message.event))child[message.event].write(Buffer.from(message.data,'base64'));
      else if(message.event==='error')child.emit('error',failure(message.error));
      else if(message.event==='identity')child.emit('message',{type:'executor-identity',identity:message.identity});
      else {child.exitCode=message.code;child.signalCode=message.signal;
        if(message.event==='close'){child.stdout.end();child.stderr.end();jobs.delete(message.jobId);}child.emit(message.event,message.code,message.signal);}
    });
  });
  send({type:'initialize',directory:options.directory,probe});
  const state=await ready;
  if(probe) {await exited;const {type,...result}=state;return result;}
  if(state.busy) {await exited;throw failure({code:'OPERATION_BUSY',message:'Another operation or its maintenance child still owns this installation'});}
  Object.assign(lease,{spawn(command,args=[],childOptions={}) {
    if(closed)throw failure({code:'LOCK_GUARD_EXITED',message:'Operation lease has ended'});
    if(cancelling)throw failure({code:'LOCK_CANCELLING',message:'This operation is being cancelled'});
    if(typeof command!=='string' || !Array.isArray(args) || args.some(value=>typeof value!=='string'))throw new TypeError('Spawn command and arguments required');
    const kind=childOptions.kind || 'maintenance';
    if(!/^[a-z][a-z-]{0,63}$/.test(kind))throw new TypeError('Maintenance child kind is invalid');
    const options={...childOptions};delete options.kind;
    if(options.detached || options.shell || options.stdio)throw new TypeError('Maintenance children cannot detach, use shell or replace guard pipes');
    const jobId=crypto.randomUUID(),child=new EventEmitter();child.jobId=jobId;child.pid=undefined;child.exitCode=null;child.signalCode=null;child.killed=false;
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,encoding,callback){try{send({type:'stdin',jobId,data:Buffer.from(chunk).toString('base64')});callback();}catch(error){callback(error);}},
      final(callback){try{send({type:'stdin-end',jobId});callback();}catch(error){callback(error);}}});
    child.kill=(signal='SIGTERM')=>{if(closed || !jobs.has(jobId))return false;send({type:'kill',jobId,signal});child.killed=true;return true;};
    jobs.set(jobId,child);send({type:'spawn',jobId,command,args,kind,options,delegationToken:crypto.randomBytes(32).toString('hex')});return child;
  },cancel({signal='SIGTERM'}={}) {
    if(!['SIGTERM','SIGKILL','SIGINT'].includes(signal))throw new TypeError('Unsupported cancellation signal');
    cancelling=true;
    return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});
      try{send({type:'cancel',id,signal});}catch(error){pending.delete(id);reject(error);}});
  },assertActive(){if(closed||releasing||!worker.connected)throw failure({code:'LOCK_GUARD_LOST',message:'The operation writer is no longer active'});},
  commitOperation({record,expected,evidence,archive=false}){
    lease.assertActive();
    return new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(failure({code:'LOCK_GUARD_TIMEOUT',message:'Operation commit acknowledgement timed out'}));},10000);
      timer.unref();pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      try{send({type:'operation-commit',id,record,expected,evidence,archive});}
      catch(error){pending.delete(id);clearTimeout(timer);reject(error);}
    });
  },async release(){releasing=true;if(!closed)send({type:'release'});const result=await exited;
    if(result.code!==0)throw failure({code:'LOCK_GUARD_EXITED',message:'The operation guard did not close cleanly; child facts require inspection'});
  },snapshot(){
    return new Promise((resolve,reject)=>{const id=++sequence;
      const timer=setTimeout(()=>{pending.delete(id);reject(failure({code:'LOCK_GUARD_TIMEOUT',message:'Operation guard snapshot timed out'}));},10000);
      timer.unref();pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      try{send({type:'snapshot',id});}catch(error){pending.delete(id);clearTimeout(timer);reject(error);}});
  }});
  return lease;
}
module.exports={acquire:options=>connect(options),snapshot:options=>connect(options,true),probe:options=>connect(options,true)};
