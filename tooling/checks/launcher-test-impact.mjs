// Test selection only. Artifact provenance and native product acceptance remain mandatory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReleasePlan, readGitSnapshot } from '../release/release-plan.mjs';
import { checkLauncherTestEnvironment } from './launcher-test-environment.mjs';

const rootPath = fileURLToPath(new URL('../../', import.meta.url));
const minimum = {
    javascript: ['launcher_operation_result.test.cjs', 'launcher_runtime.test.cjs',
        'launcher_update_executor.test.cjs', 'launcher_uninstall.test.cjs'],
    python: ['test_first_install', 'test_update_target', 'test_update_operation_safety'],
};
const withoutVersion = value => { const copy=structuredClone(value || {});delete copy.version;return copy; };

export function selectTestImpact({ baseline, current, plan }) {
    assert.ok(plan?.changed && plan.build?.environment, 'A source release plan is required');
    const reasons = [], flags = { full:false, ui:false, content:false, tavern:false };
    const full = (file, reason) => { flags.full=true;reasons.push({path:file,reason}); };
    if (!baseline || plan.initialRelease || plan.requiresReview || !baseline.contextVerified || !current.contextVerified
        || !baseline.sourceModes || !current.sourceModes) full('@baseline', 'Missing, unknown or unverified comparison requires complete regression');
    if (Object.values(plan.build.environment).some(values => values.length)) full('@environment', 'Runtime or dependency construction changed');
    for (const item of plan.changed) {
        const file=item.path;
        if (item.roles.some(role => ['build-input','environment','dependencies','launcher-dependencies'].includes(role))) {
            full(file,'Shared construction, environment or dependency input'); continue;
        }
        if (file.startsWith('docs/') || ['README.md','CONTRIBUTING.md','LICENSE','.gitignore','.gitattributes'].includes(file)) continue;
        if (file==='app/.tavern-release-version' || /^tooling\/release\/compatibility\/[\w.-]+\.json$/.test(file)) {
            reasons.push({path:file,reason:'Release metadata retains distribution and actual native transition checks'});continue;
        }
        if (file==='launcher/desktop/package.json') {
            // Only the version is exempt; nested build/dependency inputs remain significant.
            if (JSON.stringify(withoutVersion(baseline?.configuration?.launcher))!==JSON.stringify(withoutVersion(current.configuration?.launcher)))
                full(file,'APP manifest contains more than a version change');
            continue;
        }
        if (file==='launcher/desktop/package-lock.json') {
            // createReleasePlan already proves exact lock equivalence, except its two version labels.
            if (!item.roles.includes('launcher')) full(file,'Dependency lock equivalence is not established');
            continue;
        }
        if (['launcher/ui/index.html','launcher/ui/launcher-controller.js'].includes(file) || file.startsWith('launcher/ui/assets/')) {
            flags.ui=true;reasons.push({path:file,reason:'Launcher presentation and existing interaction contracts'});continue;
        }
        if (['nora/SOUL.md','nora/greeting.md'].includes(file)) {
            flags.content=true;reasons.push({path:file,reason:'Managed Nora content, template installation and customization'});continue;
        }
        if (file.startsWith('app/engine/sillytavern/public/') || file.startsWith('app/native-extensions/nora-ui/')) {
            flags.tavern=true;reasons.push({path:file,reason:'Tavern frontend plus existing backup and native product checks'});continue;
        }
        full(file,'Maintenance, persisted data, test qualification or other input without a proven narrow boundary');
    }
    return {schema:'nora-test-impact/1',...flags,productBuild:plan.mode!=='verification-only',reasons,
        minimum:structuredClone(minimum),
        requiredNative:['fresh-install','upgrade-running','upgrade-stopped','failure-recovery','task-finished','user-data','package-identity'],
        acceptanceReuse:'Only the existing accepted-artifact consumers may establish reusable acceptance; exclusion is not a passed test'};
}

export function runFocusedRegression({ root=rootPath, impact, run=spawnSync, checkEnvironment=checkLauncherTestEnvironment }={}) {
    assert.equal(impact.full,false,'A complete regression cannot be replaced by focused checks');
    assert.equal(impact.productBuild,true,'Verification-only changes do not require product regression');
    const {environment}=checkEnvironment({root,profile:'source'});
    const javascript=[...minimum.javascript,...(impact.ui?['launcher_guidance_flow.test.cjs','launcher_recovery_route.test.cjs']:[])];
    const python=[...minimum.python,...(impact.content?['test_greeting_template','test_nora_profile','test_nora_system']:[])];
    const jsTimeout=process.platform==='win32'||process.platform==='darwin'&&process.arch==='x64'?900000:240000;
    const pyTimeout=process.platform==='win32'?480000:240000;
    for (const [args,timeout] of [
        [['node','--test','--test-concurrency=1',...javascript.map(name=>path.join(root,'tests/deployment',name))],jsTimeout],
        [['python','-B','-m','unittest',...python.map(name=>'tests.deployment.'+name)],pyTimeout],
    ]) {
        const result=run(process.execPath,[path.join(root,'tooling/run.mjs'),'--timeout-ms',String(timeout-15000),...args],
            {cwd:root,env:environment,stdio:'inherit',timeout,killSignal:'SIGTERM'});
        if(result.error)throw result.error;
        assert.ok(result.status===0&&!result.signal,`Selected regression failed: ${result.signal||result.status}`);
    }
}

function main(args=process.argv.slice(2)) {
    const options={};let execute=false;
    for(let i=0;i<args.length;i++) {
        const name=args[i];if(name==='--run-focused'){assert.equal(execute,false);execute=true;continue;}
        assert.ok(['--repo','--base','--head','--output','--github-output','--force-full'].includes(name),`Unknown option ${name}`);
        assert.ok(!Object.hasOwn(options,name),`Duplicate option ${name}`);
        const value=args[++i];assert.ok(value&&!value.startsWith('--'),`Missing ${name}`);options[name]=value;
    }
    const root=path.resolve(options['--repo']||rootPath),head=options['--head'];
    assert.ok(options['--base']&&head,'Use an explicit accepted baseline and source commit');
    const current=readGitSnapshot(root,head);
    const git=(...values)=>execFileSync('git',values,{cwd:root,stdio:'pipe'}).toString().trim();
    assert.equal(current.commit,git('rev-parse','HEAD'),'Selection must match this checkout');
    git('diff','--exit-code',current.commit,'--');
    const baseline=options['--base']==='EMPTY'?null:readGitSnapshot(root,options['--base']);
    if(baseline)git('merge-base','--is-ancestor',baseline.commit,current.commit);
    const plan=createReleasePlan({baseline,current});
    const impact={...selectTestImpact({baseline,current,plan}),baseline:plan.baseline,source:plan.source,planDigest:plan.planDigest};
    assert.ok(!options['--force-full']||['true','false'].includes(options['--force-full']),'force-full must be true or false');
    if(options['--force-full']==='true') {
        impact.full=true;impact.reasons.push({path:'@manual',reason:'Explicit complete regression; may only broaden selection'});
    }
    if(execute)runFocusedRegression({root,impact});
    if(options['--output'])fs.writeFileSync(path.resolve(options['--output']),JSON.stringify(impact,null,2)+'\n',{flag:'wx'});
    else if(!execute)process.stdout.write(JSON.stringify(impact,null,2)+'\n');
    if(options['--github-output'])fs.appendFileSync(options['--github-output'],['full','ui','content','tavern']
        .map(key=>`${key}=${impact[key]}`).join('\n')+'\n');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    try {main();}catch(error){
        console.error(`Test selection rejected: ${error.message}`);
        process.exitCode=error.category==='test_environment'?2:1;
    }
}
