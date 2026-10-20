import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { COMPONENT_PLATFORMS, prepareComponentPayload, sealComponentAcceptance, verifyComponentNative, runComponentNative } from '../tooling/release/component-acceptance.mjs';
import { componentAcceptanceFixture } from './helpers/component-acceptance-fixture.mjs';
const { verifyComponentAcceptance } = createRequire(import.meta.url)('../tooling/release/publication-source.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-component-native-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, ...componentAcceptanceFixture(root) };
}
test('component publication consumes all raw native reports and exact frozen delivery', async t => {
    const f = fixture(t), result = await verifyComponentAcceptance(f.delivery, f.reports, f.planRoot, f.commit);
    assert.deepEqual(Object.keys(result.native).sort(), [...COMPONENT_PLATFORMS].sort());
    for (const platform of COMPONENT_PLATFORMS) {
        assert.deepEqual(Object.keys(result.native[platform].reportSha256).sort(), ['fresh', 'running', 'stopped']);
        assert.equal(fs.existsSync(path.join(f.reports, `nora-component-native-${platform}`, 'component-native-acceptance.json')), false);
        const output = path.join(f.root, 'payload-' + platform);
        prepareComponentPayload({ ...f, output, platform });
        const system = JSON.parse(fs.readFileSync(path.join(output, 'nora-system.json')));
        for (const [name, entry] of Object.entries(system.files))
            assert.deepEqual(fs.readFileSync(path.join(output, name)), fs.readFileSync(path.join(f.delivery, entry.asset)));
    }
});
for (const [label, change] of [
    ['missing Windows evidence', f => fs.rmSync(path.join(f.reports, 'nora-component-native-win32-x64'), { recursive: true })],
    ['missing stopped upgrade', f => fs.rmSync(path.join(f.reports, 'nora-component-native-darwin-x64/stopped'), { recursive: true })],
    ['missing fresh installation', f => fs.rmSync(path.join(f.reports, 'nora-component-native-darwin-arm64/fresh'), { recursive: true })],
    ['mutated delivery', f => fs.appendFileSync(path.join(f.delivery, 'darwin-arm64-release-manifest.json'), ' ')],
    ['mutated raw evidence', f => fs.appendFileSync(path.join(f.reports, 'nora-component-native-darwin-arm64/running/harness-result.json'), ' ')],
    ['source-only historical receipt', f => f.write(f.reports, 'component-acceptance.json', { ...f.receipt, schema: 'nora-component-acceptance/1' })],
    ['wrong final native binding', f => f.write(f.reports, 'component-acceptance.json', { ...f.receipt, native: {} })],
]) test(`component publication refuses ${label}`, async t => {
    const f = fixture(t); change(f);
    await assert.rejects(verifyComponentAcceptance(f.delivery, f.reports, f.planRoot, f.commit));
});
for (const [label, change, expected] of [
    ['active executors', value => { value.executorHandles = 'unconfirmed'; }, /verified-closed/],
    ['changed user data', value => { value.userData = 'changed'; }, /retained/],
    ['changed model configuration', value => { value.userConfigurationDigest = '0'.repeat(64); }, /fixtures disagree/],
    ['incorrect service state', value => { value.updateInitialService = 'stopped'; }, /running/],
    ['missing actor provenance', value => { delete value.actorSourceFiles['operation_cli.py']; }, /guarded actor/],
]) test(`final receipt cannot hide ${label}`, t => {
    const f = fixture(t), reports = path.join(f.reports, 'nora-component-native-win32-x64');
    const file = path.join(reports, 'running/harness-result.json'), value = JSON.parse(fs.readFileSync(file));
    change(value); f.write(reports, 'running/harness-result.json', value);
    // Rebinding a final receipt must not bypass validation of raw report facts.
    const { createHash } = createRequire(import.meta.url)('node:crypto');
    f.receipt.native['win32-x64'].reportSha256.running = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    f.write(f.reports, 'component-acceptance.json', f.receipt);
    assert.throws(() => verifyComponentNative({ ...f, reports, platform: 'win32-x64' }), expected);
    assert.throws(() => sealComponentAcceptance({ ...f, output: path.join(f.root, 'new-receipt.json') }));
});
test('payload preparation refuses cross-platform or stale component bytes before creating output', t => {
    const f = fixture(t), name = 'nora-system-win32-x64.json', system = JSON.parse(fs.readFileSync(path.join(f.delivery, name)));
    system.files['release-manifest.json'].asset = 'darwin-arm64-release-manifest.json'; f.write(f.delivery, name, system);
    const output = path.join(f.root, 'bad-payload');
    assert.throws(() => prepareComponentPayload({ ...f, output, platform: 'win32-x64' }));
    assert.equal(fs.existsSync(output), false);
});

function runnerFixture(t) {
    const f = fixture(t), platform = `${process.platform}-${process.arch}`;
    const payload = path.join(f.root, 'runner-payload');
    prepareComponentPayload({ ...f, output: payload, platform });
    const baseline = path.join(f.root, 'runner-baseline'); fs.mkdirSync(baseline);
    const baselineBytes = Buffer.from(JSON.stringify({ versions: { tavern: '2.5.4' } }));
    fs.writeFileSync(path.join(baseline, 'release-manifest.json'), baselineBytes);
    const { createHash } = createRequire(import.meta.url)('node:crypto');
    const source = JSON.parse(fs.readFileSync(path.join(f.reports, `nora-component-native-${platform}`, 'baseline-source-receipt.json')));
    source.payloadManifestSha256 = createHash('sha256').update(baselineBytes).digest('hex');
    source.files['release-manifest.json'].sha256 = source.payloadManifestSha256;
    f.write(baseline, 'baseline-source-receipt.json', source);
    const calls = [], reports = path.join(f.root, 'runner-reports'), scratch = path.join(f.root, 'runner-scratch');
    const run = (command, args, settings) => {
        assert.equal(command, process.execPath); assert.equal(settings.stdio, 'inherit');
        assert.ok(args[0].endsWith(path.join('tooling', 'run.mjs')));
        assert.equal(args[args.indexOf('--payload') + 1], payload);
        const state = args.includes('--start-state') ? args[args.indexOf('--start-state') + 1] : 'fresh'; calls.push(state);
        if (state === 'fresh') assert.ok(args.includes('--missing-system-receipt'));
        else assert.equal(args[args.indexOf('--baseline-release') + 1], baseline);
        const base = args[args.indexOf('--scratch-base') + 1], installed = path.join(f.root, 'installed-' + state);
        f.write(installed, 'tavern/tavern-updates/installed.json', { version: '2.5.5' });
        const raw = JSON.parse(fs.readFileSync(path.join(f.reports, `nora-component-native-${platform}`, state, 'harness-result.json')));
        raw.root = installed; f.write(base, 'harness-result.json', raw);
    };
    return { ...f, payload, baseline, platform, reports, scratch, calls, run };
}

test('native component runner records all three original results without an intermediate summary', t => {
    const f = runnerFixture(t); runComponentNative(f);
    assert.deepEqual(f.calls, ['fresh', 'running', 'stopped']);
    assert.deepEqual(fs.readdirSync(f.reports).sort(), ['baseline-source-receipt.json', 'fresh', 'running', 'stopped']);
    const accepted = verifyComponentNative(f); assert.deepEqual(Object.keys(accepted.reportSha256).sort(), ['fresh', 'running', 'stopped']);
});

test('native component runner stops at executor failure and incomplete results cannot be accepted', t => {
    const f = runnerFixture(t); let executions = 0;
    assert.throws(() => runComponentNative({ ...f, run: (...args) => {
        if (++executions === 2) throw new Error('fixture executor failed');
        f.run(...args);
    } }), /fixture executor failed/);
    assert.equal(executions, 2); assert.deepEqual(f.calls, ['fresh']);
    assert.throws(() => verifyComponentNative(f));
    assert.equal(fs.existsSync(path.join(f.reports, 'stopped')), false);
});
