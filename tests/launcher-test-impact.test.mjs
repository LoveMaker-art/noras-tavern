import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { selectTestImpact, runFocusedRegression } from '../tooling/checks/launcher-test-impact.mjs';

function fixture(paths) {
    const baseline = { contextVerified: true, sourceModes: {}, configuration: { launcher: { version: '2.2.6', dependencies: { semver: '7.8.5' } } } };
    const current = structuredClone(baseline);
    const plan = { initialRelease: false, requiresReview: false, mode: 'launcher',
        changed: paths.map(file => ({ path: file, roles: ['launcher'] })), build: { environment: {} } };
    return { baseline, current, plan };
}

test('known UI and content changes select their union and retain the mandatory maintenance floor', () => {
    const value = selectTestImpact(fixture(['launcher/ui/launcher-controller.js', 'nora/greeting.md',
        'app/engine/sillytavern/public/scripts/nora-home.js']));
    assert.equal(value.full, false);
    assert.equal(value.ui, true); assert.equal(value.content, true); assert.equal(value.tavern, true);
    assert.deepEqual(value.requiredNative, ['fresh-install', 'upgrade-running', 'upgrade-stopped', 'failure-recovery', 'task-finished', 'user-data', 'package-identity']);
    for (const name of ['launcher_uninstall.test.cjs', 'launcher_runtime.test.cjs', 'launcher_update_executor.test.cjs'])
        assert.ok(value.minimum.javascript.includes(name), name);
    for (const name of ['test_first_install', 'test_update_target', 'test_update_operation_safety'])
        assert.ok(value.minimum.python.includes(name), name);
});

test('maintenance, persistence, unknown inputs and changed environments always require the complete group', () => {
    for (const file of ['launcher/desktop/main.js', 'deployment/update/update.py', 'deployment/uninstall/uninstall.js',
        'deployment/shared/runtime_process.py', 'launcher/desktop/runtime.js', 'story-profile/core/storage.py',
        'app/engine/sillytavern/src/nora-world-core/worlds.mjs', 'nora/AGENTS.md', 'unclassified/new-file.js']) {
        assert.equal(selectTestImpact(fixture([file])).full, true, file);
    }
    for (const mutate of [f => { f.baseline = null; }, f => { f.plan.requiresReview = true; },
        f => { f.current.contextVerified = false; }, f => { f.plan.build.environment.hermesRuntime = ['win32-x64']; },
        f => { f.baseline.sourceModes = null; }]) {
        const value = fixture(['launcher/ui/index.html']); mutate(value);
        assert.equal(selectTestImpact(value).full, true);
    }
});

test('a version-only APP manifest and lock do not make an otherwise focused UI change full', () => {
    const f = fixture(['launcher/ui/index.html', 'launcher/desktop/package.json', 'launcher/desktop/package-lock.json', 'app/.tavern-release-version']);
    f.current.configuration.launcher.version = '2.2.7';
    assert.equal(selectTestImpact(f).full, false);
    f.current.configuration.launcher.dependencies.semver = 'changed';
    assert.equal(selectTestImpact(f).full, true, 'Different production inputs cannot use the version-only exemption');
    const lock = fixture(['launcher/desktop/package-lock.json']);
    lock.plan.changed[0].roles.push('launcher-dependencies');
    assert.equal(selectTestImpact(lock).full, true);
});

test('changed tests and release tooling do not inherit a narrow UI-only qualification', () => {
    for (const file of ['tests/deployment/launcher_uninstall.test.cjs', 'tooling/checks/launcher-test-impact.mjs', '.github/workflows/build-integrated-launcher.yml'])
        assert.equal(selectTestImpact(fixture(['launcher/ui/index.html', file])).full, true, file);
    const docs = fixture(['docs/install.md']); docs.plan.mode = 'verification-only';
    assert.equal(selectTestImpact(docs).full, false);
    assert.equal(selectTestImpact(docs).productBuild, false);
});

test('focused execution uses whole existing files once, stops on failure and refuses a full selection', () => {
    const impact=selectTestImpact(fixture(['launcher/ui/index.html','nora/greeting.md']));
    const calls=[],options={impact,checkEnvironment:()=>({environment:process.env}),run:(command,args,opts)=>{
        calls.push({command,args,opts});return {status:0};
    }};
    runFocusedRegression(options);assert.equal(calls.length,2);
    assert.ok(calls.every(call=>call.command===process.execPath&&!call.args.some(arg=>/--skip|--test-name-pattern/.test(arg))));
    const files=calls[0].args.filter(arg=>arg.endsWith('.test.cjs'));
    assert.equal(new Set(files).size,files.length);assert.ok(files.every(file=>path.isAbsolute(file)&&fs.existsSync(file)));
    assert.ok(calls[1].args.includes('tests.deployment.test_greeting_template'));
    let runs=0;
    assert.throws(()=>runFocusedRegression({...options,run:()=>{runs++;return {status:1};}}),/Selected regression failed/);
    assert.equal(runs,1);
    for(const result of [{status:null,signal:'SIGKILL'},{error:new Error('fixture deadline')}])
        assert.throws(()=>runFocusedRegression({...options,run:()=>result}));
    assert.throws(()=>runFocusedRegression({...options,impact:{...impact,full:true}}),/complete regression/);
    assert.throws(()=>runFocusedRegression({...options,checkEnvironment:()=>{throw Error('missing prerequisite');}}),/missing prerequisite/);
});

test('the real CLI binds selection to committed source and refuses a mismatched or dirty checkout', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-test-impact-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
    git('init', '-q'); git('config', 'user.name', 'Test fixture'); git('config', 'user.email', 'fixture@example.invalid');
    const write = (file, text) => { const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text); };
    write('tooling/source-layout.json', JSON.stringify({ schema: 1, rules: [['launcher/ui/', 'ops/installer/']] }));
    write('launcher/desktop/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', build: { files: [], extraResources: [] } }));
    write('launcher/ui/index.html', 'old'); git('add', '.'); git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    write('launcher/ui/index.html', 'new'); git('add', '.'); git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'head');
    const head = git('rev-parse', 'HEAD'), output = path.join(root, 'impact.json'), github = path.join(root, 'github-output');
    const script = path.resolve('tooling/checks/launcher-test-impact.mjs');
    const run = (extra=[]) => spawnSync(process.execPath, [script, '--repo', root, '--base', base, '--head', head,
        '--output', output, '--github-output', github, ...extra], { encoding:'utf8' });
    assert.equal(run().status, 0); const value = JSON.parse(fs.readFileSync(output));
    assert.equal(value.source.commit, head); assert.equal(value.baseline.commit, base);
    assert.equal(value.full, false); assert.match(fs.readFileSync(github,'utf8'), /full=false/);
    assert.notEqual(run().status, 0, 'A retained selection cannot be overwritten');
    fs.unlinkSync(output);assert.equal(run(['--force-full','true']).status,0);
    assert.equal(JSON.parse(fs.readFileSync(output)).full,true,'Periodic/manual full regression may only add coverage');
    fs.unlinkSync(output); write('launcher/ui/index.html', 'uncommitted');
    assert.notEqual(run().status, 0, 'Dirty bytes cannot borrow the committed selection');
    assert.equal(fs.existsSync(output), false);
    git('checkout', '--', 'launcher/ui/index.html');
    const missingEnvironment = run(['--run-focused']);
    assert.equal(missingEnvironment.status, 2, 'Missing prerequisites retain the test-environment exit code');
    assert.match(missingEnvironment.stderr, /Launcher test environment/);
    assert.equal(fs.existsSync(output), false, 'A prerequisite failure cannot emit successful qualification');
    const wrong = spawnSync(process.execPath, [script,'--repo',root,'--base',base,'--head',base,'--output',output],{encoding:'utf8'});
    assert.notEqual(wrong.status,0,'Another source commit cannot qualify this checkout');
});
