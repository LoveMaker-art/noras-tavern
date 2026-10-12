import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const load = name => JSON.parse(execFileSync(process.env.NORA_WORKFLOW_YAML_PYTHON || 'python3', ['-c',
  'import sys,json,yaml\nprint(json.dumps(yaml.load(open(sys.argv[1]),Loader=yaml.BaseLoader)))',
  path.join(root, '.github/workflows', name)], { encoding: 'utf8' }));
const full = load('build-integrated-launcher.yml'), components = load('publish-component-update.yml'), publisher = load('publish-accepted-release.yml');
const scripts = workflow => Object.values(workflow.jobs).flatMap(job => job.steps || []).map(step => step.run || '').join('\n');
test('the repository default Node major matches all release workflows', () => {
  const defaultNode = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  assert.equal(defaultNode, '24', 'Launcher source and native checks require real Node.js 24');
  for (const [name, workflow] of [['native', full], ['components', components], ['publisher', publisher]]) {
    const setup = Object.values(workflow.jobs).flatMap(job => job.steps || [])
      .filter(step => step.uses?.startsWith('actions/setup-node@'));
    assert.ok(setup.length > 0, `${name} workflow must select its Node version`);
    for (const step of setup) assert.equal(step.with?.['node-version'], defaultNode,
      `${name} workflow differs from the repository default Node major`);
  }
});
test('critical launcher maintenance regressions block runtime preparation on every native platform', () => {
  const steps = full.jobs.build.steps;
  const gateIndex = steps.findIndex(step => step.run?.includes('tooling/checks/verify-launcher-stability.mjs'));
  const dependencies = steps.findIndex(step => step.name === 'Install launcher test dependencies');
  const python = steps.findIndex(step => step.uses === 'actions/setup-python@v5');
  const firstRuntime = steps.findIndex(step => step.name === 'Download and verify unchanged published components');
  assert.ok(gateIndex > dependencies && gateIndex > python && gateIndex < firstRuntime,
    'Critical user-data and recovery checks must run with their dependencies before any runtime preparation');
  const gate = steps[gateIndex];
  assert.equal(gate.if, undefined, 'Every selected native platform must run the stability gate');
  assert.equal(gate['continue-on-error'], undefined, 'A failed stability gate cannot become a successful build');
  assert.equal(gate.shell, 'bash');
  assert.match(gate.run, /set -euo pipefail/);
  assert.match(gate.run, /export NORA_TEST_PYTHON="\$\(python -B -c/);
  assert.match(gate.run, /python -m pip install psutil==7\.0\.0/, 'Native process inspection needs its explicit test dependency');
  assert.match(gate.run, /PyYAML==6\.0\.2/, 'The separate native build job must install its own recovery-test YAML dependency');
  assert.doesNotMatch(gate.run, /\|\|\s*true|--test-name-pattern|--skip/);
});
test('native and component build workflows cannot publish or access publishing credentials', () => {
  for (const workflow of [full, components]) {
    assert.equal(workflow.permissions.contents, 'read');
    assert.doesNotMatch(scripts(workflow), /publish-release\.mjs|sourceforge-credentials|gh release (?:create|edit|upload)/);
    assert.ok(!JSON.stringify(workflow).includes('SOURCEFORGE_SSH_PRIVATE_KEY'));
  }
  assert.ok(full.jobs.build.needs.includes('preflight'));
  assert.ok(full.jobs.build.if.includes("needs.preflight.result == 'success'"));
  const steps = full.jobs.build.steps;
  const componentCheck = steps.findIndex(step => step.run === 'node --test tests/component-release.test.mjs');
  const dependencies = steps.findIndex(step => step.name === 'Install launcher test dependencies');
  const runtime = steps.findIndex(step => step.name === 'Prepare the verified fixed Hermes bootstrap');
  assert.ok(componentCheck > dependencies && componentCheck < runtime, 'Component contracts must run with dependencies before the cold runtime build');
  const backups = steps.findIndex(step => step.name === 'Require chat backup safety tests');
  assert.ok(backups > componentCheck && backups < runtime, 'The complete backup gate must run before the cold runtime build');
  const backupPython = steps.findIndex(step => step.name === 'Prepare the Python interpreter for native backup lock tests');
  assert.ok(backupPython >= 0 && backupPython < backups);
  assert.equal(steps[backupPython].with['python-version'], '3.11');
  assert.match(steps[backups].run, /export NORA_TEST_PYTHON="\$\(python -B -c/);
  assert.equal(steps.filter(step => step.run?.includes('node --test tests/component-release.test.mjs')).length, 1);
  assert.ok(steps.some(step => step.run?.includes('ManagedInstallRecoveryTests.test_real_install_committed_journal_keeps_sealed_metadata_after_success_cleanup')));
  const nativeNames = full.jobs.build.steps.map(step => step.name);
  for (const name of ['Test the actual Windows setup and installed application', 'Verify real APP production module closure and executor receipts',
    'Require chat backup safety tests', 'Test unified update and application replacement']) assert.ok(nativeNames.includes(name), `Lost product gate: ${name}`);
});
test('the plan and quick contracts gate expensive builds, and failing plans remain inspectable', () => {
  const steps = full.jobs.preflight.steps;
  const plan = steps.findIndex(step => step.id === 'plan');
  const gate = steps.findIndex(step => step.name?.startsWith('Require a matching build decision'));
  const contracts = steps.findIndex(step => step.name?.startsWith('Check release tooling'));
  assert.ok(plan >= 0 && gate > plan && contracts > gate);
  assert.match(steps[contracts].run, /tests\/launcher-stability-gate\.test\.mjs/, 'Verify the source gate itself before native jobs');
  assert.match(steps[contracts].run, /node "\$PWD\/tooling\/run\.mjs" python -B -m unittest tests\.deployment\.test_launcher_shared_logic\.SharedLogicTests\.test_desktop_starts_gateway_before_scheduling_shared_hook/);
  const python = steps.findIndex(step => step.uses === 'actions/setup-python@v5' && step.with?.['python-version'] === '3.11');
  assert.ok(python >= 0 && python < contracts);
  assert.equal(steps.find(step => step.with?.name === 'nora-release-plan').if, 'always()');
  assert.match(steps[gate].run, /APPROVE_UNKNOWN_INPUTS.*true/);
  assert.match(steps[gate].run, /verification-only/);
  const componentSteps = components.jobs['build-components'].steps;
  assert.ok(componentSteps.findIndex(step => step.name === 'Require an explicitly compatible component plan') < componentSteps.findIndex(step => step.run?.includes('package-release.mjs')));
});

test('test prerequisites and absolute runner entries are mandatory before native suites', () => {
  const steps = full.jobs.build.steps;
  const environment = steps.findIndex(step => step.name === 'Verify native launcher test prerequisites');
  const configured = steps.findIndex(step => step.name === 'Configure actual operation actors and native lock tests');
  const native = steps.findIndex(step => step.name === 'Test release channels and update rollback');
  assert.ok(configured >= 0 && environment > configured && native > environment);
  assert.equal(steps[environment].if, undefined);
  assert.equal(steps[environment]['continue-on-error'], undefined);
  assert.match(steps[environment].run, /launcher-test-environment\.mjs" native/);
  for (const workflow of [full, components]) assert.doesNotMatch(scripts(workflow), /node tooling\/run\.mjs/);
  const chromium = steps.find(step => step.name === 'Check source networking in pinned native Chromium before preparing runtimes');
  assert.match(chromium.run, /launcher-test-environment\.mjs" chromium/);
  const presentation = steps.find(step => step.id === 'presentation_contracts');
  assert.ok(!presentation.run.includes('launcher_telemetry_worker.test.cjs'),
    'Source presentation checks must not imply that an absent receiver was tested');
});
test('historical acceptance selects published history and runs independently from runtime reuse', () => {
  assert.ok(full.on.workflow_dispatch.inputs.acceptance_baseline_tag);
  const selection = full.jobs.preflight.steps.find(step => step.id === 'acceptance-baseline');
  assert.match(selection.run, /--paginate --slurp/); assert.match(selection.run, /baseline-selection/);
  const historical = full.jobs.build.steps.find(step => step.name?.startsWith('Freeze verified historical'));
  const download = full.jobs.build.steps.find(step => step.name?.startsWith('Download the official historical'));
  assert.equal(historical.if, "needs.preflight.outputs.initial_release != 'true'");
  assert.equal(download.if, historical.if); assert.match(download.run, /acceptance-baseline\.mjs/);
  assert.equal(download.env.GH_TOKEN, '${{ github.token }}', 'Historical GitHub downloads require the read-only job token');
  assert.equal(full.permissions.contents, 'read'); assert.equal(full.permissions.actions, 'read');
  const early = full.jobs.preflight.steps.find(step => step.name === 'Verify historical download identities before native builds');
  assert.equal(full.jobs.preflight.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(early.if, "steps.acceptance-baseline.outputs.initial_release != 'true'");
  assert.equal(early.env.ACCEPTANCE_BASELINE_TAG, '${{ steps.acceptance-baseline.outputs.acceptance_baseline_tag }}');
  assert.equal(early['timeout-minutes'], '5');
  assert.match(early.run, /for platform in darwin-arm64 darwin-x64 win32-x64/);
  assert.match(early.run, /acceptance-baseline\.mjs.*--identity-only/);
  assert.doesNotMatch(download.run, /--identity-only/, 'Native upgrade acceptance still requires the full historical payload');
  assert.ok(!full.jobs.build.env?.GH_TOKEN, 'Do not expose the GitHub token to electron-builder');
  assert.doesNotMatch(historical.run, /RUNTIME_SOURCE_RUN|nora-baseline-artifacts/);
  const proof = full.jobs.build.steps.find(step => step.with?.name === 'nora-operation-acceptance-${{ matrix.platform }}-${{ matrix.arch }}');
  assert.match(proof.with.path, /baseline-source-receipt\.json/);
});
test('fresh Hermes builds pin both installers and repository before native runtime packaging', () => {
  const steps = full.jobs.build.steps;
  const prepareIndex = steps.findIndex(step => step.name === 'Prepare the verified fixed Hermes bootstrap');
  const macIndex = steps.findIndex(step => step.name === 'Install Hermes core without browser components (macOS)');
  const windowsIndex = steps.findIndex(step => step.name === 'Install Hermes core without browser components (Windows)');
  const verifyIndex = steps.findIndex(step => step.name === 'Verify fixed Hermes source and Python before runtime packaging');
  const packageIndex = steps.findIndex(step => step.name === 'Build integrated runtime');
  assert.ok(prepareIndex >= 0 && macIndex > prepareIndex && windowsIndex > prepareIndex);
  assert.ok(verifyIndex > macIndex && verifyIndex > windowsIndex && packageIndex > verifyIndex);
  assert.match(full.jobs.preflight.steps.find(step => step.name === 'Check release tooling before preparing runtimes').run,
    /tests\/hermes-bootstrap\.test\.mjs/);
  const fresh = "inputs.runtime_source_run == '' && inputs.launcher_baseline_tag == ''";
  assert.equal(steps[prepareIndex].if, fresh);
  assert.equal(steps[verifyIndex].if, fresh);
  assert.match(steps[prepareIndex].run, /prepare-hermes-bootstrap\.mjs --prepare --platform "\$\{\{ matrix\.platform \}\}" --output "\$RUNNER_TEMP\/hermes-bootstrap"/);
  assert.match(steps[verifyIndex].run, /prepare-hermes-bootstrap\.mjs --verify --hermes-home "\$RUNNER_TEMP\/hermes" --platform "\$\{\{ matrix\.platform \}\}"/);
  const mac = steps[macIndex].run, windows = steps[windowsIndex].run;
  assert.match(mac, /revision="\$\(node tooling\/runtime\/prepare-hermes-bootstrap\.mjs --revision\)"/);
  assert.match(mac, /bash "\$RUNNER_TEMP\/hermes-bootstrap\/install\.sh"/);
  assert.match(mac, /--commit "\$revision"\s*\\\n\s*--force-commit/);
  assert.match(windows, /\$revision = node tooling\/runtime\/prepare-hermes-bootstrap\.mjs --revision/);
  assert.match(windows, /hermes-bootstrap\/install\.ps1/);
  assert.match(windows, /foreach \(\$stage in \$stages\)[\s\S]*-Commit \$revision -ForceCommit/);
  assert.match(windows, /'uv', 'git', 'node', 'system-packages', 'repository', 'python', 'venv'/);
  assert.doesNotMatch(mac + windows, /https:\/\/hermes-agent\.nousresearch\.com\/install\.(?:sh|ps1)/);
});
test('the independent publication workflow only consumes accepted bytes and defaults to a local seal', () => {
  assert.deepEqual(Object.keys(publisher.on), ['workflow_dispatch']);
  assert.equal(publisher.on.workflow_dispatch.inputs.stage.default, 'seal');
  assert.equal(publisher.on.workflow_dispatch.inputs.asset_mode.default, 'legacy');
  assert.equal(publisher.on.workflow_dispatch.inputs.destinations.default, 'all');
  assert.deepEqual(publisher.on.workflow_dispatch.inputs.destinations.options, ['all', 'github']);
  assert.doesNotMatch(scripts(publisher), /package-release\.(?:mjs|sh)|package-hermes-runtime|npm (?:ci|install)|npm run pack/);
  const steps = publisher.jobs['publish-accepted'].steps;
  assert.ok(steps.some(step => step.run?.includes('publication-source.cjs delivery')));
  assert.ok(steps.some(step => step.run?.includes('refs/tags/$RELEASE_TAG^{commit}')));
  assert.ok(scripts(publisher).includes('publisherCommit:process.env.GITHUB_SHA'));
  assert.ok(scripts(publisher).includes('sourceCommit:process.env.SOURCE_SHA'));
});
test('reviewed unknown inputs cannot take an environment or accepted-package reuse path', () => {
  const script = full.jobs.preflight.steps.find(step => step.name?.startsWith('Require a matching build decision')).run;
  const baseline = { ...process.env, PLAN_MODE: 'review-required', REQUIRES_REVIEW: 'true', APPROVE_UNKNOWN_INPUTS: 'true',
    LAUNCHER_BASELINE_TAG: '', RUNTIME_SOURCE_RUN: '', VERIFIED_WINDOWS_RUN: '' };
  const run = extra => spawnSync('bash', ['-c', script], { env: { ...baseline, ...extra }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  assert.notEqual(run({ APPROVE_UNKNOWN_INPUTS: 'false' }).status, 0);
  for (const field of ['LAUNCHER_BASELINE_TAG', 'RUNTIME_SOURCE_RUN', 'VERIFIED_WINDOWS_RUN']) assert.notEqual(run({ [field]: 'source' }).status, 0, field);
  assert.equal(run({ PLAN_MODE: 'launcher', REQUIRES_REVIEW: 'false', LAUNCHER_BASELINE_TAG: 'v2.4.3' }).status, 0);
});
test('the fixed state is durable before remote writes, final failure evidence persists, and credentials are excluded', () => {
  const job = publisher.jobs['publish-accepted'], steps = job.steps;
  const sealed = steps.findIndex(step => step.with?.name === 'nora-publication-state-before-transfer');
  const credential = steps.findIndex(step => step.run === 'node tooling/release/sourceforge-credentials.mjs prepare');
  const network = steps.findIndex(step => step.name?.startsWith('Execute only'));
  const final = steps.findIndex(step => step.with?.name === 'nora-publication-state');
  assert.ok(sealed >= 0 && credential > sealed && network > credential && final > network);
  assert.equal(steps[credential].if, "inputs.stage != 'seal' && inputs.destinations == 'all'");
  assert.match(steps[final].if, /always\(\)/);
  for (const index of [sealed, final]) assert.equal(steps[index].with.path, '${{ runner.temp }}/publication-state/**');
  assert.equal(steps.at(-1).if, "always() && inputs.destinations == 'all'");
  assert.equal(job.env.DESTINATIONS, '${{ inputs.destinations }}');
  for (const step of steps.filter(step => step.run?.includes('publish-release.mjs'))) {
    assert.match(step.run, /--destinations "\$DESTINATIONS"/);
  }
  assert.equal(job.concurrency.group, 'nora-sourceforge-release-channels');
  assert.equal(job.concurrency['cancel-in-progress'], 'false');
});
test('shared source identity is queried once for a new seal; resumes preserve the original protocol', () => {
  const steps = publisher.jobs['publish-accepted'].steps;
  const baseline = steps.find(step => step.name?.startsWith('Resolve the immutable published baseline'));
  assert.equal(baseline.if, "inputs.asset_mode == 'shared' && inputs.state_source_run == ''");
  assert.match(baseline.run, /asset-catalogue\.mjs --baseline "\$REUSE_TAG" --repository "\$GITHUB_REPOSITORY"/);
  assert.match(steps.find(step => step.name?.startsWith('Seal or revalidate')).run, /--reuse-from/);
  assert.match(steps.find(step => step.name?.startsWith('Restore the original plan')).run, /"\$RELEASE_TAG" "\$SOURCE_RUN" "\$ASSET_MODE"/);
});
test('actual shell entry refuses invalid promotion, shared baseline and rerun inputs before touching Git', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-workflow-gate-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, 'repository'); fs.mkdirSync(repository);
  const git = args => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
  git(['init', '-q']); fs.mkdirSync(path.join(repository, 'app')); fs.writeFileSync(path.join(repository, 'app/.tavern-release-version'), '2.4.4\n');
  git(['add', 'app/.tavern-release-version']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  git(['tag', 'v2.4.4']);
  const script = publisher.jobs['publish-accepted'].steps.find(step => step.id === 'identity').run;
  const base = { ...process.env, GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: path.join(temporary, 'output'),
    GITHUB_SHA: 'b'.repeat(40), RELEASE_TAG: 'v2.4.4', SOURCE_RUN: '38042656566', STATE_SOURCE_RUN: '',
    ASSET_MODE: 'legacy', REUSE_TAG: '', PUBLICATION_STAGE: 'seal' };
  const run = extra => spawnSync('bash', ['-c', script], { cwd: repository, env: { ...base, ...extra }, encoding: 'utf8' });
  for (const extra of [{ PUBLICATION_STAGE: 'promote' }, { ASSET_MODE: 'shared' },
    { REUSE_TAG: 'v2.4.3' }, { STATE_SOURCE_RUN: '123', ASSET_MODE: 'shared', REUSE_TAG: 'v2.4.3' },
    { GITHUB_RUN_ATTEMPT: '2' }, { SOURCE_RUN: '123; touch forbidden' }, { RELEASE_TAG: '-invalid' }]) {
    assert.notEqual(run(extra).status, 0, JSON.stringify(extra));
  }
  const valid = run({}); assert.equal(valid.status, 0, valid.stderr);
  assert.match(fs.readFileSync(base.GITHUB_OUTPUT, 'utf8'), /source_sha=[a-f0-9]{40}/);
});
