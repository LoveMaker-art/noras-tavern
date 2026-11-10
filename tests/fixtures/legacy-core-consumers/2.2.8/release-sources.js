const configuration = require('./release-sources.json');
const {launcherError} = require('./launcher-errors');
const repository = 'LoveMaker-art/noras-tavern';
const tagPattern = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const assetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELEASE_PAGE_SIZE = 10;
const RELEASE_MAX_PAGES = 50; // Preserve the existing 500-release discovery bound.
function releaseListUrl(page=1) {
  if(!Number.isInteger(page)||page<1||page>RELEASE_MAX_PAGES)throw new Error('Invalid release catalogue page');
  return `https://api.github.com/repos/${repository}/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`;
}
function releaseListRequest(value) {
  let url;try{url=new URL(value);}catch{return null;}
  if(url.origin!=='https://api.github.com'||url.pathname!==`/repos/${repository}/releases`
    ||url.username||url.password||url.hash)return null;
  const match=/^\?per_page=(10|100)&page=([1-9]\d?)$/.exec(url.search);
  if(!match)return null;
  const size=Number(match[1]),page=Number(match[2]);
  return page<=(size===100?5:RELEASE_MAX_PAGES)?{size,page}:null;
}

// Build-owned roots only. Release metadata cannot introduce another host.
function validateSources(value) {
  const invalid = () => launcherError('资源来源配置无效，未下载或修改安装。',
    {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
  if(!value || value.schema!==1 || !Array.isArray(value.mirrors) || value.mirrors.length>2
    || Object.keys(value).some(key=>!['schema','mirrors','primary'].includes(key))) throw invalid();
  const ids=new Set(['github']),origins=new Set(['https://github.com','https://api.github.com']);
  const mirrors=value.mirrors.map(item=>{
    if(!item || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id) || ids.has(item.id)
      || typeof item.baseUrl!=='string' || Object.keys(item).some(key=>!['id','baseUrl','provider','channelBaseUrl'].includes(key))
      || item.provider!=null && !['sourceforge','jihulab'].includes(item.provider)
      || item.provider!=='jihulab' && Object.hasOwn(item,'channelBaseUrl')) throw invalid();
    let root;try {root=new URL(item.baseUrl);} catch {throw invalid();}
    if(root.protocol!=='https:' || root.username || root.password || root.search || root.hash
      || !root.pathname.endsWith('/') || origins.has(root.origin)) throw invalid();
    if(item.provider==='sourceforge' && (root.origin!=='https://downloads.sourceforge.net'
      || !/^\/project\/[a-z0-9][a-z0-9-]{2,29}\/$/.test(root.pathname))) throw invalid();
    let channelRoot;
    if(item.provider==='jihulab') {
      const identity=/^\/api\/v4\/projects\/([1-9][0-9]*)\/packages\/generic\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})\/$/.exec(root.pathname);
      if(root.origin!=='https://jihulab.com' || item.baseUrl!==root.href || !identity
        || !Number.isSafeInteger(Number(identity[1])))throw invalid();
      try {channelRoot=new URL(item.channelBaseUrl);} catch {throw invalid();}
      const raw=/^\/((?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}\/){2,})-\/raw\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/$/.exec(channelRoot.pathname);
      if(channelRoot.origin!=='https://jihulab.com' || item.channelBaseUrl!==channelRoot.href || channelRoot.username || channelRoot.password
        || channelRoot.search || channelRoot.hash || !raw || raw[2].includes('..') || /(?:\.|\.lock)$/.test(raw[2]))throw invalid();
    }
    ids.add(item.id);origins.add(root.origin);
    return {id:item.id,baseUrl:root.href,origin:root.origin,mirror:true,...(item.provider?{provider:item.provider}:{}),
      ...(channelRoot?{channelBaseUrl:channelRoot.href}:{})};
  });
  if(value.primary!=null && !ids.has(value.primary))throw invalid();
  return mirrors;
}

function sourceCandidates(value,{channel='stable',sources=configuration}={}) {
  const mirrors=validateSources(sources),url=new URL(value);
  let relative;
  const api=`/repos/${repository}/releases`;
  if(url.origin==='https://api.github.com' && !url.hash) {
    if(url.pathname===api+'/latest' && !url.search && channel==='stable') relative='channels/stable.json';
    else if(releaseListRequest(url)?.page===1 && ['beta','stable'].includes(channel))
      relative=channel==='beta'?'channels/beta.json':'channels/launcher-stable.json';
    else if(url.pathname.startsWith(api+'/tags/') && !url.search) {
      const tag=decodeURIComponent(url.pathname.slice((api+'/tags/').length));
      if(tagPattern.test(tag)) relative=`releases/${encodeURIComponent(tag)}/release.json`;
    }
  } else if(url.origin==='https://github.com' && !url.search && !url.hash) {
    const prefix=`/${repository}/releases/download/`;
    if(url.pathname.startsWith(prefix)) {
      const [tag,name,...rest]=url.pathname.slice(prefix.length).split('/').map(decodeURIComponent);
      if(!rest.length && tagPattern.test(tag) && assetPattern.test(name))
        relative=`releases/${encodeURIComponent(tag)}/${name}`;
    }
  }
  const alternate=relative?mirrors.map(item=>({...item,
    ...(['channels/beta.json','channels/launcher-stable.json'].includes(relative)?{catalogueComplete:true}:{}),
    url:new URL(['sourceforge','jihulab'].includes(item.provider)
    ?relative.replace(/^releases\//,''):relative,item.provider==='jihulab' && relative.startsWith('channels/')
      ?item.channelBaseUrl:item.baseUrl).href})):[];
  const github={id:'github',url:String(value),mirror:false};
  const candidates=[...alternate,github],primary=candidates.find(item=>item.id===sources.primary);
  // An explicit domestic primary is followed by the canonical repository,
  // then the extra mirror. Unspecified schema-1 ordering remains compatible.
  return primary?[primary,...(primary!==github?[github]:[]),
    ...alternate.filter(item=>item!==primary)]:candidates;
}

function validateSourceResponse(source,response) {
  let final;
  try {final=new URL(response.url || source.url);} catch {
    throw launcherError('资源响应地址无效，未使用下载内容。',
      {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
  }
  const sourceforge=source.provider==='sourceforge';
  const permitted=sourceforge ? (final.origin===source.origin || /^[a-z0-9-]+\.dl\.sourceforge\.net$/i.test(final.hostname))
    && final.port==='' && final.pathname===new URL(source.url).pathname
    : source.provider==='jihulab' ? final.origin===source.origin && !final.search
      && final.pathname===new URL(source.url).pathname : !source.mirror || final.origin===source.origin;
  if(final.protocol!=='https:' || final.username || final.password || final.hash || !permitted)
    throw launcherError('资源响应偏离受信任来源，未使用下载内容。',
      {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
}

// Provider redirects are checked before the next request. JihuLab object
// storage roots remain denied until an actual project response establishes them.
async function readSource(fetcher,source,url,options={}) {
  if(!['sourceforge','jihulab'].includes(source?.provider))return fetcher(url,options);
  let target=url;
  for(let hop=0;hop<6;hop++) {
    options.signal?.throwIfAborted();
    validateSourceResponse(source,{url:target});
    const response=await fetcher(target,{...options,redirect:'manual'});
    try {validateSourceResponse(source,{url:response.url || target});}
    catch(error){await response.body?.cancel().catch(()=>{});throw error;}
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');
    await response.body?.cancel().catch(()=>{});
    if(!location)break;
    try {
      const next=new URL(location,target);
      if(next.origin!==new URL(target).origin) {
        const headers=new Headers(options.headers);headers.delete('If-Range');
        options={...options,headers};
      }
      target=next.href;
    } catch {break;}
  }
  throw launcherError('资源来源跳转异常，未使用下载内容。',
    {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
}

module.exports={sourceCandidates,validateSourceResponse,validateSources,readSource,releaseListUrl,releaseListRequest,RELEASE_PAGE_SIZE,RELEASE_MAX_PAGES};
