import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {command,githubProvider,sourceforgeProvider} from '../tooling/release/publication-providers.mjs';

test('a child ignoring SIGTERM is forcibly stopped at the bounded deadline',async()=>{
    const started=Date.now();
    await assert.rejects(command(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},10)'],
        {timeout:150,killGrace:100,capture:true,log:()=>{}}),/timeout/);
    assert.ok(Date.now()-started<1500,'Timeout did not enforce a hard process deadline');
});
test('excess command output cannot be accepted even when the child exits successfully',async()=>{
    await assert.rejects(command(process.execPath,['-e','process.stdout.write("x".repeat(10000))'],
        {capture:true,maxOutput:100,log:()=>{}}),/output limit/);
});
function githubFixture(t,{draft=true,exists=true,populated=true}={}) {
    const repository='LoveMaker-art/noras-tavern',tag='v2.4.4',commit='a'.repeat(40);
    const object={phase:'asset',key:`releases/${tag}/one.zip`,size:3,sha256:'f'.repeat(64),file:'/sealed/one.zip'};
    const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'nora-publication-provider-'));
    t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
    const p={plan:{tag,commit,channel:'stable',body:'Authored notes.\n',objects:[object]},stateDir};
    const expectedAsset={id:2,name:'one.zip',state:'uploaded',size:3,digest:'sha256:'+object.sha256,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/one.zip`};
    const assets=populated?[expectedAsset]:[];
    const release={id:1,tag_name:tag,draft,prerelease:false,body:'Authored notes.'},calls=[],state={exists};
    const notFound=()=>Object.assign(new Error('Not Found'),{diagnostics:'gh: Not Found (HTTP 404)'});
    const execute=async(program,args)=>{
        assert.equal(program,'gh');
        calls.push(args);
        const endpoint=args.at(-1);
        if(args[0]==='api'){
            const base=`repos/${repository}`;
            if(endpoint===`${base}/git/ref/tags/${tag}`)return JSON.stringify({object:{type:'commit',sha:commit}});
            if(endpoint===`${base}/releases/tags/${tag}`){
                if(state.tagError)throw state.tagError;
                // The tag endpoint exposes published releases, not drafts.
                if(!state.exists||release.draft)throw notFound();
                return JSON.stringify(release);
            }
            if(endpoint===`${base}/releases?per_page=100`){
                assert.ok(args.includes('--paginate')&&args.includes('--slurp'));
                if(state.listError)throw state.listError;
                // Put the target on a later page to exercise complete pagination.
                return JSON.stringify(state.releasePages??[[{id:99,tag_name:'v2.4.3',draft:false}],state.exists?[release]:[]]);
            }
            if(endpoint===`${base}/releases/1`){
                if(state.idError)throw state.idError;
                if(!state.exists)throw notFound();
                return JSON.stringify(state.idRelease??release);
            }
            if(endpoint===`${base}/releases/1/assets?per_page=100`){
                assert.ok(args.includes('--paginate')&&args.includes('--slurp'));
                return JSON.stringify([assets]);
            }
            if(endpoint===`${base}/releases/latest`)return JSON.stringify({...release,draft:false,tag_name:release.draft?'v2.4.3':tag});
            assert.fail(`Unexpected GitHub API endpoint: ${endpoint}`);
        }
        assert.equal(args[0],'release');assert.equal(args[2],tag);
        assert.equal(args[args.indexOf('--repo')+1],repository);
        if(args[1]==='create'){
            assert.equal(state.exists,false,'An existing draft must not be recreated');
            assert.equal(fs.readFileSync(args[args.indexOf('--notes-file')+1],'utf8'),p.plan.body);
            state.exists=true;release.draft=true;
        }else if(args[1]==='upload'){
            assert.ok(state.exists&&release.draft);assert.equal(args[3],object.file);
            assert.ok(!args.includes('--clobber'));assets.push(expectedAsset);
        }else if(args[1]==='edit')release.draft=false;
        else assert.fail(`Unexpected GitHub command: ${args.join(' ')}`);
        return '';
    };
    return {provider:githubProvider({repository,execute,log:()=>{}}),p,assets,release,calls,execute,state};
}
test('GitHub resumes an existing draft without recreate or duplicate upload and rejects a different digest',async t=>{
    const {provider,p,assets,calls}=githubFixture(t);await provider.begin(p);
    assert.equal(await provider.inspect(p.plan.objects[0],null,p),'matching');await provider.assertReady(p);
    assert.ok(!calls.some(args=>args[0]==='release'&&['create','upload'].includes(args[1])));
    assets[0].digest='sha256:'+'0'.repeat(64);
    await assert.rejects(provider.assertReady(p),/digest/);
});
test('a fresh GitHub provider can assert a draft ready although the published tag endpoint returns 404',async t=>{
    const {provider,p,calls}=githubFixture(t);
    await provider.assertReady(p);
    assert.ok(calls.some(args=>args.at(-1).endsWith('/releases?per_page=100')));
    assert.ok(!calls.some(args=>args[0]==='release'));
});
test('a discovered draft keeps its ID through upload, readiness checks and promotion',async t=>{
    const {provider,p,release,calls,state}=githubFixture(t,{populated:false});
    await provider.begin(p);
    assert.equal(await provider.inspect(p.plan.objects[0],null,p),'missing');
    // Once selected, refreshing this draft must not rely on the published tag endpoint or listing.
    state.tagError=new Error('Tag endpoint must not be used after selecting the draft');
    state.listError=new Error('Release list must not be used after selecting the draft');
    await provider.upload(p.plan.objects[0],p);
    await provider.verify(p.plan.objects[0],p);
    await provider.assertReady(p);
    await provider.checkPromotion(p);
    await provider.promote(p);
    await provider.verifyPromotion(p);
    assert.equal(release.draft,false);
    assert.equal(calls.filter(args=>args[0]==='release'&&args[1]==='upload').length,1);
    assert.equal(calls.filter(args=>args[0]==='release'&&args[1]==='edit').length,1);
    assert.ok(!calls.some(args=>args[0]==='release'&&args[1]==='create'));
    assert.equal(calls.filter(args=>args.at(-1).endsWith('/releases?per_page=100')).length,1);
    assert.ok(calls.filter(args=>args.at(-1).endsWith('/releases/1')).length>=5);
});
test('only a successful empty complete listing permits creating a draft, which is then discovered by ID',async t=>{
    const {provider,p,calls}=githubFixture(t,{exists:false,populated:false});
    await provider.begin(p);
    await provider.upload(p.plan.objects[0],p);
    await provider.assertReady(p);
    const creates=calls.filter(args=>args[0]==='release'&&args[1]==='create');
    assert.equal(creates.length,1);assert.ok(creates[0].includes('--verify-tag')&&creates[0].includes('--draft'));
    assert.equal(creates[0][creates[0].indexOf('--target')+1],p.plan.commit);
    assert.equal(calls.filter(args=>args.at(-1).endsWith('/releases?per_page=100')).length,2);
    assert.ok(calls.some(args=>args.at(-1).endsWith('/releases/1')));
});
test('published releases still use the tag endpoint and preserve the no-upload guard',async t=>{
    const {provider,p,calls}=githubFixture(t,{draft:false});
    await provider.begin(p);await provider.assertReady(p);await provider.checkPromotion(p);await provider.verifyPromotion(p);
    await assert.rejects(provider.upload(p.plan.objects[0],p),/published/);
    assert.ok(calls.some(args=>args.at(-1).endsWith('/releases/tags/v2.4.4')));
    assert.ok(!calls.some(args=>args.at(-1).endsWith('/releases?per_page=100')||args[0]==='release'));
});
test('same-tag releases across different pages are ambiguous and cannot be recreated or adopted',async t=>{
    for(const secondDraft of [true,false]){
        const {provider,p,release,state,calls}=githubFixture(t);
        state.releasePages=[[release],[{...release,id:42,draft:secondDraft}]];
        await assert.rejects(provider.begin(p),/Duplicate GitHub releases/);
        assert.ok(!calls.some(args=>args[0]==='release'));
    }
});
test('a conflicting published list entry or invalid draft ID cannot be adopted after a tag 404',async t=>{
    for(const [change,expected] of [[{draft:false},/lookup and release list disagree/],[{id:0},/Invalid GitHub release id/]]){
        const {provider,p,release,state,calls}=githubFixture(t);
        state.releasePages=[[{...release,...change}]];
        await assert.rejects(provider.begin(p),expected);
        assert.ok(!calls.some(args=>args[0]==='release'));
    }
});
test('authorization, network and malformed list failures never mean a missing release',async t=>{
    const failures=[
        Object.assign(new Error('Forbidden'),{diagnostics:'gh: Forbidden (HTTP 403)'}),
        Object.assign(new Error('Not Found'),{diagnostics:'gh: Not Found (HTTP 404)'}),
        new Error('Connection reset'),
    ];
    for(const error of failures){
        const {provider,p,state,calls}=githubFixture(t);state.listError=error;
        await assert.rejects(provider.begin(p),actual=>actual===error);
        assert.ok(!calls.some(args=>args[0]==='release'));
        assert.equal(fs.existsSync(path.join(p.stateDir,'authored-release-notes.md')),false);
    }
    for(const releasePages of [{},[{tag_name:'v2.4.4'}]]){
        const {provider,p,state,calls}=githubFixture(t);state.releasePages=releasePages;
        await assert.rejects(provider.begin(p),/Invalid paginated GitHub release response/);
        assert.ok(!calls.some(args=>args[0]==='release'));
    }
});
test('non-404 errors from the tag endpoint cannot be hidden by a draft list lookup',async t=>{
    for(const error of [Object.assign(new Error('Forbidden'),{diagnostics:'gh: Forbidden (HTTP 403)'}),new Error('Network timeout')]){
        const {provider,p,state,calls}=githubFixture(t);state.tagError=error;
        await assert.rejects(provider.begin(p),actual=>actual===error);
        assert.ok(!calls.some(args=>args.at(-1).endsWith('/releases?per_page=100')||args[0]==='release'));
    }
});
test('refresh by pinned ID rejects disappearance and release identity or notes changes',async t=>{
    for(const [change,expected] of [
        [{id:42},/Different GitHub release id/],
        [{tag_name:'v2.4.5'},/Different GitHub release identity/],
        [{prerelease:true},/Different GitHub release identity/],
        [{draft:undefined},/Different GitHub release identity/],
        [{body:'Different notes'},/Different GitHub release notes/],
    ]){
        const {provider,p,release,state,calls}=githubFixture(t);await provider.begin(p);
        state.idRelease={...release,...change};
        await assert.rejects(provider.assertReady(p),expected);
        assert.ok(!calls.some(args=>args[0]==='release'));
    }
    const {provider,p,state,calls}=githubFixture(t);await provider.begin(p);
    const error=Object.assign(new Error('Deleted draft'),{diagnostics:'gh: Not Found (HTTP 404)'});state.idError=error;
    await assert.rejects(provider.assertReady(p),actual=>actual===error);
    assert.equal(calls.filter(args=>args.at(-1).endsWith('/releases?per_page=100')).length,1);
    assert.ok(!calls.some(args=>args[0]==='release'));
});
test('draft adoption retains asset closure, size, digest and URL validation',async t=>{
    for(const [change,expected] of [
        [{name:'unapproved.zip'},/Unexpected GitHub asset/],
        [{size:4},/Different GitHub asset size/],
        [{digest:undefined},/digest/],
        [{browser_download_url:'https://example.com/one.zip'},/Different GitHub asset URL/],
        [{state:'new'},/incomplete/],
    ]){
        const {provider,p,assets,calls}=githubFixture(t);Object.assign(assets[0],change);
        await assert.rejects(provider.assertReady(p),expected);
        assert.ok(!calls.some(args=>args[0]==='release'));
    }
    const {provider,p,assets}=githubFixture(t);assets.push({...assets[0],id:3});
    await assert.rejects(provider.assertReady(p),/Duplicate GitHub asset/);
});
test('a remote tag change blocks publication independently from local source identity',async t=>{
    const fixture=githubFixture(t);const provider=githubProvider({repository:'LoveMaker-art/noras-tavern',execute:async(program,args)=>
        args.at(-1).includes('/git/ref/')?JSON.stringify({object:{type:'commit',sha:'b'.repeat(40)}}):fixture.execute(program,args),log:()=>{}});
    await assert.rejects(provider.begin(fixture.p),/tag differs/);
    assert.ok(!fixture.calls.some(args=>args[0]==='release'));
});
test('SourceForge adopts old partial-run bytes only after full hash verification and avoids repeat download with a bound receipt',async()=>{
    const object={key:'releases/v2.4.4/one.zip',size:3,sha256:'f'.repeat(64)},calls=[];
    const provider=sourceforgeProvider({upload:async()=>calls.push('upload'),
        readPublic:async(key,fetcher,timeout,options)=>{assert.equal(options.method,'HEAD');return new Response(null,{headers:{'content-length':'3'}});},
        verifyObject:async()=>calls.push('full-hash'),preventDowngrade:async()=>{},log:()=>{}});
    assert.equal(await provider.inspect(object,null),'matching');assert.deepEqual(calls,['full-hash']);
    assert.equal(await provider.inspect(object,{sha256:object.sha256,size:3,verifiedAt:'earlier'}),'matching');assert.deepEqual(calls,['full-hash']);
});
test('SourceForge authorization errors and wrong sizes are failures rather than missing files',async()=>{
    for(const response of [new Response(null,{status:403}),new Response(null,{headers:{'content-length':'4'}})]){
        let uploads=0;
        const provider=sourceforgeProvider({upload:async()=>uploads++,readPublic:async()=>response,verifyObject:async()=>{},preventDowngrade:async()=>{}});
        await assert.rejects(provider.inspect({key:'releases/v2.4.4/one.zip',size:3},null));assert.equal(uploads,0);
    }
});
