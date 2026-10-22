import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { test } from 'node:test';
import { readLayout, translatePath, deliveryEntries, projectDelivery } from '../tooling/layout.mjs';
import { createReleaseSource, digest, assertNoraSystemArtifacts } from '../tooling/release/release-source.mjs';
import { RELEASE_SOURCE_ENTRY_PATHS } from '../tooling/release/embed-release-sources.mjs';
import {captureChild, firstJsonLine, stopChild} from './deployment/launcher_test_lifecycle.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = readLayout(root);

test('desktop dependency manager is determined by one npm lockfile', () => {
    const desktop = path.join(root, 'launcher/desktop');
    const managerLocks = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);
    assert.deepEqual(fs.readdirSync(desktop).filter(name => managerLocks.has(name)).sort(), ['package-lock.json']);
    const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(desktop, 'package-lock.json'), 'utf8'));
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.packages[''].name, pkg.name);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
    assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
});

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

test('candidate projection preserves authored fingerprints and seals generated entry bytes', t => {
    const exported = createReleaseSource(root, { candidate: true });
    t.after(() => fs.rmSync(exported.stage, { recursive: true, force: true }));
    // Source projection does not install generated updater dependencies. The
    // full-system guard must reject exactly those absent build outputs; actual
    // dependency preparation and final delivery are covered by package tests.
    assert.throws(() => assertNoraSystemArtifacts(exported.files), {
        message: 'Incomplete Nora system artifacts: ' + ['receipt.json', 'package.json', 'package-lock.json']
            .map(name => `ops/updater/actor-dependencies/${name}`).join(', '),
    });
    const receipt = exported.identity.generatedSourceFiles;
    const generated = new Map(receipt.files.map(file => [file.path, file]));
    const entries = deliveryEntries(Object.keys(exported.identity.sourceFiles), rules);
    for (const [source, delivery] of entries) {
        const output = generated.get(source);
        assert.equal(digest(fs.readFileSync(path.join(exported.stage, delivery))),
            output?.afterSha256 || exported.identity.sourceFiles[source], source);
        if (output) assert.equal(output.beforeSha256, exported.identity.sourceFiles[source]);
    }
    for (const file of ['nora/SOUL.md', 'nora/AGENTS.md', 'nora/greeting.md', 'launcher/ui/index.html', 'launcher/ui/assets/nora-launcher-portrait.png',
        'nora/skills/system/model-provider-config/SKILL.md', 'nora/skills/system/model-provider-config/scripts/configure_provider.py']) {
        assert.ok(exported.identity.sourceFiles[file], file);
    }
    assert.equal(exported.files.includes('nora/SOUL.md'), false, 'No second delivery copy');
    assert.equal(receipt.schema, 'nora-embedded-release-sources/1');
});

function distributionFixture(t, configuration) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-layout-sources-'));
    t.after(() => fs.rmSync(fixture, {recursive: true, force: true}));
    const files = [...RELEASE_SOURCE_ENTRY_PATHS.map(paths => paths[0]), 'tooling/source-layout.json',
        'tooling/release/embed-release-sources.mjs', 'launcher/desktop/release-sources.json',
        'launcher/desktop/release-sources.js', 'launcher/desktop/launcher-errors.js', 'launcher/desktop/telemetry-contract.json'];
    for (const relative of files) {
        fs.mkdirSync(path.dirname(path.join(fixture, relative)), {recursive: true});
        fs.copyFileSync(path.join(root, relative), path.join(fixture, relative));
    }
    if (configuration) fs.writeFileSync(path.join(fixture, 'launcher/desktop/release-sources.json'), JSON.stringify(configuration));
    const git = args => execFileSync('git', args, {cwd: fixture, stdio: 'pipe'});
    git(['init']); git(['add', '.']);
    git(['-c', 'user.name=Source Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    return fixture;
}

const alternateSources = {schema: 1, primary: 'jihulab', mirrors: [{id: 'jihulab', provider: 'jihulab',
    baseUrl: 'https://jihulab.com/api/v4/projects/123/packages/generic/nora-tavern/',
    channelBaseUrl: 'https://jihulab.com/fixture/nora/-/raw/release-channels/'}]};

for (const candidate of [false, true]) {
    test(`${candidate ? 'candidate' : 'stable'} export records generated source bytes separately from authored hashes`, t => {
        const fixture = distributionFixture(t, candidate ? null : alternateSources);
        const configuration = path.join(fixture, 'launcher/desktop/release-sources.json');
        if (candidate) fs.writeFileSync(configuration, JSON.stringify(alternateSources));
        const exported = createReleaseSource(fixture, {candidate});
        t.after(() => fs.rmSync(exported.stage, {recursive: true, force: true}));
        const receipt = exported.identity.generatedSourceFiles;
        assert.equal(receipt.schema, 'nora-embedded-release-sources/1');
        assert.equal(receipt.configurationSha256, exported.identity.sourceFiles[receipt.configurationPath]);
        assert.equal(receipt.configurationDeliveryPath, 'ops/installer/desktop/release-sources.json');
        assert.equal(receipt.files.length, 6);
        assert.ok(receipt.files.every(file => file.changed));
        for (const file of receipt.files) {
            assert.equal(file.beforeSha256, exported.identity.sourceFiles[file.path], file.path);
            assert.equal(file.beforeSha256, digest(fs.readFileSync(path.join(fixture, file.path))), 'Checkout stays authored');
            assert.notEqual(file.beforeSha256, file.afterSha256);
            const generated = fs.readFileSync(path.join(exported.stage, file.deliveryPath));
            assert.equal(file.afterSha256, digest(generated), file.deliveryPath);
            assert.equal(file.afterSize, generated.length);
            assert.ok(generated.toString('utf8').includes(JSON.stringify(alternateSources)));
        }
        assert.equal(exported.identity.sourceDigest, digest(JSON.stringify(exported.identity.sourceFiles)));
        assert.ok(exported.files.includes('ops/scripts/embed-release-sources.mjs'));
        const result = spawnSync(process.execPath, ['ops/scripts/embed-release-sources.mjs', '--check'],
            {cwd: exported.stage, encoding: 'utf8', timeout: 10000});
        assert.equal(result.status, 0, result.stderr);
        assert.ok(JSON.parse(result.stdout).files.every(file => !file.changed), 'Projected build helper stays executable and idempotent');
    });
}

test('private acceptance reports never enter stable or candidate source identities',t=>{
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'nora-layout-evidence-'));
    t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
    fs.mkdirSync(path.join(fixture,'tooling'));fs.mkdirSync(path.join(fixture,'outputs'));
    fs.writeFileSync(path.join(fixture,'tooling/source-layout.json'),JSON.stringify({schema:1,rules:[['source.js','app/source.js']]}));
    fs.writeFileSync(path.join(fixture,'source.js'),'module.exports=1;');
    const report=path.join(fixture,'outputs/report.json');fs.writeFileSync(report,'{"private":"fixture"}');
    const git=args=>execFileSync('git',args,{cwd:fixture,stdio:'pipe'});
    git(['init']);git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
    const stable=createReleaseSource(fixture);
    t.after(()=>fs.rmSync(stable.stage,{recursive:true,force:true}));
    assert.equal(fs.existsSync(path.join(stable.stage,'outputs')),false);
    assert.equal(stable.identity.sourceFiles['outputs/report.json'],undefined);
    assert.equal(stable.identity.generatedSourceFiles, undefined, 'Unrelated source fixtures do not need a distribution config');
    const before=createReleaseSource(fixture,{candidate:true});
    t.after(()=>fs.rmSync(before.stage,{recursive:true,force:true}));
    fs.writeFileSync(report,'{"private":"changed fixture"}');
    const after=createReleaseSource(fixture,{candidate:true});
    t.after(()=>fs.rmSync(after.stage,{recursive:true,force:true}));
    assert.equal(before.identity.sourceDigest,after.identity.sourceDigest);
    assert.equal(fs.existsSync(path.join(after.stage,'outputs')),false);
    assert.equal(fs.readFileSync(report,'utf8'),'{"private":"changed fixture"}');
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

for (const mode of ['success', 'failure', 'watch', 'absolute']) {
    test(`developer runner maps source arguments and cleans its own export: ${mode}`, () => {
        const code = `
            const fs = require('node:fs');
            if (!fs.existsSync('ops/installer/templates/SOUL.md')) process.exit(90);
            if (process.argv[1] !== 'ops/installer/desktop') process.exit(91);
            console.log(JSON.stringify({ stage: process.cwd() }));
            process.exit(${mode === 'failure' ? 17 : 0});
        `;
        const result = spawnSync(process.execPath, ['tooling/run.mjs', ...(mode === 'watch' ? ['--watch'] : []),
            'node', '-e', code, mode === 'absolute' ? path.join(root, 'launcher/desktop') : 'launcher/desktop'], { cwd: root, encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, mode === 'failure' ? 17 : 0, result.stderr);
        const { stage } = JSON.parse(result.stdout.trim());
        assert.notEqual(stage, root);
        assert.equal(fs.existsSync(stage), false);
        assert.ok(fs.existsSync(path.join(root, 'nora/SOUL.md')));
    });
}

test('cancelling a TERM-resistant source test waits for forced child close before removing its export',
    {timeout:45000, skip:process.platform === 'win32'}, async t => {
    const code=`process.on('SIGTERM',()=>{}); console.log(JSON.stringify({stage:process.cwd(),pid:process.pid})); setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['tooling/run.mjs','node','-e',code],{cwd:root,stdio:['ignore','pipe','pipe']});
    const captured=captureChild(child);
    t.after(async()=>{await stopChild(child,{graceMs:6000,timeoutMs:12000});});
    // Export/startup uses the same 30 s preparation bound as the mapping tests;
    // cancellation still has its separate unchanged 12 s close deadline.
    const facts=await firstJsonLine(child,{timeoutMs:30000});
    assert.notEqual(facts.stage,root);assert.ok(fs.existsSync(facts.stage));
    assert.equal(child.kill('SIGTERM'),true);
    let timer;
    try {
        const result=await Promise.race([captured.closed,new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(Error('Source runner cancellation did not close')),12000);
        })]);
        assert.equal(result.code,130);assert.equal(result.signal,null);
        assert.equal(captured.didClose,true);assert.equal(fs.existsSync(facts.stage),false,captured.stderr);
    } finally {clearTimeout(timer);}
});

test('a source child that accepts cancellation and exits zero cannot make an interrupted runner pass',
    {timeout:45000,skip:process.platform==='win32'},async t=>{
    const code=`process.on('SIGTERM',()=>process.exit(0));console.log(JSON.stringify({stage:process.cwd()}));setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['tooling/run.mjs','node','-e',code],{cwd:root,stdio:['ignore','pipe','pipe']});
    const captured=captureChild(child);t.after(()=>stopChild(child,{graceMs:6000,timeoutMs:12000}));
    const {stage}=await firstJsonLine(child,{timeoutMs:30000});child.kill('SIGTERM');
    let timer;
    try {
        const result=await Promise.race([captured.closed,new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(Error('Cooperative source cancellation did not close')),12000);
        })]);
        assert.equal(result.code,130);assert.equal(result.signal,null);assert.equal(fs.existsSync(stage),false);
    } finally {clearTimeout(timer);}
});

test('the internal test deadline cancels a held child and retains the export on every platform',
    {timeout:35000},async t=>{
    const code=`process.on('SIGTERM',()=>{});console.log(JSON.stringify({stage:process.cwd()}));setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['tooling/run.mjs','--timeout-ms','15000','node','-e',code],{cwd:root,stdio:['ignore','pipe','pipe']});
    const captured=captureChild(child);let stage;
    t.after(async()=>{
        await stopChild(child,{graceMs:8000,timeoutMs:12000});
        // This controlled child cannot fork; after the wrapper confirms close
        // its intentionally retained export is safe to remove for this test.
        if(stage&&captured.didClose&&captured.result.code===130&&captured.stderr.includes('held child closed=true'))
            fs.rmSync(stage,{recursive:true,force:true});
    });
    ({stage}=await firstJsonLine(child,{timeoutMs:20000}));
    let timer;
    try {
        const result=await Promise.race([captured.closed,new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(Error('Internal source deadline did not close')),30000);
        })]);
        assert.equal(result.code,130);assert.equal(result.signal,null);
        assert.match(captured.stderr,/Source test deadline exceeded/);assert.match(captured.stderr,/held child closed=true/);
        assert.equal(fs.existsSync(stage),true,'A deadline cannot prove all possible descendant actors closed');
    } finally {clearTimeout(timer);}
});

test('invalid or overflowing internal timeouts fail before a projected worker is created',()=>{
    for(const value of ['0','invalid','2147483648']){
        const result=spawnSync(process.execPath,['tooling/run.mjs','--timeout-ms',value,'node','-e',
            "console.log('unexpected-worker')"],{cwd:root,encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});
        assert.notEqual(result.status,0);assert.match(result.stderr,/within 1\.\.2147483647 ms/);
        assert.equal(result.stdout,'');assert.doesNotMatch(result.stderr,/TimeoutOverflowWarning/);
    }
});
