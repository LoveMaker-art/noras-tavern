import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

export function command(program, args, {timeout = 45 * 60 * 1000, capture = false, log = console.log, killGrace = 2000, maxOutput = 32 * 1024 * 1024} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(program, args, {stdio: ['ignore', 'pipe', 'pipe']});
        let output = '', diagnostics = '', failure, forceTimer;
        const stop=reason=>{if(failure)return;failure=reason;child.kill('SIGTERM');forceTimer=setTimeout(()=>child.kill('SIGKILL'),killGrace);};
        const timer = setTimeout(() => stop('timeout'), timeout);
        const heartbeat = setInterval(() => log(`${program} running (${Math.round((Date.now() - started) / 1000)} seconds)`), 30000);
        const started = Date.now();
        child.stdout.on('data', bytes => { if(capture) { if(!failure){output += bytes;if(Buffer.byteLength(output)>maxOutput){output='';stop('output limit');}} } else process.stdout.write(bytes); });
        child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8000); if(!capture) process.stderr.write(bytes); });
        child.on('error', error => {clearTimeout(timer);clearTimeout(forceTimer);clearInterval(heartbeat);reject(error);});
        child.on('close', (code, signal) => {
            clearTimeout(timer);clearTimeout(forceTimer);clearInterval(heartbeat);
            if(code === 0 && !failure) resolve(output);
            else {const error = new Error(`${program} failed (${failure || signal || code}): ${diagnostics}`);error.code=code;error.diagnostics=diagnostics;reject(error);}
        });
    });
}
function order(tag) {
    const match=/^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(tag);assert.ok(match,'Invalid release tag');
    return [Number(match[1]),Number(match[2]),Number(match[3]),match[4] == null ? 1 : 0,Number(match[4] || 0)];
}
function noDowngrade(oldTag, target) {
    const before=order(oldTag),after=order(target),index=before.findIndex((number,index)=>number!==after[index]);
    assert.ok(index<0||before[index]<after[index], 'Refusing to downgrade GitHub channel');
}
export function githubProvider({repository, execute=command, log=console.log}={}) {
    assert.match(repository,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    let current, assets=[]; const baseline=new Map();
    const api=async endpoint=>JSON.parse(await execute('gh',['api',`repos/${repository}/${endpoint}`],{capture:true,timeout:120000,log}));
    const paginated=async(endpoint,kind)=>{
        const pages=JSON.parse(await execute('gh',['api','--paginate','--slurp',`repos/${repository}/${endpoint}`],{capture:true,timeout:120000,log}));
        assert.ok(Array.isArray(pages)&&pages.every(Array.isArray),`Invalid paginated GitHub ${kind} response`);
        return pages.flat();
    };
    const release=async tag=>{
        try{return await api(`releases/tags/${encodeURIComponent(tag)}`);}
        catch(error){if(!/\(HTTP 404\)/.test(error.diagnostics||''))throw error;}
        // The tag endpoint returns published releases; an authorized list also exposes drafts.
        const matches=(await paginated('releases?per_page=100','release')).filter(item=>item.tag_name===tag);
        assert.ok(matches.length<=1,'Duplicate GitHub releases for target tag');
        if(matches.length)assert.equal(matches[0].draft,true,'GitHub tag lookup and release list disagree');
        return matches[0]||null;
    };
    const inventory=async item=>{
        assert.ok(Number.isSafeInteger(item.id)&&item.id>0,'Invalid GitHub release id');
        return paginated(`releases/${item.id}/assets?per_page=100`,'asset');
    };
    const physical=p=>p.plan.objects.filter(object=>object.phase==='asset'&&!object.reference);
    const validateRelease=(item,p)=>{
        assert.ok(item&&typeof item.draft==='boolean'&&item.tag_name===p.plan.tag&&item.prerelease===(p.plan.channel==='beta'),'Different GitHub release identity');
        assert.equal(String(item.body||'').trimEnd(),p.plan.body.trimEnd(),'Different GitHub release notes');
        const names=new Set();for(const asset of assets){assert.ok(!names.has(asset.name),'Duplicate GitHub asset');names.add(asset.name);}
        assert.ok(assets.every(asset=>physical(p).some(object=>path.basename(object.key)===asset.name)), 'Unexpected GitHub asset; preserve and investigate it');
    };
    const checkAsset=(asset,object)=>{
        assert.ok(asset&&asset.state==='uploaded','GitHub asset is absent or incomplete');
        assert.equal(asset.size,object.size,'Different GitHub asset size');
        assert.equal(asset.digest,`sha256:${object.sha256}`,'GitHub SHA-256 digest is absent or different');
        const tag=object.assetReleaseTag||object.key.split('/')[1];
        assert.equal(asset.browser_download_url,`https://github.com/${repository}/releases/download/${tag}/${path.basename(object.key)}`,'Different GitHub asset URL');
    };
    const lookup=async(object,p)=>{
        if(!object.reference)return assets.find(item=>item.name===path.basename(object.key));
        const tag=object.assetReleaseTag;
        if(!baseline.has(tag)){
            assert.match(object.sourceCommit,/^[a-f0-9]{40}$/);
            await checkTag({plan:{tag,commit:object.sourceCommit}});
            const old=await release(tag);assert.ok(old&&!old.draft&&!old.prerelease&&old.tag_name===tag,'Referenced GitHub release is not a formal stable release');
            baseline.set(tag,await inventory(old));
        }
        return baseline.get(tag).find(item=>item.name===path.basename(object.key));
    };
    const refresh=async p=>{
        const selected=current||await release(p.plan.tag);assert.ok(selected,'Prepared GitHub release disappeared');
        assert.ok(Number.isSafeInteger(selected.id)&&selected.id>0,'Invalid GitHub release id');
        const item=await api(`releases/${selected.id}`);
        assert.equal(item.id,selected.id,'Different GitHub release id');
        assets=await inventory(item);validateRelease(item,p);current=item;
    };
    const checkTag=async p=>{
        let object=(await api(`git/ref/tags/${encodeURIComponent(p.plan.tag)}`)).object;
        for(let hop=0;object?.type==='tag'&&hop<5;hop++){
            assert.match(object.sha,/^[a-f0-9]{40}$/);object=(await api(`git/tags/${object.sha}`)).object;
        }
        assert.ok(object?.type==='commit'&&object.sha===p.plan.commit,'Remote GitHub tag differs from accepted product commit');
    };
    return {
        async begin(p){
            await checkTag(p);
            current=await release(p.plan.tag);
            if(!current){
                const notes=path.join(p.stateDir,'authored-release-notes.md');fs.writeFileSync(notes,p.plan.body);
                await execute('gh',['release','create',p.plan.tag,'--repo',repository,'--target',p.plan.commit,'--verify-tag','--draft',
                    ...(p.plan.channel==='beta'?['--prerelease']:[]),'--title',`诺拉·酒馆 ${p.plan.tag}${p.plan.channel==='beta'?' 测试版':''}`,'--notes-file',notes],{log});
            }
            await refresh(p);
        },
        async inspect(object,receipt,p){const asset=await lookup(object,p);if(!asset)return 'missing';checkAsset(asset,object);return 'matching';},
        async upload(object,p){assert.ok(current.draft,'Cannot upload to a published GitHub release');assert.ok(!object.reference);
            await execute('gh',['release','upload',p.plan.tag,object.file,'--repo',repository],{log});await refresh(p);},
        async verify(object,p){checkAsset(await lookup(object,p),object);},
        async assertReady(p){await refresh(p);for(const object of p.plan.objects.filter(item=>item.phase==='asset'))checkAsset(await lookup(object,p),object);
            assert.equal(assets.length,physical(p).length,'Incomplete GitHub asset closure');},
        async checkPromotion(p){
            await checkTag(p);
            await refresh(p);
            if(p.plan.channel==='stable'){
                let latest;try{latest=await api('releases/latest');}catch(error){if(!/\(HTTP 404\)/.test(error.diagnostics||''))throw error;}
                if(latest){assert.ok(!latest.draft&&!latest.prerelease);noDowngrade(latest.tag_name,p.plan.tag);}
            } else {
                for(const item of (await paginated('releases?per_page=100','release')).filter(item=>!item.draft&&item.prerelease))noDowngrade(item.tag_name,p.plan.tag);
            }
        },
        async promote(p){await execute('gh',['release','edit',p.plan.tag,'--repo',repository,'--draft=false',`--prerelease=${p.plan.channel==='beta'}`,`--latest=${p.plan.channel==='stable'}`],{timeout:120000,log});},
        async verifyPromotion(p){await refresh(p);assert.equal(current.draft,false);if(p.plan.channel==='stable')assert.equal((await api('releases/latest')).tag_name,p.plan.tag);
            for(const object of physical(p))checkAsset(await lookup(object,p),object);}
    };
}

export function sourceforgeProvider({upload,readPublic,verifyObject,preventDowngrade,fetcher=fetch,log=console.log}={}) {
    const checked=new Set();
    const existence=async object=>{
        const response=await readPublic(object.key,fetcher,120000,{method:'HEAD'});
        if([404,410].includes(response.status)){await response.body?.cancel();return false;}
        assert.ok(response.ok,`Cannot inspect SourceForge object: ${object.key} HTTP ${response.status}`);
        const length=response.headers.get('content-length');await response.body?.cancel();
        assert.ok(length&&/^\d+$/.test(length)&&Number(length)===object.size,`SourceForge object size is unavailable or different: ${object.key}`);
        return true;
    };
    return {
        async begin(){},
        async inspect(object,receipt){
            if(!await existence(object))return 'missing';
            // A bound checkpoint contains an earlier full-byte verification.
            // HEAD checks availability without redownloading unchanged GB assets.
            if(!receipt){log(`sourceforge adopting existing object with full SHA-256 verification: ${object.key}`);await verifyObject(object,{fetcher});}
            checked.add(object.key);return 'matching';
        },
        async upload(object){await upload(object,{immutable:true});},
        async verify(object){await verifyObject(object,{fetcher});checked.add(object.key);},
        async assertReady(p){for(const object of p.plan.objects.filter(item=>item.phase!=='channel')){
            assert.ok(p.state.sources.sourceforge.objects[object.key],'Missing verified SourceForge receipt');
            if(!checked.has(object.key))assert.ok(await existence(object),`Prepared object disappeared: ${object.key}`);
        }
            // Recheck the small catalogue byte-for-byte immediately before switching.
            await verifyObject(p.plan.objects.at(-2),{fetcher});
        },
        async checkPromotion(p){await preventDowngrade(p,fetcher);},
        async promote(p){await upload(p.plan.objects.at(-1),{immutable:false});},
        async verifyPromotion(p){await verifyObject(p.plan.objects.at(-1),{fetcher});}
    };
}
