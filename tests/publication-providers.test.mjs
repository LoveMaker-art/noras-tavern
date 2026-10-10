import {test} from 'node:test';
import assert from 'node:assert/strict';
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
function githubFixture() {
    const repository='LoveMaker-art/noras-tavern',tag='v2.4.4',commit='a'.repeat(40);
    const object={phase:'asset',key:`releases/${tag}/one.zip`,size:3,sha256:'f'.repeat(64),file:'/sealed/one.zip'};
    const p={plan:{tag,commit,channel:'stable',body:'Authored notes.\n',objects:[object]},stateDir:'/not-used'};
    const assets=[{id:2,name:'one.zip',state:'uploaded',size:3,digest:'sha256:'+object.sha256,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/one.zip`}];
    const release={id:1,tag_name:tag,draft:true,prerelease:false,body:'Authored notes.'},calls=[];
    const execute=async(program,args)=>{
        calls.push(args);
        const endpoint=args.at(-1);
        if(args[0]==='api'){
            if(endpoint.includes('/git/ref/'))return JSON.stringify({object:{type:'commit',sha:commit}});
            if(endpoint.includes('/assets?'))return JSON.stringify([assets]);
            if(endpoint.endsWith('/releases/latest'))return JSON.stringify({...release,draft:false,tag_name:'v2.4.3'});
            return JSON.stringify(release);
        }
        if(args[0]==='release'&&args[1]==='edit')release.draft=false;
        return '';
    };
    return {provider:githubProvider({repository,execute,log:()=>{}}),p,assets,release,calls,execute};
}
test('GitHub resumes an existing draft without recreate or duplicate upload and rejects a different digest',async()=>{
    const {provider,p,assets,calls}=githubFixture();await provider.begin(p);
    assert.equal(await provider.inspect(p.plan.objects[0],null,p),'matching');await provider.assertReady(p);
    assert.ok(!calls.some(args=>args[0]==='release'&&['create','upload'].includes(args[1])));
    assets[0].digest='sha256:'+'0'.repeat(64);
    await assert.rejects(provider.assertReady(p),/digest/);
});
test('a remote tag change blocks publication independently from local source identity',async()=>{
    const fixture=githubFixture();const provider=githubProvider({repository:'LoveMaker-art/noras-tavern',execute:async(program,args)=>
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
