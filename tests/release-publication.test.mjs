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

test('APP-only seal preserves its dedicated channel through resume and rejects stripping or forging the actual core anchor',async t=>{
    const {writeDiscoveryCatalogues}=await import('../tooling/release/publish-release.mjs');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-channel-seal-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const root=path.join(directory,'assets');fs.mkdirSync(root);
    const product={schema:'tavern-release/v2',commit:'b'.repeat(40),versions:{tavern:'2.5.3'},
        publication:{schema:'nora-component-publication/1',tag:'v2.5.4'},coreRelease:{schema:'nora-core-reference/1',tag:'v2.5.3',commit:'a'.repeat(40),
        manifests:{'win32-x64':{asset:'win32-x64-release-manifest.json',size:100,sha256:'f'.repeat(64)}}}};
    const file=path.join(root,'release-manifest.json');fs.writeFileSync(file,JSON.stringify(product));
    const object={file,key:'releases/v2.5.4/release-manifest.json',phase:'asset',...await fileDigest(file)};
    const release={tag_name:'v2.5.4',draft:false,prerelease:false,body:'APP only.',published_at:'2026-10-18T00:00:00Z',assets:[{name:'release-manifest.json',state:'uploaded',size:object.size,digest:'sha256:'+object.sha256,
        browser_download_url:'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.5.4/release-manifest.json'}]};
    for(const mode of ['valid','stripped','forged']) {
        const stateDir=path.join(directory,mode),discovery=await writeDiscoveryCatalogues({release,product,output:stateDir});
        const {channel,coreAnchor}=discovery,plan={tag:release.tag_name,commit:product.commit,mode:'components',channel,
            ...(mode==='stripped'?{}:{coreAnchor:mode==='forged'?{...coreAnchor,commit:'c'.repeat(40)}:coreAnchor}),objects:[object,...discovery.objects]};
        if(mode==='valid'){
            const sealed=await sealPublication({plan,release},{root,stateDir,repository:'LoveMaker-art/noras-tavern'});
            assert.equal(sealed.plan.objects.at(-1).key,'channels/launcher-stable.json');
            const resumed=await loadPublication({root,stateDir,expectedPlanId:sealed.state.planId});assert.deepEqual(resumed.plan.coreAnchor,coreAnchor);
        }else await assert.rejects(sealPublication({plan,release},{root,stateDir,repository:'LoveMaker-art/noras-tavern'}),/phase|anchor/i);
    }
});

test('ordinary stable seals both discovery pointers while legacy single-pointer plans resume unchanged',async t=>{
    const {writeDiscoveryCatalogues}=await import('../tooling/release/publish-release.mjs');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-normal-discovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const root=path.join(directory,'assets'),stateDir=path.join(directory,'state');fs.mkdirSync(root);
    const tag='v2.5.3',commit='a'.repeat(40),product={schema:'tavern-release/v2',versions:{tavern:'2.5.3'},commit};
    const file=path.join(root,'release-manifest.json');fs.writeFileSync(file,JSON.stringify(product));
    const object={file,key:`releases/${tag}/release-manifest.json`,phase:'asset',...await fileDigest(file)};
    const release={tag_name:tag,draft:false,prerelease:false,body:'Normal stable.',published_at:'2026-10-18T00:00:00Z',assets:[
        {name:'release-manifest.json',state:'uploaded',size:object.size,digest:'sha256:'+object.sha256,
            browser_download_url:`https://github.com/LoveMaker-art/noras-tavern/releases/download/${tag}/release-manifest.json`}]};
    const discovery=await writeDiscoveryCatalogues({release,product,output:stateDir});
    assert.deepEqual(discovery.objects.filter(item=>item.phase==='channel').map(item=>item.key),
        ['channels/stable.json','channels/launcher-stable.json']);
    const publication=await sealPublication({plan:{tag,commit,mode:'full',channel:'stable',objects:[object,...discovery.objects]},release},
        {root,stateDir,repository:'LoveMaker-art/noras-tavern'});
    const resumed=await loadPublication({root,stateDir,expectedPlanId:publication.state.planId});
    const pointers=resumed.plan.objects.filter(item=>item.phase==='channel');
    assert.deepEqual(JSON.parse(fs.readFileSync(pointers[0].file)),release);
    assert.deepEqual(JSON.parse(fs.readFileSync(pointers[1].file)),[release]);
    const planFile=path.join(stateDir,'publication-plan.json'),sealedBytes=fs.readFileSync(planFile),stripped=JSON.parse(sealedBytes);
    stripped.objects.pop();fs.writeFileSync(planFile,JSON.stringify(stripped,null,2)+'\n');
    await assert.rejects(loadPublication({root,stateDir,expectedPlanId:publication.state.planId}),/digest|Plan differs/);
    fs.writeFileSync(planFile,sealedBytes);
    fs.appendFileSync(pointers[1].file,' ');
    await assert.rejects(loadPublication({root,stateDir}),/bytes changed/);
    const old=await fixture(t),oldKeys=old.publication.plan.objects.map(item=>item.key),oldPlanId=old.publication.state.planId;
    const oldResumed=await old.reload();assert.deepEqual(oldResumed.plan.objects.map(item=>item.key),oldKeys);
    assert.equal(oldResumed.state.planId,oldPlanId);assert.equal(oldKeys.filter(key=>key.startsWith('channels/')).length,1);
});

test('ordinary Beta keeps its one sealed array pointer',async t=>{
    const {writeDiscoveryCatalogues}=await import('../tooling/release/publish-release.mjs');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-beta-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const release={tag_name:'v2.5.3-beta.1',draft:false,prerelease:true};
    const value=await writeDiscoveryCatalogues({release,product:{versions:{tavern:'2.5.3-beta.1'}},output:root});
    assert.deepEqual(value.objects.filter(item=>item.phase==='channel').map(item=>item.key),['channels/beta.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(value.objects.at(-1).file)),[release]);
});
