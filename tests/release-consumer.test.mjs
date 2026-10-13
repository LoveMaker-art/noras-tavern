import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readConsumerAsar,verifyFinalConsumers} from '../tooling/release/final-consumer.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const targets=['darwin-arm64','darwin-x64','win32-x64'];
const repository='LoveMaker-art/noras-tavern';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const modules=['package.json','releases.js','launcher-update.js','release-network.js','release-sources.js',
    'release-sources.json','launcher-errors.js','telemetry-contract.json'];

function shippedModuleFixture(version, sources) {
    const files=new Map(modules.map(name=>[name,fs.readFileSync(path.join(root,
        name==='releases.js'?'deployment/update/releases.js':`launcher/desktop/${name}`))]));
    if(version) {
        // Future protocol fixture only; the authored package version is unchanged.
        const pkg=JSON.parse(files.get('package.json'));pkg.version=version;
        files.set('package.json',Buffer.from(JSON.stringify(pkg)));
    }
    if(sources) files.set('release-sources.json',Buffer.from(JSON.stringify(sources)));
    const dependencyRoot=process.env.NORA_TEST_DESKTOP_NODE_MODULES || path.join(root,'launcher/desktop/node_modules');
    function dependency(directory,prefix) {
        for(const name of fs.readdirSync(directory).sort()) {
            const file=path.join(directory,name),stat=fs.lstatSync(file);
            assert.ok(!stat.isSymbolicLink(),'Fixture dependencies must be real files');
            if(stat.isDirectory()) dependency(file,`${prefix}/${name}`);
            else if(stat.isFile()) files.set(`${prefix}/${name}`,fs.readFileSync(file));
        }
    }
    dependency(fs.realpathSync(path.join(dependencyRoot,'semver')),'node_modules/semver');
    return files;
}

function asarFixture(files,editHeader=()=>{}) {
    const header={files:{}},data=[];let offset=0;
    for(const [name,bytes] of [...files].sort(([a],[b])=>a.localeCompare(b))) {
        const parts=name.split('/');let node=header;
        for(const part of parts.slice(0,-1)) node=node.files[part] ||= {files:{}};
        node.files[parts.at(-1)]={size:bytes.length,offset:String(offset),integrity:{algorithm:'SHA256',hash:hash(bytes)}};
        data.push(bytes);offset+=bytes.length;
    }
    editHeader(header);
    const text=Buffer.from(JSON.stringify(header)),headerSize=8+Math.ceil(text.length/4)*4;
    const prefix=Buffer.alloc(8+headerSize);
    prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(headerSize,4);
    prefix.writeUInt32LE(headerSize-4,8);prefix.writeUInt32LE(text.length,12);text.copy(prefix,16);
    return Buffer.concat([prefix,...data]);
}

function zipFixture(directory,asar,target,{memberNames}={}) {
    const source=path.join(directory,`consumer-${target}.asar`),archive=path.join(directory,`launcher-${target}.zip`);
    fs.writeFileSync(source,asar);
    const names=memberNames || [target.startsWith('darwin')?'NoraFixture.app/Contents/Resources/app.asar':'resources/app.asar'];
    // Deterministic minimal ZIP container, without Electron/runtime construction.
    execFileSync(process.env.NORA_TEST_PYTHON || process.env.NORA_PYTHON || (process.platform==='win32'?'python':'python3'),['-B','-c',
        `import json,sys,zipfile
data=open(sys.argv[1],'rb').read()
with zipfile.ZipFile(sys.argv[2],'w') as archive:
 for name in json.loads(sys.argv[3]):
  entry=zipfile.ZipInfo(name,(2020,1,1,0,0,0));entry.compress_type=zipfile.ZIP_STORED
  archive.writestr(entry,data)
`,source,archive,JSON.stringify(names)],{timeout:10000,windowsHide:true});
    return fs.readFileSync(archive);
}

function distributionFixture(t,{shared=false,badRootSelection=false,zipMembers,bindingDrift=false,sources}={}) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-final-consumer-test-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const captured=JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(path.join(root,
        'tests/deployment/fixtures/published-v2.4.4/metadata.json.br'))));
    const files=new Map(Object.entries(captured.files).map(([name,text])=>[name,Buffer.from(text)]));
    const provenance=JSON.parse(fs.readFileSync(path.join(root,'tests/deployment/fixtures/published-v2.4.4/provenance.json')));
    for(const item of provenance.files) assert.equal(hash(files.get(item.name)),item.sha256);
    const tag=captured.release.tag_name,commit=JSON.parse(files.get('release-manifest.json')).commit;
    const release=captured.release,references=[];
    const url=(name,source=tag)=>`https://github.com/${repository}/releases/download/${source}/${name}`;
    const closure=shippedModuleFixture(shared?'2.1.2':undefined,sources),pkg=JSON.parse(closure.get('package.json'));
    if(shared) {
        // Future shared protocol: retain platform routing while moving only
        // environment archives to older, digest-bound objects. Payload objects
        // are not read by this metadata-only gate and are explicit test doubles.
        for(const name of ['release-manifest.json',...targets.map(target=>`${target}-release-manifest.json`)]) {
            const manifest=JSON.parse(files.get(name));manifest.launcherVersion=pkg.version;
            manifest.bootstrap.minimumLauncherVersion=pkg.version;files.set(name,Buffer.from(JSON.stringify(manifest)));
        }
        for(const target of targets) {
            const name=`nora-system-${target}.json`,system=JSON.parse(files.get(name));
            system.minimumLauncherVersion=pkg.version;system.launcherVersion=pkg.version;
            const manifest=system.files['release-manifest.json'];
            manifest.sha256=hash(files.get(manifest.asset));manifest.size=files.get(manifest.asset).length;
            const [,environment]=Object.entries(system.files).find(([name])=>/^nora-hermes-runtime-.+\.(?:tar\.gz|zip)$/.test(name));
            references.push({name:environment.asset,asset_release_tag:'v2.4.3',size:environment.size,sha256:environment.sha256});
            files.set(name,Buffer.from(JSON.stringify(system)));
        }
        release.assets=release.assets.filter(asset=>!references.some(item=>item.name===asset.name));
        files.set('release-assets.json',Buffer.from(JSON.stringify({schema:'nora-release-assets/1',repository,tag,commit,
            minimumLauncherVersion:pkg.version,assets:references})));
    }
    // Synthetic final assembly derived from the public layout: an actual
    // current selector cannot borrow the frozen release's old module proof.
    // Bind the copied source bytes and recompute only metadata identities;
    // keep every original platform archive/module descriptor SHA unchanged.
    for(const name of ['release-manifest.json',...targets.map(target=>`${target}-release-manifest.json`)]) {
        const manifest=JSON.parse(files.get(name));
        for(const module of modules.filter(name=>name!=='package.json'))
            manifest.artifacts[`ops/installer/desktop/${module}`]=hash(closure.get(module));
        files.set(name,Buffer.from(JSON.stringify(manifest)));
    }
    for(const target of targets) {
        const name=`nora-system-${target}.json`,system=JSON.parse(files.get(name)),manifest=system.files['release-manifest.json'];
        manifest.sha256=hash(files.get(manifest.asset));manifest.size=files.get(manifest.asset).length;
        files.set(name,Buffer.from(JSON.stringify(system)));
    }
    if(badRootSelection) {
        // The final descriptor chooses the root entity but still requires the
        // exact published platform bytes. Both candidate bodies remain real.
        const name='nora-system-darwin-arm64.json',system=JSON.parse(files.get(name));
        system.files['release-manifest.json'].asset='release-manifest.json';
        files.set(name,Buffer.from(JSON.stringify(system)));
    }
    if(bindingDrift) closure.set('releases.js',Buffer.concat([closure.get('releases.js'),Buffer.from('\n')]));
    const asar=asarFixture(closure);
    for(const target of targets) {
        const name=`Nora-Tavern-Launcher-${pkg.version}-${target}-update.zip`;
        const bytes=zipFixture(directory,asar,target,{memberNames:zipMembers});files.set(name,bytes);
        files.set(`nora-launcher-${target}.json`,Buffer.from(JSON.stringify({schema:'nora-launcher/v1',candidate:false,commit,
            platform:target.split('-')[0],arch:target.split('-')[1],version:pkg.version,asset:name,sha256:hash(bytes),size:bytes.length})));
    }
    // Non-read payload records model the existing publication-state seam; no
    // private logs, runtime files or large archives are needed by selectPlan.
    const unreadPayloadObjects=release.assets.filter(asset=>!files.has(asset.name)).map(asset=>({
        phase:'asset',key:`releases/${tag}/${asset.name}`,file:path.join(directory,'unread-payload',asset.name),
        size:asset.size,sha256:asset.digest.slice(7)}));
    const objects=[...unreadPayloadObjects];
    for(const [name,bytes] of files) {
        const file=path.join(directory,name);fs.writeFileSync(file,bytes);
        objects.push({phase:'asset',key:`releases/${tag}/${name}`,file,size:bytes.length,sha256:hash(bytes)});
        const advertised={name,state:'uploaded',size:bytes.length,digest:`sha256:${hash(bytes)}`,browser_download_url:url(name)};
        const previous=release.assets.findIndex(asset=>asset.name===name);
        if(previous===-1)release.assets.push(advertised);else release.assets[previous]=advertised;
    }
    for(const reference of references) objects.push({phase:'asset',key:`releases/${reference.asset_release_tag}/${reference.name}`,
        file:path.join(directory,'unread-reference',reference.name),size:reference.size,sha256:reference.sha256,
        assetReleaseTag:reference.asset_release_tag,reference:true});
    return {directory,asar,closure,release,plan:{repository,tag,commit,mode:'full',assetMode:shared?'shared':'legacy',channel:'stable',
        destinations:['github','jihulab','sourceforge'],objects}};
}

function rewriteMetadata(fixture,name,change) {
    const object=fixture.plan.objects.find(object=>object.key.endsWith('/'+name));
    const value=JSON.parse(fs.readFileSync(object.file));change(value);
    const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(object.file,bytes);
    object.size=bytes.length;object.sha256=hash(bytes);
    const asset=fixture.release.assets.find(asset=>asset.name===name);asset.size=object.size;asset.digest=`sha256:${object.sha256}`;
}

test('synthetic final assembly reads actual shipped modules and public platform routing, with a deterministic receipt',async t=>{
    const fixture=distributionFixture(t),first=await verifyFinalConsumers(fixture),second=await verifyFinalConsumers(fixture);
    assert.deepEqual(second,first);
    assert.equal(first.scope,'shipped-selector-with-final-distribution-metadata');
    for(const target of targets) {
        const proof=first.platforms[target];
        assert.equal(proof.asarSha256,hash(fixture.asar));
        assert.equal(proof.moduleHashes['releases.js'],hash(fixture.closure.get('releases.js')));
        assert.equal(proof.modes.install.manifest,`${target}-release-manifest.json`);
        assert.equal(proof.modes.update.manifest,'release-manifest.json');
        assert.notEqual(proof.modes.install.manifestSha256,proof.modes.update.manifestSha256);
        assert.ok(proof.metadata.some(item=>item.url.endsWith(`/nora-system-${target}.json`)));
    }
});

test('final consumer gate uses the shipped domestic roots for sealed catalogue and platform metadata',async t=>{
    const sources={schema:1,primary:'jihulab',mirrors:[{id:'jihulab',provider:'jihulab',
        baseUrl:'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/',
        channelBaseUrl:'https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/'},
        {id:'sourceforge',provider:'sourceforge',baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]};
    const fixture=distributionFixture(t,{sources}),report=await verifyFinalConsumers(fixture);
    for(const target of targets) {
        const proof=report.platforms[target];
        assert.ok(proof.metadata.length>0);
        assert.ok(proof.metadata.every(item=>item.url.startsWith(sources.mirrors[0].baseUrl)),
            'an available domestic source must not silently exercise GitHub instead');
        assert.equal(proof.moduleHashes['release-sources.json'],hash(fixture.closure.get('release-sources.json')));
        assert.equal(proof.modes.install.manifest,`${target}-release-manifest.json`);
    }
});

test('a publication cannot leave the shipped domestic primary channel stale',async t=>{
    const sources={schema:1,primary:'jihulab',mirrors:[{id:'jihulab',provider:'jihulab',
        baseUrl:'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/',
        channelBaseUrl:'https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/'}]};
    for(const explicit of [true,false])await t.test(explicit?'explicit primary':'implicit mirror primary',async child=>{
        const configured=structuredClone(sources);if(!explicit)delete configured.primary;
        const fixture=distributionFixture(child,{sources:configured});fixture.plan.destinations=['github'];
        await assert.rejects(verifyFinalConsumers(fixture),/primary source jihulab.*destinations/);
    });
    const githubOnly=distributionFixture(t,{sources:{schema:1,mirrors:[]}});githubOnly.plan.destinations=['github'];
    const report=await verifyFinalConsumers(githubOnly);assert.equal(Object.keys(report.platforms).length,3);
});

test('legacy omitted destinations retain the GitHub and SourceForge primary gate',async t=>{
    const jihulab={id:'jihulab',provider:'jihulab',
        baseUrl:'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/',
        channelBaseUrl:'https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/'};
    const domestic=distributionFixture(t,{sources:{schema:1,primary:'jihulab',mirrors:[jihulab]}});
    delete domestic.plan.destinations;
    await assert.rejects(verifyFinalConsumers(domestic),/primary source jihulab.*destinations/);
    for(const primary of ['github','sourceforge'])await t.test(primary,async child=>{
        const legacy=distributionFixture(child,{sources:{schema:1,primary,mirrors:[{id:'sourceforge',provider:'sourceforge',
            baseUrl:'https://downloads.sourceforge.net/project/nora-tavern/'}]}});
        delete legacy.plan.destinations;
        const report=await verifyFinalConsumers(legacy);assert.equal(Object.keys(report.platforms).length,3);
    });
});

test('the final ZIP cannot borrow an accepted payload proof for different selector bytes',async t=>{
    const fixture=distributionFixture(t,{bindingDrift:true});
    await assert.rejects(verifyFinalConsumers(fixture),/Shipped consumer module differs from accepted payload: releases\.js/);
});

test('catalogue target and selected product commit must agree with the sealed plan',async t=>{
    for(const kind of ['tag','commit']) await t.test(kind,async t=>{
        const fixture=distributionFixture(t);
        if(kind==='tag')fixture.release.tag_name='v2.4.5';else fixture.plan.commit='a'.repeat(40);
        await assert.rejects(verifyFinalConsumers(fixture),/目标发布与所选版本不一致|Consumer selected a different product|product commit differs/);
    });
});

test('a descriptor for the current launcher still requires exact platform, version, source and production identity',async t=>{
    for(const [name,change] of [
        ['schema',descriptor=>{descriptor.schema='other/v1';}],
        ['platform',descriptor=>{descriptor.platform='win32';}],
        ['arch',descriptor=>{descriptor.arch='x64';}],
        ['candidate',descriptor=>{descriptor.candidate=true;}],
        ['version',descriptor=>{descriptor.version='9.9.9';}],
        ['commit',descriptor=>{descriptor.commit='a'.repeat(40);}]
    ]) await t.test(name,async t=>{
        const fixture=distributionFixture(t);rewriteMetadata(fixture,'nora-launcher-darwin-arm64.json',change);
        await assert.rejects(verifyFinalConsumers(fixture),/Final consumer acceptance failed/);
    });
});

test('a final platform descriptor selecting root bytes with the platform hash is rejected',async t=>{
    const fixture=distributionFixture(t,{badRootSelection:true});
    await assert.rejects(verifyFinalConsumers(fixture),/Final consumer gate failed for darwin-arm64: 完整系统与固定发布清单校验信息不符/);
});

test('sealed metadata changed after the fixture is captured is rejected by the actual consumer read',async t=>{
    const fixture=distributionFixture(t),object=fixture.plan.objects.find(object=>object.key.endsWith('/darwin-arm64-release-manifest.json'));
    fs.appendFileSync(object.file,' ');
    await assert.rejects(verifyFinalConsumers(fixture),/sealed metadata size changed/);
});

test('shared protocol is expanded by the shipped lookup while all control manifests stay current',async t=>{
    const fixture=distributionFixture(t,{shared:true}),report=await verifyFinalConsumers(fixture);
    for(const target of targets) {
        const proof=report.platforms[target];
        assert.equal(proof.launcherVersion,'2.1.2');assert.equal(proof.modes.install.manifest,`${target}-release-manifest.json`);
        assert.equal(proof.modes.update.manifest,'release-manifest.json');
        assert.ok(proof.metadata.some(item=>item.url.endsWith('/v2.4.4/release-assets.json')));
        assert.ok(proof.metadata.every(item=>!item.url.includes('/v2.4.3/')),'Metadata selection must not download referenced payloads');
    }
});

test('ASAR parsing refuses linked, unpacked, escaping and integrity-changed consumer members',async t=>{
    const files=shippedModuleFixture();assert.equal(hash(readConsumerAsar(asarFixture(files)).get('releases.js')),hash(files.get('releases.js')));
    for(const [name,edit] of [
        ['linked',header=>{header.files['releases.js'].link='../outside.js';}],
        ['unpacked',header=>{header.files['releases.js'].unpacked=true;}],
        ['escaping',header=>{header.files['releases.js'].offset='999999999';}],
        ['oversize',header=>{header.files['releases.js'].size=8*1024*1024+1;}],
        ['traversal',header=>{header.files.node_modules.files.semver.files['..']={files:{}};}],
        ['integrity',header=>{header.files['releases.js'].integrity.hash='0'.repeat(64);}]
    ]) await t.test(name,()=>assert.throws(()=>readConsumerAsar(asarFixture(files,edit))));
    const invalidHeader=asarFixture(files);invalidHeader.writeUInt32LE(invalidHeader.length,4);
    assert.throws(()=>readConsumerAsar(invalidHeader));
});

test('the ZIP gate refuses ambiguous app.asar members and path traversal',async t=>{
    for(const memberNames of [['resources/app.asar','Other.app/Contents/Resources/app.asar'],['../Nora.app/Contents/Resources/app.asar']])
        await t.test(memberNames.join(','),async t=>{
            const fixture=distributionFixture(t,{zipMembers:memberNames});
            await assert.rejects(verifyFinalConsumers(fixture),/Expected exactly one shipped|AssertionError/);
        });
});
