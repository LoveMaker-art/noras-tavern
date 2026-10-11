import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {sealPublication, loadPublication, executePublication as executeWithConsumerGate, fileDigest} from '../tooling/release/publication-state.mjs';

// These fixtures exercise resumable provider state, not launcher acceptance.
// A separate test below invokes the mandatory production consumer gate.
const executePublication = (publication, options={}) => executeWithConsumerGate(publication,
    {...options, verifyConsumers:async()=>({scope:'provider-state-test-fixture'})});

async function fixture(t, {destinations} = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-publication-resume-'));
    t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
    const root = path.join(directory, 'assets'), stateDir = path.join(directory, 'state');
    fs.mkdirSync(root); fs.mkdirSync(stateDir);
    const tag = 'v2.4.4', commit = 'a'.repeat(40), repository = 'LoveMaker-art/noras-tavern';
    const release = {tag_name:tag, body:'Authored summary.', published_at:'2026-10-10T00:00:00Z', draft:false, prerelease:false, assets:[]};
    const objects = [];
    for (const [phase,key,file,body] of [
        ['asset',`releases/${tag}/one.zip`,path.join(root,'one.zip'),'first sealed asset'],
        ['asset',`releases/${tag}/two.zip`,path.join(root,'two.zip'),'second sealed asset'],
        ['catalogue',`releases/${tag}/release.json`,path.join(stateDir,'release.json'),JSON.stringify(release)],
        ['channel','channels/stable.json',path.join(stateDir,'stable.json'),JSON.stringify(release)]]) {
        fs.writeFileSync(file,phase==='asset'?body:JSON.stringify(release)); const object={phase,key,file,...await fileDigest(file)};objects.push(object);
        if(phase==='asset')release.assets.push({name:path.basename(key),state:'uploaded',size:object.size,digest:`sha256:${object.sha256}`,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/${path.basename(key)}`});
    }
    const publication = await sealPublication({plan:{tag,commit,mode:'full',channel:'stable',objects},release},
        {root,stateDir,repository,sourceRun:'123',publisherCommit:'b'.repeat(40),destinations});
    const events=[], remote={github:new Map(),sourceforge:new Map()}; let failure;
    const providers=Object.fromEntries(['sourceforge','github'].map(source=>[source, {
        begin:async()=>events.push(`${source}:begin`),
        inspect:async object=>remote[source].has(object.key)?'matching':'missing',
        upload:async object=>{events.push(`${source}:upload:${object.key}`);if(failure===`${source}:${object.key}`)throw Error('simulated network failure');remote[source].set(object.key,object.sha256);},
        verify:async object=>{assert.equal(remote[source].get(object.key),object.sha256);events.push(`${source}:verify:${object.key}`);},
        assertReady:async p=>{for(const object of p.plan.objects.filter(item=>item.phase!=='channel'&&(source!=='github'||item.phase==='asset')))assert.equal(remote[source].get(object.key),object.sha256);events.push(`${source}:ready`);},
        checkPromotion:async()=>events.push(`${source}:check`),
        promote:async()=>{events.push(`${source}:promote`);if(failure===`${source}:promote`)throw Error('channel switch failure');},
        verifyPromotion:async()=>events.push(`${source}:public-health`)
    }]));
    return {directory,root,stateDir,publication,providers,events,remote,setFailure:value=>{failure=value;},reload:()=>loadPublication({root,stateDir,tag,commit,repository,sourceRun:'123',mode:'full'})};
}

test('seal is portable and performs no remote work; source and publisher commits remain distinct',async t=>{
    const f=await fixture(t);
    await executePublication(f.publication,{stage:'seal'});
    assert.deepEqual(f.events,[]);
    assert.equal(f.publication.state.commit,'a'.repeat(40));
    assert.deepEqual(f.publication.state.publishers,['b'.repeat(40)]);
    const copy=path.join(f.directory,'runner-two');fs.mkdirSync(copy);
    fs.cpSync(f.root,path.join(copy,'assets'),{recursive:true});fs.cpSync(f.stateDir,path.join(copy,'state'),{recursive:true});
    const moved=await loadPublication({root:path.join(copy,'assets'),stateDir:path.join(copy,'state'),tag:'v2.4.4'});
    assert.equal(moved.state.planId,f.publication.state.planId);
    assert.equal(moved.release.published_at,'2026-10-10T00:00:00Z');
});
test('a planted fixed temporary symlink cannot overwrite unrelated data',async t=>{
    const f=await fixture(t),unrelated=path.join(f.directory,'unrelated.txt');fs.writeFileSync(unrelated,'retain this user data');
    fs.symlinkSync(unrelated,path.join(f.stateDir,'publication-state.json.tmp'));
    await executePublication(f.publication,{stage:'seal'});
    assert.equal(fs.readFileSync(unrelated,'utf8'),'retain this user data');
    assert.ok(fs.lstatSync(path.join(f.stateDir,'publication-state.json')).isFile());
});
test('GitHub failure cannot publish either channel; resume retains existing bytes and catalogue timestamp',async t=>{
    const f=await fixture(t);const failed='releases/v2.4.4/two.zip';f.setFailure(`github:${failed}`);
    await assert.rejects(executePublication(f.publication,{stage:'all',providers:f.providers,log:()=>{}}),/preparation failed/);
    assert.ok(!f.events.some(value=>value.endsWith(':promote')));
    const checkpoint=await f.reload();assert.equal(checkpoint.state.sources.sourceforge.ready,true);
    assert.equal(checkpoint.state.sources.github.ready,false);assert.equal(checkpoint.state.status,'failed');
    const oldUploads=f.events.filter(value=>value.includes(':upload:')&&!value.endsWith(failed));
    f.setFailure(null);await executePublication(checkpoint,{stage:'all',providers:f.providers,log:()=>{}});
    for(const event of oldUploads)assert.equal(f.events.filter(value=>value===event).length,1,`Repeated ${event}`);
    assert.equal(checkpoint.release.published_at,'2026-10-10T00:00:00Z');assert.equal(checkpoint.state.status,'published');
    const firstPromotion=f.events.findIndex(value=>value.endsWith(':promote'));
    assert.ok(f.events.indexOf('sourceforge:ready')<firstPromotion&&f.events.indexOf('github:ready')<firstPromotion);
});
test('promote requires both verified sources; prepare never publishes',async t=>{
    const f=await fixture(t);
    await assert.rejects(executePublication(f.publication,{stage:'promote',providers:f.providers,log:()=>{}}),/Both sources/);
    assert.deepEqual(f.events,[]);
    await executePublication(f.publication,{stage:'prepare',providers:f.providers,log:()=>{}});
    assert.equal(f.publication.state.status,'prepared');assert.ok(!f.events.includes('github:promote'));
});
test('a GitHub-only sealed plan prepares and promotes without a SourceForge provider',async t=>{
    const f=await fixture(t,{destinations:['github']});
    assert.deepEqual(f.publication.plan.destinations,['github']);
    const providers={github:f.providers.github};
    await executePublication(f.publication,{stage:'prepare',providers,log:()=>{}});
    assert.equal(f.publication.state.status,'prepared');
    assert.equal(f.publication.state.sources.sourceforge.ready,false);
    assert.ok(!f.events.some(value=>value.startsWith('sourceforge:')||value.endsWith(':promote')));
    const resumed=await loadPublication({root:f.root,stateDir:f.stateDir,destinations:['github'],expectedPlanId:f.publication.state.planId});
    await executePublication(resumed,{stage:'promote',providers,log:()=>{}});
    assert.equal(resumed.state.status,'published');
    assert.equal(resumed.state.sources.github.promoted,true);
    assert.equal(resumed.state.sources.sourceforge.promoted,false);
    assert.ok(!f.events.some(value=>value.startsWith('sourceforge:')));
});
test('resuming cannot remove a failed destination from the original sealed plan',async t=>{
    const f=await fixture(t);
    await assert.rejects(loadPublication({root:f.root,stateDir:f.stateDir,destinations:['github']}),/destinations/);
    assert.deepEqual(f.events,[]);
});
test('a GitHub-only resume cannot silently add another destination',async t=>{
    const f=await fixture(t,{destinations:['github']});
    await assert.rejects(loadPublication({root:f.root,stateDir:f.stateDir,destinations:['github','sourceforge']}),/destinations/);
    assert.deepEqual(f.events,[]);
});
test('an original schema-1 plan without destinations still requires both channels',async t=>{
    const f=await fixture(t),planFile=path.join(f.stateDir,'publication-plan.json'),stateFile=path.join(f.stateDir,'publication-state.json');
    const plan=JSON.parse(fs.readFileSync(planFile)),state=JSON.parse(fs.readFileSync(stateFile));
    delete plan.destinations;const bytes=JSON.stringify(plan,null,2)+'\n';
    fs.writeFileSync(planFile,bytes);state.planId=crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');
    const legacy=await loadPublication({root:f.root,stateDir:f.stateDir,destinations:['github','sourceforge'],expectedPlanId:state.planId});
    await assert.rejects(executePublication(legacy,{stage:'prepare',providers:{github:f.providers.github},log:()=>{}}),/Missing sourceforge/);
    assert.deepEqual(f.events,[]);
    await assert.rejects(loadPublication({root:f.root,stateDir:f.stateDir,destinations:['github']}),/destinations/);
    await executePublication(legacy,{stage:'all',providers:f.providers,log:()=>{}});
    assert.equal(legacy.state.sources.github.promoted,true);
    assert.equal(legacy.state.sources.sourceforge.promoted,true);
});
test('invalid or duplicated publication destinations cannot be sealed',async t=>{
    for(const destinations of [[],['github','github'],['unknown'],['sourceforge','github'],null]){
        await t.test(JSON.stringify(destinations),async child=>{
            await assert.rejects(fixture(child,{destinations}),/destinations/);
        });
    }
});
test('GitHub-only publication requires shipped-consumer acceptance on every entry',async t=>{
    for(const stage of ['seal','prepare','promote','all'])await t.test(stage,async child=>{
        const f=await fixture(child,{destinations:['github']});
        await assert.rejects(executeWithConsumerGate(f.publication,{stage,providers:{github:f.providers.github},log:()=>{}}),/Final consumer|shipped launcher/);
        assert.deepEqual(f.events,[]);
        assert.equal(f.publication.state.status,'failed');
        assert.equal(f.publication.state.failure.failures[0].phase,'consumer-acceptance');
    });
});
test('GitHub-only failure preserves the same immutable bytes for a resumed upload',async t=>{
    const f=await fixture(t,{destinations:['github']}),providers={github:f.providers.github},failed='releases/v2.4.4/two.zip';
    f.setFailure(`github:${failed}`);
    await assert.rejects(executePublication(f.publication,{stage:'all',providers,log:()=>{}}),/preparation failed/);
    assert.ok(!f.events.some(value=>value.endsWith(':promote')));
    f.setFailure(null);const resumed=await f.reload();
    await executePublication(resumed,{stage:'all',providers,log:()=>{}});
    assert.equal(f.events.filter(value=>value==='github:upload:releases/v2.4.4/one.zip').length,1);
    assert.equal(resumed.state.planId,f.publication.state.planId);
    assert.equal(resumed.state.status,'published');
    assert.ok(!f.events.some(value=>value.startsWith('sourceforge:')));
});
test('final distribution without a consumable shipped launcher is rejected before either provider begins',async t=>{
    const f=await fixture(t);
    await assert.rejects(executeWithConsumerGate(f.publication,{stage:'all',providers:f.providers,log:()=>{}}),
        /Final consumer|shipped launcher/);
    assert.deepEqual(f.events,[]);
});
test('partial cross-site promotion resumes the remaining switch without rebuilding or uploading',async t=>{
    const f=await fixture(t);f.setFailure('sourceforge:promote');
    await assert.rejects(executePublication(f.publication,{stage:'all',providers:f.providers,log:()=>{}}),/channel switch failure/);
    const checkpoint=await f.reload();assert.equal(checkpoint.state.sources.github.promoted,true);
    assert.equal(checkpoint.state.sources.sourceforge.promoted,false);
    const uploads=f.events.filter(value=>value.includes(':upload:')).length;
    f.setFailure(null);await executePublication(checkpoint,{stage:'promote',providers:f.providers,log:()=>{}});
    assert.equal(f.events.filter(value=>value==='github:promote').length,1);
    assert.equal(f.events.filter(value=>value.includes(':upload:')).length,uploads);
    assert.equal(checkpoint.state.status,'published');
});
test('changed sealed bytes, different source identity and tampered plan prevent all remote effects',async t=>{
    for(const kind of ['bytes','identity','plan','receipt','symlink'])await t.test(kind,async child=>{
        const f=await fixture(child);
        if(kind==='bytes')fs.writeFileSync(path.join(f.root,'one.zip'),'changed');
        if(kind==='plan'){const file=path.join(f.stateDir,'publication-plan.json');const plan=JSON.parse(fs.readFileSync(file));plan.body='changed';fs.writeFileSync(file,JSON.stringify(plan));}
        if(kind==='receipt'){const file=path.join(f.stateDir,'publication-state.json');const state=JSON.parse(fs.readFileSync(file));state.sources.github.objects['releases/v2.4.4/one.zip']={size:1,sha256:'f'.repeat(64),verifiedAt:'x'};fs.writeFileSync(file,JSON.stringify(state));}
        if(kind==='symlink'){fs.renameSync(path.join(f.root,'one.zip'),path.join(f.root,'original.zip'));fs.symlinkSync(path.join(f.root,'original.zip'),path.join(f.root,'one.zip'));}
        await assert.rejects(kind==='identity'?loadPublication({root:f.root,stateDir:f.stateDir,commit:'c'.repeat(40)}):f.reload());
        assert.deepEqual(f.events,[]);
    });
});
