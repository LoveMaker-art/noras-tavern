import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReleasePlan, readGitSnapshot, readManifestSnapshot, workflowInputs, PLATFORMS } from '../tooling/release/release-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const planner = fileURLToPath(new URL('../tooling/release/release-plan.mjs', import.meta.url));
const layout = JSON.parse(fs.readFileSync(path.join(root, 'tooling/source-layout.json'), 'utf8')).rules;
const launcher = JSON.parse(fs.readFileSync(path.join(root, 'launcher/desktop/package.json'), 'utf8'));
const workflow = `name: fixture
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - name: Test contracts
        run: node --test tests/contracts.test.mjs
      - name: Build package
        run: node tooling/release/package-release.mjs
  publish:
    steps:
      - name: Upload
        run: rsync frozen-payload destination
`;
const snapshot = () => ({ commit: 'a'.repeat(40), ref: 'baseline', sourceDigest: 'a'.repeat(64),
    sourceModes: {}, sourceFiles: {
        'tooling/source-layout.json': 'a'.repeat(64),
        'launcher/desktop/package.json': 'a'.repeat(64),
        '.github/workflows/build-integrated-launcher.yml': 'a'.repeat(64),
    }, configuration: { layout, launcher, workflow: workflowInputs(workflow) }, environmentInputs: null });
function change(...names) {
    const baseline = snapshot(), current = structuredClone(baseline);
    current.commit = 'b'.repeat(40); current.ref = 'head'; current.sourceDigest = 'b'.repeat(64);
    for (const name of names) { baseline.sourceFiles[name] = 'a'.repeat(64); current.sourceFiles[name] = 'b'.repeat(64); }
    return { baseline, current };
}
const noEnvironment = plan => assert.ok(Object.values(plan.build.environment).every(values => values.length === 0));

test('unshipped tests/docs and publication tooling require verification, not product construction', () => {
    const inputs = change('README.md', 'docs/releases/v2.4.4.md', 'tests/deployment/launcher_network_policy.test.cjs',
        'tooling/release/publish-release.mjs', 'tooling/release/publication-state.mjs',
        'tooling/release/publication-source.cjs', 'tooling/release/publication-providers.mjs', 'tooling/release/acceptance-baseline.mjs',
        'tooling/checks/launcher-installed-check.ps1');
    const plan = createReleasePlan(inputs);
    assert.equal(plan.mode, 'verification-only'); assert.equal(plan.requiresReview, false);
    assert.deepEqual(plan.build.launcher, []); assert.deepEqual(plan.build.modules, []); noEnvironment(plan);
    assert.ok(plan.changed.every(item => item.roles.includes('verification-only')));
});

test('a README shipped in ops changes its component, without rebuilding unrelated launcher/environment bytes', () => {
    const plan = createReleasePlan(change('launcher/desktop/README.md'));
    assert.equal(plan.mode, 'components'); assert.equal(plan.requiresReview, false);
    assert.deepEqual(plan.build.modules, ['operations']); assert.deepEqual(plan.build.launcher, []); noEnvironment(plan);
    assert.match(plan.changed[0].reasons.join('\n'), /Delivered as operations/);
});

test('launcher membership comes from actual build files and resources rather than the whole launcher directory', () => {
    for (const name of ['launcher/desktop/main.js', 'launcher/ui/index.html', 'deployment/shared/nora_system.py', 'launcher/ui/assets/nora-launcher-portrait.png']) {
        const plan = createReleasePlan(change(name));
        assert.equal(plan.mode, 'launcher', name); assert.deepEqual(plan.build.launcher, [...PLATFORMS].sort(), name); noEnvironment(plan);
    }
    const plan = createReleasePlan(change('deployment/uninstall/uninstall.nsh'));
    assert.equal(plan.mode, 'launcher'); assert.deepEqual(plan.build.launcher, ['win32-x64']); noEnvironment(plan);
});

test('canonical Nora instructions and cardforge Markdown are product content, unlike repository documentation', () => {
    const plan = createReleasePlan(change('nora/SOUL.md', 'nora/AGENTS.md', 'nora/skills/creative/nora-cardforge/references/starter-stories.md'));
    assert.equal(plan.mode, 'components'); assert.deepEqual(plan.build.modules, ['operations', 'skills']);
    assert.deepEqual(plan.build.launcher, []); noEnvironment(plan);
});

test('real packer/transitive helper changes cannot reuse an environment solely because lockfiles are unchanged', () => {
    for (const name of ['tooling/release/build-commands.mjs', 'tooling/layout.mjs', 'tooling/release/package-release.mjs',
        'tooling/release/restore-launcher-runtime.cjs', 'tooling/release/launcher-build-baseline.mjs', 'tooling/release/asset-catalogue.mjs']) {
        const plan = createReleasePlan(change(name));
        assert.equal(plan.mode, 'full', name); assert.equal(plan.requiresReview, false);
        assert.deepEqual(plan.build.environment.hermesRuntime, [...PLATFORMS].sort());
        assert.deepEqual(plan.build.launcher, [...PLATFORMS].sort());
    }
    for (const name of ['launcher/desktop/runtime.js', 'tooling/runtime/clawchat-bundle-check.py', 'tooling/runtime/clawchat-bundle.lock.json']) {
        const plan = createReleasePlan(change(name));
        assert.equal(plan.mode, 'full', name); assert.deepEqual(plan.build.environment.hermesRuntime, [...PLATFORMS].sort());
        assert.deepEqual(plan.build.environment.tavernDependencies, []);
    }
});

test('launcher version-only changes preserve dependency environments; dependency and Electron inputs do not', () => {
    const inputs = change('launcher/desktop/package.json');
    inputs.current.configuration.launcher.version = '9.8.7';
    const version = createReleasePlan(inputs); assert.equal(version.mode, 'launcher'); noEnvironment(version);
    inputs.current.configuration.launcher.devDependencies.electron = '99.0.0';
    const electron = createReleasePlan(inputs);
    assert.deepEqual(electron.build.environment.launcherDependencies, [...PLATFORMS].sort());
    assert.deepEqual(electron.build.environment.hermesRuntime, []);
    const lock = createReleasePlan(change('launcher/desktop/package-lock.json'));
    assert.deepEqual(lock.build.environment.launcherDependencies, [...PLATFORMS].sort());
});

test('application/MCP lock changes rebuild the dependency closure without requiring a new Hermes archive', () => {
    const plan = createReleasePlan(change('app/engine/sillytavern/package-lock.json', 'nora-mcp/npm-shrinkwrap.json'));
    assert.equal(plan.mode, 'full'); assert.deepEqual(plan.build.environment.tavernDependencies, [...PLATFORMS].sort());
    assert.deepEqual(plan.build.environment.hermesRuntime, []); assert.deepEqual(plan.build.environment.launcherDependencies, []);
});

test('CI test/timeout/formatting changes differ from Node/Python/native build instruction changes', () => {
    const inputs = change('.github/workflows/build-integrated-launcher.yml');
    inputs.current.configuration.workflow = workflowInputs(workflow.replace('Test contracts', 'Test contracts more clearly')
        .replace('tests/contracts.test.mjs', 'tests/contracts-v2.test.mjs').replace('  build:\n', '  build:\n    timeout-minutes: 90\n'));
    const testsOnly = createReleasePlan(inputs); assert.equal(testsOnly.mode, 'verification-only'); noEnvironment(testsOnly);
    for (const value of [workflow.replace('node-version: 24', 'node-version: 26'), workflow.replace("python-version: '3.11'", "python-version: '3.12'"),
        workflow.replace('ubuntu-latest', 'macos-15')]) {
        inputs.current.configuration.workflow = workflowInputs(value);
        const environment = createReleasePlan(inputs); assert.equal(environment.mode, 'full');
        assert.deepEqual(environment.build.environment.hermesRuntime, [...PLATFORMS].sort());
    }
});

test('an unrecognized workflow build command requires review, rather than being silently labelled CI-only', () => {
    const inputs = change('.github/workflows/build-integrated-launcher.yml');
    inputs.current.configuration.workflow = workflowInputs(workflow.replace('      - name: Test contracts',
        '      - name: Custom assembly\n        run: node custom-binary-builder.mjs\n      - name: Test contracts'));
    const plan = createReleasePlan(inputs); assert.equal(plan.mode, 'review-required'); assert.equal(plan.requiresReview, true);
    assert.match(plan.review.join('\n'), /Unclassified changed build step/);
});

test('component workflow toolchain changes are build inputs; unknown workflows are not assumed harmless', () => {
    const inputs = change('.github/workflows/publish-component-update.yml');
    inputs.baseline.configuration.componentWorkflow = workflowInputs(workflow.replace('  build:', '  publish:'), 'publish');
    inputs.current.configuration.componentWorkflow = workflowInputs(workflow.replace('  build:', '  publish:').replace('node-version: 24', 'node-version: 26'), 'publish');
    assert.equal(createReleasePlan(inputs).mode, 'full');
    const unknown = createReleasePlan(change('.github/workflows/unknown-product-build.yml'));
    assert.equal(unknown.requiresReview, true); assert.match(unknown.review.join('\n'), /CI configuration/);
});

test('audited publication-only workflow stays verification-only, but cannot hide a newly introduced build', () => {
    const inputs = change('.github/workflows/publish-accepted-release.yml');
    inputs.current.configuration.publicationWorkflowHasBuild = false;
    assert.equal(createReleasePlan(inputs).mode, 'verification-only');
    inputs.current.configuration.publicationWorkflowHasBuild = true;
    assert.equal(createReleasePlan(inputs).requiresReview, true);
});

test('application generated-output helpers and canonical Story Profile source select relevant modules', () => {
    const plan = createReleasePlan(change('app/engine/sillytavern/build/build-nora.mjs', 'story-profile/core/story_profile.py',
        'nora-mcp/src/nora-control-plane.ts', 'app/native-extensions/nora-ui/index.js'));
    assert.equal(plan.mode, 'components'); noEnvironment(plan); assert.deepEqual(plan.build.launcher, []);
    assert.deepEqual(plan.build.modules, ['extension-nora-ui', 'nora-mcp', 'nora-runtime', 'nora-web', 'story-profile', 'tavern-engine']);
});

test('environment identity and ABI changes are tracked even if Git source is unchanged', () => {
    const baseline = snapshot(), current = structuredClone(baseline);
    baseline.environmentInputs = { nodeAbi: '137', pythonAbi: 'cp311', clawchatRevision: 'a'.repeat(40) };
    current.environmentInputs = { ...baseline.environmentInputs, nodeAbi: '141' };
    const plan = createReleasePlan({ baseline, current });
    assert.equal(plan.mode, 'full'); assert.equal(plan.changed[0].path, '@environmentInputs');
    assert.deepEqual(plan.build.environment.hermesRuntime, [...PLATFORMS].sort());
    assert.equal(plan.reuse.acceptedArtifactRequired, true);
});

test('unknown additions/deletions, unsupported source context and resource patterns fail closed', () => {
    for (const status of ['added', 'deleted']) {
        const inputs = change('tooling/release/future-runtime-builder.mjs');
        delete inputs[status === 'added' ? 'baseline' : 'current'].sourceFiles['tooling/release/future-runtime-builder.mjs'];
        const plan = createReleasePlan(inputs); assert.equal(plan.mode, 'review-required'); assert.equal(plan.changed[0].status, status);
        assert.match(plan.review.join('\n'), /Unclassified changed input/);
    }
    const missing = change('README.md'); missing.current.configuration = null;
    assert.equal(createReleasePlan(missing).requiresReview, true);
    const glob = change('README.md'); glob.current.configuration.launcher.build.files.push('*.js');
    assert.match(createReleasePlan(glob).review.join('\n'), /resource glob/);
});

test('file modes, deletion mapping and immutable input identities participate in the plan seal', () => {
    const inputs = change('deployment/runtime/runtime.sh');
    inputs.current.sourceFiles['deployment/runtime/runtime.sh'] = inputs.baseline.sourceFiles['deployment/runtime/runtime.sh'];
    inputs.baseline.sourceModes['deployment/runtime/runtime.sh'] = '100644'; inputs.current.sourceModes['deployment/runtime/runtime.sh'] = '100755';
    const plan = createReleasePlan(inputs); assert.equal(plan.mode, 'components'); assert.equal(plan.changed.length, 1);
    const repeat = createReleasePlan(inputs); assert.equal(plan.planDigest, repeat.planDigest);
    inputs.current.commit = 'c'.repeat(40); assert.notEqual(createReleasePlan(inputs).planDigest, plan.planDigest);
});

function repository(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-release-plan-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '--quiet'); git('config', 'user.email', 'release-plan@example.invalid'); git('config', 'user.name', 'Release Plan Test');
    const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); fs.writeFileSync(path.join(directory, name), content); };
    write('tooling/source-layout.json', JSON.stringify({ schema: 1, rules: layout }));
    write('launcher/desktop/package.json', JSON.stringify(launcher)); write('.github/workflows/build-integrated-launcher.yml', workflow);
    write('README.md', 'baseline'); write('launcher/desktop/main.js', 'console.log("baseline");');
    git('add', '.'); git('commit', '--quiet', '-m', 'baseline'); const base = git('rev-parse', 'HEAD');
    return { directory, git, write, base };
}

test('Git CLI reads exact committed bytes, ignores unrelated working edits, seals output and refuses overwrite', t => {
    const repo = repository(t); repo.write('README.md', 'updated documentation'); repo.git('add', '.'); repo.git('commit', '--quiet', '-m', 'documentation');
    const head = repo.git('rev-parse', 'HEAD'); repo.write('launcher/desktop/main.js', 'uncommitted product change');
    const output = path.join(repo.directory, 'plan.json'), githubOutput = path.join(repo.directory, 'github-output');
    const cli = ['--base', repo.base, '--head', head, '--repo', repo.directory, '--output', output, '--github-output', githubOutput];
    execFileSync(process.execPath, [planner, ...cli]);
    const plan = JSON.parse(fs.readFileSync(output)); assert.equal(plan.mode, 'verification-only');
    assert.equal(plan.source.commit, head); assert.equal(plan.baseline.commit, repo.base); assert.deepEqual(plan.changed.map(item => item.path), ['README.md']);
    assert.match(fs.readFileSync(githubOutput, 'utf8'), /product_build=false/);
    assert.equal(spawnSync(process.execPath, [planner, ...cli]).status, 1);
    assert.equal(JSON.parse(fs.readFileSync(output)).planDigest, plan.planDigest);
    assert.match(execFileSync(process.execPath, [planner, '--help'], { encoding: 'utf8' }), /Does not build, upload, publish/);
});

test('stable manifest mode verifies configuration against its claimed Git commit', t => {
    const repo = repository(t), source = readGitSnapshot(repo.directory, repo.base);
    const manifest = { schema: 'tavern-release/v2', candidate: false, dirty: false, commit: repo.base, sourceFiles: { ...source.sourceFiles } };
    const file = path.join(repo.directory, 'release-manifest.json'); fs.writeFileSync(file, JSON.stringify(manifest));
    const snapshot = readManifestSnapshot(file, repo.directory); assert.equal(snapshot.contextVerified, true);
    const plan = createReleasePlan({ baseline: snapshot, current: snapshot }); assert.equal(plan.mode, 'verification-only');
    assert.ok(plan.reuse.limitations.some(value => value.includes('file-mode')));
    manifest.sourceFiles['launcher/desktop/package.json'] = 'f'.repeat(64); fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => readManifestSnapshot(file, repo.directory), /Manifest\/config mismatch/);
    manifest.sourceFiles = { ...source.sourceFiles, 'launcher/desktop/main.js': 'f'.repeat(64) }; fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => readManifestSnapshot(file, repo.directory), /source fingerprints differ/);
    manifest.commit = 'f'.repeat(40); fs.writeFileSync(file, JSON.stringify(manifest));
    const unknown = readManifestSnapshot(file, repo.directory);
    assert.equal(createReleasePlan({ baseline: unknown, current: unknown }).requiresReview, true);
});

test('EMPTY creates a first full build and includes actual extension modules', () => {
    const current = snapshot(); current.sourceFiles['app/native-extensions/nora-ledger/index.js'] = 'a'.repeat(64);
    const plan = createReleasePlan({ current }); assert.equal(plan.initialRelease, true); assert.equal(plan.baseline.commit, null);
    assert.equal(plan.mode, 'full'); assert.ok(plan.build.modules.includes('extension-nora-ledger'));
    assert.deepEqual(plan.build.environment.hermesRuntime, [...PLATFORMS].sort());
});
