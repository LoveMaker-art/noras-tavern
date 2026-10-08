const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {launcherError} = require('./launcher-errors');
const {sourceCandidates,validateSourceResponse,readSource} = require('./release-sources');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function rememberFailureResource(error,url,identity,fetcher){
  try{
    const parsed=new URL(url);
    const list=identity==null&&parsed.origin==='https://api.github.com'&&parsed.pathname==='/repos/LoveMaker-art/noras-tavern/releases'&&/^\?per_page=100&page=[1-5]$/.test(parsed.search);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search&&!list||parsed.hash)return;
    const route=fetcher.conditionRoute?await Promise.race([fetcher.conditionRoute(url),new Promise((_,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Condition route lookup timed out')),10000);timer.unref?.();
    })]):'direct-node';
    const retryAt=Number.isFinite(error.retryAfterMs)?Date.now()+error.retryAfterMs
      :Number.isFinite(error.rateLimitReset)?error.rateLimitReset*1000:null;
    error.conditionResource={url:String(url),...(identity||{}),routeHash:digest(String(route))};
    error.conditionRetryAt=Number.isSafeInteger(retryAt)&&retryAt>=0?retryAt:null;
  }catch{}
}

const chromiumCodes = {'net::ERR_NETWORK_CHANGED':'ERR_NETWORK_CHANGED','net::ERR_CERT_AUTHORITY_INVALID':'ERR_CERT_AUTHORITY_INVALID',
  'net::ERR_CERT_DATE_INVALID':'CERT_HAS_EXPIRED','net::ERR_NAME_NOT_RESOLVED':'ENOTFOUND','net::ERR_CONNECTION_REFUSED':'ECONNREFUSED',
  'net::ERR_CONNECTION_RESET':'ECONNRESET','net::ERR_CONNECTION_CLOSED':'ECONNRESET',
  'net::ERR_TIMED_OUT':'TIMEOUT','net::ERR_ABORTED':'ABORT_ERR'};
function retryAfter(value, now) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value)) ? Number(value)*1000 : null;
  const date=Date.parse(value);return Number.isFinite(date) ? Math.max(0,date-now) : null;
}
function responseEvidence(response, now = Date.now()) {
  const remaining=response.headers.get('x-ratelimit-remaining');
  const reset=response.headers.get('x-ratelimit-reset');
  const after=retryAfter(response.headers.get('retry-after'),now);
  return {status:response.status,rateLimited:response.status===429 || response.status===403 && (remaining==='0'||after!==null),
    ...(after!==null ? {retryAfterMs:after} : {}),
    ...(remaining!==null && /^\d+$/.test(remaining) ? {rateLimitRemaining:Number(remaining)} : {}),
    ...(reset!==null && /^\d+$/.test(reset) ? {rateLimitReset:Number(reset)} : {})};
}
function transient(error) {
  return ['ERR_NETWORK_CHANGED','ECONNRESET','ETIMEDOUT','TIMEOUT','EAI_AGAIN'].includes(error?.code)
    || ['ERR_NETWORK_CHANGED','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(error?.cause?.code);
}
function transportCode(error) {
  const code=error?.code || error?.cause?.code;
  return chromiumCodes[error?.message] || (code==='UND_ERR_SOCKET'?'ECONNRESET'
    :['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code)?'TIMEOUT':undefined);
}
async function fetchRead(fetcher, url, options = {}, policy = {}) {
  // Unwrap our transport so the caller's source/operation budget owns retries.
  if (fetcher.releaseRead === true) {
    if(!fetcher.readOnce) return fetcher(url,options);
    policy={...fetcher.releasePolicy,...policy};fetcher=fetcher.readOnce;
  }
  const now=policy.now || Date.now, sleep=policy.sleep || ((ms,signal)=>delay(ms,undefined,{signal}));
  const diagnostics=policy.diagnostics || {write(){},error(){}};
  const budget=policy.totalBudgetMs ?? 100000, deadline=Math.min(policy.deadlineAt ?? Infinity,now()+budget);
  const backoff=policy.backoffMs || [2000,5000], maxAttempts=Math.min(3,policy.maxAttempts || 3);
  const readOnly=['GET','HEAD'].includes(String(options.method || 'GET').toUpperCase()) && options.body==null;
  const parsed=new URL(url), fields={engine:policy.engine || 'fetch',url:parsed.origin+parsed.pathname};
  for(let attempt=1;attempt<=maxAttempts;attempt++) {
    options.signal?.throwIfAborted();
    const timeout=new AbortController(), remaining=deadline-now();
    if(remaining<=0) throw Object.assign(new Error('发布请求已超过有限等待预算。'),{code:'TIMEOUT',attempt:attempt-1});
    const timer=setTimeout(()=>timeout.abort(new DOMException('发布请求超时','TimeoutError')),Math.min(policy.attemptTimeoutMs ?? 30000,remaining));
    const signal=AbortSignal.any([options.signal || new AbortController().signal,timeout.signal]);
    const started=now(), attemptFields={...fields,attempt};
    diagnostics.write('network.start',{...attemptFields,message:`请求 ${fields.url} engine=${fields.engine} attempt=${attempt}`});
    let response,error,wait;
    try {
      response=await readSource(fetcher,policy.source,url,{...options,signal});
      if(now()>deadline) {await response.body?.cancel();response=null;throw Object.assign(new Error('发布请求已超过有限等待预算。'),{code:'TIMEOUT'});}
      const evidence=responseEvidence(response,now());
      try {Object.defineProperty(response,'launcherAttempt',{value:attempt,configurable:true});
        Object.defineProperty(response,'launcherResponse',{value:evidence,configurable:true});} catch {}
      diagnostics.write('network.response',{...attemptFields,...evidence,durationMs:now()-started,
        message:`HTTP ${response.status} ${fields.url} attempt=${attempt} durationMs=${now()-started}`});
      if([408,429,500,502,503,504].includes(response.status) || response.status===403 && (evidence.rateLimited || evidence.retryAfterMs!==undefined)) {
        wait=evidence.retryAfterMs ?? (response.status===429 ? 60000 : backoff[attempt-1]);
        if(evidence.rateLimited && evidence.rateLimitRemaining===0) {
          // A depleted primary bucket must never be retried before its reset.
          wait=evidence.rateLimitReset ? Math.max(wait || 0,evidence.rateLimitReset*1000-now()) : Infinity;
        }
      }
    } catch(caught) {
      error=caught;
      const code=timeout.signal.aborted || options.signal?.reason?.name==='TimeoutError' ? 'TIMEOUT' : transportCode(error);
      try {Object.assign(error,{source:'release_service',site:'release.request',attempt,
        ...(code?{code}:{})});} catch {}
      // Browser DOMException.code is read-only. Preserve the native cause while
      // giving callers the same technical classification as ordinary errors.
      if(code && error.code!==code)error=launcherError(error.message,{code,source:'release_service',site:'release.request',attempt},error);
      if(transient(error)) wait=backoff[attempt-1];
    } finally {clearTimeout(timer);}
    const retry=readOnly && !options.signal?.aborted && attempt<maxAttempts && wait!==undefined && Number.isFinite(wait) && wait<deadline-now();
    if(!retry) {
      if(response) return response;
      diagnostics.error('network.failed',error,{...attemptFields,durationMs:now()-started,message:`请求失败 ${fields.url} attempt=${attempt}`});throw error;
    }
    if(response?.body) await response.body.cancel().catch(()=>{});
    diagnostics.write('network.retry',{...attemptFields,nextAttempt:attempt+1,delayMs:wait,
      message:`等待 ${wait} ms 后再次请求 ${fields.url} nextAttempt=${attempt+1}`});
    try {policy.onRetry?.(error || Object.assign(new Error(`HTTP ${response.status}`),response.launcherResponse));} catch {}
    await sleep(wait,options.signal);
  }
}

function createMetadataCache({file,ttlMs = 30000,now = Date.now} = {}) {
  const entries=new Map(),cooldowns=new Map();
  if(file) try {
    const stat=fs.lstatSync(file);
    if(stat.isFile() && stat.size<=8*1024*1024) {
      const stored=JSON.parse(fs.readFileSync(file,'utf8'));
      if(stored.schema==='nora-metadata-cache/1') {
        for(const [key,value] of Object.entries(stored.entries || {}).slice(-32)) entries.set(key,value);
        for(const [key,value] of Object.entries(stored.cooldowns || {}).slice(-16)) cooldowns.set(key,value);
      }
    }
  } catch {}
  function persist(){
    const serialize=()=>JSON.stringify({schema:'nora-metadata-cache/1',entries:Object.fromEntries(entries),cooldowns:Object.fromEntries(cooldowns)});
    let stored=serialize();
    while(entries.size>32 || Buffer.byteLength(stored)>8*1024*1024 && entries.size) {entries.delete(entries.keys().next().value);stored=serialize();}
    if(file) {fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.tmp';
      fs.writeFileSync(temporary,stored,{mode:0o600});fs.renameSync(temporary,file);}
  }
  return {ttlMs,now,get(key){
    const value=entries.get(key);
    if(!value || typeof value.body!=='string' || Buffer.byteLength(value.body)>4*1024*1024 || digest(value.body)!==value.sha256
      || value.etag!=null && (typeof value.etag!=='string' || value.etag.length>256 || /[\r\n]/.test(value.etag))
      || !Number.isFinite(Date.parse(value.checkedAt)) || Date.parse(value.checkedAt)>now()) {entries.delete(key);return null;}
    try {JSON.parse(value.body);} catch {entries.delete(key);return null;}
    return value;
  },set(key,value){
    entries.delete(key);entries.set(key,{...value,sha256:digest(value.body)});
    persist();
  },cooldown(url){
    const origin=new URL(url).origin,value=cooldowns.get(origin);
    if(![403,429].includes(value?.status)||!Number.isSafeInteger(value?.until)||value.until<=now()) {cooldowns.delete(origin);return null;}
    return {status:value.status,rateLimited:true,retryAfterMs:value.until-now(),rateLimitReset:Math.ceil(value.until/1000)};
  },limit(url,evidence){
    if(!evidence.rateLimited)return;
    const reset=Number.isSafeInteger(evidence.rateLimitReset*1000)?evidence.rateLimitReset*1000:0;
    const after=Number.isFinite(evidence.retryAfterMs)&&evidence.retryAfterMs>=0?now()+evidence.retryAfterMs:0;
    const until=Math.max(reset,after)||now()+60000;
    if(!Number.isSafeInteger(until)||until<=now())return;
    const origin=new URL(url).origin;cooldowns.delete(origin);cooldowns.set(origin,{status:evidence.status,until});
    while(cooldowns.size>16)cooldowns.delete(cooldowns.keys().next().value);
    persist();
  }};
}
function maySwitchSource(error,source) {
  if(['VERIFICATION_FAILED','INVALID_RESPONSE','RESPONSE_TOO_LARGE'].includes(error?.code)) return false;
  if([error?.code,error?.cause?.code].some(code=>typeof code==='string' && /CERT|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code))) return false;
  return transient(error) || ['ENOTFOUND','ECONNREFUSED'].includes(error?.code)
    || ['ENOTFOUND','ECONNREFUSED'].includes(error?.cause?.code) || error?.name==='TimeoutError'
    || [408,429,500,502,503,504].includes(error?.status)
    || error?.status===403
    || [404,410].includes(error?.status);
}
function sourceNotice(fetcher,policy,source,next,error,onEvent) {
  const fields={from:source.id,to:next.id,code:error.code || error.cause?.code || '',status:error.status || null};
  const message=`${source.id} 来源未完成请求（${fields.code || fields.status || '网络中断'}），切换到 ${next.id}；保持已选版本。`;
  try {(policy.diagnostics || fetcher.releasePolicy?.diagnostics)?.write('network.source.switch',{...fields,message});} catch {}
  onEvent?.({event:'log',level:'warning',uploadScope:'maintenance',
    line:`[WARNING] ${message}`});
}
async function metadataJson(url,options={}) {
  const {fetcher=fetch,signal,policy={},channel='stable'}=options;
  const sources=sourceCandidates(url,{channel,sources:policy.sources});
  const now=policy.now || Date.now,deadline=Math.min(policy.deadlineAt ?? Infinity,now()+(policy.totalBudgetMs ?? 100000));
  const failures=[];
  for(let index=0;index<sources.length;index++) {
    signal?.throwIfAborted();
    const remaining=deadline-now();
    if(remaining<=0) throw launcherError('发布请求已超过有限等待预算。',{code:'TIMEOUT',source:'release_service',site:'release.request'},failures.at(-1));
    const source=sources[index],budget=sources.length>1?Math.min(remaining,policy.attemptTimeoutMs ?? 30000):remaining;
    try {return await metadataFromSource(source.url,{...options,fetcher,source,policy:{...policy,source,deadlineAt:deadline,totalBudgetMs:budget,
      ...(sources.length>1?{maxAttempts:1}:{})}});}
    catch(error) {
      failures.push(error);
      if(signal?.aborted || index===sources.length-1 || !maySwitchSource(error,source)) {
        if(failures.length>1) error.secondaryErrors=[...(error.secondaryErrors || []),...failures.slice(0,-1).map((failure,index)=>({operation:`release-source:${sources[index].id}`,error:failure}))];
        throw error;
      }
      sourceNotice(fetcher,policy,source,sources[index+1],error);
    }
  }
}
async function metadataFromSource(url,{fetcher,signal,metadataCache,channel='stable',headers={},policy={},conditionIdentity,source} = {}) {
  if(new URL(url).protocol!=='https:') throw launcherError('发布清单必须使用 HTTPS。',{code:'VERIFICATION_FAILED',source:'release_service',site:'release.request'});
  const now=metadataCache?.now || policy.now || Date.now;
  const requestHeaders=new Headers({'User-Agent':'Nora-Tavern-Launcher',Accept:'application/vnd.github+json',...headers});
  const key=digest(JSON.stringify([String(url),channel,[...requestHeaders].sort()]));
  const cached=metadataCache?.get(key);
  signal?.throwIfAborted();
  if(cached && now()-Date.parse(cached.checkedAt)<metadataCache.ttlMs)
    return {...cached,value:JSON.parse(cached.body),source:'cache',latestConfirmed:false};
  const cooldown=metadataCache?.cooldown?.(url);
  if(cooldown){
    const error=launcherError('发布服务仍在限流等待期。',{...cooldown,source:'release_service',site:'release.request'});
    await rememberFailureResource(error,url,conditionIdentity,fetcher);throw error;
  }
  if(cached?.etag) requestHeaders.set('If-None-Match',cached.etag);
  const budget=Math.min(policy.totalBudgetMs ?? 100000,(policy.deadlineAt ?? Infinity)-(policy.now || Date.now)());
  if(budget<=0) throw launcherError('发布请求已超过有限等待预算。',{code:'TIMEOUT',source:'release_service',site:'release.request'});
  const requestSignal=AbortSignal.any([signal || new AbortController().signal,AbortSignal.timeout(Math.ceil(budget))]);
  let response;
  try {response=await fetchRead(fetcher,url,{headers:requestHeaders,signal:requestSignal},policy);}
  catch(error) {await rememberFailureResource(error,url,conditionIdentity,fetcher);throw launcherError(error.message,{source:'release_service',site:'release.request'},error);}
  try {validateSourceResponse(source,response);} catch(error) {await response.body?.cancel().catch(()=>{});throw error;}
  const responseSource=safeSource(response.url || url);
  if(response.status===304) {
    if(!cached?.etag || cached.responseSource!==responseSource || response.headers.get('etag') && response.headers.get('etag')!==cached.etag)
      throw launcherError('发布服务返回了无法对应缓存的条件响应。',{code:'INVALID_RESPONSE',source:'release_service',site:'release.request'});
    const value={...cached,checkedAt:new Date(now()).toISOString()};
    try {metadataCache.set(key,value);} catch {}
    return {...value,value:JSON.parse(value.body),source:'revalidated',latestConfirmed:true};
  }
  if(!response.ok){
    const evidence=responseEvidence(response,now());
    try {metadataCache?.limit?.(url,evidence);} catch {}
    const error=launcherError(`无法取得发布清单（HTTP ${response.status}）。`,
      {...evidence,attempt:response.launcherAttempt,source:'release_service',site:'release.request'});
    await rememberFailureResource(error,url,conditionIdentity,fetcher);await response.body?.cancel().catch(()=>{});throw error;
  }
  let body;
  try {
    const chunks=[];let size=0;
    for await(const chunk of Readable.fromWeb(response.body,{signal:requestSignal})) {size+=chunk.length;
      if(size>4*1024*1024) throw launcherError('发布清单过大。',{code:'RESPONSE_TOO_LARGE'});chunks.push(chunk);}
    body=Buffer.concat(chunks).toString('utf8');
  } catch(error) {await rememberFailureResource(error,url,conditionIdentity,fetcher);
    const code=requestSignal.reason?.name==='TimeoutError'?'TIMEOUT':transportCode(error);
    throw launcherError(error.message,{source:'release_service',site:'release.request',...(code?{code}:{})},error);}
  let value;
  try {value=JSON.parse(body);} catch {throw launcherError('发布服务返回了无法识别的内容。',{code:'INVALID_RESPONSE',source:'release_service',site:'release.request'});}
  const evidence={body,checkedAt:new Date(now()).toISOString(),etag:response.headers.get('etag') || null,responseSource};
  try {metadataCache?.set(key,evidence);} catch {}
  return {...evidence,value,source:'network',latestConfirmed:true};
}

async function fileHash(file) {
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file)) hash.update(chunk);return hash.digest('hex');
}
function regularFile(file) {
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(stat && !stat.isFile()) throw launcherError('下载缓存不是有效的普通文件。',{code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
  return stat;
}
function strongETag(value) {return typeof value==='string' && value.length<=256 && /^"[\x21\x23-\x7e]*"$/.test(value);}
function safeSource(url) {const parsed=new URL(url);return parsed.origin+parsed.pathname;}
function atomicJson(file,value) {
  fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file);
}
function cleanupDownload(files,primary) {
  for(const file of files) try {fs.rmSync(file,{force:true});}
  catch(error) {if(!primary) throw error;try {primary.secondaryErrors=[...(primary.secondaryErrors || []),error];} catch {}}
}
async function downloadAsset(options) {
  const {url,fetcher=fetch,signal,policy={},onEvent=()=>{}}=options;
  const sources=sourceCandidates(url,{sources:policy.sources}),now=policy.now || Date.now;
  const eligiblePartials=new Set(sources.map(source=>digest(JSON.stringify([source.url,options.identity]))));
  const deadline=Math.min(policy.deadlineAt ?? Infinity,now()+(policy.downloadBudgetMs ?? 1800000));
  const failures=[];
  for(let index=0;index<sources.length;index++) {
    signal?.throwIfAborted();
    const remaining=deadline-now();
    if(remaining<=0) throw launcherError('资源下载已超过有限等待预算。',{code:'TIMEOUT',source:'release_service',site:'release.download'},failures.at(-1));
    const source=sources[index];
    // Reserve an actual transfer window for each configured backup, even
    // when the primary keeps sending a few bytes and never reaches idle.
    const reserve=Math.min(policy.backupBudgetMs ?? 300000,remaining/sources.length);
    const budget=remaining-reserve*(sources.length-index-1);
    try {return await downloadFromSource({...options,fetcher,url:source.url,source,eligiblePartials,policy:{...policy,source,deadlineAt:deadline,downloadBudgetMs:Math.ceil(budget),
      ...(sources.length>1?{maxAttempts:1,downloadIdleTimeoutMs:policy.downloadIdleTimeoutMs ?? 300000}:{})}});}
    catch(error) {
      failures.push(error);
      if(signal?.aborted || index===sources.length-1 || !maySwitchSource(error,source)) {
        if(failures.length>1) error.secondaryErrors=[...(error.secondaryErrors || []),...failures.slice(0,-1).map((failure,index)=>({operation:`release-source:${sources[index].id}`,error:failure}))];
        throw error;
      }
      sourceNotice(fetcher,policy,source,sources[index+1],error,onEvent);
    }
  }
}
async function downloadFromSource({url,target,identity,fetcher,signal,onEvent=()=>{},policy={},source:sourceCandidate,eligiblePartials,task='正在下载发布资源',maxSize=2*1024**3}) {
  if(new URL(url).protocol!=='https:' || !identity || typeof identity.tag!=='string' || typeof identity.asset!=='string'
    || identity.sha256!=null && !/^[a-f0-9]{64}$/.test(identity.sha256)
    || identity.size!=null && (!Number.isSafeInteger(identity.size) || identity.size<1 || identity.size>maxSize))
    throw launcherError('发布资源身份或校验信息无效。',{code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
  signal?.throwIfAborted();
  const verified=async file=>{const stat=regularFile(file);return Boolean(stat && (!identity.size || stat.size===identity.size)
    && identity.sha256 && await fileHash(file)===identity.sha256);};
  if(await verified(target)) return {file:target,cached:true};
  const partial=target+'.partial',record=partial+'.json',expected=digest(JSON.stringify([url,identity]));
  let saved=null;
  try {const stat=regularFile(record);if(stat && stat.size<4096) saved=JSON.parse(fs.readFileSync(record,'utf8'));} catch {}
  let start=0,foreignPartial=false;
  const stat=regularFile(partial);
  if(stat && saved?.schema==='nora-download-partial/1' && eligiblePartials.has(saved.expected) && identity.sha256 && identity.size
    && strongETag(saved.etag) && saved.encoding==='identity' && saved.size===stat.size && stat.size>0 && stat.size<=identity.size
    && typeof saved.source==='string' && await fileHash(partial)===saved.prefixSha256) {
    if(saved.expected===expected)start=stat.size;else foreignPartial=true;
  }
  else {cleanupDownload([partial,record]);saved=null;}
  const headers=new Headers({'Accept-Encoding':'identity'});
  if(start) {headers.set('Range',`bytes=${start}-`);headers.set('If-Range',saved.etag);}
  onEvent({event:'task',stage_id:'download',task});onEvent({event:'progress',stage_id:'download',current:start,total:identity.size || 0});
  const idle=new AbortController();let idleTimer;
  const resetIdle=()=>{clearTimeout(idleTimer);
    if(policy.downloadIdleTimeoutMs!=null)idleTimer=setTimeout(()=>idle.abort(new DOMException('资源来源长时间没有新增下载字节','TimeoutError')),policy.downloadIdleTimeoutMs);};
  const downloadSignal=AbortSignal.any([signal || new AbortController().signal,idle.signal,AbortSignal.timeout(policy.downloadBudgetMs ?? 1800000)]);
  let response,representation=null,keep=false;
  try {
    response=await fetchRead(fetcher,url,{headers,signal:downloadSignal},policy);
    validateSourceResponse(sourceCandidate,response);
    const source=safeSource(response.url || url),etag=response.headers.get('etag');
    const encoding=(response.headers.get('content-encoding') || 'identity').toLowerCase();
    const protocolError=()=>launcherError('发布资源校验失败：响应或文件与固定内容不符，未使用下载文件。',
      {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
    if(response.status===416 && start) {
      if(response.headers.get('content-range')!==`bytes */${identity.size}` || source!==saved.source || etag!==saved.etag || !await verified(partial)) throw protocolError();
      await response.body?.cancel();fs.renameSync(partial,target);cleanupDownload([record]);return {file:target,cached:false,resumed:true};
    }
    if(!response.ok || !response.body) throw launcherError(`发布资源下载失败（HTTP ${response.status}）。`,
      {...responseEvidence(response),attempt:response.launcherAttempt,source:'release_service',site:'release.download'});
    let responseSize;
    if(response.status===206) {
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if(!start || !range || Number(range[1])!==start || Number(range[3])!==identity.size
        || Number(range[2])<start || Number(range[2])>=identity.size || etag!==saved.etag || source!==saved.source || encoding!=='identity') throw protocolError();
      responseSize=Number(range[2])-start+1;
    } else if(response.status===200) {
      start=0;responseSize=identity.size;
    } else throw protocolError();
    const declared=response.headers.get('content-length');
    if(encoding==='identity' && declared && (!/^\d+$/.test(declared) || responseSize && Number(declared)!==responseSize)) throw protocolError();
    representation=identity.sha256 && identity.size && strongETag(etag) && encoding==='identity'
      ? {schema:'nora-download-partial/1',expected,etag,source,encoding:'identity'} : null;
    resetIdle();
    // Preserve another configured source's verified checkpoint until this
    // source actually supplies a usable representation. Never append it here.
    if(foreignPartial){cleanupDownload([record]);foreignPartial=false;}
    const output=await fs.promises.open(partial,start?'a':'w',0o600);
    let current=start,lastProgress=0,transferFailure;
    try {
      for await(const chunk of Readable.fromWeb(response.body,{signal:downloadSignal})) {
        if(current+chunk.length>(identity.size || maxSize)) throw protocolError();
        await output.writeFile(chunk);current+=chunk.length;if(chunk.length)resetIdle();
        if(Date.now()-lastProgress>=250) {lastProgress=Date.now();onEvent({event:'progress',stage_id:'download',current,total:identity.size || Number(declared) || 0});}
      }
      clearTimeout(idleTimer);
      await output.sync();
    } catch(error) {transferFailure=error;throw error;}
    finally {try {await output.close();} catch(error) {if(!transferFailure) throw error;
      try {transferFailure.secondaryErrors=[...(transferFailure.secondaryErrors || []),error];} catch {}}}
    downloadSignal.throwIfAborted();
    onEvent({event:'progress',stage_id:'download',current,total:identity.size || current});
    onEvent({event:'task',stage_id:'verify',task:'正在校验下载资源'});
    if(identity.size && current!==identity.size) throw Object.assign(new Error('发布资源连接中断，下载尚未完整。'),{code:'ECONNRESET'});
    if(identity.sha256 && !await verified(partial)) throw protocolError();
    downloadSignal.throwIfAborted();
    fs.renameSync(partial,target);cleanupDownload([record]);return {file:target,cached:false,resumed:Boolean(start)};
  } catch(error) {
    const code=downloadSignal.reason?.name==='TimeoutError'?'TIMEOUT':transportCode(error);
    if(code && error.code!==code)error=launcherError(error.message,{code},error);
    try {if(!error.source) error.source='release_service';if(!error.site||error.site==='release.request') error.site='release.download';} catch {}
    await rememberFailureResource(error,url,identity,fetcher);
    if(foreignPartial)keep=true;
    else if(representation && (signal?.aborted || downloadSignal.aborted || transient(error))) {
      try {const current=regularFile(partial);if(current?.size>0 && current.size<=identity.size) {
        atomicJson(record,{...representation,size:current.size,prefixSha256:await fileHash(partial)});keep=true;
      }} catch(saveError) {try {error.secondaryErrors=[...(error.secondaryErrors || []),{operation:'download-checkpoint',error:saveError}];} catch {}}
    } else if(saved && start && !representation && (signal?.aborted || transient(error) || error.status===403 || error.status===429 || error.status>=500)) keep=true;
    if(!keep) cleanupDownload([partial,record],error);
    throw error;
  } finally {clearTimeout(idleTimer);if(response?.body && !response.bodyUsed) await response.body.cancel().catch(()=>{});}
}

function createReleaseNetwork({ app, net, diagnostics, onRetry = () => {}, policy = {},routeFor }) {
  async function readOnce(url,options={}){
    await app.whenReady();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('发布资源必须使用 HTTPS。');
    return net.fetch(url,{...options,credentials:'omit',cache:'no-store',bypassCustomProtocolHandlers:true});
  }
  async function fetchRelease(url, options = {}) {return fetchRead(readOnce,url,options,{...policy,engine:'chromium',diagnostics,onRetry});}
  fetchRelease.releaseRead=true;
  fetchRelease.readOnce=readOnce;
  fetchRelease.releasePolicy={...policy,engine:'chromium',diagnostics,onRetry};
  if(routeFor){fetchRelease.conditionRoute=routeFor;readOnce.conditionRoute=routeFor;}

  // The caller uses the same bounded release query for both engines. Node is
  // diagnostic only, never a fallback that bypasses Chromium certificate errors.
  async function compare(probe, nodeFetch = globalThis.fetch) {
    let chromiumError;
    for (const [engine, fetcher] of [['chromium', fetchRelease], ['node', nodeFetch]]) {
      const started = Date.now();
      try {
        await probe(fetcher);
        diagnostics.write('network.probe.complete', { engine, durationMs: Date.now() - started });
      } catch (error) {
        diagnostics.error('network.probe.failed', error, { engine, durationMs: Date.now() - started });
        if (engine === 'chromium') chromiumError = error;
      }
    }
    if (chromiumError) throw chromiumError;
  }
  return { fetch: fetchRelease, readOnce, compare };
}

module.exports = { createReleaseNetwork,fetchRead,responseEvidence,createMetadataCache,metadataJson,downloadAsset };
