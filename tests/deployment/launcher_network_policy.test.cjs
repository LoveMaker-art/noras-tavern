const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const https=require('node:https');
const {Readable}=require('node:stream');
const {execFileSync}=require('node:child_process');
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
  return {requests,fetcher:async(url,options)=>{
    const result=await fetch(base+new URL(url).pathname,options);
    Object.defineProperty(result,'url',{value:String(url),configurable:true});return result;
  }};
}
const quiet={write(){},error(){}};
const sources={schema:1,mirrors:[{id:'primary',baseUrl:'https://primary.example/'}]};
const latestUrl='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest';
const assetUrl='https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.2/asset.zip';

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
  const serve=async(primary)=>{
    const service=https.createServer(tls,(request,response)=>{
      requests.push({primary,path:request.url,range:request.headers.range});
      response.writeHead(200,{'Content-Length':bytes.length,ETag:primary?'"primary"':'"backup"'});
      response.write(bytes.subarray(0,4096));
      setTimeout(()=>primary?response.destroy():response.end(bytes.subarray(4096)),15);
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
    policy:{sources:{schema:1,mirrors:[{id:'primary',baseUrl:primary}]},downloadBudgetMs:3000},
    onEvent:event=>{if(event.event==='progress')progress.push({current:event.current,total:event.total});}});
  assert.deepEqual(fs.readFileSync(path.join(root,'asset.zip')),bytes);
  assert.equal(requests.length,2);assert.equal(requests[0].path,'/releases/v2.4.2/asset.zip');assert.equal(requests[1].range,undefined);
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
test('the shipped source order is GitHub first and healthy GitHub makes no backup request',async()=>{
  const {sourceCandidates}=require(path.join(desktop,'release-sources'));
  assert.deepEqual(sourceCandidates(latestUrl).map(item=>item.id),['github','sourceforge']);
  const calls=[];
  const result=await networkModule.metadataJson(latestUrl,{fetcher:async url=>{calls.push(url);return Response.json({tag_name:'v2.4.2'});}});
  assert.equal(result.value.tag_name,'v2.4.2');assert.deepEqual(calls,[latestUrl]);
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
test('a continuously slow GitHub body cannot consume the backup download window',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sourceforge-slow-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('verified'),calls=[];let timer;
  t.after(()=>clearInterval(timer));
  await networkModule.downloadAsset({url:assetUrl,target:path.join(root,'asset.zip'),identity:{tag:'v2.4.2',asset:'asset.zip',size:bytes.length,sha256:sha(bytes)},
    policy:{sources:sfSources,downloadBudgetMs:200,backupBudgetMs:150,downloadIdleTimeoutMs:100},fetcher:async url=>{
      calls.push(url);if(url!==assetUrl)return new Response(bytes);
      return new Response(new ReadableStream({start(controller){timer=setInterval(()=>controller.enqueue(Buffer.from('v')),25);},cancel(){clearInterval(timer);}}));
    }});
  assert.equal(calls.length,2);assert.deepEqual(fs.readFileSync(path.join(root,'asset.zip')),bytes);
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

async function interrupted(t,finish,{etag='"content-v1"',prefix=4}={}) {
  const bytes=Buffer.from('abcdefghij'),controller=new AbortController();
  const f=await server(t,(req,res,count)=>{
    if(count>1) return finish(req,res,bytes);
    res.writeHead(200,{'Content-Length':'10',ETag:etag});
    if(prefix===bytes.length) res.end(bytes);else res.write(bytes.subarray(0,prefix));
  });
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-range-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const options={url:'https://github.com/asset',target:path.join(root,'asset.zip'),fetcher:f.fetcher,
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

test('weak validators and a changed fixed identity start a new full request',async t=>{
  for(const kind of ['weak','identity']) await t.test(kind,async child=>{
    const f=await interrupted(child,(req,res,bytes)=>{assert.equal(req.headers.range,undefined);assert.equal(req.headers['if-range'],undefined);
      res.writeHead(200,{ETag:'"content-v1"','Content-Length':'10'});res.end(bytes);},{etag:kind==='weak'?'W/"content-v1"':'"content-v1"'});
    await networkModule.downloadAsset({...f.options,identity:{...f.options.identity,...(kind==='identity'?{tag:'v2.4.3'}:{})}});
    assert.deepEqual(fs.readFileSync(f.options.target),f.bytes);
  });
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
