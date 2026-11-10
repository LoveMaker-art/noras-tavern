import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {configurePublication,readPublicationCompatibility,writeSystemRelease} from './system-release.mjs';
import {buildCommand} from './build-commands.mjs';
import {assertNoraSystemArtifacts,collectRuntimeFiles,createReleaseSource,digest,groupRuntimeModules,materializeUpdaterDependencies,UPDATER_DEPENDENCY_ROOT} from './release-source.mjs';
import {readMaintenancePin} from '../maintenance-input.mjs';
import {declareLegacyApp,deliveryAsset} from './legacy-app-delivery.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const candidate=process.argv.includes('--candidate');
const explicitOption=name=>{const positions=process.argv.flatMap((value,index)=>value===name?[index]:[]);if(!positions.length)return undefined;const value=process.argv[positions[0]+1];if(positions.length!==1||!value||value.startsWith('--'))throw Error('Missing or duplicate '+name);return value;};
for(const removed of ['--app-only','--launcher-baseline','--candidate-telemetry'])if(process.argv.includes(removed))throw Error('Desktop construction is outside this core repository');
const publicationTag=explicitOption('--publication-tag'),compatibilityFile=explicitOption('--update-compatibility');
const runtimeManifestPath=explicitOption('--hermes-runtime-manifest');
const componentsOnly=!runtimeManifestPath;
if(runtimeManifestPath&&process.argv.includes('--components-only'))throw Error('Component builds do not accept a runtime manifest');
const { stage, files, identity } = createReleaseSource(root, { candidate });
const minimumLauncherVersion=readMaintenancePin(stage).compatibility.minimumLauncherVersion;
const legacy=declareLegacyApp(identity,stage);
Object.assign(identity,legacy.identity);
// createReleaseSource already binds the immutable Git export for stable builds.
// Read the declaration from that export, never a second live worktree read.
const {updateCompatibility}=readPublicationCompatibility(stage,{versions:{tavern:fs.readFileSync(path.join(stage,'app/.tavern-release-version'),'utf8').trim()},launcherVersion:legacy.pin.version},{compatibilityFile,candidate:true});
const engine = path.join(stage, 'app/engine/sillytavern');
function run(command, args, cwd = engine, extraEnv = {}) {
    const resolved = buildCommand(command, args);
    return execFileSync(resolved.command, resolved.args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
}

function copyPackageFile(source, target) {
    const stat = fs.statSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, stat.mode & 0o777);
}


try {
    // Advertise the actual immutable APP delivery, separately from its minimum floor.
    const mcp = path.join(stage, 'nora-mcp');
        run('npm', ['ci', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])]);
        const mcpInstall = (fs.existsSync(path.join(mcp,'package-lock.json'))||fs.existsSync(path.join(mcp,'npm-shrinkwrap.json'))) ? 'ci' : null;
        if(!mcpInstall)throw Error('Core MCP construction requires its authored npm lock');
        run('npm', [mcpInstall, '--ignore-scripts', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])], mcp);
        run('npm', ['run', 'build'], mcp);
        run('npm', ['run', 'build:nora']);
    const updaterDependencies = materializeUpdaterDependencies(stage, {
        install: directory => run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund',
            ...(process.argv.includes('--offline') ? ['--offline'] : [])], directory) });
    identity.updaterDependencies = { schema: updaterDependencies.schema, path: UPDATER_DEPENDENCY_ROOT,
        canonicalLockSha256: updaterDependencies.canonicalLockSha256, dependencies: updaterDependencies.dependencies,
        receiptSha256: digest(fs.readFileSync(path.join(stage, UPDATER_DEPENDENCY_ROOT, 'receipt.json'))) };
    const members = collectRuntimeFiles(stage, files);
    assertNoraSystemArtifacts(members);
    const release = path.join(root, 'release', `${candidate ? 'candidate' : 'stable'}-${identity.commit.slice(0, 12)}-${Date.now()}`);
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(path.join(release,deliveryAsset),legacy.bytes,{flag:'wx'});
    const checksums = [];
    identity.archives = {};
    for (const part of ['app', 'ops', 'nora-mcp']) {
        const list = path.join(stage, `${part}-members.txt`);
        fs.writeFileSync(list, members.filter(file => file.startsWith(`${part}/`)).join('\n') + '\n');
        const name = `nora-tavern-${part}.tar.gz`;
        run('tar', ['--no-xattrs', '-C', stage, '-czf', path.join(release, name), '-T', list], stage, { COPYFILE_DISABLE: '1' });
        const sha256 = digest(fs.readFileSync(path.join(release, name)));
        identity.archives[part] = { name, sha256, size: fs.statSync(path.join(release, name)).size };
        checksums.push(`${sha256}  ${name}`);
    }
    identity.artifacts = Object.fromEntries(members.map(file => [file, digest(fs.readFileSync(path.join(stage, file)))]));
    identity.artifactModes = Object.fromEntries(members.map(file => [
        file,
        fs.statSync(path.join(stage, file)).mode & 0o111 ? 0o755 : 0o644,
    ]));
    identity.modules = {};
    for (const [module, moduleMembers] of groupRuntimeModules(members)) {
        const list = path.join(stage, `module-${module}-members.txt`);
        fs.writeFileSync(list, moduleMembers.join('\n') + '\n');
        const name = `nora-tavern-module-${module}.tar.gz`;
        run('tar', ['--no-xattrs', '-C', stage, '-czf', path.join(release, name), '-T', list], stage, { COPYFILE_DISABLE: '1' });
        const sha256 = digest(fs.readFileSync(path.join(release, name)));
        identity.modules[module] = { name, sha256, size: fs.statSync(path.join(release, name)).size, artifacts: moduleMembers };
        checksums.push(`${sha256}  ${name}`);
    }
    const profile = JSON.parse(fs.readFileSync(path.join(stage, 'app/story_profile_runtime/manifest.json')));
    identity.storyProfile = { sourceRevision: profile.sourceRevision, manifestSha256: digest(JSON.stringify(profile)) };
    identity.generatedAt = new Date().toISOString();
    identity.versions = {
        tavern: fs.readFileSync(path.join(stage, 'app/.tavern-release-version'), 'utf8').trim(),
        mcp: JSON.parse(fs.readFileSync(path.join(mcp, 'package.json'))).version,
        storyProfile: profile.sourceRevision,
        skills: Object.fromEntries(['creative/tavern', 'creative/tavern-ops', 'creative/nora-cardforge', 'system/tavern-updater', 'system/model-provider-config', 'creative/nora-skill-library']
            .map(name => [name, digest(fs.readFileSync(path.join(stage, 'ops/skills', name, 'SKILL.md')))])),
        agents: digest(fs.readFileSync(path.join(stage, 'ops/skills/agents-tavern.md'))),
    };
    Object.assign(identity,configurePublication(identity,{publicationTag,updateCompatibility}));
    identity.verification = {
        mode: 'packaging-only',
        testsExecutedByPackager: false,
        statement: 'The packager builds and seals release artifacts; it does not run release gates.',
    };
    const bootstrap = fs.readFileSync(path.join(stage, 'ops/updater/bootstrap.py'));
    const installer = fs.readFileSync(path.join(stage, 'ops/updater/install.sh'));
    const bootstrapManifest = Buffer.from(JSON.stringify({ schema: 2, scope: 'tavern-updater-bootstrap',
        commit: identity.commit, sha256: digest(bootstrap), installerSha256: digest(installer) }, null, 2) + '\n');
    for (const [name, bytes] of [['tavern-updater-bootstrap.py', bootstrap], ['install-tavern-updater.sh', installer], ['bootstrap-manifest.json', bootstrapManifest]]) {
        fs.writeFileSync(path.join(release, name), bytes);
        checksums.push(`${digest(bytes)}  ${name}`);
    }
    identity.bootstrap = { sha256: digest(bootstrap), installerSha256: digest(installer), managedComponents: 1, managedLifecycle: 1,
        managedReceiptRecovery: 1,
        minimumLauncherVersion };
    const firstBootstrap = fs.readFileSync(path.join(stage, 'ops/installer/bootstrap.py'));
    const firstInstaller = fs.readFileSync(path.join(stage, 'ops/installer/install.sh'));
    const firstPowerShellInstaller = fs.readFileSync(path.join(stage, 'ops/installer/install.ps1'));
    const firstInstallManifest = Buffer.from(JSON.stringify({ schema: 1, scope: 'nora-tavern-first-install-bootstrap',
        commit: identity.commit, sha256: digest(firstBootstrap), installerSha256: digest(firstInstaller),
        powershellInstallerSha256: digest(firstPowerShellInstaller) }, null, 2) + '\n');
    for (const [name, bytes] of [
        ['nora-tavern-first-install-bootstrap.py', firstBootstrap],
        ['install-nora-tavern.sh', firstInstaller],
        ['install-nora-tavern.ps1', firstPowerShellInstaller],
        ['first-install-manifest.json', firstInstallManifest],
    ]) {
        fs.writeFileSync(path.join(release, name), bytes);
        checksums.push(`${digest(bytes)}  ${name}`);
    }
    identity.firstInstall = {
        sha256: digest(firstBootstrap),
        installerSha256: digest(firstInstaller),
        powershellInstallerSha256: digest(firstPowerShellInstaller),
    };
    const runtimePayloadNames = [];
    if (runtimeManifestPath) {
        const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
        if (runtimeManifest.schema !== 1 || !runtimeManifest.archive || !runtimeManifest.sha256) {
            throw new Error('Hermes runtime manifest is invalid');
        }
        if (!runtimeManifest.components?.clawchat?.revision || !runtimeManifest.components?.liveware?.sha256 ||
            runtimeManifest.componentProbe !== 'nora-clawchat-check.py') {
            throw new Error('Integrated runtime must include verified ClawChat and Liveware components');
        }
        const greetingPatchSha256 = digest(fs.readFileSync(path.join(stage, 'ops/updater/clawchat-greeting-order.patch')));
        if (runtimeManifest.components.clawchat.greetingPatchSha256 !== greetingPatchSha256) {
            throw new Error('Rebuild the Hermes runtime with the matching shared ClawChat greeting patch before packaging');
        }
        const runtimeArchive = path.resolve(path.dirname(runtimeManifestPath), runtimeManifest.archive);
        const runtimeBytes = fs.readFileSync(runtimeArchive);
        if (digest(runtimeBytes) !== runtimeManifest.sha256) {
            throw new Error('Hermes runtime archive checksum does not match its manifest');
        }
        for (const [name, bytes] of [
            ['nora-hermes-runtime.json', fs.readFileSync(runtimeManifestPath)],
            [runtimeManifest.archive, runtimeBytes],
        ]) {
            fs.writeFileSync(path.join(release, name), bytes);
            checksums.push(`${digest(bytes)}  ${name}`);
            runtimePayloadNames.push(name);
        }
        identity.hermesRuntime = {
            platform: runtimeManifest.platform,
            arch: runtimeManifest.arch,
            version: runtimeManifest.hermesVersion,
            archive: runtimeManifest.archive,
            sha256: runtimeManifest.sha256,
            size: runtimeManifest.size,
            optionalComponents: runtimeManifest.optionalComponents,
        };

        run('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], engine);
        run('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], mcp);
        const dependencyArchiveName = `nora-tavern-dependencies-${runtimeManifest.platform}-${runtimeManifest.arch}.tar.gz`;
        const dependencyArchive = path.join(release, dependencyArchiveName);
        run('tar', ['--no-xattrs', '-C', stage, '-czf', dependencyArchive,
            'app/engine/sillytavern/node_modules', 'nora-mcp/node_modules'], stage, { COPYFILE_DISABLE: '1' });
        const dependencyBytes = fs.readFileSync(dependencyArchive);
        const dependencyManifest = Buffer.from(JSON.stringify({
            schema: 1,
            platform: runtimeManifest.platform,
            arch: runtimeManifest.arch,
            archive: dependencyArchiveName,
            sha256: digest(dependencyBytes),
            size: dependencyBytes.length,
            nodeMajor: Number(String(runtimeManifest.nodeVersion || '').match(/v?(\d+)/)?.[1] || 0),
            roots: ['app/engine/sillytavern/node_modules', 'nora-mcp/node_modules'],
        }, null, 2) + '\n');
        fs.writeFileSync(path.join(release, 'nora-tavern-dependencies.json'), dependencyManifest);
        checksums.push(`${digest(dependencyBytes)}  ${dependencyArchiveName}`);
        checksums.push(`${digest(dependencyManifest)}  nora-tavern-dependencies.json`);
        runtimePayloadNames.push(dependencyArchiveName, 'nora-tavern-dependencies.json');
        identity.dependencies = {
            platform: runtimeManifest.platform,
            arch: runtimeManifest.arch,
            archive: dependencyArchiveName,
            sha256: digest(dependencyBytes),
            size: dependencyBytes.length,
            nodeMajor: Number(String(runtimeManifest.nodeVersion || '').match(/v?(\d+)/)?.[1] || 0),
        };
    }
    const payloadManifest = Buffer.from(JSON.stringify(identity, null, 2) + '\n');
    fs.writeFileSync(path.join(release, 'release-manifest.json'), payloadManifest);
    const payloadChecksums = [...checksums, `${digest(payloadManifest)}  release-manifest.json`];
    fs.writeFileSync(path.join(release, 'SHA256SUMS'), payloadChecksums.join('\n') + '\n');

    if(runtimeManifestPath){
        const payload=path.join(release,'core-payload');fs.mkdirSync(payload);
        for(const name of ['release-manifest.json','SHA256SUMS','nora-tavern-app.tar.gz','nora-tavern-ops.tar.gz',
            'nora-tavern-nora-mcp.tar.gz','nora-tavern-first-install-bootstrap.py','tavern-updater-bootstrap.py',
            'first-install-manifest.json',...runtimePayloadNames])copyPackageFile(path.join(release,name),path.join(payload,name));
        writeSystemRelease({release,payload,identity,launcherVersion:legacy.pin.version,minimumLauncherVersion});
    }
    const classification = candidate ? 'candidate' : 'stable';
    console.log(`release=${release}\nclassification=${classification}`);
} finally {
    fs.rmSync(stage, { recursive: true, force: true });
}
