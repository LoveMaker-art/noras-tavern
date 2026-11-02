import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { COMPONENT_PLATFORMS, prepareComponentPayload, sealComponentAcceptance, verifyComponentNative, runComponentNative, runComponentCloud } from '../tooling/release/component-acceptance.mjs';
import { componentAcceptanceFixture } from './helpers/component-acceptance-fixture.mjs';
const { verifyComponentAcceptance } = createRequire(import.meta.url)('../tooling/release/publication-source.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-component-native-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, ...componentAcceptanceFixture(root) };
}

test('headless qualification consumes shared core bytes and rejects incomplete outcomes or another host',t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-cloud-qualification-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const delivery=path.join(root,'core'),baseline=path.join(root,'baseline'),hermesSource=path.join(root,'hermes');
    for(const folder of [delivery,baseline,hermesSource])fs.mkdirSync(folder);
    const commit='a'.repeat(40),archives={};
    for(const name of ['app','ops','nora-mcp']){
        const bytes=Buffer.from(name),file=`nora-tavern-${name}.tar.gz`;fs.writeFileSync(path.join(delivery,file),bytes);
        archives[name]={name:file,sha256:createHash('sha256').update(bytes).digest('hex')};
    }
    fs.writeFileSync(path.join(delivery,'release-manifest.json'),JSON.stringify({schema:'tavern-release/v2',commit,candidate:false,dirty:false,archives}));
    const expected={schema:'nora-cloud-component-acceptance/1',platform:'linux',targetCommit:commit,outcome:'passed',
        scenarios:['fresh','running','stopped','dependency-rebuild'].map(scenario=>({scenario,outcome:'passed',stop:'confirmed',executorHandles:'verified-closed',activeOwnedProcesses:[],installedCommit:commit,userData:'retained',worldAndChatRead:'verified'}))};
    let calls=0;
    const check=(result=expected,host='linux')=>runComponentCloud({delivery,baseline,hermesSource,commit,host,python:process.execPath,
        scratch:path.join(root,'attempt-'+calls),run:(_command,args)=>{
            calls++;assert.ok(args.includes('--hermes-source'));assert.ok(args.some(value=>value.endsWith('tests/deployment/cloud_component_acceptance.py')));
            assert.ok(fs.statSync(args[2]).isFile(), 'The actual Python actor must exist before qualification');
            const output=args[args.indexOf('--scratch')+1];fs.mkdirSync(output);fs.writeFileSync(path.join(output,'cloud-acceptance.json'),JSON.stringify(result));
        }});
    assert.equal(check().outcome,'passed');
    for(const mutate of [v=>v.outcome='failed',v=>v.scenarios[0].stop='unconfirmed',v=>v.scenarios[1].userData='changed',
        v=>v.scenarios[2].worldAndChatRead='unconfirmed',v=>v.scenarios[3].outcome='not-executed',v=>v.targetCommit='b'.repeat(40),v=>v.scenarios.pop(),
        v=>v.scenarios[0].executorHandles='unconfirmed',v=>v.scenarios[0].activeOwnedProcesses=[123]]){
        const bad=structuredClone(expected);mutate(bad);assert.throws(()=>check(bad));
    }
    const before=calls;assert.throws(()=>check(expected,'darwin'),/actual Linux/);assert.equal(calls,before);
    fs.appendFileSync(path.join(delivery,archives.app.name),'changed');assert.throws(()=>check(),/Changed cloud core/);assert.equal(calls,before);
});

test('headless fixture respects its shared deadline and closes an actual timed-out child',()=>{
    const script=path.resolve('tests/deployment/cloud_component_acceptance.py');
    const program=`import importlib.util,pathlib,sys,tempfile,time,psutil
spec=importlib.util.spec_from_file_location('cloud_fixture',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='nora-cloud-deadline-') as temp:
 fixture=module.Scenario.__new__(module.Scenario);fixture.root=pathlib.Path(temp);fixture.env={'PATH':str(pathlib.Path(sys.executable).parent)};fixture.report={'commands':[]};fixture.deadline=time.monotonic()
 try:fixture.command('expired',['-c','raise SystemExit(99)']);raise AssertionError('Expired fixture admitted a child')
 except RuntimeError as error:assert 'deadline exhausted' in str(error)
 assert not list(fixture.root.iterdir())
 children=[];original=module.subprocess.Popen
 def held(*args,**options):
  child=original(*args,**options);children.append(child);return child
 module.subprocess.Popen=held;fixture.deadline=time.monotonic()+180
 try:
  try:fixture.command('timeout',['-c','import time; time.sleep(30)'],timeout=0.05);raise AssertionError('Timed-out actor passed')
  except RuntimeError as error:assert 'owned children closed' in str(error)
  assert len(children)==1 and children[0].poll() is not None and not psutil.pid_exists(children[0].pid)
 finally:
  for child in children:
   if child.poll() is None:child.kill();child.wait(timeout=5)
print('actual fixture child closed; no expired actor admitted')`;
    const output=execFileSync(process.env.NORA_TEST_PYTHON||'python3',['-I','-B','-c',program,script],{encoding:'utf8',timeout:10000});
    assert.match(output,/actual fixture child closed/);
});
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
test('component publication accepts the actual multi-path upload layout without trusting the sidecar', async t => {
    const f = fixture(t);
    for (const platform of COMPONENT_PLATFORMS) {
        const reports = path.join(f.reports, `nora-component-native-${platform}`);
        const nested = path.join(reports, 'component-native-reports'); fs.mkdirSync(nested);
        for (const name of ['baseline-source-receipt.json', 'fresh', 'running', 'stopped'])
            fs.renameSync(path.join(reports, name), path.join(nested, name));
        fs.writeFileSync(path.join(reports, 'native-test-impact.json'), '{"full":false}');
    }
    await verifyComponentAcceptance(f.delivery, f.reports, f.planRoot, f.commit);
    const platform = COMPONENT_PLATFORMS[0], reports = path.join(f.reports, `nora-component-native-${platform}`);
    fs.renameSync(path.join(reports, 'component-native-reports/stopped'), path.join(reports, 'stopped'));
    await assert.rejects(verifyComponentAcceptance(f.delivery, f.reports, f.planRoot, f.commit));
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

function runnerFixture(t, platform) {
    // This contract uses a synthetic executor, not native binaries. Exercise
    // every supported target even when preflight itself is hosted on Linux.
    const [host, arch] = platform.split('-');
    t.mock.property(process, 'platform', host);
    t.mock.property(process, 'arch', arch);
    const f = fixture(t);
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
        const base = args[args.indexOf('--scratch-base') + 1], installed = path.join(base, 'products-smoke-fixture');
        f.write(installed, 'tavern/tavern-updates/installed.json', { version: '2.5.5' });
        const raw = JSON.parse(fs.readFileSync(path.join(f.reports, `nora-component-native-${platform}`, state, 'harness-result.json')));
        raw.root = fs.realpathSync(installed); f.write(installed, 'harness-result.json', raw);
    };
    return { ...f, payload, baseline, platform, reports, scratch, calls, run };
}

for (const platform of COMPONENT_PLATFORMS) {
test(`native ${platform} result collection does not treat installed runtime links as delivery inputs`, t => {
    const f = runnerFixture(t, platform);
    runComponentNative({ ...f, run: (...args) => {
        f.run(...args);
        const base = args[1][args[1].indexOf('--scratch-base') + 1];
        const installed = path.join(base, 'products-smoke-fixture'), runtime = path.join(installed, 'hermes/python');
        fs.mkdirSync(runtime, { recursive: true });
        fs.symlinkSync(runtime, path.join(installed, 'runtime-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } });
    assert.deepEqual(f.calls, ['fresh', 'running', 'stopped']);
    verifyComponentNative(f);
});

for (const change of ['duplicate root', 'linked root', 'linked result', 'foreign result root'])
test(`native ${platform} result collection rejects ${change}`, t => {
    const f = runnerFixture(t, platform);
    assert.throws(() => runComponentNative({ ...f, run: (...args) => {
        f.run(...args);
        const base = args[1][args[1].indexOf('--scratch-base') + 1], installed = path.join(base, 'products-smoke-fixture');
        const result = path.join(installed, 'harness-result.json');
        if (change === 'duplicate root') fs.mkdirSync(path.join(base, 'products-smoke-duplicate'));
        if (change === 'linked root') {
            fs.renameSync(installed, path.join(f.root, 'other-installation'));
            fs.symlinkSync(path.join(f.root, 'other-installation'), installed, process.platform === 'win32' ? 'junction' : 'dir');
        }
        if (change === 'linked result') {
            fs.renameSync(result, path.join(f.root, 'other-result.json'));
            fs.symlinkSync(path.join(f.root, 'other-result.json'), result, 'file');
        }
        if (change === 'foreign result root') {
            const raw = JSON.parse(fs.readFileSync(result)); raw.root = f.root; fs.writeFileSync(result, JSON.stringify(raw));
        }
    } }));
    assert.equal(fs.existsSync(path.join(f.reports, 'fresh/harness-result.json')), false);
    assert.equal(fs.existsSync(path.join(f.reports, 'running')), false);
});

test(`native component runner records all three original ${platform} results without an intermediate summary`, t => {
    const f = runnerFixture(t, platform); runComponentNative(f);
    assert.deepEqual(f.calls, ['fresh', 'running', 'stopped']);
    assert.deepEqual(fs.readdirSync(f.reports).sort(), ['baseline-source-receipt.json', 'fresh', 'running', 'stopped']);
    const accepted = verifyComponentNative(f); assert.deepEqual(Object.keys(accepted.reportSha256).sort(), ['fresh', 'running', 'stopped']);
});

test(`native component runner stops at ${platform} executor failure and incomplete results cannot be accepted`, t => {
    const f = runnerFixture(t, platform); let executions = 0;
    assert.throws(() => runComponentNative({ ...f, run: (...args) => {
        if (++executions === 2) throw new Error('fixture executor failed');
        f.run(...args);
    } }), /fixture executor failed/);
    assert.equal(executions, 2); assert.deepEqual(f.calls, ['fresh']);
    assert.throws(() => verifyComponentNative(f));
    assert.equal(fs.existsSync(path.join(f.reports, 'stopped')), false);
});
}

test('the real native runner still refuses an unsupported Linux host before invoking an executor', t => {
    t.mock.property(process, 'platform', 'linux');
    t.mock.property(process, 'arch', 'x64');
    let executions = 0;
    assert.throws(() => runComponentNative({ run: () => { executions++; } }), /COMPONENT_PLATFORMS/);
    assert.equal(executions, 0);
});

test('revalidation receipt distinguishes product and verifier and still consumes every raw native result',async t=>{
    const f=fixture(t);fs.unlinkSync(f.output);
    const verifier='c'.repeat(40),source={schema:'nora-component-product/1',repository:'owner/tavern',productCommit:f.commit,productRun:123,
        producer:{id:20,attempt:1},artifacts:[],tag:f.tag,verificationCommit:verifier};
    const receipt=sealComponentAcceptance({delivery:f.delivery,reports:f.reports,plan:f.plan,output:f.output,commit:f.commit,tag:f.tag,
        productSource:source,verificationCommit:verifier});
    assert.equal(receipt.schema,'nora-component-acceptance/3');assert.equal(receipt.commit,f.commit);
    assert.deepEqual(receipt.qualification,{commit:verifier,productSource:source});
    await assert.rejects(verifyComponentAcceptance(f.delivery,f.reports,f.planRoot,f.commit));
    const expected={commit:verifier,productSource:source};
    assert.equal((await verifyComponentAcceptance(f.delivery,f.reports,f.planRoot,f.commit,expected)).outcome,'passed');
    await assert.rejects(verifyComponentAcceptance(f.delivery,f.reports,f.planRoot,f.commit,{...expected,commit:'d'.repeat(40)}));
    const file=path.join(f.reports,'nora-component-native-win32-x64/stopped/harness-result.json');
    const value=JSON.parse(fs.readFileSync(file));value.userData='changed';fs.writeFileSync(file,JSON.stringify(value));
    await assert.rejects(verifyComponentAcceptance(f.delivery,f.reports,f.planRoot,f.commit,expected));
});
