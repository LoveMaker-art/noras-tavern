import fs from 'node:fs';
import { configureCandidateLauncher, writeSystemRelease } from './system-release.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildCommand } from './build-commands.mjs';
import { assertNoraSystemArtifacts, collectRuntimeFiles, createReleaseSource, digest, groupRuntimeModules } from './release-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidate = process.argv.includes('--candidate');
const runtimeManifestIndex = process.argv.indexOf('--hermes-runtime-manifest');
const runtimeManifestPath = runtimeManifestIndex >= 0
    ? path.resolve(process.argv[runtimeManifestIndex + 1] || '')
    : null;
const { stage, files, identity } = createReleaseSource(root, { candidate });
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

function copyPackageTree(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) {
            copyPackageTree(from, to);
        } else if (entry.isFile()) {
            copyPackageFile(from, to);
        }
    }
}

try {
    run('npm', ['ci', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])]);
    const mcp = path.join(stage, 'nora-mcp');
    const mcpInstall = fs.existsSync(path.join(mcp, 'package-lock.json')) ? 'ci' : 'install';
    run('npm', [mcpInstall, '--ignore-scripts', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])], mcp);
    run('npm', ['run', 'build'], mcp);
    run('npm', ['run', 'build:nora']);
    const members = collectRuntimeFiles(stage, files);
    if (runtimeManifestPath) assertNoraSystemArtifacts(members);
    const release = path.join(root, 'release', `${candidate ? 'candidate' : 'stable'}-${identity.commit.slice(0, 12)}-${Date.now()}`);
    fs.mkdirSync(release, { recursive: true });
    const checksums = [];
    identity.archives = {};
    for (const part of ['app', 'ops', 'nora-mcp']) {
        const list = path.join(stage, `${part}-members.txt`);
        fs.writeFileSync(list, members.filter(file => file.startsWith(`${part}/`)).join('\n') + '\n');
        const name = `nora-tavern-${part}.tar.gz`;
        run('tar', ['--no-xattrs', '-C', stage, '-czf', path.join(release, name), '-T', list], stage, { COPYFILE_DISABLE: '1' });
        const sha256 = digest(fs.readFileSync(path.join(release, name)));
        identity.archives[part] = { name, sha256 };
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
        identity.modules[module] = { name, sha256, artifacts: moduleMembers };
        checksums.push(`${sha256}  ${name}`);
    }
    const profile = JSON.parse(fs.readFileSync(path.join(stage, 'app/story_profile_runtime/manifest.json')));
    identity.storyProfile = { sourceRevision: profile.sourceRevision, manifestSha256: digest(JSON.stringify(profile)) };
    identity.generatedAt = new Date().toISOString();
    identity.versions = {
        tavern: fs.readFileSync(path.join(stage, 'app/.tavern-release-version'), 'utf8').trim(),
        mcp: JSON.parse(fs.readFileSync(path.join(mcp, 'package.json'))).version,
        storyProfile: profile.sourceRevision,
        skills: Object.fromEntries(['creative/tavern', 'creative/tavern-ops', 'creative/nora-cardforge', 'system/tavern-updater']
            .map(name => [name, digest(fs.readFileSync(path.join(stage, 'ops/skills', name, 'SKILL.md')))])),
        agents: digest(fs.readFileSync(path.join(stage, 'ops/skills/agents-tavern.md'))),
    };
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
    identity.bootstrap = { sha256: digest(bootstrap), installerSha256: digest(installer) };
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

    const starterRoot = path.join(release, 'nora-tavern-launcher');
    const starterPayload = path.join(starterRoot, 'payload');
    fs.mkdirSync(starterPayload, { recursive: true });
    for (const name of [
        'release-manifest.json',
        'SHA256SUMS',
        'nora-tavern-app.tar.gz',
        'nora-tavern-ops.tar.gz',
        'nora-tavern-nora-mcp.tar.gz',
        'nora-tavern-first-install-bootstrap.py',
        'first-install-manifest.json',
        ...runtimePayloadNames,
    ]) {
        copyPackageFile(path.join(release, name), path.join(starterPayload, name));
    }
    const starterFiles = [
        'Install-Nora-Tavern.command',
        'Install-Nora-Tavern.cmd',
        'Install-Nora-Tavern.ps1',
        'START-HERE.md',
    ];
    for (const name of starterFiles) {
        copyPackageFile(path.join(stage, 'ops/installer/package', name), path.join(starterRoot, name));
    }
    for (const name of ['launcher-ui-prototype.html', 'launcher-conversation-prototype.html', 'launcher-controller.js', 'launcher_services.py', 'launcher_bridge.py', 'nora_profile.py', 'nora_system.py', 'model_config.py', 'bootstrap.py']) {
        copyPackageFile(path.join(stage, 'ops/installer', name), path.join(starterRoot, name));
    }
    copyPackageTree(path.join(stage, 'ops/installer/assets'), path.join(starterRoot, 'assets'));
    copyPackageTree(path.join(stage, 'ops/installer/desktop'), path.join(starterRoot, 'desktop'));
    if (/-beta\./.test(identity.versions.tavern)) {
        const packageFile = path.join(starterRoot, 'desktop/package.json');
        const desktop = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
        desktop.noraReleaseChannel = 'beta';
        desktop.build.appId = 'art.lovemaker.nora-tavern-launcher.beta';
        desktop.build.productName = '诺拉·酒馆 Beta';
        desktop.build.artifactName = `Nora-Tavern-${identity.versions.tavern}-\${os}-\${arch}.\${ext}`;
        desktop.build.mac.identity = '-';
        desktop.build.nsis.artifactName = `Nora-Tavern-${identity.versions.tavern}-win-\${arch}-setup.\${ext}`;
        fs.writeFileSync(packageFile, JSON.stringify(desktop, null, 2));
    }
    writeSystemRelease({ release, payload: starterPayload, identity,
        launcherVersion: JSON.parse(fs.readFileSync(path.join(starterRoot, 'desktop/package.json'), 'utf8')).version });
    if (identity.hermesRuntime) configureCandidateLauncher({
        packageFile: path.join(starterRoot, 'desktop/package.json'), payload: starterPayload, identity,
    });
    const starterName = 'nora-tavern-launcher.zip';
    run('zip', ['-qry', starterName, 'nora-tavern-launcher'], release);
    const starterBytes = fs.readFileSync(path.join(release, starterName));
    checksums.push(`${digest(starterBytes)}  ${starterName}`);
    identity.starter = {
        name: starterName,
        sha256: digest(starterBytes),
        payload: 'bundled-release',
        entrypoints: starterFiles,
    };

    fs.writeFileSync(path.join(release, 'release-manifest.json'), JSON.stringify(identity, null, 2) + '\n');
    checksums.push(`${digest(fs.readFileSync(path.join(release, 'release-manifest.json')))}  release-manifest.json`);
    fs.writeFileSync(path.join(release, 'SHA256SUMS'), checksums.join('\n') + '\n');
    const classification = candidate ? 'candidate' : 'stable';
    console.log(`release=${release}\nclassification=${classification}`);
} finally {
    fs.rmSync(stage, { recursive: true, force: true });
}
