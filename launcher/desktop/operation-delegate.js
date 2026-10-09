// A live guard acknowledgement, rather than an environment flag, delegates maintenance.
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const {PassThrough,Writable}=require('node:stream');
const fs=require('node:fs');
const path=require('node:path');
const run = promisify(execFile);
const failed = (code,message) => Object.assign(new Error(message),{code});
const diagnosticReasons=new Set(['non_project_frames_omitted','program_message_unreviewed','program_error_missing',
  'launch_log_empty_or_changed','launch_log_unavailable','unknown_evidence_gap']);
const diagnosticFrame=/^File "[A-Za-z0-9_.-]{1,120}\.(?:js|cjs|mjs)", line [1-9][0-9]{0,6}, in [A-Za-z_<>][A-Za-z0-9_<>.]{0,119}$/;
const diagnosticCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)
  ||Number.isInteger(value)&&value>=100&&value<=599;

// This module also ships beside operation_node.mjs. Keep the private protocol
// builtin-only; the guard injects the launcher's existing text sanitizer.
function projectDiagnostic(error,{text,directory}) {
  const state={truncated:false},seen=new Set();let nodes=0,frames=0;
  let projectRoot;
  try{projectRoot=fs.realpathSync(directory);}catch{}
  function visit(value) {
    if(!value||typeof value!=='object'||seen.has(value)||nodes>=4){state.truncated=true;return undefined;}
    seen.add(value);nodes++;
    const reasons=new Set(projectRoot?[]:['unknown_evidence_gap']);let message;
    try {
      message=text(value.message,1200,state);
      if(typeof message!=='string'||Buffer.byteLength(message)>1200)throw new Error('Invalid text projection');
      if(message==='[EVIDENCE UNAVAILABLE]')reasons.add('program_message_unreviewed');
    }catch{message='[EVIDENCE UNAVAILABLE]';reasons.add('program_message_unreviewed');state.truncated=true;}
    if(message.includes('\0'))state.truncated=true;
    const record={name:/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value.name||'')?value.name:'Error',
      message:message.replaceAll('\0',''),code:diagnosticCode(value.code)?value.code:null,stack:''};
    if(Array.isArray(value.missingReasons))for(const reason of value.missingReasons.slice(0,16))
      reasons.add(diagnosticReasons.has(reason)?reason:'unknown_evidence_gap');
    if(value.missingReasons?.length>16||value.truncated===true)state.truncated=true;
    const locations=[];
    for(const line of String(value.stack||'').split(/\r?\n/)) {
      if(!/^\s*at\s/.test(line))continue;
      const match=/^\s*at\s+(?:(.*?)\s+\()?(.+?):([1-9][0-9]{0,6})(?::[0-9]+)?\)?$/.exec(line);
      let filename,fn;
      try {
        filename=match&&fs.realpathSync(match[2]);fn=(match?.[1]||'<anonymous>').replace(/^(?:async|new)\s+/,'');
        if(!filename||path.dirname(filename)!==projectRoot||!fs.statSync(filename).isFile()
          ||!/^[A-Za-z0-9_.-]{1,120}\.(?:js|cjs|mjs)$/.test(path.basename(filename))
          ||!/^[A-Za-z_<>][A-Za-z0-9_<>.]{0,119}$/.test(fn))throw new Error('Non-project frame');
      }catch{reasons.add('non_project_frames_omitted');continue;}
      if(frames>=12){state.truncated=true;continue;}
      locations.push(`File "${path.basename(filename)}", line ${match[3]}, in ${fn}`);frames++;
    }
    record.stack=locations.join('\n');
    if(reasons.size)record.missingReasons=[...reasons];
    if(value.cause){const cause=visit(value.cause);if(cause)record.cause=cause;}
    if(Array.isArray(value.secondaryErrors)) {
      if(value.secondaryErrors.length>2)state.truncated=true;
      const secondary=value.secondaryErrors.slice(0,2).map(item=>visit(item?.error)).filter(Boolean);
      if(secondary.length)record.secondaryErrors=secondary.map(error=>({error}));
    }
    return record;
  }
  const root=visit(error)||{name:'Error',message:'Program error unavailable',code:null,stack:'',missingReasons:['program_error_missing']};
  root.truncated=state.truncated;
  // The node/message/frame limits normally stay below this final wire bound.
  if(Buffer.byteLength(JSON.stringify(root))>16*1024){delete root.cause;delete root.secondaryErrors;root.stack='';
    root.truncated=true;root.missingReasons=['unknown_evidence_gap'];}
  return root;
}

function restoreDiagnostic(fields) {
  let nodes=0,frames=0;
  function valid(value,root=false) {
    if(!value||typeof value!=='object'||Array.isArray(value)||++nodes>4)return false;
    const allowed=['name','message','code','stack','cause','secondaryErrors','missingReasons',...(root?['truncated']:[])];
    if(Object.keys(value).some(key=>!allowed.includes(key))||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value.name||'')
      ||typeof value.message!=='string'||value.message.includes('\0')||Buffer.byteLength(value.message)>1200
      ||value.code!==null&&!diagnosticCode(value.code)||typeof value.stack!=='string'||Buffer.byteLength(value.stack)>4096)return false;
    const locations=value.stack?value.stack.split('\n'):[];frames+=locations.length;
    if(frames>12||locations.some(line=>!diagnosticFrame.test(line)))return false;
    if(Object.hasOwn(value,'truncated')&&typeof value.truncated!=='boolean')return false;
    if(Object.hasOwn(value,'missingReasons')&&(!Array.isArray(value.missingReasons)||value.missingReasons.length>16
      ||value.missingReasons.some(reason=>!diagnosticReasons.has(reason))))return false;
    if(Object.hasOwn(value,'cause')&&!valid(value.cause))return false;
    if(Object.hasOwn(value,'secondaryErrors')&&(!Array.isArray(value.secondaryErrors)||value.secondaryErrors.length>2
      ||value.secondaryErrors.some(item=>!item||Object.keys(item).length!==1||!Object.hasOwn(item,'error')||!valid(item.error))))return false;
    return true;
  }
  function restore(value) {
    const error=new Error(value.message,value.cause?{cause:restore(value.cause)}:undefined);error.name=value.name;
    if(value.code!==null)error.code=value.code;error.stack=value.stack;
    if(value.missingReasons)error.missingReasons=[...value.missingReasons];
    if(value.secondaryErrors)error.secondaryErrors=value.secondaryErrors.map(item=>({error:restore(item.error)}));
    if(value.truncated!==undefined)error.truncated=value.truncated;
    return error;
  }
  let code,message;
  try{code=fields?.code;message=fields?.message;}catch{}
  const error=failed(code,message);
  try {
    const diagnostic=fields?.diagnostic;
    if(diagnostic) {
      if(!valid(diagnostic,true)||Buffer.byteLength(JSON.stringify(diagnostic))>16*1024)throw new Error('Invalid guard diagnostic');
      const original=restore(diagnostic);
      for(const key of ['name','stack','cause','secondaryErrors','truncated','missingReasons'])
        if(Object.hasOwn(original,key))error[key]=original[key];
      error.message=message;error.code=code;error.remoteMessage=diagnostic.message;
    }
  }catch{error.truncated=true;error.missingReasons=['unknown_evidence_gap'];}
  return error;
}

async function creationIdentity(pid=process.pid) {
  if(!Number.isSafeInteger(pid)||pid<1)throw failed('DELEGATION_IDENTITY_UNKNOWN','Executor PID is invalid');
  let value,precisionSeconds;
  if(process.platform==='darwin') {
    const result=await run('/bin/ps',['-p',String(pid),'-o','lstart='],{env:{...process.env,LC_ALL:'C'},timeout:10000});
    value=Date.parse(result.stdout.trim())/1000;precisionSeconds=1;
  } else if(process.platform==='win32') {
    const query=run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      `([DateTimeOffset](Get-Process -Id ${pid}).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`],
      // PowerShell can initialize a fresh Windows profile before the first
      // query. Keep the exact OS creation time check, with a bounded cold-start budget.
      {windowsHide:true,timeout:30000});
    query.child.stdin?.end();
    const result=await query;
    value=Number(result.stdout.trim())/1000;precisionSeconds=0.001;
  } else throw failed('DELEGATION_UNSUPPORTED','Operation delegation is unsupported on this platform');
  if(!Number.isFinite(value) || value<=0)throw failed('DELEGATION_IDENTITY_UNKNOWN','Executor creation time could not be established');
  return {pid,creationTime:value,precisionSeconds};
}

async function connect(options={}) {
  const env=options.env || process.env;
  const match=/^127\.0\.0\.1:(\d{1,5})$/.exec(env.NORA_OPERATION_DELEGATE_ENDPOINT || '');
  const token=env.NORA_OPERATION_DELEGATE_TOKEN,jobId=env.NORA_OPERATION_JOB_ID;
  if(!match || Number(match[1])>65535 || !/^[a-f\d]{64}$/.test(token || '') || !jobId)
    throw failed('DELEGATION_REQUIRED','Maintenance requires a live operation guard');
  const identity=options.identity || await creationIdentity();
  if(identity.pid!==process.pid || !Number.isFinite(identity.creationTime) || identity.creationTime<=0)
    throw failed('DELEGATION_IDENTITY_UNKNOWN','Executor identity is invalid');
  const socket=net.createConnection({host:'127.0.0.1',port:Number(match[1])});
  const result=new EventEmitter();result.active=false;
  let requestSequence=0;
  const requests=new Map(),children=new Map(),earlyEvents=new Map();
  function send(value){result.assertActive();socket.write(JSON.stringify(value)+'\n');}
  function rpc(type,fields={}){
    result.assertActive();const requestId=String(++requestSequence);
    return new Promise((resolve,reject)=>{requests.set(requestId,{resolve,reject});try{send({type,requestId,...fields});}catch(error){requests.delete(requestId);reject(error);}});
  }
  function dispatch(message){
    if(message.type==='reply'){
      const request=requests.get(message.requestId);if(!request)return;
      requests.delete(message.requestId);
      if(message.error)request.reject(restoreDiagnostic(message.error));else request.resolve(message.result);
      return;
    }
    if(message.type!=='child')return;
    const child=children.get(message.jobId);
    if(!child){const buffered=earlyEvents.get(message.jobId)||[];if(buffered.length>=128)throw failed('DELEGATION_INVALID_EVENT','Too many early executor events');buffered.push(message);earlyEvents.set(message.jobId,buffered);return;}
    if(message.event==='stdout'||message.event==='stderr')child[message.event].write(Buffer.from(message.data,'base64'));
    else if(message.event==='spawn'){child.pid=message.pid;child.emit('spawn');}
    else if(message.event==='exit'){child.exitCode=message.code;child.signalCode=message.signal;child.emit('exit',message.code,message.signal);}
    else if(message.event==='error'){const error=restoreDiagnostic(message.error);if(child.listenerCount('error'))child.emit('error',error);}
    else if(message.event==='close'){
      child.exitCode=message.code;child.signalCode=message.signal;child.stdout.end();child.stderr.end();children.delete(message.jobId);child.emit('close',message.code,message.signal);
    }else if(message.event==='identity')child.emit('identity',message.identity);
  }
  result.identity=identity;
  result.assertActive=()=>{if(!result.active)throw failed('DELEGATION_LOST','The operation guard is no longer connected');};
  result.close=()=>{result.active=false;socket.destroy();};
  let frame='',acknowledged=false;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.destroy();reject(failed('DELEGATION_TIMEOUT','Operation delegation did not acknowledge in time'));},options.timeoutMs || 10000);
    const stop=error=>{clearTimeout(timer);reject(error);};
    socket.once('error',error=>stop(failed('DELEGATION_LOST',error.message)));
    socket.once('close',()=>{
      result.active=false;
      if(!acknowledged)stop(failed('DELEGATION_LOST','Operation guard disconnected before acknowledgement'));
      for(const request of requests.values())request.reject(failed('DELEGATION_LOST','The operation guard disconnected'));requests.clear();
      for(const child of children.values()){child.stdout.end();child.stderr.end();child.emit('guard-lost');}
      result.emit('lost');
    });
    socket.once('connect',()=>socket.write(JSON.stringify({schema:'nora-operation-executor/1',jobId,token,...identity})+'\n'));
    socket.on('data',data=>{
      frame+=data.toString('utf8');
      const limit=acknowledged?256*1024:8192;
      while(frame.includes('\n')){
      const split=frame.indexOf('\n'),line=frame.slice(0,split);frame=frame.slice(split+1);
      if(line.length>limit){socket.destroy();stop(failed('DELEGATION_REJECTED','Invalid guard message'));return;}
      try {
        const ack=JSON.parse(line);
        if(acknowledged){dispatch(ack);continue;}
        if(ack.schema!=='nora-operation-delegation-ack/1' || ack.token!==token || ack.jobId!==jobId
            || ack.operationId!==env.NORA_OPERATION_ID || String(ack.ownerEpoch)!==env.NORA_OPERATION_OWNER_EPOCH)
          throw new Error('Guard did not acknowledge this operation');
        clearTimeout(timer);acknowledged=true;result.active=true;
        result.context={operationId:ack.operationId,ownerEpoch:ack.ownerEpoch,jobId};resolve();
      } catch(error){socket.destroy();stop(failed('DELEGATION_REJECTED',error.message));return;}
      }
      if(frame.length>limit){socket.destroy();stop(failed('DELEGATION_REJECTED','Invalid guard message'));}
    });
  });
  result.spawn=async(command,args=[],spawnOptions={})=>{
    const {kind,...options}=spawnOptions;
    const response=await rpc('spawn',{command,args,kind,options});
    const child=new EventEmitter();child.jobId=response.jobId;child.pid=undefined;child.exitCode=null;child.signalCode=null;
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,encoding,callback){
      (async()=>{for(let start=0;start<chunk.length;start+=32768)await rpc('stdin',{jobId:child.jobId,data:chunk.subarray(start,start+32768).toString('base64')});})().then(()=>callback(),callback);
    },final(callback){rpc('stdin-end',{jobId:child.jobId}).then(()=>callback(),callback);}});
    child.stdin.on('error',()=>{});
    child.kill=signal=>rpc('kill',{jobId:child.jobId,signal:signal||'SIGTERM'}).then(value=>value.sent);
    children.set(child.jobId,child);
    const buffered=earlyEvents.get(child.jobId);earlyEvents.delete(child.jobId);
    if(buffered)setImmediate(()=>buffered.forEach(dispatch));
    return child;
  };
  result.run=async(command,args=[],options={})=>{
    const {timeoutMs=60000,maxOutputBytes=2*1024*1024,input,...spawnOptions}=options;
    const child=await result.spawn(command,args,spawnOptions);let stdout='',stderr='',spawnError,timedOut=false,truncated=false;
    const capture=stream=>value=>{const available=maxOutputBytes-Buffer.byteLength(stream==='stdout'?stdout:stderr);if(available<value.length)truncated=true;
      const text=value.subarray(0,Math.max(0,available)).toString('utf8');if(stream==='stdout')stdout+=text;else stderr+=text;};
    child.stdout.on('data',capture('stdout'));child.stderr.on('data',capture('stderr'));child.on('error',error=>spawnError=error);
    if(input!==undefined)child.stdin.end(input);else child.stdin.end();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL').catch(reject);},timeoutMs);timer.unref();
      child.once('guard-lost',()=>{clearTimeout(timer);reject(failed('DELEGATION_LOST','The guard stopped before confirming executor closure'));});
      child.once('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal,stdout,stderr,outputTruncated:truncated,
        error:spawnError||(timedOut?failed('ETIMEDOUT','Maintenance command exceeded its deadline'):undefined)});});
    });
  };
  return result;
}
module.exports={connect,creationIdentity,projectDiagnostic,restoreDiagnostic};
