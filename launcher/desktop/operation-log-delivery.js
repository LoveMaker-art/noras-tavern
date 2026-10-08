const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ENDPOINT='https://noratavern.com/api/launcher/logs';
const MAX_STATE=2*1024*1024;
const missingReasons=new Set(['log_path_rejected','log_read_failed','log_record_invalid','log_history_trimmed','log_order_unknown','console_record_too_large',
  'service_output_omitted','sensitive_content_omitted','redaction_failed','source_missing','chunk_limit']);

// A transport cursor over the existing logger, not a second log collector.
// One immutable pending batch survives lost ACKs/restarts; only an exact ACK
// advances it. No user-configured paths, auth credentials or raw service logs.
function createOperationLogDelivery({file,read,project,consent,fetcher=globalThis.fetch,now=Date.now,diagnostic=()=>{}}){
  let state={schema:1,jobs:[]},broken=false,sending=false,controller,generation=0;
  try{
    if(fs.existsSync(file)){
      if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>MAX_STATE)throw Error('invalid outbox');
      state=JSON.parse(fs.readFileSync(file,'utf8'));
      if(state.schema!==1||!Array.isArray(state.jobs)||state.jobs.length>64)throw Error('invalid outbox');
      for(const job of state.jobs)if(!UUID.test(job.id)||!UUID.test(job.logId)||!UUID.test(job.installation)||!UUID.test(job.consent)
        ||!Number.isInteger(job.index)||job.index<0||job.index>4096||!Number.isSafeInteger(job.started)
        ||typeof job.closed!=='boolean'||!Array.isArray(job.pending))throw Error('invalid job');
    }
  }catch{broken=true;diagnostic('raw_log_state_unreadable');}
  function save(){
    if(broken)return false;
    const temporary=file+'.'+randomUUID()+'.tmp';
    try{
      const data=JSON.stringify(state);if(Buffer.byteLength(data)>MAX_STATE)throw Error('capacity');
      fs.mkdirSync(path.dirname(file),{recursive:true});
      if(fs.lstatSync(file,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('linked outbox');
      const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,file);return true;
    }catch{broken=true;diagnostic('raw_log_queue_save_failed');return false;}
    finally{try{fs.rmSync(temporary,{force:true});}catch{}}
  }
  const allowed=job=>{const choice=consent();return choice.enabled===true&&choice.id===job.consent&&choice.installation===job.installation;};
  function sync(){
    const keep=state.jobs.filter(allowed);
    if(keep.length!==state.jobs.length){generation++;controller?.abort();state.jobs=keep;save();}
  }
  function begin(id){
    if(broken||!UUID.test(id))return;sync();
    const choice=consent();if(!choice.enabled||!UUID.test(choice.id)||!UUID.test(choice.installation)||state.jobs.some(job=>job.id===id&&!job.closed))return;
    state.jobs=state.jobs.filter(job=>!job.done);
    if(state.jobs.length>=64){diagnostic('raw_log_queue_capacity');return;}
    state.jobs.push({id,logId:randomUUID(),installation:choice.installation,consent:choice.id,started:now(),index:0,closed:false,done:false,cursor:null,pending:[],due:0,attempts:0});save();
  }
  function finish(id,outcome='failed'){
    const job=state.jobs.findLast(job=>job.id===id&&!job.closed);
    if(job){job.closed=true;job.outcome=outcome;if(!['failed','interrupted'].includes(outcome))state.jobs=state.jobs.filter(value=>value!==job);save();}
  }
  function chunks(text){
    const parts=[];let line='',bytes=0;
    for(const character of text){const length=Buffer.byteLength(character);if(bytes+length>16384){parts.push(line);line='';bytes=0;}line+=character;bytes+=length;}
    if(line)parts.push(line);return parts;
  }
  async function flush(){
    if(broken||sending)return;
    sync();const job=state.jobs.find(job=>job.closed&&!job.done&&!job.blocked&&job.due<=now());if(!job)return;
    if(now()-job.started>7*86400000){job.blocked='expired';save();diagnostic('raw_log_expired');return;}
    sending=true;const version=generation;
    try{
      if(!job.pending.length){
        const result=read(job.id,job.cursor);
        const missing=new Set(result.missing.filter(reason=>missingReasons.has(reason)));
        if(result.pendingTail)missing.add('log_record_invalid');
        const records=[];
        for(const record of result.records){
          if(record.upload===false){missing.add('service_output_omitted');continue;}
          const text=project(record.text);
          if(text.includes('[CONTENT OMITTED]'))missing.add('sensitive_content_omitted');
          if(text==='[EVIDENCE UNAVAILABLE]')missing.add('redaction_failed');
          records.push(text+'\n');
        }
        if(job.closed&&!result.records.length&&!job.index)missing.add('source_missing');
        const final=job.closed&&!result.hasMore;
        const parts=chunks(records.join(''));if(!parts.length&&final)parts.push('');
        if(!parts.length){job.cursor=result.cursor;save();return;}
        if(job.index+parts.length>4096||job.index+parts.length===4096&&!final){parts.splice(Math.max(0,4096-job.index));missing.add('chunk_limit');}
        job.nextCursor=result.cursor;
        job.pending=parts.map((text,offset)=>{
          const index=job.index+offset,isFinal=offset===parts.length-1&&(final||missing.has('chunk_limit'));
          const reasons=offset===parts.length-1?[...missing]:[];
          return {schema:1,installation_id:job.installation,operation_id:job.id,log_id:job.logId,index,text,final:isFinal,missing:reasons,
            chunk_id:createHash('sha256').update(JSON.stringify([job.id,job.logId,index,text,isFinal,reasons])).digest('hex')};
        });
        if(!save())return;
      }
      // One request per flush keeps statistics responsive and bounds work.
      const chunk=job.pending[0];if(!chunk)return;
      // Re-project persisted content before sending. A modified outbox cannot
      // inject a path or a credential into a previously redacted batch.
      const keys=['schema','installation_id','operation_id','log_id','index','text','final','missing','chunk_id'];
      if(Object.keys(chunk).length!==keys.length||!keys.every(key=>Object.hasOwn(chunk,key))||chunk.schema!==1||typeof chunk.final!=='boolean'
        ||chunk.operation_id!==job.id||chunk.log_id!==job.logId||chunk.installation_id!==job.installation||chunk.index!==job.index
        ||typeof chunk.text!=='string'||project(chunk.text)!==chunk.text||Buffer.byteLength(chunk.text)>16384
        ||!Array.isArray(chunk.missing)||!chunk.missing.every(reason=>missingReasons.has(reason))
        ||createHash('sha256').update(JSON.stringify([job.id,job.logId,chunk.index,chunk.text,chunk.final,chunk.missing])).digest('hex')!==chunk.chunk_id){
        job.blocked='invalid_chunk';save();diagnostic('raw_log_invalid_chunk');return;
      }
      controller=new AbortController();const timer=setTimeout(()=>controller?.abort(),10000);timer.unref?.();
      let response;try{response=await fetcher(ENDPOINT,{method:'POST',redirect:'error',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify(chunk),signal:controller.signal});}
      finally{clearTimeout(timer);}
      if(version!==generation||!allowed(job))return;
      if([400,401,403,404,409].includes(response.status)){job.blocked=`http_${response.status}`;save();diagnostic(`raw_log_${job.blocked}`);return;}
      if(!response.ok)throw Error('transport');
      const ack=await response.json();if(ack.accepted!==true||ack.index!==chunk.index||ack.chunk_id!==chunk.chunk_id)throw Error('unacknowledged');
      job.index++;job.pending.shift();job.attempts=0;job.due=0;
      if(!job.pending.length){job.cursor=job.nextCursor;delete job.nextCursor;}
      if(chunk.final)job.done=true;
      save();
    }catch{
      if(version===generation&&allowed(job)){job.attempts++;job.due=now()+Math.min(300000,5000*2**Math.min(job.attempts,6));save();diagnostic('raw_log_delivery_delayed');}
    }finally{sending=false;controller=null;}
  }
  function relocate(next){
    if(next===file)return true;
    if(broken||fs.existsSync(next))return false;
    generation++;controller?.abort();
    const previous=file;file=next;
    if(!save()){file=previous;return false;}
    try{fs.rmSync(previous,{force:true});}catch{diagnostic('raw_log_previous_state_retained');}
    return true;
  }
  return {begin,finish,sync,flush,relocate,close(){generation++;controller?.abort();},
    summary:id=>{const job=state.jobs.findLast(job=>job.id===id);return job?{logId:job.logId,received:job.index,queued:job.pending.length,complete:job.done,blocked:job.blocked||'',unavailable:broken}:null;}};
}
module.exports={createOperationLogDelivery};
