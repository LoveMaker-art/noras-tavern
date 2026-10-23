import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createJihuTransport,loadJihuUploadConfig} from '../tooling/release/jihulab-transport.mjs';
import {jihulabProvider} from '../tooling/release/jihulab-provider.mjs';

const config={projectId:378185,projectPath:'LoveMaker-art/nora-tavern',packageName:'nora-tavern',branch:'main'};
const api='https://jihulab.com/api/v4/projects/378185';
const source={id:'jihulab',provider:'jihulab',baseUrl:api+'/packages/generic/nora-tavern/',
  channelBaseUrl:'https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/'};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const release=tag=>({tag_name:tag,draft:false,prerelease:tag.includes('-beta.'),assets:[]});
const fileApi=api+'/repository/files/channels%2Fstable.json';
const publicChannel=source.channelBaseUrl+'channels/stable.json';
const project={id:config.projectId,path_with_namespace:config.projectPath,visibility:'public',default_branch:'main',
  archived:false,packages_enabled:true,namespace:{full_path:'LoveMaker-art'}};
const policy=(allowed=false,regex='')=>({data:{namespace:{fullPath:'LoveMaker-art',packageSettings:{
  genericDuplicatesAllowed:allowed,genericDuplicateExceptionRegex:regex}}}});
const metadata=(bytes,commit='a'.repeat(40))=>({file_path:'channels/stable.json',ref:'main',size:bytes.length,
  encoding:'base64',content:bytes.toString('base64'),content_sha256:hash(bytes),last_commit_id:commit});
function fixture(t,{route=()=>new Response(null,{status:404}),policyValue=policy(),options={},onRequest,
  projectValue=project,authenticatedProjectValue=project,configValue=config}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jihulab-transport-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],logs=[];
  const fetcher=async(url,settings={})=>{
    const call={url:String(url),...settings};calls.push(call);await onRequest?.(call);
    if(String(url)===api && (settings.method||'GET')==='GET')return json(new Headers(settings.headers).has('PRIVATE-TOKEN')
      ?authenticatedProjectValue:projectValue);
    if(String(url)==='https://jihulab.com/api/graphql')return json(policyValue);
    return route(call);
  };
  const transport=createJihuTransport(configValue,{source,privateToken:'test-secret-token',fetcher,log:message=>logs.push(message),...options});
  const object=(bytes,key='releases/v2.4.5/asset.zip',phase='asset')=>{
    const file=path.join(root,path.basename(key));fs.writeFileSync(file,bytes);
    return {file,key,phase,size:bytes.length,sha256:hash(bytes)};
  };
  const publication=(tag='v2.4.5')=>{
    const bytes=Buffer.from(JSON.stringify(release(tag))+'\n');
    const pointer=object(bytes,'channels/stable.json','channel');
    return {plan:{tag,channel:'stable',objects:[pointer]},pointer,bytes};
  };
  return {transport,calls,logs,object,publication,root,fetcher};
}

const inventoryConfig={...config,immutablePolicy:'inventory-single-publisher'};
const packageRecord={id:900,name:'nora-tavern',version:'v2.4.5',package_type:'generic',status:'default'};
const inventoryFile=(bytes,name='asset.zip',id=901)=>({id,package_id:900,file_name:name,size:bytes.length,file_sha256:hash(bytes)});
function inventoryFixture(t,{files=[inventoryFile(Buffer.from('asset'))],packages=[packageRecord],options={},afterWrite,
  extraRoute,onRequest}={}) {
  const server={files,packages,bytes:Buffer.from('asset'),writes:0};
  const setup=fixture(t,{configValue:inventoryConfig,policyValue:{data:{namespace:null}},options,onRequest,route:async call=>{
    const url=new URL(call.url),method=call.method||'GET';
    if(url.pathname===new URL(api).pathname+'/packages'&&method==='GET')
      return json(server.packages.filter(item=>item.status===url.searchParams.get('status')),200,{'x-next-page':''});
    if(url.pathname===new URL(api).pathname+'/packages/900/package_files'&&method==='GET')
      return json(server.files,200,{'x-next-page':''});
    if(call.url===source.baseUrl+'v2.4.5/asset.zip') {
      if(method==='PUT') {
        const chunks=[];for await(const bytes of call.body)chunks.push(bytes);server.bytes=Buffer.concat(chunks);
        server.writes++;server.files.push(inventoryFile(server.bytes));
        if(!server.packages.length)server.packages.push(packageRecord);
        await afterWrite?.(server);return json({message:'201 Created'},201);
      }
      return server.files.some(file=>file.file_name==='asset.zip')?new Response(method==='HEAD'?null:server.bytes,
        {headers:{'content-length':String(server.bytes.length)}}):new Response(null,{status:404});
    }
    return await extraRoute?.(call,server)??new Response(null,{status:404});
  }});
  return {...setup,server};
}

test('publisher configuration and token files require private regular files',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jihulab-credentials-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const token=path.join(root,'token'),publisher=path.join(root,'publisher.json');
  fs.writeFileSync(token,'test-secret-token\n',{mode:0o600});
  fs.writeFileSync(publisher,JSON.stringify({...config,tokenFile:token}),{mode:0o600});
  assert.deepEqual(loadJihuUploadConfig(publisher),{...config,tokenFile:token});
  assert.doesNotThrow(()=>createJihuTransport(loadJihuUploadConfig(publisher),{source,log:()=>{}}));
  fs.writeFileSync(publisher,JSON.stringify({...inventoryConfig,tokenFile:token}));
  assert.deepEqual(loadJihuUploadConfig(publisher),{...inventoryConfig,tokenFile:token});
  assert.doesNotThrow(()=>createJihuTransport(publisher,{source,log:()=>{}}));
  fs.writeFileSync(publisher,JSON.stringify({...config,immutablePolicy:'ignore-errors',tokenFile:token}));
  assert.throws(()=>loadJihuUploadConfig(publisher),/policy/i);
  fs.writeFileSync(publisher,JSON.stringify({...config,tokenFile:token}));
  fs.chmodSync(token,0o644);
  assert.throws(()=>createJihuTransport(loadJihuUploadConfig(publisher),{source}),/protected|private|0600/i);
  fs.chmodSync(token,0o600);fs.chmodSync(publisher,0o644);
  assert.throws(()=>loadJihuUploadConfig(publisher),/protected|private|0600/i);
  fs.chmodSync(publisher,0o600);
  const linked=path.join(root,'linked');fs.symlinkSync(publisher,linked);
  assert.throws(()=>loadJihuUploadConfig(linked),/regular|link/i);
});

test('publisher identity must match the build-owned exact Jihu roots before IO',()=>{
  for(const invalid of [{...source,baseUrl:source.baseUrl.replace('378185','1')},
    {...source,channelBaseUrl:source.channelBaseUrl.replace('/main/','/other/')},
    {...source,baseUrl:'https://evil.example/api/v4/projects/378185/packages/generic/nora-tavern/'},
    {...source,objectStorageRoots:['https://*.myqcloud.com/']}])
    assert.throws(()=>createJihuTransport(config,{source:invalid,privateToken:'secret'}),/source|root|config|identity/i);
});

test('immutable writes require a public matching project and server-enforced no-duplicate policy',async t=>{
  for(const value of [policy(true),policy(false,'.*'),{data:{namespace:null}},{errors:[{message:'sensitive server content'}]}]) {
    const {transport,calls,object}=fixture(t,{policyValue:value});
    await assert.rejects(transport.upload(object(Buffer.from('asset')),{immutable:true}),/duplicate|policy|namespace/i);
    assert.equal(calls.some(call=>call.method==='PUT'),false);
  }
});

test('public project responses can omit private settings; authenticated settings and registry availability decide writes',async t=>{
  const minimal={id:378185,path_with_namespace:config.projectPath,visibility:'public',default_branch:'main',namespace:project.namespace};
  const {transport,calls}=fixture(t,{projectValue:minimal,authenticatedProjectValue:{...minimal,archived:false},
    route:call=>call.url===api+'/packages?package_type=generic&per_page=1'?json([]):new Response(null,{status:404})});
  await transport.preflight();
  assert.ok(calls.some(call=>call.url===api&&new Headers(call.headers).has('PRIVATE-TOKEN')));
  assert.ok(calls.some(call=>call.url===api+'/packages?package_type=generic&per_page=1'));
  const disabled=fixture(t,{projectValue:minimal,authenticatedProjectValue:{...minimal,archived:false,packages_enabled:false}});
  await assert.rejects(disabled.transport.preflight(),/package|registry|availability/i);
});

test('public reads stay anonymous and reject unknown object-storage redirects before following them',async t=>{
  const {transport,calls}=fixture(t,{route:()=>new Response(null,{status:302,headers:{location:'https://unverified.cos.myqcloud.com/file'}})});
  await assert.rejects(transport.readPublic('releases/v2.4.5/asset.zip'),/来源|source|redirect/i);
  assert.equal(calls.length,1);
  assert.equal(new Headers(calls[0].headers).has('PRIVATE-TOKEN'),false);
  assert.equal(calls[0].redirect,'manual');
});

test('full public bytes establish SHA-256; correct HEAD metadata cannot hide wrong bytes',async t=>{
  const {transport,object,calls}=fixture(t,{route:call=>new Response(call.method==='HEAD'?null:'wrong',{
    headers:{'content-length':'5','x-checksum-sha256':hash('asset')}})});
  const asset=object(Buffer.from('asset'));
  const response=await transport.readPublic(asset.key,undefined,1000,{method:'HEAD'});await response.body?.cancel();
  await assert.rejects(transport.verifyObject(asset),/SHA|sha|different/i);
  assert.deepEqual(calls.map(call=>call.method||'GET'),['HEAD','GET']);
});

test('matching immutable files are adopted while different bytes are never overwritten',async t=>{
  for(const bytes of ['asset','wrong']) {
    const {transport,calls,object}=fixture(t,{route:()=>new Response(bytes)}),asset=object(Buffer.from('asset'));
    if(bytes==='asset')await transport.upload(asset,{immutable:true});
    else await assert.rejects(transport.upload(asset,{immutable:true}),/SHA|sha|different/i);
    assert.equal(calls.some(call=>call.method==='PUT'),false);
  }
});

test('missing immutable upload streams exact sealed bytes to only the authenticated Jihu API',async t=>{
  let uploaded=false;const sent=[];
  const {transport,calls,logs,object}=fixture(t,{route:async call=>{
    if(call.method==='PUT') {
      for await(const chunk of call.body)sent.push(chunk);
      uploaded=true;return json({message:'201 Created'},201);
    }
    return uploaded?new Response('asset'):new Response(null,{status:404});
  }});
  const asset=object(Buffer.from('asset'));await transport.upload(asset,{immutable:true});await transport.verifyObject(asset);
  assert.equal(Buffer.concat(sent).toString(),'asset');
  const put=calls.find(call=>call.method==='PUT');
  assert.equal(put.url,source.baseUrl+'v2.4.5/asset.zip');assert.equal(put.duplex,'half');
  assert.equal(new Headers(put.headers).get('PRIVATE-TOKEN'),'test-secret-token');
  assert.equal(new Headers(put.headers).get('content-length'),'5');
  for(const call of calls.filter(call=>call.url.includes('/packages/generic/')&&call.method!=='PUT'))
    assert.equal(new Headers(call.headers).has('PRIVATE-TOKEN'),false);
  assert.equal(logs.some(line=>line.includes('test-secret-token')),false);
});

test('a source file changed during network preflight cannot corrupt its sealed immutable upload',async t=>{
  let asset,stored;
  const {transport,object}=fixture(t,{onRequest:call=>{
    if(call.url===api)fs.writeFileSync(asset.file,'wrong');
  },route:async call=>{
    if(call.method==='PUT') {
      const chunks=[];for await(const bytes of call.body)chunks.push(bytes);stored=Buffer.concat(chunks);
      return json({message:'201 Created'},201);
    }
    return stored?new Response(stored):new Response(null,{status:404});
  }});
  asset=object(Buffer.from('asset'));await transport.upload(asset,{immutable:true});
  assert.equal(stored.toString(),'asset');await transport.verifyObject(asset);
  assert.equal(fs.readFileSync(asset.file,'utf8'),'wrong','snapshotting must preserve unrelated current source changes');
});

test('ambiguous immutable upload failure is never retried and is accepted only after exact anonymous readback',async t=>{
  for(const readback of ['asset',null]) {
    let attempted=false;
    const {transport,calls,object}=fixture(t,{route:call=>{
      if(call.method==='PUT'){attempted=true;throw new Error('server leaked test-secret-token');}
      return attempted&&readback?new Response(readback):new Response(null,{status:404});
    }});
    const operation=transport.upload(object(Buffer.from('asset')),{immutable:true});
    if(readback)await operation;
    else await assert.rejects(operation,error=>/JihuLab/.test(error.message)&&!error.message.includes('test-secret-token'));
    assert.equal(calls.filter(call=>call.method==='PUT').length,1);
  }
});

test('repository channel update includes last_commit_id and checks anonymous final bytes',async t=>{
  let current=Buffer.from(JSON.stringify(release('v2.4.4'))+'\n'),commit='a'.repeat(40);
  const {transport,calls,publication}=fixture(t,{route:call=>{
    if(call.url===fileApi+'?ref=main')return json(metadata(current,commit));
    if(call.method==='PUT') {
      const body=JSON.parse(call.body);assert.equal(body.last_commit_id,commit);assert.equal(body.encoding,'base64');
      current=Buffer.from(body.content,'base64');commit='b'.repeat(40);
      return json({file_path:'channels/stable.json',branch:'main'});
    }
    if(call.url===publicChannel)return new Response(current);
    throw new Error('unexpected test request');
  }});
  const p=publication();await transport.channelPromotion.check(p);await transport.channelPromotion.promote(p.pointer,p);
  await transport.channelPromotion.verify(p.pointer,p);
  assert.equal(calls.filter(call=>call.method==='PUT').length,1);
  assert.equal(calls.filter(call=>call.url===fileApi+'?ref=main').length,2);
  for(const call of calls.filter(call=>call.url===publicChannel))assert.equal(new Headers(call.headers).has('PRIVATE-TOKEN'),false);
});

test('a missing channel requires anonymous absence confirmation and creates it once',async t=>{
  let current;
  const {transport,calls,publication}=fixture(t,{route:call=>{
    if(call.url===fileApi+'?ref=main')return current?json(metadata(current)):new Response(null,{status:404});
    if(call.method==='POST') {
      const body=JSON.parse(call.body);assert.equal(Object.hasOwn(body,'last_commit_id'),false);
      current=Buffer.from(body.content,'base64');return json({file_path:'channels/stable.json',branch:'main'},201);
    }
    if(call.url===publicChannel)return new Response(current);
    throw new Error('unexpected test request');
  }});
  const p=publication();await transport.channelPromotion.check(p);await transport.channelPromotion.promote(p.pointer,p);
  assert.equal(calls.filter(call=>call.method==='POST'&&call.url===fileApi).length,1);
  assert.equal(calls.filter(call=>call.url===fileApi+'?ref=main'&&!new Headers(call.headers).has('PRIVATE-TOKEN')).length,2);
});

test('changed channel snapshots, downgrades, authorization failures, and CAS rejection never overwrite',async t=>{
  for(const mode of ['changed','downgrade','auth','cas']) {
    let reads=0;
    const {transport,calls,publication}=fixture(t,{route:call=>{
      if(call.url===fileApi+'?ref=main') {
        reads++;
        if(mode==='auth')return json({message:'test-secret-token'},401);
        const tag=mode==='downgrade'?'v2.4.6':'v2.4.4';
        return json(metadata(Buffer.from(JSON.stringify(release(tag))),mode==='changed'&&reads>1?'b'.repeat(40):'a'.repeat(40)));
      }
      if(call.method==='PUT')return json({message:'sensitive conflict body'},400);
      throw new Error('unexpected test request');
    }});
    const p=publication();
    if(['downgrade','auth'].includes(mode))await assert.rejects(transport.channelPromotion.check(p),/downgrade|HTTP 401/i);
    else {await transport.channelPromotion.check(p);await assert.rejects(transport.channelPromotion.promote(p.pointer,p),/conflict|HTTP 400/i);}
    assert.equal(calls.filter(call=>call.method==='PUT').length,mode==='cas'?1:0);
    assert.equal(calls.some(call=>call.method==='POST'&&call.url===fileApi),false);
  }
});

test('same target version with different sealed bytes is a conflict and public readback must match',async t=>{
  const first=fixture(t,{route:()=>json(metadata(Buffer.from(JSON.stringify({...release('v2.4.5'),body:'different'}))))});
  await assert.rejects(first.transport.channelPromotion.check(first.publication()),/same|conflict|identity/i);
  const second=fixture(t,{route:()=>new Response('wrong')});const p=second.publication();
  await assert.rejects(second.transport.channelPromotion.verify(p.pointer,p),/size|SHA|sha|different|incomplete/i);
});

test('absolute deadlines cover ignored aborts and stalled body reads; JSON and payload sizes are bounded',async t=>{
  const headers=fixture(t,{route:()=>new Promise(()=>{}),options:{totalTimeout:15}});
  await assert.rejects(headers.transport.readPublic('releases/v2.4.5/asset.zip'),/deadline|timeout/i);
  const stalled=fixture(t,{route:()=>new Response(new ReadableStream({start(){}})),options:{totalTimeout:15}});
  await assert.rejects(stalled.transport.verifyObject(stalled.object(Buffer.from('asset'))),/deadline|timeout/i);
  const oversized=fixture(t,{route:()=>new Response('too-long')});
  await assert.rejects(oversized.transport.verifyObject(oversized.object(Buffer.from('asset'))),/large|size/i);
  const jsonBound=fixture(t,{policyValue:{...policy(),padding:'x'.repeat(4096)},options:{maxJsonBytes:1024}});
  await assert.rejects(jsonBound.transport.preflight(),/large|limit/i);
});

test('response cleanup cannot keep a failed API request pending after its deadline',async t=>{
  const {transport}=fixture(t,{options:{totalTimeout:15,fetcher:async()=>new Response(new ReadableStream({
    cancel:()=>new Promise(()=>{}),
  }),{status:401})}});
  const outcome=await Promise.race([transport.preflight().then(()=>({ok:true}),error=>({error})),
    new Promise(resolve=>setTimeout(()=>resolve({pending:true}),75))]);
  assert.equal(outcome.pending,undefined,'unsettled cleanup exceeded the absolute budget');
  assert.match(outcome.error.message,/HTTP 401/);
});

test('malformed server metadata never exposes its body or a reflected credential in errors',async t=>{
  const {transport,publication}=fixture(t,{route:()=>json({...metadata(Buffer.from(JSON.stringify(release('v2.4.4')))),
    last_commit_id:'test-secret-token'})});
  await assert.rejects(transport.channelPromotion.check(publication()),error=>
    !error.message.includes('test-secret-token')&&!JSON.stringify(error).includes('test-secret-token'));
});

test('explicit inventory policy supports a personal namespace and adopts only unique matching files',async t=>{
  const {transport,calls,object,server}=inventoryFixture(t);
  const asset=object(Buffer.from('asset'));await transport.preflight();await transport.upload(asset,{immutable:true});
  assert.equal(await transport.verifyIdentity(asset),'matching');assert.equal(server.writes,0);
  assert.equal(calls.some(call=>call.url==='https://jihulab.com/api/graphql'),false);
  for(const status of ['default','hidden','processing','error','pending_destruction','deprecated'])
    assert.ok(calls.some(call=>new URL(call.url).searchParams.get('status')===status));
});

test('inventory unknown fields, duplicate files/packages, wrong SHA, and processing states block adoption and writes',async t=>{
  const bytes=Buffer.from('asset');
  const scenarios=[{files:[inventoryFile(bytes),inventoryFile(bytes,'asset.zip',902)]},
    {files:[{...inventoryFile(bytes),file_sha256:null}]},
    {files:[{...inventoryFile(bytes),file_name:null}]},
    {files:[{...inventoryFile(bytes),file_sha256:hash('wrong')}]},
    {packages:[packageRecord,{...packageRecord,id:902}]},
    {packages:[{...packageRecord,status:'processing'}]}];
  for(const scenario of scenarios) {
    const {transport,object,server}=inventoryFixture(t,scenario);
    await assert.rejects(transport.upload(object(bytes),{immutable:true}),/inventory|identity|duplicate|SHA|processing/i);
    assert.equal(server.writes,0);
  }
});

test('inventory missing objects are created once and ambiguous uploads require both unique inventory and full public SHA',async t=>{
  for(const outcome of ['success','committed-error','duplicate','wrong-public']) {
    const {transport,object,server}=inventoryFixture(t,{files:[],packages:[],afterWrite:value=>{
      if(outcome==='duplicate')value.files.push(inventoryFile(value.bytes,'asset.zip',902));
      if(outcome==='wrong-public')value.bytes=Buffer.from('wrong');
      if(outcome==='committed-error')throw new Error('ambiguous response');
    }});
    const operation=transport.upload(object(Buffer.from('asset')),{immutable:true});
    if(['success','committed-error'].includes(outcome))await operation;
    else await assert.rejects(operation,/inventory|duplicate|SHA|different/i);
    assert.equal(server.writes,1,'ambiguous responses must never cause a second PUT');
  }
});

test('an unresolved upload cannot be PUT again by the same publisher instance',async t=>{
  const {transport,object,server}=inventoryFixture(t,{files:[],packages:[],afterWrite:value=>{
    value.files=[];value.packages=[];throw new Error('unknown commit outcome');
  }});
  const asset=object(Buffer.from('asset'));
  await assert.rejects(transport.upload(asset,{immutable:true}),/missing|inventory/i);
  await assert.rejects(transport.upload(asset,{immutable:true}),/attempt|unresolved|missing|inventory/i);
  assert.equal(server.writes,1,'an ambiguous creation must remain blocked rather than re-PUT');
});

test('durable intent callback runs only immediately before a missing object PUT and failure prevents IO',async t=>{
  for(const mode of ['missing','matching','persistence-failed']) {
    let intents=0;
    const {transport,object,server}=inventoryFixture(t,{files:mode==='matching'?[inventoryFile(Buffer.from('asset'))]:[],
      packages:mode==='matching'?[packageRecord]:[],onRequest:call=>{
        if(call.method==='PUT')assert.equal(intents,1,'intent must be durable before the PUT starts');
      }});
    const operation=transport.upload(object(Buffer.from('asset')),{immutable:true,onUploadAttempt:async()=>{
      intents++;if(mode==='persistence-failed')throw Error('intent persistence failed');
    }});
    if(mode==='persistence-failed')await assert.rejects(operation,/intent persistence failed/);else await operation;
    assert.equal(intents,mode==='matching'?0:1);assert.equal(server.writes,mode==='missing'?1:0);
  }
  let intents=0;const blocked=fixture(t,{policyValue:policy(true)});
  await assert.rejects(blocked.transport.upload(blocked.object(Buffer.from('asset')),{immutable:true,onUploadAttempt:async()=>{intents++;}}),/policy|duplicate/);
  assert.equal(intents,0,'preflight failure must not invent a PUT attempt');
});

test('inventory scans every package/file page and rejects incomplete or unbounded pagination',async t=>{
  for(const mode of ['second-page-duplicate','endless','malformed','matching','bad-next-page']) {
    const {object}=fixture(t);const pages=[];
    const fetcher=async(url,settings)=>{
      const value=new URL(url),page=Number(value.searchParams.get('page'));
      pages.push([value.pathname,value.searchParams.get('status'),page]);
      if(value.pathname===new URL(api).pathname+'/packages') {
        if(value.searchParams.get('status')!=='default')return json([],200,{'x-next-page':''});
        if(mode==='malformed')return json([{}],200,{'x-next-page':''});
        if(mode==='endless')return json([{...packageRecord,id:900+page,name:'nora-tavern-extra'}],200,{'x-next-page':String(page+1)});
        if(mode==='bad-next-page')return json([packageRecord],200,{'x-next-page':'https://evil.example/next'});
        return json([page===1?{...packageRecord,id:910,name:'nora-tavern-extra'}:packageRecord],200,{'x-next-page':page===1?'2':''});
      }
      if(value.pathname.endsWith('/package_files')) {
        const file=page===1?inventoryFile(Buffer.from('asset')):inventoryFile(Buffer.from('asset'),mode==='matching'?'another.zip':'asset.zip',902);
        return json([file],200,{'x-next-page':page===1?'2':''});
      }
      return json(project);
    };
    const bounded=createJihuTransport(inventoryConfig,{source,privateToken:'test-token',fetcher,log:()=>{},maxInventoryPages:2});
    if(mode==='matching')assert.equal(await bounded.verifyIdentity(object(Buffer.from('asset'))),'matching');
    else await assert.rejects(bounded.verifyIdentity(object(Buffer.from('asset'))),/pagination|inventory|limit|duplicate/i);
    if(['matching','second-page-duplicate'].includes(mode))assert.ok(pages.some(([pathname,,page])=>pathname.endsWith('/package_files')&&page===2));
  }
});

test('inventory compares exact package identity and never infers a missing file from malformed metadata',async t=>{
  for(const row of [{...packageRecord,name:'nora-tavern-extra'},{...packageRecord,version:'v2.4.6'},
    {...packageRecord,package_type:'npm'}]) {
    const {transport,object}=inventoryFixture(t,{packages:[row],files:[]});
    assert.equal(await transport.verifyIdentity(object(Buffer.from('asset')),{allowMissing:true}),'missing');
  }
  for(const changed of [{id:null},{package_id:null},{size:null},{size:0},{file_sha256:''}]) {
    const {transport,object,server}=inventoryFixture(t,{files:[{...inventoryFile(Buffer.from('asset')),...changed}]});
    await assert.rejects(transport.upload(object(Buffer.from('asset')),{immutable:true}),/inventory/i);assert.equal(server.writes,0);
  }
});

test('83-file readiness reads one complete inventory, all public HEADs, and the catalogue bytes per phase',async t=>{
  const content=new Map();
  const f=inventoryFixture(t,{extraRoute:call=>{
    const bytes=content.get(call.url);
    if(bytes)return new Response(call.method==='HEAD'?null:bytes,{headers:{'content-length':String(bytes.length)}});
  }});
  const p=f.publication(),objects=[];
  for(let index=0;index<83;index++) {
    const name=index===82?'release.json':`asset-${index}.zip`,bytes=Buffer.from(`sealed-${index}`);
    const object=f.object(bytes,`releases/v2.4.5/${name}`,index===82?'catalogue':'asset');
    objects.push(object);content.set(source.baseUrl+`v2.4.5/${name}`,bytes);
  }
  f.server.files=objects.map((object,index)=>inventoryFile(content.get(source.baseUrl+object.key.replace(/^releases\//,'')),
    path.basename(object.key),901+index));
  p.plan.objects.unshift(...objects);p.state={sources:{jihulab:{objects:Object.fromEntries(objects.map(object=>[object.key,
    {size:object.size,sha256:object.sha256,verifiedAt:'2026-10-19T00:00:00.000Z'}]))}}};
  const provider=jihulabProvider({...f.transport,fetcher:f.fetcher,log:()=>{}});
  await provider.assertReady(p);
  const counts=()=>({packages:f.calls.filter(call=>new URL(call.url).pathname===new URL(api).pathname+'/packages').length,
    files:f.calls.filter(call=>new URL(call.url).pathname.endsWith('/package_files')).length,
    heads:f.calls.filter(call=>call.method==='HEAD').length,
    catalogueGets:f.calls.filter(call=>call.url===source.baseUrl+'v2.4.5/release.json'&&call.method==='GET').length});
  assert.deepEqual(counts(),{packages:6,files:1,heads:83,catalogueGets:1});
  assert.equal(f.calls.length,91,'one-page readiness must not repeat the seven-request inventory for every object');
  f.server.files[0]={...f.server.files[0],file_sha256:hash('changed-after-readiness')};
  await assert.rejects(provider.assertReady(p),/SHA/);
  assert.deepEqual(counts(),{packages:12,files:2,heads:166,catalogueGets:1},'no inventory may survive into a later readiness phase');
  f.server.files[0]={...f.server.files[0],file_sha256:objects[0].sha256};
  const before=f.calls.length;
  const perObject=jihulabProvider({...f.transport,verifyPreparedIdentities:undefined,fetcher:f.fetcher,log:()=>{}});
  await perObject.assertReady(p);
  const previousCalls=f.calls.slice(before);
  assert.equal(previousCalls.filter(call=>new URL(call.url).pathname===new URL(api).pathname+'/packages'
    ||new URL(call.url).pathname.endsWith('/package_files')).length,581);
  assert.equal(previousCalls.length,665,'the per-object compatibility path provides the measured comparison');
  // Compare complete prepare through the original per-object seam as well.
  f.calls.length=0;
  await perObject.begin(p);
  for(const object of objects)assert.equal(await perObject.inspect(object,p.state.sources.jihulab.objects[object.key],p),'matching');
  assert.deepEqual(counts(),{packages:498,files:83,heads:83,catalogueGets:0});
  assert.equal(f.calls.length,666);
  // Exercise the same complete resumed prepare through the batch seam.
  f.calls.length=0;
  await provider.begin(p);
  for(const object of objects)assert.equal(await provider.inspect(object,p.state.sources.jihulab.objects[object.key],p),'matching');
  assert.deepEqual(counts(),{packages:6,files:1,heads:83,catalogueGets:0});
  assert.equal(f.calls.length,92,'83 public HEADs, one seven-request inventory and two project preflight reads');
  assert.equal(f.calls.some(call=>!['GET','HEAD'].includes(call.method||'GET')),false,'complete resume performs no write');
  await provider.assertReady(p);
  assert.deepEqual(counts(),{packages:12,files:2,heads:166,catalogueGets:1},'readiness obtains another fresh inventory');
  assert.equal(f.server.writes,0);
});

test('batch readiness rejects missing, duplicate, changed, unavailable, and unexpected inventory objects',async t=>{
  const bytes=Buffer.from('asset');
  const cases=[{files:[]},{files:[inventoryFile(bytes),inventoryFile(bytes,'asset.zip',902)]},
    {files:[{...inventoryFile(bytes),file_sha256:hash('changed')}]},
    {files:[{...inventoryFile(bytes),size:bytes.length+1}]},
    {packages:[{...packageRecord,status:'processing'}]},
    {packages:[packageRecord,{...packageRecord,id:902}]},
    {files:[inventoryFile(bytes),inventoryFile(bytes,'unexpected.zip',902)]}];
  for(const scenario of cases) {
    const f=inventoryFixture(t,scenario),p=f.publication();p.plan.objects.unshift(f.object(bytes));
    await assert.rejects(f.transport.verifyPreparedIdentities(p),/missing|duplicate|SHA|unavailable|closure|inventory/i);
    assert.ok(f.calls.every(call=>(call.method||'GET')==='GET'),'inventory validation must never write');
  }
});

test('batch inventory is grouped by source version and refreshed for referenced historical assets too',async t=>{
  const current=Buffer.from('current'),old=Buffer.from('previous');let oldFiles=[{...inventoryFile(old),package_id:910}];
  const f=fixture(t,{configValue:inventoryConfig,route:call=>{
    const url=new URL(call.url);
    if(url.pathname===new URL(api).pathname+'/packages')return json(url.searchParams.get('status')==='default'
      ?[{...packageRecord,...(url.searchParams.get('package_version')==='v2.4.4'?{id:910,version:'v2.4.4'}:{})}]:[],200,{'x-next-page':''});
    if(url.pathname.endsWith('/packages/900/package_files'))return json([inventoryFile(current)],200,{'x-next-page':''});
    if(url.pathname.endsWith('/packages/910/package_files'))return json(oldFiles,200,{'x-next-page':''});
    return new Response(null,{status:404});
  }});
  const p=f.publication();p.plan.objects.unshift(f.object(current),{...f.object(old,'releases/v2.4.4/asset.zip'),reference:true});
  await f.transport.verifyPreparedIdentities(p);assert.equal(f.calls.length,14);
  oldFiles=[{...oldFiles[0],file_sha256:hash('historical-asset-changed')}];
  await assert.rejects(f.transport.verifyPreparedIdentities(p),/SHA/);assert.equal(f.calls.length,28);
});

test('channel check and promotion recheck inventory closure and block changed identities before CAS',async t=>{
  let current=Buffer.from(JSON.stringify(release('v2.4.4'))+'\n');
  const {transport,object,publication,server,calls}=inventoryFixture(t,{extraRoute:call=>{
    if(call.url===fileApi+'?ref=main')return json(metadata(current));
    if(call.url===publicChannel)return new Response(current);
    if(call.method==='PUT'&&call.url===fileApi){current=Buffer.from(JSON.parse(call.body).content,'base64');return json({file_path:'channels/stable.json',branch:'main'});}
  }});
  const p=publication(),asset=object(Buffer.from('asset'));p.plan.objects.unshift(asset);
  await transport.channelPromotion.check(p);
  server.files[0]={...server.files[0],file_sha256:hash('wrong')};
  await assert.rejects(transport.channelPromotion.promote(p.pointer,p),/SHA|identity|inventory/i);
  assert.equal(calls.some(call=>call.url===fileApi&&call.method==='PUT'),false);
  server.files[0]=inventoryFile(Buffer.from('asset'));
  server.files.push(inventoryFile(Buffer.from('other'),'unexpected.zip',903));
  await assert.rejects(transport.channelPromotion.check(p),/closure|unexpected|inventory/i);
});

test('Jihu inventory GET recovers from transient 503 without repeating a write',async t=>{
    let reads=0;const f=fixture(t,{configValue:inventoryConfig,route:call=>{
        const url=new URL(call.url);
        if(url.pathname===new URL(api).pathname+'/packages'){
            if(++reads<=2)return json({},503);
            return json(url.searchParams.get('status')==='default'?[packageRecord]:[],200,{'x-next-page':''});
        }
        if(url.pathname===new URL(api).pathname+'/packages/900/package_files')return json([inventoryFile(Buffer.from('asset'))],200,{'x-next-page':''});
        return new Response(null,{status:404});
    }});
    assert.equal(await f.transport.verifyIdentity(f.object(Buffer.from('asset'))),'matching');
    assert.equal(reads,8);assert.ok(f.calls.every(call=>(call.method||'GET')==='GET'));
});
test('Jihu inventory GET retries are bounded when 503 persists',async t=>{
    let reads=0;const f=fixture(t,{configValue:inventoryConfig,route:call=>{
        if(new URL(call.url).pathname===new URL(api).pathname+'/packages'){reads++;return json({},503);}
        return new Response(null,{status:404});
    }});
    await assert.rejects(f.transport.verifyIdentity(f.object(Buffer.from('asset'))),/HTTP 503/);
    assert.equal(reads,4);assert.ok(f.calls.every(call=>(call.method||'GET')==='GET'));
});

test('Jihu HTTP 503 on an immutable PUT is never automatically replayed',async t=>{
    const f=fixture(t,{route:call=>call.method==='PUT'?json({},503):new Response(null,{status:404})});
    const asset=f.object(Buffer.from('asset'));
    await assert.rejects(f.transport.upload(asset,{immutable:true}),/503/);
    assert.equal(f.calls.filter(call=>call.method==='PUT').length,1);
});

test('APP-only channel CAS never overwrites the normal stable core anchor and verifies its fixed source',async t=>{
  const anchor={tag:'v2.4.4',commit:'c'.repeat(40)},core=Buffer.from(JSON.stringify({schema:'tavern-release/v2',commit:anchor.commit,versions:{tavern:'2.4.4'}}));
  const coreHead={...release(anchor.tag),assets:[{name:'release-manifest.json',state:'uploaded',size:core.length,digest:'sha256:'+hash(core),
    browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${anchor.tag}/release-manifest.json`}]};
  const key='channels/launcher-stable.json',url=api+'/repository/files/'+encodeURIComponent(key);let published;
  const f=fixture(t,{route:call=>{
    if(call.url===publicChannel)return new Response(JSON.stringify(coreHead));
    if(call.url===source.baseUrl+anchor.tag+'/release-manifest.json')return new Response(core);
    if(call.url===url+'?ref=main')return published?json({...metadata(published),file_path:key}):json({message:'missing'},404);
    if(call.url===url&&call.method==='POST'){const body=JSON.parse(call.body);published=Buffer.from(body.content,'base64');return json({file_path:key,branch:'main'},201);}
    if(call.url===source.channelBaseUrl+key)return published?new Response(published):new Response(null,{status:404});
    return new Response(null,{status:404});
  }});
  const bytes=Buffer.from(JSON.stringify([release('v2.4.5')])+'\n'),pointer=f.object(bytes,key,'channel');
  const p={plan:{tag:'v2.4.5',channel:'stable',coreAnchor:anchor,objects:[pointer]}};
  await f.transport.preflight();await f.transport.channelPromotion.check(p);
  await f.transport.channelPromotion.promote(pointer,p);await f.transport.channelPromotion.verify(pointer,p);
  assert.deepEqual(published,bytes);assert.equal(f.calls.some(c=>c.url===fileApi&&['POST','PUT'].includes(c.method)),false);
  coreHead.tag_name='v2.4.3';await assert.rejects(f.transport.channelPromotion.check(p),/anchor/i);
});

test('ordinary stable advances both sealed pointers in one repository commit and resumes a committed response loss',async t=>{
  const coreKey='channels/stable.json',appKey='channels/launcher-stable.json',commits=api+'/repository/commits';
  const current=new Map([[coreKey,{bytes:Buffer.from(JSON.stringify(release('v2.4.4'))+'\n'),commit:'a'.repeat(40)}]]);
  let loseResponse=true;
  const f=fixture(t,{route:call=>{
    const url=new URL(call.url),prefix=api+'/repository/files/';
    if(call.url.startsWith(prefix)&&url.search==='?ref=main'){
      const key=decodeURIComponent(url.pathname.split('/').pop()),value=current.get(key);
      return value?json({...metadata(value.bytes,value.commit),file_path:key}):json({},404);
    }
    if(call.url===commits&&call.method==='POST'){
      const body=JSON.parse(call.body);assert.equal(body.branch,'main');
      assert.deepEqual(body.actions.map(action=>action.file_path),[coreKey,appKey]);
      for(const action of body.actions){
        const previous=current.get(action.file_path);assert.equal(action.action,previous?'update':'create');
        assert.equal(action.last_commit_id,previous?.commit);assert.equal(action.encoding,'base64');
      }
      for(const action of body.actions)current.set(action.file_path,{bytes:Buffer.from(action.content,'base64'),commit:'b'.repeat(40)});
      if(loseResponse){loseResponse=false;throw Error('Response lost after atomic commit');}
      return json({id:'b'.repeat(40)},201);
    }
    if(call.url.startsWith(source.channelBaseUrl)){
      const value=current.get(call.url.slice(source.channelBaseUrl.length));return value?new Response(value.bytes):new Response(null,{status:404});
    }
    throw Error('Unexpected channel request');
  }});
  const p=f.publication(),app=f.object(Buffer.from(JSON.stringify([release(p.plan.tag)])+'\n'),appKey,'channel');
  p.plan.objects.push(app);
  await f.transport.channelPromotion.check(p);
  await assert.rejects(f.transport.channelPromotion.promote(p.pointer,p),/request failed/);
  for(const object of p.plan.objects)assert.equal(hash(current.get(object.key).bytes),object.sha256);
  await f.transport.channelPromotion.check(p);
  await f.transport.channelPromotion.promote(p.pointer,p);await f.transport.channelPromotion.verify(p.pointer,p);
  assert.equal(f.calls.filter(call=>call.url===commits&&call.method==='POST').length,1,'Resume must adopt both already committed bytes');
  assert.equal(f.calls.some(call=>call.url.startsWith(api+'/repository/files/')&&['POST','PUT'].includes(call.method)),false);
  current.set(appKey,{...current.get(appKey),bytes:Buffer.from('wrong')});
  await assert.rejects(f.transport.channelPromotion.verify(p.pointer,p),/size|SHA|different|incomplete/i);
});

test('either stable pointer CAS conflict or changed sealed bytes rejects the entire pair',async t=>{
  const keys=['channels/stable.json','channels/launcher-stable.json'];
  for(const kind of ['core changed','APP changed','APP created','core commit race','APP commit race','core bytes changed','APP bytes changed','sealed pointer removed'])await t.test(kind,async t=>{
    const current=new Map(keys.map((key,index)=>[key,{bytes:Buffer.from(JSON.stringify(index?[release('v2.4.4')]:release('v2.4.4'))),commit:'a'.repeat(40)}]));
    if(kind==='APP created')current.delete(keys[1]);
    const f=fixture(t,{route:call=>{
      if(call.url.startsWith(api+'/repository/files/')&&call.url.endsWith('?ref=main')){
        const key=decodeURIComponent(new URL(call.url).pathname.split('/').pop()),value=current.get(key);
        return value?json({...metadata(value.bytes,value.commit),file_path:key}):json({},404);
      }
      if(call.url===api+'/repository/commits'&&call.method==='POST'){
        const actions=JSON.parse(call.body).actions,key=kind==='core commit race'?keys[0]:keys[1];
        current.get(key).commit='c'.repeat(40);
        assert.equal(actions.length,2);
        assert.ok(actions.some(action=>action.last_commit_id!==current.get(action.file_path)?.commit));
        return json({},400); // The repository rejects all actions atomically.
      }
      throw Error('Unexpected request before a rejected promotion');
    }});
    const p=f.publication(),app=f.object(Buffer.from(JSON.stringify([release(p.plan.tag)])+'\n'),keys[1],'channel');p.plan.objects.push(app);
    await f.transport.channelPromotion.check(p);
    if(kind==='core changed')current.get(keys[0]).commit='b'.repeat(40);
    if(kind==='APP changed')current.get(keys[1]).commit='b'.repeat(40);
    if(kind==='APP created')current.set(keys[1],{bytes:Buffer.from(JSON.stringify([release('v2.4.4')])),commit:'b'.repeat(40)});
    if(kind==='core bytes changed')fs.appendFileSync(p.pointer.file,' ');
    if(kind==='APP bytes changed')fs.appendFileSync(app.file,' ');
    if(kind==='sealed pointer removed')p.plan.objects.pop();
    const before=new Map([...current].map(([key,value])=>[key,hash(value.bytes)]));
    await assert.rejects(f.transport.channelPromotion.promote(p.pointer,p),/conflict|HTTP 400|sealed|snapshot|size|SHA/i);
    assert.deepEqual(new Map([...current].map(([key,value])=>[key,hash(value.bytes)])),before);
    assert.equal(f.calls.filter(call=>call.method==='POST'&&call.url===api+'/repository/commits').length,kind.includes('commit race')?1:0);
    assert.equal(f.calls.some(call=>['PUT','POST'].includes(call.method)&&call.url.startsWith(api+'/repository/files/')),false);
  });
});

test('a malformed atomic commit receipt cannot reflect credentials in the thrown diagnostic',async t=>{
  const f=fixture(t,{route:call=>call.url===api+'/repository/commits'&&call.method==='POST'
    ?json({id:'test-secret-token'},201):json({},404)});
  const p=f.publication();p.plan.objects.push(f.object(Buffer.from(JSON.stringify([release(p.plan.tag)])),
    'channels/launcher-stable.json','channel'));
  await f.transport.channelPromotion.check(p);
  await assert.rejects(f.transport.channelPromotion.promote(p.pointer,p),error=>
    /Invalid JihuLab channel commit receipt/.test(error.message)&&!JSON.stringify(error).includes('test-secret-token'));
});
