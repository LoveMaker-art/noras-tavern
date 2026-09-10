import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fileDigest, writeSystemRelease } from './system-release.mjs';
import { assertNoraSystemArtifacts } from './release-source.mjs';

export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const REPO = 'LoveMaker-art/noras-tavern';
const CORE = ['nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz',
    'nora-tavern-first-install-bootstrap.py', 'first-install-manifest.json'];
const IMMUTABLE_PREFIXES = ['launcher/', 'deployment/install/', 'deployment/shared/',
    'deployment/uninstall/', 'tooling/runtime/'];
const IMMUTABLE_FILES = ['deployment/update/releases.js', 'deployment/update/system-update.js',
    'tooling/release/package-hermes-runtime.mjs', 'tooling/source-layout.json',
    'app/engine/sillytavern/package.json', 'app/engine/sillytavern/package-lock.json',
    'nora-mcp/package.json', 'nora-mcp/npm-shrinkwrap.json'];
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const safeName = name => {
    assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    return name;
};

export function assertReusable(current, baseline) {
    assert.equal(current.schema, 'tavern-release/v2');
    assert.equal(baseline.schema, 'tavern-release/v2');
    assert.equal(baseline.candidate, false, 'Runtime baseline must be a published stable release');
    assert.ok(current.sourceFiles && baseline.sourceFiles, 'Missing source fingerprints');
    const selected = name => IMMUTABLE_FILES.includes(name) || IMMUTABLE_PREFIXES.some(prefix => name.startsWith(prefix));
    const guarded = [...new Set([...Object.keys(current.sourceFiles), ...Object.keys(baseline.sourceFiles)])].filter(selected);
    assert.ok(IMMUTABLE_FILES.every(name => baseline.sourceFiles[name]), 'Baseline lacks dependency or launcher fingerprints');
    const changed = guarded.filter(name => current.sourceFiles[name] !== baseline.sourceFiles[name]);
    assert.equal(changed.length, 0, `Full launcher build required; immutable inputs changed: ${changed.join(', ')}`);
    assertNoraSystemArtifacts(Object.keys(current.artifacts || {}));
}

export function verifyFile(file, entry) {
    assert.ok(entry && /^[a-f0-9]{64}$/.test(entry.sha256), 'Missing component checksum');
    assert.equal(fs.statSync(file).size, entry.size, `Component size mismatch: ${path.basename(file)}`);
    assert.equal(fileDigest(file), entry.sha256, `Component checksum mismatch: ${path.basename(file)}`);
}

export function assemblePlatform({ release, baseline, system, baselineRoot, output, candidate = false }) {
    const current = json(path.join(release, 'release-manifest.json'));
    assertReusable(current, baseline);
    assert.equal(system.schema, 'nora-system/v1');
    assert.equal(system.candidate, false);
    assert.equal(system.channel, 'stable');
    assert.equal(system.commit, baseline.commit);
    assert.equal(system.version, baseline.versions.tavern);
    const platform = `${system.platform}-${system.arch}`;
    assert.ok(PLATFORMS.includes(platform));
    assert.equal(current.candidate, candidate);
    const runtime = json(path.join(baselineRoot, 'nora-hermes-runtime.json'));
    const dependencies = json(path.join(baselineRoot, 'nora-tavern-dependencies.json'));
    for (const item of [runtime, dependencies]) {
        assert.equal(`${item.platform}-${item.arch}`, platform);
        assert.equal(item.schema, 1);
        assert.equal(item.sha256, system.files[safeName(item.archive)]?.sha256);
    }
    assert.equal(baseline.hermesRuntime.sha256, runtime.sha256);
    assert.equal(baseline.dependencies.sha256, dependencies.sha256);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-component-payload-'));
    try {
        const checks = [];
        const add = (name, source) => {
            const target = path.join(temporary, safeName(name));
            fs.copyFileSync(source, target);
            checks.push(`${fileDigest(target)}  ${name}`);
        };
        for (const name of CORE) add(name, path.join(release, name));
        for (const name of ['nora-hermes-runtime.json', 'nora-tavern-dependencies.json', runtime.archive, dependencies.archive]) {
            const file = path.join(baselineRoot, safeName(name));
            verifyFile(file, system.files[name]);
            add(name, file);
        }
        const identity = { ...current, hermesRuntime: baseline.hermesRuntime, dependencies: baseline.dependencies };
        fs.writeFileSync(path.join(temporary, 'release-manifest.json'), JSON.stringify(identity, null, 2) + '\n');
        checks.push(`${fileDigest(path.join(temporary, 'release-manifest.json'))}  release-manifest.json`);
        fs.writeFileSync(path.join(temporary, 'SHA256SUMS'), checks.join('\n') + '\n');
        writeSystemRelease({ release: output, payload: temporary, identity, launcherVersion: system.launcherVersion,
            minimumLauncherVersion: system.minimumLauncherVersion });
        return { platform, runtimeSha256: runtime.sha256, dependenciesSha256: dependencies.sha256 };
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function main() {
    const [releaseArg, baselineTag, outputArg] = process.argv.slice(2);
    assert.ok(releaseArg && outputArg, 'Usage: <shared-release-directory> <stable-baseline-tag> <output-directory>');
    assert.match(baselineTag, /^v\d+\.\d+\.\d+$/);
    const release = path.resolve(releaseArg), output = path.resolve(outputArg);
    const current = json(path.join(release, 'release-manifest.json'));
    assert.equal(current.candidate, false, 'Public updates require a clean committed release');
    assert.ok(!fs.existsSync(output), 'Output must be a new directory');
    const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const metadata = JSON.parse(gh(['release', 'view', baselineTag, '--repo', REPO,
        '--json', 'tagName,isDraft,isPrerelease,assets']));
    assert.equal(metadata.tagName, baselineTag);
    assert.equal(metadata.isDraft, false);
    assert.equal(metadata.isPrerelease, false);
    const names = metadata.assets.map(asset => asset.name);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-component-baseline-'));
    const download = (name, directory) => {
        safeName(name);
        assert.ok(names.includes(name), `Missing baseline asset: ${name}`);
        gh(['release', 'download', baselineTag, '--repo', REPO, '--pattern', name, '--dir', directory]);
        return path.join(directory, name);
    };
    try {
        const inputs = [];
        // Validate every platform before downloading any multi-GB environment.
        for (const platform of PLATFORMS) {
            const directory = path.join(work, platform); fs.mkdirSync(directory);
            const system = json(download(`nora-system-${platform}.json`, directory));
            assert.equal(`${system.platform}-${system.arch}`, platform);
            for (const name of ['release-manifest.json', 'nora-hermes-runtime.json', 'nora-tavern-dependencies.json']) {
                const item = system.files[name];
                const file = download(item.asset, directory);
                verifyFile(file, item);
                fs.renameSync(file, path.join(directory, name));
            }
            const baseline = json(path.join(directory, 'release-manifest.json'));
            assertReusable(current, baseline);
            assert.equal(system.version, baselineTag.slice(1));
            inputs.push({ directory, baseline, system });
        }
        let installerTag = baselineTag;
        let installers = names.filter(name => /^Nora-Tavern-Launcher-/.test(name) && /(?:-mac-(?:arm64|x64)\.dmg|-win-x64-setup\.exe)$/.test(name));
        if (names.includes('component-release.json')) {
            const previous = json(download('component-release.json', work));
            installerTag = previous.installerTag; installers = previous.installers;
            assert.match(installerTag, /^v\d+\.\d+\.\d+$/);
            const original = JSON.parse(gh(['release', 'view', installerTag, '--repo', REPO, '--json', 'isDraft,isPrerelease,assets']));
            assert.equal(original.isDraft, false); assert.equal(original.isPrerelease, false);
            assert.ok(installers.every(name => original.assets.some(asset => asset.name === name)), 'Original installers no longer exist');
        }
        assert.equal(installers.length, 3, 'Three original installers are required');
        fs.mkdirSync(output, { recursive: true });
        const shared = path.join(output, 'shared'); fs.mkdirSync(shared);
        for (const name of fs.readdirSync(release)) {
            if (fs.statSync(path.join(release, name)).isFile()) fs.copyFileSync(path.join(release, name), path.join(shared, name));
        }
        const reused = [];
        for (const { directory, baseline, system } of inputs) {
            for (const manifest of ['nora-hermes-runtime.json', 'nora-tavern-dependencies.json']) {
                const { archive } = json(path.join(directory, manifest));
                const item = system.files[safeName(archive)];
                const file = download(item.asset, directory);
                verifyFile(file, item);
                fs.renameSync(file, path.join(directory, archive));
            }
            reused.push(assemblePlatform({ release, baseline, system, baselineRoot: directory, output }));
        }
        fs.writeFileSync(path.join(output, 'component-release.json'), JSON.stringify({
            schema: 'nora-component-release/v1', version: current.versions.tavern, commit: current.commit,
            baselineTag, installerTag, installers, reused,
        }, null, 2) + '\n');
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
