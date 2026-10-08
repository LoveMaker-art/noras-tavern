const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createFaultPackets } = require('./fault-packet');
const { programFacts, programIdentity } = require('./launcher-errors');
const OPERATION_BUDGET=require('../operation-budget.json');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEFAULT_LIMITS = Object.freeze({ bytes: OPERATION_BUDGET.evidenceBytes, records: 128, messageBytes: 4096, frames: 24, errorNodes: 8,
  globalBytes:OPERATION_BUDGET.globalBytes,historyCapacity:OPERATION_BUDGET.historyCapacity+OPERATION_BUDGET.stopReserve,ackCapacity:OPERATION_BUDGET.ackCapacity });

// Local, reviewed technical evidence. This module has no upload capability and
// never opens service logs, configuration files or subprocess output files.
function createEvidenceStore({ directory, clean = value => value, redact = value => value, limits = {} } = {}) {
  const budget = { ...DEFAULT_LIMITS, ...limits };
  if(!Number.isSafeInteger(budget.historyCapacity)||budget.historyCapacity<1||!Number.isSafeInteger(budget.ackCapacity)||budget.ackCapacity<1
    ||!Number.isSafeInteger(budget.globalBytes)||budget.globalBytes<=budget.historyCapacity*budget.ackCapacity)
    throw new TypeError('Evidence budget must reserve every bounded delivery file');
  const dataBudget=budget.globalBytes-budget.historyCapacity*budget.ackCapacity;
  const projection = createFaultPackets({ clean: value => redact(clean(value)) });
  const clone = value => JSON.parse(JSON.stringify(value));
  const unwritten=new Map();let usageCache;
  const operations=()=>path.join(path.resolve(typeof directory==='function'?directory():directory),'operations');
  const generationFile=()=>path.join(operations(),'.evidence-generation.json');
  function generation(){try{
    const stat=fs.lstatSync(generationFile());if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256)return null;
    const value=JSON.parse(fs.readFileSync(generationFile(),'utf8'));return value.schema===1&&UUID.test(value.id)&&value.writing===false?value.id:null;
  }catch{return null;}}
  function mark(writing){
    fs.mkdirSync(operations(),{recursive:true,mode:0o700});
    const file=generationFile(),temporary=file+'.'+randomUUID()+'.tmp',id=randomUUID();
    if(fs.lstatSync(file,{throwIfNoEntry:false})?.isSymbolicLink())throw Object.assign(new Error('Evidence generation is linked'),{code:'EVIDENCE_PATH'});
    try{fs.writeFileSync(temporary,JSON.stringify({schema:1,id,writing}),{mode:0o600});fs.renameSync(temporary,file);}
    finally{fs.rmSync(temporary,{force:true});}return id;
  }
  function fileBytes(target,names){return names.reduce((sum,name)=>{
    checkPath(target,name);return sum+(fs.lstatSync(path.join(target,name),{throwIfNoEntry:false})?.size||0);
  },0);}
  function retainedBytes(){
    const id=generation();if(id&&usageCache?.id===id)return usageCache.bytes;
    let names;try{names=fs.readdirSync(operations()).filter(name=>UUID.test(name));}catch(error){if(error.code==='ENOENT')return 0;throw error;}
    if(names.length>budget.historyCapacity)throw Object.assign(new Error('Evidence history capacity exceeded'),{code:'CAPACITY'});
    let bytes=0;for(const name of names)bytes+=fileBytes(location(name),['metadata.json','events.jsonl','python.json']);
    if(id&&generation()===id)usageCache={id,bytes};else usageCache=null;return bytes;
  }
  function location(operationId) {
    if (!UUID.test(operationId || '')) throw new TypeError('Invalid evidence operation ID');
    return path.join(path.resolve(typeof directory === 'function' ? directory() : directory), 'operations', operationId, 'evidence');
  }
  function checkPath(target, file = '') {
    const root = path.resolve(target, '../../..');
    let current = root;
    for (const part of path.relative(root, target).split(path.sep).concat(file ? [file] : [])) {
      current = path.join(current, part);
      let entry;
      try { entry = fs.lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const finalFile = Boolean(file) && current === path.join(target, file);
      if (entry.isSymbolicLink() || (finalFile ? !entry.isFile() : !entry.isDirectory())) {
        throw Object.assign(new Error('Evidence path must remain inside its operation directory'), { code: 'EVIDENCE_PATH' });
      }
    }
  }
  function missing(state, reason) {
    if (state.missingReasons.includes(reason)) return false;
    if (state.missingReasons.length >= 16) { state.truncated = true; return false; }
    state.missingReasons.push(reason);
    return true;
  }
  function text(value, limit, state) {
    let result = projection.text(value, Number.MAX_SAFE_INTEGER);
    if (result.includes('[CONTENT OMITTED]')) missing(state, 'sensitive_content_omitted');
    if (result === '[EVIDENCE UNAVAILABLE]') missing(state, 'redaction_failed');
    if (Buffer.byteLength(result) > limit) state.truncated = true;
    result = result.slice(0, limit);
    while (Buffer.byteLength(result) > limit) result = result.slice(0, -1);
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    return result;
  }
  function privateFields(value, state) {
    if (Object.keys(value || {}).some(key => /^(?:body|response|request|headers|env|config|messages|prompt|content|api[_-]?key|token|password|output|stdout|stderr)$/i.test(key))) {
      missing(state, 'sensitive_fields_omitted');
    }
  }
  function project(error, state, maximum = budget.errorNodes) {
    const seen = new Set();
    function visit(value) {
      if (!value || typeof value !== 'object' || seen.has(value)) return null;
      if (seen.size >= maximum) { state.truncated = true; return null; }
      seen.add(value);
      privateFields(value, state);
      const facts = programFacts(value);
      state.truncated ||= facts.truncated === true;
      for (const reason of facts.missingReasons || []) missing(state, reason);
      const message = text(value.source === 'model_service' ? 'Model request failed; see technical status.' : value.remoteMessage ?? value.message, budget.messageBytes, state);
      const frames = String(value.stack || '').split(/\r?\n/).filter(line => /^\s*(?:at\s|File\s+["'])/.test(line));
      if (frames.length > budget.frames) state.truncated = true;
      const item = {
        ...programIdentity(value), message,
        frames: frames.slice(-budget.frames).map(frame => text(frame.trim(), 240, state)),
        ...facts,
      };
      const cause = visit(value.cause);
      if (cause) item.cause = cause;
      return item;
    }
    return visit(error);
  }
  function technicalContext(value, state) {
    privateFields(value, state);
    const result = {};
    for (const key of ['stage', 'action', 'component', 'source', 'site', 'operation', 'status', 'program']) {
      if (typeof value?.[key] === 'string') result[key] = text(value[key], 120, state);
    }
    for (const key of ['pid', 'exitCode', 'httpStatus', 'durationMs']) {
      if (Number.isSafeInteger(value?.[key])) result[key] = value[key];
    }
    return result;
  }
  function deliveryContext(value, state) {
    privateFields(value, state);
    if (value?.operationId !== undefined && value.operationId !== state.operationId) return null;
    const result = {};
    if (value?.schema === 1) result.schema = 1;
    if (value?.operationId === state.operationId) result.operationId = state.operationId;
    // Legacy delivery status remains readable; new summaries carry explicit
    // counts and ACK facts, never the application's outcome.
    if (['pending', 'failed', 'accepted', 'paused'].includes(value?.status)) result.status = value.status;
    for (const key of ['queued', 'accepted', 'rejected', 'expired', 'evicted', 'paused', 'detail_suppressed']) {
      if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
    }
    if (value?.last_http === null || Number.isInteger(value?.last_http) && value.last_http >= 100 && value.last_http <= 599) result.last_http = value.last_http;
    if (value?.last_ack === null || Number.isSafeInteger(value?.last_ack) && value.last_ack >= 0) result.last_ack = value.last_ack;
    const labels = new Set(['', 'rate_limited', 'response', 'unacknowledged', 'conflicting_ack', 'transport_failed',
      'queue_save_failed', 'invalid_event', 'identity_conflict', 'expired', 'evicted', 'paused', 'http_4xx', 'http_5xx']);
    if (labels.has(value?.last_error) || /^http_[45]\d\d$/.test(value?.last_error || '')) result.last_error = value.last_error;
    if (Array.isArray(value?.missing)) {
      const reasons = new Set(['diagnostic_disabled', 'queue_save_failed', 'queue_unavailable', 'telemetry_paused',
        'telemetry_disabled', 'delivery_not_recorded', 'summary_evicted', 'invalid_event', 'identity_conflict', 'expired', 'evicted', 'paused']);
      result.missing = [...new Set(value.missing.filter(reason => reasons.has(reason)))].slice(0, 16);
      if (value.missing.length > 16) state.truncated = true;
    }
    return result;
  }
  function reviewedSource(error, state) {
    const group = error?.launcherEvidence;
    if (Array.isArray(group?.reviewedOutput) && group.reviewedOutput.length) {
        if (group.reviewedOutput.length > 12) state.truncated = true;
        // Freeze the primary's context once; later rollback output must not
        // replace the original failure's technical evidence.
        if (!state.primary) state.reviewedOutput = group.reviewedOutput.slice(-12).map(line => text(line, 500, state));
    }
    if (group?.output?.length && group.output !== group.reviewedOutput) missing(state, 'unreviewed_output');
    state.truncated ||= group?.truncated === true;
    if (!Array.isArray(group?.errors) || !group.errors.length) return { error, secondaryErrors: [] };
    if (group.errors.length > budget.errorNodes) state.truncated = true;
    const entries = group.errors.slice(0, budget.errorNodes).filter(item => item && typeof item === 'object')
      .map(item => ({ name: item.name, message: item.message, code: item.code, stack: item.stack,
        evidenceRelation: item.evidenceRelation, ...programFacts(item) }));
    if (!entries.length) return { error, secondaryErrors: [] };
    const primary = entries[0], secondaryErrors = [];
    let cause = primary;
    for (const item of entries.slice(1)) {
      if (item.evidenceRelation === 'cause') { cause.cause = item; cause = item; }
      else secondaryErrors.push({ operation: 'child-secondary', error: item });
    }
    return { error: primary, secondaryErrors };
  }
  const rows = state => state.events.map(event => JSON.stringify(event) + '\n').join('');
  const size = state => Buffer.byteLength(JSON.stringify(state)) + Buffer.byteLength(rows(state));
  function fit(state, preservePrimary) {
    while (size(state) > budget.bytes) {
      state.truncated = true;
      if (state.secondary.length) state.secondary.pop();
      else if (state.events.length) state.events.pop();
      else if (state.reviewedOutput?.length) state.reviewedOutput.shift();
      else if (state.delivery) delete state.delivery;
      else if (preservePrimary) break;
      else {
        const nodes = [];
        for (let node = state.primary; node; node = node.cause) nodes.push(node);
        const tail = nodes.slice().reverse();
        const frames = tail.find(node => node.frames.length > 1);
        const message = tail.find(node => node.message.length > 80);
        const optionalFrame = tail.find(node => node !== state.primary && node.frames.length);
        if (frames) frames.frames.shift();
        else if (message) message.message = message.message.slice(0, Math.floor(message.message.length / 2));
        else if (optionalFrame) optionalFrame.frames.shift();
        else if (nodes.length > 1) delete nodes.at(-2).cause;
        else if (state.primary?.frames.length) state.primary.frames.shift();
        else break;
      }
    }
  }
  function persist(state, target, preservePrimary = true) {
    if (!target) return;
    const temporary = path.join(target, `metadata-${randomUUID()}.tmp`);
    const eventTemporary = path.join(target, `events-${randomUUID()}.tmp`);
    try {
      fit(state, preservePrimary);
      if (size(state) > budget.bytes) { missing(state, 'save_failed:BUDGET'); return; }
      checkPath(target);
      checkPath(target, 'metadata.json');
      checkPath(target, 'events.jsonl');
      const names=fs.existsSync(operations())?fs.readdirSync(operations()).filter(name=>UUID.test(name)):[];
      if(names.length+(names.includes(state.operationId)?0:1)>budget.historyCapacity)
        throw Object.assign(new Error('Evidence history capacity exceeded'),{code:'CAPACITY'});
      const retained=retainedBytes()-fileBytes(target,['metadata.json','events.jsonl'])+size(state);
      if(retained>dataBudget)throw Object.assign(new Error('Retained evidence budget reached'),{code:'CAPACITY'});
      mark(true);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      const write=file=>{const fd=fs.openSync(file,'wx',0o600);return {fd,close(){try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}};};
      let output=write(eventTemporary);try{fs.writeFileSync(output.fd,rows(state));}finally{output.close();}
      fs.renameSync(eventTemporary, path.join(target, 'events.jsonl'));
      output=write(temporary);try{fs.writeFileSync(output.fd,JSON.stringify(state));}finally{output.close();}
      fs.renameSync(temporary, path.join(target, 'metadata.json'));
      if(process.platform!=='win32'){const fd=fs.openSync(target,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      usageCache={id:mark(false),bytes:retained};unwritten.delete(state.operationId);
    } catch (error) {
      missing(state, `save_failed:${/^[A-Z_]+$/.test(error.code || '') ? error.code : 'UNKNOWN'}`);
      unwritten.delete(state.operationId);unwritten.set(state.operationId,clone(state));
      while(unwritten.size>8)unwritten.delete(unwritten.keys().next().value);
      usageCache=null;
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      try { fs.rmSync(eventTemporary, { force: true }); } catch {}
    }
  }
  function begin({ operationId = randomUUID(), action = 'none', runId = '', memoryOnly = false } = {}) {
    if (!UUID.test(operationId || '')) throw new TypeError('Invalid evidence operation ID');
    let target = '', locationError;
    try { target = location(operationId); } catch (error) { locationError = error; }
    let state = { schema: 1, operationId, action: projection.text(action, 80), runId: projection.text(runId, 120),
      startedAt: new Date().toISOString(), outcome: '', primary: null, secondary: [], events: [], missingReasons: [], truncated: false };
    const saved = target ? read(operationId) : null;
    if (saved?.schema === 1 && saved.operationId === operationId && typeof saved.startedAt === 'string'
        && Array.isArray(saved.events) && Array.isArray(saved.secondary) && Array.isArray(saved.missingReasons)) state = saved;
    if (locationError) missing(state, `save_failed:${/^[A-Z_]+$/.test(locationError.code || '') ? locationError.code : 'UNKNOWN'}`);
    const snapshot = () => clone(state);
    const save = preservePrimary => {if(memoryOnly)fit(state,preservePrimary);else persist(state,target,preservePrimary);};
    const freeze = ({ error, outcome, context, secondaryErrors = [], delivery } = {}) => {
      const alreadyFrozen = Boolean(state.primary);
      const originalSecondary = Array.isArray(error?.secondaryErrors) ? error.secondaryErrors : [];
      const reviewed = reviewedSource(error, state);
      error = reviewed.error;
      secondaryErrors = [...reviewed.secondaryErrors, ...originalSecondary, ...secondaryErrors];
      if (!state.primary && error) state.primary = project(error, state);
      if (context && !state.context) state.context = technicalContext(context, state);
      const count = node => node ? 1 + count(node.cause) : 0;
      const appendSecondary = item => {
        const detail = project(item?.error, state);
        if (!detail || JSON.stringify(detail) === JSON.stringify(state.primary)
            || state.secondary.some(saved => JSON.stringify(saved.error) === JSON.stringify(detail))) return;
        const available = budget.errorNodes - count(state.primary) - state.secondary.reduce((sum, saved) => sum + count(saved.error), 0);
        if (available <= 0) { state.truncated = true; return; }
        state.secondary.push({ operation: text(item.operation || 'secondary', 80, state), error: project(item.error, state, available) });
      };
      for (const item of secondaryErrors) appendSecondary(item);
      if (error && state.primary) appendSecondary({ operation: 'secondary', error });
      if (typeof outcome === 'string') state.outcome = projection.text(outcome, 80);
      if (delivery) {
        const projectedDelivery = deliveryContext(delivery, state);
        if (projectedDelivery) state.delivery = projectedDelivery;
      }
      save(alreadyFrozen);
      return snapshot();
    };
    const observe = message => {
      if (message?.event === 'log') {
        if (missing(state, 'unreviewed_output')) save(true);
        return snapshot();
      }
      let event;
      if (message?.event === 'diagnostic' && message.error && ['bridge', 'installer', 'updater', 'native'].includes(message.component)) {
        event = { event: 'diagnostic', component: message.component, error: project(message.error, state) };
      } else if (message?.event === 'diagnostic' && ['subprocess-start', 'subprocess-exit'].includes(message.operation)) {
        event = { event: 'diagnostic', ...technicalContext(message, state) };
      } else if (['task', 'milestone', 'progress', 'step'].includes(message?.event)) {
        event = { event: message.event, ...technicalContext(message, state) };
      } else {
        if (missing(state, 'unreviewed_event')) save(true);
        return snapshot();
      }
      if (state.events.length >= budget.records) {
        if (!state.truncated) { state.truncated = true; save(true); }
      } else {
        state.events.push(event);
        save(true);
      }
      return snapshot();
    };
    save(true);
    return { id: operationId, directory: target, snapshot, observe, freeze, finish: freeze };
  }
  function read(operationId) {
    if (!UUID.test(operationId || '')) throw new TypeError('Invalid evidence operation ID');
    const mergeDelivery=saved=>{
      try{
        const target=location(operationId);checkPath(target,'delivery.json');
        const file=path.join(target,'delivery.json'),stat=fs.lstatSync(file,{throwIfNoEntry:false});
        if(stat?.isFile()&&stat.size<=budget.ackCapacity){const value=JSON.parse(fs.readFileSync(file,'utf8'));
          if(value.schema===1&&value.operationId===operationId){const delivery=deliveryContext(value.delivery,{operationId,missingReasons:[],truncated:false});if(delivery)saved.delivery=delivery;}}
      }catch{}
      return saved;
    };
    if(unwritten.has(operationId))return mergeDelivery(clone(unwritten.get(operationId)));
    const unavailable = (reason, truncated = false) => ({ schema: 1, operationId, primary: null, secondary: [], events: [], missingReasons: [reason], truncated });
    try {
      const target = location(operationId);
      checkPath(target, 'metadata.json');
      const file = path.join(target, 'metadata.json');
      if (fs.statSync(file).size > budget.bytes) return unavailable('evidence_read_limit', true);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!saved || saved.schema !== 1 || saved.operationId !== operationId || typeof saved.startedAt !== 'string'
          || !Array.isArray(saved.events) || !Array.isArray(saved.secondary) || !Array.isArray(saved.missingReasons)
          || typeof saved.truncated !== 'boolean') return unavailable('evidence_invalid');
      return mergeDelivery(saved);
    }
    catch (error) {
      return unavailable(error.code === 'ENOENT' ? 'evidence_missing' : error instanceof SyntaxError ? 'evidence_invalid'
        : `evidence_read_failed:${/^[A-Z_]+$/.test(error.code || '') ? error.code : 'UNKNOWN'}`);
    }
  }
  function canArchive(operationId) {
    try {
      const saved=read(operationId),root=path.resolve(typeof directory==='function'?directory():directory);
      const target=location(operationId);checkPath(path.dirname(target),'operation.json');
      checkPath(target,'delivery.json');
      const deliveryFile=path.join(target,'delivery.json'),deliveryStat=fs.lstatSync(deliveryFile,{throwIfNoEntry:false});
      if(deliveryStat){
        if(!deliveryStat.isFile()||deliveryStat.size>budget.ackCapacity)return false;
        const delivery=JSON.parse(fs.readFileSync(deliveryFile,'utf8'));
        if(delivery.schema!==1||delivery.operationId!==operationId||!delivery.delivery||typeof delivery.delivery!=='object')return false;
      }
      const file=path.join(target,'..','operation.json'),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.size>256*1024)return false;
      const record=JSON.parse(fs.readFileSync(file,'utf8'));
      if(record.schema!=='nora-operation/1'||record.operationId!==operationId
        ||!['succeeded','failed','cancelled','rolled-back','blocked'].includes(record.state)
        ||!['untouched','restored'].includes(record.effectState)||record.handoffRef
        ||record.effectState==='restored'&&record.verification!=='confirmed'
        ||['recovery-required','files-restored-start-failed'].includes(record.recoveryOutcome))return false;
      if(!saved.delivery || saved.delivery.queued!==0 || saved.delivery.status==='pending'
        || saved.delivery.missing?.some(reason=>['queue_save_failed','queue_unavailable','delivery_not_recorded'].includes(reason)))return false;
      for(const file of [path.join(root,'telemetry.json'),path.join(root,'operations',operationId,'telemetry.json')]){
        const rawFile=file+'.logs',rawStat=fs.lstatSync(rawFile,{throwIfNoEntry:false});
        if(rawStat){
          if(!rawStat.isFile()||rawStat.isSymbolicLink()||rawStat.size>2*1024*1024)return false;
          const raw=JSON.parse(fs.readFileSync(rawFile,'utf8'));
          if(raw.schema!==1||!Array.isArray(raw.jobs)||raw.jobs.length>64
            ||raw.jobs.some(job=>!UUID.test(job.id)||typeof job.closed!=='boolean'||typeof job.done!=='boolean'))return false;
          if(raw.jobs.some(job=>job.id===operationId&&!job.done))return false;
        }
        const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)continue;
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)return false;
        const state=JSON.parse(fs.readFileSync(file,'utf8'));
        if(state.schema!==1||!Array.isArray(state.queue)||state.queue.some(event=>!event||typeof event.operation_id!=='string'))return false;
        if(state.queue.some(event=>event.operation_id===operationId))return false;
      }
      return true;
    }catch{return false;}
  }
  function archive(operationId) {
    if(!canArchive(operationId))return false;
      const target=location(operationId);checkPath(target);
    // Transaction inventories, backups and unacknowledged queues are never
    // retention targets. Only these reviewed evidence files may be reclaimed.
    mark(true);for(const name of ['metadata.json','events.jsonl','python.json','delivery.json']){
      checkPath(target,name);fs.rmSync(path.join(target,name),{force:true});
    }
    mark(false);usageCache=null;unwritten.delete(operationId);
    return true;
  }
  function updateDelivery(operationId,delivery){
    let temporary;
    try{
      const target=location(operationId);checkPath(target,'metadata.json');checkPath(path.dirname(target),'operation.json');
      const stat=fs.lstatSync(path.join(target,'metadata.json'),{throwIfNoEntry:false});if(!stat?.isFile()||stat.size>budget.bytes)return false;
      const recordFile=path.join(target,'..','operation.json'),recordStat=fs.lstatSync(recordFile,{throwIfNoEntry:false});
      if(!recordStat?.isFile()||recordStat.size>256*1024)return false;
      const record=JSON.parse(fs.readFileSync(recordFile,'utf8'));
      if(record.schema!=='nora-operation/1'||record.operationId!==operationId||record.archived===true)return false;
      // ACK callbacks own only this bounded sibling. They never rewrite cached
      // metadata, so a late callback cannot replace a successor's first cause.
      const projected=deliveryContext(delivery,{operationId,missingReasons:[],truncated:false});if(!projected)return false;
      const value={schema:1,operationId,delivery:projected},contents=JSON.stringify(value);if(Buffer.byteLength(contents)>budget.ackCapacity)return false;
      checkPath(target,'delivery.json');
      // Data writers reserve one complete ACK slot per bounded Operation fact.
      // ACKs cannot consume metadata capacity even while that writer commits.
      if(fs.readdirSync(operations()).filter(name=>UUID.test(name)).length>budget.historyCapacity)return false;
      mark(true);temporary=path.join(target,`delivery-${randomUUID()}.tmp`);
      const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,contents);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,path.join(target,'delivery.json'));
      if(process.platform!=='win32'){const parent=fs.openSync(target,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
      mark(false);usageCache=null;
      return true;
    }catch{return false;}
    finally{if(temporary)try{fs.rmSync(temporary,{force:true});}catch{}}
  }
  function commitSnapshot(snapshot){
    const state=clone(snapshot);
    if(!state||state.schema!==1||!UUID.test(state.operationId||'')||typeof state.startedAt!=='string'
      ||!Array.isArray(state.events)||!Array.isArray(state.secondary)||!Array.isArray(state.missingReasons)
      ||typeof state.truncated!=='boolean'||Buffer.byteLength(JSON.stringify(state))>budget.bytes*2)
      throw Object.assign(new Error('Operation evidence snapshot is invalid'),{code:'EVIDENCE_INVALID'});
    persist(state,location(state.operationId),Boolean(state.primary));return clone(state);
  }
  return { begin, read, canArchive, archive, updateDelivery, commitSnapshot };
}

module.exports = { createEvidenceStore, DEFAULT_LIMITS, OPERATION_BUDGET };
