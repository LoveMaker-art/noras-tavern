const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {launcherError} = require('./launcher-errors');
const {sourceCandidates,validateSourceResponse,readSource} = require('./release-sources');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const RELEASE_USER_AGENT = 'Nora-Tavern-Launcher';

// A caller owns this context for one operation. It is not a health cache or
// release-plan field: neither API responses nor old metadata can seed it.
function createReleaseSourceContext({tag} = {}) {
  let target=null,preferred=null,probeAttempted=false;const authorized=new Map();
  const valid=value=>typeof value==='string' && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
  const assetTag=value=>{
    try {
      const url=new URL(value);
      if(url.origin!=='https://github.com' || url.username || url.password || url.search || url.hash)return null;
      const prefix='/LoveMaker-art/noras-tavern/releases/download/';
      if(!url.pathname.startsWith(prefix))return null;
      const [candidate,name,...rest]=url.pathname.slice(prefix.length).split('/').map(decodeURIComponent);
      return !rest.length && valid(candidate) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '')?candidate:null;
    } catch {return null;}
  };
  const context={
    bindTarget(value){
      if(!valid(value) || target!==null && target!==value)
        throw launcherError('资源来源上下文与固定目标不一致，未改变更新计划。',{code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
      target=value;return context;
    },
    authorizeAssets(items){
      const invalid=()=>launcherError('共享资源来源提示与固定计划不一致，未改变更新计划。',
        {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
      if(target===null || !Array.isArray(items) || items.length>2048)throw invalid();
      const additions=new Map();
      for(const item of items) {
        if(!item || Object.keys(item).some(key=>!['url','sha256','size'].includes(key))
          || !assetTag(item.url) || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
          || !Number.isSafeInteger(item.size) || item.size<1 || item.size>2*1024**3)throw invalid();
        const identity=digest(JSON.stringify([item.sha256,item.size])),previous=authorized.get(item.url) || additions.get(item.url);
        if(previous && previous!==identity)throw invalid();additions.set(item.url,identity);
      }
      if(new Set([...authorized.keys(),...additions.keys()]).size>2048)throw invalid();
      for(const [url,identity] of additions)authorized.set(url,identity);return context;
    },
    preferredSource(url){return target!==null && (assetTag(url)===target || authorized.has(url))?preferred:null;},
    rememberAssetResponse(url,id){if(target!==null && (assetTag(url)===target || authorized.has(url)) && typeof id==='string')preferred=id;},
    isTargetAsset(url){return target!==null && assetTag(url)===target;},
    beginFixedPlanProbe(url){if(!context.isTargetAsset(url)||probeAttempted)return false;probeAttempted=true;return true;},
  };
  if(tag!=null)context.bindTarget(tag);
  return Object.freeze(context);
}
function operationSources(url,options,context){
  const candidates=sourceCandidates(url,options).map((source,index)=>({...source,retryIndex:index}));
  const id=context?.preferredSource?.(url),preferred=candidates.find(source=>source.id===id);
  return preferred?[preferred,...candidates.filter(source=>source!==preferred)]:candidates;
}

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
  'net::ERR_TIMED_OUT':'TIMEOUT','net::ERR_CONNECTION_TIMED_OUT':'TIMEOUT','net::ERR_ABORTED':'ABORT_ERR'};
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
  const headers=new Headers(options.headers);headers.set('User-Agent',RELEASE_USER_AGENT);
  options={...options,headers};
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
      if(!policy.networkRetriesOnly && ([408,429,500,502,503,504].includes(response.status) || response.status===403 && (evidence.rateLimited || evidence.retryAfterMs!==undefined))) {
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
  },delete(key){
    entries.delete(key);persist();
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
async function sourceFailure(error,url,identity,fetcher,failures,sources) {
  const retryAt=failures.map(value=>value.conditionRetryAt).filter(Number.isSafeInteger);
  if(failures.length>1) error.secondaryErrors=[...(error.secondaryErrors || []),...failures.slice(0,-1)
    .map((failure,index)=>({operation:`release-source:${sources[index].id}`,error:failure}))];
  // Admission owns the fixed canonical resource, not a provider-specific URL.
  // Keep source errors and the longest existing cooldown as separate evidence.
  await rememberFailureResource(error,url,identity,fetcher);
  if(retryAt.length)error.conditionRetryAt=Math.max(error.conditionRetryAt || 0,...retryAt);
  return error;
}
function sourceReadPolicy(source,index,policy,fetcher) {
  const attempts=policy.maxAttempts || (fetcher.releaseRead===true&&fetcher.releasePolicy?.maxAttempts) || 2;
  index=source.retryIndex ?? index;
  return {maxAttempts:Math.min(attempts,index===0&&source.id==='github'?2:1),networkRetriesOnly:true};
}
function metadataResourceKind(value) {
  const url=new URL(value),api='/repos/LoveMaker-art/noras-tavern/releases';
  if(url.username || url.password || url.hash)return 'unknown';
  if(url.origin==='https://api.github.com') {
    if(url.pathname===api && /^\?per_page=100&page=[1-5]$/.test(url.search))return 'release_list';
    if(url.search)return 'unknown';
    if(url.pathname===api+'/latest')return 'channel';
    if(/^\/repos\/LoveMaker-art\/noras-tavern\/releases\/tags\/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(url.pathname))return 'release';
  }
  if(url.origin==='https://github.com' && !url.search) {
    const match=/^\/LoveMaker-art\/noras-tavern\/releases\/download\/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if(match) {
      if(match[1]==='release-assets.json')return 'asset_index';
      if(match[1]==='release-manifest.json')return 'release_manifest';
      if(/^(?:win32-x64|darwin-(?:arm64|x64))-release-manifest\.json$/.test(match[1]))return 'platform_manifest';
      if(/^nora-system-(?:win32-x64|darwin-(?:arm64|x64))\.json$/.test(match[1]))return 'system_index';
      if(/^nora-launcher-(?:win32-x64|darwin-(?:arm64|x64))\.json$/.test(match[1]))return 'launcher_index';
      if(['first-install-manifest.json','bootstrap-manifest.json'].includes(match[1]))return 'install_manifest';
    }
  }
  return 'unknown';
}
// The raw operation-log projection retains this typed message without exposing
// a URL, redirect query, remote address, header/body content or native message.
// These facts describe this reader; they never change admission or its budgets.
function metadataTrace({url,resourceKind,source,fetcher,policy,signal,budget,deadline}) {
  const clock=policy.now || Date.now,started=clock(),maximum=4*1024*1024;
  const elapsed=value=>Number.isFinite(value)?Math.min(2147483647,Math.max(0,Math.trunc(value))):null;
  const parsed=new URL(url),sourceKind=source?.provider==='sourceforge'?'sourceforge':source?.mirror?'configured_mirror'
    :['https://github.com','https://api.github.com'].includes(parsed.origin)?'github':'other';
  const transport=policy.engine || fetcher.releasePolicy?.engine || 'fetch';
  const engine=['chromium','node','fetch'].includes(transport)?transport:'unknown';
  const diagnostics=policy.diagnostics || fetcher.releasePolicy?.diagnostics;
  let response,headerAt=null,firstByteAt=null,lastByteAt=null,size=0,requestSignal;
  function emit(event,phase,error) {
    const current=clock(),code=error?.code || transportCode(error);
    const abortReason=!error?'none':signal?.aborted?(signal.reason?.name==='TimeoutError'?'caller_timeout':'caller_cancelled')
      :requestSignal?.aborted || budget<=0?(policy.deadlineAt<=started+(policy.totalBudgetMs ?? 100000)?'operation_deadline':'source_deadline')
      :code==='TIMEOUT' || error?.name==='TimeoutError'?'transport_timeout':phase==='parse' || phase==='response'?'response_error':'transport_error';
    let declaredBytes=null,contentEncoding='unknown';
    try {
      const length=response?.headers.get('content-length');
      if(/^\d+$/.test(length || '') && Number.isSafeInteger(Number(length)) && Number(length)<=maximum)declaredBytes=Number(length);
      if(response?.headers) {
        const encoding=(response.headers.get('content-encoding') || 'identity').toLowerCase();
        if(['identity','gzip','br','deflate'].includes(encoding))contentEncoding=encoding;
      }
    } catch {}
    const fields={phase,resourceKind,sourceKind,engine,status:Number.isInteger(response?.status)&&response.status>=100&&response.status<=599?response.status:null,
      elapsedMs:elapsed(current-started),headersMs:headerAt===null?null:elapsed(headerAt-started),bodyMs:headerAt===null?null:elapsed(current-headerAt),
      firstByteMs:firstByteAt===null?null:elapsed(firstByteAt-started),lastByteMs:lastByteAt===null?null:elapsed(lastByteAt-started),
      bytesReceived:Math.min(size,maximum+1),bytesCapped:size>maximum+1,declaredBytes,contentEncoding,
      budgetMs:elapsed(budget),remainingMs:elapsed(deadline-current),abortReason};
    fields.message='metadata '+Object.entries(fields).map(([key,value])=>`${key}=${value===null?'unknown':value}`).join(' ');
    try {diagnostics?.write?.(event,fields);} catch {}
  }
  return {
    signal(value){requestSignal=value;},
    headers(value){response=value;headerAt=clock();emit('network.metadata.headers','headers');},
    resetHeaders(){response=undefined;headerAt=null;},
    chunk(length){size+=length;if(length){firstByteAt??=clock();lastByteAt=clock();}},
    failed(phase,error){emit('network.metadata.failed',phase,error);},
    complete(){emit('network.metadata.complete','complete');},
  };
}
async function metadataJson(url,options={}) {
  const {fetcher=fetch,signal,policy={},channel='stable'}=options;
  const sources=operationSources(url,{channel,sources:policy.sources},policy.sourceContext);
  const resourceKind=metadataResourceKind(url);
  const now=policy.now || Date.now,deadline=Math.min(policy.deadlineAt ?? Infinity,now()+(policy.totalBudgetMs ?? 100000));
  const failures=[];
  for(let index=0;index<sources.length;index++) {
    signal?.throwIfAborted();
    const remaining=deadline-now();
    if(remaining<=0) throw await sourceFailure(launcherError('发布请求已超过有限等待预算。',
      {code:'TIMEOUT',source:'release_service',site:'release.request'},failures.at(-1)),url,options.conditionIdentity,fetcher,failures,sources);
    const source=sources[index],budget=sources.length>1?Math.min(remaining,policy.attemptTimeoutMs ?? 30000):remaining;
    try {const result=await metadataFromSource(source.url,{...options,fetcher,source,resourceKind,policy:{...policy,source,canonicalUrl:url,deadlineAt:deadline,totalBudgetMs:budget,
      ...(sources.length>1?sourceReadPolicy(source,index,policy,fetcher):{})}});
      return {...result,catalogueComplete:source.catalogueComplete===true};}
    catch(error) {
      failures.push(error);
      if(signal?.aborted || index===sources.length-1 || !maySwitchSource(error,source)) {
        throw await sourceFailure(error,url,options.conditionIdentity,fetcher,failures,sources);
      }
      sourceNotice(fetcher,policy,source,sources[index+1],error);
    }
  }
}
async function metadataFromSource(url,{fetcher,signal,metadataCache,channel='stable',headers={},policy={},conditionIdentity,source,resourceKind} = {}) {
  if(new URL(url).protocol!=='https:') throw launcherError('发布清单必须使用 HTTPS。',{code:'VERIFICATION_FAILED',source:'release_service',site:'release.request'});
  const now=metadataCache?.now || policy.now || Date.now;
  const requestHeaders=new Headers({'User-Agent':RELEASE_USER_AGENT,Accept:'application/vnd.github+json',...headers});
  requestHeaders.set('User-Agent',RELEASE_USER_AGENT);
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
  const requestDeadline=Math.min(policy.deadlineAt ?? Infinity,(policy.now || Date.now)()+budget);
  const trace=metadataTrace({url,resourceKind,source,fetcher,policy,signal,budget,deadline:requestDeadline});
  if(budget<=0) {const error=launcherError('发布请求已超过有限等待预算。',{code:'TIMEOUT',source:'release_service',site:'release.request'});trace.failed('before_headers',error);throw error;}
  const requestSignal=AbortSignal.any([signal || new AbortController().signal,AbortSignal.timeout(Math.ceil(budget))]);
  trace.signal(requestSignal);
  let response;
  try {response=await fetchRead(fetcher,url,{headers:requestHeaders,signal:requestSignal},policy);}
  catch(error) {trace.failed('before_headers',error);await rememberFailureResource(error,url,conditionIdentity,fetcher);throw launcherError(error.message,{source:'release_service',site:'release.request'},error);}
  trace.headers(response);
  try {validateSourceResponse(source,response);} catch(error) {trace.failed('response',error);await response.body?.cancel().catch(()=>{});throw error;}
  let responseSource=safeSource(response.url || url);
  if(response.status===304) {
    if(cached?.etag && requestHeaders.get('If-None-Match')===cached.etag && cached.responseSource===responseSource
      && (!response.headers.get('etag') || response.headers.get('etag')===cached.etag)) {
      const value={...cached,checkedAt:new Date(now()).toISOString()};
      try {metadataCache.set(key,value);} catch {}
      return {...value,value:JSON.parse(value.body),source:'revalidated',latestConfirmed:true};
    }
    // Never assign an unmatched 304 to an old body. Remove this representation
    // and make one unconditional read of the same checked source within the
    // original request budget; it still goes through all source/body validators.
    try {metadataCache?.delete?.(key);} catch {}
    await response.body?.cancel().catch(()=>{});
    requestHeaders.delete('If-None-Match');
    trace.resetHeaders();
    try {response=await fetchRead(fetcher,url,{headers:requestHeaders,signal:requestSignal},
      {...policy,deadlineAt:requestDeadline,maxAttempts:1});}
    catch(error){trace.failed('before_headers',error);await rememberFailureResource(error,url,conditionIdentity,fetcher);throw launcherError(error.message,{source:'release_service',site:'release.request'},error);}
    trace.headers(response);
    try {validateSourceResponse(source,response);} catch(error){trace.failed('response',error);await response.body?.cancel().catch(()=>{});throw error;}
    responseSource=safeSource(response.url || url);
    if(response.status===304){const error=launcherError('发布服务返回了无法对应缓存的条件响应。',
      {code:'INVALID_RESPONSE',source:'release_service',site:'release.request'});trace.failed('response',error);throw error;}
  }
  if(!response.ok){
    const evidence=responseEvidence(response,now());
    try {metadataCache?.limit?.(url,evidence);} catch {}
    const error=launcherError(`无法取得发布清单（HTTP ${response.status}）。`,
      {...evidence,attempt:response.launcherAttempt,source:'release_service',site:'release.request'});
    trace.failed('response',error);
    await rememberFailureResource(error,url,conditionIdentity,fetcher);await response.body?.cancel().catch(()=>{});throw error;
  }
  let body;
  try {
    const chunks=[];let size=0;
    for await(const chunk of Readable.fromWeb(response.body,{signal:requestSignal})) {size+=chunk.length;
      trace.chunk(chunk.length);
      if(size>4*1024*1024) throw launcherError('发布清单过大。',{code:'RESPONSE_TOO_LARGE'});chunks.push(chunk);}
    body=Buffer.concat(chunks).toString('utf8');
  } catch(error) {trace.failed('body',error);await rememberFailureResource(error,url,conditionIdentity,fetcher);
    const code=requestSignal.reason?.name==='TimeoutError'?'TIMEOUT':transportCode(error);
    throw launcherError(error.message,{source:'release_service',site:'release.request',...(code?{code}:{})},error);}
  let value;
  try {value=JSON.parse(body);} catch {const error=launcherError('发布服务返回了无法识别的内容。',{code:'INVALID_RESPONSE',source:'release_service',site:'release.request'});trace.failed('parse',error);throw error;}
  trace.complete();
  // Domain validators still own acceptance. A known byte identity must agree
  // before even this scheduling hint may be learned; cache/304 paths never do.
  if((conditionIdentity?.sha256==null || digest(body)===conditionIdentity.sha256)
    && (conditionIdentity?.size==null || Buffer.byteLength(body)===conditionIdentity.size))
    policy.sourceContext?.rememberAssetResponse?.(policy.canonicalUrl || url,source.id);
  const evidence={body,checkedAt:new Date(now()).toISOString(),etag:response.headers.get('etag') || null,responseSource};
  try {metadataCache?.set(key,evidence);} catch {}
  return {...evidence,value,source:'network',latestConfirmed:true};
}

async function fileHash(file,{signal,check=()=>{}}={}) {
  check();const hash=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(file,{signal})) {check();hash.update(chunk);}
  check();return hash.digest('hex');
}
function regularFile(file) {
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(stat && !stat.isFile()) throw launcherError('下载缓存不是有效的普通文件。',{code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
  return stat;
}
function validateDownloadRequest({url,identity,maxSize=2*1024**3}) {
  if(new URL(url).protocol!=='https:' || !identity || typeof identity.tag!=='string' || typeof identity.asset!=='string'
    || identity.sha256!=null && !/^[a-f0-9]{64}$/.test(identity.sha256)
    || identity.size!=null && (!Number.isSafeInteger(identity.size) || identity.size<1 || identity.size>maxSize))
    throw launcherError('发布资源身份或校验信息无效。',{code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
}
async function verifiedDownload(file,identity,options={}) {
  options.check?.();const stat=regularFile(file);
  const verified=Boolean(stat && (!identity.size || stat.size===identity.size)
    && identity.sha256 && await fileHash(file,options)===identity.sha256);
  options.check?.();return verified;
}
async function refreshFixedPlanSource({url,identity,fetcher,signal,policy,onEvent,fixedPlanSourceEvidence:evidence}) {
  const context=policy.sourceContext;
  if(!evidence || !context?.isTargetAsset?.(url) || context.preferredSource(url))return;
  const invalid=()=>launcherError('固定发布来源证据与原计划不符，未下载或修改安装。',
    {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
  if(!context.isTargetAsset(evidence.url) || !/^[a-f0-9]{64}$/.test(evidence.sha256 || '')
    || !Number.isSafeInteger(evidence.size) || evidence.size<1 || evidence.size>4*1024*1024)throw invalid();
  if(!context.beginFixedPlanProbe(evidence.url))return;
  const now=policy.now || Date.now,probePolicy={...policy,deadlineAt:Math.min(policy.deadlineAt ?? Infinity,now()+(policy.totalBudgetMs ?? 100000))};
  try {
    // Fresh full bytes at the already sealed URL: no latest lookup, TTL cache
    // or conditional 304 may establish evidence for a resumed execution.
    const result=await metadataJson(evidence.url,{fetcher,signal,policy:probePolicy,
      conditionIdentity:{sha256:evidence.sha256,size:evidence.size}});
    if(Buffer.byteLength(result.body)!==evidence.size || digest(result.body)!==evidence.sha256)throw invalid();
  }catch(error){
    if(signal?.aborted || !maySwitchSource(error))throw error;
    const fields={code:error.code,status:error.status,message:'暂时未确认下载源，继续按已选版本下载。'};
    try{(policy.diagnostics || fetcher.releasePolicy?.diagnostics)?.write('network.plan_source.unavailable',fields);}catch{}
    onEvent?.({event:'log',level:'warning',uploadScope:'maintenance',line:`[WARNING] ${fields.message}`});
  }
}
function strongETag(value) {return typeof value==='string' && value.length<=256 && /^"[\x21\x23-\x7e]*"$/.test(value);}
function safeSource(url) {const parsed=new URL(url);return parsed.origin+parsed.pathname;}
function atomicJson(file,value) {
  const temporary=file+'.tmp',descriptor=fs.openSync(temporary,'w',0o600);
  try {fs.writeFileSync(descriptor,JSON.stringify(value));fs.fsyncSync(descriptor);}
  finally {fs.closeSync(descriptor);}
  fs.renameSync(temporary,file);
  // Windows does not expose directory fsync through this filesystem API.
  if(process.platform!=='win32') {
    const directory=fs.openSync(path.dirname(file),'r');
    try {fs.fsyncSync(directory);}finally {fs.closeSync(directory);}
  }
}
function cleanupDownload(files,primary) {
  for(const file of files) try {fs.rmSync(file,{force:true});}
  catch(error) {if(!primary) throw error;try {primary.secondaryErrors=[...(primary.secondaryErrors || []),error];} catch {}}
}
// A checkpoint proves that committed bytes still match the local disk. Its
// prefix hash is not publisher authentication: only the final full-file SHA
// below can make bytes from one or several admitted sources usable.
function downloadContent(identity) {return digest(JSON.stringify([identity.sha256,identity.size]));}
function slowSourceEstimator({identity,start,now,deadline,policy}) {
  const warmup=policy.downloadSlowWarmupMs ?? 30000,window=policy.downloadSlowWindowMs ?? 20000;
  const sampleInterval=policy.downloadSlowSampleMs ?? 1000,sustain=policy.downloadSlowSustainMs ?? 15000;
  const recentWindow=policy.downloadSlowRecentWindowMs ?? 5000;
  const started=now(),samples=[{at:started,bytes:start}];let badSince=null,improvingSince=null,sampleCount=1;
  return current=>{
    const at=now(),last=samples.at(-1);
    if(at-last.at<sampleInterval)return null;
    samples.push({at,bytes:current});sampleCount++;
    while(samples.length>2 && samples[1].at<=at-window)samples.shift();
    const first=samples[0],elapsed=at-started,received=current-start,remaining=identity.size-current;
    if(elapsed<warmup || sampleCount<4 || received<1 || remaining<=0) {badSince=null;return null;}
    const rate=(current-first.bytes)/(at-first.at);
    const recent=samples.find(sample=>sample.at>=at-recentWindow) || first;
    const recentRate=at>recent.at?(current-recent.bytes)/(at-recent.at):rate;
    const eta=rate>0?remaining/rate:Infinity,available=deadline-at;
    const nearEnd=remaining<=Math.min(8*1024*1024,identity.size*0.05);
    if(recentRate>rate*1.15){if(improvingSince===null)improvingSince=at;}else improvingSince=null;
    const improving=improvingSince!==null && (at-improvingSince>=recentWindow || remaining/recentRate<=available);
    // A brief pause cannot trigger by itself. Improving recent throughput
    // clears the suspicion; a near-complete transfer still needs a viable ETA.
    if(improving || nearEnd && (eta<=60000 || eta<=available) || eta<=available*1.25) {
      badSince=null;return null;
    }
    if(badSince===null)badSince=at;
    if(at-badSince<sustain)return null;
    return {elapsedMs:elapsed,windowMs:at-first.at,receivedBytes:received,remainingBytes:remaining,
      estimatedRemainingMs:Number.isFinite(eta)?Math.min(2147483647,Math.ceil(eta)):null,
      sourceRemainingMs:Math.max(0,Math.ceil(available)),slowForMs:at-badSince};
  };
}
async function prefixHasher(file,{signal,check=()=>{}}={}) {
  check();const hash=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(file,{signal})){check();hash.update(chunk);}
  check();
  return hash;
}
async function loadDownloadCheckpoint({partial,record,identity,sources,signal,check=()=>{}}) {
  check();
  let saved;
  try {const stat=regularFile(record);if(stat && stat.size<4096)saved=JSON.parse(fs.readFileSync(record,'utf8'));}catch{}
  const stat=regularFile(partial),plan=digest(JSON.stringify(identity)),content=downloadContent(identity);
  const admitted=new Map(sources.map(source=>[safeSource(source.url),source]));
  if(saved?.schema==='nora-download-partial/1') {
    const previous=sources.find(source=>digest(JSON.stringify([source.url,identity]))===saved.expected);
    if(previous && strongETag(saved.etag))saved={...saved,schema:'nora-download-partial/2',
      requestUrl:safeSource(previous.url),plan,content};
    else saved=null;
  }
  if(stat && identity.sha256 && identity.size && saved?.schema==='nora-download-partial/2'
    && saved.content===content && saved.plan===plan && admitted.has(saved.requestUrl)
    && saved.encoding==='identity' && (saved.etag==null || strongETag(saved.etag))
    && typeof saved.source==='string' && /^[a-f0-9]{64}$/.test(saved.prefixSha256 || '')
    && Number.isSafeInteger(saved.size) && saved.size>0 && saved.size<=identity.size && stat.size>=saved.size) {
    try {
      validateSourceResponse(admitted.get(saved.requestUrl),{url:saved.source});
      // A process can die after writing data but before committing its record.
      // Those bytes are deliberately discarded before checking the prefix.
      check();if(stat.size!==saved.size)fs.truncateSync(partial,saved.size);
      const hash=await prefixHasher(partial,{signal,check});check();
      if(hash.copy().digest('hex')===saved.prefixSha256) {
        atomicJson(record,saved);check();return {saved,hash};
      }
    }catch(error){if(signal?.aborted || error?.code && !['VERIFICATION_FAILED','ENOENT'].includes(error.code))throw error;}
  }
  check();
  cleanupDownload([partial,record,record+'.tmp']);return {saved:null,hash:crypto.createHash('sha256')};
}
async function downloadAsset(options) {
  const {url,fetcher=fetch,signal,policy={},onEvent=()=>{}}=options;
  validateDownloadRequest(options);signal?.throwIfAborted();
  // Preserve build-owned source admission even when no network is needed.
  sourceCandidates(url,{sources:policy.sources});
  if(await verifiedDownload(options.target,options.identity))return {file:options.target,cached:true};
  await refreshFixedPlanSource({...options,fetcher,signal,policy,onEvent});
  const sources=operationSources(url,{sources:policy.sources},policy.sourceContext),now=policy.now || Date.now;
  const deadline=Math.min(policy.deadlineAt ?? Infinity,now()+(policy.downloadBudgetMs ?? 1800000));
  const failures=[];
  for(let index=0;index<sources.length;index++) {
    signal?.throwIfAborted();
    const remaining=deadline-now();
    if(remaining<=0)throw await sourceFailure(launcherError('资源下载已超过有限等待预算。',
      {code:'TIMEOUT',source:'release_service',site:'release.download'},failures.at(-1)),url,options.identity,fetcher,failures,sources);
    const source=sources[index];
    // A slow source has a finite phase, and each backup retains a transfer
    // window. All phases share one operation deadline and one content prefix.
    const reserve=Math.min(policy.backupBudgetMs ?? 300000,remaining/sources.length);
    const sourceDeadline=Math.min(deadline,now()+remaining-reserve*(sources.length-index-1));
    const requestAttempts=policy.maxAttempts ?? (fetcher.releaseRead===true?fetcher.releasePolicy?.maxAttempts:undefined);
    const bodyAttempts=Math.max(1,Math.min(3,policy.downloadBodyMaxAttempts ?? (requestAttempts===1?1:2)));
    let failure;
    for(let attempt=1;attempt<=bodyAttempts;attempt++) {
      try {return await downloadFromSource({...options,fetcher,url:source.url,source,sources,policy:{...policy,source,deadlineAt:deadline,
        sourceDeadlineAt:sourceDeadline,hasNextSource:index<sources.length-1,
        ...(sources.length>1?{...sourceReadPolicy(source,index,policy,fetcher),downloadIdleTimeoutMs:policy.downloadIdleTimeoutMs ?? 60000}:{})}});}
      catch(error) {
        failure=error;
        const wait=policy.downloadBodyBackoffMs?.[attempt-1] ?? policy.backoffMs?.[attempt-1] ?? 250;
        const retry=attempt<bodyAttempts && error.downloadBodyFailure===true && error.downloadCheckpointSaved===true
          && error.downloadPhaseExpired!==true && error.downloadSlowSourceEstimate!==true && transient(error) && !signal?.aborted
          && !(error.downloadIdleExpired===true && index<sources.length-1)
          && Number.isFinite(wait) && wait>=0 && wait<sourceDeadline-now();
        if(!retry)break;
        try {(policy.diagnostics || fetcher.releasePolicy?.diagnostics)?.write('network.download.retry',{
          source:source.id,attempt,nextAttempt:attempt+1,delayMs:wait,message:'正文传输中断，保留已提交字节并向同一来源续传。'});}catch{}
        await (policy.sleep || ((ms,abort)=>delay(ms,undefined,{signal:abort})))(wait,signal);
      }
    }
    failures.push(failure);
    if(signal?.aborted || index===sources.length-1 || !maySwitchSource(failure,source))
      throw await sourceFailure(failure,url,options.identity,fetcher,failures,sources);
    sourceNotice(fetcher,policy,source,sources[index+1],failure,onEvent);
  }
}
async function downloadFromSource({url,target,identity,fetcher,signal,onEvent=()=>{},policy={},source:sourceCandidate,sources,task='正在下载发布资源',maxSize=2*1024**3}) {
  validateDownloadRequest({url,identity,maxSize});signal?.throwIfAborted();
  const now=policy.now || Date.now;
  const deadline=Math.min(policy.deadlineAt ?? Infinity,policy.sourceDeadlineAt ?? now()+(policy.downloadBudgetMs ?? 1800000));
  const idle=new AbortController(),phase=new AbortController();let idleTimer;
  const timeoutReason=()=>new DOMException('资源来源已超过有限等待预算','TimeoutError');
  const phaseTimer=setTimeout(()=>phase.abort(timeoutReason()),Math.max(1,Math.ceil(deadline-now())));phaseTimer.unref?.();
  const downloadSignal=AbortSignal.any([signal || new AbortController().signal,idle.signal,phase.signal]);
  const checkDeadline=()=>{
    // The clock check also covers synchronous filesystem work which can delay
    // the timer callback. Hashing and retries never create a new phase window.
    if(now()>=deadline && !phase.signal.aborted)phase.abort(timeoutReason());
    downloadSignal.throwIfAborted();
  };
  const verified=file=>verifiedDownload(file,identity,{signal:downloadSignal,check:checkDeadline});
  const partial=target+'.partial',record=partial+'.json',replacement=partial+'.replacement';
  const resetIdle=()=>{clearTimeout(idleTimer);
    if(policy.downloadIdleTimeoutMs!=null)idleTimer=setTimeout(()=>idle.abort(new DOMException('资源来源长时间没有新增下载字节','TimeoutError')),policy.downloadIdleTimeoutMs);};
  const protocolError=()=>launcherError('发布资源校验失败：响应或文件与固定内容不符，未使用下载文件。',
    {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
  let saved=null,initialStart=0,start=0,hash=crypto.createHash('sha256'),checkpointLoaded=false;
  let response,representation=null,outputFile=partial,checkpointSaved=false,bodyFailure=false;
  try {
    checkDeadline();if(await verified(target)){checkDeadline();return {file:target,cached:true};}
    // A prior replacement was never committed. The original checkpoint remains
    // authoritative until the replacement passes whole-file verification.
    cleanupDownload([replacement,record+'.tmp']);checkDeadline();
    const loaded=await loadDownloadCheckpoint({partial,record,identity,sources,signal:downloadSignal,check:checkDeadline});
    checkpointLoaded=true;saved=loaded.saved;checkpointSaved=Boolean(saved);
    initialStart=saved?.size || 0;start=initialStart;hash=loaded.hash;checkDeadline();
    const requestUrl=safeSource(url),headers=new Headers({'User-Agent':RELEASE_USER_AGENT,'Accept-Encoding':'identity'});
    if(start) {
      headers.set('Range',`bytes=${start}-`);
      // ETags identify a representation at one source, not content at mirrors.
      if(saved.requestUrl===requestUrl && saved.source===requestUrl && strongETag(saved.etag))headers.set('If-Range',saved.etag);
    }
    onEvent({event:'task',stage_id:'download',task});onEvent({event:'progress',stage_id:'download',current:start,total:identity.size || 0});
    checkDeadline();response=await fetchRead(fetcher,url,{headers,signal:downloadSignal},policy);
    // A full replacement attempt must preserve the original prefix even when
    // headers or a missing body cause rejection before any file is opened.
    if(response.status===200 && start)outputFile=replacement;
    validateSourceResponse(sourceCandidate,response);
    const source=safeSource(response.url || url),etag=response.headers.get('etag');
    const encoding=(response.headers.get('content-encoding') || 'identity').toLowerCase();
    if(encoding!=='identity')throw protocolError();
    if(response.status===416 && start) {
      if(response.headers.get('content-range')!==`bytes */${identity.size}` || !await verified(partial))throw protocolError();
      await response.body?.cancel();checkDeadline();
      fs.renameSync(partial,target);cleanupDownload([record,record+'.tmp']);return {file:target,cached:false,resumed:true};
    }
    if(!response.ok || !response.body)throw launcherError(`发布资源下载失败（HTTP ${response.status}）。`,
      {...responseEvidence(response),attempt:response.launcherAttempt,source:'release_service',site:'release.download'});
    let responseSize;
    if(response.status===206) {
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      const numbers=range?.slice(1).map(Number);
      if(!start || !numbers?.every(Number.isSafeInteger) || numbers[0]!==start || numbers[2]!==identity.size
        || numbers[1]<start || numbers[1]!==identity.size-1 || headers.has('If-Range') && (etag!==saved.etag || source!==saved.source))throw protocolError();
      // Without If-Range, an admitted provider may choose another managed
      // mirror. Range and final whole-file SHA still bind the fixed content.
      responseSize=numbers[1]-start+1;
    } else if(response.status===200) {
      start=0;hash=crypto.createHash('sha256');responseSize=identity.size;
    } else throw protocolError();
    const declared=response.headers.get('content-length');
    if(declared!==null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))
      || responseSize && Number(declared)!==responseSize || Number(declared)>maxSize))throw protocolError();
    representation=identity.sha256 && identity.size
      ? {schema:'nora-download-partial/2',content:downloadContent(identity),plan:digest(JSON.stringify(identity)),
        requestUrl,source,etag:strongETag(etag)?etag:null,encoding:'identity'}:null;
    resetIdle();checkDeadline();const output=await fs.promises.open(outputFile,start?'a':'w',0o600);
    let current=start,lastProgress=0,lastCheckpoint=0,committed=start,transferFailure;
    const estimateSlow=representation && outputFile===partial && policy.hasNextSource
      ?slowSourceEstimator({identity,start,now,deadline,policy}):null;
    const checkpoint=async()=>{
      if(!representation || outputFile!==partial || current<=0)return;
      await output.sync();
      atomicJson(record,{...representation,size:current,prefixSha256:hash.copy().digest('hex')});
      committed=current;lastCheckpoint=Date.now();checkpointSaved=true;
    };
    try {
      for await(const chunk of Readable.fromWeb(response.body,{signal:downloadSignal})) {
        checkDeadline();if(current+chunk.length>(identity.size || maxSize))throw protocolError();
        await output.writeFile(chunk);hash.update(chunk);current+=chunk.length;checkDeadline();
        if(chunk.length)resetIdle();
        if(current-committed>=(policy.downloadCheckpointBytes ?? 4*1024*1024)
          || Date.now()-lastCheckpoint>=(policy.downloadCheckpointIntervalMs ?? 2000))await checkpoint();
        checkDeadline();
        const estimate=estimateSlow?.(current);
        if(estimate) {
          // Commit first: cancellation and the next source must observe the
          // same durable fixed-content prefix, even below the periodic size.
          await checkpoint();checkDeadline();
          try {(policy.diagnostics || fetcher.releasePolicy?.diagnostics)?.write('network.download.slow_source',{
            source:sourceCandidate.id,...estimate,message:'持续下载速度预计无法在来源预算内完成，保留已提交字节并提前尝试下一来源。'});}catch{}
          const error=launcherError('当前来源持续传输过慢，预计无法在有限预算内完成。',
            {code:'TIMEOUT',source:'release_service',site:'release.download'});
          error.downloadSlowSourceEstimate=true;throw error;
        }
        if(Date.now()-lastProgress>=250) {lastProgress=Date.now();onEvent({event:'progress',stage_id:'download',current,total:identity.size || Number(declared) || 0});}
      }
      await output.sync();checkDeadline();
      if(identity.size && current!==identity.size)throw Object.assign(new Error('发布资源连接中断，下载尚未完整。'),{code:'ECONNRESET'});
    }catch(error) {
      transferFailure=error;bodyFailure=true;
      const code=downloadSignal.reason?.name==='TimeoutError'?'TIMEOUT':transportCode(error);
      if(signal?.aborted || downloadSignal.aborted || transient(error) || code && transient({code})) {
        try {await checkpoint();}catch(saveError){try {error.secondaryErrors=[...(error.secondaryErrors || []),{operation:'download-checkpoint',error:saveError}];}catch{}}
      }
      throw error;
    }finally {
      try {await output.close();}catch(error){if(!transferFailure)throw error;
        try {transferFailure.secondaryErrors=[...(transferFailure.secondaryErrors || []),error];}catch{}}
    }
    clearTimeout(idleTimer);checkDeadline();
    onEvent({event:'progress',stage_id:'download',current,total:identity.size || current});
    onEvent({event:'task',stage_id:'verify',task:'正在校验下载资源'});
    checkDeadline();if(identity.sha256 && !await verified(outputFile))throw protocolError();
    checkDeadline();
    fs.renameSync(outputFile,target);cleanupDownload([partial,record,record+'.tmp',replacement]);
    return {file:target,cached:false,resumed:Boolean(initialStart && outputFile===partial)};
  }catch(error) {
    const code=downloadSignal.reason?.name==='TimeoutError'?'TIMEOUT':transportCode(error);
    if(code && error.code!==code)error=launcherError(error.message,{code},error);
    try {if(!error.source)error.source='release_service';if(!error.site || error.site==='release.request')error.site='release.download';
      error.downloadBodyFailure=bodyFailure;error.downloadPhaseExpired=phase.signal.aborted || now()>=deadline;
      error.downloadIdleExpired=idle.signal.aborted;
      error.downloadCheckpointSaved=checkpointSaved;}catch{}
    await rememberFailureResource(error,url,identity,fetcher);
    const recoverable=signal?.aborted || downloadSignal.aborted || transient(error) || maySwitchSource(error,sourceCandidate);
    // Failed fresh 200 downloads cannot destroy a useful original prefix.
    // Even on a verification failure it remains unavailable until a future
    // entire-file SHA succeeds; the rejected replacement is always removed.
    const preserve=outputFile===replacement && Boolean(saved) || checkpointSaved && recoverable
      || !checkpointLoaded && (signal?.aborted || downloadSignal.aborted || now()>=deadline);
    cleanupDownload([replacement,record+'.tmp'],error);
    if(!preserve)cleanupDownload([partial,record],error);
    throw error;
  }finally {clearTimeout(idleTimer);clearTimeout(phaseTimer);if(response?.body && !response.bodyUsed)await response.body.cancel().catch(()=>{});}
}

// Electron net.fetch cancels manual redirects instead of exposing their 3xx
// response. Keep Chromium's session/proxy/TLS stack, but expose one net.request
// hop so readSource can validate the destination before issuing the next one.
function chromiumManualRead(net,url,options) {
  options.signal?.throwIfAborted();
  const method=String(options.method || 'GET').toUpperCase();
  if(!['GET','HEAD'].includes(method) || options.body!=null)throw new TypeError('发布手动跳转仅支持只读请求。');
  return new Promise((resolve,reject)=>{
    const request=net.request({url:String(url),method,redirect:'manual',
      headers:Object.fromEntries(new Headers(options.headers)),credentials:'omit',
      cache:'no-store',bypassCustomProtocolHandlers:true});
    let settled=false,closedIntentionally=false,incoming;
    const cleanup=()=>options.signal?.removeEventListener('abort',abort);
    const fail=error=>{
      if(closedIntentionally)return;
      if(!settled){settled=true;cleanup();reject(error);}
      else if(incoming && !incoming.destroyed)incoming.destroy(error);
    };
    const abort=()=>{
      fail(options.signal.reason || new DOMException('发布请求已取消','AbortError'));
      request.abort();
    };
    const stopCompleted=()=>{closedIntentionally=true;cleanup();request.abort();};
    const responseHeaders=raw=>{
      const headers=new Headers();
      for(const [name,value] of Object.entries(raw))for(const item of Array.isArray(value)?value:[value])headers.append(name,item);
      return headers;
    };
    const complete=(body,status,headers)=>{
      const response=new Response(body,{status,headers});
      Object.defineProperty(response,'url',{value:String(url)});
      settled=true;resolve(response);
    };
    request.on('error',fail);
    request.once('abort',()=>fail(options.signal?.reason || new DOMException('发布请求已取消','AbortError')));
    request.once('redirect',(status,_method,destination,raw)=>{
      try {
        const headers=responseHeaders(raw);
        if(!headers.has('location'))headers.set('location',destination);
        complete(null,status,headers);
      } catch(error){fail(error);}
      // Never follow here. The existing source validator owns every next hop.
      stopCompleted();
    });
    request.once('response',message=>{
      incoming=message;
      // Teardown may deliver a late native error even for a bodyless response,
      // or before a Response could be constructed. Keep that event handled.
      incoming.on('error',()=>{});
      try {
        incoming.once('end',()=>{closedIntentionally=true;cleanup();});
        incoming.once('close',()=>{cleanup();if(!incoming.readableEnded)stopCompleted();});
        if(method==='HEAD' || [204,205,304].includes(incoming.statusCode)) {
          complete(null,incoming.statusCode,responseHeaders(incoming.headers));
          stopCompleted();return;
        }
        // Electron 38 IncomingMessage is a Node Readable with native loader
        // backpressure. Count bytes in the Web stream queue, rather than letting
        // its default chunk-count strategy buffer thousands of large chunks.
        const body=Readable.toWeb(incoming,{strategy:{highWaterMark:incoming.readableHighWaterMark,
          size:chunk=>chunk.byteLength}});
        complete(body,incoming.statusCode,responseHeaders(incoming.headers));
      } catch(error){fail(error);stopCompleted();}
    });
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted){abort();return;}
    request.end();
  });
}

function createReleaseNetwork({ app, net, diagnostics, onRetry = () => {}, policy = {},routeFor }) {
  async function readOnce(url,options={}){
    await app.whenReady();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('发布资源必须使用 HTTPS。');
    if(options.redirect==='manual')return chromiumManualRead(net,url,options);
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

module.exports = { createReleaseNetwork,createReleaseSourceContext,fetchRead,responseEvidence,createMetadataCache,metadataJson,downloadAsset };
