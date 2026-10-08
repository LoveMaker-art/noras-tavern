const configuration = require('./release-sources.json');
const {launcherError} = require('./launcher-errors');
const repository = 'LoveMaker-art/noras-tavern';
const tagPattern = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const assetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Build-owned roots only. Release metadata cannot introduce another host.
function validateSources(value) {
  const invalid = () => launcherError('资源来源配置无效，未下载或修改安装。',
    {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
  if(!value || value.schema!==1 || !Array.isArray(value.mirrors) || value.mirrors.length>2
    || Object.keys(value).some(key=>!['schema','mirrors','primary'].includes(key))
    || value.primary!=null && value.primary!=='github') throw invalid();
  const ids=new Set(['github']),origins=new Set(['https://github.com','https://api.github.com']);
  return value.mirrors.map(item=>{
    if(!item || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id) || ids.has(item.id)
      || typeof item.baseUrl!=='string' || Object.keys(item).some(key=>!['id','baseUrl','provider'].includes(key))
      || item.provider!=null && item.provider!=='sourceforge') throw invalid();
    let root;try {root=new URL(item.baseUrl);} catch {throw invalid();}
    if(root.protocol!=='https:' || root.username || root.password || root.search || root.hash
      || !root.pathname.endsWith('/') || origins.has(root.origin)) throw invalid();
    if(item.provider==='sourceforge' && (root.origin!=='https://downloads.sourceforge.net'
      || !/^\/project\/[a-z0-9][a-z0-9-]{2,29}\/$/.test(root.pathname))) throw invalid();
    ids.add(item.id);origins.add(root.origin);
    return {id:item.id,baseUrl:root.href,origin:root.origin,mirror:true,...(item.provider?{provider:item.provider}:{})};
  });
}

function sourceCandidates(value,{channel='stable',sources=configuration}={}) {
  const mirrors=validateSources(sources),url=new URL(value);
  let relative;
  const api=`/repos/${repository}/releases`;
  if(url.origin==='https://api.github.com' && !url.hash) {
    if(url.pathname===api+'/latest' && !url.search && channel==='stable') relative='channels/stable.json';
    else if(url.pathname===api && url.search==='?per_page=100&page=1' && channel==='beta') relative='channels/beta.json';
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
  const alternate=relative?mirrors.map(item=>({...item,url:new URL(item.provider==='sourceforge'
    ?relative.replace(/^releases\//,''):relative,item.baseUrl).href})):[];
  const github={id:'github',url:String(value),mirror:false};
  return sources.primary==='github'?[github,...alternate]:[...alternate,github];
}

function validateSourceResponse(source,response) {
  const final=new URL(response.url || source.url);
  const sourceforge=source.provider==='sourceforge';
  const permitted=sourceforge ? (final.origin===source.origin || /^[a-z0-9-]+\.dl\.sourceforge\.net$/i.test(final.hostname))
    && final.port==='' && final.pathname===new URL(source.url).pathname
    : !source.mirror || final.origin===source.origin;
  if(final.protocol!=='https:' || final.username || final.password || final.hash || !permitted)
    throw launcherError('资源响应偏离受信任来源，未使用下载内容。',
      {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
}

// SourceForge redirects to a managed mirror. Check every hop before sending
// the next request, rather than trusting only the final response URL.
async function readSource(fetcher,source,url,options) {
  if(source?.provider!=='sourceforge')return fetcher(url,options);
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
    try {target=new URL(location,target).href;} catch {break;}
  }
  throw launcherError('资源来源跳转异常，未使用下载内容。',
    {code:'VERIFICATION_FAILED',source:'release_service',site:'release.verify'});
}

module.exports={sourceCandidates,validateSourceResponse,validateSources,readSource};
