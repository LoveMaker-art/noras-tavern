import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readLayout, translatePath, deliveryEntries, projectDelivery } from '../tooling/layout.mjs';
import { createReleaseSource, digest, assertNoraSystemArtifacts } from '../tooling/release/release-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = readLayout(root);

test('source ownership maps to the existing delivery protocol in both directions', () => {
    for (const [source, delivery] of rules) {
        const suffix = source.endsWith('/') ? 'fixture.py' : '';
        assert.equal(translatePath(source + suffix, rules), delivery + suffix);
        assert.equal(translatePath(delivery + suffix, rules, true), source + suffix);
    }
    assert.equal(translatePath('deployment/install/install-location.js', rules), 'ops/installer/desktop/install-location.js');
    assert.equal(translatePath('ops/installer/desktop/install-location.js', rules, true), 'deployment/install/install-location.js');
    assert.equal(translatePath('nora/README.md', rules), 'nora/README.md');
});

test('unsafe paths, missing ownership, duplicate delivery and legacy authored copies fail closed', () => {
    assert.throws(() => translatePath('../escape', rules), /Unsafe/);
    assert.throws(() => translatePath('folder//file', rules), /Unsafe/);
    assert.throws(() => deliveryEntries(['deployment/new.py'], rules), /Missing delivery mapping/);
    assert.throws(() => deliveryEntries(['ops/updater/update.py'], rules), /Legacy authored/);
    assert.throws(() => deliveryEntries(['one', 'two'], [['one', 'same'], ['two', 'same']]), /Duplicate/);
    assert.throws(() => deliveryEntries(['one', 'two'], [['one', 'Same'], ['two', 'same']]), /Duplicate/);
});

test('candidate projection preserves every authored byte and requires the full Nora system', t => {
    const exported = createReleaseSource(root, { candidate: true });
    t.after(() => fs.rmSync(exported.stage, { recursive: true, force: true }));
    assertNoraSystemArtifacts(exported.files);
    const entries = deliveryEntries(Object.keys(exported.identity.sourceFiles), rules);
    for (const [source, delivery] of entries) {
        assert.equal(digest(fs.readFileSync(path.join(exported.stage, delivery))), exported.identity.sourceFiles[source], source);
    }
    for (const file of ['nora/SOUL.md', 'nora/AGENTS.md', 'nora/greeting.md', 'launcher/ui/index.html', 'launcher/ui/assets/nora-launcher-portrait.png',
        'nora/skills/system/model-provider-config/SKILL.md', 'nora/skills/system/model-provider-config/scripts/configure_provider.py']) {
        assert.ok(exported.identity.sourceFiles[file], file);
    }
    assert.equal(exported.files.includes('nora/SOUL.md'), false, 'No second delivery copy');
});

test('stable source uses the committed layout, not uncommitted path overrides', t => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-layout-test-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(fixture, 'tooling'));
    fs.mkdirSync(path.join(fixture, 'nora'));
    fs.writeFileSync(path.join(fixture, 'tooling/source-layout.json'), JSON.stringify({ schema: 1, rules: [['nora/SOUL.md', 'ops/installer/templates/SOUL.md']] }));
    fs.writeFileSync(path.join(fixture, 'nora/SOUL.md'), '# Test persona\n');
    const git = args => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' });
    git(['init']);
    git(['add', '.']);
    git(['-c', 'user.name=Layout Test', '-c', 'user.email=layout@example.invalid', 'commit', '-m', 'fixture']);
    const exported = createReleaseSource(fixture);
    t.after(() => fs.rmSync(exported.stage, { recursive: true, force: true }));
    assert.equal(fs.readFileSync(path.join(exported.stage, 'ops/installer/templates/SOUL.md'), 'utf8'), '# Test persona\n');
    assert.ok(exported.identity.sourceFiles['nora/SOUL.md']);
    fs.writeFileSync(path.join(fixture, 'tooling/source-layout.json'), '{}');
    assert.throws(() => createReleaseSource(fixture), /clean committed tree/);
});

test('projection rejects a collision before changing the source tree', t => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-layout-collision-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    fs.mkdirSync(path.join(fixture, 'tooling'));
    fs.writeFileSync(path.join(fixture, 'tooling/source-layout.json'), JSON.stringify({ schema: 1, rules: [['a', 'b'], ['b', 'c']] }));
    fs.writeFileSync(path.join(fixture, 'a'), 'first');
    fs.writeFileSync(path.join(fixture, 'b'), 'second');
    assert.throws(() => projectDelivery(fixture, ['a', 'b']), /collision/);
    assert.equal(fs.readFileSync(path.join(fixture, 'a'), 'utf8'), 'first');
});

for (const mode of ['success', 'failure', 'watch']) {
    test(`developer runner maps source arguments and cleans its own export: ${mode}`, () => {
        const code = `
            const fs = require('node:fs');
            if (!fs.existsSync('ops/installer/templates/SOUL.md')) process.exit(90);
            if (process.argv[1] !== 'ops/installer/desktop') process.exit(91);
            console.log(JSON.stringify({ stage: process.cwd() }));
            process.exit(${mode === 'failure' ? 17 : 0});
        `;
        const result = spawnSync(process.execPath, ['tooling/run.mjs', ...(mode === 'watch' ? ['--watch'] : []),
            'node', '-e', code, 'launcher/desktop'], { cwd: root, encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, mode === 'failure' ? 17 : 0, result.stderr);
        const { stage } = JSON.parse(result.stdout.trim());
        assert.notEqual(stage, root);
        assert.equal(fs.existsSync(stage), false);
        assert.ok(fs.existsSync(path.join(root, 'nora/SOUL.md')));
    });
}
