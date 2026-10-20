import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { COMPONENT_PLATFORMS, prepareComponentPayload, sealComponentAcceptance, verifyComponentNative } from '../tooling/release/component-acceptance.mjs';
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
    ['incorrect service state', value => { value.updateInitialService = 'stopped'; }, /running/],
    ['missing actor provenance', value => { delete value.actorSourceFiles['operation_cli.py']; }, /guarded actor/],
]) test(`native summary cannot hide ${label}`, t => {
    const f = fixture(t), reports = path.join(f.reports, 'nora-component-native-win32-x64');
    const file = path.join(reports, 'running/harness-result.json'), value = JSON.parse(fs.readFileSync(file));
    change(value); f.write(reports, 'running/harness-result.json', value);
    const summaryFile = path.join(reports, 'component-native-acceptance.json'), summary = JSON.parse(fs.readFileSync(summaryFile));
    // Rebinding a fabricated summary must not bypass the individual assertions.
    // Use a real new hash, so the executor assertion rather than byte binding rejects.
    const { createHash } = createRequire(import.meta.url)('node:crypto');
    summary.states.running = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    f.write(reports, 'component-native-acceptance.json', summary);
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
