import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sealPublication, loadPublication, executePublication } from './publication-state.mjs';
import { command, githubProvider, sourceforgeProvider } from './publication-providers.mjs';

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

function releaseAssets(root) {
    const assets = new Map();
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            assert.ok(!entry.isSymbolicLink(), `Symbolic release object: ${entry.name}`);
            if (entry.isDirectory()) { visit(file); continue; }
            assert.ok(entry.isFile(), `Invalid release object: ${entry.name}`);
            if (entry.name === 'release-notes.generated.md' || entry.name.endsWith('.blockmap') || /^latest.*\.yml$/.test(entry.name)) continue;
            assert.match(entry.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
            assert.notEqual(entry.name, 'release.json', 'Reserved distribution catalogue name');
            assert.ok(!assets.has(entry.name), `Duplicate release asset: ${entry.name}`);
            assets.set(entry.name, file);
        }
    };
    visit(root);
    return [...assets].sort(([left], [right]) => left.localeCompare(right, 'en'));
}
async function objectRecord(file, key, phase) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return {file, key, phase, size:fs.statSync(file).size, sha256:hash.digest('hex')};
}

// Prepare an ordered, verified upload list. Storage-specific uploads are a
// separate deployment step; never expose a channel before all objects verify.
export async function prepareDistribution({root, tag, commit, mode='full', repository='LoveMaker-art/noras-tavern', output=root+'.distribution',body='',publishedAt=new Date().toISOString(),assetMode='legacy',reuseFrom}) {
    root=path.resolve(root);output=path.resolve(output);
    assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(tag, /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
    const relative=path.relative(root, output);
    assert.ok(relative.startsWith('..'+path.sep) || path.isAbsolute(relative), 'Distribution output must be outside release assets');
    assert.ok(!fs.existsSync(output), 'Distribution output already exists; preserve the previous immutable plan');
    releaseAssets(root);
    const verifier=fileURLToPath(new URL('./verify-launcher-release.cjs', import.meta.url));
    // The release projection moves this verifier to ops/scripts.
    const verificationScript=fs.existsSync(verifier)?verifier:path.resolve(path.dirname(verifier),'../../ops/scripts/verify-launcher-release.cjs');
    const verification=execFileSync(process.execPath, [verificationScript, root, tag, commit, mode], {encoding:'utf8',stdio:'pipe'});
    assert.ok(['legacy','shared'].includes(assetMode),'Invalid asset mode');
    assert.ok(assetMode==='shared'||!reuseFrom,'Legacy publication cannot reuse cross-tag assets');
    const assets=releaseAssets(root),objects=[];
    for (const [name,file] of assets) objects.push(await objectRecord(file, `releases/${tag}/${name}`, 'asset'));
    // Recheck descriptor closure against the exact final publication bytes.
    // Verification must never rewrite a sealed component or its checksum list.
    const finalByName=new Map(assets.map(([name],index)=>[name,objects[index]]));
    for(const [name,item] of finalByName) if(/^nora-system-(?:darwin-(?:arm64|x64)|win32-x64)\.json$/.test(name)) {
        const system=JSON.parse(fs.readFileSync(item.file,'utf8'));
        for(const entry of Object.values(system.files)) {
            const actual=finalByName.get(entry.asset);
            assert.ok(actual && actual.size===entry.size && actual.sha256===entry.sha256, `Final release bytes differ from system manifest: ${entry.asset}`);
        }
    }
    fs.mkdirSync(output,{recursive:true});
    if(assetMode==='shared') {
        assert.ok(reuseFrom,'Shared publication requires a frozen reuse baseline');
        const baseline=typeof reuseFrom==='string'?JSON.parse(fs.readFileSync(reuseFrom,'utf8')):reuseFrom;
        assert.equal(baseline.schema,'nora-reuse-baseline/1');assert.equal(baseline.repository,repository);assert.match(baseline.commit,/^[a-f0-9]{40}$/);
        const previous=baseline.release;assert.ok(previous&&!previous.draft&&!previous.prerelease&&Array.isArray(previous.assets),'Reuse baseline must be a formal stable release');
        assert.match(previous.tag_name,/^v\d+\.\d+\.\d+$/);
        const old=tagOrder(previous.tag_name),target=tagOrder(tag),different=old.findIndex((number,index)=>number!==target[index]);
        assert.ok(different>=0&&old[different]<target[different],'Reuse baseline must precede target version');
        const systems=assets.filter(([name])=>/^nora-system-(?:darwin-(?:arm64|x64)|win32-x64)\.json$/.test(name)).map(([,file])=>JSON.parse(fs.readFileSync(file)));
        assert.equal(systems.length,3,'Shared publication needs three platform descriptors');
        const minimum=systems[0].minimumLauncherVersion;
        assert.match(minimum,/^\d+\.\d+\.\d+$/);assert.ok(tagOrder('v'+minimum).some((number,index)=>number!==tagOrder('v2.1.1')[index])&&
            (()=>{const values=tagOrder('v'+minimum),old=tagOrder('v2.1.1'),index=values.findIndex((number,index)=>number!==old[index]);return index>=0&&values[index]>old[index];})(),'Shared protocol requires a launcher newer than 2.1.1');
        assert.ok(systems.every(item=>item.commit===commit&&item.minimumLauncherVersion===minimum),'Inconsistent shared protocol requirements');
        const sharedManifest=JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json')));
        assert.equal(sharedManifest.bootstrap.minimumLauncherVersion,minimum,'Shared manifest minimum differs');
        const protectedName=name=>/^(?:release-assets\.json|release-manifest\.json|(?:LAUNCHER-)?SHA256SUMS|bootstrap-manifest\.json|first-install-manifest\.json|tavern-updater-bootstrap\.py|nora-tavern-first-install-bootstrap\.py|install-(?:nora-tavern\.(?:sh|ps1)|tavern-updater\.sh)|nora-system-.*\.json|nora-launcher-.*\.json|Nora-Tavern-Launcher-.*(?:-update\.zip|-setup\.exe|\.dmg|\.zip))$/.test(name)
            ||/-(?:release-manifest.*\.json|SHA256SUMS|first-install-manifest\.json|nora-tavern-first-install-bootstrap\.py|tavern-updater-bootstrap\.py)$/.test(name);
        const byName=new Map();for(const asset of previous.assets){assert.ok(!byName.has(asset.name),'Duplicate baseline asset');byName.set(asset.name,asset);}
        const references=[];
        for(const object of objects){
            const name=path.basename(object.key),oldAsset=byName.get(name);
            if(protectedName(name)||!oldAsset||oldAsset.size!==object.size||oldAsset.digest!==`sha256:${object.sha256}`)continue;
            const origin=oldAsset.asset_release_tag||previous.tag_name;
            assert.match(origin,/^v\d+\.\d+\.\d+$/);
            const originOrder=tagOrder(origin),currentOrder=tagOrder(previous.tag_name),originDifference=originOrder.findIndex((number,index)=>number!==currentOrder[index]);
            assert.ok(originDifference<0||originOrder[originDifference]<currentOrder[originDifference],'Referenced origin is newer than its baseline');
            assert.equal(oldAsset.browser_download_url,`https://github.com/${repository}/releases/download/${origin}/${name}`,'Untrusted baseline asset URL');
            const sourceCommit=origin===previous.tag_name?baseline.commit:baseline.originCommits?.[origin];
            assert.match(sourceCommit||'',/^[a-f0-9]{40}$/,'Missing original asset commit proof');
            const descriptor=[...Object.values(sharedManifest.archives||{}),...Object.values(sharedManifest.modules||{})].find(item=>item.name===name);
            if(descriptor){assert.equal(descriptor.size,object.size,'Shared business descriptor requires the actual sealed size');assert.equal(descriptor.sha256,object.sha256);}
            object.reference=true;object.assetReleaseTag=origin;object.sourceCommit=sourceCommit;object.key=`releases/${origin}/${name}`;
            references.push({name,asset_release_tag:origin,size:object.size,sha256:object.sha256});
        }
        assert.ok(references.length,'Shared mode did not find any identical reusable assets; use legacy');
        const index=path.join(output,'release-assets.json');
        fs.writeFileSync(index,JSON.stringify({schema:'nora-release-assets/1',repository,tag,commit,minimumLauncherVersion:minimum,assets:references})+'\n');
        objects.push(await objectRecord(index,`releases/${tag}/release-assets.json`,'asset'));
    }
    const beta=tag.includes('-beta.'),channel=beta?'beta':'stable';
    assert.ok(Number.isFinite(Date.parse(publishedAt)), 'Invalid publication date');
    assert.equal(typeof body,'string');
    const release={tag_name:tag,draft:false,prerelease:beta,body,published_at:publishedAt,assets:objects.filter(item=>!item.reference).map(item=>({name:path.basename(item.key),state:'uploaded',size:item.size,
        digest:`sha256:${item.sha256}`,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/${path.basename(item.key)}`}))};
    fs.mkdirSync(path.join(output,'releases',tag),{recursive:true});
    const catalogue=path.join(output,'releases',tag,'release.json');
    fs.writeFileSync(catalogue,JSON.stringify(release)+'\n');
    objects.push(await objectRecord(catalogue,`releases/${tag}/release.json`,'catalogue'));
    fs.mkdirSync(path.join(output,'channels'));
    const pointer=path.join(output,'channels',channel+'.json');
    fs.writeFileSync(pointer,JSON.stringify(beta?[release]:release)+'\n');
    objects.push(await objectRecord(pointer,`channels/${channel}.json`,'channel'));
    const plan={schema:'nora-distribution/1',tag,commit,mode,channel,
        publishChannelAfter:'all_objects_verified',objects};
    fs.writeFileSync(path.join(output,'distribution-plan.json'),JSON.stringify(plan,null,2)+'\n');
    return {output,plan,release,verification};
}

const sfRoot='https://downloads.sourceforge.net/project/nora-tavern/';
const sfKey=key=>key.replace(/^releases\//,'');
function sourceReader() {
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const file=['launcher/desktop/release-sources.js','ops/installer/desktop/release-sources.js']
        .map(name=>path.join(root,name)).find(name=>fs.existsSync(name));
    assert.ok(file,'Missing shared release source validator');
    return createRequire(import.meta.url)(file).readSource;
}
async function readPublic(key,fetcher,timeout=1800000,options={}) {
    const url=sfRoot+sfKey(key);
    return sourceReader()(fetcher,{provider:'sourceforge',origin:new URL(sfRoot).origin,mirror:true,url},url,
        {...options,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),headers:{'Accept-Encoding':'identity'}});
}
export async function verifyDistributionObject(object,{fetcher=fetch,totalTimeout=1800000,idleTimeout=120000}={}) {
    const controller=new AbortController();
    const response=await readPublic(object.key,fetcher,totalTimeout,{signal:controller.signal});
    assert.ok(response.ok&&response.body,`SourceForge object unavailable: ${object.key} (HTTP ${response.status})`);
    const hash=crypto.createHash('sha256');let size=0;const started=Date.now();
    const heartbeat=setInterval(()=>console.log(`SourceForge verifying ${object.key}: ${size}/${object.size} bytes (${Math.round((Date.now()-started)/1000)} seconds)`),30000);
    let idle;const iterator=response.body[Symbol.asyncIterator]();
    try {for(;;) {
        const next=await Promise.race([iterator.next(),new Promise((resolve,reject)=>{idle=setTimeout(()=>{controller.abort();reject(new Error(`SourceForge verification stalled: ${object.key} (${size}/${object.size} bytes)`));},idleTimeout);})]);
        clearTimeout(idle);if(next.done)break;const chunk=next.value;
        size+=chunk.length;
        assert.ok(size<=object.size,`SourceForge object too large: ${object.key}`);
        hash.update(chunk);
    }} finally {clearTimeout(idle);clearInterval(heartbeat);controller.abort();}
    assert.equal(size,object.size,`Incomplete SourceForge object: ${object.key}`);
    assert.equal(hash.digest('hex'),object.sha256,`Different SourceForge object: ${object.key}`);
}
function tagOrder(tag) {
    const match=/^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(tag);
    assert.ok(match,'Invalid existing channel version');
    return [Number(match[1]),Number(match[2]),Number(match[3]),match[4]==null?1:0,Number(match[4]||0)];
}
async function preventDowngrade(distribution,fetcher) {
    const response=await readPublic(`channels/${distribution.plan.channel}.json`,fetcher,30000);
    if([404,410].includes(response.status)){await response.body?.cancel();return;}
    assert.ok(response.ok,'Cannot confirm existing SourceForge channel');
    const chunks=[];let size=0;
    for await(const chunk of response.body) {
        size+=chunk.length;assert.ok(size<=4*1024*1024,'Existing channel too large');chunks.push(chunk);
    }
    const previous=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(Array.isArray(previous),distribution.plan.channel==='beta','Existing channel has an invalid shape');
    const items=Array.isArray(previous)?previous:[previous],target=tagOrder(distribution.plan.tag);
    for(const item of items) {
        assert.ok(item && !item.draft && Boolean(item.prerelease)===(distribution.plan.channel==='beta'),'Existing channel has an invalid release');
        const old=tagOrder(item.tag_name);
        const index=old.findIndex((number,index)=>number!==target[index]);
        assert.ok(index<0||old[index]<target[index],'Refusing to downgrade SourceForge channel');
    }
}
// Upload immutable objects first. Each source is independently complete before
// its mutable channel pointer can advertise the new release.
export async function publishDistribution(distribution,{upload,verify=verifyDistributionObject,fetcher=fetch}={}) {
    assert.equal(typeof upload,'function','SourceForge uploader is required');
    const objects=distribution.plan.objects;
    const {tag,channel}=distribution.plan;
    tagOrder(tag);
    assert.equal(channel,tag.includes('-beta.')?'beta':'stable');
    assert.ok(objects.length>=3,'Incomplete publication plan');
    const keys=new Set();
    for(const object of objects) {
        assert.match(object.key,/^(?:releases\/v\d+\.\d+\.\d+(?:-beta\.\d+)?\/[A-Za-z0-9][A-Za-z0-9._-]*|channels\/(?:stable|beta)\.json)$/);
        assert.ok(!keys.has(object.key),'Duplicate publication object');keys.add(object.key);
        const phase=object.key===`channels/${channel}.json`?'channel'
            :object.key===`releases/${tag}/release.json`?'catalogue'
            :object.key.startsWith(`releases/${tag}/`)?'asset':null;
        assert.ok(phase && object.phase===phase,'Publication phase or release identity differs');
        const bytes=await objectRecord(object.file,object.key,object.phase);
        assert.equal(bytes.size,object.size,'Sealed publication bytes changed');
        assert.equal(bytes.sha256,object.sha256,'Sealed publication bytes changed');
    }
    assert.equal(objects.at(-1).phase,'channel');
    assert.equal(objects.at(-2).phase,'catalogue');
    for(const object of objects.filter(item=>item.phase!=='channel')) {
        const progress=`[${objects.indexOf(object)+1}/${objects.length}] ${object.key}`;
        console.log(`SourceForge upload ${progress} (${object.size} bytes)`);
        await upload(object,{immutable:true});
        console.log(`SourceForge verify ${progress}`);
        await verify(object,{fetcher});
        console.log(`SourceForge verified ${progress} sha256=${object.sha256}`);
    }
    await preventDowngrade(distribution,fetcher);
    const pointer=objects.at(-1);
    console.log(`SourceForge upload [${objects.length}/${objects.length}] ${pointer.key} (${pointer.size} bytes)`);
    await upload(pointer,{immutable:false});
    console.log(`SourceForge verify [${objects.length}/${objects.length}] ${pointer.key}`);
    await verify(pointer,{fetcher});
    console.log(`SourceForge verified [${objects.length}/${objects.length}] ${pointer.key} sha256=${pointer.sha256}`);
}
export function sourceforgeUploader(configPath,output,{execute=execFileSync}={}) {
    assert.ok(configPath,'Set NORA_SOURCEFORGE_UPLOAD_CONFIG to a protected publisher configuration file');
    const stat=fs.lstatSync(configPath);
    assert.ok(stat.isFile()&&(stat.mode&0o077)===0,'Publisher configuration must be a regular private file');
    const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
    assert.equal(config.project,'nora-tavern');assert.match(config.username,/^[a-z0-9][a-z0-9-]{2,29}$/);
    for(const key of ['identityFile','knownHostsFile']) {
        assert.ok(path.isAbsolute(config[key])&&!/[\r\n\0]/.test(config[key]),`Invalid ${key}`);
        assert.ok(fs.lstatSync(config[key]).isFile(),`Missing ${key}`);
    }
    assert.ok((fs.statSync(config.identityFile).mode&0o077)===0,'SSH identity must be private');
    const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
    const ssh=['ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=30','-oServerAliveInterval=15','-oServerAliveCountMax=4',
        '-oControlMaster=auto','-oControlPersist=60',`-oControlPath=${path.join(path.dirname(config.identityFile),'publication-ssh')}`,
        `-oUserKnownHostsFile=${config.knownHostsFile}`,'-i',config.identityFile].map(quote).join(' ');
    return async(object,{immutable})=>{
        const key=sfKey(object.key);
        assert.match(key,/^(?:v\d+\.\d+\.\d+(?:-beta\.\d+)?\/[A-Za-z0-9][A-Za-z0-9._-]*|channels\/(?:stable|beta)\.json)$/);
        const stage=fs.mkdtempSync(path.join(output,'.sourceforge-upload-')),file=path.join(stage,key);
        try {
            fs.mkdirSync(path.dirname(file),{recursive:true});
            try {fs.linkSync(object.file,file);} catch(error) {
                if(error.code!=='EXDEV')throw error;
                fs.copyFileSync(object.file,file);
            }
            const args=['-rtR','--progress','--timeout=120','--partial-dir=.nora-partial',...(immutable?['--ignore-existing']:[]),'-e',ssh,'--',`${stage}/./${key}`,
                `${config.username}@frs.sourceforge.net:/home/frs/project/nora-tavern/`];
            for(let attempt=1;attempt<=3;attempt++)try {
                if(execute===execFileSync)await command('rsync',args);else await execute('rsync',args,{stdio:'inherit',timeout:45*60*1000});
                break;
            } catch(error){if(attempt===3||![10,12,30,35,255].includes(error.code))throw error;console.log(`SourceForge transfer retry ${attempt}/2: ${object.key}`);await new Promise(resolve=>setTimeout(resolve,attempt*2000));}
        } finally {fs.rmSync(stage,{recursive:true,force:true});}
    };
}

async function publish() {
const args=process.argv.slice(2),[rootArg,tag,commit]=args.splice(0,3);
const mode=args[0]&&!args[0].startsWith('--')?args.shift():'full';
assert.ok(rootArg,'Release assets root is required');
const options={stage:'seal',assetMode:'legacy',resume:false};
const names={'--stage':'stage','--state-dir':'stateDir','--asset-mode':'assetMode','--reuse-from':'reuseFrom','--expected-plan-id':'expectedPlanId'};
while(args.length){const name=args.shift();if(name==='--resume'){assert.ok(!options.resume,'Duplicate resume flag');options.resume=true;continue;}
    assert.ok(names[name]&&args[0]&&!args[0].startsWith('--'),`Invalid publication argument: ${name}`);assert.ok(!options['_'+name],`Duplicate ${name}`);options['_'+name]=true;options[names[name]]=args.shift();}
const root = path.resolve(rootArg);
const repository = process.env.GH_REPO;
assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
assert.ok(['seal','prepare','promote','all'].includes(options.stage));assert.ok(['legacy','shared'].includes(options.assetMode));
assert.ok(['full','components'].includes(mode),'Invalid delivery mode');
assert.match(commit,/^[a-f0-9]{40}$/);assert.match(tag,/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
assert.equal(execFileSync('git',['rev-parse','--verify',`refs/tags/${tag}^{commit}`],{encoding:'utf8'}).trim(),commit,'Tag differs from accepted product commit');
const stateDir=path.resolve(options.stateDir||root+'.publication');
const sourceRun=process.env.SOURCE_RUN||'local',publisherCommit=process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
let publication;
if(options.resume){
    assert.ok(!options.reuseFrom,'Resume uses the original sealed reuse baseline');
    if(process.env.CI)assert.ok(options.expectedPlanId,'CI resume requires the original plan id from its verified source artifact');
    publication=await loadPublication({root,stateDir,repository,tag,commit,mode,sourceRun,assetMode:options.assetMode,expectedPlanId:options.expectedPlanId});
} else {
    assert.ok(!options.expectedPlanId,'A new seal cannot claim an existing plan identity');
    assert.ok(!fs.existsSync(stateDir),'State directory already exists; restore and use --resume');
    fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
    const notes=path.join(stateDir,'authored-release-notes.md');
    run(process.execPath,['tooling/release/launcher-release-notes.cjs',root,tag,repository,`docs/releases/${tag}.md`,notes]);
    const distribution=await prepareDistribution({root,tag,commit,mode,repository,output:path.join(stateDir,'distribution'),
        body:fs.readFileSync(notes,'utf8'),assetMode:options.assetMode,reuseFrom:options.reuseFrom});
    process.stdout.write(distribution.verification);
    publication=await sealPublication(distribution,{root,stateDir,repository,sourceRun,publisherCommit,assetMode:options.assetMode});
}
const scratch=options.stage==='seal'?null:fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||path.dirname(stateDir),'nora-publication-transfer-'));
try {
    const providers=options.stage==='seal'?undefined:{
        sourceforge:sourceforgeProvider({upload:sourceforgeUploader(process.env.NORA_SOURCEFORGE_UPLOAD_CONFIG,scratch),readPublic,verifyObject:verifyDistributionObject,preventDowngrade}),
        github:githubProvider({repository})};
    const state=await executePublication(publication,{stage:options.stage,providers,publisherCommit});
    console.log(`Publication ${state.status}: ${tag} product=${commit} publisher=${publisherCommit} plan=${state.planId} state=${stateDir}`);
} finally {if(scratch)fs.rmSync(scratch,{recursive:true,force:true});}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await publish();
