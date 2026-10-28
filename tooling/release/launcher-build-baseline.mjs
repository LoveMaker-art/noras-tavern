import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCommand } from './build-commands.mjs';
import { assertSafeReleasePath, createReleaseSource, digest } from './release-source.mjs';
import { fileDigest, assertCoreReleasePayload } from './system-release.mjs';
import { verifyFile, PLATFORMS } from './package-component-update.mjs';
import {materializeAcceptanceBaseline} from './acceptance-baseline.mjs';
import {materializeCoreReference} from './app-only-release.mjs';
import { readAssetCatalogue, downloadCatalogueAsset, assertBaselineCatalogue } from './asset-catalogue.mjs';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const safeName = name => {
    assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    return name;
};
const allowedFiles = new Set([
    'app/.tavern-release-version', 'deployment/update/releases.js', 'deployment/update/system-update.js',
    'deployment/shared/services.py', 'deployment/shared/model_config.py', 'deployment/shared/hermes_models.py', 'deployment/shared/hermes_model_auth.py',
    'deployment/shared/nora_profile.py', 'deployment/shared/nora_system.py',
    'tooling/release/package-launcher-update.cjs', 'tooling/release/package-local-launcher.mjs',
    'tooling/release/verify-launcher-release.cjs', 'tooling/release/launcher-release-notes.cjs',
    'tooling/release/acceptance-baseline.mjs',
]);

const appOnlyFiles=new Set([
    'tooling/release/acceptance-baseline.mjs', 'tooling/release/app-only-release.mjs', 'tooling/release/app-only-acceptance.cjs',
    'tooling/release/app-only-native-ui.ps1', 'tooling/release/app-only-native-ui.applescript',
    'tooling/release/publication-source.cjs', 'tooling/release/release-plan.mjs', 'tooling/release/final-consumer.mjs',
    '.github/workflows/publish-accepted-release.yml',
    'tooling/release/system-release.mjs', 'tooling/release/asset-catalogue.mjs',
    'tooling/release/launcher-build-baseline.mjs', 'tooling/release/package-release.mjs',
    'deployment/update/bootstrap.py', 'deployment/update/update.py', 'deployment/update/task.py',
    'deployment/update/task_backend.py', 'deployment/runtime/nora-tavern-update-check.py',
    '.github/workflows/build-integrated-launcher.yml',
]);
export function assertLauncherReuse(current, baseline,{appOnly=false}={}) {
    assert.equal(baseline.schema, 'tavern-release/v2');
    assert.equal(baseline.candidate, false, 'Baseline must be a stable published build');
    assert.equal(baseline.dirty, false, 'Baseline must be clean');
    assert.equal(current.schema, baseline.schema);
    for (const value of [baseline, current]) {
        assert.match(value.commit, /^[a-f0-9]{40}$/);
        for (const required of ['app/engine/sillytavern/package-lock.json', 'nora-mcp/npm-shrinkwrap.json',
            'tooling/source-layout.json', 'tooling/release/package-hermes-runtime.mjs']) {
            assert.match(value.sourceFiles?.[required] || '', /^[a-f0-9]{64}$/, `Missing fingerprint: ${required}`);
        }
    }
    // Shared build/projection tools can change compiled payloads without changing
    // app source. Only reviewed launcher-specific tools may bypass compilation.
    const allowed = name => allowedFiles.has(name)||(appOnly&&appOnlyFiles.has(name))
        || /^tooling\/release\/compatibility\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)
        || ['launcher/', 'deployment/install/', 'deployment/uninstall/', 'tests/', 'docs/'].some(prefix => name.startsWith(prefix));
    const changed = [...new Set([...Object.keys(current.sourceFiles), ...Object.keys(baseline.sourceFiles)])]
        .filter(name => current.sourceFiles[name] !== baseline.sourceFiles[name]);
    const blocked = changed.filter(name => !allowed(name));
    assert.equal(blocked.length, 0, `Full build required; non-launcher inputs changed: ${blocked.join(', ')}`);
    return changed;
}

export function assertLauncherVersion(version, previous) {
    for (const value of [version, previous]) assert.match(value || '', /^\d+\.\d+\.\d+$/, 'Missing stable launcher version');
    const next = version.split('.').map(Number), old = previous.split('.').map(Number);
    const difference = next.findIndex((value, index) => value !== old[index]);
    assert.ok(difference >= 0 && next[difference] > old[difference], 'Increase launcher version before a stable launcher build');
}

export function readBaseline(directory, current, platform = `${process.platform}-${process.arch}`,{appOnly=false}={}) {
    assert.ok(PLATFORMS.includes(platform));
    const system = json(path.join(directory, `nora-system-${platform}.json`));
    assert.equal(system.schema, 'nora-system/v1');
    assert.equal(`${system.platform}-${system.arch}`, platform);
    assert.equal(system.candidate, false);
    assert.equal(system.channel, 'stable');
    const readVerified = name => {
        verifyFile(path.join(directory, safeName(name)), system.files[name]);
        return json(path.join(directory, name));
    };
    const identity = readVerified('release-manifest.json');
    if(system.coreRelease)assertCoreReleasePayload(system,fs.readFileSync(path.join(directory,'release-manifest.json')),platform,system.files['release-manifest.json']);
    else assert.equal(identity.commit, system.commit);
    assert.equal(identity.versions.tavern, system.version);
    assertLauncherReuse(current, identity,{appOnly});
    // Shared module archives come from one build platform, whereas installers
    // have platform-specific full archives (including different tar metadata).
    const sharedPath = path.join(directory, 'shared-release-manifest.json');
    if (fs.existsSync(sharedPath)) {
        const checks = fs.readFileSync(path.join(directory, 'shared-SHA256SUMS'), 'utf8');
        const expected = checks.split(/\r?\n/).map(line => /^([a-f0-9]{64})  release-manifest\.json$/.exec(line)).filter(Boolean);
        assert.equal(expected.length, 1, 'Missing shared manifest checksum');
        assert.equal(fileDigest(sharedPath), expected[0][1]);
        const shared = json(sharedPath);
        if(!system.coreRelease){assert.equal(shared.commit, identity.commit);
        assert.deepEqual(shared.sourceFiles, identity.sourceFiles);
        identity.modules = Object.fromEntries(Object.entries(shared.modules).filter(([, entry]) => entry.artifacts.every(name =>
            shared.artifacts[name] === identity.artifacts[name] && shared.artifactModes[name] === identity.artifactModes[name])));}
    }
    const runtime = readVerified('nora-hermes-runtime.json');
    const dependencies = readVerified('nora-tavern-dependencies.json');
    for (const [item, key] of [[runtime, 'hermesRuntime'], [dependencies, 'dependencies']]) {
        assert.equal(item.schema, 1);
        assert.equal(`${item.platform}-${item.arch}`, platform);
        if(identity[key])assert.equal(item.sha256, identity[key].sha256);
        verifyFile(path.join(directory, safeName(item.archive)), item);
        verifyFile(path.join(directory, item.archive), system.files[item.archive]);
    }
    return { directory, identity, system, runtime, dependencies,
        product:fs.existsSync(sharedPath)?json(sharedPath):identity,
        coreRelease:fs.existsSync(path.join(directory,'baseline-core-reference.json'))?json(path.join(directory,'baseline-core-reference.json')):undefined };
}

// Only regular, manifest-owned files are extracted, never archive links or arbitrary paths.
export function restoreBuiltPayload(baseline, stage) {
    const versionPath = path.join(stage, 'app/.tavern-release-version');
    const version = fs.readFileSync(versionPath);
    const tar = args => {
        const command = buildCommand('tar', args);
        return execFileSync(command.command, command.args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    };
    for (const part of ['app', 'nora-mcp']) {
        const archive = baseline.identity.archives[part];
        const file = path.join(baseline.directory, safeName(archive.name));
        assert.equal(fileDigest(file), archive.sha256);
        const members = tar(['-tzf', file]).trim().split(/\r?\n/);
        const expected = Object.keys(baseline.identity.artifacts).filter(name => name.startsWith(`${part}/`)).sort();
        assert.deepEqual([...members].sort(), expected, `Unexpected ${part} archive members`);
        for (const name of members) {
            assertSafeReleasePath(name);
            assert.ok(!name.includes(':') && !name.startsWith('-'));
        }
        assert.ok(tar(['-tvzf', file]).trim().split(/\r?\n/).every(line => line.startsWith('-')), 'Archive links are forbidden');
        tar(['-xzf', file, '-C', stage]);
        for (const name of expected) {
            const target = path.join(stage, name);
            assert.ok(fs.lstatSync(target).isFile());
            assert.equal(fileDigest(target), baseline.identity.artifacts[name], `Artifact mismatch: ${name}`);
        }
    }
    fs.writeFileSync(versionPath, version);
}

export function reuseArchive(baseline, entry, members, stage, destination) {
    if (!entry) return false;
    const expected = entry.artifacts || Object.keys(baseline.identity.artifacts).filter(name => name.startsWith(`${entry.part}/`));
    if (JSON.stringify([...members].sort()) !== JSON.stringify([...expected].sort())) return false;
    if (members.some(name => digest(fs.readFileSync(path.join(stage, name))) !== baseline.identity.artifacts[name]
        || (fs.statSync(path.join(stage, name)).mode & 0o111 ? 0o755 : 0o644) !== baseline.identity.artifactModes?.[name])) return false;
    const source = path.join(baseline.directory, safeName(entry.name));
    assert.equal(fileDigest(source), entry.sha256, `Archive checksum mismatch: ${entry.name}`);
    fs.copyFileSync(source, destination);
    return true;
}

function main() {
    const [tag, platform, output] = process.argv.slice(2);
    const appOnly=process.argv.includes('--app-only');
    assert.match(tag || '', /^v\d+\.\d+\.\d+$/);
    assert.ok(PLATFORMS.includes(platform));
    assert.ok(output && !fs.existsSync(output), 'Use a new baseline directory');
    const catalogue = readAssetCatalogue({ tag });
    materializeAcceptanceBaseline({tag,platform,output});
    const download = (asset, name = asset, entry) => downloadCatalogueAsset(catalogue, asset, output, { targetName: name, expected: entry });
    const system = json(path.join(output, `nora-system-${platform}.json`));
    const baseline = json(path.join(output, 'release-manifest.json'));
    materializeCoreReference(catalogue,output);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const source = createReleaseSource(root, { candidate: true });
    try { assertLauncherReuse(source.identity, baseline,{appOnly}); }
    finally { fs.rmSync(source.stage, { recursive: true, force: true }); }
    download('release-manifest.json', 'shared-release-manifest.json');
    download('SHA256SUMS', 'shared-SHA256SUMS');
    const shared = json(path.join(output, 'shared-release-manifest.json'));
    assertBaselineCatalogue(catalogue, shared);
    if(!system.coreRelease)assert.equal(shared.commit, baseline.commit);
    for (const entry of Object.values(shared.modules)) {
        download(entry.name);
        assert.equal(fileDigest(path.join(output, entry.name)), entry.sha256);
    }
    readBaseline(output, source.identity, platform,{appOnly});
    console.log(`Verified launcher baseline ${tag} (${platform}) in ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
