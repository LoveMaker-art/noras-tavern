import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

const root=path.resolve(import.meta.dirname,'..');
const helper='tooling/release/sourceforge-credentials.mjs';
test('only the independent publication job handles credentials, locks formal channels and always cleans up',()=>{
  for(const file of ['publish-accepted-release.yml']){
    const text=fs.readFileSync(path.join(root,'.github/workflows',file),'utf8');
    assert.match(text,/group: nora-sourceforge-release-channels/,file);
    const prepare=text.indexOf(`node ${helper} prepare`),publish=text.indexOf('node tooling/release/publish-release.mjs',prepare),cleanup=text.indexOf(`node ${helper} cleanup`);
    assert.ok(prepare>=0 && prepare<publish && cleanup>publish,`${file}: credentials must bracket the actual publisher`);
    for(const name of ['SOURCEFORGE_USERNAME','SOURCEFORGE_SSH_PRIVATE_KEY','SOURCEFORGE_KNOWN_HOSTS'])assert.ok(text.includes(name),`${file}: missing ${name}`);
    assert.match(text.slice(publish,cleanup),/if: always\(\)/,`${file}: cleanup must run on failure`);
  }
  for(const file of ['build-integrated-launcher.yml','publish-component-update.yml']){
    const text=fs.readFileSync(path.join(root,'.github/workflows',file),'utf8');
    assert.ok(!text.includes('SOURCEFORGE_SSH_PRIVATE_KEY'),`${file}: build job must not receive publisher secrets`);
  }
});
test('CI credential preparation produces a usable private config and cleanup cannot remove an unrelated directory',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sf-ci-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const environment=path.join(temp,'github-env'),env={...process.env,RUNNER_TEMP:temp,GITHUB_ENV:environment,NORA_SF_USERNAME:'sorrymakerx',NORA_SF_PRIVATE_KEY:'isolated fixture key',NORA_SF_KNOWN_HOSTS:'frs.sourceforge.net ssh-ed25519 isolated-fixture'};
  const run=(command,overrides={})=>spawnSync(process.execPath,[path.join(root,helper),command],{env:{...env,...overrides},encoding:'utf8'});
  const prepared=run('prepare');assert.equal(prepared.status,0,prepared.stderr);
  const config=fs.readFileSync(environment,'utf8').trim().split('=').slice(1).join('=');
  const value=JSON.parse(fs.readFileSync(config,'utf8'));assert.equal(value.project,'nora-tavern');assert.equal(value.username,'sorrymakerx');
  for(const file of [config,value.identityFile,value.knownHostsFile])assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.equal(run('cleanup',{NORA_SOURCEFORGE_UPLOAD_CONFIG:config}).status,0);assert.equal(fs.existsSync(path.dirname(config)),false);
  const unrelated=path.join(temp,'keep');fs.mkdirSync(unrelated);fs.writeFileSync(path.join(unrelated,'publisher.json'),'{}');
  assert.notEqual(run('cleanup',{NORA_SOURCEFORGE_UPLOAD_CONFIG:path.join(unrelated,'publisher.json')}).status,0);assert.equal(fs.existsSync(unrelated),true);
});
test('missing credentials fail before publishing a configuration path',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sf-missing-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const environment=path.join(temp,'github-env');const run=spawnSync(process.execPath,[path.join(root,helper),'prepare'],{env:{...process.env,RUNNER_TEMP:temp,GITHUB_ENV:environment,NORA_SF_USERNAME:'sorrymakerx',NORA_SF_PRIVATE_KEY:'',NORA_SF_KNOWN_HOSTS:''},encoding:'utf8'});
  assert.notEqual(run.status,0);assert.equal(fs.existsSync(environment),false);assert.deepEqual(fs.readdirSync(temp),[]);
});

test('a transient mirror connect timeout retries from the canonical URL and still verifies every byte',async()=>{
  const {verifyDistributionObject}=await import('../tooling/release/publish-release.mjs');
  const bytes=Buffer.from('the complete fixed SourceForge publication object');
  const object={key:'releases/v2.4.4/Nora-Tavern-Launcher-2.1.1-win-x64.zip',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  const canonical='https://downloads.sourceforge.net/project/nora-tavern/v2.4.4/Nora-Tavern-Launcher-2.1.1-win-x64.zip';
  const urls=[];let redirects=0;
  const fetcher=async(url,options)=>{
    assert.equal(options.redirect,'manual');urls.push(url);
    if(url===canonical){redirects++;return new Response(null,{status:302,headers:{location:canonical.replace('downloads.sourceforge.net',redirects===1?'cytranet-dal.dl.sourceforge.net':'netix.dl.sourceforge.net')}});}
    if(url.includes('cytranet-dal.dl.sourceforge.net'))throw new TypeError('fetch failed',{cause:Object.assign(new Error('Connect Timeout Error'),{code:'UND_ERR_CONNECT_TIMEOUT'})});
    return new Response(bytes);
  };
  await verifyDistributionObject(object,{fetcher,retryDelay:0,log:()=>{}});
  assert.equal(redirects,2);
  assert.deepEqual(urls,[canonical,canonical.replace('downloads.sourceforge.net','cytranet-dal.dl.sourceforge.net'),canonical,canonical.replace('downloads.sourceforge.net','netix.dl.sourceforge.net')]);
});

const fixedBody=Buffer.from('all bytes must match the original fixed object');
const fixedObject={key:'releases/v2.4.4/fixture.zip',size:fixedBody.length,sha256:crypto.createHash('sha256').update(fixedBody).digest('hex')};
const quiet={retryDelay:0,log:()=>{}};
const connectionFailure=()=>new TypeError('fetch failed',{cause:Object.assign(new Error('Connect Timeout Error'),{code:'UND_ERR_CONNECT_TIMEOUT'})});

test('HEAD retries temporary transport failures but only actual 404 and 410 mean absent',async()=>{
  const {readPublic}=await import('../tooling/release/publish-release.mjs');let calls=0;
  const response=await readPublic(fixedObject.key,async(url,options)=>{
    assert.equal(options.method,'HEAD');assert.equal(options.headers['Accept-Encoding'],'identity');calls++;
    if(calls===1)throw connectionFailure();
    assert.equal(options.headers['Cache-Control'],'no-cache');
    return new Response(null,{headers:{'content-length':String(fixedObject.size)}});
  },1000,{...quiet,method:'HEAD'});
  assert.equal(response.status,200);assert.equal(calls,2);
  for(const status of [404,410]){
    calls=0;const absent=await readPublic(fixedObject.key,async()=>{calls++;return new Response(null,{status});},1000,quiet);
    assert.equal(absent.status,status);assert.equal(calls,1);
  }
  calls=0;await assert.rejects(readPublic(fixedObject.key,async()=>{calls++;throw connectionFailure();},1000,quiet),/fetch failed/);
  assert.equal(calls,4);
});

test('temporary HTTP errors retry; permission errors and unexpected responses do not',async()=>{
  const {verifyDistributionObject}=await import('../tooling/release/publish-release.mjs');
  for(const status of [408,429,500,502,503,504]){
    let calls=0;await verifyDistributionObject(fixedObject,{...quiet,fetcher:async()=>++calls===1?new Response(null,{status,headers:{'Retry-After':'0'}}):new Response(fixedBody)});
    assert.equal(calls,2,`HTTP ${status}`);
  }
  for(const status of [400,401,403,404,410,501]){
    let calls=0;await assert.rejects(verifyDistributionObject(fixedObject,{...quiet,fetcher:async()=>{calls++;return new Response(null,{status});}}),/unavailable/);
    assert.equal(calls,1,`HTTP ${status}`);
  }
});

test('Retry-After beyond the total deadline fails without retrying early',async()=>{
  const {readPublic}=await import('../tooling/release/publish-release.mjs');
  for(const retryAfter of ['120',new Date(Date.now()+120000).toUTCString(),'999999999999999999999999999']){
    let calls=0;const started=Date.now();
    await assert.rejects(readPublic(fixedObject.key,async()=>{calls++;return new Response(null,{status:429,headers:{'Retry-After':retryAfter}});},30,quiet),/public read deadline/);
    assert.equal(calls,1);assert.ok(Date.now()-started<500);
  }
});

test('a body socket reset restarts from zero; a corrupt complete retry cannot pass SHA verification',async()=>{
  const {verifyDistributionObject}=await import('../tooling/release/publish-release.mjs');
  for(const secondBody of [fixedBody,Buffer.alloc(fixedBody.length)]){
    let calls=0;
    const fetcher=async()=>{
      if(++calls!==1)return new Response(secondBody);
      let pulls=0;return new Response(new ReadableStream({pull(controller){
        if(pulls++===0)controller.enqueue(fixedBody.subarray(0,5));
        else controller.error(Object.assign(new Error('socket reset'),{code:'UND_ERR_SOCKET'}));
      }}));
    };
    if(secondBody===fixedBody)await verifyDistributionObject(fixedObject,{...quiet,fetcher});
    else await assert.rejects(verifyDistributionObject(fixedObject,{...quiet,fetcher}),/Different SourceForge object/);
    assert.equal(calls,2);
  }
});

test('oversized, incomplete and wrong complete objects fail immediately without transport retries',async()=>{
  const {verifyDistributionObject}=await import('../tooling/release/publish-release.mjs');
  for(const body of [fixedBody.subarray(0,5),Buffer.alloc(fixedBody.length),Buffer.concat([fixedBody,Buffer.from('x')])]){
    let calls=0;await assert.rejects(verifyDistributionObject(fixedObject,{...quiet,fetcher:async()=>{calls++;return new Response(body);}}),/Incomplete|Different|too large/);
    assert.equal(calls,1);
  }
});

test('untrusted redirects, wrong paths and TLS trust errors never retry or follow an unsafe URL',async()=>{
  const {verifyDistributionObject}=await import('../tooling/release/publish-release.mjs');
  for(const location of ['https://example.com/project/nora-tavern/v2.4.4/fixture.zip','http://netix.dl.sourceforge.net/project/nora-tavern/v2.4.4/fixture.zip','https://netix.dl.sourceforge.net/project/nora-tavern/v2.4.3/fixture.zip']){
    let calls=0;await assert.rejects(verifyDistributionObject(fixedObject,{...quiet,fetcher:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}}));
    assert.equal(calls,1);
  }
  let calls=0;await assert.rejects(verifyDistributionObject(fixedObject,{...quiet,fetcher:async()=>{calls++;throw Object.assign(new Error('invalid TLS certificate'),{code:'CERT_HAS_EXPIRED'});}}),/invalid TLS/);
  assert.equal(calls,1);
});

test('headers, stream idle, attempt and overall deadlines terminate pending requests',async()=>{
  const {readPublic,verifyDistributionObject}=await import('../tooling/release/publish-release.mjs');
  let calls=0;
  await assert.rejects(readPublic(fixedObject.key,async()=>{calls++;return new Promise(()=>{});},200,{...quiet,headerTimeout:5,maxAttempts:2}),/headers deadline/);
  assert.equal(calls,2);
  calls=0;await assert.rejects(verifyDistributionObject(fixedObject,{...quiet,totalTimeout:40,attemptTimeout:100,headerTimeout:100,fetcher:async()=>{calls++;return new Promise(()=>{});}}),/public read deadline/);
  assert.equal(calls,1);
  calls=0;await assert.rejects(verifyDistributionObject(fixedObject,{...quiet,totalTimeout:200,attemptTimeout:5,idleTimeout:100,maxAttempts:2,fetcher:async()=>{calls++;return new Response(new ReadableStream({start(){}}));}}),/public attempt deadline/);
  assert.equal(calls,2);
  calls=0;await assert.rejects(verifyDistributionObject(fixedObject,{...quiet,totalTimeout:200,idleTimeout:5,maxAttempts:2,fetcher:async()=>{calls++;return new Response(new ReadableStream({start(){}}));}}),/verification stalled/);
  assert.equal(calls,2);
});

test('operator cancellation prevents further retry and network fetches',async()=>{
  const {readPublic}=await import('../tooling/release/publish-release.mjs');const controller=new AbortController();let calls=0;
  await assert.rejects(readPublic(fixedObject.key,async()=>{calls++;controller.abort(new Error('operator cancelled'));throw connectionFailure();},1000,{...quiet,signal:controller.signal}),/operator cancelled/);
  assert.equal(calls,1);
});
