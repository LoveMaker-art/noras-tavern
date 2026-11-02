import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { verifyLauncherStability, sourceTestGroups } from '../tooling/checks/verify-launcher-stability.mjs';
import { verifyBackupSafety } from '../tooling/checks/verify-backup-safety.mjs';
import { runFocusedRegression } from '../tooling/checks/launcher-test-impact.mjs';
import { auditReleaseFixtures, missingPythonTests, assertFixturePrerequisites } from '../tooling/checks/release-fixtures.mjs';

const root = path.resolve(import.meta.dirname, '..');
const load = name => JSON.parse(execFileSync(process.env.NORA_WORKFLOW_YAML_PYTHON || 'python3', ['-c',
  'import sys,json,yaml\nprint(json.dumps(yaml.load(open(sys.argv[1]),Loader=yaml.BaseLoader)))',
  path.join(root, '.github/workflows', name)], { encoding: 'utf8' }));
const componentStages=load('component-platform-stages.yml');
const componentNative={steps:['source','acceptance'].flatMap(stage=>componentStages.jobs[stage].steps)};
const caller = load('build-integrated-launcher.yml'), staged=load('launcher-platform-stages.yml'), components = load('publish-component-update.yml'), publisher = load('publish-accepted-release.yml');
// Existing gate assertions inspect the ordered native path across the real jobs.
// The stage-specific DAG and transfer contracts are checked separately below.
const full = structuredClone(caller);
full.jobs.build.steps=['source','runtime','package','build'].flatMap(stage=>staged.jobs[stage]?.steps||[]);
full.jobs.build['runs-on']=staged.jobs.build['runs-on'];
const scripts = workflow => Object.values(workflow.jobs).flatMap(job => job.steps || []).map(step => step.run || '').join('\n');

test('same-run stage retries retain successful producers and cannot skip a native acceptance stage',()=>{
  for(const key of ['runner','platform','arch','package_script'])assert.equal(caller.jobs.build.with[key],`\${{ matrix.${key} }}`);
  for(const key of ['app_only','production_mode','force_full_regression'])assert.equal(caller.jobs.build.with[key],`\${{ inputs.${key} || false }}`,'tag pushes have typed boolean defaults');
  assert.equal(caller.jobs.build.with.source_options,"${{ toJSON(inputs || fromJSON('{}')) }}");
  const sequence=['source','runtime','package','build'];
  for(const [index,name] of sequence.entries()){
    const job=staged.jobs[name];assert.equal(caller.jobs.build.strategy['fail-fast'],'false');
    assert.equal(job['continue-on-error'],undefined);
    assert.ok(!job.needs?.includes('preflight'),'callee has no cross-platform barrier');
    for(const dependency of sequence.slice(0,index)){
      assert.ok(job.needs.includes(dependency));assert.ok(job.if.includes(`needs.${dependency}.result == 'success'`));
      const restored=job.steps.filter(step=>step.run?.includes(`build-stage.cjs restore ${dependency}`));
      assert.equal(restored.length,1,`${name} must restore ${dependency} exactly once`);
    }
    if(name!=='build'){
      const seal=job.steps.findIndex(step=>step.run?.includes(`build-stage.cjs seal ${name}`));
      const upload=job.steps.findIndex(step=>step.with?.name===`nora-stage-${name}-\${{ inputs.platform }}-\${{ inputs.arch }}`);
      assert.ok(seal>0&&upload>seal);assert.equal(job.steps[upload].if,undefined,'failed stages never produce a reusable artifact');
      assert.equal(job.steps[upload].with['if-no-files-found'],'error');
    }
  }
  const final=staged.jobs.build.steps;
  assert.ok(!final.some(step=>/package-release|package-launcher-update|npm run/.test(step.run||'')),'acceptance retry must never rebuild the candidate');
  assert.ok(!staged.jobs.package.steps.some(step=>step.name==='Require launcher source stability before preparing runtimes'));
  assert.ok(final.some(step=>step.name==='Verify stage provenance and unchanged product before delivery'));
  const retained=final.find(step=>step.name==='Preserve isolated operation acceptance evidence');assert.ok(retained.with.path.includes('nora-build-stages.json'));
  const continuity=staged.jobs.package.steps.find(step=>step.name==='Test native transaction and complete evidence contracts');
  assert.ok(continuity.run.includes('test_native_maintenance_contract')||continuity.run.includes('test_native_lifecycle_locking'),'continuous recovery checks stay together');
});

test('all same-run stage handoffs use the same exact verification interpreters',()=>{
  for(const workflow of [caller,staged])for(const job of Object.values(workflow.jobs))for(const step of job.steps||[]){
    if(step.uses==='actions/setup-node@v4')assert.equal(step.with['node-version'],'24.19.0');
    if(step.uses==='actions/setup-python@v5')assert.equal(step.with['python-version'],'3.11.9');
  }
});

test('fresh package workers qualify real Chromium before native recovery tests',()=>{
  const steps=staged.jobs.package.steps;
  const dependencies=steps.findIndex(step=>step.name==='Install launcher test dependencies');
  const qualify=steps.findIndex(step=>step.name==='Qualify actual Electron before native recovery tests');
  const recovery=steps.findIndex(step=>step.name==='Test unified update and application replacement');
  assert.ok(dependencies>=0&&qualify>dependencies&&recovery>qualify,'each fresh package VM must prepare the real Electron fixture before recovery');
  assert.match(steps[qualify].run,/node launcher\/desktop\/node_modules\/electron\/install\.js/);
  assert.match(steps[qualify].run,/launcher-test-environment\.mjs.*chromium/);
  assert.equal(steps[qualify].if,undefined,'qualify the locked Electron on every native platform');
});

const pythonTestReferences = references => missingPythonTests(references, root);

test('release workflows and source gates reference existing authored test files and Python members', () => {
  const report=auditReleaseFixtures({root,loaded:[['build',caller],['stages',staged],['components',components],['publisher',publisher]]
    .map(([name,workflow])=>({name,workflow}))});
  assert.ok(report.files.length>0&&report.python.length>0);
});

test('fixture prerequisite audit rejects wrong-platform recovery and dependencies installed after consumption',()=>{
  assert.throws(()=>assertFixturePrerequisites({jobs:{core:{'runs-on':'ubuntu-24.04',steps:[{run:'python -m unittest tests.deployment.test_launcher_update_recovery'}]}}}),/desktop recovery/);
  const steps=[{run:'node tooling/checks/verify-launcher-stability.mjs'},{run:'npm ci --prefix app/engine/sillytavern --ignore-scripts'}];
  assert.throws(()=>assertFixturePrerequisites({jobs:{source:{'runs-on':'macos-15',steps}}}),/precede/);
  assertFixturePrerequisites({jobs:{source:{'runs-on':'macos-15',steps:[...steps].reverse()}}});
});

test('authored native script entries are checked before packaging, without requiring generated dependencies',()=>{
  const loaded=[{name:'entry-fixture',workflow:{jobs:{native:{steps:[
    {run:'./tooling/checks/launcher-installed-check.ps1'},
    {run:'node launcher/desktop/node_modules/electron/install.js'},
  ]}}}}];
  const report=auditReleaseFixtures({root,loaded});
  assert.ok(report.scripts.includes('tooling/checks/launcher-installed-check.ps1'));
  assert.ok(!report.scripts.some(file=>file.includes('/node_modules/')));
  loaded[0].workflow.jobs.native.steps.push({run:'./tooling/checks/missing-native-entry-fixture.ps1'});
  assert.throws(()=>auditReleaseFixtures({root,loaded}),/missing authored script/);
});

test('fixture audit follows the actual Tavern npm glob and dynamic contract consumer without running them',()=>{
  const report=auditReleaseFixtures({root,loaded:[{name:'frontend',workflow:{jobs:{source:{steps:[
    {run:'node tooling/run.mjs npm --prefix app/engine/sillytavern run test:nora'},
  ]}}}}]});
  for(const name of ['nora-world-ui-boundary.test.mjs','nora-ui-shell-contract.mjs','run-nora-contracts.mjs'])
    assert.ok(report.files.includes(`app/engine/sillytavern/tests/${name}`),name);
  assert.ok(report.scripts.includes('app/engine/sillytavern/build/build-public-lib.mjs'));
  assert.ok(report.scripts.includes('app/engine/sillytavern/build/sync-story-profile-runtime.mjs'));
});

test('the release reference audit detects a missing Python module or named native test without importing it', () => {
  const existing = scripts(full).match(/tests\.deployment\.[A-Za-z_][\w.]*\.test_[A-Za-z_\w]*/)?.[0];
  assert.ok(existing, 'The actual Windows/native named entry must be included');
  assert.deepEqual(pythonTestReferences([existing]), []);
  const missing = pythonTestReferences(['tests.deployment.test_missing_release_reference_fixture', existing + '.removed_fixture_member']);
  assert.equal(missing.length, 2);
  assert.equal(missing[0].reason, 'FileNotFoundError');
  assert.match(missing[1].reason, /removed_fixture_member/);
});
test('component delivery requires all three native platforms before the final publishable receipt', () => {
  const native = components.jobs['native-components'], accepted = components.jobs['accept-components'];
  assert.deepEqual(native.needs, ['build-components','prepare-platform-inputs']); assert.equal(native.strategy['fail-fast'], 'false');
  assert.deepEqual(native.strategy.matrix.include, [
    { runner: 'macos-15', platform: 'darwin-arm64' },
    { runner: 'macos-15-intel', platform: 'darwin-x64' },
    { runner: 'windows-latest', platform: 'win32-x64' },
  ]);
  assert.deepEqual(accepted.needs, ['build-components', 'native-components']);
  assert.equal(accepted.if, undefined, 'A failed or skipped native matrix must not produce an accepted receipt');
  assert.equal(native.uses,'./.github/workflows/component-platform-stages.yml');
  const nativeSteps = componentNative.steps, downloaded = nativeSteps.find(step => step.uses === 'actions/download-artifact@v4');
  assert.equal(downloaded.with['artifact-ids'], '${{ inputs.delivery_artifact_id }}');
  assert.equal(downloaded.with['merge-multiple'],'true');
  const prepare = nativeSteps.findIndex(step => step.name === 'Materialize the same frozen component payload');
  const run = nativeSteps.findIndex(step => step.name === 'Test fresh target installation and both native upgrade states with retained user data');
  assert.ok(prepare >= 0 && run > prepare);
  assert.match(nativeSteps[prepare].run, /component-acceptance\.mjs prepare.*COMPONENT_DELIVERY.*component-payload.*PRODUCT_COMMIT/);
  assert.match(nativeSteps[run].run, /component-acceptance\.mjs" run.*component-payload.*component-baseline.*PRODUCT_COMMIT.*BASELINE_TAG.*baseline_commit/);
  assert.equal(nativeSteps[run]['continue-on-error'], undefined);
  assert.equal(nativeSteps.find(step => step.name === 'Pin the native verification tool interpreter').with['python-version'], '3.11.9');
  const baseline = nativeSteps.find(step => step.name === 'Authenticate the published baseline for actual native upgrades');
  assert.match(baseline.run, /acceptance-baseline\.mjs.*--expected-commit/);
  assert.match(nativeSteps.find(step => step.name === 'Restore the verified frozen runtime for native harness prerequisites').run, /restore-launcher-runtime\.cjs.*component-payload/);
  const archive = componentStages.jobs.acceptance.steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(archive.if, 'success()');assert.equal(archive.with.overwrite,'true'); assert.equal(archive.with.name, 'nora-component-native-${{ inputs.platform }}');
  assert.equal(archive.with['if-no-files-found'], 'error');
  assert.ok(!components.jobs['build-components'].steps.some(step => step.with?.name === 'nora-component-acceptance'),
    'Source-only Ubuntu checks must not publish the final native receipt');
  const final = accepted.steps.find(step => step.name === 'Accept only complete three-platform native evidence for these bytes');
  assert.match(final.run, /component-acceptance\.mjs seal.*COMPONENT_DELIVERY.*component-native.*release-plan\.json.*PRODUCT_COMMIT/);
  assert.equal(final['continue-on-error'], undefined);
});
test('source checks run locally in each platform job without cross-machine report handoff', () => {
  assert.equal(full.jobs['source-checks'], undefined);
  assert.ok(!full.on.workflow_dispatch.inputs.target.options.includes('source-checks'));
  const gate = full.jobs.build.steps.find(step => step.name === 'Require launcher source stability before preparing runtimes');
  assert.match(gate.run, /verify-launcher-stability\.mjs/);
  assert.doesNotMatch(gate.run, /--report|--verify-reports|nora-source-stability/);
});
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
  assert.deepEqual(target.options, ['all', 'win32-x64', 'darwin-x64', 'darwin-arm64', 'win32-package-check', 'preflight-only']);
  assert.deepEqual(full.concurrency, {
    group: "nora-build-${{ github.sha }}-${{ inputs.target || 'all' }}",
    'cancel-in-progress': 'false',
  });
  assert.equal(full.jobs.build.strategy['fail-fast'], 'false', 'One platform must not cancel the other native jobs');
  assert.deepEqual(full.permissions, { contents: 'read', actions: 'read' });
  const shared = full.jobs.build.steps.find(step => step.name === 'Upload shared updater assets');
  assert.equal(shared.if, "inputs.platform == 'darwin' && inputs.arch == 'arm64' && (github.ref_type == 'tag' || inputs.production_mode)");
});
test('the repository default Node major matches all release workflows', () => {
  const defaultNode = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  assert.equal(defaultNode, '24', 'Launcher source and native checks require real Node.js 24');
  for (const [name, workflow] of [['native', full], ['components', components], ['publisher', publisher]]) {
    const setup = Object.values(workflow.jobs).flatMap(job => job.steps || [])
      .filter(step => step.uses?.startsWith('actions/setup-node@'));
    assert.ok(setup.length > 0, `${name} workflow must select its Node version`);
    for (const step of setup) assert.equal(step.with?.['node-version'].split('.')[0], defaultNode,
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
test('the full profile retains complete source coverage and focused profiles leave native product acceptance mandatory', () => {
  const steps=full.jobs.build.steps;
  const runtime=steps.findIndex(step=>step.name==='Download and verify unchanged published components');
  const files=command=>[...command.matchAll(/tests\/deployment\/([\w.-]+\.test\.cjs)/g)].map(match=>match[1]);
  const sourceFiles=steps.slice(0,runtime).flatMap(step=>files(step.run||''));
  verifyLauncherStability({platform:'darwin',checkEnvironment:()=>({environment:process.env}),run:(command,args)=>{
    sourceFiles.push(...args.filter(arg=>arg.endsWith('.test.cjs')).map(file=>path.basename(file)));return {status:0};
  }});
  for(const file of new Set(sourceFiles))assert.equal(sourceFiles.filter(name=>name===file).length,1,
    `${file} is already covered in this source environment; native-context repetitions remain separate`);
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
    assert.equal(source.if,group==='presentation'?"steps.test-impact.outputs.full == 'true' || steps.test-impact.outputs.ui == 'true'":undefined);
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
  for(const name of ['Test operation ownership, evidence, bounded retry and recovery contracts',
    'Test native transaction and complete evidence contracts','Test unified update and application replacement'])
    assert.equal(steps.find(step=>step.name===name).if,"steps.test-impact.outputs.full == 'true' || (inputs.launcher_baseline_tag == '' && inputs.runtime_source_run == '')",
      'New environments cannot reuse source-only qualification');
  const selection=steps.findIndex(step=>step.id==='test-impact');
  const gate=steps.findIndex(step=>step.name==='Require launcher source stability before preparing runtimes');
  assert.ok(selection>=0&&selection<gate);
  assert.match(steps[selection].run,/--base "\$ACCEPTANCE_BASELINE_TAG" --head "\$GITHUB_SHA"/);
  assert.match(steps[gate].run,/case "\$FULL_REGRESSION" in/);
  assert.match(steps[gate].run,/false\) node .*launcher-test-impact\.mjs.*--run-focused/);
  assert.match(steps[gate].run,/Missing verified test selection.*exit 1/);
  for(const name of ['Require chat backup safety tests','Verify real APP production module closure and executor receipts',
    'Verify packaged network modules in native Chromium'])assert.equal(steps.find(step=>step.name===name).if,undefined,name);
  const component=components.jobs['build-components'].steps;
  const componentSelection=component.findIndex(step=>step.id==='test-impact');
  const componentGate=component.findIndex(step=>step.name==='Require the selected component source regression');
  assert.ok(componentSelection>=0&&componentGate>componentSelection);
  assert.match(componentNative.steps.find(step=>step.name==='Qualify native maintenance changes before actual component acceptance').run,/true\) node "\$PWD\/tooling\/checks\/verify-launcher-stability\.mjs"/);
  assert.match(component[componentGate].run,/--run-focused/);
  assert.match(component[componentGate].run,/Missing verified test selection.*exit 1/);
  assert.doesNotMatch(scripts(publisher),/verify-launcher-stability|--run-focused|launcher-installed-check/,
    'Publishing accepted bytes must retain provenance checks without rerunning product installation');
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
  assert.equal(steps[backupPython].with['python-version'], '3.11.9');
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
  const python = steps.findIndex(step => step.uses === 'actions/setup-python@v5' && step.with?.['python-version'] === '3.11.9');
  assert.ok(python >= 0 && python < contracts);
  assert.equal(steps.find(step => step.with?.name === 'nora-release-plan').if, 'always()');
  assert.match(steps[gate].run, /APPROVE_UNKNOWN_INPUTS.*true/);
  assert.match(steps[gate].run, /verification-only/);
  const componentSteps = components.jobs['build-components'].steps;
  assert.ok(componentSteps.findIndex(step => step.name === 'Require an explicitly compatible component plan') < componentSteps.findIndex(step => step.run?.includes('package-release.mjs')));
});

test('pure output and publisher regressions run before native builds without repeating operation policy in the same Node context', () => {
  const early=full.jobs.preflight.steps.find(step=>step.name==='Check release tooling before preparing runtimes').run;
  for(const file of ['tests/publication-providers.test.mjs','tests/release-publication.test.mjs',
    'tests/deployment/launcher_process_output.test.cjs'])assert.ok(early.includes(file),`${file} must fail before native builds`);
  const steps=full.jobs.build.steps;
  assert.ok(steps.find(step=>step.name==='Verify failed-install recovery and error classification before preparing runtimes')
    .run.includes('launcher_operation_policy.test.cjs'));
  const native=steps.find(step=>step.name==='Test operation ownership, evidence, bounded retry and recovery contracts').run;
  assert.ok(!native.includes('launcher_operation_policy.test.cjs'),'pure policy does not acquire a different Hermes context');
  for(const file of ['launcher_operation_lock','launcher_operation_state','launcher_uninstall','launcher_runtime_transaction',
    'launcher_restore_runtime','launcher_update_executor'])assert.ok(native.includes(file+'.test.cjs'),`${file} native coverage stays mandatory`);
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
  assert.equal(check.run.split('tests/launcher-build-shell.test.mjs').length-1,1,'Portable actual Bash arguments must fail in preflight');
  for(const file of ['launcher-build-baseline','launcher-build-package'])assert.ok(!check.run.includes(`tests/${file}.test.mjs`),'Native packager tests require one of the supported product platforms');
  const nativePackaging=staged.jobs.source.steps.find(step=>step.name==='Verify launcher build reuse boundaries').run;
  for(const file of ['launcher-build-baseline','launcher-build-package','launcher-build-shell'])assert.ok(nativePackaging.includes(`tests/${file}.test.mjs`),'All original native packaging and platform Bash assertions stay in each native source stage');
  assert.doesNotMatch(check.run, /--test-name-pattern|--skip|\|\|\s*true/);
  const nativeBackup = full.jobs.build.steps.find(step => step.name === 'Require chat backup safety tests');
  assert.equal(nativeBackup.if, undefined);
  assert.equal(nativeBackup['continue-on-error'], undefined);
  assert.match(nativeBackup.run, /node "\$PWD\/tooling\/checks\/verify-backup-safety\.mjs"/);
  assert.match(nativeBackup.run, /npm ci --prefix nora-mcp/);
  for (const [job, consumer] of [['source', 'Require launcher source stability before preparing runtimes'],
    ['package', 'Verify committed installation journals before installation tests']]) {
    const nativeSteps = staged.jobs[job].steps;
    const recoveryDependencies = nativeSteps.findIndex(step => step.name === 'Install locked Tavern dependencies before recovery checks');
    assert.ok(recoveryDependencies >= 0 && recoveryDependencies < nativeSteps.findIndex(step => step.name === consumer),
      `${job}: real chat backup recovery fixtures need locked engine dependencies before their first consumer`);
    const prerequisite = nativeSteps[recoveryDependencies];
    assert.equal(prerequisite.if, undefined);
    assert.equal(prerequisite['continue-on-error'], undefined);
    assert.equal(prerequisite['timeout-minutes'], '5');
    assert.match(prerequisite.run, /^npm ci --prefix app\/engine\/sillytavern --ignore-scripts --no-audit --no-fund\s*$/);
    assert.equal(nativeSteps.filter(step => /npm ci --prefix app\/engine\/sillytavern/.test(step.run || '')).length, 1,
      `${job}: install the same locked engine dependencies only once`);
  }
});

test('component Linux preparation exercises headless updates while full desktop maintenance stays on all native targets', () => {
  assert.equal(components.jobs['build-components']['runs-on'], 'ubuntu-latest');
  const linux = components.jobs['build-components'].steps.find(step => step.name === 'Require the selected component source regression');
  assert.match(linux.run, /true\) node "\$PWD\/tooling\/checks\/verify-launcher-stability\.mjs"/);
  assert.equal(components.jobs['build-components'].steps.filter(step => step.name === 'Check independent update and data contracts outside the full gate').length, 0,
    'the same Linux qualification must not maintain a second handwritten module list');
  const selected=sourceTestGroups('linux');
  for (const name of ['test_update_dependency_materialization', 'test_update_operation_safety', 'test_updater_task_backend', 'test_standalone_update_recovery',
    'test_update_download_sources', 'test_incremental_update', 'test_update_check', 'test_managed_update', 'test_native_startup_evidence', 'test_native_cli_diagnostics',
    'test_cloud_instance_paths', 'test_cloud_lifecycle_cli', 'test_cloud_volume_recovery'])
    assert.ok(selected.python.includes(name), `actual Linux maintenance path: ${name}`);
  assert.equal(new Set(selected.python).size,selected.python.length);
  assert.deepEqual(selected.javascript,['cloud_core_release.test.cjs']);
  const native = components.jobs['native-components'];
  assert.deepEqual(native.strategy.matrix.include.map(item => item.platform).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
  const gate = componentNative.steps.find(step => step.name === 'Qualify native maintenance changes before actual component acceptance');
  assert.match(gate.run, /true\) node "\$PWD\/tooling\/checks\/verify-launcher-stability\.mjs"/);
  assert.match(gate.run, /tooling\/run\.mjs" python -B -m unittest tests\.deployment\.test_launcher_update_recovery/);
  assert.ok(gate.run.indexOf('verify-launcher-stability.mjs') < gate.run.indexOf('test_launcher_update_recovery'));
  assert.equal(gate['continue-on-error'], undefined);
  assert.ok(componentNative.steps.indexOf(gate) < componentNative.steps.findIndex(step => step.name === 'Test fresh target installation and both native upgrade states with retained user data'));
});

test('native component maintenance wrappers satisfy the real Windows offline process census', () => {
  const { windowsProcesses } = createRequire(import.meta.url)('../deployment/uninstall/uninstall-offline-check.js');
  const native = componentNative;
  for (const name of ['Qualify native maintenance changes before actual component acceptance',
    'Test fresh target installation and both native upgrade states with retained user data']) {
    const body = native.steps.find(step => step.name === name).run;
    const entries = [...body.matchAll(/\bnode\s+("\$PWD\/[^"\n]+\.mjs"|tooling\/[^\s;]+\.mjs)/g)];
    assert.ok(entries.length > 0, name);
    for (const [, entry] of entries) {
      const script = entry.replaceAll('$PWD/', 'C:/work/nora/');
      const snapshot = { schema: 'nora-uninstall-processes/1', processes: [
        { pid: 42, name: 'node.exe', executable: 'C:\\Node\\node.exe', commandLine: 'node "C:\\tests\\worker.cjs"' },
        { pid: 43, name: 'node.exe', executable: 'C:\\Node\\node.exe', commandLine: `node ${script}` },
      ] };
      assert.doesNotThrow(() => windowsProcesses(JSON.stringify(snapshot), { root: 'C:\\NoraTavern', pid: 42 }), name + ': ' + entry);
    }
  }
});

test('component workers prepare locked engine dependencies before real recovery consumers', () => {
  for (const [job, consumer] of [['build-components', 'Require the selected component source regression'],
    ['native-components', 'Qualify native maintenance changes before actual component acceptance']]) {
    const steps = job==='native-components'?componentStages.jobs.source.steps:components.jobs[job].steps;
    const installations = steps.map((step, index) => /npm ci --prefix app\/engine\/sillytavern/.test(step.run || '') ? index : -1).filter(index => index >= 0);
    assert.equal(installations.length, 1, `${job}: one locked engine install per fresh worker`);
    assert.ok(installations[0] < steps.findIndex(step => step.name === consumer), `${job}: engine dependencies must precede recovery`);
    const prerequisite = steps[installations[0]];
    assert.equal(prerequisite.if, undefined);
    assert.equal(prerequisite['continue-on-error'], undefined);
    assert.match(prerequisite.run, /npm ci --prefix app\/engine\/sillytavern --ignore-scripts --no-audit --no-fund/);
    assert.ok(Number(prerequisite['timeout-minutes']) > 0 && Number(prerequisite['timeout-minutes']) <= 10);
  }
});

test('test prerequisites and absolute runner entries are mandatory before native suites', () => {
  const steps = full.jobs.build.steps;
  for (const step of steps) for (const line of (step.run || '').split('\n')) {
    if (/(?:^|\s)-m unittest tests\.deployment\./.test(line))
      assert.match(line, /node "\$PWD\/tooling\/run\.mjs"/, 'Deployment-relative tests must execute the actual delivery projection');
  }
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
  const facts=full.jobs.preflight.steps.find(step=>step.name==='Read published facts before separating planning and upgrade baselines');
  assert.match(facts.run,/--paginate --slurp/);assert.match(selection.run,/baseline-selection/);
  assert.equal(selection.if,"steps.plan.outputs.mode != 'verification-only'");
  const historical = full.jobs.build.steps.find(step => step.name?.startsWith('Freeze verified historical'));
  const download = full.jobs.build.steps.find(step => step.name?.startsWith('Download the official historical'));
  assert.equal(historical.if, "inputs.initial_release != 'true' && !inputs.app_only");
  assert.equal(download.if, "inputs.initial_release != 'true'"); assert.match(download.run, /acceptance-baseline\.mjs/);
  assert.equal(download.env.GH_TOKEN, '${{ github.token }}', 'Historical GitHub downloads require the read-only job token');
  assert.equal(full.permissions.contents, 'read'); assert.equal(full.permissions.actions, 'read');
  const early = full.jobs.preflight.steps.find(step => step.name === 'Verify historical download identities before native builds');
  assert.equal(full.jobs.preflight.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(early.if, "steps.plan.outputs.mode != 'verification-only' && steps.acceptance-baseline.outputs.initial_release != 'true'");
  assert.equal(early.env.ACCEPTANCE_BASELINE_TAG, '${{ steps.acceptance-baseline.outputs.acceptance_baseline_tag }}');
  assert.equal(early['timeout-minutes'], '5');
  assert.match(early.run, /for platform in darwin-arm64 darwin-x64 win32-x64/);
  assert.match(early.run, /acceptance-baseline\.mjs.*--identity-only/);
  assert.doesNotMatch(download.run, /--identity-only/, 'Native upgrade acceptance still requires the full historical payload');
  assert.ok(!full.jobs.build.env?.GH_TOKEN, 'Do not expose the GitHub token to electron-builder');
  assert.doesNotMatch(historical.run, /RUNTIME_SOURCE_RUN|nora-baseline-artifacts/);
  const proof = full.jobs.build.steps.find(step => step.with?.name === 'nora-operation-acceptance-${{ inputs.platform }}-${{ inputs.arch }}');
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
  assert.match(steps[prepareIndex].run, /"\$PWD\/tooling\/runtime\/prepare-hermes-bootstrap\.mjs" --prepare --platform "\$\{\{ inputs\.platform \}\}" --output "\$RUNNER_TEMP\/hermes-bootstrap"/);
  assert.match(steps[verifyIndex].run, /"\$PWD\/tooling\/runtime\/prepare-hermes-bootstrap\.mjs" --verify --hermes-home "\$RUNNER_TEMP\/hermes" --platform "\$\{\{ inputs\.platform \}\}"/);
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
    { GITHUB_RUN_ATTEMPT: '2' }, { SOURCE_RUN: '123; touch forbidden' }, { RELEASE_TAG: '-invalid' },
    { REQUALIFY_COMPONENTS: 'true', DELIVERY_MODE: 'full' }]) {
    assert.notEqual(run(extra).status, 0, JSON.stringify(extra));
  }
  const valid = run({}); assert.equal(valid.status, 0, valid.stderr);
  assert.equal(run({REQUALIFY_COMPONENTS:'true',DELIVERY_MODE:'components'}).status,0);
  assert.match(fs.readFileSync(base.GITHUB_OUTPUT, 'utf8'), /source_sha=[a-f0-9]{40}/);
});
test('component requalification is explicit and reads producer facts from the original source API',()=>{
  assert.equal(publisher.on.workflow_dispatch.inputs.requalify_components.type,'boolean');
  assert.equal(publisher.on.workflow_dispatch.inputs.requalify_components.default,'false');
  const restore=publisher.jobs['publish-accepted'].steps.find(step=>step.name==='Restore accepted delivery with exact artifact ZIP hashes').run;
  assert.match(restore,/if \[\[ "\$\{REQUALIFY_COMPONENTS:-false\}" == true \]\]/);
  assert.match(restore,/allJobs\(process\.env\.GITHUB_REPOSITORY,process\.env\.SOURCE_RUN\)/);
  assert.doesNotMatch(restore,/jobs\?filter=latest/,'Earlier successful source jobs and failed attempts remain visible');
  assert.match(restore,/publication-source\.cjs delivery.*'' '' "\$qualification_jobs"/);
  assert.ok(restore.indexOf('allJobs(')<restore.indexOf('publication-source.cjs delivery'));
});
test('APP-only builds retain ordinary core gates and require real interactive historical APP evidence after sealing target bytes',()=>{
 assert.equal(full.on.workflow_dispatch.inputs.app_only.default,'false');
 assert.match(full.jobs.build['runs-on'],/inputs\.app_only/);assert.match(full.jobs.build['runs-on'],/nora-launcher-native-ui/);assert.match(full.jobs.build['runs-on'],/inputs\.runner/);
 const steps=full.jobs.build.steps,download=steps.find(s=>s.name==='Verify official APP inputs exclusively for native APP-only transition');
 assert.equal(download.if,'inputs.app_only');assert.match(download.run,/acceptance-baseline\.mjs.*--launcher/);assert.doesNotMatch(download.run,/--identity-only/);
 const native=steps.findIndex(s=>s.name==='Verify actual APP-only upgrades with running and stopped unchanged core');
 assert.ok(native>steps.findIndex(s=>s.name==='Build lightweight launcher replacement'));
 assert.ok(native>steps.findIndex(s=>s.name==='Verify real APP production module closure and executor receipts'));
 assert.equal(steps[native].if,'inputs.app_only');assert.match(steps[native].run,/app-only-acceptance\.cjs.*--phase run/);
 assert.match(steps[native].run,/--baseline-launcher/);assert.doesNotMatch(steps[native].run,/\|\|\s*true|--skip|manual/);
 const proof=steps.find(s=>s.with?.name==='nora-operation-acceptance-${{ inputs.platform }}-${{ inputs.arch }}');
 for(const name of ['checkpoint.json','observed.json','finished-status.json'])assert.ok(proof.with.path.includes(name));
});

test('component acceptance retries restore the complete passed source stage and never build products',()=>{
  const source=componentStages.jobs.source,acceptance=componentStages.jobs.acceptance;
  assert.equal(acceptance.needs,'source');assert.equal(acceptance.if,undefined);
  assert.equal(components.permissions.actions,'read');
  assert.match(acceptance.steps.find(step=>step.name==='Restore successful source qualification without running it again').run,/build-stage\.cjs restore source/);
  assert.ok(!acceptance.steps.some(step=>/verify-launcher-stability|package-component-update|package-release|npm run/.test(step.run||'')));
  const gate=source.steps.find(step=>step.name==='Qualify native maintenance changes before actual component acceptance');
  assert.match(gate.run,/false\) node .*launcher-test-impact\.mjs.*--run-focused/,'focused desktop minimum remains mandatory after moving Linux away from desktop fixtures');
  const seal=source.steps.findIndex(step=>step.name==='Seal reusable component source qualification');
  const upload=source.steps.findIndex(step=>step.with?.name==='nora-component-stage-source-${{ inputs.platform }}');
  assert.ok(seal>source.steps.indexOf(gate)&&upload>seal);assert.equal(source.steps[upload].if,undefined);
  const raw=acceptance.steps.find(step=>step.with?.name==='nora-component-native-${{ inputs.platform }}');
  assert.ok(raw.with.path.includes('nora-stage-input-source.json'));
  for(const job of [source,acceptance]){
    assert.equal(job.steps.find(step=>step.uses==='actions/setup-node@v4').with['node-version'],'24.19.0');
    assert.equal(job.steps.find(step=>step.uses==='actions/setup-node@v4').with.cache,'npm');
    assert.equal(job.steps.find(step=>step.uses==='actions/setup-node@v4').with['cache-dependency-path'],'launcher/desktop/package-lock.json');
    assert.equal(job.steps.find(step=>step.uses==='actions/setup-python@v5').with['python-version'],'3.11.9');
  }
});

test('component regression and upgrade baselines are fixed separately before restoring a product',()=>{
  const job=components.jobs['build-components'],steps=job.steps;
  const baseline=steps.findIndex(step=>step.id==='baselines');
  assert.ok(baseline>=0&&baseline<steps.findIndex(step=>step.id==='product'));
  assert.match(steps[baseline].run,/baseline-selection/);
  assert.match(steps[baseline].run,/selectPlanningBaseline/);
  assert.match(steps[baseline].run,/NORA_PRODUCT_SOURCE_TAG/);
  assert.match(steps.find(step=>step.id==='plan').run,/--base "\$REGRESSION_BASELINE"/);
  assert.match(steps.find(step=>step.id==='test-impact').run,/--base "\$REGRESSION_BASELINE"/);
  assert.equal(components.jobs['native-components'].with.regression_baseline,'${{ needs.build-components.outputs.regression_baseline }}');
  assert.equal(componentStages.env.REGRESSION_BASELINE,'${{ inputs.regression_baseline }}');
  assert.match(componentStages.env.NORA_STAGE_OPTIONS,/regressionBaseline/);
  const source=componentStages.jobs.source.steps.find(step=>step.name==='Qualify native maintenance changes before actual component acceptance');
  assert.match(source.run,/--base "\$REGRESSION_BASELINE"/);
  assert.doesNotMatch(source.run,/--base "\$BASELINE_TAG"/);
  const upgrade=componentStages.jobs.acceptance.steps.find(step=>step.name==='Authenticate the published baseline for actual native upgrades');
  assert.match(upgrade.run,/--tag "\$BASELINE_TAG"/);
});

test('the actual component baseline step preserves upgrade identity and rejects an obsolete baseline early',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'component-baselines-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const step=components.jobs['build-components'].steps.find(step=>step.id==='baselines');
  const lines=step.run.split('\n'),network=lines.findIndex(line=>line.includes('gh api '));
  assert.ok(network>=0);lines[network]='cp "$FIXTURE_FACTS" "$facts"';
  const facts=path.join(directory,'facts.json');
  fs.writeFileSync(facts,JSON.stringify([['v2.6.0','v2.6.4'].map(tag_name=>({tag_name,draft:false,prerelease:false}))]));
  for(const [name,source,upgrade,expected] of [['new','','v2.6.4','v2.6.4'],['revalidate','v2.6.4','v2.6.0','v2.6.4'],['obsolete','','v2.6.0',null]]){
    const temp=path.join(directory,name);fs.mkdirSync(temp);
    const env={PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,RUNNER_TEMP:temp,FIXTURE_FACTS:facts,
      GITHUB_REPOSITORY:'owner/repo',GITHUB_ENV:path.join(temp,'env'),GITHUB_OUTPUT:path.join(temp,'output'),
      NORA_PUBLICATION_TAG:'v2.6.5',NORA_PRODUCT_SOURCE_TAG:source,BASELINE_TAG:upgrade};
    const result=spawnSync('bash',['-c',lines.join('\n')],{cwd:root,env,encoding:'utf8',timeout:10000});
    if(expected){assert.equal(result.status,0,result.stderr);assert.match(fs.readFileSync(env.GITHUB_ENV,'utf8'),new RegExp('REGRESSION_BASELINE='+expected));
      assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'component-upgrade-baseline.json'))).tag,upgrade);
    }else{assert.notEqual(result.status,0);assert.equal(fs.existsSync(env.GITHUB_ENV),false);assert.match(result.stderr,/most recent published older stable/);}
  }
});

test('verification-only dispatches check tooling without historical payloads or product builds',()=>{
 const preflight=caller.jobs.preflight;
 assert.equal(preflight.outputs.plan_mode,'${{ steps.plan.outputs.mode }}');
 assert.match(preflight.steps.find(step=>step.id==='plan').run,/selectPlanningBaseline/);
 assert.match(caller.jobs.build.if,/needs\.preflight\.outputs\.plan_mode != 'verification-only'/);
 assert.match(caller.jobs['reuse-windows'].if,/needs\.preflight\.outputs\.plan_mode != 'verification-only'/);
 const gate=preflight.steps.find(step=>step.name?.startsWith('Require a matching build decision'));
 const start=gate.run.indexOf('verification-only)');assert.ok(start>=0);
 assert.doesNotMatch(gate.run.slice(start).split(';;')[0],/No product build.*exit 1/);
 assert.ok(preflight.steps.some(step=>step.run?.includes('release-fixtures.mjs')));
});

test('original component ZIP revalidation never runs compilation and keeps verification and product commits distinct',()=>{
 const build=components.jobs['build-components'];
 assert.ok(components.on.workflow_dispatch.inputs.product_source_run);assert.ok(components.on.workflow_dispatch.inputs.product_source_tag);
 assert.equal(build.outputs.product_commit,'${{ steps.product.outputs.product_commit }}');
 assert.equal(build.outputs.product_tag,'${{ steps.product.outputs.product_tag }}');
 const restore=build.steps.find(step=>step.id==='product');assert.equal(restore.run,'node tooling/release/publication-source.cjs restore-product');
 assert.equal(restore.if,undefined,'both paths resolve their identity before proceeding');
 for(const name of ['Plan component changes before compilation','Require an explicitly compatible component plan',
  'Build only shared application and updater components','Reuse verified environments and seal three system manifests','Verify the frozen component delivery before native acceptance'])
  assert.equal(build.steps.find(step=>step.name===name).if,"inputs.product_source_run == ''",name);
 for(const name of ['Verify release contracts and update preservation','Require chat backup safety tests','Require the selected component source regression'])
  assert.equal(build.steps.find(step=>step.name===name).if,undefined,'new verifier must actually execute '+name);
 for(const stage of ['source','acceptance']){
  const steps=componentStages.jobs[stage].steps;
  const checked=steps.findIndex(step=>step.name==='Qualify product and verification handoff inputs before downloading');
  assert.ok(checked>=0&&checked<steps.findIndex(step=>step.name==='Materialize the same frozen component payload'));
  assert.match(steps[checked].run,/check-component-input/);
  assert.match(steps.find(step=>step.name==='Materialize the same frozen component payload').run,/PRODUCT_COMMIT/);
 }
 assert.equal(componentStages.env.PRODUCT_COMMIT,'${{ inputs.product_commit }}');
 assert.match(componentStages.env.NORA_STAGE_OPTIONS,/productCommit/);assert.match(componentStages.env.NORA_STAGE_OPTIONS,/productSourceRun/);
 assert.match(componentStages.jobs.source.steps.find(step=>step.name?.startsWith('Qualify native maintenance')).run,/--head "\$GITHUB_SHA"/);
 assert.ok(publisher.on.workflow_dispatch.inputs.revalidated_components);
 assert.match(publisher.jobs['publish-accepted'].steps.find(step=>step.name?.startsWith('Restore accepted delivery')).run,/REVALIDATED_COMPONENTS/);
});

test('component retries retain failed diagnostics, replace only canonical CI slots, and bind changed upstream artifacts',()=>{
 const delivery=components.jobs['build-components'].steps.find(step=>step.id==='delivery');
 assert.equal(delivery.with.overwrite,'true');
 const accepted=componentStages.jobs.acceptance.steps.find(step=>step.name==='Preserve raw native component evidence');
 assert.equal(accepted.if,'success()');assert.equal(accepted.with.overwrite,'true');
 const failure=componentStages.jobs.acceptance.steps.find(step=>step.name?.startsWith('Preserve failed native diagnostics'));
 assert.equal(failure.if,'failure() || cancelled()');assert.ok(failure.with.name.includes('github.run_attempt'));
 assert.equal(failure.with.overwrite,undefined,'older failures must not be overwritten by a later successful retry');
 for(const key of ['delivery_artifact_id','delivery_artifact_digest']){
  const value=components.jobs['native-components'].with[key];
  for(const platform of ['arm64','intel','windows'])assert.ok(value.includes(`delivery_${platform}_${key.endsWith('_id')?'id':'digest'}`));
  assert.ok(componentStages.on.workflow_call.inputs[key]);
 }
 assert.match(componentStages.env.NORA_STAGE_OPTIONS,/deliveryArtifactId/);assert.match(componentStages.env.NORA_STAGE_OPTIONS,/deliveryArtifactDigest/);
 for(const job of Object.values(componentStages.jobs)){
  const check=job.steps.findIndex(step=>step.name==='Qualify product and verification handoff inputs before downloading');
  assert.ok(check>=0&&check<job.steps.findIndex(step=>step.uses==='actions/download-artifact@v4'));
 }
});

test('native component workers consume platform subsets while publication retains the complete original delivery',()=>{
 const prep=components.jobs['prepare-platform-inputs'],steps=prep.steps;
 assert.equal(prep.needs,'build-components');assert.equal(prep.if,undefined);
 assert.doesNotMatch(scripts({jobs:{prep}}),/package-release|package-component-update|electron-builder|npm run/);
 const split=steps.findIndex(step=>step.name==='Prepare platform-only inputs from the same complete delivery');
 assert.ok(split>steps.findIndex(step=>step.name==='Normalize the original or newly built component delivery'),'The immutable original is authenticated before platform transfer preparation');
 for(const [id,platform] of [['delivery-arm64','darwin-arm64'],['delivery-intel','darwin-x64'],['delivery-windows','win32-x64']]){
  const step=steps.find(step=>step.id===id);assert.equal(step.with.name,'nora-component-delivery-'+platform);assert.ok(step.with.path.includes('/'+platform+'/'));
 }
 for(const job of Object.values(componentStages.jobs)){
  assert.ok(!job.steps.some(step=>/unwrap-product/.test(step.run||'')));
  assert.equal(job.steps.find(step=>step.uses==='actions/download-artifact@v4').with['artifact-ids'],'${{ inputs.delivery_artifact_id }}');
 }
 assert.match(componentStages.env.NORA_STAGE_OPTIONS,/"platformDelivery":true/);
 assert.equal(componentStages.env.COMPONENT_DELIVERY,undefined,'Runner paths are resolved inside steps, not workflow-level env');
 assert.equal(components.jobs['accept-components'].steps.find(step=>step.uses==='actions/download-artifact@v4').with.name,'nora-component-delivery');
});

test('the earliest fixture audit rejects dangling steps and steps mixing commands with actions',()=>{
 for(const step of [{name:'forgotten command'},{name:'mixed',run:'node check.mjs',uses:'actions/checkout@v4'}])
  assert.throws(()=>assertFixturePrerequisites({jobs:{check:{'runs-on':'ubuntu-24.04',steps:[step]}}}),/exactly one run or uses/);
 assert.throws(()=>assertFixturePrerequisites({env:{INPUT:'${{ runner.temp }}'},jobs:{}}),/Runner context/);
 for(const [value,message] of [['${{ steps.missing.outputs.id }}',/missing step/],['${{ matrix.platform }}',/matrix strategy/]])
  assert.throws(()=>assertFixturePrerequisites({jobs:{check:{outputs:{input:value},steps:[{id:'actual',uses:'actions/checkout@v4'}]}}}),message);
});
