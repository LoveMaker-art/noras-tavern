import assert from 'node:assert/strict';
import {test} from 'node:test';
import {jihulabProvider} from '../tooling/release/jihulab-provider.mjs';

const asset={key:'releases/v2.4.5/asset.zip',phase:'asset',size:10,sha256:'a'.repeat(64)};
const catalogue={key:'releases/v2.4.5/release.json',phase:'catalogue',size:20,sha256:'b'.repeat(64)};
const channel={key:'channels/stable.json',phase:'channel',size:20,sha256:'b'.repeat(64)};
const receipt=object=>({size:object.size,sha256:object.sha256,verifiedAt:'2026-10-13T00:00:00.000Z'});
const publication=()=>({plan:{tag:'v2.4.5',channel:'stable',objects:[asset,catalogue,channel]},
  state:{sources:{jihulab:{objects:{}}}}});
function fixture(overrides={}) {
  const calls=[];
  const provider=jihulabProvider({readPublic:async(key,fetcher,timeout,options)=>{
    calls.push(['head',key,options.method]);return new Response(null,{headers:{'content-length':String(key===asset.key?10:20)}});
  },verifyObject:async object=>{calls.push(['verify',object.key]);},
  upload:async(object,options)=>{calls.push(['upload',object.key,options]);},
  channelPromotion:{check:async()=>{calls.push(['check']);},promote:async object=>{calls.push(['cas',object.key]);},
    verify:async object=>{calls.push(['verify-channel',object.key]);}},log:()=>{},...overrides});
  return {provider,calls};
}

test('JihuLab adopts existing immutable files with full-byte verification and uploads without generic channel replacement',async()=>{
  const {provider,calls}=fixture(),p=publication();await provider.begin(p);
  assert.equal(await provider.inspect(asset,null,p),'matching');
  await provider.upload(catalogue,p);await provider.verify(catalogue,p);
  assert.deepEqual(calls,[['head',asset.key,'HEAD'],['verify',asset.key],
    ['upload',catalogue.key,{immutable:true}],['verify',catalogue.key]]);
  await assert.rejects(provider.upload(channel,p),/immutable|channel/i);
  assert.equal(calls.length,4);
});

test('resumed preparation rechecks immutable availability and delegates channel promotion only to CAS',async()=>{
  const {provider,calls}=fixture(),p=publication();
  for(const object of [asset,catalogue])p.state.sources.jihulab.objects[object.key]=receipt(object);
  await provider.assertReady(p);await provider.checkPromotion(p);await provider.promote(p);await provider.verifyPromotion(p);
  assert.deepEqual(calls,[['head',asset.key,'HEAD'],['head',catalogue.key,'HEAD'],['verify',catalogue.key],
    ['check'],['cas',channel.key],['verify-channel',channel.key]]);
});

test('only a receipt bound to the same sealed bytes can skip adopting the full immutable file',async()=>{
  const {provider,calls}=fixture(),p=publication();
  assert.equal(await provider.inspect(asset,receipt(asset),p),'matching');
  assert.deepEqual(calls,[['head',asset.key,'HEAD']]);
  for(const invalid of [{...receipt(asset),size:11},{...receipt(asset),sha256:'c'.repeat(64)},
    {...receipt(asset),verifiedAt:'unverified'}]) {
    await assert.rejects(provider.inspect(asset,invalid,p),/receipt/i);
    p.state.sources.jihulab.objects[asset.key]=invalid;
    await assert.rejects(provider.assertReady(p),/receipt/i);
  }
  assert.equal(calls.length,1,'invalid receipt must fail before further network IO');
});

test('an immutable file disappearing after inspection blocks readiness and never reaches CAS',async()=>{
  let available=true;const {provider,calls}=fixture({readPublic:async key=>key===catalogue.key
    ?new Response(null,{headers:{'content-length':'20'}}):available
      ?new Response(null,{headers:{'content-length':'10'}}):new Response(null,{status:404})}),p=publication();
  assert.equal(await provider.inspect(asset,receipt(asset),p),'matching');
  for(const object of [asset,catalogue])p.state.sources.jihulab.objects[object.key]=receipt(object);
  available=false;await assert.rejects(provider.assertReady(p),/disappeared/i);
  assert.deepEqual(calls,[]);
});

test('only actual absence can lead to an immutable upload; permissions or wrong size fail closed',async()=>{
  for(const status of [404,410]) {
    const {provider,calls}=fixture({readPublic:async()=>new Response(null,{status})});
    assert.equal(await provider.inspect(asset,null,publication()),'missing');assert.deepEqual(calls,[]);
  }
  for(const status of [204,206,401,403,429,500]) {
    const {provider,calls}=fixture({readPublic:async()=>new Response(null,{status,headers:{'content-length':'10'}})});
    await assert.rejects(provider.inspect(asset,null,publication()),/Cannot inspect JihuLab/);assert.deepEqual(calls,[]);
  }
  for(const length of [null,'11','invalid','9007199254740992']) {
    let cancelled=0;const {provider,calls}=fixture({readPublic:async()=>({status:200,
      headers:new Headers(length===null?{}:{'content-length':length}),body:{cancel:async()=>{cancelled++;}}})});
    await assert.rejects(provider.inspect(asset,null,publication()),/size is unavailable or different/);
    assert.deepEqual(calls,[]);assert.equal(cancelled,1);
  }
});

test('CAS conflict propagates without a generic channel upload or a promoted checkpoint',async()=>{
  const calls=[],p=publication();p.state.sources.jihulab.promoted=false;
  const {provider}=fixture({upload:async()=>{calls.push('generic-upload');},channelPromotion:{check:async()=>{},
    promote:async()=>{calls.push('cas-conflict');throw new Error('channel compare-and-swap conflict');},verify:async()=>{calls.push('verify');}}});
  await assert.rejects(provider.promote(p),/compare-and-swap conflict/);
  assert.deepEqual(calls,['cas-conflict']);assert.equal(p.state.sources.jihulab.promoted,false);
  const bad=publication();bad.plan.objects=[asset,catalogue,{...channel,key:'channels/beta.json'}];
  await assert.rejects(provider.promote(bad),/Different JihuLab channel/);
  assert.deepEqual(calls,['cas-conflict']);
});

test('a missing CAS implementation fails before inspecting or uploading any release file',()=>{
  assert.throws(()=>fixture({channelPromotion:{check:async()=>{},verify:async()=>{}}}),/Missing JihuLab channel CAS promote/);
  assert.throws(()=>fixture({upload:undefined}),/Missing JihuLab upload/);
});

test('production preflight runs at begin and a bound receipt cannot hide a changed inventory SHA',async()=>{
  let identity='matching';const observed=[];
  const {provider,calls}=fixture({preflight:async()=>{observed.push('preflight');},verifyIdentity:async object=>{
    observed.push(object.key);if(identity!=='matching')throw new Error('inventory SHA changed');return identity;
  }});
  const p=publication();await provider.begin(p);assert.deepEqual(observed,['preflight']);
  assert.equal(await provider.inspect(asset,receipt(asset),p),'matching');
  identity='changed';await assert.rejects(provider.inspect(asset,receipt(asset),p),/inventory SHA/);
  for(const object of [asset,catalogue])p.state.sources.jihulab.objects[object.key]=receipt(object);
  await assert.rejects(provider.assertReady(p),/inventory SHA/);
  assert.equal(calls.some(call=>call[0]==='cas'),false);
});

test('missing public bytes cannot be uploaded when inventory still has a record',async()=>{
  const {provider}=fixture({readPublic:async()=>new Response(null,{status:404}),verifyIdentity:async()=> 'matching'});
  await assert.rejects(provider.inspect(asset,null,publication()),/inventory|public|identity/i);
});

test('an unresolved persisted upload requires full SHA again even when a receipt exists',async()=>{
  const {provider,calls}=fixture({verifyIdentity:async()=> 'matching'}),p=publication();
  p.state.sources.jihulab.uploadIntents={[asset.key]:{size:asset.size,sha256:asset.sha256,attemptedAt:'2026-10-13T00:00:00.000Z'}};
  assert.equal(await provider.inspect(asset,receipt(asset),p),'matching');
  assert.deepEqual(calls,[['head',asset.key,'HEAD'],['verify',asset.key]]);
});

test('the provider forwards durable intent recording to the actual transport PUT seam',async()=>{
  const records=[],p=publication();p.recordJihuUploadIntent=object=>records.push(object.key);
  const {provider}=fixture({upload:async(object,options)=>{assert.equal(records.length,0);await options.onUploadAttempt();}});
  await provider.upload(asset,p);assert.deepEqual(records,[asset.key]);
});
