// Component acceptance uses the same sealed bytes and native product harness as
// full releases. Source tests alone cannot authorize a component publication.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileDigest as hashFile } from './system-release.mjs';

export const COMPONENT_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
const safe = value => { assert.match(value || '', /^[A-Za-z0-9][A-Za-z0-9._-]*$/); return value; };
const json = value => JSON.stringify(value, null, 2) + '\n';
const files = root => fs.readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
    assert.ok(!entry.isSymbolicLink(), 'Linked component acceptance input');
    assert.ok(entry.isFile() || entry.isDirectory(), 'Invalid component acceptance input');
    return entry.isFile() ? path.join(entry.parentPath, entry.name) : null;
}).filter(Boolean);
const find = (root, name) => {
    const matches = files(root).filter(file => path.basename(file) === safe(name));
    assert.equal(matches.length, 1, `Missing or duplicate component input: ${name}`);
    return matches[0];
};
const versionParts = value => { assert.match(value || '', /^\d+\.\d+\.\d+$/); return value.split('.').map(Number); };
function assertUpgradeVersion(before, after) {
    const old = versionParts(before), next = versionParts(after);
    const changed = next.findIndex((value, index) => value !== old[index]);
    assert.ok(changed >= 0 && next[changed] > old[changed], 'Component acceptance requires a newer core version');
}

export function componentInventory(root) {
    const inventory = {};
    for (const file of files(root)) {
        const name = path.basename(file); safe(name);
        assert.ok(!Object.keys(inventory).some(key => key.toLowerCase() === name.toLowerCase()), 'Duplicate component delivery basename');
        inventory[name] = { size: fs.statSync(file).size, sha256: hashFile(file) };
    }
    return inventory;
}

/** Materialize the exact platform closure, without repacking or downloading a
 * replacement environment. The system manifest binds every logical file. */
export function prepareComponentPayload({ delivery, output, platform, commit }) {
    assert.ok(COMPONENT_PLATFORMS.includes(platform)); assert.match(commit, /^[a-f0-9]{40}$/);
    assert.ok(!fs.existsSync(output), 'Component payload must be a new directory');
    const inventory = componentInventory(delivery);
    const systemFile = find(delivery, `nora-system-${platform}.json`), system = read(systemFile);
    assert.equal(system.schema, 'nora-system/v1'); assert.equal(`${system.platform}-${system.arch}`, platform);
    assert.equal(system.commit, commit); assert.equal(system.candidate, false); assert.equal(system.channel, 'stable');
    const product = read(find(delivery, 'release-manifest.json'));
    assert.equal(product.commit, commit); assert.equal(product.candidate, false); assert.equal(product.dirty, false);
    assert.equal(system.version, product.versions.tavern);
    assert.ok(system.files && Object.keys(system.files).length > 0);
    for (const [name, entry] of Object.entries(system.files)) {
        safe(name); safe(entry.asset); assert.equal(entry.asset, `${platform}-${name}`);
        assert.notEqual(name, 'nora-system.json', 'System manifest cannot replace its own binding');
        assert.deepEqual(inventory[entry.asset], { size: entry.size, sha256: entry.sha256 }, `Frozen component differs: ${name}`);
    }
    const payload = read(find(delivery, system.files['release-manifest.json'].asset));
    assert.equal(payload.commit, commit); assert.equal(payload.candidate, false); assert.equal(payload.dirty, false);
    assert.deepEqual(payload.artifacts, product.artifacts); assert.deepEqual(payload.versions, product.versions);
    for (const [name, key] of [['nora-hermes-runtime.json', 'hermesRuntime'], ['nora-tavern-dependencies.json', 'dependencies']]) {
        const descriptor = read(find(delivery, system.files[name].asset));
        assert.equal(`${descriptor.platform}-${descriptor.arch}`, platform);
        assert.equal(descriptor.sha256, payload[key].sha256);
        assert.equal(system.files[safe(descriptor.archive)]?.sha256, descriptor.sha256);
    }
    fs.mkdirSync(output, { recursive: true });
    try {
        for (const [name, entry] of Object.entries(system.files)) fs.copyFileSync(find(delivery, entry.asset), path.join(output, name));
        fs.copyFileSync(systemFile, path.join(output, 'nora-system.json'));
    } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
    return system;
}

/** Inspect raw harness evidence again at publication; a successful matrix job
 * or a summary containing outcome=passed is insufficient. */
export function verifyComponentNative({ delivery, reports, platform, commit, baselineTag, baselineCommit }) {
    assert.ok(COMPONENT_PLATFORMS.includes(platform));
    const systemFile = find(delivery, `nora-system-${platform}.json`), systemBytes = fs.readFileSync(systemFile), system = JSON.parse(systemBytes);
    assert.equal(system.commit, commit); assert.equal(system.candidate, false); assert.equal(`${system.platform}-${system.arch}`, platform);
    const entry = system.files['release-manifest.json'], payloadBytes = fs.readFileSync(find(delivery, entry.asset)), payload = JSON.parse(payloadBytes);
    assert.equal(payloadBytes.length, entry.size); assert.equal(digest(payloadBytes), entry.sha256);
    const product = read(find(delivery, 'release-manifest.json'));
    assert.equal(product.commit, commit); assert.deepEqual(payload.artifacts, product.artifacts);
    assert.equal(payload.candidate, false); assert.equal(payload.dirty, false); assert.equal(payload.versions.tavern, system.version);
    const receiptFile = find(reports, 'baseline-source-receipt.json'), receiptBytes = fs.readFileSync(receiptFile), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.schema, 'nora-acceptance-baseline/1'); assert.equal(receipt.mode, 'materialized');
    assert.equal(receipt.platform, platform); assert.equal(receipt.tag, baselineTag);
    assert.equal(receipt.productCommit || receipt.commit, baselineCommit, 'Native baseline differs from the frozen change plan');
    assert.equal(receipt.verifiedFiles, receipt.declaredFiles); assert.ok(receipt.verifiedFiles > 0);
    assert.deepEqual([...receipt.verifiedNames].sort(), Object.keys(receipt.files).sort());
    assertUpgradeVersion(receipt.version, system.version);
    const expected = {
        platform, commit, baselineTag, baselineCommit, baselineVersion: receipt.version,
        baselineManifestSha256: receipt.payloadManifestSha256, sourceReceiptSha256: digest(receiptBytes),
        targetVersion: system.version, targetManifestSha256: digest(payloadBytes),
        systemManifestSha256: digest(systemBytes), runtimeSha256: payload.hermesRuntime.sha256,
    };
    const actualReports = files(reports).filter(file => path.basename(file) === 'harness-result.json');
    assert.equal(actualReports.length, 3, 'Component acceptance requires a fresh target installation and two native upgrade reports');
    let configurationDigest; const reportSha256 = {};
    for (const state of ['fresh', 'running', 'stopped']) {
        const reportFile = path.join(reports, state, 'harness-result.json');
        const value = read(reportFile);
        reportSha256[state] = hashFile(reportFile);
        assert.equal(value.schema, 'nora-launcher-products-smoke/1'); assert.equal(value.outcome, 'passed');
        assert.equal(`${value.platform}-${value.arch}`, platform);
        assert.equal(value.releaseManifestSha256, expected.targetManifestSha256); assert.equal(value.runtimeSha256, expected.runtimeSha256);
        assert.equal(value.actorSourceBinding, 'verified-selected-candidate-manifest');
        assert.ok(Object.keys(value.actorSourceFiles || {}).length > 0, 'Missing executed actor source hashes');
        for (const [name, hash] of Object.entries(value.actorSourceFiles)) assert.equal(hash, product.artifacts['ops/installer/' + name], `Component native actor differs: ${name}`);
        for (const name of ['operation_control.py', 'operation_cli.py', 'operation_evidence.py', 'desktop/operation-delegate.js'])
            assert.match(value.actorSourceFiles[name] || '', /^[a-f0-9]{64}$/, 'Missing guarded actor evidence');
        for (const key of ['operation', 'runtime', 'firstInstall', 'http', 'hermesSkills', 'mcp', 'stop']) assert.equal(value[key], 'verified', `Native component result missing: ${key}`);
        assert.equal(value.executorHandles, 'verified-closed'); assert.equal(value.userData, 'retained');
        assert.match(value.userConfigurationDigest || '', /^[a-f0-9]{64}$/);
        configurationDigest ||= value.userConfigurationDigest;
        assert.equal(value.userConfigurationDigest, configurationDigest, 'Native fixtures disagree on retained configuration');
        if (state === 'fresh') {
            assert.equal(value.committedFirstInstall, 'verified-real-resume-without-reinstall');
            assert.equal(value.missingSystemReceipt, 'verified-bound-repair-and-preserved-user-data');
            assert.equal(value.update, 'verified-noop'); assert.equal(value.changedSourceArtifacts, 0);
            assert.equal(value.releaseAcceptance, 'isolated-same-version-repair'); assert.equal(value.updateInitialService, 'running');
            assert.deepEqual(value.componentInstallation, { platform, commit, targetVersion: system.version,
                targetManifestSha256: expected.targetManifestSha256, installedVersion: system.version });
        } else {
            assert.equal(value.update, 'verified-content-transition'); assert.ok(value.changedSourceArtifacts > 0);
            assert.equal(value.releaseAcceptance, 'isolated-version-transition'); assert.equal(value.updateInitialService, state);
            assert.deepEqual(value.componentTransition, { ...expected, startState: state, installedVersion: system.version });
        }
    }
    return { ...expected, outcome: 'passed', freshInstallation: 'verified', states: ['running', 'stopped'], reportSha256 };
}

export function runComponentNative({ payload, baseline, reports, scratch, commit, baselineTag, baselineCommit, root = path.resolve(fileURLToPath(new URL('../../', import.meta.url))), run = execFileSync }) {
    const platform = `${process.platform}-${process.arch}`;
    assert.ok(COMPONENT_PLATFORMS.includes(platform)); assert.ok(!fs.existsSync(reports), 'Native reports must be a new directory');
    const sourceReceipt = path.join(baseline, 'baseline-source-receipt.json'), receipt = read(sourceReceipt);
    assert.equal(receipt.mode, 'materialized'); assert.equal(receipt.platform, platform); assert.equal(receipt.tag, baselineTag);
    assert.equal(receipt.productCommit || receipt.commit, baselineCommit);
    const systemBytes = fs.readFileSync(path.join(payload, 'nora-system.json')), system = JSON.parse(systemBytes);
    const payloadBytes = fs.readFileSync(path.join(payload, 'release-manifest.json')), identity = JSON.parse(payloadBytes);
    assert.equal(identity.commit, commit); assert.equal(system.commit, commit);
    assertUpgradeVersion(receipt.version, system.version);
    const expected = { platform, commit, baselineTag, baselineCommit, baselineVersion: receipt.version,
        baselineManifestSha256: receipt.payloadManifestSha256, sourceReceiptSha256: hashFile(sourceReceipt),
        targetVersion: system.version, targetManifestSha256: digest(payloadBytes), systemManifestSha256: digest(systemBytes), runtimeSha256: identity.hermesRuntime.sha256 };
    fs.mkdirSync(reports, { recursive: true }); fs.copyFileSync(sourceReceipt, path.join(reports, 'baseline-source-receipt.json'));
    for (const state of ['fresh', 'running', 'stopped']) {
        const base = path.join(scratch, state);
        const selected = state === 'fresh' ? ['--update-release', payload, '--missing-system-receipt']
            : ['--baseline-release', baseline, '--update-release', payload, '--start-state', state];
        run(process.execPath, [path.join(root, 'tooling/run.mjs'), 'node', path.join(root, 'tests/deployment/launcher_product_refactor_smoke.cjs'),
            '--payload', payload, ...selected, '--scratch-base', base, '--keep'], { cwd: root, stdio: 'inherit' });
        const source = find(base, 'harness-result.json'), value = read(source);
        const installed = read(path.join(value.root, 'tavern/tavern-updates/installed.json'));
        assert.equal(installed.version, system.version, 'Native installed version differs');
        assert.equal(hashFile(path.join(baseline, 'release-manifest.json')), receipt.payloadManifestSha256);
        assert.equal(hashFile(path.join(payload, 'release-manifest.json')), expected.targetManifestSha256);
        if (state === 'fresh') value.componentInstallation = { platform, commit, targetVersion: system.version,
            targetManifestSha256: expected.targetManifestSha256, installedVersion: installed.version };
        else value.componentTransition = { ...expected, startState: state, installedVersion: installed.version };
        fs.mkdirSync(path.join(reports, state)); const target = path.join(reports, state, 'harness-result.json');
        fs.writeFileSync(target, json(value));
    }
}

export function sealComponentAcceptance({ delivery, reports, plan, output, commit, tag }) {
    assert.equal(plan.source.commit, commit); assert.equal(plan.mode, 'components'); assert.equal(plan.requiresReview, false);
    const baselineTag = plan.baseline.ref, baselineCommit = plan.baseline.commit;
    assert.match(baselineTag, /^v\d+\.\d+\.\d+$/); assert.match(baselineCommit, /^[a-f0-9]{40}$/);
    const native = {};
    for (const platform of COMPONENT_PLATFORMS) native[platform] = verifyComponentNative({ delivery,
        reports: path.join(reports, `nora-component-native-${platform}`), platform, commit, baselineTag, baselineCommit });
    const receipt = { schema: 'nora-component-acceptance/2', commit, tag, outcome: 'passed', files: componentInventory(delivery), native };
    assert.ok(!fs.existsSync(output)); fs.writeFileSync(output, json(receipt)); return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'prepare') {
        assert.equal(args.length, 4); const [delivery, output, platform, commit] = args;
        prepareComponentPayload({ delivery, output, platform, commit });
    } else if (command === 'run') {
        assert.equal(args.length, 7); const [payload, baseline, reports, scratch, commit, baselineTag, baselineCommit] = args;
        runComponentNative({ payload, baseline, reports, scratch, commit, baselineTag, baselineCommit });
    } else if (command === 'seal') {
        assert.equal(args.length, 7); const [delivery, reports, planFile, output, commit, tag, baselineTag] = args;
        const plan = read(planFile); assert.equal(plan.baseline.ref, baselineTag);
        sealComponentAcceptance({ delivery, reports, plan, output, commit, tag });
    } else throw new Error('Use component-acceptance.mjs prepare|run|seal');
}
