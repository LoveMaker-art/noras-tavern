import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
export async function prepareDistribution({root, tag, commit, mode='full', repository='LoveMaker-art/noras-tavern', output=root+'.distribution',body='',publishedAt=new Date().toISOString()}) {
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
    const beta=tag.includes('-beta.'),channel=beta?'beta':'stable';
    assert.ok(Number.isFinite(Date.parse(publishedAt)), 'Invalid publication date');
    assert.equal(typeof body,'string');
    const release={tag_name:tag,draft:false,prerelease:beta,body,published_at:publishedAt,assets:objects.map((item,index)=>({name:assets[index][0],state:'uploaded',size:item.size,
        digest:`sha256:${item.sha256}`,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/${assets[index][0]}`}))};
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
async function readPublic(key,fetcher,timeout=1800000) {
    const url=sfRoot+sfKey(key);
    return sourceReader()(fetcher,{provider:'sourceforge',origin:new URL(sfRoot).origin,mirror:true,url},url,
        {signal:AbortSignal.timeout(timeout),headers:{'Accept-Encoding':'identity'}});
}
export async function verifyDistributionObject(object,{fetcher=fetch}={}) {
    const response=await readPublic(object.key,fetcher);
    assert.ok(response.ok&&response.body,`SourceForge object unavailable: ${object.key} (HTTP ${response.status})`);
    const hash=crypto.createHash('sha256');let size=0;
    for await(const chunk of response.body) {
        size+=chunk.length;
        assert.ok(size<=object.size,`SourceForge object too large: ${object.key}`);
        hash.update(chunk);
    }
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
        await upload(object,{immutable:true});await verify(object,{fetcher});
    }
    await preventDowngrade(distribution,fetcher);
    const pointer=objects.at(-1);
    await upload(pointer,{immutable:false});await verify(pointer,{fetcher});
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
    const ssh=['ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes',`-oUserKnownHostsFile=${config.knownHostsFile}`,'-i',config.identityFile].map(quote).join(' ');
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
            execute('rsync',['-rtR',...(immutable?['--ignore-existing']:[]),'-e',ssh,'--',`${stage}/./${key}`,
                `${config.username}@frs.sourceforge.net:/home/frs/project/nora-tavern/`],{stdio:'inherit'});
        } finally {fs.rmSync(stage,{recursive:true,force:true});}
    };
}

async function publish() {
const [rootArg, tag, commit, mode = 'full'] = process.argv.slice(2);
const root = path.resolve(rootArg);
const repository = process.env.GH_REPO;
assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const notes = path.join(root, 'release-notes.generated.md');
run(process.execPath, ['tooling/release/launcher-release-notes.cjs', root, tag, repository, `docs/releases/${tag}.md`, notes]);
const distribution=await prepareDistribution({root,tag,commit,mode,repository,body:fs.readFileSync(notes,'utf8')});
process.stdout.write(distribution.verification);
const upload=sourceforgeUploader(process.env.NORA_SOURCEFORGE_UPLOAD_CONFIG,distribution.output);
await publishDistribution(distribution,{upload});
const beta = tag.includes('-beta.');
// A failed upload leaves a draft, never a partially published latest release.
run('gh', ['release', 'create', tag, '--verify-tag', '--draft', ...(beta ? ['--prerelease'] : []),
    '--title', `诺拉·酒馆 ${tag}${beta ? ' 测试版' : ''}`, '--notes-file', notes]);
for (const {file} of distribution.plan.objects.filter(item=>item.phase==='asset')) {
    run('gh', ['release', 'upload', tag, file]);
}
run('gh', ['release', 'edit', tag, '--draft=false', `--prerelease=${beta}`, `--latest=${!beta}`]);
console.log(`SourceForge distribution verified: ${distribution.output}; GitHub release published.`);
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await publish();
