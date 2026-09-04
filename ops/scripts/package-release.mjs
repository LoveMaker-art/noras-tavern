import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { collectRuntimeFiles, createReleaseSource, digest, groupRuntimeModules } from './release-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidate = process.argv.includes('--candidate');
const { stage, files, identity } = createReleaseSource(root, { candidate });
const engine = path.join(stage, 'app/engine/sillytavern');
function run(command, args, cwd = engine, extraEnv = {}) {
    return execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
}

try {
    run('npm', ['ci', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])]);
    const mcp = path.join(stage, 'nora-mcp');
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])], mcp);
    run('npm', ['run', 'build'], mcp);
    run('npm', ['run', 'build:nora']);
    const members = collectRuntimeFiles(stage, files);
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
    fs.writeFileSync(path.join(release, 'release-manifest.json'), JSON.stringify(identity, null, 2) + '\n');
    checksums.push(`${digest(fs.readFileSync(path.join(release, 'release-manifest.json')))}  release-manifest.json`);
    fs.writeFileSync(path.join(release, 'SHA256SUMS'), checksums.join('\n') + '\n');
    const classification = candidate ? 'candidate' : 'stable';
    console.log(`release=${release}\nclassification=${classification}`);
} finally {
    fs.rmSync(stage, { recursive: true, force: true });
}
