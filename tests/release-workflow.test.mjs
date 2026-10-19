import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { verifyLauncherStability } from '../tooling/checks/verify-launcher-stability.mjs';

const root = path.resolve(import.meta.dirname, '..');
const load = name => JSON.parse(execFileSync(process.env.NORA_WORKFLOW_YAML_PYTHON || 'python3', ['-c',
  'import sys,json,yaml\nprint(json.dumps(yaml.load(open(sys.argv[1]),Loader=yaml.BaseLoader)))',
  path.join(root, '.github/workflows', name)], { encoding: 'utf8' }));
const full = load('build-integrated-launcher.yml'), components = load('publish-component-update.yml'), publisher = load('publish-accepted-release.yml');
const scripts = workflow => Object.values(workflow.jobs).flatMap(job => job.steps || []).map(step => step.run || '').join('\n');
test('domestic publisher acceptance uses the authored tooling layout while installed consumers use the delivery projection', () => {
  const command = full.jobs.preflight.steps.find(step => step.name === 'Check release tooling before preparing runtimes').run;
  const publisherLines = command.split('\n').filter(line => line.includes('launcher_jihulab_publication.test.cjs'));
  assert.equal(publisherLines.length, 1);
  assert.match(publisherLines[0], /^\s*node --test /);
  assert.doesNotMatch(publisherLines[0], /tooling\/run\.mjs/);
  for (const name of ['launcher_jihulab_sources', 'launcher_static_catalogue', 'launcher_shared_assets']) {
    assert.ok(command.split('\n').some(line => line.includes('tooling/run.mjs') && line.includes(`${name}.test.cjs`)));
  }
});
test('component publication is an explicit validated input forwarded as quoted arguments',async t=>{
  const {workflowPublicationOptions}=await import('../tooling/release/system-release.mjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-workflow-publication-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'app'),{recursive:true});fs.writeFileSync(path.join(directory,'app/.tavern-release-version'),'2.5.2');
  fs.mkdirSync(path.join(directory,'launcher/desktop'),{recursive:true});fs.writeFileSync(path.join(directory,'launcher/desktop/package.json'),JSON.stringify({version:'2.2.3'}));
  assert.throws(()=>workflowPublicationOptions(directory),/Missing reviewed compatibility declaration/);
  assert.throws(()=>workflowPublicationOptions(directory,{publicationTag:'v2.5.3\nEVIL=true'}));
  assert.throws(()=>workflowPublicationOptions(directory,{publicationTag:'v2.5.3',refType:'tag',refName:'v2.5.2'}));
  for(const compatibilityFile of ['/tmp/private.json','../private.json','local-state/private.json','tooling/release/compatibility/../../private.json'])
    assert.throws(()=>workflowPublicationOptions(directory,{compatibilityFile}));
  const compatibilityFile='tooling/release/compatibility/reviewed.json',compatibility={schema:'nora-core-launcher-compatibility/1',coreVersion:'2.5.2',
    launcherVersions:['2.2.2','2.2.3'],capabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2}};
  fs.mkdirSync(path.dirname(path.join(directory,compatibilityFile)),{recursive:true});fs.writeFileSync(path.join(directory,compatibilityFile),JSON.stringify(compatibility));
  fs.copyFileSync(path.join(directory,compatibilityFile),path.join(directory,'tooling/release/compatibility/v2.5.2.json'));
  const git=args=>execFileSync('git',args,{cwd:directory,stdio:'pipe'});
  git(['init','-q']);git(['add','.']);git(['-c','core.hooksPath=/dev/null','-c','user.name=Workflow fixture','-c','user.email=fixture@example.invalid',
    '-c','commit.gpgSign=false','commit','-qm','isolated workflow fixture']);
  const selected=workflowPublicationOptions(directory,{publicationTag:'v2.5.3',compatibilityFile});
  assert.equal(workflowPublicationOptions(directory).tag,'v2.5.2');
  assert.equal(workflowPublicationOptions(directory).explicit,false);
  assert.equal(workflowPublicationOptions(directory).compatibilityFile,'tooling/release/compatibility/v2.5.2.json');
  assert.equal(workflowPublicationOptions(directory,{publicationTag:'v2.5.3',refType:'tag',refName:'v2.5.3'}).tag,'v2.5.3');
  assert.equal(selected.compatibilityFile,compatibilityFile);assert.match(selected.compatibilitySha256,/^[a-f0-9]{64}$/);
  fs.appendFileSync(path.join(directory,compatibilityFile),'\n');assert.throws(()=>workflowPublicationOptions(directory,{compatibilityFile}),/fixed source commit/);
  fs.rmSync(path.join(directory,compatibilityFile));fs.symlinkSync(path.join(directory,'launcher/desktop/package.json'),path.join(directory,compatibilityFile));
  assert.throws(()=>workflowPublicationOptions(directory,{compatibilityFile}),/links/);
  for(const workflow of [full,components]){
    assert.equal(workflow.on.workflow_dispatch.inputs.publication_tag.default,'');
    assert.equal(workflow.on.workflow_dispatch.inputs.compatibility_file.default,'');
    assert.match(scripts(workflow),/--workflow-options/);assert.match(scripts(workflow),/--publication-tag "\$NORA_COMPONENT_PUBLICATION_TAG"/);
    assert.match(scripts(workflow),/--update-compatibility "\$NORA_UPDATE_COMPATIBILITY_FILE"/);
  }
});
test('native platform selectors preserve diagnostic, concurrency and publication boundaries', () => {
  const target = full.on.workflow_dispatch.inputs.target;
  assert.equal(target.default, 'all');
  assert.deepEqual(target.options, ['all', 'win32-x64', 'darwin-x64', 'darwin-arm64', 'win32-package-check']);
  assert.deepEqual(full.concurrency, {
    group: "nora-build-${{ github.sha }}-${{ inputs.target || 'all' }}",
    'cancel-in-progress': 'false',
  });
  assert.equal(full.jobs.build.strategy['fail-fast'], 'false', 'One platform must not cancel the other native jobs');
  assert.deepEqual(full.permissions, { contents: 'read', actions: 'read' });
  const shared = full.jobs.build.steps.find(step => step.name === 'Upload shared updater assets');
  assert.equal(shared.if, "matrix.platform == 'darwin' && matrix.arch == 'arm64' && (github.ref_type == 'tag' || inputs.production_mode)");
});
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
  assert.match(gate.run, /python -m venv --copies "\$RUNNER_TEMP\/nora-source-python"/);
  assert.match(gate.run, /NORA_TEST_PYTHON="\$RUNNER_TEMP\/nora-source-python\/Scripts\/python\.exe"/);
  assert.match(gate.run, /NORA_TEST_PYTHON="\$RUNNER_TEMP\/nora-source-python\/bin\/python"/);
  assert.match(gate.run, /"\$NORA_TEST_PYTHON" -m pip install psutil==7\.0\.0/, 'Native process inspection needs its explicit test dependency in the selected venv');
  assert.match(gate.run, /python -m pip install psutil==7\.0\.0 PyYAML==6\.0\.2/, 'Later source contracts retain their setup-python dependencies');
  assert.match(gate.run, /export NORA_TEST_MANAGED_PYTHON_ROOT=.*sys\.base_prefix/);
  assert.match(gate.run, /resolveExecution\(process\.env\.NORA_TEST_PYTHON/);
  assert.match(gate.run, /spawnSync\(resolved\.command/);
  assert.match(gate.run, /import json,sys,psutil,yaml/);
  assert.match(gate.run, /PyYAML==6\.0\.2/, 'The separate native build job must install its own recovery-test YAML dependency');
  assert.doesNotMatch(gate.run, /\|\|\s*true|--test-name-pattern|--skip/);
});
test('complete source coverage runs once before runtimes and only environment-dependent files repeat natively', () => {
  const steps=full.jobs.build.steps;
  const runtime=steps.findIndex(step=>step.name==='Download and verify unchanged published components');
  const files=command=>[...command.matchAll(/tests\/deployment\/([\w.-]+\.test\.cjs)/g)].map(match=>match[1]);
  const sourceFiles=steps.slice(0,runtime).flatMap(step=>files(step.run||''));
  verifyLauncherStability({checkEnvironment:()=>({environment:process.env}),run:(command,args)=>{
    sourceFiles.push(...args.filter(arg=>arg.endsWith('.test.cjs')).map(file=>path.basename(file)));return {status:0};
  }});
  const requiredSource=[
    'launcher_releases','launcher_bundle_contract','launcher_system_update','launcher_install_cleanup',
    'launcher_copy','launcher_location','launcher_model_recheck','launcher_publish',
    'launcher_diagnostics','launcher_process_output','launcher_network','launcher_install_source',
    'launcher_component_update','launcher_skill_update','launcher_shutdown','launcher_model_config',
    'launcher_console','launcher_native_crash','launcher_test_build','launcher_windows_extract',
    'launcher_telemetry','launcher_error_presentation','launcher_ui_feedback','launcher_task_progress',
    'launcher_operation_state',
  ].map(name=>name+'.test.cjs');
  for(const file of requiredSource)assert.equal(sourceFiles.filter(name=>name===file).length,1,
    `${file} must retain full pre-runtime coverage without a duplicate source invocation`);
  for(const group of ['release','installation','presentation']){
    const index=steps.findIndex(step=>step.name===`Check ${group} source contracts before preparing runtimes`);
    assert.ok(index>=0&&index<runtime,`${group} contracts must precede all runtime preparation`);
    const source=steps[index];
    assert.equal(source['continue-on-error'],undefined);
    assert.equal(source.if,undefined);
    assert.equal(source['timeout-minutes'],'5');
    assert.match(source.run,/--test-concurrency=1/);
    assert.doesNotMatch(source.run,/--test-name-pattern|--skip|\|\|\s*true/);
  }
  const release=steps.find(step=>step.id==='release_contracts'),installation=steps.find(step=>step.id==='installation_contracts');
  assert.deepEqual(files(release.run),['launcher_system_update.test.cjs'], 'Legacy recovery uses the actual native actor');
  assert.deepEqual(files(installation.run),['launcher_diagnostics.test.cjs','launcher_skill_update.test.cjs','launcher_native_crash.test.cjs'],
    'Retain managed Python, skill Python and native Electron contexts');
  assert.ok(!steps.some(step=>step.id==='presentation_contracts'), 'Pure presentation contracts do not acquire a different runtime context');
  const barrier=steps.find(step=>step.name==='Require all platform contract checks before native acceptance');
  assert.ok(barrier.if.includes("steps.release_contracts.outcome != 'success'"));
  assert.ok(barrier.if.includes("steps.installation_contracts.outcome != 'success'"));
  assert.ok(!barrier.if.includes('presentation_contracts'), 'Removed step IDs must not block every build');
});
test('standalone download source contracts run before runtime preparation without a native Hermes dependency',()=>{
  const steps=full.jobs.build.steps;
  const index=steps.findIndex(step=>step.name==='Check release source contracts before preparing runtimes');
  const runtime=steps.findIndex(step=>step.name==='Download and verify unchanged published components');
  assert.ok(index>=0&&index<runtime);
  const gate=steps[index];
  assert.equal(gate.if,undefined);assert.equal(gate['continue-on-error'],undefined);
  assert.match(gate.run,/set -euo pipefail/);
  assert.match(gate.run,/node "\$PWD\/tooling\/run\.mjs" python -B -m unittest tests\.deployment\.test_update_download_sources(?:\s|$)/);
  for(const module of ['test_standalone_release_sources','test_first_install_bootstrap_entry',
    'test_first_install_shared_assets','test_update_shared_assets','test_update_check','test_clawchat_bundle',
    'test_liveware_cache_release','test_managed_context','test_native_lifecycle_locking','test_native_ownership_recovery',
    'test_nora_instance','test_updater_host_hook','test_updater_runtime_process_detection'])
    assert.ok(gate.run.includes('tests.deployment.'+module),`Standalone source contract omitted: ${module}`);
  assert.doesNotMatch(gate.run,/\|\|\s*true|--test-name-pattern|--skip/);
});
test('maintenance wrappers and historical smoke forward only absolute script paths',()=>{
  const steps=full.jobs.build.steps;
  for(const step of steps){
    for(const line of (step.run||'').split('\n').filter(line=>line.includes('node "$PWD/tooling/run.mjs" node'))){
      assert.doesNotMatch(line,/(?:^|\s)(?:tests\/deployment|tooling)\/[\w./-]+\.(?:mjs|cjs)(?:\s|$)/,step.name);
    }
  }
  const history=steps.find(step=>step.name?.startsWith('Freeze verified historical'));
  assert.match(history.run,/\[path\.resolve\('tooling\/run\.mjs'\),'node',path\.resolve\('tests\/deployment\/launcher_product_refactor_smoke\.cjs'\)/);
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
  assert.match(steps[contracts].run, /tests\/shared-assets-frozen-client\.test\.mjs/, 'Exercise unchanged historical client bytes against current source contracts before native jobs');
  for(const file of ['jihulab-credentials.test.mjs','jihulab-provider.test.mjs','jihulab-publisher-config.test.mjs',
    'jihulab-transport.test.mjs','release-sources-embedding.test.mjs','launcher_jihulab_sources.test.cjs',
    'launcher_static_catalogue.test.cjs','launcher_shared_assets.test.cjs','launcher_jihulab_publication.test.cjs',
    'docs-navigation.test.cjs','launcher-publish-source.test.cjs'])
    assert.ok(steps[contracts].run.includes(file),`Current distribution contract omitted: ${file}`);
  assert.match(steps.find(step=>step.name==='Install the workflow contract parser').run,/psutil==7\.0\.0/);
  assert.match(steps[contracts].run,/tests\.deployment\.test_updater_runtime_process_detection/,
    'Exercise /proc discovery on Linux rather than calling the macOS and Windows skip a pass');
  const initialization=full.jobs.build.steps.find(step=>step.name==='Test Nora initialization and profile synchronization');
  assert.match(initialization.run,/tests\.deployment\.test_launcher_hermes_config/);
  const nativeLifecycle=full.jobs.build.steps.find(step=>step.name==='Test native transaction and complete evidence contracts');
  assert.match(nativeLifecycle.run,/tests\.deployment\.test_native_lifecycle_locking/,
    'The qualified real CLI case must also run with an actual managed runtime, not only source admission refusals');
  assert.equal(steps.find(step => step.uses === 'actions/checkout@v4').with['fetch-depth'], '0',
    'The frozen client must load its exact historical commit, not a reconstructed current client');
  assert.match(steps[contracts].run, /node "\$PWD\/tooling\/run\.mjs" python -B -m unittest tests\.deployment\.test_launcher_shared_logic\.SharedLogicTests\.test_desktop_starts_gateway_before_scheduling_shared_hook/);
  const python = steps.findIndex(step => step.uses === 'actions/setup-python@v5' && step.with?.['python-version'] === '3.11');
  assert.ok(python >= 0 && python < contracts);
  assert.equal(steps.find(step => step.with?.name === 'nora-release-plan').if, 'always()');
  assert.match(steps[gate].run, /APPROVE_UNKNOWN_INPUTS.*true/);
  assert.match(steps[gate].run, /verification-only/);
  const componentSteps = components.jobs['build-components'].steps;
  assert.ok(componentSteps.findIndex(step => step.name === 'Require an explicitly compatible component plan') < componentSteps.findIndex(step => step.run?.includes('package-release.mjs')));
});

test('mandatory backup workflow contracts run in preflight with finite installation dependencies', () => {
  const steps = full.jobs.preflight.steps;
  const decision = steps.findIndex(step => step.name?.startsWith('Require a matching build decision'));
  const dependencies = steps.findIndex(step => step.name === 'Install mandatory backup workflow contract dependencies');
  const contracts = steps.findIndex(step => step.name === 'Check release tooling before preparing runtimes');
  assert.ok(decision >= 0 && dependencies > decision && contracts > dependencies,
    'Install the Node YAML dependency after the build decision and before its complete backup workflow contracts');
  const install = steps[dependencies], check = steps[contracts];
  assert.equal(install.if, undefined);
  assert.equal(install['continue-on-error'], undefined);
  assert.equal(install['timeout-minutes'], '5');
  assert.equal(install.shell, 'bash');
  assert.match(install.run, /set -euo pipefail/);
  assert.match(install.run, /npm ci --prefix app\/engine\/sillytavern --ignore-scripts --no-audit --no-fund/);
  assert.match(install.run, /npm ci --prefix launcher\/desktop --ignore-scripts --no-audit --no-fund/,
    'Static domestic fixtures need the locked desktop semver modules in a clean preflight checkout');
  assert.doesNotMatch(install.run, /\|\|\s*true/);
  assert.equal(check.if, undefined);
  assert.equal(check['continue-on-error'], undefined);
  assert.equal([...check.run.matchAll(/tests\/backup-safety-gate\.test\.mjs/g)].length, 1);
  assert.doesNotMatch(check.run, /--test-name-pattern|--skip|\|\|\s*true/);
  const nativeBackup = full.jobs.build.steps.find(step => step.name === 'Require chat backup safety tests');
  assert.equal(nativeBackup.if, undefined);
  assert.equal(nativeBackup['continue-on-error'], undefined);
  assert.match(nativeBackup.run, /node "\$PWD\/tooling\/checks\/verify-backup-safety\.mjs"/);
  assert.match(nativeBackup.run, /npm ci --prefix app\/engine\/sillytavern/);
  assert.match(nativeBackup.run, /npm ci --prefix nora-mcp/);
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
  const presentation = steps.find(step => step.name === 'Check presentation source contracts before preparing runtimes');
  assert.ok(!presentation.run.includes('launcher_telemetry_worker.test.cjs'),
    'Source presentation checks must not imply that an absent receiver was tested');
});
test('whole machine deletion proofs cannot overlap another suite\'s unclassifiable process fixtures', () => {
  const step = full.jobs.build.steps.find(step => step.name === 'Test operation ownership, evidence, bounded retry and recovery contracts');
  assert.ok(step);
  assert.match(step.run, /node --test --test-concurrency=1/,
    'An ownership fixture can legitimately use an inline actor; deletion suites must observe the machine after that fixture closes');
  for (const file of ['launcher_operation_lock.test.cjs', 'launcher_runtime_transaction.test.cjs', 'launcher_uninstall.test.cjs'])
    assert.ok(step.run.includes(`tests/deployment/${file}`), `Required native proof lost: ${file}`);
  assert.doesNotMatch(step.run, /--test-name-pattern|--skip/);
  assert.equal(step['continue-on-error'], undefined);
});
test('historical acceptance selects published history and runs independently from runtime reuse', () => {
  assert.ok(full.on.workflow_dispatch.inputs.acceptance_baseline_tag);
  const selection = full.jobs.preflight.steps.find(step => step.id === 'acceptance-baseline');
  assert.match(selection.run, /--paginate --slurp/); assert.match(selection.run, /baseline-selection/);
  const historical = full.jobs.build.steps.find(step => step.name?.startsWith('Freeze verified historical'));
  const download = full.jobs.build.steps.find(step => step.name?.startsWith('Download the official historical'));
  assert.equal(historical.if, "needs.preflight.outputs.initial_release != 'true' && !inputs.app_only");
  assert.equal(download.if, "needs.preflight.outputs.initial_release != 'true'"); assert.match(download.run, /acceptance-baseline\.mjs/);
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
  assert.match(steps[prepareIndex].run, /"\$PWD\/tooling\/runtime\/prepare-hermes-bootstrap\.mjs" --prepare --platform "\$\{\{ matrix\.platform \}\}" --output "\$RUNNER_TEMP\/hermes-bootstrap"/);
  assert.match(steps[verifyIndex].run, /"\$PWD\/tooling\/runtime\/prepare-hermes-bootstrap\.mjs" --verify --hermes-home "\$RUNNER_TEMP\/hermes" --platform "\$\{\{ matrix\.platform \}\}"/);
  const mac = steps[macIndex].run, windows = steps[windowsIndex].run;
  assert.match(mac, /revision="\$\(node "\$PWD\/tooling\/runtime\/prepare-hermes-bootstrap\.mjs" --revision\)"/);
  assert.match(mac, /bash "\$RUNNER_TEMP\/hermes-bootstrap\/install\.sh"/);
  assert.match(mac, /--commit "\$revision"\s*\\\n\s*--force-commit/);
  assert.match(windows, /\$revision = node "\$PWD\/tooling\/runtime\/prepare-hermes-bootstrap\.mjs" --revision/);
  assert.match(windows, /hermes-bootstrap\/install\.ps1/);
  assert.match(windows, /foreach \(\$stage in \$stages\)[\s\S]*-Commit \$revision -ForceCommit/);
  assert.match(windows, /'uv', 'git', 'node', 'system-packages', 'repository', 'python', 'venv'/);
  assert.doesNotMatch(mac + windows, /https:\/\/hermes-agent\.nousresearch\.com\/install\.(?:sh|ps1)/);
});
test('cold native acceptance uses the sealed portable runtime instead of the bootstrap interpreter', () => {
  const steps = full.jobs.build.steps;
  const built = steps.findIndex(step => step.name === 'Build integrated runtime');
  const restored = steps.findIndex(step => step.name === 'Restore the freshly sealed runtime for native acceptance');
  const configured = steps.findIndex(step => step.name === 'Configure actual operation actors and native lock tests');
  const prerequisites = steps.findIndex(step => step.name === 'Verify native launcher test prerequisites');
  assert.ok(built >= 0 && restored > built && configured > restored && prerequisites > configured,
    'Cold builds must restore their sealed archive before selecting the native test interpreter');
  const step = steps[restored];
  assert.equal(step.if, "inputs.runtime_source_run == '' && inputs.launcher_baseline_tag == ''");
  assert.equal(step['continue-on-error'], undefined);
  assert.match(step.run, /set -euo pipefail/);
  assert.match(step.run, /mv "\$RUNNER_TEMP\/hermes" "\$RUNNER_TEMP\/hermes-bootstrap-source"/);
  assert.match(step.run, /mv "\$RUNNER_TEMP\/hermes-runtime" "\$RUNNER_TEMP\/hermes-sealed-build"/);
  assert.match(step.run, /node "\$PWD\/tooling\/run\.mjs" node "\$PWD\/tooling\/release\/restore-launcher-runtime\.cjs" "\$RUNNER_TEMP\/hermes-sealed-build" "\$RUNNER_TEMP"/);
  assert.doesNotMatch(step.run, /hermes-build-source|\|\|\s*true|launcher-test-environment/,
    'Keep the later acceptance backup name available and retain mandatory prerequisite checks');
});
test('the independent publication workflow only consumes accepted bytes and defaults to a local seal', () => {
  assert.deepEqual(Object.keys(publisher.on), ['workflow_dispatch']);
  assert.equal(publisher.on.workflow_dispatch.inputs.stage.default, 'seal');
  assert.equal(publisher.on.workflow_dispatch.inputs.asset_mode.default, 'legacy');
  assert.equal(publisher.on.workflow_dispatch.inputs.destinations.default, 'auto');
  assert.deepEqual(publisher.on.workflow_dispatch.inputs.destinations.options,
    ['auto','github-jihulab','all-with-jihulab','all','github','jihulab']);
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
  const snapshot=steps.findIndex(step=>step.run?.includes('snapshotBeforeTransfer('));
  assert.ok(snapshot>=0&&snapshot<sealed,'upload an independent pre-transfer snapshot before preparing credentials');
  assert.ok(sealed >= 0 && credential > sealed && network > credential && final > network);
  assert.equal(steps[credential].if, "inputs.stage != 'seal' && steps.destinations.outputs.sourceforge == 'true'");
  const domestic=steps.findIndex(step=>step.run==='node tooling/release/jihulab-credentials.mjs prepare');
  assert.ok(domestic>sealed&&domestic<network);
  assert.equal(steps[domestic].if,"inputs.stage != 'seal' && steps.destinations.outputs.jihulab == 'true'");
  assert.equal(steps[domestic].env.NORA_JIHULAB_PRIVATE_TOKEN,'${{ secrets.JIHULAB_PRIVATE_TOKEN }}');
  assert.match(steps[final].if, /always\(\)/);
  assert.equal(steps[sealed].with.path, '${{ runner.temp }}/publication-state-before-transfer/**');
  assert.equal(steps[final].with.path, '${{ runner.temp }}/publication-state/**');
  for(const [provider,script] of [['sourceforge','sourceforge-credentials.mjs'],['jihulab','jihulab-credentials.mjs']]){
    const cleanup=steps.find(step=>step.run===`node tooling/release/${script} cleanup`);
    assert.equal(cleanup.if,`always() && steps.destinations.outputs.${provider} == 'true'`);
  }
  const resolve=steps.findIndex(step=>step.id==='destinations');
  assert.ok(resolve<sealed&&resolve<credential);
  assert.match(steps[resolve].run,/resolvePublicationDestinationSelection/);
  assert.match(steps[resolve].run,/publication-plan\.json/);
  assert.match(steps[resolve].run,/GITHUB_ENV/);
  assert.equal(job.env.DESTINATIONS, '${{ inputs.destinations }}');
  const publicationCommands = steps.filter(step => /node tooling\/release\/publish-release\.mjs /.test(step.run || ''));
  assert.equal(publicationCommands.length, 2);
  for (const step of publicationCommands) {
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
test('APP-only builds retain ordinary core gates and require real interactive historical APP evidence after sealing target bytes',()=>{
 assert.equal(full.on.workflow_dispatch.inputs.app_only.default,'false');
 assert.match(full.jobs.build['runs-on'],/inputs\.app_only/);assert.match(full.jobs.build['runs-on'],/nora-launcher-native-ui/);assert.match(full.jobs.build['runs-on'],/matrix\.runner/);
 const steps=full.jobs.build.steps,download=steps.find(s=>s.name==='Verify official APP inputs exclusively for native APP-only transition');
 assert.equal(download.if,'inputs.app_only');assert.match(download.run,/acceptance-baseline\.mjs.*--launcher/);assert.doesNotMatch(download.run,/--identity-only/);
 const native=steps.findIndex(s=>s.name==='Verify actual APP-only upgrades with running and stopped unchanged core');
 assert.ok(native>steps.findIndex(s=>s.name==='Build lightweight launcher replacement'));
 assert.ok(native>steps.findIndex(s=>s.name==='Verify real APP production module closure and executor receipts'));
 assert.equal(steps[native].if,'inputs.app_only');assert.match(steps[native].run,/app-only-acceptance\.cjs.*--phase run/);
 assert.match(steps[native].run,/--baseline-launcher/);assert.doesNotMatch(steps[native].run,/\|\|\s*true|--skip|manual/);
 const proof=steps.find(s=>s.with?.name==='nora-operation-acceptance-${{ matrix.platform }}-${{ matrix.arch }}');
 for(const name of ['checkpoint.json','observed.json','finished-status.json'])assert.ok(proof.with.path.includes(name));
});
