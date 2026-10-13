const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const desktop=fs.existsSync(path.resolve(__dirname,'../../launcher/desktop/release-sources.js'))
  ? path.resolve(__dirname,'../../launcher/desktop') : path.resolve(__dirname,'../installer/desktop');
const {sourceCandidates,validateSources,validateSourceResponse,readSource}=require(path.join(desktop,'release-sources'));
const latest='https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest';
const asset='https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.5/asset.zip';
// Test-only project identity. The shipped configuration remains unconfigured.
const jihulab={id:'jihulab',provider:'jihulab',
  baseUrl:'https://jihulab.com/api/v4/projects/42/packages/generic/nora-tavern/',
  channelBaseUrl:'https://jihulab.com/test-owner/nora-tavern/-/raw/release-channels/'};
const configured={schema:1,primary:'jihulab',mirrors:[jihulab]};

test('configured JihuLab uses fixed generic versions and separate raw channel pointers',()=>{
  const channel=sourceCandidates(latest,{sources:configured});
  assert.deepEqual(channel.map(source=>source.id),['jihulab','github']);
  assert.equal(channel[0].url,'https://jihulab.com/test-owner/nora-tavern/-/raw/release-channels/channels/stable.json');
  assert.equal(sourceCandidates(asset,{sources:configured})[0].url,
    'https://jihulab.com/api/v4/projects/42/packages/generic/nora-tavern/v2.4.5/asset.zip');
  assert.equal(sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/tags/v2.4.5',{sources:configured})[0].url,
    'https://jihulab.com/api/v4/projects/42/packages/generic/nora-tavern/v2.4.5/release.json');
});

test('an explicit domestic primary tries GitHub before the extra SourceForge fallback',()=>{
  const sources={...configured,mirrors:[jihulab,{id:'sourceforge',provider:'sourceforge',
    baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]};
  assert.deepEqual(sourceCandidates(asset,{sources}).map(source=>source.id),['jihulab','github','sourceforge']);
  assert.deepEqual(sourceCandidates(latest,{sources}).map(source=>source.id),['jihulab','github','sourceforge']);
});

test('JihuLab beta pointer declares the complete advertised catalogue to stop GitHub pagination',()=>{
  const beta=sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=1',
    {sources:configured,channel:'beta'});
  assert.equal(beta[0].url,'https://jihulab.com/test-owner/nora-tavern/-/raw/release-channels/channels/beta.json');
  assert.equal(beta[0].catalogueComplete,true);
  assert.equal(beta[1].catalogueComplete,undefined);
  assert.equal(sourceCandidates(latest,{sources:configured})[0].catalogueComplete,undefined);
});

test('JihuLab rejects unresolved, noncanonical or expanded roots before any read',()=>{
  const invalid=[
    {...jihulab,baseUrl:'https://gitlab.com/api/v4/projects/42/packages/generic/nora-tavern/'},
    {...jihulab,baseUrl:'https://jihulab.com/api/v4/projects/0/packages/generic/nora-tavern/'},
    {...jihulab,baseUrl:'https://jihulab.com/api/v4/projects/9007199254740992/packages/generic/nora-tavern/'},
    {...jihulab,baseUrl:'https://jihulab.com/api/v4/projects/test-owner%2Fnora-tavern/packages/generic/nora-tavern/'},
    {...jihulab,baseUrl:'https://jihulab.com/api/v4/projects/42/packages/generic/nora-tavern/../nora-tavern/'},
    {...jihulab,baseUrl:jihulab.baseUrl+'?token=secret'},
    {...jihulab,channelBaseUrl:undefined},
    {...jihulab,channelBaseUrl:jihulab.baseUrl},
    {...jihulab,channelBaseUrl:'https://jihulab.com/test-owner/nora-tavern/-/raw/release..channels/'},
    {...jihulab,channelBaseUrl:'https://jihulab.com/test-owner/nora-tavern/-/raw/release-channels.lock/'},
    {...jihulab,channelBaseUrl:'https://jihulab.com/test-owner/nora-tavern/-/raw/release-channels/../release-channels/'},
    {...jihulab,channelBaseUrl:'https://storage.myqcloud.com/raw/'},
    {...jihulab,redirectOrigins:['https://anything.myqcloud.com']},
  ];
  for(const item of invalid)assert.throws(()=>validateSources({schema:1,mirrors:[item]}),
    error=>error.code==='VERIFICATION_FAILED',JSON.stringify(item));
  assert.throws(()=>validateSources({...configured,primary:'unconfigured'}),error=>error.code==='VERIFICATION_FAILED');
  assert.equal(validateSources({schema:1,mirrors:[{...jihulab,
    channelBaseUrl:'https://jihulab.com/test-owner/subgroup/nora-tavern/-/raw/release-channels/'}]}).length,1);
});

test('JihuLab validates every redirect before following it, without an inferred storage wildcard',async()=>{
  const source=sourceCandidates(asset,{sources:configured})[0];
  for(const location of ['https://bucket.cos.ap-shanghai.myqcloud.com/a.zip',
    source.url.replace('/projects/42/','/projects/43/'),source.url.replace('asset.zip','other.zip'),
    source.url.replace('https:','http:'),source.url.replace('https://','https://user:password@'),
    source.url+'#fragment',source.url+'?arbitrary=1']) {
    const calls=[];let cancelled=0;
    await assert.rejects(readSource(async(url,options)=>{
      calls.push(url);assert.equal(options.redirect,'manual');
      return {url,status:302,headers:new Headers({location}),body:{cancel:async()=>{cancelled++;}}};
    },source,source.url,{}),error=>error.code==='VERIFICATION_FAILED',location);
    assert.deepEqual(calls,[source.url]);assert.equal(cancelled,1);
  }
  let calls=0;
  await assert.rejects(readSource(async()=>{calls++;},source,'https://untrusted.example/asset.zip',{}),
    error=>error.code==='VERIFICATION_FAILED');
  assert.equal(calls,0);
  assert.throws(()=>validateSourceResponse(source,{url:source.url.replace('/projects/42/','/projects/43/')}),
    error=>error.code==='VERIFICATION_FAILED');
});

test('a malformed final provider URL is a verification failure and its body is cancelled',async()=>{
  const source=sourceCandidates(asset,{sources:configured})[0];let cancelled=0;
  await assert.rejects(readSource(async()=>({url:'malformed final URL',status:200,headers:new Headers(),
    body:{cancel:async()=>{cancelled++;}}}),source,source.url,{}),error=>error.code==='VERIFICATION_FAILED');
  assert.equal(cancelled,1);
});

test('fixed JihuLab reads retain Range while managed SourceForge redirects drop foreign If-Range',async()=>{
  const source=sourceCandidates(asset,{sources:configured})[0];
  const payload=await readSource(async(url,options)=>{
    assert.equal(url,source.url);assert.equal(options.redirect,'manual');
    const headers=new Headers(options.headers);assert.equal(headers.get('Range'),'bytes=8-');
    assert.equal(headers.get('If-Range'),'"jihulab-validator"');return new Response('ij',{status:206});
  },source,source.url,{headers:{Range:'bytes=8-','If-Range':'"jihulab-validator"'}});
  assert.equal(await payload.text(),'ij');
  const sf=sourceCandidates(asset,{sources:{schema:1,mirrors:[{id:'sourceforge',provider:'sourceforge',
    baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]}})[0],calls=[];
  const response=await readSource(async(url,options)=>{
    const headers=new Headers(options.headers);calls.push({url,range:headers.get('Range'),validator:headers.get('If-Range')});
    return calls.length===1?new Response(null,{status:302,headers:{location:url.replace('downloads.sourceforge.net','pilotfiber.dl.sourceforge.net')}})
      :new Response('ij',{status:206});
  },sf,sf.url,{headers:{Range:'bytes=8-','If-Range':'"sourceforge-canonical-validator"'}});
  assert.equal(await response.text(),'ij');
  assert.deepEqual(calls,[{url:'https://downloads.sourceforge.net/project/nora-tavern/v2.4.5/asset.zip',range:'bytes=8-',validator:'"sourceforge-canonical-validator"'},
    {url:'https://pilotfiber.dl.sourceforge.net/project/nora-tavern/v2.4.5/asset.zip',range:'bytes=8-',validator:null}]);
});

test('schema 1 generic and SourceForge mappings retain their old ordering and fixed paths',()=>{
  const old={schema:1,mirrors:[{id:'generic',baseUrl:'https://mirror.example/nora/'},
    {id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]};
  assert.deepEqual(sourceCandidates(asset,{sources:old}).map(source=>source.url),[
    'https://mirror.example/nora/releases/v2.4.5/asset.zip',
    'https://downloads.sourceforge.net/project/nora-tavern/v2.4.5/asset.zip',asset]);
  assert.deepEqual(sourceCandidates(latest,{sources:{...old,primary:'github'}}).map(source=>source.id),['github','generic','sourceforge']);
  const beta=sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=1',{sources:old,channel:'beta'});
  assert.deepEqual(beta.map(source=>source.catalogueComplete),[true,true,undefined]);
  assert.equal(sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100&page=2',{sources:old,channel:'beta'}).length,1);
});
