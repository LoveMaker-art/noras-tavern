// Inspect real release callers without importing tests or starting their actors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceTestGroups } from './verify-launcher-stability.mjs';
import { verifyBackupSafety } from './verify-backup-safety.mjs';
import { runFocusedRegression } from './launcher-test-impact.mjs';
import { noraContractFiles } from '../../app/engine/sillytavern/tests/run-nora-contracts.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const python = () => process.env.NORA_WORKFLOW_YAML_PYTHON || process.env.NORA_TEST_PYTHON || 'python3';
const workflows = ['build-integrated-launcher.yml', 'publish-component-update.yml', 'publish-accepted-release.yml'];

export function missingPythonTests(references, root = repository) {
    const program = `import ast,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);missing=[]
for reference in json.load(sys.stdin):
 parts=reference.split('.');file=root.joinpath(*parts[:3]).with_suffix('.py')
 try: node=ast.parse(file.read_text(encoding='utf-8'))
 except (OSError,SyntaxError) as error:
  missing.append({'reference':reference,'reason':type(error).__name__});continue
 for member in parts[3:]:
  found=next((value for value in node.body if isinstance(value,(ast.ClassDef,ast.FunctionDef,ast.AsyncFunctionDef)) and value.name==member),None)
  if found is None:
   missing.append({'reference':reference,'reason':'missing member '+member});break
  node=found
print(json.dumps(missing))`;
    return JSON.parse(execFileSync(python(), ['-B', '-c', program, root],
        { input: JSON.stringify([...references]), encoding: 'utf8', timeout: 30000 }));
}

export function assertFixturePrerequisites(workflow) {
    for(const value of Object.values(workflow.env||{}))
        assert.ok(!String(value).includes('${{')||!/\brunner\./.test(value),'Runner context is unavailable in workflow-level env');
    for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
        const steps = job.steps || [], scripts = steps.map(step => step.run || '');
        for(const step of steps)assert.ok(Boolean(step.run)!==Boolean(step.uses),`${jobName}: each step needs exactly one run or uses entry`);
        const ids=new Set(steps.map(step=>step.id).filter(Boolean));
        for(const value of Object.values(job.outputs||{})){
            for(const match of String(value).matchAll(/\bsteps\.([\w-]+)\.outputs\./g))
                assert.ok(ids.has(match[1]),`${jobName}: output references a missing step: ${match[1]}`);
            if(/\bmatrix\./.test(value))assert.ok(job.strategy?.matrix,`${jobName}: matrix output needs a matrix strategy`);
        }
        // A concrete Linux worker cannot exercise the desktop bridge. Variable
        // native workers remain qualified by their actual runtime prerequisite.
        if (String(job['runs-on']).startsWith('ubuntu'))
            assert.ok(!scripts.some(script => /tests\.deployment\.test_launcher_update_recovery\b/.test(script)),
                `${jobName}: desktop recovery fixture on a Linux worker`);
        const consumer = scripts.findIndex(script => /verify-launcher-stability\.mjs/.test(script));
        if (consumer >= 0) assert.ok(scripts.some((script, index) => index < consumer
            && /npm ci --prefix app\/engine\/sillytavern\b/.test(script)),
        `${jobName}: locked engine dependencies must precede their recovery consumers`);
    }
}

export function auditReleaseFixtures({ root = repository, loaded } = {}) {
    const parsed = loaded ? [...loaded] : [], pending = loaded ? [] : [...workflows];
    const seen = new Set(parsed.map(item => item.name));
    for(const {workflow} of parsed)for(const job of Object.values(workflow.jobs||{}))
        if(job.uses?.startsWith('./.github/workflows/'))pending.push(job.uses.slice('./.github/workflows/'.length));
    while (pending.length) {
        const name=pending.shift(); if (seen.has(name)) continue; seen.add(name);
        assert.match(name, /^[A-Za-z0-9_-]+\.yml$/);
        const workflow=JSON.parse(execFileSync(python(), ['-B', '-c',
            'import json,sys,yaml;print(json.dumps(yaml.load(open(sys.argv[1]),Loader=yaml.BaseLoader)))',
            path.join(root, '.github/workflows', name)], { encoding: 'utf8', timeout: 30000 }));
        parsed.push({name,workflow});
        for (const job of Object.values(workflow.jobs)) if (job.uses?.startsWith('./.github/workflows/'))
            pending.push(job.uses.slice('./.github/workflows/'.length));
    }
    const files = new Set(), references = new Set(), scripts = new Set();
    for (const { workflow } of parsed) {
        assertFixturePrerequisites(workflow);
        const text = Object.values(workflow.jobs).flatMap(job => job.steps || []).map(step => step.run || '').join('\n').replaceAll('$PWD/', '');
        // Follow the existing npm entry rather than silently omitting its globs
        // and dynamically discovered contracts from the release caller audit.
        if (/npm --prefix app\/engine\/sillytavern run test:nora\b/.test(text)) {
            const engine='app/engine/sillytavern', directory=path.join(root,engine);
            const manifest=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
            const pending=['test:nora'], seenScripts=new Set();
            while(pending.length){
                const name=pending.shift();if(seenScripts.has(name))continue;seenScripts.add(name);
                const command=manifest.scripts?.[name];assert.ok(command,`Missing engine npm script ${name}`);
                for(const match of command.matchAll(/\bnpm run ([\w:-]+)/g))pending.push(match[1]);
                for(const match of command.matchAll(/(?:tests|build)\/[\w./*-]+\.(?:mjs|cjs|js)/g)){
                    const pattern=match[0], found=pattern.includes('*')?fs.globSync(pattern,{cwd:directory}):[pattern];
                    assert.ok(found.length,`Empty release test glob ${pattern}`);
                    for(const file of found){scripts.add(`${engine}/${file}`);if(file.startsWith('tests/'))files.add(`${engine}/${file}`);}
                    if(pattern==='tests/run-nora-contracts.mjs')for(const file of noraContractFiles(path.join(directory,'tests')))
                        files.add(`${engine}/tests/${file}`);
                }
            }
        }
        for (const match of text.matchAll(/(?<![\w./])(?:app\/engine\/sillytavern\/tests|nora-mcp\/tests|story-profile\/tests|tests)\/[\w./-]+\.(?:mjs|cjs|js|py)/g)) files.add(match[0]);
        for (const match of text.matchAll(/\btests\.deployment\.[A-Za-z_][\w.]*/g)) references.add(match[0]);
        const entries=text.replaceAll('$env:GITHUB_WORKSPACE/','').replaceAll('$GITHUB_WORKSPACE/','')
            .replaceAll('${GITHUB_WORKSPACE}/','').replaceAll('${{ github.workspace }}/','');
        for(const match of entries.matchAll(/(?<![\w./])(?:\.\/)?((?:tooling|tests|deployment|launcher|nora|nora-mcp|story-profile|app)\/[\w./-]+\.(?:mjs|cjs|js|py|ps1|sh|applescript|cmd|bat))(?![\w.-])/g)){
            const file=match[1];
            if(file.includes('/node_modules/')||/^(?:nora-mcp|launcher\/desktop)\/dist\//.test(file))continue;
            assert.ok(!file.split('/').includes('..'),'Unsafe authored script reference');scripts.add(file);
        }
    }
    for (const platform of ['darwin', 'win32', 'linux']) {
        const group = sourceTestGroups(platform);
        for (const file of group.javascript) files.add(`tests/deployment/${file}`);
        for (const module of group.python) references.add(`tests.deployment.${module}`);
        runFocusedRegression({root,platform,impact:{full:false,productBuild:true,ui:true,content:true},
            checkEnvironment:()=>({environment:process.env}),run:(_command,args)=>{
                for (const value of args) {
                    if (value.endsWith('.test.cjs')) files.add(path.relative(root,value).split(path.sep).join('/'));
                    if (value.startsWith('tests.deployment.')) references.add(value);
                }
                return {status:0};
            }});
    }
    verifyBackupSafety({ root, run: (_command, args, options) => {
        for (const file of args.filter(value => value.startsWith('tests/'))) files.add(path.relative(root, path.resolve(options.cwd, file)).split(path.sep).join('/'));
        return { status: 0 };
    } });
    assert.ok(files.size && references.size, 'An empty audit is not release qualification');
    assert.deepEqual([...files].filter(file => !fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()), [],
        'A release caller references a missing test file');
    assert.deepEqual([...scripts].filter(file => !fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()), [],
        'A release caller references a missing authored script');
    assert.deepEqual(missingPythonTests(references, root), [], 'A release caller references a missing Python test');
    return { schema: 'nora-release-fixtures/1', workflows: parsed.map(item => item.name),
        files: [...files].sort(), scripts:[...scripts].sort(), python: [...references].sort(),
        historical: ['tests/deployment/fixtures/published-v2.4.4', 'tests/deployment/fixtures/clawchat-greeting-before'],
        scope: 'entry identities and prerequisite ordering; not a passed product or native acceptance' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(JSON.stringify(auditReleaseFixtures(), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
