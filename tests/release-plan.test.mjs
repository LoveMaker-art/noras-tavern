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

test('step titles cannot exempt changed unknown executable commands from review', () => {
    for (const title of ['Accept the exact component delivery without publishing', 'Verify contracts', 'Test contracts', 'Require evidence']) {
        const before = workflow.replace('Test contracts', title);
        const after = before.replace('node --test tests/contracts.test.mjs', 'bash tooling/release/unclassified-runtime-builder.sh');
        const inputs = change('.github/workflows/build-integrated-launcher.yml');
        inputs.baseline.configuration.workflow = workflowInputs(before);
        inputs.current.configuration.workflow = workflowInputs(after);
        const plan = createReleasePlan(inputs);
        assert.equal(plan.mode, 'review-required', title);
        assert.equal(plan.requiresReview, true, title);
    }
});

test('test-looking commands with shell execution or paths outside tests still require review', () => {
    for (const command of ['node --test tests/contracts.test.mjs; bash build-runtime.sh',
        'node --test tests/../tooling/release/build-runtime.mjs', 'node --test tests/./contracts.test.mjs',
        'node --test tests/$(bash build-runtime.sh).mjs', 'node --import ./build-runtime.mjs --test tests/contracts.test.mjs']) {
        const inputs = change('.github/workflows/build-integrated-launcher.yml');
        inputs.current.configuration.workflow = workflowInputs(workflow.replace('node --test tests/contracts.test.mjs', command));
        assert.equal(createReleasePlan(inputs).requiresReview, true, command);
    }
});

test('pure step-title changes do not alter actual packaging inputs', () => {
    const inputs = change('.github/workflows/build-integrated-launcher.yml');
    inputs.current.configuration.workflow = workflowInputs(workflow.replace('Build package', 'A clearer packaging title'));
    assert.equal(createReleasePlan(inputs).mode, 'verification-only'); noEnvironment(createReleasePlan(inputs));
});

const actualComponentWorkflow = fs.readFileSync(path.join(root, '.github/workflows/publish-component-update.yml'), 'utf8');
const legacyComponentInventory = "node -e 'const fs=require(\"node:fs\"),crypto=require(\"node:crypto\"),path=require(\"node:path\");const inventory={};for(const name of fs.readdirSync(\"artifacts\",{recursive:true})){const p=path.join(\"artifacts\",name);if(fs.statSync(p).isFile())inventory[name]={size:fs.statSync(p).size,sha256:crypto.createHash(\"sha256\").update(fs.readFileSync(p)).digest(\"hex\")};}fs.writeFileSync(path.join(process.env.RUNNER_TEMP,\"component-acceptance.json\"),JSON.stringify({schema:\"nora-component-acceptance/1\",commit:process.env.GITHUB_SHA,tag:process.env.GITHUB_REF_NAME,outcome:\"passed\",files:inventory},null,2)+\"\\n\")'";
function componentStep(source, title) {
    const start = source.indexOf('      - name: ' + title + '\n');
    assert.ok(start >= 0, 'Missing real workflow step: ' + title);
    const end = source.indexOf('\n      - ', start + 1);
    return source.slice(start, end < 0 ? source.length : end);
}
const contractStep = componentStep(actualComponentWorkflow, 'Verify release contracts and update preservation');
const frozenStep = componentStep(actualComponentWorkflow, 'Verify the frozen component delivery before native acceptance');
const historicalComponentWorkflow = actualComponentWorkflow
    .replace(contractStep, contractStep.replace(' tests/component-native-acceptance.test.mjs', ''))
    .replace(frozenStep, frozenStep + '\n          ' + legacyComponentInventory);
function componentWorkflowChange(before, after) {
    const inputs = change('.github/workflows/publish-component-update.yml');
    inputs.baseline.configuration.componentWorkflow = workflowInputs(before, 'build-components');
    inputs.current.configuration.componentWorkflow = workflowInputs(after, 'build-components');
    return inputs;
}

test('audited real component verification transition does not reconstruct unchanged products or environments', () => {
    const inputs = componentWorkflowChange(historicalComponentWorkflow, actualComponentWorkflow);
    for (const key of ['unknown', 'environment', 'packaging']) {
        assert.deepEqual(inputs.baseline.configuration.componentWorkflow[key], inputs.current.configuration.componentWorkflow[key], key);
    }
    const plan = createReleasePlan(inputs);
    assert.equal(plan.mode, 'verification-only'); assert.equal(plan.requiresReview, false);
    assert.deepEqual(plan.build.modules, []); assert.deepEqual(plan.build.launcher, []); noEnvironment(plan);
});

test('audited component step content cannot hide changed commands, parameters, environment or escaped paths', () => {
    const mutations = [
        value => value.replace(contractStep, contractStep + '\n          bash tooling/release/unknown-builder.sh'),
        value => value.replace('tests/component-native-acceptance.test.mjs', 'tests/../tooling/release/unknown-builder.mjs'),
        value => value.replace('tests/component-native-acceptance.test.mjs', 'tests/new-unreviewed.test.mjs'),
        value => value.replace(' artifacts "$GITHUB_REF_NAME" "$GITHUB_SHA" components', ' artifacts "$GITHUB_REF_NAME" "$GITHUB_SHA" --unchecked'),
        value => value.replace(contractStep, contractStep.replace('        run: |', '        env:\n          NODE_OPTIONS: --import=./unknown-builder.mjs\n        run: |')),
        value => value.replace(frozenStep, frozenStep + '\n          node -e "process.exit(0)"'),
        value => value.replace(frozenStep, frozenStep.replace('shell: bash', 'shell: pwsh')),
    ];
    for (const mutate of mutations) {
        const plan = createReleasePlan(componentWorkflowChange(actualComponentWorkflow, mutate(actualComponentWorkflow)));
        assert.equal(plan.mode, 'review-required'); assert.equal(plan.requiresReview, true);
        assert.match(plan.review.join('\n'), /Unclassified changed build step/);
    }
    const alteredLegacy = historicalComponentWorkflow.replace('schema:"nora-component-acceptance/1"', 'schema:"nora-component-acceptance/changed"');
    assert.equal(createReleasePlan(componentWorkflowChange(historicalComponentWorkflow, alteredLegacy)).requiresReview, true);
});

test('reviewed component bodies are not a general exemption for another job or a changed build environment', () => {
    const renamedTitles = actualComponentWorkflow.replace('Verify release contracts and update preservation', 'A different title')
        .replace('Verify the frozen component delivery before native acceptance', 'Another title');
    assert.equal(createReleasePlan(componentWorkflowChange(actualComponentWorkflow, renamedTitles)).mode, 'verification-only');
    const otherJob = actualComponentWorkflow.replace('  build-components:', '  build:');
    assert.ok(workflowInputs(otherJob).unknown.some(value => value.includes('component-native-acceptance')));
    const alteredNode = actualComponentWorkflow.replace('node-version: 24', 'node-version: 26');
    const plan = createReleasePlan(componentWorkflowChange(actualComponentWorkflow, alteredNode));
    assert.equal(plan.mode, 'full'); assert.deepEqual(plan.build.environment.hermesRuntime, [...PLATFORMS].sort());
});

test('reviewed compatibility files are product metadata, without changing runtime construction',()=>{
    const plan=createReleasePlan(change('tooling/release/compatibility/v2.5.4.json'));
    assert.equal(plan.requiresReview,false);assert.equal(plan.mode,'components');assert.equal(plan.build.metadata,true);
    assert.deepEqual(plan.build.launcher,[]);noEnvironment(plan);
});

test('unshipped tests/docs and publication tooling require verification, not product construction', () => {
    const inputs = change('README.md', 'CONTRIBUTING.md', 'docs/releases/v2.4.4.md', 'tests/deployment/launcher_network_policy.test.cjs',
        'tooling/release/publish-release.mjs', 'tooling/release/publication-state.mjs',
        'tooling/release/publication-source.cjs', 'tooling/release/publication-providers.mjs', 'tooling/release/acceptance-baseline.mjs',
        'tooling/release/final-consumer.mjs', 'tooling/release/component-acceptance.mjs', 'tooling/release/jihulab-provider.mjs', 'tooling/release/jihulab-transport.mjs',
        'tooling/checks/launcher-installed-check.ps1');
    const plan = createReleasePlan(inputs);
    assert.equal(plan.mode, 'verification-only'); assert.equal(plan.requiresReview, false);
    assert.deepEqual(plan.build.launcher, []); assert.deepEqual(plan.build.modules, []); noEnvironment(plan);
    assert.ok(plan.changed.every(item => item.roles.includes('verification-only')));
    assert.equal(plan.buildWorkflow, null);
});

test('a README shipped in ops changes its component, without rebuilding unrelated launcher/environment bytes', () => {
    const plan = createReleasePlan(change('launcher/desktop/README.md'));
    assert.equal(plan.mode, 'components'); assert.equal(plan.requiresReview, false);
    assert.equal(plan.buildWorkflow, '.github/workflows/publish-component-update.yml');
    assert.ok(plan.verification.includes('native-component-install-and-upgrade'));
    assert.deepEqual(plan.build.modules, ['operations']); assert.deepEqual(plan.build.launcher, []); noEnvironment(plan);
    assert.match(plan.changed[0].reasons.join('\n'), /Delivered as operations/);
});

test('launcher membership comes from actual build files and resources rather than the whole launcher directory', () => {
    for (const name of ['launcher/desktop/main.js', 'launcher/ui/index.html', 'deployment/shared/nora_system.py', 'launcher/ui/assets/nora-launcher-portrait.png']) {
        const plan = createReleasePlan(change(name));
        assert.equal(plan.mode, 'launcher', name); assert.deepEqual(plan.build.launcher, [...PLATFORMS].sort(), name); noEnvironment(plan);
        assert.equal(plan.buildWorkflow, '.github/workflows/build-integrated-launcher.yml');
    }
    const plan = createReleasePlan(change('deployment/uninstall/uninstall.nsh'));
    assert.equal(plan.mode, 'launcher'); assert.deepEqual(plan.build.launcher, ['win32-x64']); noEnvironment(plan);
});

test('canonical Nora instructions and cardforge Markdown are product content, unlike repository documentation', () => {
    const plan = createReleasePlan(change('nora/SOUL.md', 'nora/AGENTS.md', 'nora/skills/creative/nora-cardforge/references/starter-stories.md'));
    assert.equal(plan.mode, 'components'); assert.deepEqual(plan.build.modules, ['skills', 'updater']);
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

function versionOnlyLockChange() {
    const inputs = change('launcher/desktop/package.json', 'launcher/desktop/package-lock.json');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'launcher/desktop/package-lock.json'), 'utf8'));
    inputs.baseline.configuration.launcherLock = lock;
    inputs.current.configuration.launcherLock = structuredClone(lock);
    inputs.current.configuration.launcher.version = '9.8.7';
    inputs.current.configuration.launcherLock.version = '9.8.7';
    inputs.current.configuration.launcherLock.packages[''].version = '9.8.7';
    return inputs;
}

test('synchronized package and lock version labels do not force native dependency reconstruction', () => {
    const inputs = versionOnlyLockChange(), plan = createReleasePlan(inputs);
    assert.equal(plan.mode, 'launcher'); noEnvironment(plan);
    assert.deepEqual(plan.build.launcher, [...PLATFORMS].sort(), 'Changed APP metadata still needs new APP artifacts');
    assert.match(plan.changed.find(item => item.path.endsWith('package-lock.json')).reasons.join('\n'), /exact dependency/);
});

test('dependency identity and unknown lock evidence cannot hide behind an APP version bump', () => {
    const mutations = [
        config => { delete config.launcherLock; },
        config => { config.launcherLock.lockfileVersion = 2; },
        config => { config.launcherLock.packages[''].version = '1.0.0'; },
        config => { config.launcherLock.name = 'different-product'; },
        config => { config.launcherLock.packages[''].name = 'different-product'; },
        config => { config.launcherLock.packages[''].dependencies.semver = '99.0.0'; },
        config => { config.launcherLock.packages['node_modules/semver'].integrity = 'sha512-different'; },
        config => { config.launcherLock.packages['node_modules/semver'].resolved = 'https://example.invalid/changed.tgz'; },
        config => { config.launcherLock.packages['node_modules/semver'].os = ['win32']; },
        config => { config.launcherLock.packages['node_modules/semver'].hasInstallScript = true; },
        config => { config.launcherLock.newUnknownInput = true; },
    ];
    for (const mutate of mutations) {
        const inputs = versionOnlyLockChange(); mutate(inputs.current.configuration);
        const plan = createReleasePlan(inputs);
        assert.equal(plan.mode, 'full');
        assert.deepEqual(plan.build.environment.launcherDependencies, [...PLATFORMS].sort());
    }
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
        workflow.replace('ubuntu-latest', 'macos-15'),
        workflow.replace('      - name: Test contracts\n        run: node --test tests/contracts.test.mjs',
            '      - name: Prepare fixed Hermes bootstrap\n        run: node tooling/runtime/prepare-hermes-bootstrap.mjs --platform darwin --output /tmp/bootstrap')]) {
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

test('Git snapshots carry lock evidence and distinguish a real version-only bump from dependency changes', t => {
    const repo = repository(t), lock = JSON.parse(fs.readFileSync(path.join(root, 'launcher/desktop/package-lock.json'), 'utf8'));
    repo.write('launcher/desktop/package-lock.json', JSON.stringify(lock));
    repo.git('add', '.'); repo.git('commit', '--quiet', '-m', 'lock baseline');
    const baseline = readGitSnapshot(repo.directory, repo.git('rev-parse', 'HEAD'));
    const next = structuredClone(launcher); next.version = '9.8.7';
    lock.version = next.version; lock.packages[''].version = next.version;
    repo.write('launcher/desktop/package.json', JSON.stringify(next));
    repo.write('launcher/desktop/package-lock.json', JSON.stringify(lock));
    repo.git('add', '.'); repo.git('commit', '--quiet', '-m', 'version labels');
    const current = readGitSnapshot(repo.directory, repo.git('rev-parse', 'HEAD'));
    const plan = createReleasePlan({ baseline, current });
    assert.equal(plan.mode, 'launcher'); noEnvironment(plan);
    lock.packages['node_modules/semver'].integrity = 'sha512-changed';
    repo.write('launcher/desktop/package-lock.json', JSON.stringify(lock));
    repo.git('add', '.'); repo.git('commit', '--quiet', '-m', 'dependency identity');
    const changed = createReleasePlan({ baseline: current, current: readGitSnapshot(repo.directory, repo.git('rev-parse', 'HEAD')) });
    assert.deepEqual(changed.build.environment.launcherDependencies, [...PLATFORMS].sort());
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
