const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const https=require('node:https');
const {Readable}=require('node:stream');
const {execFileSync,spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const crypto=require('node:crypto');
const desktop=fs.existsSync(path.resolve(__dirname,'../../launcher/desktop/release-network.js'))
  ? path.resolve(__dirname,'../../launcher/desktop') : path.resolve(__dirname,'../installer/desktop');
const networkModule=require(path.join(desktop,'release-network'));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function server(t,handler) {
  const requests=[];
  const service=http.createServer((req,res)=>{requests.push({url:req.url,headers:req.headers});handler(req,res,requests.length);});
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{service.closeAllConnections();await new Promise(resolve=>service.close(resolve));});
  const base=`http://127.0.0.1:${service.address().port}`;
  return {requests,base,fetcher:async(url,options)=>{
    const result=await fetch(base+new URL(url).pathname,options);
    Object.defineProperty(result,'url',{value:String(url),configurable:true});return result;
  }};
}
const quiet={write(){},error(){}};
const sources={schema:1,mirrors:[{id:'primary',baseUrl:'https://primary.example/'}]};
const latestUrl='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest';
const assetUrl='https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/asset.zip';

test('a timed-out 80% transfer keeps its bytes when SourceForge answers with a different ETag',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-timeout-cross-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('abcdefghij'),requests=[];
  const result=await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),
    identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},
    policy:{downloadBudgetMs:250,backupBudgetMs:100,maxAttempts:1,sources:{schema:1,primary:'github',
      mirrors:[{id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]}},
    fetcher:async(url,options)=>{
      const headers=new Headers(options.headers);requests.push({url,range:headers.get('range'),validator:headers.get('if-range')});
      if(url.startsWith('https://github.com/'))return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,8));}}),
        {headers:{ETag:'"github-representation"','Content-Length':'10'}});
      assert.equal(headers.get('range'),'bytes=8-','a source switch must keep the downloaded prefix');
      assert.equal(headers.get('if-range'),null,'a source-specific validator must not be sent to another origin');
      return new Response(bytes.subarray(8),{status:206,headers:{ETag:'"sourceforge-representation"','Content-Length':'2','Content-Range':'bytes 8-9/10'}});
    }});
  assert.equal(result.resumed,true);assert.equal(requests.length,2);assert.deepEqual(fs.readFileSync(result.file),bytes);
});

test('asset transfers identify the same product as metadata, including resumed requests',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-product-agent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('complete-product-resource'),target=path.join(root,'asset.zip'),identity={tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},seen=[];
  const isolated={schema:1,primary:'github',mirrors:[]};const etag='"fixed-product-resource"';let interrupted=true;
  const fetcher=async(url,options)=>{const headers=new Headers(options.headers);seen.push({range:headers.get('range'),agent:headers.get('user-agent')});
    assert.equal(headers.get('user-agent'),'Nora-Tavern-Launcher');
    if(interrupted){interrupted=false;return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,8));setTimeout(()=>controller.error(Object.assign(new Error('socket interrupted'),{code:'ECONNRESET'})),20);}}),{headers:{'Content-Length':String(bytes.length),ETag:etag}});}
    return new Response(bytes.subarray(8),{status:206,headers:{'Content-Length':String(bytes.length-8),'Content-Range':`bytes 8-${bytes.length-1}/${bytes.length}`,ETag:etag}});
  };
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,target,identity,fetcher,policy:{sources:isolated,maxAttempts:1}}),error=>error.code==='ECONNRESET');
  const result=await networkModule.downloadAsset({url:assetUrl,target,identity,fetcher,policy:{sources:isolated,maxAttempts:1}});
  assert.equal(result.resumed,true);assert.deepEqual(seen,[{range:null,agent:'Nora-Tavern-Launcher'},{range:'bytes=8-',agent:'Nora-Tavern-Launcher'}]);assert.equal(sha(fs.readFileSync(target)),identity.sha256);
});

test('one fixed operation uses its fully received asset metadata source for the following complete asset',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-operation-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=crypto.randomBytes(16384),metadataUrl=assetUrl.replace('asset.zip','release-manifest.json'),calls=[];
  const sf={schema:1,primary:'github',mirrors:[{id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]};
  const context=networkModule.createReleaseSourceContext?.({tag:'v2.4.2'}),policy={sources:sf,maxAttempts:1,sourceContext:context};
  const local=await server(t,(request,response)=>{calls.push(request.url);if(request.url.startsWith('/LoveMaker-art/')){response.writeHead(503);response.end('unavailable');}
    else if(request.url.endsWith('/release-manifest.json')){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({tag:'v2.4.2',size:bytes.length,sha256:sha(bytes)}));}
    else{response.setHeader('Content-Length',String(bytes.length));response.end(bytes);}});
  const metadata=await networkModule.metadataJson(metadataUrl,{fetcher:local.fetcher,policy});assert.equal(metadata.value.sha256,sha(bytes));
  // API success must not erase the asset provider just established in this operation.
  await networkModule.metadataJson(latestUrl,{fetcher:async()=>Response.json({tag_name:'v2.4.2'}),policy});
  const target=path.join(root,'asset.zip');await networkModule.downloadAsset({url:assetUrl,target,identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},fetcher:local.fetcher,policy});
  assert.equal(sha(fs.readFileSync(target)),sha(bytes));
  assert.deepEqual(calls,[new URL(metadataUrl).pathname,'/project/nora-tavern/v2.4.2/release-manifest.json','/project/nora-tavern/v2.4.2/asset.zip']);
});

test('source preference is isolated by target and operation, and cache or revalidation cannot seed it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-source-isolation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const url=assetUrl.replace('asset.zip','release-manifest.json'),sf={schema:1,primary:'github',mirrors:[{id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]};
  let clock=Date.now();const file=path.join(root,'cache.json'),cache=networkModule.createMetadataCache({file,now:()=>clock});
  const first=networkModule.createReleaseSourceContext({tag:'v2.4.2'}),policy={sources:sf,maxAttempts:1,sourceContext:first};
  const fetcher=async value=>value.startsWith('https://github.com/')?new Response('offline',{status:503}):Response.json({tag:'v2.4.2'},{headers:{ETag:'"fixed"'}});
  await networkModule.metadataJson(url,{fetcher,metadataCache:cache,policy});assert.equal(first.preferredSource(assetUrl),'sourceforge');
  assert.equal(first.preferredSource(assetUrl.replace('v2.4.2','v2.4.3')),null);assert.equal(first.preferredSource(latestUrl),null);
  assert.throws(()=>first.bindTarget('v2.4.3'),error=>error.code==='VERIFICATION_FAILED');
  const next=networkModule.createReleaseSourceContext({tag:'v2.4.2'});
  const cached=await networkModule.metadataJson(url,{fetcher,metadataCache:cache,policy:{...policy,sourceContext:next}});
  assert.equal(cached.source,'cache');assert.equal(next.preferredSource(assetUrl),null);
  clock+=cache.ttlMs+1;
  const revalidated=await networkModule.metadataJson(url,{metadataCache:cache,policy:{...policy,sourceContext:next},fetcher:async value=>
    value.startsWith('https://github.com/')?new Response('offline',{status:503}):new Response(null,{status:304,headers:{ETag:'"fixed"'}})});
  assert.equal(revalidated.source,'revalidated');assert.equal(next.preferredSource(assetUrl),null);
  assert.equal(JSON.stringify(first),'{}');assert.doesNotMatch(fs.readFileSync(file,'utf8'),/sourceContext|preferredSource/);
});

test('invalid metadata or a mismatched byte identity does not promote an asset source',async t=>{
  const sf={schema:1,primary:'github',mirrors:[{id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]},url=assetUrl.replace('asset.zip','release-manifest.json');
  for(const failure of ['invalid-json','certificate','identity'])await t.test(failure,async()=>{
    const context=networkModule.createReleaseSourceContext({tag:'v2.4.2'}),policy={sources:sf,maxAttempts:1,sourceContext:context};
    const fetcher=async value=>{if(value.startsWith('https://github.com/')){if(failure==='certificate')throw Object.assign(new Error('untrusted certificate'),{code:'ERR_CERT_AUTHORITY_INVALID'});return new Response('offline',{status:503});}
      return new Response(failure==='invalid-json'?'not JSON':'{}');};
    const call=networkModule.metadataJson(url,{fetcher,policy,...(failure==='identity'?{conditionIdentity:{sha256:'0'.repeat(64),size:2}}:{})});
    if(failure==='identity')await call;else await assert.rejects(call);
    assert.equal(context.preferredSource(assetUrl),null);
  });
});

test('a preferred source does not weaken integrity or the original GitHub retry allowance',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-preferred-fallback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('full-checked-bytes'),url=assetUrl.replace('asset.zip','release-manifest.json'),sf={schema:1,primary:'github',mirrors:[{id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]};
  const context=networkModule.createReleaseSourceContext({tag:'v2.4.2'}),policy={sources:sf,sourceContext:context,sleep:async()=>{},downloadBudgetMs:10000};
  await networkModule.metadataJson(url,{policy,fetcher:async value=>value.startsWith('https://github.com/')?new Response('missing',{status:404}):Response.json({tag:'v2.4.2'})});
  const calls=[];let github=0;
  await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},policy,fetcher:async value=>{
    calls.push(value);if(value.startsWith('https://downloads.sourceforge.net/'))return new Response('offline',{status:503});
    if(++github===1)throw Object.assign(new Error('connection reset'),{code:'ECONNRESET'});return new Response(bytes);
  }});
  assert.deepEqual(calls,['https://downloads.sourceforge.net/project/nora-tavern/v2.4.2/asset.zip',assetUrl,assetUrl]);assert.equal(sha(fs.readFileSync(path.join(root,'asset.zip'))),sha(bytes));
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,target:path.join(root,'invalid.zip'),identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},policy,
    fetcher:async()=>new Response(Buffer.alloc(bytes.length))}),error=>error.code==='VERIFICATION_FAILED');
  assert.equal(fs.existsSync(path.join(root,'invalid.zip')),false);
});

test('release HEAD requests use the same product user agent without losing conditional headers',async()=>{
  const fetcher=async(_url,options)=>{
    assert.equal(options.method,'HEAD');const headers=new Headers(options.headers);
    assert.equal(headers.get('user-agent'),'Nora-Tavern-Launcher');assert.equal(headers.get('if-none-match'),'"fixed"');return new Response(null);
  };
  const options={method:'HEAD',headers:{'User-Agent':'browser-default','If-None-Match':'"fixed"'}};
  await networkModule.fetchRead(fetcher,assetUrl,options,{maxAttempts:1});
  fetcher.releaseRead=true;await networkModule.fetchRead(fetcher,assetUrl,options,{maxAttempts:1});
});

test('an unavailable fixed source probe preserves the sealed download and is attempted only once per operation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-fixed-source-offline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const proof='{"fixed":true}',proofUrl=assetUrl.replace('asset.zip','release-manifest.json'),bytes=Buffer.from('fixed-content'),requests=[],events=[];
  const policy={sourceContext:networkModule.createReleaseSourceContext({tag:'v2.4.2'}),maxAttempts:1,sources:{schema:1,primary:'github',mirrors:[]}};
  const fetcher=async url=>{requests.push(url);if(url===proofUrl)return new Response('temporarily unavailable',{status:503});return new Response(bytes);};
  for(const name of ['asset.zip','second.zip'])await networkModule.downloadAsset({url:assetUrl.replace('asset.zip',name),target:path.join(root,name),identity:{tag:'v2.4.2',asset:name,size:bytes.length,sha256:sha(bytes)},fetcher,policy,onEvent:event=>events.push(event),fixedPlanSourceEvidence:{url:proofUrl,size:proof.length,sha256:sha(proof)}});
  assert.equal(requests.filter(url=>url===proofUrl).length,1);assert.equal(events.filter(event=>event.event==='log').length,1);
  assert.equal(sha(fs.readFileSync(path.join(root,'second.zip'))),sha(bytes));
});

test('fresh fixed source evidence cannot downgrade invalid bytes, JSON or certificates to an asset download',async t=>{
  const proof='{"fixed":true}',proofUrl=assetUrl.replace('asset.zip','release-manifest.json');
  for(const fault of ['sha256','size','json','certificate'])await t.test(fault,async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-fixed-source-reject-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let assets=0;
    await assert.rejects(networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),identity:{tag:'v2.4.2',asset:'asset.zip',size:4,sha256:sha('data')},
      policy:{sourceContext:networkModule.createReleaseSourceContext({tag:'v2.4.2'}),maxAttempts:1,sources:{schema:1,primary:'github',mirrors:[]}},fixedPlanSourceEvidence:{url:proofUrl,size:proof.length,sha256:sha(proof)},
      fetcher:async url=>{if(url!==proofUrl){assets++;return new Response('data');}if(fault==='certificate')throw Object.assign(new Error('certificate rejected'),{code:'ERR_CERT_AUTHORITY_INVALID'});return new Response(fault==='json'?'not-json':fault==='sha256'?'{"fixed":false}':fault==='size'?proof+' ':proof);}}),error=>['VERIFICATION_FAILED','INVALID_RESPONSE','ERR_CERT_AUTHORITY_INVALID'].includes(error.code));
    assert.equal(assets,0);assert.equal(fs.existsSync(path.join(root,'asset.zip')),false);
  });
});

test('a fresh fixed-plan source deadline is confined to its full metadata probe',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-fixed-source-budget-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const proof='{"fixed":true}',proofUrl=assetUrl.replace('asset.zip','release-manifest.json');let clock=1000;
  const policy={now:()=>clock,sourceContext:networkModule.createReleaseSourceContext({tag:'v2.4.2'}),maxAttempts:1,sources:{schema:1,primary:'github',mirrors:[]}};
  const result=await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),identity:{tag:'v2.4.2',asset:'asset.zip',size:4,sha256:sha('data')},policy,
    fixedPlanSourceEvidence:{url:proofUrl,size:proof.length,sha256:sha(proof)},onEvent:event=>{if(event.stage_id==='download')clock=200001;},
    fetcher:async url=>{if(url===proofUrl){clock=90000;return new Response(proof);}assert.ok(clock>101000);return new Response('data');}});
  assert.equal(sha(fs.readFileSync(result.file)),sha('data'));assert.equal(policy.deadlineAt,undefined);
});

test('a fully verified cached asset still rejects invalid build source configuration before any request',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-cache-source-admission-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'asset.zip');fs.writeFileSync(target,'data');let requests=0;
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,target,identity:{tag:'v2.4.2',asset:'asset.zip',size:4,sha256:sha('data')},
    policy:{sources:{schema:2,mirrors:[]}},fetcher:async()=>{requests++;return new Response('data');}}),error=>error.code==='VERIFICATION_FAILED');
  assert.equal(requests,0);assert.equal(fs.readFileSync(target,'utf8'),'data');
});

test('metadata rate-limit cooldown survives reopening and expires before querying again',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-metadata-cooldown-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'metadata.json');let clock=Date.now(),calls=0;
  const reset=Math.ceil(clock/1000)+600;
  const fetcher=async()=>{calls++;return new Response('limited',{status:403,
    headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(reset)}});};
  const policy={now:()=>clock,maxAttempts:1,sources:{schema:1,mirrors:[]}};
  const first=networkModule.createMetadataCache({file,now:()=>clock});
  await assert.rejects(networkModule.metadataJson(latestUrl,{fetcher,policy,metadataCache:first}),error=>error.rateLimited===true);
  const reopened=networkModule.createMetadataCache({file,now:()=>clock});
  await assert.rejects(networkModule.metadataJson(latestUrl,{fetcher,policy,metadataCache:reopened}),error=>error.rateLimited===true&&error.retryAfterMs>0);
  assert.equal(calls,1,'the known depleted bucket must not be contacted by another check or relaunch');
  clock=reset*1000+1;
  const result=await networkModule.metadataJson(latestUrl,{fetcher:async()=>{calls++;return Response.json({version:'2.4.2'});},policy,metadataCache:reopened});
  assert.equal(calls,2);assert.equal(result.latestConfirmed,true);
});

test('metadata cooldown skips only the throttled origin and still uses an available backup',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-metadata-backup-cooldown-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cache=networkModule.createMetadataCache({file:path.join(root,'metadata.json')});
  const calls=[];const policy={maxAttempts:1,sources};
  const fetcher=async url=>{calls.push(url);return url.startsWith('https://primary.example/')
    ?new Response('limited',{status:429,headers:{'retry-after':'600'}}):Response.json({version:'2.4.2'});};
  await networkModule.metadataJson(latestUrl,{fetcher,policy,metadataCache:cache});
  await networkModule.metadataJson(latestUrl,{fetcher,policy,metadataCache:cache});
  assert.equal(calls.filter(url=>url.startsWith('https://primary.example/')).length,1);
  assert.equal(calls.filter(url=>url.startsWith('https://api.github.com/')).length,1);
});

test('secondary rate limits use Retry-After without confusing ordinary permission failures',async()=>{
  const cache=networkModule.createMetadataCache();let calls=0;
  const limited=async()=>{calls++;return new Response('limited',{status:403,headers:{'retry-after':'600','x-ratelimit-remaining':'17'}});};
  const options={metadataCache:cache,fetcher:limited,policy:{maxAttempts:1,sources:{schema:1,mirrors:[]}}};
  await assert.rejects(networkModule.metadataJson(latestUrl,options),error=>error.rateLimited===true);
  await assert.rejects(networkModule.metadataJson(latestUrl,options),error=>error.rateLimited===true);
  assert.equal(calls,1);
  const permissionCache=networkModule.createMetadataCache();let forbidden=0;
  for(let index=0;index<2;index++)await assert.rejects(networkModule.metadataJson(latestUrl,{
    metadataCache:permissionCache,policy:{maxAttempts:1,sources:{schema:1,mirrors:[]}},fetcher:async()=>{forbidden++;return new Response('forbidden',{status:403});}}),
    error=>error.rateLimited===false);
  assert.equal(forbidden,2);
});

test('controlled HTTPS transfer reports actual bytes and survives a real primary socket interruption',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-https-source-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1',
    '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const tls={key:fs.readFileSync(key),cert:fs.readFileSync(cert)},bytes=crypto.randomBytes(32768),requests=[],progress=[];
  let primaryResponse,primaryBytesObserved=false;
  const serve=async(primary)=>{
    const service=https.createServer(tls,(request,response)=>{
      requests.push({primary,path:request.url,range:request.headers.range});
      response.writeHead(200,{'Content-Length':bytes.length,ETag:primary?'"primary"':'"backup"'});
      if(primary)primaryResponse=response;
      response.write(bytes.subarray(0,4096));
      if(!primary)setTimeout(()=>response.end(bytes.subarray(4096)),15);
    });
    await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{service.closeAllConnections();await new Promise(resolve=>service.close(resolve));});
    return `https://127.0.0.1:${service.address().port}/`;
  };
  const primary=await serve(true),backup=await serve(false);
  const fetcher=(url,options)=>new Promise((resolve,reject)=>{
    const destination=url.startsWith(primary)?url:backup+new URL(url).pathname.slice(1);
    const request=https.request(destination,{ca:tls.cert,rejectUnauthorized:true,signal:options.signal,headers:Object.fromEntries(new Headers(options.headers))},incoming=>{
      const response=new Response(Readable.toWeb(incoming),{status:incoming.statusCode,headers:incoming.headers});
      Object.defineProperty(response,'url',{value:url});resolve(response);
    });request.on('error',reject);request.end();
  });
  await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),fetcher,
    identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},
    policy:{sources:{schema:1,mirrors:[{id:'primary',baseUrl:primary}]},downloadBodyMaxAttempts:1,downloadBudgetMs:3000},
    onEvent:event=>{if(event.event==='progress'){
      progress.push({current:event.current,total:event.total});
      // Interrupt the real socket only once the production reader has observed
      // its first bytes. A wall-clock delay can fire before the client reads
      // them when this check runs alongside other platform contracts.
      if(!primaryBytesObserved&&event.current===4096&&primaryResponse){
        assert.equal(requests.length,1,'the observed bytes must precede any backup request');
        assert.equal(requests[0].primary,true);
        assert.equal(primaryResponse.destroyed,false,'the primary socket must still be live before the injected interruption');
        primaryBytesObserved=true;primaryResponse.destroy();
      }
    }}});
  assert.deepEqual(fs.readFileSync(path.join(root,'asset.zip')),bytes);
  assert.equal(requests.length,2);assert.equal(requests[0].path,'/releases/v2.4.2/asset.zip');assert.equal(requests[1].range,'bytes=4096-');
  assert.equal(primaryBytesObserved,true,'the interruption must follow a real primary-body read');
  assert.ok(progress.some(item=>item.current===4096&&item.total===bytes.length));
  assert.equal(progress.at(-1).current,bytes.length);assert.equal(fs.existsSync(path.join(root,'asset.zip.partial')),false);
});

test('a stalled primary body leaves time for the backup instead of consuming the whole download budget',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-idle-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('verified'),requests=[];
  await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},
    policy:{sources,downloadIdleTimeoutMs:25,downloadBudgetMs:500},fetcher:async url=>{
      requests.push(url);return new Response(url.startsWith('https://primary.example/')?new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,2));}}):bytes,
        {headers:{ETag:'"fixture"','Content-Length':String(bytes.length)}});
    }});
  assert.equal(requests.length,2);assert.deepEqual(fs.readFileSync(path.join(root,'asset.zip')),bytes);
});

test('source switching never masks certificate, malformed or corrupt responses',async t=>{
  for(const kind of ['certificate','malformed','redirect','digest']) await t.test(kind,async child=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-source-reject-'));child.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    let calls=0;
    const fetcher=async url=>{
      calls++;if(kind==='certificate')throw Object.assign(new Error('invalid certificate'),{code:'ERR_CERT_AUTHORITY_INVALID'});
      const response=new Response(kind==='malformed'?'not json':'bad');
      if(kind==='redirect')Object.defineProperty(response,'url',{value:'https://untrusted.example/file'});
      return response;
    };
    if(kind==='digest')await assert.rejects(networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),
      identity:{tag:'v2.4.2',asset:'asset.zip',size:3,sha256:sha('good')},policy:{sources},fetcher}),error=>error.code==='VERIFICATION_FAILED');
    else await assert.rejects(networkModule.metadataJson(latestUrl,{policy:{sources},fetcher}));
    assert.equal(calls,1);assert.equal(fs.existsSync(path.join(root,'asset.zip')),false);
  });
});

const sfSources={schema:1,primary:'github',mirrors:[{id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]};
const sfLatest='https://downloads.sourceforge.net/project/nora-tavern/channels/stable.json';
test('GitHub connection failures retry the fixed asset once before using a backup',async t=>{
  for(const message of ['net::ERR_CONNECTION_RESET','net::ERR_CONNECTION_TIMED_OUT'])await t.test(message,async child=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-github-connect-retry-'));child.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const bytes=Buffer.from('verified'),calls=[],waits=[],target=path.join(root,'asset.zip');
    await networkModule.downloadAsset({url:assetUrl,target,identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},
      policy:{sources:sfSources,backoffMs:[2,5],sleep:async ms=>waits.push(ms)},fetcher:async url=>{
        calls.push(url);if(calls.length===1)throw new Error(message);return new Response(bytes);
      }});
    assert.deepEqual(calls,[assetUrl,assetUrl]);assert.deepEqual(waits,[2]);assert.deepEqual(fs.readFileSync(target),bytes);
  });
});
test('Chromium connection timeouts download the same frozen asset through the official backup',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-chromium-connect-timeout-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('frozen checksum fixture\n'),calls=[],events=[],waits=[],error=new Error('net::ERR_CONNECTION_TIMED_OUT');
  const url='https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.5/SHA256SUMS';
  const backup='https://downloads.sourceforge.net/project/nora-tavern/v2.4.5/SHA256SUMS';
  const mirror='https://zenlayer.dl.sourceforge.net/project/nora-tavern/v2.4.5/SHA256SUMS?viasf=1';
  const target=path.join(root,'SHA256SUMS');
  await networkModule.downloadAsset({url,target,identity:{tag:'v2.4.5',asset:'SHA256SUMS',size:bytes.length,sha256:sha(bytes)},
    policy:{sources:sfSources,sleep:async ms=>waits.push(ms)},onEvent:event=>events.push(event),
    fetcher:async(request,options)=>{
      calls.push(request);
      if(request===url)throw error;
      assert.equal(options.redirect,'manual');
      if(request===backup)return new Response(null,{status:302,headers:{Location:mirror}});
      assert.equal(request,mirror);return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
    }});
  assert.deepEqual(calls,[url,url,backup,mirror]);assert.deepEqual(waits,[2000]);assert.deepEqual(fs.readFileSync(target),bytes);
  assert.equal(error.code,'TIMEOUT');
  assert.equal(require(path.join(desktop,'launcher-errors')).describeError(error).error_code,'timeout');
  assert.ok(events.some(event=>event.event==='log'&&event.line.includes('github')&&event.line.includes('sourceforge')&&event.line.includes('TIMEOUT')));
});
test('GitHub metadata connection retries keep the original source and total deadlines',async t=>{
  const url='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/v2.4.5';
  const backup='https://downloads.sourceforge.net/project/nora-tavern/v2.4.5/release.json';
  for(const outcome of ['recovered','source-budget','total-budget','body-failure'])await t.test(outcome,async()=>{
    const calls=[],waits=[];let clock=1000;
    const lookup=()=>networkModule.metadataJson(url,{policy:{sources:sfSources,now:()=>clock,
      totalBudgetMs:outcome==='total-budget'?100:100000,sleep:async ms=>{waits.push(ms);clock+=ms;}},fetcher:async request=>{
      calls.push(request);
      if(request===url&&outcome==='body-failure')return new Response(new ReadableStream({start(controller){
        controller.error(new Error('net::ERR_CONNECTION_TIMED_OUT'));
      }}));
      if(request===url&&calls.length===1){clock+=outcome==='source-budget'?29000:outcome==='total-budget'?100:19466;
        throw new Error('net::ERR_CONNECTION_RESET');}
      clock+=4000;return Response.json({tag_name:'v2.4.5'});
    }});
    if(outcome==='total-budget'){
      await assert.rejects(lookup(),error=>error.code==='TIMEOUT');assert.deepEqual(calls,[url]);assert.deepEqual(waits,[]);
    } else {
      assert.equal((await lookup()).value.tag_name,'v2.4.5');
      assert.deepEqual(calls,outcome==='recovered'?[url,url]:[url,backup]);assert.deepEqual(waits,outcome==='recovered'?[2000]:[]);
    }
  });
});
test('explicit one-attempt policies still switch once for metadata and fixed assets',async t=>{
  for(const kind of ['metadata','asset'])for(const origin of ['caller','transport'])await t.test(`${kind}-${origin}`,async child=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-explicit-source-attempt-'));child.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const calls=[],bytes=Buffer.from('verified'),policy={sources:sfSources,maxAttempts:origin==='caller'?1:undefined,
      sleep:async()=>assert.fail('an explicit single attempt must not retry')};
    const readOnce=async url=>{
      calls.push(url);if(calls.length===1)throw new Error('net::ERR_CONNECTION_RESET');
      return kind==='metadata'?Response.json({tag_name:'v2.4.5'}):new Response(bytes);
    };
    const fetcher=origin==='transport'?Object.assign(async(...args)=>readOnce(...args),{releaseRead:true,readOnce,releasePolicy:{maxAttempts:1}}):readOnce;
    if(kind==='metadata'){
      assert.equal((await networkModule.metadataJson(latestUrl,{policy,fetcher})).value.tag_name,'v2.4.5');assert.deepEqual(calls,[latestUrl,sfLatest]);
    } else {
      const target=path.join(root,'asset.zip');
      await networkModule.downloadAsset({url:assetUrl,target,policy,fetcher,identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)}});
      assert.deepEqual(calls,[assetUrl,'https://downloads.sourceforge.net/project/nora-tavern/v2.4.2/asset.zip']);assert.deepEqual(fs.readFileSync(target),bytes);
    }
  });
});
test('exhausted GitHub and backup connections retain bounded attempts and the canonical asset',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-source-network-exhaustion-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],waits=[],target=path.join(root,'asset.zip');
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,target,identity:{tag:'v2.4.2',asset:'asset.zip',size:8,sha256:sha('verified')},
    policy:{sources:sfSources,backoffMs:[2,5],sleep:async ms=>waits.push(ms)},fetcher:async url=>{
      calls.push(url);throw new Error('net::ERR_CONNECTION_TIMED_OUT');
    }}),error=>{
      assert.equal(error.code,'TIMEOUT');assert.equal(error.attempt,1);assert.equal(error.conditionResource.url,assetUrl);
      assert.equal(error.secondaryErrors[0].operation,'release-source:github');assert.equal(error.secondaryErrors[0].error.attempt,2);return true;
    });
  assert.deepEqual(calls,[assetUrl,assetUrl,'https://downloads.sourceforge.net/project/nora-tavern/v2.4.2/asset.zip']);
  assert.deepEqual(waits,[2]);assert.equal(fs.existsSync(target),false);
});
test('Chromium connection timeouts have bounded metadata retries and retain timeout evidence',async t=>{
  for(const outcome of ['recovered','exhausted'])await t.test(outcome,async()=>{
    const calls=[],waits=[],events=[],error=new Error('net::ERR_CONNECTION_TIMED_OUT');let clock=1000;
    const network=networkModule.createReleaseNetwork({app:{whenReady:async()=>{}},
      diagnostics:{write:(event,fields)=>events.push({event,...fields}),error:(event,error,fields)=>events.push({event,error,...fields})},
      net:{fetch:async url=>{
        calls.push(url);clock+=10;
        if(outcome==='exhausted'||calls.length<3)throw error;
        return Response.json({tag_name:'v2.4.5'});
      }}});
    const lookup=()=>networkModule.metadataJson(latestUrl,{fetcher:network.fetch,policy:{sources:{schema:1,mirrors:[]},
      now:()=>clock,totalBudgetMs:100,backoffMs:[2,5],sleep:async ms=>{waits.push(ms);clock+=ms;}}});
    if(outcome==='recovered')assert.equal((await lookup()).value.tag_name,'v2.4.5');
    else await assert.rejects(lookup(),caught=>caught.code==='TIMEOUT'&&caught.attempt===3);
    assert.deepEqual(calls,[latestUrl,latestUrl,latestUrl]);assert.deepEqual(waits,[2,5]);
    assert.equal(events.filter(event=>event.event==='network.retry').length,2);
    assert.equal(require(path.join(desktop,'launcher-errors')).describeError(error).error_code,'timeout');
  });
});
test('connection timeout fallback still respects cancellation, certificates, hashes and unknown messages',async t=>{
  for(const kind of ['cancelled','certificate','hash','unknown-with-url'])await t.test(kind,async child=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-connect-timeout-boundary-'));child.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const calls=[],controller=new AbortController(),target=path.join(root,'asset.zip');
    const error=new Error(kind==='certificate'?'net::ERR_CERT_AUTHORITY_INVALID':kind==='unknown-with-url'
      ?`net::ERR_CONNECTION_TIMED_OUT at ${assetUrl}`:'net::ERR_CONNECTION_TIMED_OUT');
    await assert.rejects(networkModule.downloadAsset({url:assetUrl,target,signal:controller.signal,
      identity:{tag:'v2.4.2',asset:'asset.zip',size:8,sha256:sha('verified')},policy:{sources:sfSources},
      fetcher:async url=>{
        calls.push(url);
        if(kind==='hash')return new Response('tampered',{headers:{'Content-Length':'8'}});
        if(kind==='cancelled')controller.abort();
        throw error;
      }}),caught=>kind==='hash'?caught.code==='VERIFICATION_FAILED':kind==='certificate'?caught.code==='ERR_CERT_AUTHORITY_INVALID'
        :kind==='cancelled'?controller.signal.aborted&&caught.code==='TIMEOUT':caught===error&&caught.code===undefined);
    assert.deepEqual(calls,[assetUrl]);assert.equal(fs.existsSync(target),false);
    if(kind==='unknown-with-url')assert.equal(require(path.join(desktop,'launcher-errors')).describeError(error).error_code,'unknown');
  });
});
test('the shipped source order prefers JihuLab and a healthy primary makes no fallback request',async()=>{
  const {sourceCandidates}=require(path.join(desktop,'release-sources'));
  const candidates=sourceCandidates(latestUrl);
  assert.deepEqual(candidates.map(item=>item.id),['jihulab','github','sourceforge']);
  const calls=[];
  const result=await networkModule.metadataJson(latestUrl,{fetcher:async url=>{calls.push(url);return Response.json({tag_name:'v2.4.2'});}});
  assert.equal(result.value.tag_name,'v2.4.2');assert.deepEqual(calls,[candidates[0].url]);
  assert.equal(sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/v2.4.2',{sources:sfSources})[1].url,
    'https://downloads.sourceforge.net/project/nora-tavern/v2.4.2/release.json');
});
test('GitHub forbidden, throttled, missing and transient failures switch to the official SourceForge mirror',async()=>{
  for(const status of [403,404,408,410,429,503]) {
    const calls=[],events=[];
    const result=await networkModule.metadataJson(latestUrl,{policy:{sources:sfSources,diagnostics:{write:(event,fields)=>events.push({event,...fields})}},fetcher:async(url,options)=>{
      calls.push(url);
      if(url===latestUrl)return new Response('unavailable',{status});
      assert.equal(options.redirect,'manual');
      if(url===sfLatest)return new Response(null,{status:302,headers:{Location:'https://zenlayer.dl.sourceforge.net/project/nora-tavern/channels/stable.json?viasf=1'}});
      return Response.json({tag_name:'v2.4.2'});
    }});
    assert.equal(result.value.tag_name,'v2.4.2');assert.equal(calls.length,3);
    const change=events.find(event=>event.event==='network.source.switch');
    assert.equal(change.from,'github');assert.equal(change.to,'sourceforge');assert.equal(change.status,status);
  }
});
test('SourceForge rejects unsafe redirect targets before contacting them',async()=>{
  const {readSource,sourceCandidates}=require(path.join(desktop,'release-sources'));
  const source=sourceCandidates(latestUrl,{sources:sfSources})[1];
  for(const location of ['http://zenlayer.dl.sourceforge.net/project/nora-tavern/channels/stable.json',
    'https://evil.example/project/nora-tavern/channels/stable.json','https://zenlayer.dl.sourceforge.net/project/other/channels/stable.json',
    'https://user:password@zenlayer.dl.sourceforge.net/project/nora-tavern/channels/stable.json']) {
    let calls=0;
    await assert.rejects(readSource(async()=>{calls++;return new Response(null,{status:302,headers:{Location:location}});},source,source.url,{}),error=>error.code==='VERIFICATION_FAILED');
    assert.equal(calls,1);
  }
});
test('a failed GitHub asset downloads the same frozen bytes from SourceForge with a reserved budget',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sourceforge-asset-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('verified'),calls=[],events=[];
  const identity={tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)};
  await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),identity,policy:{sources:sfSources},
    onEvent:event=>events.push(event),fetcher:async url=>{
      calls.push(url);if(url===assetUrl)return new Response('forbidden',{status:403});
      if(url.startsWith('https://downloads.sourceforge.net/'))return new Response(null,{status:302,headers:{Location:url.replace('downloads.sourceforge.net','pilotfiber.dl.sourceforge.net')}});
      return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
    }});
  assert.deepEqual(calls,[assetUrl,'https://downloads.sourceforge.net/project/nora-tavern/v2.4.2/asset.zip','https://pilotfiber.dl.sourceforge.net/project/nora-tavern/v2.4.2/asset.zip']);
  assert.deepEqual(fs.readFileSync(path.join(root,'asset.zip')),bytes);
  assert.ok(events.some(event=>event.event==='log'&&event.line.includes('github')&&event.line.includes('sourceforge')));
});
test('a retried, continuously slow GitHub body cannot consume the backup download window',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sourceforge-slow-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('verified'),calls=[],primaryProgress=[],events=[];let timer,activeUrl,primaryCancelled=false,switched=false;
  const backupUrl='https://downloads.sourceforge.net/project/nora-tavern/v2.4.2/asset.zip';
  t.after(()=>clearInterval(timer));
  await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},
    // Keep the same ratios while allowing actual file writes, sync and hashing on a busy runner.
    // The 625ms byte cadence remains below idle timeout, and cannot overrun the eight-byte identity.
    policy:{sources:sfSources,backoffMs:[0,0],downloadBudgetMs:5000,backupBudgetMs:3750,downloadIdleTimeoutMs:2500},
    onEvent:event=>{events.push(event);if(event.event==='log'&&event.line.includes('切换'))switched=true;
      if(!switched&&activeUrl===assetUrl&&event.event==='progress'&&event.current>0)primaryProgress.push(event.current);},
    fetcher:async url=>{
      calls.push(url);activeUrl=url;
      if(url!==assetUrl){assert.equal(url,backupUrl);assert.equal(primaryCancelled,true);return new Response(bytes);}
      if(calls.length===1)throw new Error('net::ERR_CONNECTION_RESET');
      return new Response(new ReadableStream({start(controller){timer=setInterval(()=>controller.enqueue(Buffer.from('v')),625);},
        cancel(){primaryCancelled=true;clearInterval(timer);}}));
    }});
  assert.deepEqual(calls,[assetUrl,assetUrl,backupUrl]);assert.deepEqual(fs.readFileSync(path.join(root,'asset.zip')),bytes);
  assert.ok(primaryProgress.length>=2,'the primary produced repeated byte progress without completing');
  assert.ok(primaryProgress.every((current,index)=>current>0&&current<bytes.length&&(!index||current>primaryProgress[index-1])));
  assert.ok(events.some(event=>event.event==='log'&&event.line.includes('github')&&event.line.includes('sourceforge')&&event.line.includes('TIMEOUT')));
  assert.equal(primaryCancelled,true);
});

test('default slow-source estimation switches a 1 KiB/s body before receiving 512 KiB and preserves Range',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-slow-estimate-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.alloc(4*1024*1024,0x61),target=path.join(root,'asset.zip'),requests=[],diagnostics=[];
  let clock=1000,chunks=0,primaryCancelled=false,backupOffset=0;
  const result=await networkModule.downloadAsset({url:assetUrl,target,identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},
    policy:{sources:sfSources,now:()=>clock,diagnostics:{write:(event,fields)=>diagnostics.push({event,...fields}),error(){}}},
    fetcher:async(url,options)=>{
      const headers=new Headers(options.headers);requests.push({url,range:headers.get('range'),ifRange:headers.get('if-range')});
      if(url===assetUrl)return new Response(new ReadableStream({async pull(controller){
        // Keep virtual elapsed time aligned with bytes actually consumed by
        // the reader instead of letting Web-stream prefetch advance the clock.
        while(!primaryCancelled && (fs.statSync(target+'.partial',{throwIfNoEntry:false})?.size || 0)<chunks*5*1024)
          await new Promise(resolve=>setImmediate(resolve));
        if(primaryCancelled)return;
        if(chunks++>=15){controller.error(Object.assign(new Error('slow source did not yield within the observation window'),{code:'FIXTURE_NO_EARLY_SWITCH'}));return;}
        clock+=5000;controller.enqueue(bytes.subarray(0,5*1024));
      },cancel(){primaryCancelled=true;}}),{headers:{ETag:'"slow-primary"','Content-Length':String(bytes.length)}});
      assert.equal(primaryCancelled,true);backupOffset=Number(headers.get('range')?.slice(6,-1));
      assert.ok(backupOffset>=16*1024&&backupOffset<512*1024);assert.equal(headers.get('if-range'),null);
      assert.equal(JSON.parse(fs.readFileSync(target+'.partial.json')).size,backupOffset);
      return new Response(bytes.subarray(backupOffset),{status:206,headers:{ETag:'"faster-backup"','Content-Length':String(bytes.length-backupOffset),
        'Content-Range':`bytes ${backupOffset}-${bytes.length-1}/${bytes.length}`}});
    }});
  assert.equal(requests.length,2);assert.equal(result.resumed,true);assert.ok(clock-1000<90000);
  assert.equal(sha(fs.readFileSync(result.file)),sha(bytes));
  const estimate=diagnostics.find(event=>event.event==='network.download.slow_source');assert.ok(estimate);
  t.diagnostic(JSON.stringify({evidence:'default-slow-source-policy',elapsedMs:clock-1000,backupRange:requests[1].range,
    receivedBytes:backupOffset,defaultThresholds:true,finalSha256:sha(bytes),requestCount:requests.length}));
});

function adaptiveTransferFixture(t,{size=4*1024*1024,prefix=0,steps,finishPrimary=false,policy={},backup='complete',ignoreRange=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-adaptive-transfer-'));let cancelled=false;
  t.after(()=>{cancelled=true;fs.rmSync(root,{recursive:true,force:true});});
  const target=path.join(root,'asset.zip'),bytes=Buffer.alloc(size,0x61),requests=[],diagnostics=[];
  const identity={tag:'v2.4.2',asset:'asset.zip',size,sha256:sha(bytes)};let clock=1000,produced=0,index=0;
  if(prefix) {
    fs.writeFileSync(target+'.partial',bytes.subarray(0,prefix));
    fs.writeFileSync(target+'.partial.json',JSON.stringify({schema:'nora-download-partial/2',plan:sha(JSON.stringify(identity)),
      content:sha(JSON.stringify([identity.sha256,identity.size])),requestUrl:assetUrl,source:assetUrl,etag:'"slow-primary"',encoding:'identity',
      size:prefix,prefixSha256:sha(bytes.subarray(0,prefix))}));
  }
  const run=()=>networkModule.downloadAsset({url:assetUrl,target,identity,
    policy:{sources:sfSources,now:()=>clock,...policy,diagnostics:{write:(event,fields)=>diagnostics.push({event,...fields}),error(){}}},
    fetcher:async(url,options)=>{
      const headers=new Headers(options.headers);requests.push({url,range:headers.get('range'),ifRange:headers.get('if-range')});
      if(url!==assetUrl) {
        if(backup==='expired')return new Response(new ReadableStream({start(controller){clock+=1800001;controller.enqueue(bytes.subarray(0,1));controller.close();}}),
          {headers:{ETag:'"backup"','Content-Length':String(size)}});
        const offset=Number(headers.get('range')?.slice(6,-1) || 0);assert.equal(headers.get('if-range'),null);
        return new Response(bytes.subarray(offset),{status:offset?206:200,headers:{ETag:'"backup"','Content-Length':String(size-offset),
          ...(offset?{'Content-Range':`bytes ${offset}-${size-1}/${size}`}:{})}});
      }
      const append=prefix && !ignoreRange,output=target+'.partial'+(prefix&&ignoreRange?'.replacement':'');
      return new Response(new ReadableStream({async pull(controller){
        while(!cancelled && (fs.statSync(output,{throwIfNoEntry:false})?.size || 0)<(append?prefix:0)+produced)
          await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));if(cancelled)return;
        const step=steps[index++];
        if(!step){finishPrimary?controller.close():controller.error(Object.assign(new Error('no early slow-source handoff'),{code:'FIXTURE_NO_EARLY_SWITCH'}));return;}
        clock+=step.ms;const from=(append?prefix:0)+produced,n=Math.min(step.bytes,size-from);produced+=n;
        controller.enqueue(bytes.subarray(from,from+n));
      },cancel(){cancelled=true;}}),{status:append?206:200,headers:{ETag:'"slow-primary"','Content-Length':String(append?size-prefix:size),
        ...(append?{'Content-Range':`bytes ${prefix}-${size-1}/${size}`}:{})}});
    }});
  return {run,bytes,target,requests,diagnostics,elapsed:()=>clock-1000};
}

test('default slow-source estimation also hands off a cold 1 B/s source without a byte floor',async t=>{
  const fixture=adaptiveTransferFixture(t,{steps:Array.from({length:15},()=>({ms:5000,bytes:5}))});
  const result=await fixture.run();assert.equal(fixture.requests.length,2);assert.equal(result.resumed,true);
  const offset=Number(fixture.requests[1].range.slice(6,-1));assert.ok(offset>0&&offset<64);
  assert.ok(fixture.elapsed()<90000);assert.equal(sha(fs.readFileSync(result.file)),sha(fixture.bytes));
  t.diagnostic(JSON.stringify({evidence:'default-cold-one-byte-per-second',elapsedMs:fixture.elapsed(),backupRange:fixture.requests[1].range,
    receivedBytes:offset,defaultThresholds:true,requestCount:fixture.requests.length}));
});

test('default ETA policy tolerates a brief pause and sustained acceleration before finishing',async t=>{
  for(const pause of [0,8000])await t.test(pause?'brief-pause':'acceleration',async child=>{
    const steps=Array.from({length:6},()=>({ms:5000,bytes:5*1024}));
    steps.push({ms:pause || 5000,bytes:512*1024},{ms:5000,bytes:512*1024},{ms:5000,bytes:512*1024},
      {ms:5000,bytes:512*1024},{ms:5000,bytes:4*1024*1024});
    const fixture=adaptiveTransferFixture(child,{steps,finishPrimary:true,policy:{downloadBudgetMs:100000,backupBudgetMs:40000}});
    const result=await fixture.run();assert.equal(fixture.requests.length,1);
    assert.equal(fixture.diagnostics.some(event=>event.event==='network.download.slow_source'),false);
    assert.equal(sha(fs.readFileSync(result.file)),sha(fixture.bytes));
  });
});

test('isolated arrival bursts cannot repeatedly erase a sustained hopeless ETA',async t=>{
  const fixture=adaptiveTransferFixture(t,{steps:Array.from({length:18},(_,index)=>({ms:5000,bytes:index%2?15:5}))});
  const result=await fixture.run();assert.equal(fixture.requests.length,2);assert.ok(fixture.elapsed()<90000);
  const estimate=fixture.diagnostics.find(event=>event.event==='network.download.slow_source');assert.ok(estimate);
  assert.ok(estimate.slowForMs>=15000);assert.equal(sha(fs.readFileSync(result.file)),sha(fixture.bytes));
});

test('the last available source keeps its finite absolute deadline without speculative ETA handoffs',async t=>{
  const fixture=adaptiveTransferFixture(t,{steps:Array.from({length:30},()=>({ms:5000,bytes:5})),
    policy:{sources:{schema:1,mirrors:[]},downloadBudgetMs:100000}});
  await assert.rejects(fixture.run(),error=>error.code==='TIMEOUT');assert.equal(fixture.requests.length,1);
  assert.equal(fs.existsSync(fixture.target),false);
  assert.equal(fixture.diagnostics.some(event=>event.event==='network.download.slow_source'),false);
});

test('a near-complete viable ETA is protected while a very slow tail still switches source',async t=>{
  const size=1024*1024,prefix=size-32*1024;
  await t.test('near-complete-viable',async child=>{
    const steps=Array.from({length:10},()=>({ms:5000,bytes:2*1024}));steps.push({ms:5000,bytes:32*1024});
    const fixture=adaptiveTransferFixture(child,{size,prefix,steps,finishPrimary:true,policy:{downloadBudgetMs:100000,backupBudgetMs:40000}});
    const result=await fixture.run();assert.equal(fixture.requests.length,1);
    assert.equal(fixture.diagnostics.some(event=>event.event==='network.download.slow_source'),false);
    assert.equal(sha(fs.readFileSync(result.file)),sha(fixture.bytes));
  });
  await t.test('near-complete-one-byte-per-second',async child=>{
    const fixture=adaptiveTransferFixture(child,{size,prefix,steps:Array.from({length:15},()=>({ms:5000,bytes:5}))});
    const result=await fixture.run();assert.equal(fixture.requests.length,2);
    assert.ok(Number(fixture.requests[1].range.slice(6,-1))>prefix);assert.ok(fixture.elapsed()<90000);
    assert.ok(fixture.diagnostics.some(event=>event.event==='network.download.slow_source'));
    assert.equal(sha(fs.readFileSync(result.file)),sha(fixture.bytes));
  });
});

test('a slow-source handoff cannot loop or commit after the shared operation deadline',async t=>{
  const fixture=adaptiveTransferFixture(t,{steps:Array.from({length:15},()=>({ms:5000,bytes:5})),backup:'expired'});
  await assert.rejects(fixture.run(),error=>error.code==='TIMEOUT');assert.equal(fixture.requests.length,2);
  assert.equal(fs.existsSync(fixture.target),false);
  assert.equal(fixture.diagnostics.filter(event=>event.event==='network.download.slow_source').length,1);
});

test('a Range-ignoring replacement is still bounded and preserves the original checkpoint',async t=>{
  const fixture=adaptiveTransferFixture(t,{prefix:1024,ignoreRange:true,
    steps:Array.from({length:15},()=>({ms:5000,bytes:5})),policy:{downloadBudgetMs:100000,backupBudgetMs:40000}});
  const before=fs.readFileSync(fixture.target+'.partial.json');
  // Returning HTTP 200 keeps the original record untouched; the absolute
  // phase may expire, and a later admitted source resumes the old 1 KiB.
  const result=await fixture.run();assert.equal(fixture.requests.length,2);
  assert.equal(fixture.requests[1].range,'bytes=1024-');assert.equal(result.resumed,true);
  assert.equal(fixture.diagnostics.some(event=>event.event==='network.download.slow_source'),false);
  assert.ok(before.length>0);assert.equal(sha(fs.readFileSync(result.file)),sha(fixture.bytes));
});

test('default multi-source idle timeout gives a real stalled socket 60 seconds before switching',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-default-idle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('abcdefghij'),target=path.join(root,'asset.zip');let advanced=0,ticked=false;
  const f=await server(t,(request,response)=>{
    if(request.url.startsWith('/LoveMaker-art/')){response.writeHead(200,{ETag:'"primary"','Content-Length':'10'});response.write(bytes.subarray(0,4));return;}
    assert.equal(advanced,60000);assert.equal(request.headers.range,'bytes=4-');assert.equal(request.headers['if-range'],undefined);
    response.writeHead(206,{ETag:'"backup"','Content-Length':'6','Content-Range':'bytes 4-9/10'});response.end(bytes.subarray(4));
  });
  t.mock.timers.enable({apis:['setTimeout']});
  const result=await networkModule.downloadAsset({url:assetUrl,target,fetcher:f.fetcher,
    identity:{tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)},policy:{sources:sfSources},
    onEvent:event=>{if(!ticked&&event.event==='progress'&&event.current===4){ticked=true;
      advanced=59999;t.mock.timers.tick(59999);assert.equal(f.requests.length,1,'a short pause must keep the current socket');
      advanced=60000;t.mock.timers.tick(1);
    }}});
  assert.equal(ticked,true);assert.equal(f.requests.length,2);assert.deepEqual(fs.readFileSync(result.file),bytes);
  t.diagnostic(JSON.stringify({evidence:'default-idle-real-socket-virtual-time',idleAtMs:advanced,defaultIdleThreshold:true,
    backupRange:f.requests[1].headers.range,requestCount:f.requests.length,realSocket:true}));
});

test('source configuration rejects uncontrolled roots before making any request',async()=>{
  const {sourceCandidates}=require(path.join(desktop,'release-sources'));
  for(const mirrors of [[{id:'primary',baseUrl:'http://host/'}],[{id:'primary',baseUrl:'https://user:password@host/'}],
    [{id:'primary',baseUrl:'https://host/?key=x'}],[{id:'primary',baseUrl:'https://host/a/'},{id:'backup',baseUrl:'https://host/b/'}],
    [{id:'github',baseUrl:'https://host/'}]]) assert.throws(()=>sourceCandidates(latestUrl,{sources:{schema:1,mirrors}}),error=>error.code==='VERIFICATION_FAILED');
  assert.equal(sourceCandidates('https://external.example/file',{sources}).length,1);
  assert.equal(sourceCandidates('https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/%2E%2E',{sources}).length,1);
});
test('beta and fixed-tag catalogues keep canonical release identity and configured source order',()=>{
  const {sourceCandidates}=require(path.join(desktop,'release-sources'));
  assert.equal(sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=1',{sources,channel:'beta'})[0].url,
    'https://primary.example/channels/beta.json');
  assert.equal(sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/v2.4.2',{sources})[0].url,
    'https://primary.example/releases/v2.4.2/release.json');
  assert.equal(sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=2',{sources,channel:'beta'}).length,1);
});
test('known missing mirrors and evidenced rate limits switch host in one round without sleeping',async()=>{
  for(const status of [404,410,429,403]) {
    const requests=[];
    const result=await networkModule.metadataJson(latestUrl,{policy:{sources:{schema:1,mirrors:[...sources.mirrors,{id:'backup',baseUrl:'https://backup.example/'}]},
      sleep:async()=>{assert.fail('cross-host switching must not wait on the failed bucket');}},fetcher:async url=>{
        requests.push(url);return new Response(url.startsWith('https://api.github.com/')?'{}':'unavailable',
          {status:url.startsWith('https://api.github.com/')?200:status,headers:status===403?{'x-ratelimit-remaining':'0','x-ratelimit-reset':'9999999999'}:{}});
      }});
    assert.deepEqual(result.value,{});assert.equal(requests.length,3);
    assert.ok(requests[0].startsWith('https://primary.example/'));assert.ok(requests[1].startsWith('https://backup.example/'));
  }
});
test('source attempts share the whole asset deadline and retain earlier failures in diagnostics',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-download-budget-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let clock=1000,calls=0;const target=path.join(root,'asset.zip');
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,target,identity:{tag:'v2.4.2',asset:'asset.zip',size:8,sha256:sha('verified')},
    policy:{sources,now:()=>clock,downloadBudgetMs:100},fetcher:async()=>{calls++;clock+=60;return new Response('unavailable',{status:503});}}),error=>{
      assert.equal(error.code,'TIMEOUT');assert.equal(error.secondaryErrors[0].operation,'release-source:primary');
      assert.equal(error.secondaryErrors[0].error.status,503);return true;
    });
  assert.equal(calls,2);assert.equal(fs.existsSync(target),false);
});

test('cancelled metadata and body transfer never start the next source',async t=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(networkModule.metadataJson(latestUrl,{signal:controller.signal,policy:{sources},fetcher:async()=>{
    calls++;controller.abort();throw Object.assign(new Error('reset'),{code:'ECONNRESET'});
  }}));assert.equal(calls,1);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-source-cancel-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const transfer=new AbortController(),bytes=Buffer.from('verified');calls=0;
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),signal:transfer.signal,policy:{sources},
    identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},fetcher:async()=>{calls++;return new Response(bytes);},
    onEvent:event=>{if(event.event==='progress'&&event.current>0)transfer.abort();}}),{name:'AbortError'});
  assert.equal(calls,1);assert.equal(fs.existsSync(path.join(root,'asset.zip')),false);
});

test('Chromium source reads do not multiply retries or renew the total deadline',async()=>{
  let clock=1000,calls=0;
  const network=networkModule.createReleaseNetwork({app:{whenReady:async()=>{}},diagnostics:quiet,policy:{maxAttempts:3,backoffMs:[0,0]},
    net:{fetch:async()=>{calls++;clock+=60;return new Response('temporary',{status:503});}}});
  await assert.rejects(networkModule.metadataJson(latestUrl,{fetcher:network.fetch,policy:{sources,now:()=>clock,totalBudgetMs:100}}));
  assert.equal(calls,2);
  clock=1000;calls=0;
  await assert.rejects(networkModule.metadataJson(latestUrl,{fetcher:network.fetch,policy:{sources,now:()=>clock,totalBudgetMs:50}}));
  assert.equal(calls,1);
});

test('metadata body timeout switches source while keeping validators isolated',async()=>{
  let primaryAvailable=true;const requests=[];
  const cache=networkModule.createMetadataCache({ttlMs:0});
  const fetcher=async(url,options)=>{
    requests.push({url,etag:new Headers(options.headers).get('If-None-Match')});
    if(url.startsWith('https://primary.example/')&&!primaryAvailable)return new Response(new ReadableStream({start(){}}));
    return Response.json({tag_name:'v2.4.2'},{headers:{ETag:url.startsWith('https://primary.example/')?'"primary"':'"github"'}});
  };
  await networkModule.metadataJson(latestUrl,{fetcher,metadataCache:cache,policy:{sources,attemptTimeoutMs:30}});
  primaryAvailable=false;
  const result=await networkModule.metadataJson(latestUrl,{fetcher,metadataCache:cache,policy:{sources,attemptTimeoutMs:30,totalBudgetMs:500}});
  assert.equal(result.value.tag_name,'v2.4.2');assert.equal(requests.length,3);
  assert.equal(requests[1].etag,'"primary"');assert.equal(requests[2].etag,null);
});

test('configured primary metadata fails over once to Github within the same lookup budget',async()=>{
  const requests=[];let clock=1000;
  const result=await networkModule.metadataJson('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest',{
    fetcher:async url=>{requests.push(url);clock+=30;return new Response(JSON.stringify({tag_name:'v2.4.2'}),{status:url.startsWith('https://primary.example/')?503:200});},
    policy:{now:()=>clock,totalBudgetMs:100,sources:{schema:1,mirrors:[{id:'primary',baseUrl:'https://primary.example/'}]},backoffMs:[0,0]}});
  assert.equal(result.value.tag_name,'v2.4.2');
  assert.deepEqual(requests,['https://primary.example/channels/stable.json','https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest']);
});

test('a primary body failure switches asset source without splicing bytes or changing identity',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-multi-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('complete verified artifact'),requests=[],events=[];
  const target=path.join(root,'asset.zip'),url='https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/asset.zip';
  await networkModule.downloadAsset({url,target,identity:{tag:'v2.4.2',asset:'asset.zip',sha256:sha(bytes),size:bytes.length},
    policy:{sources:{schema:1,mirrors:[{id:'primary',baseUrl:'https://primary.example/'}]}},onEvent:event=>events.push(event),
    fetcher:async(url,options)=>{requests.push({url,range:new Headers(options.headers).get('Range')});
      if(url.startsWith('https://primary.example/'))return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,4));},pull(controller){controller.error(Object.assign(Error('reset'),{code:'ECONNRESET'}));}}),{headers:{ETag:'"primary"','Content-Length':String(bytes.length)}});
      return new Response(bytes,{headers:{ETag:'"backup"','Content-Length':String(bytes.length)}});
    }});
  assert.deepEqual(fs.readFileSync(target),bytes);assert.equal(requests.length,2);assert.equal(requests[0].url,'https://primary.example/releases/v2.4.2/asset.zip');
  assert.equal(requests[1].range,null);assert.ok(events.some(event=>event.event==='log'&&/切换/.test(event.line)));
});
test('a verified backup checkpoint survives an unavailable primary on the next invocation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-backup-resume-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('abcdefghij'),controller=new AbortController();let backups=0;
  const options={url:assetUrl,target:path.join(root,'asset.zip'),identity:{tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)},policy:{sources},
    fetcher:async(url,options)=>{
      if(url.startsWith('https://primary.example/'))return new Response('unavailable',{status:503});
      backups++;
      if(backups===1)return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,4));}}),{headers:{ETag:'"backup"','Content-Length':'10'}});
      assert.equal(new Headers(options.headers).get('Range'),'bytes=4-');
      return new Response(bytes.subarray(4),{status:206,headers:{ETag:'"backup"','Content-Length':'6','Content-Range':'bytes 4-9/10'}});
    }};
  await assert.rejects(networkModule.downloadAsset({...options,signal:controller.signal,
    onEvent:event=>{if(event.event==='progress'&&event.current===4)controller.abort();}}),{name:'AbortError'});
  await networkModule.downloadAsset(options);assert.deepEqual(fs.readFileSync(options.target),bytes);assert.equal(backups,2);
});
test('Chromium body reset errors retain network classification and can switch the resource source',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-chromium-body-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let calls=0;
  const fetcher=async url=>{
    calls++;return new Response(url.startsWith('https://primary.example/')?new ReadableStream({start(controller){
      controller.error(new DOMException('net::ERR_CONNECTION_RESET','NetworkError'));
    }}):'{}');
  };
  const value=await networkModule.metadataJson(latestUrl,{fetcher,policy:{sources}});assert.deepEqual(value.value,{});assert.equal(calls,2);
  calls=0;const target=path.join(root,'asset.zip');
  await networkModule.downloadAsset({url:assetUrl,target,fetcher,policy:{sources},identity:{tag:'v2.4.2',asset:'asset.zip',size:2,sha256:sha('{}')}});
  assert.equal(calls,2);assert.equal(fs.readFileSync(target,'utf8'),'{}');
  calls=0;
  await networkModule.metadataJson(latestUrl,{policy:{sources},fetcher:async url=>{
    calls++;if(url.startsWith('https://primary.example/'))throw new DOMException('net::ERR_CONNECTION_RESET','NetworkError');
    return Response.json({});
  }});assert.equal(calls,2);
});

test('temporary GET failure recovers within one bounded request policy',async t=>{
  const f=await server(t,(_req,res,count)=>{res.writeHead(count===1?503:200);res.end(count===1?'temporary':'ready');});
  const network=networkModule.createReleaseNetwork({app:{whenReady:async()=>{}},net:{fetch:f.fetcher},diagnostics:quiet,
    policy:{backoffMs:[0,0],totalBudgetMs:1000,attemptTimeoutMs:200}});
  const response=await network.fetch('https://github.com/resource');
  assert.equal(response.status,200);assert.equal(await response.text(),'ready');
  assert.equal(f.requests.length,2);
});

test('conditional metadata cache preserves its original confirmation time until a valid 304',async t=>{
  let clock=1000;
  const f=await server(t,(req,res)=>{
    if(req.headers['if-none-match']==='"version-a"') {res.writeHead(304,{ETag:'"version-a"'});res.end();}
    else {res.writeHead(200,{ETag:'"version-a"'});res.end('{"version":"2.4.2"}');}
  });
  const cache=networkModule.createMetadataCache({ttlMs:100,now:()=>clock});
  const options={fetcher:f.fetcher,metadataCache:cache,channel:'stable',policy:{backoffMs:[0,0]}};
  const first=await networkModule.metadataJson('https://api.github.com/versions',options);
  clock=1050;
  const cached=await networkModule.metadataJson('https://api.github.com/versions',options);
  assert.equal(cached.source,'cache');assert.equal(cached.latestConfirmed,false);assert.equal(cached.checkedAt,first.checkedAt);
  clock=1200;
  const confirmed=await networkModule.metadataJson('https://api.github.com/versions',options);
  assert.equal(confirmed.source,'revalidated');assert.equal(confirmed.latestConfirmed,true);
  assert.equal(confirmed.checkedAt,new Date(1200).toISOString());assert.deepEqual(confirmed.value,{version:'2.4.2'});
  assert.equal(f.requests.length,2);
});

test('an inconsistent conditional response discards its cache and retrieves verified fresh metadata once',async t=>{
  let clock=1000;
  const f=await server(t,(req,res,count)=>{
    if(count===1){res.writeHead(200,{ETag:'"old"'});res.end('{"version":"2.4.3"}');return;}
    if(count===2){assert.equal(req.headers['if-none-match'],'"old"');res.writeHead(304,{ETag:'"different"'});res.end();return;}
    assert.equal(req.headers['if-none-match'],undefined,'The inconsistent validator must not be sent again');
    res.writeHead(200,{ETag:'"fresh"'});res.end('{"version":"2.4.4"}');
  });
  const metadataCache=networkModule.createMetadataCache({ttlMs:100,now:()=>clock});
  const options={fetcher:f.fetcher,metadataCache,policy:{maxAttempts:1,sources:{schema:1,mirrors:[]}}};
  await networkModule.metadataJson('https://api.github.com/versions',options);clock=1200;
  const fresh=await networkModule.metadataJson('https://api.github.com/versions',options);
  assert.deepEqual(fresh.value,{version:'2.4.4'});assert.equal(fresh.latestConfirmed,true);assert.equal(fresh.source,'network');
  assert.equal(f.requests.length,3);
});

test('an unconditional cache recovery never trusts another 304 or malformed body',async t=>{
  for(const kind of ['304','malformed'])await t.test(kind,async child=>{
    let clock=1000;
    const f=await server(child,(req,res,count)=>{
      if(count===1){res.writeHead(200,{ETag:'"old"'});res.end('{"version":"2.4.3"}');return;}
      if(count===2){res.writeHead(304,{ETag:'"different"'});res.end();return;}
      assert.equal(req.headers['if-none-match'],undefined);
      res.writeHead(kind==='304'?304:200);res.end(kind==='304'?'':'not-json');
    });
    const metadataCache=networkModule.createMetadataCache({ttlMs:100,now:()=>clock});
    const options={fetcher:f.fetcher,metadataCache,policy:{maxAttempts:1,sources:{schema:1,mirrors:[]}}};
    await networkModule.metadataJson('https://api.github.com/versions',options);clock=1200;
    await assert.rejects(networkModule.metadataJson('https://api.github.com/versions',options),error=>error.code==='INVALID_RESPONSE');
    assert.equal(f.requests.length,3,'Only one unconditional recovery request is allowed');
    await assert.rejects(networkModule.metadataJson('https://api.github.com/versions',options),error=>error.code==='INVALID_RESPONSE');
    assert.equal(f.requests[3].headers['if-none-match'],undefined,'The rejected representation must not survive for the next check');
  });
});

test('cancelled bytes resume with a strong validator and complete whole-file verification',async t=>{
  const bytes=Buffer.from('abcdefghij'),controller=new AbortController();
  const f=await server(t,(req,res)=>{
    res.setHeader('ETag','"content-v1"');
    if(req.headers.range) {
      assert.equal(req.headers.range,'bytes=4-');assert.equal(req.headers['if-range'],'"content-v1"');
      res.writeHead(206,{'Content-Range':'bytes 4-9/10','Content-Length':'6'});res.end(bytes.subarray(4));
    } else {res.writeHead(200,{'Content-Length':'10'});res.write(bytes.subarray(0,4));}
  });
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-resume-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const options={url:'https://github.com/asset',target:path.join(root,'asset.zip'),fetcher:f.fetcher,
    identity:{tag:'v2.4.2',asset:'asset.zip',sha256:sha(bytes),size:10}};
  await assert.rejects(networkModule.downloadAsset({...options,signal:controller.signal,
    onEvent:event=>{if(event.event==='progress' && event.current===4) controller.abort();}}),{name:'AbortError'});
  assert.equal(fs.existsSync(options.target),false);
  await networkModule.downloadAsset(options);
  assert.deepEqual(fs.readFileSync(options.target),bytes);assert.equal(f.requests.length,2);
});

async function interrupted(t,finish,{etag='"content-v1"',prefix=4,url='https://github.com/asset'}={}) {
  const bytes=Buffer.from('abcdefghij'),controller=new AbortController();
  const f=await server(t,(req,res,count)=>{
    if(count>1) return finish(req,res,bytes);
    res.writeHead(200,{'Content-Length':'10',ETag:etag});
    if(prefix===bytes.length) res.end(bytes);else res.write(bytes.subarray(0,prefix));
  });
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-range-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const options={url,target:path.join(root,'asset.zip'),fetcher:f.fetcher,policy:{sources:{schema:1,mirrors:[]}},
    identity:{tag:'v2.4.2',asset:'asset.zip',sha256:sha(bytes),size:10}};
  await assert.rejects(networkModule.downloadAsset({...options,signal:controller.signal,
    onEvent:event=>{if(event.event==='progress' && event.current===prefix) controller.abort();}}),{name:'AbortError'});
  return {...f,options,bytes};
}

test('a server ignoring Range replaces the prefix with the verified full representation',async t=>{
  const f=await interrupted(t,(req,res,bytes)=>{assert.equal(req.headers.range,'bytes=4-');res.writeHead(200,{ETag:'"replacement"','Content-Length':'10'});res.end(bytes);});
  await networkModule.downloadAsset(f.options);assert.deepEqual(fs.readFileSync(f.options.target),f.bytes);
});

test('incorrect 206 range, validator, encoding or redirect is never spliced or retried',async t=>{
  for(const kind of ['range','etag','encoding','source']) await t.test(kind,async child=>{
    const f=await interrupted(child,(_req,res,bytes)=>{
      res.writeHead(206,{ETag:kind==='etag'?'"other"':'"content-v1"','Content-Range':kind==='range'?'bytes 3-8/10':'bytes 4-9/10',
        'Content-Length':'6',...(kind==='encoding'?{'Content-Encoding':'gzip'}:{})});res.end(bytes.subarray(4));
    });
    const fetcher=kind==='source' ? async(url,options)=>{const response=await f.fetcher(url,options);Object.defineProperty(response,'url',{value:'https://other.example/asset',configurable:true});return response;} : f.fetcher;
    await assert.rejects(networkModule.downloadAsset({...f.options,fetcher}),error=>error.code==='VERIFICATION_FAILED');
    assert.equal(f.requests.length,2);assert.equal(fs.existsSync(f.options.target),false);
  });
});

test('416 only commits a complete partial after whole-file verification',async t=>{
  const f=await interrupted(t,(_req,res)=>{res.writeHead(416,{ETag:'"content-v1"','Content-Range':'bytes */10'});res.end();},{prefix:10});
  await networkModule.downloadAsset(f.options);assert.deepEqual(fs.readFileSync(f.options.target),f.bytes);
});

test('weak validators are omitted while fixed hash and size still permit checked Range recovery',async t=>{
  const f=await interrupted(t,(req,res,bytes)=>{assert.equal(req.headers.range,'bytes=4-');assert.equal(req.headers['if-range'],undefined);
    res.writeHead(206,{'Content-Range':'bytes 4-9/10','Content-Length':'6'});res.end(bytes.subarray(4));},{etag:'W/"content-v1"'});
  await networkModule.downloadAsset(f.options);assert.deepEqual(fs.readFileSync(f.options.target),f.bytes);
});
test('a changed fixed plan identity starts a new full request',async t=>{
  const f=await interrupted(t,(req,res,bytes)=>{assert.equal(req.headers.range,undefined);assert.equal(req.headers['if-range'],undefined);
    res.writeHead(200,{ETag:'"content-v1"','Content-Length':'10'});res.end(bytes);});
  await networkModule.downloadAsset({...f.options,identity:{...f.options.identity,tag:'v2.4.3'}});
  assert.deepEqual(fs.readFileSync(f.options.target),f.bytes);
});

test('transient body resets retry the same source with a finite checked Range request',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-body-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('abcdefghij'),requests=[];let timer;
  t.after(()=>clearTimeout(timer));
  const result=await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),
    identity:{tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)},
    policy:{sources:{schema:1,mirrors:[]},downloadBodyBackoffMs:[0,0]},
    fetcher:async(_url,options)=>{
      const headers=new Headers(options.headers);requests.push({range:headers.get('range'),etag:headers.get('if-range')});
      if(requests.length===1)return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,4));
        timer=setTimeout(()=>controller.error(Object.assign(new Error('body reset'),{code:'ECONNRESET'})),30);}}),
        {headers:{ETag:'"fixed"','Content-Length':'10'}});
      return new Response(bytes.subarray(4),{status:206,headers:{ETag:'"fixed"','Content-Range':'bytes 4-9/10','Content-Length':'6'}});
    }});
  assert.deepEqual(requests,[{range:null,etag:null},{range:'bytes=4-',etag:'"fixed"'}]);
  assert.equal(result.resumed,true);assert.deepEqual(fs.readFileSync(result.file),bytes);
});

test('repeated same-source body resets cannot renew the operation budget or retry indefinitely',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-body-bounded-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('abcdefghij'),requests=[],timers=[];t.after(()=>timers.forEach(clearTimeout));
  const target=path.join(root,'asset.zip');
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,target,
    identity:{tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)},
    policy:{sources:{schema:1,mirrors:[]},downloadBodyBackoffMs:[0,0],downloadBudgetMs:1000},
    fetcher:async(_url,options)=>{
      const range=new Headers(options.headers).get('range');requests.push(range);
      return new Response(new ReadableStream({start(controller){controller.enqueue(range?bytes.subarray(4,6):bytes.subarray(0,4));
        timers.push(setTimeout(()=>controller.error(Object.assign(new Error('reset again'),{code:'ECONNRESET'})),30));}}),
        {status:range?206:200,headers:{ETag:'"fixed"','Content-Length':range?'6':'10',...(range?{'Content-Range':'bytes 4-9/10'}:{})}});
    }}),error=>error.code==='ECONNRESET');
  assert.deepEqual(requests,[null,'bytes=4-']);assert.equal(JSON.parse(fs.readFileSync(target+'.partial.json')).size,6);
  assert.deepEqual(fs.readFileSync(target+'.partial'),bytes.subarray(0,6));assert.equal(fs.existsSync(target),false);
});

test('checkpoint hashing and the resumed body share the original absolute download deadline',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-checkpoint-deadline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('abcdefghij'),target=path.join(root,'asset.zip'),identity={tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)};
  fs.writeFileSync(target+'.partial',bytes.subarray(0,4));
  fs.writeFileSync(target+'.partial.json',JSON.stringify({schema:'nora-download-partial/2',plan:sha(JSON.stringify(identity)),
    content:sha(JSON.stringify([identity.sha256,identity.size])),requestUrl:assetUrl,source:assetUrl,etag:'"fixed"',encoding:'identity',
    size:4,prefixSha256:sha(bytes.subarray(0,4))}));
  const original=fs.createReadStream;let delayed=false,timer;
  t.after(()=>clearTimeout(timer));
  t.mock.method(fs,'createReadStream',(file,...args)=>{
    if(file===target+'.partial'&&!delayed){delayed=true;return Readable.from((async function*(){
      await new Promise(resolve=>setTimeout(resolve,150));yield bytes.subarray(0,4);
    })());}
    return original(file,...args);
  });
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,target,identity,
    policy:{sources:{schema:1,mirrors:[]},maxAttempts:1,downloadBudgetMs:200},fetcher:async()=>new Response(new ReadableStream({start(controller){
      timer=setTimeout(()=>{controller.enqueue(bytes.subarray(4));controller.close();},100);
    },cancel(){clearTimeout(timer);}}),{status:206,headers:{ETag:'"fixed"','Content-Length':'6','Content-Range':'bytes 4-9/10'}})}),error=>error.code==='TIMEOUT');
  assert.equal(delayed,true);assert.equal(fs.existsSync(target),false);assert.deepEqual(fs.readFileSync(target+'.partial'),bytes.subarray(0,4));
});

test('an absolute deadline expiring during prefix or final hashing prevents network or commit',async t=>{
  for(const stage of ['prefix','final'])await t.test(stage,async child=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-hash-deadline-'));child.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const bytes=Buffer.from('abcdefghij'),target=path.join(root,'asset.zip'),identity={tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)};
    const partial=target+'.partial',record=partial+'.json';let clock=1000,calls=0,hashObserved=false;
    if(stage==='prefix') {
      fs.writeFileSync(partial,bytes.subarray(0,4));
      fs.writeFileSync(record,JSON.stringify({schema:'nora-download-partial/2',plan:sha(JSON.stringify(identity)),
        content:sha(JSON.stringify([identity.sha256,identity.size])),requestUrl:assetUrl,source:assetUrl,etag:'"fixed"',encoding:'identity',
        size:4,prefixSha256:sha(bytes.subarray(0,4))}));
    }
    const original=fs.createReadStream;
    child.mock.method(fs,'createReadStream',(file,options,...args)=>{
      if(file!==partial)return original(file,options,...args);
      hashObserved=true;assert.ok(options.signal,'disk verification must share the phase abort signal');
      return Readable.from((async function*(){clock=1201;yield stage==='prefix'?bytes.subarray(0,4):bytes;})());
    });
    await assert.rejects(networkModule.downloadAsset({url:assetUrl,target,identity,
      policy:{sources:{schema:1,mirrors:[]},maxAttempts:1,downloadBudgetMs:200,now:()=>clock},
      fetcher:async()=>{calls++;return new Response(bytes,{headers:{ETag:'"fixed"','Content-Length':'10'}});}}),error=>error.code==='TIMEOUT');
    assert.equal(hashObserved,true);assert.equal(calls,stage==='prefix'?0:1);assert.equal(fs.existsSync(target),false);
    if(stage==='prefix')assert.deepEqual(fs.readFileSync(partial),bytes.subarray(0,4));
  });
});

test('a rejected HTTP 200 replacement cannot delete the untouched original checkpoint',async t=>{
  for(const fault of ['encoding','body'])await t.test(fault,async child=>{
    const f=await interrupted(child,(_request,response)=>{response.writeHead(503);response.end();});
    const before=fs.readFileSync(f.options.target+'.partial.json');
    await assert.rejects(networkModule.downloadAsset({...f.options,policy:{sources:{schema:1,mirrors:[]},maxAttempts:1},
      fetcher:async()=>new Response(fault==='body'?null:f.bytes,{status:200,headers:{ETag:'"replacement"','Content-Length':'10',
        ...(fault==='encoding'?{'Content-Encoding':'gzip'}:{})}})}));
    assert.deepEqual(fs.readFileSync(f.options.target+'.partial'),f.bytes.subarray(0,4));
    assert.deepEqual(fs.readFileSync(f.options.target+'.partial.json'),before);assert.equal(fs.existsSync(f.options.target),false);
  });
});

test('a backup that ignores Range and resets preserves the original larger checkpoint',async t=>{
  const bytes=Buffer.from('abcdefghij'),requests=[];let backups=0;
  const f=await interrupted(t,(req,res)=>{requests.push(req.headers.range);res.writeHead(503);res.end();},{prefix:8,url:assetUrl});
  const before=fs.readFileSync(f.options.target+'.partial.json');let timer;t.after(()=>clearTimeout(timer));
  await assert.rejects(networkModule.downloadAsset({...f.options,policy:{sources,maxAttempts:1},
    fetcher:async(url,options)=>{
      if(url.startsWith('https://primary.example/')) {
        backups++;
        assert.equal(new Headers(options.headers).get('range'),'bytes=8-');assert.equal(new Headers(options.headers).get('if-range'),null);
        return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,2));
          timer=setTimeout(()=>controller.error(Object.assign(new Error('replacement reset'),{code:'ECONNRESET'})),25);}}),
          {headers:{ETag:'"backup"','Content-Length':'10'}});
      }
      return f.fetcher(url,options);
    }}),error=>error.code==='ECONNRESET' || error.status===503);
  assert.deepEqual(fs.readFileSync(f.options.target+'.partial'),bytes.subarray(0,8));
  assert.deepEqual(fs.readFileSync(f.options.target+'.partial.json'),before);
  assert.equal(backups,1);assert.equal(requests.length,1);assert.equal(requests[0],'bytes=8-');
  assert.equal(fs.existsSync(f.options.target+'.partial.replacement'),false);assert.equal(fs.existsSync(f.options.target),false);
});

test('legacy schema-1 checkpoints are safely upgraded before resuming',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-legacy-partial-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('abcdefghij'),target=path.join(root,'asset.zip'),identity={tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)};
  fs.writeFileSync(target+'.partial',bytes.subarray(0,4));
  fs.writeFileSync(target+'.partial.json',JSON.stringify({schema:'nora-download-partial/1',expected:sha(JSON.stringify([assetUrl,identity])),
    etag:'"fixed"',source:assetUrl,encoding:'identity',size:4,prefixSha256:sha(bytes.subarray(0,4))}));
  await networkModule.downloadAsset({url:assetUrl,target,identity,policy:{sources:{schema:1,mirrors:[]}},fetcher:async(_url,options)=>{
    assert.equal(new Headers(options.headers).get('range'),'bytes=4-');assert.equal(new Headers(options.headers).get('if-range'),'"fixed"');
    assert.equal(JSON.parse(fs.readFileSync(target+'.partial.json')).schema,'nora-download-partial/2');
    return new Response(bytes.subarray(4),{status:206,headers:{ETag:'"fixed"','Content-Length':'6','Content-Range':'bytes 4-9/10'}});
  }});assert.deepEqual(fs.readFileSync(target),bytes);
});

test('a SourceForge checkpoint resumes through a different admitted mirror without a foreign If-Range',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sourceforge-mirror-resume-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('abcdefghij'),target=path.join(root,'asset.zip'),identity={tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)};
  const canonical='https://downloads.sourceforge.net/project/nora-tavern/v2.4.2/asset.zip';
  const previous=canonical.replace('downloads.sourceforge.net','pilotfiber.dl.sourceforge.net');
  const current=canonical.replace('downloads.sourceforge.net','zenlayer.dl.sourceforge.net'),requests=[];
  fs.writeFileSync(target+'.partial',bytes.subarray(0,4));
  fs.writeFileSync(target+'.partial.json',JSON.stringify({schema:'nora-download-partial/2',plan:sha(JSON.stringify(identity)),
    content:sha(JSON.stringify([identity.sha256,identity.size])),requestUrl:canonical,source:previous,etag:'"previous-mirror"',encoding:'identity',
    size:4,prefixSha256:sha(bytes.subarray(0,4))}));
  const result=await networkModule.downloadAsset({url:assetUrl,target,identity,policy:{sources:{...sfSources,primary:'sourceforge'},maxAttempts:1},
    fetcher:async(url,options)=>{
      const headers=new Headers(options.headers);requests.push(url);assert.equal(headers.get('range'),'bytes=4-');assert.equal(headers.get('if-range'),null);
      assert.equal(options.redirect,'manual');
      const response=url===canonical?new Response(null,{status:302,headers:{Location:current}})
        :new Response(bytes.subarray(4),{status:206,headers:{ETag:'"current-mirror"','Content-Length':'6','Content-Range':'bytes 4-9/10'}});
      Object.defineProperty(response,'url',{value:url});return response;
    }});
  assert.deepEqual(requests,[canonical,current]);assert.equal(result.resumed,true);assert.deepEqual(fs.readFileSync(result.file),bytes);
});

test('a local prefix hash never authenticates tampered bytes before whole-file SHA verification',async t=>{
  const f=await interrupted(t,(req,res,bytes)=>{assert.equal(req.headers.range,'bytes=4-');res.writeHead(206,
    {ETag:'"content-v1"','Content-Length':'6','Content-Range':'bytes 4-9/10'});res.end(bytes.subarray(4));});
  const partial=f.options.target+'.partial',record=partial+'.json',saved=JSON.parse(fs.readFileSync(record));
  fs.writeFileSync(partial,'evil');fs.writeFileSync(record,JSON.stringify({...saved,prefixSha256:sha('evil')}));
  await assert.rejects(networkModule.downloadAsset(f.options),error=>error.code==='VERIFICATION_FAILED');
  assert.equal(fs.existsSync(f.options.target),false);assert.equal(fs.existsSync(partial),false);
});

test('corrupt local prefixes and unapproved checkpoint sources are discarded before issuing Range',async t=>{
  for(const kind of ['disk','source','short-disk','malformed-source'])await t.test(kind,async child=>{
    const f=await interrupted(child,(req,res,bytes)=>{assert.equal(req.headers.range,undefined);res.writeHead(200,{'Content-Length':'10'});res.end(bytes);});
    const partial=f.options.target+'.partial',record=partial+'.json';
    if(kind==='disk')fs.writeFileSync(partial,'evil');
    if(kind==='short-disk')fs.truncateSync(partial,2);
    if(kind==='source'){const saved=JSON.parse(fs.readFileSync(record));fs.writeFileSync(record,JSON.stringify({...saved,requestUrl:'https://unapproved.example/asset.zip'}));}
    if(kind==='malformed-source'){const saved=JSON.parse(fs.readFileSync(record));fs.writeFileSync(record,JSON.stringify({...saved,source:'malformed final URL'}));}
    await networkModule.downloadAsset(f.options);assert.deepEqual(fs.readFileSync(f.options.target),f.bytes);
  });
});

test('a control file without an independent SHA cannot create a resumable content checkpoint',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-control-not-resumable-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const controller=new AbortController(),target=path.join(root,'SHA256SUMS'),bytes=Buffer.from('abcdefghij');let calls=0;
  const options={url:assetUrl.replace('asset.zip','SHA256SUMS'),target,identity:{tag:'v2.4.2',asset:'SHA256SUMS',size:10},
    policy:{sources:{schema:1,mirrors:[]}},fetcher:async(_url,options)=>{
      assert.equal(new Headers(options.headers).get('range'),null);calls++;
      return new Response(calls===1?new ReadableStream({start(stream){stream.enqueue(bytes.subarray(0,4));}}):bytes,
        {headers:{ETag:'"fixed"','Content-Length':'10'}});
    }};
  await assert.rejects(networkModule.downloadAsset({...options,signal:controller.signal,
    onEvent:event=>{if(event.event==='progress'&&event.current===4)controller.abort();}}),{name:'AbortError'});
  assert.equal(fs.existsSync(target+'.partial'),false);assert.equal(fs.existsSync(target+'.partial.json'),false);
  await networkModule.downloadAsset(options);assert.equal(calls,2);assert.deepEqual(fs.readFileSync(target),bytes);
});

test('process death before and after a durable checkpoint recovers only committed bytes',async t=>{
  for(const mode of ['before','after'])await t.test(mode,async childTest=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-process-checkpoint-'));childTest.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const target=path.join(root,'asset.zip'),bytes=Buffer.from('abcdefghij'),identity={tag:'v2.4.2',asset:'asset.zip',size:10,sha256:sha(bytes)};
    let firstResponse;
    const f=await server(childTest,(request,response,count)=>{
      if(count===1){firstResponse=response;response.writeHead(200,{ETag:'"fixed"','Content-Length':'10'});response.write(bytes.subarray(0,4));return;}
      const offset=mode==='after'?4:0;assert.equal(request.headers.range,offset?'bytes=4-':undefined);
      if(offset)response.writeHead(206,{ETag:'"fixed"','Content-Range':'bytes 4-9/10','Content-Length':'6'});
      else response.writeHead(200,{ETag:'"fixed"','Content-Length':'10'});
      response.end(bytes.subarray(offset));
    });
    const script=`const fs=require('node:fs');const network=require(${JSON.stringify(path.join(desktop,'release-network'))});
      if(${JSON.stringify(mode)}==='before'){const original=fs.promises.open;fs.promises.open=async(...args)=>{const handle=await original(...args);
        handle.sync=async()=>{process.send({ready:true});await new Promise(()=>{});};return handle;};}
      network.downloadAsset({url:${JSON.stringify(assetUrl)},target:${JSON.stringify(target)},identity:${JSON.stringify(identity)},
        policy:{sources:{schema:1,mirrors:[]},downloadCheckpointIntervalMs:3600000,downloadCheckpointBytes:1048576},
        fetcher:async(url,options)=>{const response=await fetch(${JSON.stringify(f.base)}+new URL(url).pathname,options);
          Object.defineProperty(response,'url',{value:url});return response;},
        onEvent:event=>{if(${JSON.stringify(mode)}==='after'&&event.event==='progress'&&event.current===4)process.send({ready:true});}
      }).catch(error=>{process.send({failure:String(error)});process.exitCode=1;});`;
    const processChild=spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','pipe','ipc']});
    childTest.after(()=>{if(processChild.exitCode===null)processChild.kill('SIGKILL');});
    let errors='';processChild.stderr.on('data',chunk=>{errors+=chunk;});
    const exited=new Promise((resolve,reject)=>{processChild.once('error',reject);processChild.once('exit',(code,signal)=>resolve({code,signal}));});
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('checkpoint child did not reach the controlled crash boundary: '+errors)),5000);
      processChild.once('message',message=>{clearTimeout(timeout);message.ready?resolve():reject(new Error(message.failure || 'unexpected child message'));});
      processChild.once('exit',()=>{clearTimeout(timeout);reject(new Error('checkpoint child exited early: '+errors));});
    });
    const partial=target+'.partial',record=partial+'.json';assert.equal(fs.statSync(partial).size,4);
    if(mode==='after') {
      assert.equal(JSON.parse(fs.readFileSync(record)).size,4);firstResponse.write(bytes.subarray(4,6));
      const until=Date.now()+3000;
      while(fs.statSync(partial).size!==6 && Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(fs.statSync(partial).size,6,'uncommitted bytes must reach disk before the process is killed');
      assert.equal(JSON.parse(fs.readFileSync(record)).size,4);
    }else assert.equal(fs.existsSync(record),false);
    processChild.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
    await networkModule.downloadAsset({url:assetUrl,target,identity,fetcher:f.fetcher,policy:{sources:{schema:1,mirrors:[]}}});
    assert.deepEqual(fs.readFileSync(target),bytes);assert.equal(f.requests.length,2);
  });
});

test('a real socket interrupted after 100 MiB resumes those bytes from a differently tagged source',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-large-cross-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.alloc(128*1024*1024,0x61),target=path.join(root,'asset.zip');
  let primaryResponse,observedOffset=0,backupOffset=0;
  const f=await server(t,(request,response)=>{
    if(request.url.startsWith('/LoveMaker-art/')) {
      primaryResponse=response;response.writeHead(200,{'Content-Length':String(bytes.length),ETag:'"primary-large"'});
      response.write(bytes.subarray(0,112*1024*1024));return;
    }
    assert.match(request.headers.range,/^bytes=\d+-$/);assert.equal(request.headers['if-range'],undefined);
    backupOffset=Number(request.headers.range.slice(6,-1));assert.ok(backupOffset>100*1024*1024);
    response.writeHead(206,{ETag:'"backup-large"','Content-Length':String(bytes.length-backupOffset),
      'Content-Range':`bytes ${backupOffset}-${bytes.length-1}/${bytes.length}`});response.end(bytes.subarray(backupOffset));
  });
  const interrupt=setInterval(()=>{
    const stat=fs.statSync(target+'.partial',{throwIfNoEntry:false});
    if(primaryResponse && stat?.size>100*1024*1024 && !observedOffset) {
      observedOffset=stat.size;primaryResponse.destroy();clearInterval(interrupt);
    }
  },5);t.after(()=>clearInterval(interrupt));
  const result=await networkModule.downloadAsset({url:assetUrl,target,fetcher:f.fetcher,
    identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},
    policy:{sources:sfSources,maxAttempts:1,downloadBudgetMs:15000,backupBudgetMs:5000}});
  assert.ok(observedOffset>100*1024*1024);assert.ok(backupOffset>=observedOffset);
  assert.equal(f.requests.length,2);assert.equal(result.resumed,true);assert.equal(fs.statSync(result.file).size,bytes.length);
  assert.equal(sha(fs.readFileSync(result.file)),sha(bytes));
  t.diagnostic(JSON.stringify({evidence:'controlled-local-http-real-socket',assetBytes:bytes.length,interruptedDiskBytes:observedOffset,
    backupRange:`bytes=${backupOffset}-`,backupIfRange:f.requests[1].headers['if-range'] ?? null,backupETag:'"backup-large"',
    initialETag:'"primary-large"',requestCount:f.requests.length,finalSha256:sha(bytes),resumed:result.resumed,
    domesticPublicNetwork:false,packagedLauncher:false}));
});

test('cross-source resume rejects wrong lengths, compressed bytes and content changes before installation',async t=>{
  for(const kind of ['length','encoding','digest','partial-range','overflow'])await t.test(kind,async child=>{
    const f=await interrupted(child,(_request,response)=>{response.writeHead(503);response.end();},{url:assetUrl});
    let backupCalls=0;
    await assert.rejects(networkModule.downloadAsset({...f.options,policy:{sources,maxAttempts:1},fetcher:async(url,options)=>{
      if(!url.startsWith('https://primary.example/'))return f.fetcher(url,options);
      backupCalls++;assert.equal(new Headers(options.headers).get('range'),'bytes=4-');assert.equal(new Headers(options.headers).get('if-range'),null);
      const body=kind==='digest'?Buffer.from('XXXXXX'):kind==='overflow'?Buffer.from('efghijk'):kind==='partial-range'?Buffer.from('ef'):f.bytes.subarray(4);
      return new Response(body,{status:206,headers:{ETag:'"new-origin"','Content-Length':kind==='length'?'5':String(body.length),
        'Content-Range':kind==='partial-range'?'bytes 4-5/10':'bytes 4-9/10',...(kind==='encoding'?{'Content-Encoding':'gzip'}:{})}});
    }}),error=>error.code==='VERIFICATION_FAILED');
    assert.equal(backupCalls,1);assert.equal(fs.existsSync(f.options.target),false);
  });
});

test('shared assets inherit a source preference only for exact authorized canonical URLs',()=>{
  const context=networkModule.createReleaseSourceContext({tag:'v2.4.2'}),historical=assetUrl.replace('v2.4.2','v2.4.1');
  context.rememberAssetResponse(assetUrl,'sourceforge');assert.equal(context.preferredSource(historical),null);
  context.authorizeAssets([{url:historical,sha256:'a'.repeat(64),size:10}]);assert.equal(context.preferredSource(historical),'sourceforge');
  assert.equal(context.preferredSource(historical.replace('asset.zip','unlisted.zip')),null);
  assert.equal(context.isTargetAsset(historical),false);assert.equal(context.beginFixedPlanProbe(historical),false);
  for(const item of [{url:historical+'?query=yes',sha256:'a'.repeat(64),size:10},
    {url:historical.replace('github.com','evil.example'),sha256:'a'.repeat(64),size:10},
    {url:historical,sha256:'bad',size:10},{url:historical,sha256:'b'.repeat(64),size:10},
    {url:historical,sha256:'a'.repeat(64),size:0}])assert.throws(()=>context.authorizeAssets([item]),error=>error.code==='VERIFICATION_FAILED');
});

test('complete beta catalogue evidence comes from the admitted source for network, cache and 304 results',async()=>{
  let clock=1000,calls=0;const metadataCache=networkModule.createMetadataCache({ttlMs:100,now:()=>clock});
  const url='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=1';
  const options={channel:'beta',metadataCache,policy:{sources,now:()=>clock,maxAttempts:1},fetcher:async()=>{
    calls++;return calls===1?Response.json([{tag_name:'v2.4.2-beta.1'}],{headers:{ETag:'"beta"'}}):new Response(null,{status:304,headers:{ETag:'"beta"'}});
  }};
  const network=await networkModule.metadataJson(url,options);assert.equal(network.catalogueComplete,true);assert.equal(network.source,'network');
  clock=1050;const cached=await networkModule.metadataJson(url,options);assert.equal(cached.catalogueComplete,true);assert.equal(cached.source,'cache');
  clock=1200;const revalidated=await networkModule.metadataJson(url,options);assert.equal(revalidated.catalogueComplete,true);assert.equal(revalidated.source,'revalidated');
  assert.equal(calls,2);
  const github=await networkModule.metadataJson(url,{channel:'beta',policy:{sources:{schema:1,mirrors:[]},maxAttempts:1},
    fetcher:async()=>Response.json({catalogueComplete:true})});
  assert.equal(github.value.catalogueComplete,true);assert.equal(github.catalogueComplete,false,'a network body cannot grant catalogue completeness');
});

test('403 without rate headers is forbidden, while a rate reset beyond budget is returned without premature retry',async t=>{
  let clock=1000,sleeps=0;
  for(const headers of [{},{'x-ratelimit-remaining':'0','x-ratelimit-reset':'200'}]) {
    const f=await server(t,(_req,res)=>{res.writeHead(403,headers);res.end('forbidden');});
    const response=await networkModule.fetchRead(f.fetcher,'https://api.github.com/resource',{},
      {now:()=>clock,sleep:async ms=>{sleeps++;clock+=ms;},totalBudgetMs:1000});
    assert.equal(response.status,403);assert.equal(response.launcherResponse.rateLimited,Boolean(headers['x-ratelimit-reset']));
    assert.equal(f.requests.length,1);
  }
  assert.equal(sleeps,0);
});

test('429 Retry-After seconds and HTTP dates obey the same finite budget',async t=>{
  for(const after of ['2','Thu, 01 Jan 1970 00:00:03 GMT']) {
    let clock=1000;const sleeps=[];
    const f=await server(t,(_req,res,count)=>{res.writeHead(count===1?429:200,{'Retry-After':after});res.end('ready');});
    const response=await networkModule.fetchRead(f.fetcher,'https://api.github.com/resource',{},
      {now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},totalBudgetMs:4000});
    assert.equal(response.status,200);assert.deepEqual(sleeps,[2000]);assert.equal(f.requests.length,2);
  }
});

test('expired metadata is never presented as fresh after an outage and unbound 304 is rejected',async t=>{
  let clock=1000;
  const f=await server(t,(_req,res,count)=>{if(count===1) {res.writeHead(200,{ETag:'"good"'});res.end('{"version":"2.4.2"}');}
    else {res.writeHead(503);res.end('outage');}});
  const metadataCache=networkModule.createMetadataCache({ttlMs:100,now:()=>clock});
  const options={fetcher:f.fetcher,metadataCache,policy:{maxAttempts:1,sources:{schema:1,mirrors:[]}}};
  await networkModule.metadataJson('https://api.github.com/versions',options);clock=1200;
  await assert.rejects(networkModule.metadataJson('https://api.github.com/versions',options),error=>error.status===503);
  const unbound=await server(t,(_req,res)=>{res.writeHead(304);res.end();});
  await assert.rejects(networkModule.metadataJson('https://api.github.com/versions',{fetcher:unbound.fetcher}),error=>error.code==='INVALID_RESPONSE');
});

test('metadata cache survives restart but remains scoped to URL, headers and channel',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-metadata-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'metadata.json'),f=await server(t,(_req,res)=>{res.writeHead(200,{ETag:'"good"'});res.end('{"version":"2.4.2"}');});
  await networkModule.metadataJson('https://api.github.com/versions',{fetcher:f.fetcher,metadataCache:networkModule.createMetadataCache({file})});
  const cache=networkModule.createMetadataCache({file});
  const result=await networkModule.metadataJson('https://api.github.com/versions',{fetcher:f.fetcher,metadataCache:cache});
  assert.equal(result.source,'cache');assert.equal(result.latestConfirmed,false);
  await networkModule.metadataJson('https://api.github.com/versions',{fetcher:f.fetcher,metadataCache:cache,channel:'beta'});
  await networkModule.metadataJson('https://api.github.com/versions',{fetcher:f.fetcher,metadataCache:cache,headers:{Accept:'different'}});
  assert.equal(f.requests.length,3);
});

test('a full response with a wrong digest is never retried or made usable',async t=>{
  const f=await server(t,(_req,res)=>{res.writeHead(200,{ETag:'"wrong"','Content-Length':'10'});res.end('badcontent');});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-hash-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'asset.zip');
  await assert.rejects(networkModule.downloadAsset({url:'https://github.com/asset',target,fetcher:f.fetcher,
    identity:{tag:'v2.4.2',asset:'asset.zip',sha256:sha('abcdefghij'),size:10}}),error=>error.code==='VERIFICATION_FAILED');
  assert.equal(f.requests.length,1);assert.equal(fs.existsSync(target),false);assert.equal(fs.existsSync(target+'.partial'),false);
});

test('a file close failure cannot replace an earlier progress failure',async t=>{
  const f=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Length':'10'});res.end('abcdefghij');});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-close-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const primary=new Error('fixture progress failure'),secondary=new Error('fixture close failure'),open=fs.promises.open;
  t.mock.method(fs.promises,'open',async(...args)=>{const file=await open(...args);const close=file.close.bind(file);
    file.close=async()=>{await close();throw secondary;};return file;});
  await assert.rejects(networkModule.downloadAsset({url:'https://github.com/asset',target:path.join(root,'asset.zip'),fetcher:f.fetcher,
    identity:{tag:'v2.4.2',asset:'asset.zip',sha256:sha('abcdefghij'),size:10},
    onEvent:event=>{if(event.event==='progress' && event.current>0) throw primary;}}),error=>error===primary);
  assert.ok(primary.secondaryErrors.includes(secondary));
});

test('all-source asset failure keeps the canonical identity and the primary Retry-After',async t=>{
  const identity={tag:'v2.4.2',asset:'asset.zip',size:2048,sha256:'a'.repeat(64)};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-source-cooldown-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const started=Date.now();
  await assert.rejects(networkModule.downloadAsset({url:assetUrl,identity,target:path.join(root,'asset.zip'),
    fetcher:async url=>{
      const github=new URL(url).hostname==='github.com';
      const response=new Response('unavailable',{status:github?429:503,headers:github?{'retry-after':'60'}:{}});
      Object.defineProperty(response,'url',{value:String(url)});return response;
    },policy:{maxAttempts:1}}),error=>{
      assert.equal(error.conditionResource.url,assetUrl);
      assert.ok(error.conditionRetryAt>=started+60000);
      assert.ok(error.secondaryErrors.some(item=>item.operation==='release-source:github'));return true;
    });
});

test('metadata failure facts distinguish a real post-header stalled body from connection admission',async t=>{
  const events=[];
  const f=await server(t,(_request,response)=>{
    response.writeHead(200,{'Content-Type':'application/json','Content-Length':'200'});
    response.write('{"a":');
  });
  await assert.rejects(networkModule.metadataJson(latestUrl,{fetcher:f.fetcher,
    policy:{sources:{schema:1,mirrors:[]},maxAttempts:1,totalBudgetMs:500,attemptTimeoutMs:500,
      engine:'node',diagnostics:{write:(event,fields)=>events.push({event,...fields}),error(){}}}}),error=>error.code==='TIMEOUT');
  const failure=events.find(event=>event.event==='network.metadata.failed');
  assert.ok(failure,'the metadata body timeout must emit its phase facts through the real diagnostics channel');
  assert.equal(failure.phase,'body');assert.equal(failure.status,200);assert.equal(failure.bytesReceived,5);
  assert.equal(failure.declaredBytes,200);assert.equal(failure.resourceKind,'channel');assert.equal(failure.sourceKind,'github');
  assert.equal(failure.engine,'node');assert.equal(failure.abortReason,'operation_deadline');
  assert.ok(failure.headersMs>=0);assert.ok(failure.bodyMs>0);assert.ok(failure.firstByteMs>=failure.headersMs);
  assert.ok(failure.lastByteMs>=failure.firstByteMs);assert.ok(failure.elapsedMs>=failure.lastByteMs);
  assert.equal(f.requests.length,1,'diagnostic facts must not introduce retries or fallback');
});

test('metadata facts preserve a valid small body and bound untrusted length and message fields',async()=>{
  const good=JSON.stringify({tag_name:'v2.4.5'}),events=[];
  const policy={sources:{schema:1,mirrors:[]},maxAttempts:1,diagnostics:{write:(event,fields)=>events.push({event,...fields}),error(){}}};
  const result=await networkModule.metadataJson(latestUrl,{policy,fetcher:async()=>new Response(good,
    {headers:{'Content-Length':String(Buffer.byteLength(good))}})});
  assert.deepEqual(result.value,{tag_name:'v2.4.5'});assert.equal(result.body,good);assert.equal(result.latestConfirmed,true);
  const complete=events.find(event=>event.event==='network.metadata.complete');
  assert.ok(complete);assert.equal(complete.bytesReceived,Buffer.byteLength(good));
  assert.equal(complete.declaredBytes,Buffer.byteLength(good));assert.equal(complete.abortReason,'none');
  for(const length of ['length-canary','9007199254740992','4194305','-1']){
    const failures=[],stream=new ReadableStream({start(controller){controller.error(new Error('BODY_CANARY https://private.example/secret?token=QUERY_CANARY'));}});
    await assert.rejects(networkModule.metadataJson(latestUrl+'?token=QUERY_CANARY',{fetcher:async()=>{
      const response=new Response(stream,{headers:{'Content-Length':length,'X-Private':'HEADER_CANARY'}});
      Object.defineProperty(response,'url',{value:'https://private.example/secret?token=QUERY_CANARY'});return response;
    },policy:{...policy,engine:'ENGINE_CANARY',diagnostics:{write:(event,fields)=>failures.push({event,...fields}),error(){}}}}));
    const failure=failures.find(event=>event.event==='network.metadata.failed');assert.ok(failure);
    assert.equal(failure.phase,'body');assert.equal(failure.declaredBytes,null);assert.equal(failure.resourceKind,'unknown');assert.equal(failure.engine,'unknown');
    const serialized=JSON.stringify(failure);
    for(const value of ['BODY_CANARY','QUERY_CANARY','HEADER_CANARY','length-canary','private.example','https://','ENGINE_CANARY'])assert.ok(!serialized.includes(value),value+' must not enter metadata diagnostic facts');
  }
});

test('metadata caller cancellation is distinct from a source deadline after headers',async t=>{
  for(const reason of [new DOMException('caller stopped','AbortError'),new DOMException('caller budget','TimeoutError')])await t.test(reason.name,async()=>{
    const events=[],controller=new AbortController();let timer;
    const stream=new ReadableStream({start(body){body.enqueue(Buffer.from('{'));timer=setTimeout(()=>controller.abort(reason),20);}});
    try{
      await assert.rejects(networkModule.metadataJson(latestUrl,{signal:controller.signal,fetcher:async()=>new Response(stream),
        policy:{sources:{schema:1,mirrors:[]},maxAttempts:1,totalBudgetMs:1000,
          diagnostics:{write:(event,fields)=>events.push({event,...fields}),error(){}}}}));
      const failure=events.find(event=>event.event==='network.metadata.failed');assert.ok(failure);
      assert.equal(failure.phase,'body');assert.equal(failure.bytesReceived,1);
      assert.equal(failure.abortReason,reason.name==='AbortError'?'caller_cancelled':'caller_timeout');
    }finally{clearTimeout(timer);}
  });
});

test('metadata phase facts survive existing local console and operation-log projection without a fault schema change',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-metadata-facts-log-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {createDiagnostics}=require(path.join(desktop,'diagnostics'));
  const {createFaultPackets}=require(path.join(desktop,'fault-packet'));
  const {createOperationLogDelivery}=require(path.join(desktop,'operation-log-delivery'));
  const log=path.join(root,'install.log'),diagnostics=createDiagnostics({primary:()=>log,fallback:path.join(root,'fallback.log')});
  const operation=crypto.randomUUID(),consent=crypto.randomUUID(),installation=crypto.randomUUID(),batches=[];
  const packets=createFaultPackets({clean:diagnostics.clean,roots:()=>[root]});
  const delivery=createOperationLogDelivery({file:path.join(root,'outbox.json'),read:diagnostics.readOperation,project:text=>packets.text(text,Number.MAX_SAFE_INTEGER),
    consent:()=>({enabled:true,id:consent,installation}),fetcher:async(_url,options)=>{const batch=JSON.parse(options.body);batches.push(batch);return Response.json({accepted:true,index:batch.index,chunk_id:batch.chunk_id});}});
  t.after(()=>delivery.close());delivery.begin(operation);
  const product=networkModule.createReleaseNetwork({app:{whenReady:async()=>{}},diagnostics,
    net:{fetch:async()=>new Response(new ReadableStream({start(body){body.error(new Error('net::ERR_CONNECTION_RESET'));}}))}});
  await assert.rejects(diagnostics.scope(operation,{action:'check_update'},()=>networkModule.metadataJson(latestUrl,{fetcher:product.fetch,
    policy:{sources:{schema:1,mirrors:[]},maxAttempts:1,totalBudgetMs:1000}})));
  const records=diagnostics.readOperation(operation).records;
  const line=records.find(item=>item.text.includes('metadata phase=body'));assert.ok(line,'phase facts must be visible in the existing operation console');
  assert.ok(line.text.includes('resourceKind=channel'));assert.ok(line.text.includes('status=200'));assert.ok(line.text.includes('bytesReceived=0'));
  delivery.finish(operation,'failed');await delivery.flush();
  assert.ok(batches.some(batch=>batch.text.includes('metadata phase=body')&&batch.text.includes('bytesReceived=0')),
    'the existing projected raw operation log must preserve typed facts');
});

test('metadata admission failures and per-source body deadlines retain distinct safe facts',async t=>{
  const admission=[];
  await assert.rejects(networkModule.metadataJson(latestUrl,{fetcher:async()=>{throw new Error('net::ERR_CONNECTION_RESET');},
    policy:{sources:{schema:1,mirrors:[]},maxAttempts:1,
      diagnostics:{write:(event,fields)=>admission.push({event,...fields}),error(){}}}}),error=>error.code==='ECONNRESET');
  const before=admission.find(event=>event.event==='network.metadata.failed');assert.ok(before);
  assert.equal(before.phase,'before_headers');assert.equal(before.status,null);assert.equal(before.headersMs,null);
  assert.equal(before.bodyMs,null);assert.equal(before.bytesReceived,0);assert.equal(before.declaredBytes,null);
  assert.equal(before.contentEncoding,'unknown');assert.equal(before.abortReason,'transport_error');
  const events=[],calls=[],hold=setTimeout(()=>{},2000);t.after(()=>clearTimeout(hold));
  const result=await networkModule.metadataJson(latestUrl,{fetcher:async url=>{
    calls.push(url);return url.startsWith('https://primary.example/')
      ?new Response(new ReadableStream({start(body){body.enqueue(Buffer.from('{'));}})):Response.json({tag_name:'v2.4.5'});
  },policy:{sources,maxAttempts:1,attemptTimeoutMs:40,totalBudgetMs:1000,
    diagnostics:{write:(event,fields)=>events.push({event,...fields}),error(){}}}});
  assert.equal(result.value.tag_name,'v2.4.5');assert.equal(calls.length,2);
  const source=events.find(event=>event.event==='network.metadata.failed');assert.ok(source);
  assert.equal(source.phase,'body');assert.equal(source.sourceKind,'configured_mirror');assert.equal(source.resourceKind,'channel');
  assert.equal(source.bytesReceived,1);assert.equal(source.abortReason,'source_deadline');assert.ok(source.budgetMs<=40);
});

test('metadata diagnostic observer failure cannot replace a successful read',async()=>{
  const result=await networkModule.metadataJson(latestUrl,{fetcher:async()=>Response.json({tag_name:'v2.4.5'}),
    policy:{sources:{schema:1,mirrors:[]},maxAttempts:1,diagnostics:{write:event=>{if(event.startsWith('network.metadata.'))throw new Error('fixture logger unavailable');},error(){}}}});
  assert.equal(result.value.tag_name,'v2.4.5');assert.equal(result.source,'network');assert.equal(result.latestConfirmed,true);
});
