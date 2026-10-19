import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReleaseSource, collectRuntimeFiles, groupRuntimeModules, materializeUpdaterDependencies } from '../tooling/release/release-source.mjs';
import { fileDigest } from '../tooling/release/system-release.mjs';
import { buildCommand } from '../tooling/release/build-commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('native packaging scripts preserve empty optional arguments under the actual platform Bash', t => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-integrated-launcher.yml'), 'utf8');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-shell-arguments-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const capture = path.join(temporary, 'arguments.bin');
    const runtime = path.join(temporary, 'runtime with spaces').replaceAll('\\', '/');
    // Match the workflow shell; Windows PATH may also contain the WSL stub.
    const bash = process.platform === 'win32'
        ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
    assert.ok(fs.existsSync(bash), `Native workflow Bash is unavailable: ${bash}`);
    const script = name => {
        const section = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
        assert.ok(section, name);
        const block = section.split('        run: |\n')[1];
        assert.ok(block, name);
        return block.trimEnd().split('\n').map(line => line.slice(10)).join('\n')
            .replaceAll('${{ matrix.platform }}', 'darwin').replaceAll('${{ matrix.arch }}', 'arm64');
    };
    const run = (name, env = {}) => {
        fs.writeFileSync(capture, '');
        const output = execFileSync(bash, ['--noprofile', '--norc', '-c',
            'node() { printf "%s\\0" "$@" >> "$NORA_TEST_ARGV_CAPTURE"; }\nprintf "%s\\n" "$PWD"\n' + script(name)], {
            cwd: temporary, encoding: 'utf8', env: { ...process.env,
                NORA_TEST_ARGV_CAPTURE: capture.replaceAll('\\', '/'), RUNNER_TEMP: runtime,
                NORA_APP_ONLY: 'false', PRODUCTION_MODE: 'true', GITHUB_REF_TYPE: 'branch',
                NORA_COMPONENT_PUBLICATION_TAG: '', NORA_UPDATE_COMPATIBILITY_FILE: '',
                LAUNCHER_BASELINE: '', BASELINE_TAG: 'v2.5.2', ...env }, timeout: 10000,
        });
        const args = fs.readFileSync(capture, 'utf8').split('\0');
        assert.equal(args.pop(), '');
        return { cwd: output.trim(), args };
    };
    const payload = 'Build release payload';
    let result = run(payload);
    assert.deepEqual(result.args, [`${result.cwd}/tooling/release/package-release.mjs`, '--hermes-runtime-manifest', `${runtime}/hermes-runtime/nora-hermes-runtime.json`]);
    result = run(payload, { PRODUCTION_MODE: 'false' });
    assert.deepEqual(result.args, [`${result.cwd}/tooling/release/package-release.mjs`, '--candidate', '--hermes-runtime-manifest', `${runtime}/hermes-runtime/nora-hermes-runtime.json`]);
    result = run(payload, { LAUNCHER_BASELINE: 'v2.5.2' });
    assert.deepEqual(result.args, [`${result.cwd}/tooling/release/package-release.mjs`, '--launcher-baseline', `${runtime}/launcher-baseline`]);
    const compatibility = 'tooling/release/compatibility/reviewed file.json';
    result = run(payload, { NORA_APP_ONLY: 'true', LAUNCHER_BASELINE: 'v2.5.2',
        NORA_COMPONENT_PUBLICATION_TAG: 'v2.5.4', NORA_UPDATE_COMPATIBILITY_FILE: compatibility });
    assert.deepEqual(result.args, [`${result.cwd}/tooling/release/package-release.mjs`, '--app-only', '--publication-tag', 'v2.5.4',
        '--update-compatibility', compatibility, '--launcher-baseline', `${runtime}/launcher-baseline`]);
    for (const appOnly of ['false', 'true']) {
        result = run('Download and verify unchanged published components', { NORA_APP_ONLY: appOnly });
        assert.deepEqual(result.args, [`${result.cwd}/tooling/release/launcher-build-baseline.mjs`, 'v2.5.2', 'darwin-arm64',
            `${runtime}/launcher-baseline`, ...(appOnly === 'true' ? ['--app-only'] : [])]);
    }
});

test('the packaged desktop includes its local JavaScript execution closure', t => {
    const source = createReleaseSource(root, { candidate: true });
    t.after(() => fs.rmSync(source.stage, { recursive: true, force: true }));
    const desktop = path.join(source.stage, 'ops/installer/desktop');
    const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json')));
    const included = new Set([...pkg.build.files, 'package.json']);
    const pending = [...included].filter(name => /\.js$/.test(name));
    for (const name of pending) {
        const text = fs.readFileSync(path.join(desktop, name), 'utf8');
        for (const match of text.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
            const relative = match[1];
            const file = path.extname(relative) ? relative : relative + '.js';
            assert.ok(included.has(file), `${name} requires ${file}, which is absent from the APP archive`);
        }
    }
});

for (const kind of ['same','changed','app-only']) test(`real packager: ${kind} without npm builds`, { timeout: 120000 }, t => {
    const changed=kind==='changed',appOnly=kind==='app-only';
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-package-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const source = createReleaseSource(root, { candidate: true });
    t.after(() => fs.rmSync(source.stage, { recursive: true, force: true }));
    // Synthetic compiled bytes test packaging only, not a runnable Tavern installation.
    for (const directory of ['app/engine/sillytavern/public/dist/nora', 'app/engine/sillytavern/dist/_webpack/output', 'nora-mcp/dist']) {
        fs.mkdirSync(path.join(source.stage, directory), { recursive: true });
        fs.writeFileSync(path.join(source.stage, directory, 'fixture.js'), '// compiled fixture\n');
    }
    const services = fs.readFileSync(path.join(source.stage, 'ops/installer/launcher_services.py'));
    if (changed) {
        fs.writeFileSync(path.join(source.stage, 'ops/installer/launcher_services.py'), '# previous launcher services\n');
        fs.writeFileSync(path.join(source.stage, 'app/.tavern-release-version'), '0.0.1');
        source.identity.sourceFiles['deployment/shared/services.py'] = 'b'.repeat(64);
        source.identity.sourceFiles['app/.tavern-release-version'] = 'c'.repeat(64);
    }
    // A current sealed baseline already contains the actor's exact production
    // closure. Preparing that fixture is separate from the packager invocation;
    // the reuse path below must still perform no npm/build work.
    materializeUpdaterDependencies(source.stage, { install: directory => {
        const npm = buildCommand('npm', ['ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund']);
        execFileSync(npm.command, npm.args, { cwd: directory, stdio: 'pipe', timeout: 60000 });
    } });
    const members = collectRuntimeFiles(source.stage, source.files);
    const baseline = { ...source.identity, candidate: false, dirty: false,
        versions: { tavern: fs.readFileSync(path.join(source.stage, 'app/.tavern-release-version'), 'utf8').trim() },
        artifacts: {}, artifactModes: {}, archives: {}, modules: {} };
    for (const name of members) {
        baseline.artifacts[name] = fileDigest(path.join(source.stage, name));
        baseline.artifactModes[name] = fs.statSync(path.join(source.stage, name)).mode & 0o111 ? 0o755 : 0o644;
    }
    const archive = (name, files) => {
        const list = path.join(temporary, 'members.txt');
        fs.writeFileSync(list, files.join('\n') + '\n');
        const command = buildCommand('tar', ['--no-xattrs', '-czf', path.join(temporary, name), '-C', source.stage, '-T', list]);
        execFileSync(command.command, command.args, { env: { ...process.env, COPYFILE_DISABLE: '1' } });
        return { name, sha256: fileDigest(path.join(temporary, name)) };
    };
    for (const part of ['app', 'ops', 'nora-mcp']) baseline.archives[part] = archive(`nora-tavern-${part}.tar.gz`, members.filter(name => name.startsWith(`${part}/`)));
    for (const [module, files] of groupRuntimeModules(members)) baseline.modules[module] = {
        ...archive(`nora-tavern-module-${module}.tar.gz`, files), artifacts: files,
    };
    const system = { schema: 'nora-system/v1', platform: process.platform, arch: process.arch,
        candidate: false, channel: 'stable', commit: baseline.commit, version: baseline.versions.tavern, files: {} };
    const write = (name, value) => {
        fs.writeFileSync(path.join(temporary, name), typeof value === 'string' ? value : JSON.stringify(value));
        system.files[name] = { size: fs.statSync(path.join(temporary, name)).size, sha256: fileDigest(path.join(temporary, name)) };
    };
    for (const [name, key] of [['nora-hermes-runtime.json', 'hermesRuntime'], ['nora-tavern-dependencies.json', 'dependencies']]) {
        const archive = `${key}.tar.gz`;
        write(archive, 'synthetic environment');
        baseline[key] = { schema: 1, platform: process.platform, arch: process.arch, archive, ...system.files[archive] };
        write(name, baseline[key]);
    }
    if(appOnly){baseline.launcherVersion='2.2.1';for(const entry of [...Object.values(baseline.archives),...Object.values(baseline.modules)])system.files[entry.name]={asset:`${process.platform}-${process.arch}-${entry.name}`,size:fs.statSync(path.join(temporary,entry.name)).size,sha256:entry.sha256};write('SHA256SUMS','original core checksum table\n');}
    write('release-manifest.json', baseline);
    if(appOnly){for(const [name,entry]of Object.entries(system.files))entry.asset=`${process.platform}-${process.arch}-${name}`;
      fs.writeFileSync(path.join(temporary,'baseline-core-reference.json'),JSON.stringify({schema:'nora-core-reference/1',tag:'v'+baseline.versions.tavern,commit:baseline.commit,manifests:{[`${process.platform}-${process.arch}`]:system.files['release-manifest.json']}}));}
    write(`nora-system-${process.platform}-${process.arch}.json`, system);
    const output = execFileSync(process.execPath, ['tooling/release/package-release.mjs', '--candidate', '--launcher-baseline', temporary,...(appOnly?['--app-only','--publication-tag','v9.0.0']:[])],
        { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    const release = /^release=(.+)$/m.exec(output)?.[1];
    assert.ok(release);
    t.after(() => fs.rmSync(release, { recursive: true, force: true }));
    const result = JSON.parse(fs.readFileSync(path.join(release, 'release-manifest.json')));
    for (const descriptor of [...Object.values(result.archives), ...Object.values(result.modules)]) {
        const archive = path.join(release, descriptor.name);
        assert.equal(descriptor.size, fs.statSync(archive).size, `Actual sealed archive size: ${descriptor.name}`);
        assert.equal(descriptor.sha256, fileDigest(archive), `Full archive SHA-256: ${descriptor.name}`);
    }
    assert.equal(result.candidate, true);
    assert.equal(result.bootstrap.minimumLauncherVersion,
        JSON.parse(fs.readFileSync(path.join(root,'launcher/desktop/package.json'))).version);
    assert.deepEqual(result.launcherBuildReuse.modules, Object.fromEntries(Object.entries(baseline.modules)
        .filter(([, item]) => item.artifacts.every(name => baseline.artifacts[name] === result.artifacts[name]))
        .map(([name, item]) => [name, item.sha256])));
    for (const key of ['app', 'ops', 'nora-mcp']) {
        if (changed && key !== 'nora-mcp') assert.notEqual(result.archives[key].sha256, baseline.archives[key].sha256);
        else assert.equal(result.archives[key].sha256, baseline.archives[key].sha256);
    }
    assert.equal(result.artifacts['ops/installer/launcher_services.py'], fileDigest(path.join(root, 'deployment/shared/services.py')));
    const payload = path.join(release, 'nora-tavern-launcher/payload');
    for (const name of ['hermesRuntime.tar.gz', 'dependencies.tar.gz']) assert.equal(fileDigest(path.join(payload, name)), system.files[name].sha256);
    if(appOnly){assert.deepEqual(fs.readFileSync(path.join(payload,'release-manifest.json')),fs.readFileSync(path.join(temporary,'release-manifest.json')));assert.equal(result.coreRelease.manifests[`${process.platform}-${process.arch}`].sha256,fileDigest(path.join(payload,'release-manifest.json')));assert.notEqual(fileDigest(path.join(release,'release-manifest.json')),fileDigest(path.join(payload,'release-manifest.json')));}
    const desktop = path.join(release, 'nora-tavern-launcher/desktop');
    assert.ok(fs.existsSync(path.join(desktop, 'main.js')));
    assert.ok(fs.existsSync(path.join(release, 'nora-tavern-launcher/launcher_services.py')));
    assert.deepEqual(fs.readFileSync(path.join(release, 'nora-tavern-launcher/launcher_services.py')), services);
    assert.ok(fs.existsSync(path.join(payload, 'nora-system.json')));
    assert.ok(!fs.existsSync(path.join(desktop, 'node_modules')));
    assert.ok(!output.includes('npm'));
});
