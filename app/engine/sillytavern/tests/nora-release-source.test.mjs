import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { assertSafeReleasePath, assertSafeReleaseContent, createReleaseSource, collectRuntimeFiles } from '../../../../ops/scripts/release-source.mjs';

test('release guards reject runtime/private paths and credential contents without echoing them', () => {
    for (const file of ['app/.env', 'app/engine/sillytavern/data/default-user/secrets.json', 'app/audit-runtime.log', 'app/__pycache__/a.pyc', '../app/x', 'app/x\ny']) assert.throws(() => assertSafeReleasePath(file));
    assert.doesNotThrow(() => assertSafeReleasePath('app/native-extensions/nora-ui/settings-store.js'));
    assert.throws(() => assertSafeReleaseContent('app/example.js', Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----')), /Potential credential/);
});

test('source export excludes ignored private files and stable mode rejects uncommitted changes', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-package-fixture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']);
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n*.log\ndata/\n');
    fs.writeFileSync(path.join(root, 'app/main.js'), 'export const ready = true;\n');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture']);
    fs.writeFileSync(path.join(root, 'app/.env'), 'FAKE_PRIVATE=fixture');
    fs.writeFileSync(path.join(root, 'app/audit-runtime.log'), 'FAKE_PRIVATE');
    const snapshot = createReleaseSource(root);
    t.after(() => fs.rmSync(snapshot.stage, { recursive: true, force: true }));
    assert.equal(fs.existsSync(path.join(snapshot.stage, 'app/.env')), false);
    assert.equal(fs.existsSync(path.join(snapshot.stage, 'app/audit-runtime.log')), false);
    assert.equal(snapshot.identity.dirty, false);
    fs.appendFileSync(path.join(root, 'app/main.js'), '// changed\n');
    assert.throws(() => createReleaseSource(root), /clean committed tree/);
});

test('delivery allowlist rejects obsolete CLI names and keeps developer-only files out of runtime archives', t => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-delivery-fixture-'));
    t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
    const retained = [
        'app/engine/sillytavern/src/nora-story-statistics.js',
        'ops/scripts/runtime.sh', 'ops/scripts/bringup-native.sh', 'ops/scripts/provision.sh',
        'ops/scripts/profile_memory.py', 'ops/scripts/install-hermes-skills.py',
        'ops/scripts/analyze-boot-metrics.mjs', 'ops/scripts/analyze-runtime-phases.mjs',
        'ops/skills/INSTALL.md', 'ops/skills/agents-tavern.md',
        'ops/skills/creative/tavern/SKILL.md', 'ops/skills/creative/tavern/references/story-profile.md',
        'ops/skills/creative/tavern-ops/SKILL.md', 'ops/skills/system/tavern-updater/references/release-compatibility.md',
        'ops/skills/system/tavern-updater/scripts/update.py', 'ops/updater/update.py',
        'ops/skills/creative/nora-cardforge/src/cli/main.js', 'ops/skills/creative/nora-cardforge/SKILL.md',
        'nora-mcp/package.json', 'nora-mcp/npm-shrinkwrap.json', 'nora-mcp/README.md',
    ];
    const excluded = [
        'ops/scripts/tavern_cli.py', 'ops/scripts/native_tavern.py', 'ops/scripts/package-release.mjs',
        'ops/scripts/verify-product-workflows.mjs', 'ops/scripts/migrate-nora-worlds-v2.mjs',
        'ops/scripts/index-project.mjs', 'ops/tests/test-install.py', 'ops/specialists/retired/SKILL.md',
        'ops/skills/creative/retired/SKILL.md', 'ops/skills/creative/tavern/scripts/retired.py',
        'app/engine/sillytavern/tests/nora-world-theme.test.mjs',
        'nora-mcp/src/server.ts', 'nora-mcp/tests/discovery.test.mjs',
        'ops/skills/creative/nora-cardforge/tests/smoke.js', 'ops/skills/creative/nora-cardforge/agents/openai.yaml',
    ];
    const generated = ['app/engine/sillytavern/public/dist/nora/entry.js', 'app/engine/sillytavern/dist/_webpack/output/vendor.js', 'nora-mcp/dist/server.js'];
    for (const file of [...retained, ...excluded, ...generated]) {
        fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
        fs.writeFileSync(path.join(stage, file), '// fixture');
    }
    const delivery = collectRuntimeFiles(stage, [...retained, ...excluded]);
    assert.deepEqual(delivery, [...retained, ...generated].sort());
    for (const file of excluded) assert.ok(fs.existsSync(path.join(stage, file)), `${file} remains available to source/build tests`);
});
