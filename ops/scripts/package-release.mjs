import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { collectRuntimeFiles, createReleaseSource, digest } from './release-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidate = process.argv.includes('--candidate');
const browserIndex = process.argv.indexOf('--browser-report');
const browserReport = browserIndex < 0 ? '' : path.resolve(process.argv[browserIndex + 1] || '');
if (!candidate && !browserReport) throw new Error('Stable packaging requires --browser-report from target-environment verification.');
const { stage, files, identity } = createReleaseSource(root, { candidate });
const engine = path.join(stage, 'app/engine/sillytavern');
function run(command, args, cwd = engine, extraEnv = {}) {
    return execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
}

try {
    run('npm', ['ci', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])]);
    // Candidate builds are explicitly non-release evidence. A stable release
    // must not silently bypass unresolved production dependency advisories.
    if (!candidate) run('npm', ['audit', '--omit=dev', '--audit-level=moderate']);
    run('npm', ['run', 'check:story-profile-source']);
    const mcp = path.join(stage, 'nora-mcp');
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(process.argv.includes('--offline') ? ['--offline'] : [])], mcp);
    run('npm', ['test'], mcp);
    run('npm', ['run', 'test:integration'], mcp, { NORA_TAVERN_SOURCE: engine });
    run('npm', ['test'], path.join(stage, 'ops/skills/creative/nora-cardforge'));
    run('python3', ['-m', 'unittest', 'discover', '-s', 'ops/tests'], stage, { PYTHONDONTWRITEBYTECODE: '1' });
    run(process.execPath, ['--test', 'ops/tests/test_python_migration.mjs'], stage);
    if (!candidate) run('npm', ['audit', '--omit=dev', '--audit-level=moderate'], mcp);
    run('python3', ['-m', 'unittest', 'discover', '-s', 'story-profile/tests'], stage,
        { PYTHONDONTWRITEBYTECODE: '1' });
    run('npm', ['run', 'test:nora']);
    run('npm', ['run', 'lint']);
    run('npm', ['run', 'build:nora']);
    run(process.execPath, ['tests/run-nora-contracts.mjs']);
    run(process.execPath, [path.join(stage, 'ops/scripts/verify-product-workflows.mjs'),
        ...(!candidate ? ['--require-browser', '--browser-report', browserReport] : [])], engine,
    { TAVERN_RELEASE_COMMIT: identity.commit, TAVERN_RELEASE_SOURCE_DIGEST: identity.sourceDigest });
    run('python3', ['-c', 'from native_lifecycle import NativeRuntime; print(NativeRuntime.from_environment().verify_source())'],
        path.join(stage, 'app'), { TAVERN_APP_DIR: path.join(stage, 'app'), PYTHONDONTWRITEBYTECODE: '1' });
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
    identity.artifacts = Object.fromEntries(members.map(file => [file, digest(fs.readFileSync(path.join(stage, file)))]));
    const bootstrap = fs.readFileSync(path.join(stage, 'ops/updater/bootstrap.py'));
    const installer = fs.readFileSync(path.join(stage, 'ops/updater/install.sh'));
    const bootstrapManifest = Buffer.from(JSON.stringify({ schema: 2, scope: 'tavern-updater-bootstrap',
        commit: identity.commit, sha256: digest(bootstrap), installerSha256: digest(installer) }, null, 2) + '\n');
    for (const [name, bytes] of [['tavern-updater-bootstrap.py', bootstrap], ['install-tavern-updater.sh', installer], ['bootstrap-manifest.json', bootstrapManifest]]) {
        fs.writeFileSync(path.join(release, name), bytes);
        checksums.push(`${digest(bytes)}  ${name}`);
    }
    identity.bootstrap = { sha256: digest(bootstrap), installerSha256: digest(installer) };
    fs.writeFileSync(path.join(release, 'release-manifest.json'), JSON.stringify(identity, null, 2) + '\n');
    checksums.push(`${digest(fs.readFileSync(path.join(release, 'release-manifest.json')))}  release-manifest.json`);
    fs.writeFileSync(path.join(release, 'SHA256SUMS'), checksums.join('\n') + '\n');
    console.log(`release=${release}\nclassification=${candidate ? 'candidate-not-user-outcome-verified' : 'stable'}`);
} finally {
    fs.rmSync(stage, { recursive: true, force: true });
}
