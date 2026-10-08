const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Presentation of our own event records only. Native output is already text;
// preserve indentation and tracebacks instead of rendering its JSON envelope.
function consoleRecord(record) {
  const error = Boolean(record.error) || record.event === 'error' || /failed|timeout/.test(record.event || '');
  if (record.event === 'log') return { text: String(record.line ?? ''), error: record.stream === 'stderr' && /Error|Exception|Traceback|错误|失败/i.test(record.line || '') };
  const timestamp = record.timestamp || '';
  const detail = value => {
    if (!value) return '';
    const parts = [value.stack || `${value.name || 'Error'}: ${value.message || ''}`];
    for (const key of ['code','userCode','source','site','status','errno','syscall','exitCode','signal','context']) if (value[key] !== undefined && value[key] !== null)
      parts.push(`${key}=${typeof value[key]==='object'?JSON.stringify(value[key]):value[key]}`);
    if (value.cause) parts.push('Caused by:', detail(value.cause));
    for (const item of value.secondaryErrors || []) parts.push(`Secondary (${item.operation || 'cleanup'}):`, detail(item.error));
    return parts.join('\n');
  };
  const names = { 'run.start':'START', 'run.end':record.outcome === 'failed' ? 'ERROR' : 'DONE',
    task:'START', milestone:record.state === 'error' ? 'ERROR' : record.state === 'done' ? 'DONE' : 'INFO',
    warning:'WARNING', error:'ERROR', command:'INFO', progress:'INFO' };
  const level = error ? 'ERROR' : names[record.event] || 'INFO';
  let message;
  if (record.event === 'run.start') message = `operation=${record.operationId} action=${record.action || ''}`;
  else if (record.event === 'run.end') message = `outcome=${record.outcome}`;
  else if (record.event === 'progress') message = `${record.task || record.stage_id || record.stage || ''} ${record.current ?? ''}${record.total > 0 ? ' / ' + record.total : ''}${record.unit ? ' ' + record.unit : ''}`;
  else if (record.event === 'command') message = Array.isArray(record.command) ? record.command.join(' ') : record.command;
  else message = record.task || record.message || record.event;
  const facts = ['version','channel','platform','arch','node','electron','python','cwd','pid','exitCode','signal','durationMs','source','site',
    'state','effectState','verification','recoveryOutcome','evidenceStatus'];
  const context = facts.filter(key => record[key] !== undefined && record[key] !== null).map(key => `${key}=${typeof record[key] === 'object' ? JSON.stringify(record[key]) : record[key]}`);
  return { text:`[${level}] ${timestamp} ${message || ''}${context.length ? ' ' + context.join(' ') : ''}${record.error ? '\n' + detail(record.error) : ''}`, error,
    ...(record.event==='run.start'?{outcome:null,action:record.action}:record.event==='run.end'?{outcome:record.outcome}:{} ) };
}

function trimLegacyLog(file) {
  const size = fs.statSync(file).size;
  if (size <= MAX_LOG_BYTES) return;
  const marker = Buffer.from(`${JSON.stringify({ event: 'log.history-trimmed', timestamp: new Date().toISOString(), originalBytes: size })}\n`);
  const tail = Buffer.alloc(MAX_LOG_BYTES - marker.length);
  const fd = fs.openSync(file, 'r');
  let read;
  try { read = fs.readSync(fd, tail, 0, tail.length, size - tail.length); }
  finally { fs.closeSync(fd); }
  // Drop the partial first record, retaining only complete recent JSONL lines.
  const bytes = tail.subarray(0, read);
  const newline = bytes.indexOf(10);
  fs.writeFileSync(file, Buffer.concat([marker, newline < 0 ? Buffer.alloc(0) : bytes.subarray(newline + 1)]), { mode: 0o600 });
}

function appendLogLine(file, line) {
  let size = 0;
  try { size = fs.statSync(file).size; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size && size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
    for (const name of [file, `${file}.1`]) {
      try { trimLegacyLog(name); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.rmSync(`${file}.2`, { force: true });
    try { fs.renameSync(`${file}.1`, `${file}.2`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, line, { mode: 0o600 });
}

function appendRecord(file, record) {
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) + 1 <= MAX_LOG_BYTES) {
    appendLogLine(file, `${json}\n`);
    return;
  }
  // Oversized records remain recoverable without splitting UTF-8 or JSON escapes.
  const encoded = Buffer.from(json).toString('base64');
  const chunkSize = MAX_LOG_BYTES - 1024;
  const id = randomUUID();
  const total = Math.ceil(encoded.length / chunkSize);
  for (let index = 0; index < total; index++) {
    appendLogLine(file, `${JSON.stringify({ event: 'log.fragment', id, index, total, encoding: 'base64-json',
      data: encoded.slice(index * chunkSize, (index + 1) * chunkSize) })}\n`);
  }
}

// Explicit fields avoid accidentally serializing request bodies or environments.
function errorDetails(error, seen = new Set()) {
  if (!error || typeof error !== 'object') return { message: String(error) };
  if (seen.has(error)) return { message: '[circular error]' };
  seen.add(error);
  const details = {};
  for (const key of ['name', 'message', 'stack', 'code', 'userCode', 'source', 'site', 'status', 'errno', 'syscall', 'path', 'dest', 'signal', 'exitCode', 'context']) {
    if (error[key] !== undefined) details[key] = error[key];
  }
  if (error.cause) details.cause = errorDetails(error.cause, seen);
  if (error.errors) details.errors = Array.from(error.errors, item => errorDetails(item, seen));
  if (error.secondaryErrors) details.secondaryErrors = error.secondaryErrors.map(item => ({
    operation: item.operation, error: errorDetails(item.error, seen),
  }));
  return details;
}

function createDiagnostics({ primary, fallback }) {
  const secrets = new Set();
  const scopes = new AsyncLocalStorage();
  let runId = `startup-${randomUUID()}`;
  let operationId = randomUUID();
  let started = Date.now();
  let stage = 'startup';
  let lastFile = '';
  let recordOrder = 0;
  const sensitive = /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|pair[_-]?code)$/i;
  function addSecret(value) { if (typeof value === 'string' && value) secrets.add(value); }
  function text(value) {
    let result = String(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
        result = result.split(form).join('[REDACTED]');
      }
    }
    return result
      .replace(/\b(?:sk|sk-ant)-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
      .replace(/((?:[\w-]*(?:api[_-]?key|token|secret|password|pair[_-]?code)|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&][\w.-]+=)[^\s&#"'<>]+/g, '$1[REDACTED]');
  }
  function clean(value, key = '') {
    if (sensitive.test(key) || key === 'code' && typeof value === 'string' && !/^[A-Z_]+$/.test(value)) return '[REDACTED]';
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((item, index) => {
      if (key === 'command' && index > 0 && /^--?(?:key|api-key|token|password|code|pair-code)$/.test(String(value[index - 1]))) return '[REDACTED]';
      return clean(item);
    });
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, name)]));
    return value;
  }
  function write(event, fields = {}) {
    const context = scopes.getStore();
    // Same-millisecond writes keep their real order when the primary fails
    // and the logger switches to the fallback. This remains local metadata.
    recordOrder=Math.max(Date.now()*1024,recordOrder+1);
    const record = { ...fields, recordId:randomUUID(), recordOrder, timestamp: new Date().toISOString(), runId:context?.runId || runId,
      operationId:context?.operationId || operationId, stage:context?.stage || stage, elapsedMs: Date.now() - (context?.started || started), event };
    const append = file => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      appendRecord(file, clean(record));
      lastFile = file;
    };
    try { append(primary()); }
    catch (error) {
      record.logWriteError = errorDetails(error);
      try { append(fallback); }
      catch (fallbackError) {
        // Logging failure must not replace the installation's original error.
        try { process.stderr.write(`${JSON.stringify(clean({ ...record, fallbackError: errorDetails(fallbackError) }))}\n`); } catch {}
      }
    }
  }
  function readOperation(id = operationId, cursor = {}) {
    if (!UUID.test(id || '')) throw new TypeError('Invalid log operation ID');
    const previous = cursor && cursor.operationId === id && cursor.offsets && typeof cursor.offsets === 'object' ? cursor.offsets : {};
    const offsets = {}, records = [], missing = new Set();
    const files = [...new Set([primary(), fallback].filter(file => typeof file === 'string' && file))]
      .flatMap(file => [file + '.2', file + '.1', file]);
    const maximum=256*1024,readers=[],found=new Set(),dropping={};
    let budget=maximum,pendingTail=false;
    for (const file of files) {
      let fd;
      try {
        // The configured directory is trusted, including OS aliases such as
        // macOS /var -> /private/var; the log itself must be a regular file.
        if (fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error('Linked log'), {code:'LOG_PATH'});
        const target = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
        fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_LOG_BYTES) throw Object.assign(new Error('Invalid log'), {code:'LOG_PATH'});
        const identity = `${stat.dev}:${stat.ino}`;
        if(found.has(identity)){fs.closeSync(fd);fd=undefined;continue;}found.add(identity);
        const value = previous[identity];
        const position = Number.isSafeInteger(value) && value >= 0 && value <= stat.size ? value : 0;
        readers.push({fd,identity,size:stat.size,position,buffer:Buffer.alloc(0),dropping:cursor?.operationId===id&&cursor?.dropping?.[identity]===true});
        fd=undefined;
      } catch (error) {
        if (error.code !== 'ENOENT') missing.add(error.code === 'LOG_PATH' || error.code === 'ELOOP' ? 'log_path_rejected' : 'log_read_failed');
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    // Merge file heads before consuming them. Sorting each returned batch
    // after draining the primary would still put later primary output before
    // earlier fallback output in the next batch.
    function peek(reader){
      if(reader.head)return reader.head;
      let newline=reader.buffer.indexOf(10);
      while(newline<0&&reader.buffer.length<maximum&&reader.position+reader.buffer.length<reader.size){
        const bytes=Buffer.alloc(Math.min(4096,maximum-reader.buffer.length,reader.size-reader.position-reader.buffer.length));
        const length=fs.readSync(reader.fd,bytes,0,bytes.length,reader.position+reader.buffer.length);
        if(!length)break;reader.buffer=Buffer.concat([reader.buffer,bytes.subarray(0,length)]);newline=reader.buffer.indexOf(10);
      }
      if(newline<0&&reader.buffer.length<maximum){if(reader.buffer.length)pendingTail=true;return null;}
      const bytes=newline<0?maximum:newline+1;
      let record,reason;
      if(reader.dropping||newline<0)reason='console_record_too_large';
      else try{record=JSON.parse(reader.buffer.subarray(0,newline).toString('utf8'));}
      catch{reason='log_record_invalid';}
      if(record?.event==='log.fragment'||record?.event==='log.history-trimmed')reason='log_history_trimmed';
      const legacyTime=Date.parse(record?.timestamp);
      const order=Number.isSafeInteger(record?.recordOrder)?record.recordOrder:Number.isFinite(legacyTime)?legacyTime*1024:-Infinity;
      if(record&&!Number.isFinite(order))reason='log_record_invalid';
      return reader.head={record,reason,order,bytes,dropping:newline<0};
    }
    let hasMore=false;
    try{
      while(budget>0){
        const heads=readers.map(reader=>({reader,head:peek(reader)})).filter(value=>value.head);
        if(!heads.length)break;
        heads.sort((a,b)=>a.head.order-b.head.order);
        const {reader,head}=heads[0];
        if(head.bytes>budget){hasMore=true;break;}
        if(head.record?.operationId===id&&!Number.isSafeInteger(head.record.recordOrder)
          &&heads.some(value=>value.reader!==reader&&value.head.record?.operationId===id&&value.head.order===head.order))missing.add('log_order_unknown');
        const position=reader.position;reader.position+=head.bytes;reader.buffer=reader.buffer.subarray(head.bytes);reader.dropping=head.dropping;reader.head=null;budget-=head.bytes;
        if(head.reason){missing.add(head.reason);continue;}
        if(head.record?.operationId!==id)continue;
        const item=consoleRecord(clean(head.record));
        records.push({id:head.record.recordId||`${reader.identity}:${position}`,...item,
          upload:head.record.event!=='log'||head.record.uploadScope==='maintenance'});
      }
    }catch{missing.add('log_read_failed');}
    finally{for(const reader of readers){offsets[reader.identity]=reader.position;
      if(reader.dropping)dropping[reader.identity]=true;
      if(reader.head||!budget&&reader.position<reader.size)hasMore=true;
      fs.closeSync(reader.fd);
    }}
    if (Object.keys(previous).some(identity => !found.has(identity))) missing.add('log_history_trimmed');
    return { operationId:id, records, cursor:{operationId:id,offsets,dropping}, hasMore,pendingTail, missing:[...missing] };
  }
  return {
    addSecret, clean, write, readOperation,
    async scope(id, fields, work) {
      if (!UUID.test(id || '')) throw new TypeError('Invalid log operation ID');
      return scopes.run({operationId:id,runId:id,stage:'starting',started:Date.now()},async()=>{
        write('run.start',fields);
        let outcome='succeeded';
        try { const result=await work(); if(result?.diagnosticError){outcome='failed';write('run.failed',{error:errorDetails(result.diagnosticError)});}
          return result&&typeof result==='object'&&!Array.isArray(result)?{...result,logOperationId:id}:result; }
        catch(error){outcome='failed';write('run.failed',{error:errorDetails(error)});
          if(error&&typeof error==='object')try{error.logOperationId=id;}catch{}
          throw error;}
        finally{write('run.end',{outcome,durationMs:Date.now()-scopes.getStore().started});}
      });
    },
    get lastFile() { return lastFile; },
    get operationId() { return operationId; },
    begin(id, fields) {
      runId = id;
      operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(fields?.operationId || '') ? fields.operationId : randomUUID();
      started = Date.now(); stage = 'starting';
      write('run.start', fields); return operationId;
    },
    event(message) {
      if (message.event === 'heartbeat' || message.event === 'result') return;
      if (message.task) { const context=scopes.getStore(); if(context)context.stage=message.task;else stage=message.task; }
      write(message.event, message);
    },
    error(event, error, fields = {}) { write(event, { ...fields, error: errorDetails(error) }); },
    finish(outcome) { write('run.end', { outcome, durationMs: Date.now() - started }); },
  };
}

module.exports = { createDiagnostics, errorDetails };
