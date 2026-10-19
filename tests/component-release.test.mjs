import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assemblePlatform, assertReusable, launcherProvenance, PLATFORMS } from '../tooling/release/package-component-update.mjs';
import { assertMaintenanceVersions, fileDigest, writeSystemRelease } from '../tooling/release/system-release.mjs';
import { NORA_SYSTEM_REQUIRED_FILES, LAUNCHER_CAPABILITIES, createReleaseSource, groupRuntimeModules } from '../tooling/release/release-source.mjs';
import { buildCommand } from '../tooling/release/build-commands.mjs';

test('publication generation is explicit and preserves real core identity in platform descriptors', async t => {
    const { configurePublication, releasePublicationTag } = await import('../tooling/release/system-release.mjs');
    const identity={versions:{tavern:'2.5.2'},launcherVersion:'2.2.3'};
    assert.deepEqual(configurePublication(identity),identity);
    const compatibility={schema:'nora-core-launcher-compatibility/1',coreVersion:'2.5.2',launcherVersions:['2.2.2','2.2.3'],
        capabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2}};
    const updated=configurePublication(identity,{publicationTag:'v2.5.3',updateCompatibility:compatibility});
    assert.equal(updated.versions.tavern,'2.5.2');assert.equal(releasePublicationTag(updated),'v2.5.3');
    assert.deepEqual(updated.updateCompatibility,compatibility);
    assert.equal(identity.publication,undefined);
    assert.throws(()=>configurePublication(identity,{publicationTag:'v2.5.3',updateCompatibility:{...compatibility,coreVersion:'2.5.1'}}));
    assert.throws(()=>releasePublicationTag({...updated,publication:{...updated.publication,unknown:true}}));
    const f=fixture(t);
    f.current.publication=updated.publication;f.current.updateCompatibility={...compatibility,coreVersion:f.current.versions.tavern,launcherVersions:[f.current.launcherVersion]};
    f.write(f.release,'release-manifest.json',f.current);assemblePlatform(f);
    const descriptor=JSON.parse(fs.readFileSync(path.join(f.output,'system-assets/nora-system-darwin-arm64.json')));
    assert.deepEqual(descriptor.publication,updated.publication);
    assert.deepEqual(descriptor.updateCompatibility,f.current.updateCompatibility);
    assert.equal(descriptor.version,f.current.versions.tavern);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('incremental updater archive loads its actual runner without the full ops archive', t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-updater-closure-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const source = createReleaseSource(root, { candidate: true });
    t.after(() => fs.rmSync(source.stage, { recursive: true, force: true }));
    const members = groupRuntimeModules(source.files.filter(name => name.startsWith('ops/'))).get('updater');
    const name = 'nora-tavern-module-updater.tar.gz';
    const list = path.join(temporary, 'members.txt');
    fs.writeFileSync(list, members.join('\n') + '\n');
    const tar = buildCommand('tar', ['--no-xattrs', '-czf', path.join(temporary, name), '-C', source.stage, '-T', list]);
    execFileSync(tar.command, tar.args, { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const manifest = { artifacts: Object.fromEntries(members.map(file => [file, fileDigest(path.join(source.stage, file))])),
        modules: { updater: { name, sha256: fileDigest(path.join(temporary, name)), artifacts: members } } };
    fs.writeFileSync(path.join(temporary, 'release-manifest.json'), JSON.stringify(manifest));
    const probe = `import importlib.util,json,pathlib,runpy,subprocess,sys
bundle, bootstrap, node = map(pathlib.Path, sys.argv[1:])
spec=importlib.util.spec_from_file_location('packaged_bootstrap',bootstrap)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
runner=bundle/'runner'
module.extract_runner(bundle,runner,json.loads((bundle/'release-manifest.json').read_text()))
result=subprocess.run([sys.executable,'-B',str(runner/'ops/updater/update.py'),'--help'],capture_output=True,text=True)
assert result.returncode==0, result.stdout+result.stderr
namespace=runpy.run_path(str(runner/'ops/updater/update.py'),run_name='closure_probe')
control=namespace['_control_path']
cli=namespace['module_at']('packaged_operation_cli',control.with_name('operation_cli.py'))
cli._control()
for name in ('operation_evidence.py','operation-budget.json','operation_node.mjs','mcp_probe.mjs','desktop/operation-delegate.js','desktop/operation-history.js'):
    assert control.with_name(name).is_file() if '/' not in name else (control.parent/name).is_file(), name
result=subprocess.run([str(node),str(control.with_name('operation_node.mjs')),str(runner/'ops/updater/verify-worlds.mjs')],capture_output=True,text=True)
assert result.returncode!=0 and 'DELEGATION_REQUIRED' in result.stderr, result.stdout+result.stderr
assert 'Node maintenance delegation is unavailable' not in result.stderr, result.stderr
print('verified module-only runner imports and delegates; no installation executed')
`;
    const python = process.env.NORA_TEST_PYTHON || process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
    delete environment.PYTHONPATH;
    for (const key of Object.keys(environment)) if (key.startsWith('NORA_OPERATION_')) delete environment[key];
    execFileSync(python, ['-B', '-c', probe, temporary, path.join(source.stage, 'ops/updater/bootstrap.py'), process.execPath],
        { env: environment, encoding: 'utf8', timeout: 20000 });
});
const sourceNames = ['launcher/desktop/main.js', 'launcher/ui/index.html',
    'deployment/update/releases.js', 'deployment/update/system-update.js',
    'tooling/release/package-hermes-runtime.mjs', 'tooling/source-layout.json',
    'app/engine/sillytavern/package.json', 'app/engine/sillytavern/package-lock.json',
    'nora-mcp/package.json', 'nora-mcp/npm-shrinkwrap.json'];

test('maintenance compatibility rejects legacy public versions and missing or impossible minimums',()=>{
    for(const [launcherVersion,minimumLauncherVersion] of [['2.0.2','2.0.2'],['2.1.0','1.1.0'],
        ['2.1.0',undefined],['2.1.0','2.2.0'],['2.1.0','02.1.0']])
        assert.throws(()=>assertMaintenanceVersions({launcherVersion,minimumLauncherVersion}));
    assert.equal(assertMaintenanceVersions({launcherVersion:'2.1.0',minimumLauncherVersion:'2.1.0'}),'2.1.0');
    assert.equal(assertMaintenanceVersions({launcherVersion:'2.0.2',minimumLauncherVersion:'2.0.2',candidate:true}),'2.0.2');
});
test('system generation refuses an omitted minimum before writing platform resources',t=>{
    const f=fixture(t);
    assert.throws(()=>writeSystemRelease({release:f.output,payload:f.release,
        identity:{...f.current,hermesRuntime:f.baseline.hermesRuntime,bootstrap:{}},launcherVersion:'2.1.0'}),/maintenance launcher version/);
    assert.equal(fs.existsSync(f.output),false);
});

function fixture(t, platform = 'darwin-arm64') {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-component-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const release = path.join(temporary, 'release'), baselineRoot = path.join(temporary, 'baseline');
    fs.mkdirSync(release); fs.mkdirSync(baselineRoot);
    const [systemPlatform, arch] = platform.split('-');
    const baseline = { schema: 'tavern-release/v2', candidate: false, commit: 'a'.repeat(40),
        launcherCapabilities: LAUNCHER_CAPABILITIES,
        versions: { tavern: '2.3.0' }, launcherVersion: '2.1.0', bootstrap: { minimumLauncherVersion: '2.1.0' },
        sourceFiles: Object.fromEntries(sourceNames.map(name => [name, 'a'.repeat(64)])) };
    const current = { ...baseline, commit: 'b'.repeat(40), versions: { tavern: '2.3.1' },
        sourceFiles: { ...baseline.sourceFiles, 'deployment/update/update.py': 'c'.repeat(64), 'nora/greeting.md': 'd'.repeat(64) },
        artifacts: Object.fromEntries(NORA_SYSTEM_REQUIRED_FILES.map(name => [name, 'e'.repeat(64)])) };
    const write = (directory, name, value) => {
        fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
    };
    const system = { schema: 'nora-system/v1', candidate: false, channel: 'stable', platform: systemPlatform, arch,
        version: '2.3.0', commit: baseline.commit, launcherVersion: '2.1.0', minimumLauncherVersion: '0.3.2', files: {} };
    for (const [manifestName, archive, bytes, identityKey] of [
        ['nora-hermes-runtime.json', 'hermes.tar.gz', 'hermes-python-node', 'hermesRuntime'],
        ['nora-tavern-dependencies.json', 'deps.tar.gz', 'native-dependencies', 'dependencies'],
    ]) {
        write(baselineRoot, archive, bytes);
        const descriptor = { schema: 1, platform: systemPlatform, arch, archive, sha256: fileDigest(path.join(baselineRoot, archive)) };
        write(baselineRoot, manifestName, descriptor); baseline[identityKey] = descriptor;
    }
    for (const name of fs.readdirSync(baselineRoot)) system.files[name] = {
        asset: `${platform}-${name}`, size: fs.statSync(path.join(baselineRoot, name)).size,
        sha256: fileDigest(path.join(baselineRoot, name)),
    };
    current.archives = {};
    for (const name of ['nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz',
        'nora-tavern-first-install-bootstrap.py', 'first-install-manifest.json', 'tavern-updater-bootstrap.py']) {
        write(release, name, 'new-'+name);
        if (name.endsWith('.tar.gz')) current.archives[name] = { name, sha256: fileDigest(path.join(release, name)) };
    }
    current.modules = {};
    write(release, 'release-manifest.json', current);
    write(release, 'SHA256SUMS', fs.readdirSync(release).map(name => `${fileDigest(path.join(release, name))}  ${name}\n`).join(''));
    return { temporary, release, baselineRoot, baseline, system, current, output: path.join(temporary, 'output'), write };
}

test('only mutable system content can reuse environments; shell and lock changes fail closed', t => {
    const f = fixture(t);
    assert.doesNotThrow(() => assertReusable(f.current, f.baseline));
    for (const name of sourceNames) assert.throws(() => assertReusable({ ...f.current,
        sourceFiles: { ...f.current.sourceFiles, [name]: 'changed' } }, f.baseline), /Full launcher build required/);
    assert.throws(() => assertReusable({ ...f.current, sourceFiles: {} }, f.baseline), /Full launcher/);
    assert.throws(() => assertReusable(f.current, { ...f.baseline, candidate: true }), /stable release/);
    assert.throws(() => assertReusable({ ...f.current, artifacts: {} }, f.baseline), /Incomplete Nora/);
});

for (const platform of PLATFORMS) test(`${platform}: new system identity keeps byte-identical environments and old-client compatibility`, async t => {
    const f = fixture(t, platform);
    assemblePlatform(f);
    const assetsRoot = path.join(f.output, 'system-assets');
    const system = JSON.parse(fs.readFileSync(path.join(assetsRoot, `nora-system-${platform}.json`)));
    assert.equal(system.version, '2.3.1'); assert.equal(system.commit, f.current.commit);
    assert.equal(system.minimumLauncherVersion, '2.1.0'); assert.equal(system.launcherVersion, '2.1.0');
    assert.notEqual(system.minimumLauncherVersion, f.system.minimumLauncherVersion);
    assert.equal(system.files['hermes.tar.gz'].sha256, f.system.files['hermes.tar.gz'].sha256);
    assert.equal(system.files['deps.tar.gz'].sha256, f.system.files['deps.tar.gz'].sha256);
    assert.ok(!fs.readdirSync(assetsRoot).some(name => /\.(?:dmg|exe|zip)$/.test(name)));
    const desktopRequire = createRequire(path.join(root, 'launcher/desktop/package.json'));
    fs.cpSync(path.dirname(desktopRequire.resolve('semver/package.json')), path.join(f.temporary, 'node_modules/semver'), { recursive: true });
    fs.copyFileSync(path.join(root, 'deployment/update/releases.js'), path.join(f.temporary, 'releases.js'));
    for (const file of ['launcher-errors.js', 'telemetry-contract.json', 'release-network.js', 'release-sources.js', 'release-sources.json', 'launcher-update.js']) {
        fs.copyFileSync(path.join(root, 'launcher/desktop', file), path.join(f.temporary, file));
    }
    const client = createRequire(import.meta.url)(path.join(f.temporary, 'releases.js'));
    const {sourceCandidates} = createRequire(import.meta.url)(path.join(f.temporary, 'release-sources.js'));
    const tag = 'v2.3.1', base = `https://github.com/LoveMaker-art/noras-tavern/releases/download/${tag}/`;
    const release = { tag_name: tag, draft: false, prerelease: false, assets: fs.readdirSync(assetsRoot)
        .map(name => ({ name, browser_download_url: base+name })) };
    assert.doesNotThrow(() => client.validateSystem(system, release, system.platform, system.arch, '2.1.0'));
    assert.throws(() => client.validateSystem(system, release, system.platform, system.arch, '0.3.2'), /升级启动器/);
    const incomplete = { ...release, assets: release.assets.filter(asset => asset.name !== system.files.SHA256SUMS.asset) };
    assert.throws(() => client.validateSystem(system, incomplete, system.platform, system.arch, '0.3.2'), /缺少完整组件/);
    const fetched = [];
    const latest = 'https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest';
    const catalogueUrls = new Set(sourceCandidates(latest).map(source => source.url));
    const assetUrls = new Map(release.assets.flatMap(asset => sourceCandidates(asset.browser_download_url)
        .map(source => [source.url, asset.name])));
    const fetcher = async url => {
        fetched.push(url);
        let body;
        if(catalogueUrls.has(url)) body = JSON.stringify(release);
        else {
            const name = assetUrls.get(url);
            assert.ok(name && release.assets.some(asset => asset.name === name),
                `Unexpected unowned asset or source: ${url}`);
            body = fs.readFileSync(path.join(assetsRoot, name));
        }
        const response = new Response(body);
        Object.defineProperty(response, 'url', {value:url});
        return response;
    };
    const prepared = await client.prepare({ cacheRoot: path.join(f.temporary, 'cache'), bundledRoot: f.baselineRoot,
        launcherVersion: '2.1.0', platform: system.platform, arch: system.arch, fetcher });
    assert.equal(JSON.parse(fs.readFileSync(path.join(prepared, 'nora-system.json'))).version, '2.3.1');
    assert.equal(fetched[0], sourceCandidates(latest)[0].url);
    assert.ok(!fetched.some(url => url.endsWith('-hermes.tar.gz') || url.endsWith('-deps.tar.gz')), 'Matching bundled environments should not download again');
    release.assets = release.assets.filter(a => a.name !== system.files['hermes.tar.gz'].asset);
    await assert.rejects(client.prepare({ cacheRoot: path.join(f.temporary, 'empty-cache'), bundledRoot: f.baselineRoot,
        launcherVersion: '2.1.0', platform: system.platform, arch: system.arch, fetcher }), /缺少完整组件/);
});

test('corrupt or wrong-platform baseline is refused', t => {
    const f = fixture(t);
    f.system.platform = 'win32';
    assert.throws(() => assemblePlatform(f));
    f.system.platform = 'darwin';
    fs.writeFileSync(path.join(f.baselineRoot, 'hermes.tar.gz'), 'damaged');
    assert.throws(() => assemblePlatform(f), /mismatch/);
});

test('component verifier requires complete system assets without requiring new installers', t => {
    const f = fixture(t);
    const reused = [];
    for (const platform of PLATFORMS) {
        const item = fixture(t, platform); reused.push(assemblePlatform({ ...item, output: f.output }));
    }
    fs.cpSync(f.release, path.join(f.output, 'shared'), { recursive: true });
    for (const platform of PLATFORMS) {
        const [system, arch] = platform.split('-');
        const asset = `Nora-Tavern-Launcher-2.1.0-${platform}-update.zip`;
        f.write(f.output, asset, 'launcher');
        const launcher = { schema: 'nora-launcher/v1', candidate: false, commit: f.baseline.commit,
            platform: system, arch, version: '2.1.0', asset, size: 8, sha256: fileDigest(path.join(f.output, asset)) };
        f.write(f.output, `nora-launcher-${platform}.json`, launcher);
        reused.find(item => item.platform === platform).launcher = launcherProvenance(f.current, f.baseline, launcher, platform);
    }
    f.write(f.output, 'component-release.json', { schema: 'nora-component-release/v1', version: '2.3.1', commit: f.current.commit,
        baselineTag: 'v2.3.0', installerTag: 'v2.3.0', reused });
    const args = ['tooling/release/verify-launcher-release.cjs', f.output, 'v2.3.1', f.current.commit];
    assert.doesNotThrow(() => execFileSync(process.execPath, [...args, 'components'], { cwd: root, stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, [...args, 'full'], { cwd: root, stdio: 'pipe' }));
    const launcherFile = path.join(f.output, 'nora-launcher-win32-x64.json');
    const launcher = JSON.parse(fs.readFileSync(launcherFile));
    f.write(f.output, path.basename(launcherFile), { ...launcher, commit: 'c'.repeat(40) });
    assert.throws(() => execFileSync(process.execPath, [...args, 'components'], { cwd: root, stdio: 'pipe' }));
    f.write(f.output, path.basename(launcherFile), launcher);
    fs.unlinkSync(path.join(f.output, 'system-assets/nora-system-win32-x64.json'));
    assert.throws(() => execFileSync(process.execPath, [...args, 'components'], { cwd: root, stdio: 'pipe' }));
});

test('launcher reuse follows full and chained component baseline provenance', t => {
    const f = fixture(t);
    const platform = 'darwin-arm64';
    const launcher = { schema: 'nora-launcher/v1', candidate: false, commit: f.baseline.commit,
        version: f.current.launcherVersion, platform: 'darwin', arch: 'arm64', asset: 'launcher-update.zip', size: 8, sha256: 'd'.repeat(64) };
    const provenance = launcherProvenance(f.current, f.baseline, launcher, platform);
    const baseline = { ...f.baseline, commit: 'e'.repeat(40) };
    const previous = { commit: baseline.commit, version: baseline.versions.tavern, reused: [{ platform, launcher: provenance }] };
    assert.deepEqual(launcherProvenance(f.current, baseline, launcher, platform, previous), provenance);
    assert.throws(() => launcherProvenance(f.current, baseline, launcher, platform), /baseline commit/);
    for (const change of [{ commit: 'f'.repeat(40) }, { sha256: 'f'.repeat(64) }, { size: 9 }, { version: '0.3.4' }, { arch: 'x64' }]) {
        assert.throws(() => launcherProvenance(f.current, baseline, { ...launcher, ...change }, platform, previous));
    }
    assert.throws(() => launcherProvenance({ ...f.current, sourceFiles: { ...f.current.sourceFiles,
        'launcher/desktop/main.js': 'changed' } }, baseline, launcher, platform, previous), /Full launcher/);
});

test('APP-only discovery channel is derived from an authenticated core reference; ordinary defaults stay legacy compatible',async()=>{
  const tools=await import('../tooling/release/system-release.mjs');
  const normal={versions:{tavern:'2.5.3'},commit:'a'.repeat(40)};
  assert.equal(tools.publicationCoreAnchor(normal),null);
  assert.equal(tools.publicationChannelKey({tag:'v2.5.3',channel:'stable'}),'channels/stable.json');
  const product={...normal,commit:'b'.repeat(40),publication:{schema:'nora-component-publication/1',tag:'v2.5.4'},
    coreRelease:{schema:'nora-core-reference/1',tag:'v2.5.3',commit:'a'.repeat(40),manifests:{
      'win32-x64':{asset:'win32-x64-release-manifest.json',sha256:'c'.repeat(64),size:100}}}};
  const coreAnchor=tools.publicationCoreAnchor(product);assert.deepEqual(coreAnchor,{tag:'v2.5.3',commit:'a'.repeat(40)});
  assert.equal(tools.publicationChannelKey({tag:'v2.5.4',channel:'stable',coreAnchor}),'channels/launcher-stable.json');
  for(const invalid of [{...coreAnchor,tag:'v2.5.4'},{...coreAnchor,url:'https://example.com'},{...coreAnchor,commit:'bad'}])
    assert.throws(()=>tools.publicationChannelKey({tag:'v2.5.4',channel:'stable',coreAnchor:invalid}));
  assert.throws(()=>tools.publicationCoreAnchor({...product,publication:{schema:'nora-component-publication/1',tag:'v2.5.4-beta.1'}}),/stable|Beta/);
});

test('ordinary stable discovery refuses a batch tag that legacy APPs would mistake for a different core version',async t=>{
    const {writeDiscoveryCatalogues}=await import('../tooling/release/publish-release.mjs');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-core-anchor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const product={versions:{tavern:'2.5.3'},publication:{schema:'nora-component-publication/1',tag:'v2.5.4'}};
    await assert.rejects(writeDiscoveryCatalogues({product,output:root,release:{tag_name:'v2.5.4',draft:false,prerelease:false}}),/ordinary|legacy|anchor/i);
    assert.equal(fs.readdirSync(root).length,0,'incompatible discovery must fail before writing a catalogue');
});
test('packaging requires a reviewed compatibility declaration even when no workflow input is supplied',async t=>{
    const {readPublicationCompatibility}=await import('../tooling/release/system-release.mjs');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-required-compatibility-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const identity={versions:{tavern:'2.5.4'},launcherVersion:'2.2.4'};
    assert.equal(typeof readPublicationCompatibility,'function');
    assert.throws(()=>readPublicationCompatibility(directory,identity,{candidate:true}),/compatibility declaration/i);
    const file='tooling/release/compatibility/v2.5.4.json';
    fs.mkdirSync(path.dirname(path.join(directory,file)),{recursive:true});
    const declaration={schema:'nora-core-launcher-compatibility/1',coreVersion:'2.5.4',launcherVersions:['2.2.4'],previousCoreVersions:['2.5.3'],
        capabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2}};
    fs.writeFileSync(path.join(directory,file),JSON.stringify(declaration));
    const result=readPublicationCompatibility(directory,identity,{candidate:true});
    assert.equal(result.compatibilityFile,file);assert.deepEqual(result.updateCompatibility,declaration);
    assert.match(result.compatibilitySha256,/^[a-f0-9]{64}$/);
    assert.throws(()=>readPublicationCompatibility(directory,{...identity,launcherVersion:'2.2.5'},{candidate:true}),/compatibility declaration/i);
    assert.throws(()=>readPublicationCompatibility(directory,identity),/committed|git/i,'formal inputs cannot borrow an uncommitted declaration');
    const current={versions:{tavern:fs.readFileSync(path.join(root,'app/.tavern-release-version'),'utf8').trim()},
        launcherVersion:JSON.parse(fs.readFileSync(path.join(root,'launcher/desktop/package.json'))).version};
    const reviewed=readPublicationCompatibility(root,current,{candidate:true}).updateCompatibility;
    assert.equal(reviewed.coreVersion,current.versions.tavern);assert.ok(reviewed.launcherVersions.includes(current.launcherVersion));
    assert.ok(reviewed.previousCoreVersions?.length||reviewed.launcherVersions.some(version=>version!==current.launcherVersion),
        'the actual reviewed file must declare a transition, not just the final pair');
});
test('the actual packager refuses an omitted reviewed file before exporting or building product files',()=>{
    const output=path.join(root,'release'),before=fs.existsSync(output)?fs.readdirSync(output):null;
    const result=spawnSync(process.execPath,[path.join(root,'tooling/release/package-release.mjs'),'--candidate',
        '--update-compatibility','tooling/release/compatibility/missing-regression-contract.json'],{cwd:root,encoding:'utf8',timeout:10000});
    assert.equal(result.status,1);assert.match(result.stderr,/Missing reviewed compatibility declaration/);
    assert.deepEqual(fs.existsSync(output)?fs.readdirSync(output):null,before);
});
