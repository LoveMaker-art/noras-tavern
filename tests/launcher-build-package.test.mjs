import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReleaseSource, collectRuntimeFiles, groupRuntimeModules } from '../tooling/release/release-source.mjs';
import { fileDigest } from '../tooling/release/system-release.mjs';
import { buildCommand } from '../tooling/release/build-commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const changed of [false, true]) test(`real packager: ${changed ? 'changed launcher resources and product version' : 'unchanged payload'} without npm builds`, { timeout: 120000 }, t => {
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
    write('release-manifest.json', baseline);
    write(`nora-system-${process.platform}-${process.arch}.json`, system);
    const output = execFileSync(process.execPath, ['tooling/release/package-release.mjs', '--candidate', '--launcher-baseline', temporary],
        { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    const release = /^release=(.+)$/m.exec(output)?.[1];
    assert.ok(release);
    t.after(() => fs.rmSync(release, { recursive: true, force: true }));
    const result = JSON.parse(fs.readFileSync(path.join(release, 'release-manifest.json')));
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
    const desktop = path.join(release, 'nora-tavern-launcher/desktop');
    assert.ok(fs.existsSync(path.join(desktop, 'main.js')));
    assert.ok(fs.existsSync(path.join(release, 'nora-tavern-launcher/launcher_services.py')));
    assert.deepEqual(fs.readFileSync(path.join(release, 'nora-tavern-launcher/launcher_services.py')), services);
    assert.ok(fs.existsSync(path.join(payload, 'nora-system.json')));
    assert.ok(!fs.existsSync(path.join(desktop, 'node_modules')));
    assert.ok(!output.includes('npm'));
});
