import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const COMPONENT_VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
// A first install records the verified dependency metadata in its local copy of
// the manifest, then serializes it without the release file's final newline.
// Keep this finite, reproducible representation separate from release identity.
export function coreReceiptRepresentations(sourceBytes,{dependenciesBytes,dependencyEntry,platform,arch}={}) {
    const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
    const source=JSON.parse(sourceBytes),sourceManifestSha256=sha(sourceBytes);
    const representations=[{kind:'release-bytes',sha256:sourceManifestSha256}];
    if(dependenciesBytes!==undefined||dependencyEntry!==undefined){
        assert.ok(dependenciesBytes&&dependencyEntry,'Missing authenticated dependency metadata');
        assert.ok(dependenciesBytes.length>0&&dependenciesBytes.length<=4*1024*1024);
        assert.equal(dependenciesBytes.length,dependencyEntry.size,'Dependency metadata size differs');
        assert.equal(sha(dependenciesBytes),dependencyEntry.sha256,'Dependency metadata SHA differs');
        const dependencies=JSON.parse(dependenciesBytes);
        assert.equal(dependencies.schema,1);assert.equal(dependencies.platform,platform);assert.equal(dependencies.arch,arch);
        assert.match(dependencies.archive||'',/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/);
        assert.match(dependencies.sha256||'',/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(dependencies.size)&&dependencies.size>0);
        if(Object.hasOwn(source,'integratedDependencies'))assert.deepEqual(source.integratedDependencies,dependencies,'Core dependency declaration differs');
        const installed=Object.hasOwn(source,'integratedDependencies')?source:{...source,integratedDependencies:dependencies};
        representations.push({kind:'first-install',sha256:sha(JSON.stringify(installed,null,2))});
    }
    return {sourceManifestSha256,representations};
}
export function releasePublicationTag(identity) {
    const core=identity.versions?.tavern ?? identity.version;
    if(typeof core!=='string'||!COMPONENT_VERSION.test(core))throw new Error('Missing canonical core version');
    if(!Object.hasOwn(identity,'publication'))return `v${core}`;
    const value=identity.publication;
    if(!value||Object.keys(value).length!==2||value.schema!=='nora-component-publication/1'
        ||typeof value.tag!=='string'||!value.tag.startsWith('v')||!COMPONENT_VERSION.test(value.tag.slice(1)))
        throw new Error('Invalid component publication identity');
    return value.tag;
}

// The root describes the current product/APP and maintenance runner. Only this
// exact reference may bind an unchanged, separately sealed core payload.
export function coreReleaseIdentity(product,platform) {
    if(!Object.hasOwn(product,'coreRelease'))return null;
    const value=product.coreRelease,target=/^[a-z][a-z0-9_]{0,31}-[a-z0-9_]{1,32}$/;
    const exact=(item,keys)=>item&&typeof item==='object'&&!Array.isArray(item)
        &&Object.keys(item).sort().join(',')===[...keys].sort().join(',');
    if(!product.publication||!exact(value,['schema','tag','commit','manifests'])||value.schema!=='nora-core-reference/1'
        ||!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.tag||'')
        ||!/^[a-f0-9]{40}$/.test(value.commit||'')||!value.manifests||Array.isArray(value.manifests)
        ||!Object.keys(value.manifests).length||Object.keys(value.manifests).some(name=>!target.test(name)))
        throw new Error('Invalid explicit core release reference');
    const publication=releasePublicationTag(product),before=value.tag.slice(1).split('.').map(Number),after=publication.slice(1).split('-')[0].split('.').map(Number);
    const difference=before.findIndex((number,index)=>number!==after[index]);
    if(difference<0||before[difference]>=after[difference])throw new Error('Core reference must retain an older publication');
    for(const [target,entry] of Object.entries(value.manifests))if(!exact(entry,['asset','sha256','size'])
        ||entry.asset!==`${target}-release-manifest.json`||!/^[a-f0-9]{64}$/.test(entry.sha256||'')
        ||!Number.isSafeInteger(entry.size)||entry.size<1||entry.size>4*1024*1024)
        throw new Error('Invalid bound platform core manifest');
    if(platform!==undefined&&!value.manifests[platform])throw new Error('Missing bound platform core manifest');
    return structuredClone(value);
}
// Stable core discovery remains readable by public clients which predate
// component publications. APP-only has one separate, fixed-purpose pointer.
export function publicationCoreAnchor(product) {
    const ref=coreReleaseIdentity(product);if(!ref)return null;
    if(releasePublicationTag(product).includes('-')||ref.tag!==`v${product.versions?.tavern}`)
        throw new Error('APP-only legacy discovery requires a stable ordinary core anchor; Beta is not supported');
    return {tag:ref.tag,commit:ref.commit};
}
export function publicationChannelKey(plan) {
    assert.ok(['stable','beta'].includes(plan.channel),'Invalid publication channel');
    if(!Object.hasOwn(plan,'coreAnchor'))return `channels/${plan.channel}.json`;
    const value=plan.coreAnchor;
    assert.ok(plan.channel==='stable'&&value&&Object.keys(value).sort().join(',')==='commit,tag','Invalid APP-only core anchor');
    assert.match(value.tag||'',/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,'Invalid APP-only core anchor tag');
    assert.match(value.commit||'',/^[a-f0-9]{40}$/,'Invalid APP-only core anchor commit');
    const before=value.tag.slice(1).split('.').map(Number),after=String(plan.tag).slice(1).split('.').map(Number);
    const i=before.findIndex((v,i)=>v!==after[i]);
    assert.ok(after.length===3&&after.every(Number.isSafeInteger)&&i>=0&&before[i]<after[i],'APP-only publication must follow its core anchor');
    return 'channels/launcher-stable.json';
}
// Infer the fixed channel set from sealed objects. Historical ordinary plans
// retain their one-pointer contract; new producers include both stable heads.
export function publicationChannelObjects(plan) {
    const primary=publicationChannelKey(plan),objects=plan.objects.filter(item=>item.phase==='channel');
    const keys=objects.map(item=>item.key),dual=plan.channel==='stable'&&!plan.coreAnchor&&objects.length===2;
    assert.deepEqual(keys,dual?['channels/stable.json','channels/launcher-stable.json']:[primary],
        'Different sealed publication channel phase/identity');
    return objects;
}
export async function verifyPublishedCoreAnchor(plan,readBytes) {
    publicationChannelKey(plan);if(!plan.coreAnchor)return;
    const head=JSON.parse(await readBytes('channels/stable.json'));
    assert.ok(head&&head.draft===false&&head.prerelease===false&&head.tag_name===plan.coreAnchor.tag,'Published core anchor differs');
    const matches=head.assets?.filter(item=>item.name==='release-manifest.json');
    assert.ok(matches?.length===1,'Published core anchor has no unique manifest');
    const asset=matches[0];assert.ok(asset.state==='uploaded'&&Number.isSafeInteger(asset.size)&&asset.size>0&&asset.size<=4*1024*1024,'Invalid core anchor manifest size');
    assert.match(asset.digest||'',/^sha256:[a-f0-9]{64}$/,'Missing core anchor manifest digest');
    assert.equal(asset.browser_download_url,`https://github.com/LoveMaker-art/noras-tavern/releases/download/${head.tag_name}/release-manifest.json`,'Different core anchor manifest origin');
    const bytes=await readBytes(`releases/${head.tag_name}/release-manifest.json`);
    assert.equal(bytes.length,asset.size,'Different core anchor manifest size');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.digest.slice(7),'Different core anchor manifest SHA');
    const manifest=JSON.parse(bytes);
    assert.ok(manifest.schema==='tavern-release/v2'&&!manifest.candidate&&!manifest.coreRelease
        &&manifest.commit===plan.coreAnchor.commit&&`v${manifest.versions?.tavern}`===head.tag_name
        &&releasePublicationTag(manifest)===head.tag_name,'Published core anchor identity differs');
}

export function assertCoreReleasePayload(product,bytes,platform,entry) {
    const reference=coreReleaseIdentity(product,platform);
    if(!reference)return null;
    const declared=reference.manifests[platform],actual=JSON.parse(bytes);
    if(entry&&JSON.stringify(Object.fromEntries(Object.entries(entry).sort()))!==JSON.stringify(Object.fromEntries(Object.entries(declared).sort())))
        throw new Error('Platform system differs from its bound core manifest');
    if(bytes.length!==declared.size||crypto.createHash('sha256').update(bytes).digest('hex')!==declared.sha256
        ||actual.schema!=='tavern-release/v2'||actual.candidate!==false||actual.dirty!==false||actual.coreRelease
        ||actual.commit!==reference.commit||actual.versions?.tavern!==(product.versions?.tavern??product.version)
        ||releasePublicationTag(actual)!==reference.tag)throw new Error('Core payload differs from its explicit source identity');
    return actual;
}

// No default compatibility is inferred from a version, build, or protocol.
// Actual native acceptance and local identities remain separate release gates.
export function configurePublication(identity,{publicationTag,updateCompatibility}={}) {
    const result={...identity};
    if(publicationTag!==undefined)result.publication={schema:'nora-component-publication/1',tag:publicationTag};
    releasePublicationTag(result);
    if(updateCompatibility!==undefined){
        const value=updateCompatibility,capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
        const list=(versions,{stable=false}={})=>Array.isArray(versions)&&versions.length>0&&versions.length<=32
            &&new Set(versions).size===versions.length&&versions.every(version=>typeof version==='string'
                &&COMPONENT_VERSION.test(version)&&(!stable||!version.includes('-')));
        if(!value||value.schema!=='nora-core-launcher-compatibility/1'||value.coreVersion!==identity.versions?.tavern
            ||Object.keys(value).some(key=>!['schema','coreVersion','launcherVersions','previousCoreVersions','capabilities'].includes(key))
            ||!list(value.launcherVersions,{stable:true})
            ||identity.launcherVersion!==undefined&&!value.launcherVersions.includes(identity.launcherVersion)
            ||value.previousCoreVersions!==undefined&&!list(value.previousCoreVersions)
            ||!value.capabilities||Object.keys(value.capabilities).length!==Object.keys(capabilities).length
            ||Object.entries(capabilities).some(([name,expected])=>value.capabilities[name]!==expected))
            throw new Error('Invalid explicitly supplied core/launcher compatibility declaration');
        result.updateCompatibility=structuredClone(value);
    }
    return result;
}

export function readPublicationCompatibility(root,identity,{compatibilityFile='',candidate=false}={}) {
    // The filename is selected automatically, but compatibility itself is never
    // inferred. A new version must bring its explicitly reviewed declaration.
    if(!compatibilityFile)compatibilityFile=`tooling/release/compatibility/v${identity.versions?.tavern}.json`;
    if(typeof compatibilityFile!=='string'||!/^tooling\/release\/compatibility\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(compatibilityFile))
        throw new Error('Compatibility input must be a reviewed repository JSON under tooling/release/compatibility/');
    let current=path.resolve(root);
    for(const part of compatibilityFile.split('/')){
        current=path.join(current,part);
        if(!fs.existsSync(current))throw new Error(`Missing reviewed compatibility declaration: ${compatibilityFile}`);
        const stat=fs.lstatSync(current);
        if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw new Error('Compatibility input cannot traverse links');
    }
    const stat=fs.lstatSync(current);
    if(!stat.isFile()||stat.size<1||stat.size>64*1024)throw new Error('Compatibility JSON must be a bounded regular file');
    const bytes=fs.readFileSync(current);
    if(!candidate){
        const git=args=>execFileSync('git',args,{cwd:root,maxBuffer:128*1024,stdio:['ignore','pipe','pipe']});
        const commit=git(['rev-parse','--verify','HEAD^{commit}']).toString().trim();
        const tree=git(['ls-tree',commit,'--',compatibilityFile]).toString();
        if(!tree.startsWith('100644 blob '))throw new Error('Compatibility input must be a committed regular JSON');
        const committed=git(['show',`${commit}:${compatibilityFile}`]);
        if(!bytes.equals(committed))throw new Error('Compatibility input differs from the fixed source commit');
    }
    const {updateCompatibility}=configurePublication(identity,{updateCompatibility:JSON.parse(bytes)});
    return {compatibilityFile,updateCompatibility,compatibilitySha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}

export function workflowPublicationOptions(root,{publicationTag='',compatibilityFile='',refType,refName}={}) {
    const coreVersion=fs.readFileSync(path.join(root,'app/.tavern-release-version'),'utf8').trim();
    const launcherVersion=JSON.parse(fs.readFileSync(path.join(root,'launcher/desktop/package.json'),'utf8')).version;
    const identity={versions:{tavern:coreVersion},launcherVersion};
    const tag=releasePublicationTag(configurePublication(identity,{...(publicationTag?{publicationTag}:{})}));
    if(refType==='tag'&&refName!==tag)throw new Error('Requested publication differs from the immutable Git tag');
    const selected=readPublicationCompatibility(root,identity,{compatibilityFile});
    return {tag,coreVersion,explicit:Boolean(publicationTag),compatibilityFile:selected.compatibilityFile,
        compatibilitySha256:selected.compatibilitySha256};
}

// Released launchers through 2.0.2 predate the registered executor protocol.
// Candidate labels may be reused locally; they cannot establish compatibility
// for a public release. The first public version is chosen at delivery.
const LAST_LEGACY_LAUNCHER = [2, 0, 2];
const compareVersion = (left, right) => {
    for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return Math.sign(left[index] - right[index]);
    return 0;
};
export function assertMaintenanceVersions({ launcherVersion, minimumLauncherVersion, candidate = false }) {
    const parse = value => {
        if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
            throw new Error('Missing or invalid maintenance launcher version');
        const parts = value.split('.').map(Number);
        if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid maintenance launcher version');
        return parts;
    };
    const launcher = parse(launcherVersion), minimum = parse(minimumLauncherVersion);
    if (compareVersion(minimum, launcher) > 0) throw new Error('Maintenance minimum exceeds the bundled launcher version');
    if (!candidate && compareVersion(minimum, LAST_LEGACY_LAUNCHER) <= 0)
        throw new Error('The new maintenance protocol cannot advertise legacy launchers through 2.0.2; choose a new public launcher version');
    return minimumLauncherVersion;
}

export function fileDigest(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
        let length;
        while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
}

export function configureCandidateLauncher({ packageFile, payload, identity, telemetryEnabled = false }) {
    if (!identity.candidate) return;
    const systemBytes = fs.readFileSync(path.join(payload, 'nora-system.json'));
    const system = JSON.parse(systemBytes);
    if (system.candidate !== true || system.commit !== identity.commit || system.version !== identity.versions.tavern) {
        throw new Error('Candidate launcher identity does not match its payload');
    }
    const desktop = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const installationId = desktop.noraTestInstallationId || `candidate-${identity.commit.slice(0, 12)}${telemetryEnabled ? '-telemetry' : ''}`;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(installationId)) throw new Error('Invalid candidate installation identity');
    delete desktop.noraReleaseChannel;
    desktop.noraLocalTest = { schema: 1, buildId: installationId,
        systemManifestSha256: crypto.createHash('sha256').update(systemBytes).digest('hex'),
        ...(telemetryEnabled ? { telemetryEnabled: true } : {}) };
    desktop.build.appId = 'art.lovemaker.nora-tavern-launcher.local-test';
    desktop.build.productName = '诺拉·酒馆测试版';
    desktop.build.artifactName = `Nora-Tavern-${system.version}-test-\${os}-\${arch}.\${ext}`;
    desktop.build.nsis.artifactName = `Nora-Tavern-${system.version}-test-win-\${arch}-setup.\${ext}`;
    fs.writeFileSync(packageFile, JSON.stringify(desktop, null, 2) + '\n');
}

// Each platform publishes unique names; no shared manifest is overwritten by another build.
export function writeSystemRelease({ release, payload, identity, launcherVersion, minimumLauncherVersion = identity.bootstrap?.minimumLauncherVersion }) {
    const runtime = identity.hermesRuntime;
    if (!runtime) return null;
    assertMaintenanceVersions({ launcherVersion, minimumLauncherVersion, candidate: identity.candidate === true });
    const platform = `${runtime.platform}-${runtime.arch}`;
    const output = path.join(release, 'system-assets');
    fs.mkdirSync(output, { recursive: true });
    const files = {};
    for (const name of fs.readdirSync(payload)) {
        const file = path.join(payload, name);
        if (!fs.statSync(file).isFile() || name === 'nora-system.json') continue;
        const asset = `${platform}-${name}`;
        fs.copyFileSync(file, path.join(output, asset));
        files[name] = { asset, sha256: fileDigest(file), size: fs.statSync(file).size };
    }
    if(identity.coreRelease)assertCoreReleasePayload(identity,fs.readFileSync(path.join(payload,'release-manifest.json')),platform,files['release-manifest.json']);
    const manifest = {
        schema: 'nora-system/v1', version: identity.versions.tavern, commit: identity.commit,
        candidate: Boolean(identity.candidate), platform: runtime.platform, arch: runtime.arch,
        channel: /-beta\./.test(releasePublicationTag(identity)) ? 'beta' : 'stable',
        launcherVersion, minimumLauncherVersion, components: identity.versions, files,
        launcherCapabilities:identity.launcherCapabilities,
        updaterCapabilities:identity.updaterCapabilities,
        ...(identity.publication?{publication:identity.publication}:{}),
        ...(identity.coreRelease?{coreRelease:coreReleaseIdentity(identity,platform)}:{}),
        ...(identity.updateCompatibility?{updateCompatibility:identity.updateCompatibility}:{}),
    };
    const bytes = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(path.join(output, `nora-system-${platform}.json`), bytes);
    fs.writeFileSync(path.join(payload, 'nora-system.json'), bytes);
    return output;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    if(process.argv.length!==3||process.argv[2]!=='--workflow-options')throw new Error('Usage: system-release.mjs --workflow-options');
    const result=workflowPublicationOptions(process.cwd(),{publicationTag:process.env.BUILD_PUBLICATION_TAG||'',
        compatibilityFile:process.env.BUILD_COMPATIBILITY_FILE||'',refType:process.env.GITHUB_REF_TYPE,refName:process.env.GITHUB_REF_NAME});
    const values={NORA_PUBLICATION_TAG:result.tag,NORA_COMPONENT_PUBLICATION_TAG:result.explicit?result.tag:'',
        NORA_UPDATE_COMPATIBILITY_FILE:result.compatibilityFile};
    if(process.env.GITHUB_ENV)fs.appendFileSync(process.env.GITHUB_ENV,Object.entries(values).map(([name,value])=>`${name}=${value}\n`).join(''));
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`publication_tag=${result.tag}\ncore_version=${result.coreVersion}\n`);
}
