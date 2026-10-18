import assert from 'node:assert/strict';
import {publicationChannelObjects} from './system-release.mjs';

function immutableObject(object) {
    assert.ok(object && ['asset','catalogue'].includes(object.phase), 'JihuLab generic upload requires an immutable object, not a channel');
    assert.match(object.key,/^releases\/v\d+\.\d+\.\d+(?:-beta\.\d+)?\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.ok(Number.isSafeInteger(object.size) && object.size>0, 'Invalid JihuLab object size');
    assert.match(object.sha256,/^[a-f0-9]{64}$/);
}
function channelObject(publication) {
    return publicationChannelObjects(publication.plan)[0];
}
function boundReceipt(object,receipt) {
    assert.ok(receipt && receipt.size===object.size && receipt.sha256===object.sha256
        && typeof receipt.verifiedAt==='string' && Number.isFinite(Date.parse(receipt.verifiedAt)),
        `JihuLab receipt differs from the sealed object: ${object.key}`);
}

// The transport enforces the selected sealed-file publication policy. A
// repository-files CAS adapter owns the mutable raw channel pointer.
export function jihulabProvider({upload,readPublic,verifyObject,channelPromotion,preflight,verifyIdentity,fetcher=fetch,log=console.log}={}) {
    for(const [name,implementation] of Object.entries({upload,readPublic,verifyObject}))
        assert.equal(typeof implementation,'function',`Missing JihuLab ${name}`);
    for(const method of ['check','promote','verify'])
        assert.equal(typeof channelPromotion?.[method],'function',`Missing JihuLab channel CAS ${method}`);
    for(const [name,implementation] of Object.entries({preflight,verifyIdentity}))
        if(implementation!==undefined)assert.equal(typeof implementation,'function',`Invalid JihuLab ${name}`);
    const existence=async object=>{
        immutableObject(object);
        const response=await readPublic(object.key,fetcher,120000,{method:'HEAD'});
        try {
            if([404,410].includes(response.status))return false;
            assert.equal(response.status,200,`Cannot inspect JihuLab object: ${object.key} HTTP ${response.status}`);
            const length=response.headers.get('content-length');
            assert.ok(length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length)===object.size,
                `JihuLab object size is unavailable or different: ${object.key}`);
            return true;
        } finally {await response.body?.cancel().catch(()=>{});}
    };
    return {
        async begin(){await preflight?.();},
        async inspect(object,receipt,p){
            immutableObject(object);if(receipt!=null)boundReceipt(object,receipt);
            const exists=await existence(object);
            const identity=await verifyIdentity?.(object,{allowMissing:!exists});
            if(!exists){assert.ok(identity==null||identity==='missing','JihuLab inventory and public object identity disagree');return 'missing';}
            if(!receipt||p?.state?.sources?.jihulab?.uploadIntents?.[object.key]){
                log(`jihulab adopting existing object with full SHA-256 verification: ${object.key}`);await verifyObject(object,{fetcher});}
            return 'matching';
        },
        async upload(object,p){immutableObject(object);assert.ok(!object.reference,'Cannot create a referenced immutable asset');
            await upload(object,{immutable:true,...(typeof p?.recordJihuUploadIntent==='function'
                ?{onUploadAttempt:()=>p.recordJihuUploadIntent(object)}:{})});},
        async verify(object){immutableObject(object);await verifyObject(object,{fetcher});},
        async assertReady(p){
            for(const object of p.plan.objects.filter(item=>item.phase!=='channel')) {
                immutableObject(object);
                boundReceipt(object,p.state.sources?.jihulab?.objects?.[object.key]);
                assert.ok(await existence(object),`Prepared JihuLab object disappeared: ${object.key}`);
                await verifyIdentity?.(object,{publication:p});
            }
            const catalogue=p.plan.objects.filter(object=>object.phase==='catalogue');
            assert.equal(catalogue.length,1,'JihuLab requires one sealed catalogue');
            await verifyObject(catalogue[0],{fetcher});
        },
        async checkPromotion(p){channelObject(p);await channelPromotion.check(p);},
        async promote(p){await channelPromotion.promote(channelObject(p),p);},
        async verifyPromotion(p){await channelPromotion.verify(channelObject(p),p);},
    };
}
